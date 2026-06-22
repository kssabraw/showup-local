# PRD — Rankability Report (Map Pack Check) — Implementation Reference

**Status:** Build-ready spec for replication by a coding agent (Claude Code)
**Owner:** Platform
**Last updated:** 2026-06-22
**Source feature:** ShowUP Local "Check Map Pack" / Rankability (`/check-rankability`)
**Target stack:** React/Vite + TypeScript frontend · Python 3.11 FastAPI service · Supabase · DataForSEO
**Companion docs:** `docs/PRD_silo_pages.md`, `docs/PRD_bulk_silo_creation.md`

---

## 0. How to use this document (read first)

This is a **reproduction spec** for the rankability report: given a keyword + location +
the client's GBP business, it answers *"can this business realistically rank in the Google
Maps pack for this keyword?"* with a 0–100 score, a verdict, a points breakdown, the live
competitor pack, and plain-English barriers.

It is a **single non-streaming endpoint** (`POST /check-rankability`) plus a frontend
report card. It depends on **DataForSEO** (organic SERP + Google Maps endpoints) and a
free geocoder (Nominatim). There is no Claude/LLM call.

Build order:
1. **§5** environment & dependencies (DataForSEO creds).
2. **§7.1** scoring + geo + match helpers (pure functions — unit-testable in isolation).
3. **§7.2** Maps top-10 fetch.
4. **§7.3** the endpoint (orchestration: parallel fetch → category → hard fails → score).
5. **§8** the monthly-cap gate (edge proxy + RPCs) — optional but recommended.
6. **§9** frontend: client wrapper, types, call, and the report UI.
7. **§10** test plan.

> ⚠️ **VERBATIM** blocks are copied from the reference implementation — reproduce exactly
> (adjust imports/paths only). **ADAPT** blocks are illustrative.

---

## 1. Purpose, Goals, Non-Goals

**Purpose:** Tell a user, before they invest in content, whether a keyword is winnable in
the Maps pack for their specific business — and if not, *why* (wrong category, too far,
review deficit, branded competitors).

**Goals**
- 0–100 rankability score with a transparent, deterministic points breakdown.
- Verdict bands: `strong | moderate | difficult | very_difficult`.
- Two decisive "hard fail" short-circuits: category mismatch and >10 mi distance.
- Surface the live 3-pack/top-10 competitors with ratings + review counts.
- Concrete gap metrics: review gap to weakest competitor, distance, branded-name count.
- Handle service-area businesses (SABs) distinctly from physical locations.
- Cheap and bounded: rate-limited + a monthly per-user cap (not subscription credits).

**Non-Goals**
- No LLM scoring — fully deterministic Python.
- No historical tracking / rank monitoring over time (single point-in-time check).
- No write to any customer asset.

---

## 2. What the score measures (rubric)

100 points across five signals, minus an optional SAB penalty:

| Signal | Max | How it's scored |
|---|---|---|
| **Category match** | 35 | GBP category vs. the categories of the Maps pack: `exact` 35 / `partial` 18 / `none` 0 |
| **Competition barrier** | 15 | Client GBP reviews vs. pack: ≥ max in pack 15 · ≥ min 10 · ≥ 80% of min 5 · else 0 · (unknown → 7 neutral) |
| **Distance to target city** | 20 | From business (or SAB city) to city center: ≤5 mi 20 · ≤7 mi 5 · else 0 · (unknown → 10 neutral) |
| **Keyword in competitor names** | 25 | Count of the 3-pack with the keyword in their business name: 0→25 · 1→10 · 2→5 · 3→0 |
| **Appears in Maps top-10** | 5 | Client business already present in Maps top-10: 5 / 0 |
| **SAB penalty** | −40 | If business is a SAB *and* ≥50% of the pack are physical locations |

**Verdict bands** (post-penalty total): `≥70 strong` · `≥45 moderate` · `≥20 difficult` ·
`else very_difficult`.

**Hard fails (short-circuit to score 0 / very_difficult):**
- **Category = none** — no pack business shares the client's category → can't rank.
- **Distance > 10 mi** — Maps strongly favors proximity → effectively unrankable.

---

## 3. Data sources

| Source | Use | Notes |
|---|---|---|
| **DataForSEO organic SERP** (`/v3/serp/google/organic/live/advanced`, depth 10) | Detect whether a `local_pack` widget renders → `has_map_pack` (honest signal) | Auth: HTTP Basic (login:password, base64) |
| **DataForSEO Google Maps** (`/v3/serp/google/maps/live/advanced`, depth 10) | All competitor/category analysis + client's Maps position | Reliable top-10 regardless of organic widget |
| **Nominatim** (OpenStreetMap) | Geocode target city + SAB city → distance | Free, no key; set a UA string |

Organic SERP and Maps are fetched **in parallel**.

---

## 4. System architecture

```
┌──────────────┐  nlp.checkRankability()  ┌──────────────┐  X-API-Key + X-User-ID   ┌──────────────────────────┐
│  Frontend    │ ───────────────────────▶ │ Edge: nlp-   │ ──(after monthly-cap)──▶ │ FastAPI /check-rankability│
│ report card  │                          │ proxy        │                          │                          │
└──────────────┘ ◀─────────────────────── └──────────────┘ ◀─────────────────────── └──────────────────────────┘
                    RankabilityResult            │ 429 if cap reached                       │
                                                 │ check_rankability_limit RPC              │ parallel:
                                                 ▼                                          │  • DataForSEO organic
                                          Supabase user_profiles                            │  • DataForSEO Maps top-10
                                          (rankability_checks_used / per_month)             │  • Nominatim geocode ×2
```

**Sequence:**
1. Frontend calls `checkRankability(payload)` (keyword, location, GBP fields, SAB city).
2. Edge `nlp-proxy` verifies the JWT, runs the **monthly cap** RPC
   (`check_rankability_limit`); 429 if exceeded; otherwise forwards with `X-API-Key`.
3. Service fetches organic SERP + Maps top-10 in parallel; parses competitors/categories.
4. Category match computed → if `none`, **return hard fail**.
5. Distance computed via geocoding → if `>10 mi`, **return hard fail**.
6. Otherwise compute the 100-pt score + review gap + message; return `RankabilityResponse`.

---

## 5. Environment & Dependencies

### 5.1 Service
```
fastapi · uvicorn · httpx · pydantic   # base
```
No new packages beyond the base service. Uses stdlib `math`, `base64`, `re`, `asyncio`.

### 5.2 Service env vars
| Var | Purpose |
|---|---|
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | DataForSEO Basic auth (503 if missing) |
| `NLP_API_KEY` | `X-API-Key` shared secret (edge proxy path) |

Endpoint constants — **VERBATIM**:
```python
DATAFORSEO_ENDPOINT       = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
DATAFORSEO_MAPS_ENDPOINT  = "https://api.dataforseo.com/v3/serp/google/maps/live/advanced"
```

### 5.3 Supabase (for the monthly cap, §8)
- `user_profiles` columns: `rankability_checks_used`, `rankability_checks_per_month`
  (default 50), `rankability_reset_at`.
- RPCs: `check_rankability_limit(p_user_id)` (atomic check-and-increment, admin bypass,
  monthly auto-reset) and `get_rankability_usage(p_user_id)` (read for display).

---

## 6. Data Contracts

### 6.1 Request — **VERBATIM**
```python
class RankabilityRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    gbp_category: str
    business_name: Optional[str] = None
    business_address: Optional[str] = None   # used to infer SAB (empty = SAB)
    business_review_count: Optional[int] = None  # client's own GBP review count
    business_lat: Optional[float] = None
    business_lng: Optional[float] = None
    website: Optional[str] = None  # to check top-10 organic presence
    sab_city: Optional[str] = None  # SAB only: city where GBP is physically located
    gbp_place_id: Optional[str] = None  # GBP place_id for exact Maps match
```

### 6.2 Response — **VERBATIM**
```python
class CompetitorInfo(BaseModel):
    name: str
    rating: Optional[float] = None
    review_count: Optional[int] = None
    has_keyword_in_name: bool = False


class RankabilityResponse(BaseModel):
    # Score
    score: int
    verdict: str          # "strong" | "moderate" | "difficult" | "very_difficult"
    score_breakdown: dict

    # Map pack data
    has_map_pack: bool
    competitors: List[CompetitorInfo]
    ranking_categories: List[dict]    # [{category, count}]

    # Competition metrics
    min_reviews_in_pack: Optional[int] = None
    max_reviews_in_pack: Optional[int] = None
    avg_reviews_in_pack: Optional[float] = None
    avg_rating_in_pack: Optional[float] = None
    review_gap: Optional[int] = None  # vs. weakest competitor in pack

    # Category match
    category_match: str               # "exact" | "partial" | "none"

    # Distance
    distance_miles: Optional[float] = None
    distance_ok: bool = True

    # Keyword-in-name
    keyword_in_competitor_names: int = 0  # count of 3-pack with keyword in name
    competitor_name_examples: List[str] = []

    # Google Maps top-10 presence
    in_maps_results: bool = False
    maps_position: Optional[int] = None  # 1–10 if found, None otherwise

    # SAB vs physical pack
    is_sab: bool = False
    sab_pack_mismatch: bool = False
    physical_competitors_in_pack: int = 0

    # Legacy fields for backward compat with existing frontend
    message: str = ""
    match_count: int = 0
    total_results: int = 0
```

### 6.3 Frontend type (`nlp-types.ts`) — **VERBATIM**
```ts
export interface RankabilityCompetitor {
  name: string;
  rating?: number;
  review_count?: number;
  has_keyword_in_name: boolean;
}

export interface RankabilityResult {
  score: number;
  verdict: string;          // "strong" | "moderate" | "difficult" | "very_difficult"
  score_breakdown: Record<string, number>;
  has_map_pack: boolean;
  competitors: RankabilityCompetitor[];
  ranking_categories: Array<{ category: string; count: number }>;
  min_reviews_in_pack?: number;
  max_reviews_in_pack?: number;
  avg_reviews_in_pack?: number;
  avg_rating_in_pack?: number;
  review_gap?: number;
  category_match: string;     // "exact" | "partial" | "none"
  distance_miles?: number;
  distance_ok: boolean;
  keyword_in_competitor_names: number;
  competitor_name_examples: string[];
  in_maps_results: boolean;
  maps_position?: number;
  is_sab: boolean;
  sab_pack_mismatch: boolean;
  physical_competitors_in_pack: number;
  message: string;
  match_count: number;
  total_results: number;
}
```

---

## 7. Service Implementation

### 7.1 Helpers — **VERBATIM**

```python
def _haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles between two lat/lng points."""
    import math
    R = 3958.8  # Earth radius in miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _keyword_in_name(keyword: str, business_name: str) -> bool:
    """True if ALL keyword tokens appear in business name (case-insensitive).
    Requires 100% match so that e.g. 'tree service' doesn't flag a competitor
    for the keyword 'emergency tree service' — the modifier matters.
    """
    kw_tokens = set(re.sub(r'[^a-z0-9\s]', '', keyword.lower()).split())
    name_lower = re.sub(r'[^a-z0-9\s]', '', business_name.lower())
    if not kw_tokens:
        return False
    return all(t in name_lower for t in kw_tokens)


async def _geocode_location(location: str) -> Optional[tuple[float, float]]:
    """Geocode a city/location string using Nominatim (free, no key)."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": location, "format": "json", "limit": 1},
                headers={"User-Agent": "ShowUPLocal/1.0 (contact@showuplocal.com)"},
            )
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as e:
        logger.warning(f"Geocoding failed for '{location}': {e}")
    return None


def _infer_is_sab(address: Optional[str]) -> bool:
    """
    SABs don't display an address on their GBP listing, so the address field
    is empty or null when pulled from the API. Physical locations have a
    street address stored.
    """
    return not bool(address and address.strip())


def _rankability_score(
    category_match: str,           # "exact" | "partial" | "none"
    client_reviews: Optional[int], # client's own GBP review count
    max_reviews: Optional[int],    # highest review count in map pack
    min_reviews: Optional[int],    # lowest review count in map pack
    distance_miles: Optional[float],
    keyword_name_count: int,       # how many of 3 competitors have keyword in name
    in_maps_results: bool,
    is_sab: bool = False,
    physical_competitor_count: int = 0,
    total_pack_count: int = 0,
) -> dict:
    """Compute 0-100 rankability score with breakdown."""

    # 1. Category match (35 pts)
    cat_pts = {"exact": 35, "partial": 18, "none": 0}.get(category_match, 0)

    # 2. Competition barrier — client reviews vs. pack (15 pts)
    if client_reviews is None or min_reviews is None or max_reviews is None:
        comp_pts = 7  # neutral when data unavailable
    elif client_reviews >= max_reviews:
        comp_pts = 15
    elif client_reviews >= min_reviews:
        comp_pts = 10
    elif min_reviews > 0 and client_reviews >= min_reviews * 0.80:
        comp_pts = 5   # up to 20% below lowest in pack
    else:
        comp_pts = 0

    # 3. Distance from city center (20 pts)
    if distance_miles is None:
        dist_pts = 10  # neutral / unknown
    elif distance_miles <= 5:
        dist_pts = 20
    elif distance_miles <= 7:
        dist_pts = 5
    else:
        dist_pts = 0

    # 4. Keyword in competitor names (25 pts)
    kw_name_pts = {0: 25, 1: 10, 2: 5, 3: 0}.get(min(keyword_name_count, 3), 0)

    # 5. Business website in top 10 organic (5 pts)
    organic_pts = 5 if in_maps_results else 0

    total = cat_pts + comp_pts + dist_pts + kw_name_pts + organic_pts

    # SAB vs physical-dominant pack penalty (-40 pts)
    sab_penalty = 0
    sab_pack_mismatch = False
    if is_sab and total_pack_count > 0:
        physical_ratio = physical_competitor_count / total_pack_count
        if physical_ratio >= 0.5:
            sab_penalty = -40
            sab_pack_mismatch = True

    total = max(0, total + sab_penalty)

    if total >= 70:
        verdict = "strong"
    elif total >= 45:
        verdict = "moderate"
    elif total >= 20:
        verdict = "difficult"
    else:
        verdict = "very_difficult"

    return {
        "total": total,
        "verdict": verdict,
        "sab_pack_mismatch": sab_pack_mismatch,
        "breakdown": {
            "category_match": cat_pts,
            "competition_barrier": comp_pts,
            "distance": dist_pts,
            "keyword_in_competitor_names": kw_name_pts,
            "in_maps_results": organic_pts,
            "sab_penalty": sab_penalty,
        },
    }
```

### 7.2 Maps top-10 fetch — **VERBATIM**

```python
async def _fetch_maps_top10(
    keyword: str,
    loc_field: dict,
    business_name: str,
    credentials: str,
    place_id: Optional[str] = None,
) -> tuple[bool, int, list[dict]]:
    """
    Query DataForSEO Google Maps endpoint for top-10 results.
    Returns (business_found, position, maps_items).
    Match priority: place_id (exact) → business_name (fuzzy, high threshold)
    """
    payload = [{
        "keyword": keyword,
        **loc_field,
        "language_name": "English",
        "depth": 10,
    }]
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                DATAFORSEO_MAPS_ENDPOINT,
                headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        maps_items = []
        for task in (data.get("tasks") or []):
            for result in (task.get("result") or []):
                for item in (result.get("items") or []):
                    if item.get("type") == "maps_search":
                        maps_items.append(item)
        for item in maps_items:
            pos = item.get("rank_group") or item.get("rank_absolute") or 0
            # Prefer exact place_id match
            if place_id and item.get("place_id") == place_id:
                return True, int(pos), maps_items
            # Fallback: require ALL significant tokens (len >= 5) to appear in result name
            if business_name and not place_id:
                name = item.get("title", "")
                sig_tokens = [t for t in re.sub(r'[^a-z0-9\s]', '', business_name.lower()).split() if len(t) >= 5]
                name_norm = re.sub(r'[^a-z0-9\s]', '', name.lower())
                if sig_tokens and all(t in name_norm for t in sig_tokens):
                    return True, int(pos), maps_items
        return False, 0, maps_items
    except Exception as e:
        logger.warning(f"Maps top-10 check failed for '{keyword}': {e}")
    return False, 0, []
```

### 7.3 The endpoint — **VERBATIM**

```python
@app.post('/check-rankability', response_model=RankabilityResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def check_rankability(request: Request, body: RankabilityRequest):
    if not DATAFORSEO_LOGIN or not DATAFORSEO_PASSWORD:
        raise HTTPException(status_code=503, detail="DataForSEO credentials not configured")

    credentials = base64.b64encode(
        f"{DATAFORSEO_LOGIN}:{DATAFORSEO_PASSWORD}".encode()
    ).decode()
    loc_field = {"location_code": body.location_code} if body.location_code else {"location_name": body.location}

    # Run SERP (organic + local_pack) and Google Maps top-10 in parallel
    serp_payload = [{
        "keyword": body.keyword,
        **loc_field,
        "language_name": "English",
        "depth": 10,
        "se_domain": "google.com",
    }]

    async def _fetch_serp() -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                DATAFORSEO_ENDPOINT,
                headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
                json=serp_payload,
            )
            resp.raise_for_status()
            return resp.json()

    maps_task = _fetch_maps_top10(body.keyword, loc_field, body.business_name or "", credentials, place_id=body.gbp_place_id)
    serp_data, (in_maps_results, maps_position, maps_items) = await asyncio.gather(
        _fetch_serp(), maps_task
    )

    # Parse organic SERP — only used to determine if a local pack appears in search results
    local_pack_items: List[dict] = []
    for task in (serp_data.get("tasks") or []):
        for result in (task.get("result") or []):
            for item in (result.get("items") or []):
                if item.get("type") == "local_pack":
                    local_pack_items.append(item)

    # has_map_pack is determined solely by organic SERP (honest signal)
    has_map_pack = len(local_pack_items) > 0

    # ── Competitor & category analysis from Maps top-10 ────────────────────────
    competitors: List[CompetitorInfo] = []
    category_counts: Dict[str, int] = {}
    keyword_name_count = 0
    competitor_name_examples: List[str] = []
    physical_competitor_count = 0

    for item in maps_items[:10]:
        name = item.get("title", "")
        rating_obj = item.get("rating") or {}
        rating = rating_obj.get("value") if isinstance(rating_obj, dict) else rating_obj
        review_count = rating_obj.get("votes_count") if isinstance(rating_obj, dict) else None

        address_val = item.get("address", "") or ""
        is_physical = bool(address_val)
        if is_physical:
            physical_competitor_count += 1

        has_kw = _keyword_in_name(body.keyword, name)
        if has_kw:
            keyword_name_count += 1
            competitor_name_examples.append(name)

        cat = item.get("category", "")
        if cat:
            category_counts[cat] = category_counts.get(cat, 0) + 1

        competitors.append(CompetitorInfo(
            name=name,
            rating=float(rating) if rating else None,
            review_count=int(review_count) if review_count else None,
            has_keyword_in_name=has_kw,
        ))

    ranking_categories = [{"category": k, "count": v}
                          for k, v in sorted(category_counts.items(), key=lambda x: -x[1])]

    # ── Category match ─────────────────────────────────────────────────────────
    gbp_cat_lower = body.gbp_category.lower()
    cat_tokens = set(re.sub(r'[^a-z0-9\s]', '', gbp_cat_lower).split())
    match_count = sum(1 for rc in ranking_categories
                      if gbp_cat_lower in rc["category"].lower()
                      or rc["category"].lower() in gbp_cat_lower)
    partial_count = sum(1 for rc in ranking_categories
                        for t in cat_tokens
                        if len(t) > 3 and t in rc["category"].lower())
    if match_count > 0:
        category_match = "exact"
    elif partial_count > 0:
        category_match = "partial"
    else:
        category_match = "none"

    # ── Category mismatch — hard fail ─────────────────────────────────────────
    if category_match == "none":
        return RankabilityResponse(
            score=0,
            verdict="very_difficult",
            score_breakdown={"category_match": 0},
            has_map_pack=has_map_pack,
            competitors=competitors[:3],
            ranking_categories=ranking_categories,
            category_match="none",
            keyword_in_competitor_names=keyword_name_count,
            competitor_name_examples=competitor_name_examples,
            in_maps_results=in_maps_results,
            maps_position=maps_position if in_maps_results else None,
            is_sab=_infer_is_sab(body.business_address),
            sab_pack_mismatch=False,
            physical_competitors_in_pack=physical_competitor_count,
            message=(
                "Your GBP category doesn't match any category in the Maps results — "
                "you will not rank in Maps for this keyword. "
                "The businesses ranking here are in a different category. "
                "Target a different keyword, or create content for organic search instead."
            ),
            match_count=0,
            total_results=len(maps_items),
        )

    # ── Review metrics (top 3 only — mirrors the visible 3-pack) ───────────────
    top3 = competitors[:3]
    review_counts = [c.review_count for c in top3 if c.review_count is not None]
    ratings = [c.rating for c in top3 if c.rating is not None]
    min_reviews = min(review_counts) if review_counts else None
    max_reviews = max(review_counts) if review_counts else None
    avg_reviews = round(sum(review_counts) / len(review_counts), 1) if review_counts else None
    avg_rating = round(sum(ratings) / len(ratings), 2) if ratings else None

    is_sab = _infer_is_sab(body.business_address)

    # ── Distance ───────────────────────────────────────────────────────────────
    distance_miles = None
    distance_ok = True
    target_coords = await _geocode_location(body.location)
    if target_coords:
        if is_sab and body.sab_city:
            origin_coords = await _geocode_location(body.sab_city)
            if origin_coords:
                distance_miles = round(_haversine_miles(
                    origin_coords[0], origin_coords[1],
                    target_coords[0], target_coords[1]
                ), 1)
                distance_ok = distance_miles <= 10.0
        elif not is_sab and body.business_lat and body.business_lng:
            distance_miles = round(_haversine_miles(
                body.business_lat, body.business_lng,
                target_coords[0], target_coords[1]
            ), 1)
            distance_ok = distance_miles <= 10.0

    # ── Distance hard fail ─────────────────────────────────────────────────────
    if distance_miles is not None and distance_miles > 10.0:
        return RankabilityResponse(
            score=0,
            verdict="very_difficult",
            score_breakdown={"distance": 0},
            has_map_pack=has_map_pack,
            competitors=competitors[:3],
            ranking_categories=ranking_categories,
            category_match=category_match,
            keyword_in_competitor_names=keyword_name_count,
            competitor_name_examples=competitor_name_examples,
            in_maps_results=in_maps_results,
            maps_position=maps_position if in_maps_results else None,
            is_sab=is_sab,
            sab_pack_mismatch=False,
            physical_competitors_in_pack=physical_competitor_count,
            distance_miles=distance_miles,
            distance_ok=False,
            message=(
                f"Your business is {distance_miles} miles from {body.location} — "
                "Google Maps heavily favors businesses within 5 miles of the search location. "
                "You are unlikely to rank in Maps for this keyword. "
                "Target a city closer to your location or target organic rankings instead."
            ),
            match_count=match_count,
            total_results=len(maps_items),
        )

    # ── Score ──────────────────────────────────────────────────────────────────
    score_data = _rankability_score(
        category_match=category_match,
        client_reviews=body.business_review_count,
        max_reviews=max_reviews,
        min_reviews=min_reviews,
        distance_miles=distance_miles,
        keyword_name_count=keyword_name_count,
        in_maps_results=in_maps_results,
        is_sab=is_sab,
        physical_competitor_count=physical_competitor_count,
        total_pack_count=len(maps_items[:10]),
    )

    # ── Review gap — reviews needed to match weakest competitor ───────────────
    review_gap = None
    if body.business_review_count is not None and min_reviews is not None:
        review_gap = max(0, min_reviews - body.business_review_count)

    # ── Human-readable message ─────────────────────────────────────────────────
    verdict_labels = {
        "strong": "Strong map pack rankability",
        "moderate": "Moderate — achievable with work",
        "difficult": "Difficult — real barriers present",
        "very_difficult": "Very difficult — consider a different keyword or location",
    }
    message = verdict_labels.get(score_data["verdict"], "")
    if not has_map_pack:
        no_pack_note = " (no local pack in organic SERP for this query)" if maps_items else ""
        if not maps_items:
            message = "No map pack found for this keyword — may be a low local-intent query"
        else:
            message = verdict_labels.get(score_data["verdict"], "") + no_pack_note
    elif score_data.get("sab_pack_mismatch"):
        message += f". Your service area business faces a pack dominated by {physical_competitor_count} physical location(s) — Google heavily favors proximity for this keyword"

    return RankabilityResponse(
        score=score_data["total"],
        verdict=score_data["verdict"],
        score_breakdown=score_data["breakdown"],
        has_map_pack=has_map_pack,
        competitors=competitors,
        ranking_categories=ranking_categories,
        min_reviews_in_pack=min_reviews,
        max_reviews_in_pack=max_reviews,
        avg_reviews_in_pack=avg_reviews,
        avg_rating_in_pack=avg_rating,
        review_gap=review_gap,
        category_match=category_match,
        distance_miles=distance_miles,
        distance_ok=distance_ok,
        keyword_in_competitor_names=keyword_name_count,
        competitor_name_examples=competitor_name_examples,
        in_maps_results=in_maps_results,
        maps_position=maps_position if in_maps_results else None,
        is_sab=is_sab,
        sab_pack_mismatch=score_data.get("sab_pack_mismatch", False),
        physical_competitors_in_pack=physical_competitor_count,
        message=message,
        match_count=match_count,
        total_results=len(local_pack_items),
    )
```

**Behavioural notes for the agent:**
- `has_map_pack` is **only** from the organic SERP local-pack widget (honest "does Google
  show a pack here"); all competitor/category math uses the Maps endpoint, which returns a
  top-10 even when the organic widget didn't render.
- Review metrics + the `keyword_in_competitor_names` 3-pack count use **top 3** only
  (mirrors the visible pack); `physical_competitor_count` and category counts use top 10.
- Distance origin differs by business type: physical → `business_lat/lng`; SAB →
  geocode of `sab_city` (SABs hide their address).
- Both hard fails return a **fully-populated** response (competitors, categories, flags)
  with `score=0` and a specific `message` — the UI still renders a useful report.

---

## 8. Monthly cap gate (recommended) — **VERBATIM**

Rankability is **not** charged as subscription credits; instead each user gets **50 free
checks/month** (admins bypass), enforced in the edge proxy before forwarding. On exceed →
HTTP 429 with `code: "RANKABILITY_LIMIT_REACHED"`.

Edge proxy gate (`supabase/functions/nlp-proxy/index.ts`):
```ts
// ── Rankability monthly cap (50 checks/month, separate from credits) ─────────
if (endpoint === "/check-rankability") {
  const { data: allowed, error: limitError } = await adminClient.rpc(
    "check_rankability_limit",
    { p_user_id: user.id },
  );
  if (limitError) {
    return new Response(JSON.stringify({ error: "Could not verify usage limit" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!allowed) {
    return new Response(JSON.stringify({
      error: "Monthly map pack check limit reached",
      code: "RANKABILITY_LIMIT_REACHED",
      limit: 50,
    }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
```

Supabase migration (atomic check-and-increment, auto-reset, admin bypass) — **VERBATIM**:
```sql
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS rankability_checks_used      INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rankability_checks_per_month INTEGER     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS rankability_reset_at         TIMESTAMPTZ NOT NULL
    DEFAULT (date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month');

CREATE OR REPLACE FUNCTION public.check_rankability_limit(p_user_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_used INTEGER; v_limit INTEGER; v_reset TIMESTAMPTZ; v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE user_id = p_user_id;
  IF v_role = 'admin' THEN RETURN TRUE; END IF;

  SELECT rankability_checks_used, rankability_checks_per_month, rankability_reset_at
  INTO v_used, v_limit, v_reset
  FROM public.user_profiles WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF NOW() >= v_reset THEN
    UPDATE public.user_profiles
    SET rankability_checks_used = 1,
        rankability_reset_at = date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month'
    WHERE user_id = p_user_id;
    RETURN TRUE;
  END IF;

  IF v_used >= v_limit THEN RETURN FALSE; END IF;

  UPDATE public.user_profiles SET rankability_checks_used = rankability_checks_used + 1
  WHERE user_id = p_user_id;
  RETURN TRUE;
END; $$;
GRANT EXECUTE ON FUNCTION public.check_rankability_limit(UUID) TO service_role;

-- Read-only usage for display (used + limit + reset_at)
CREATE OR REPLACE FUNCTION public.get_rankability_usage(p_user_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_used INTEGER; v_limit INTEGER; v_reset TIMESTAMPTZ;
BEGIN
  SELECT rankability_checks_used, rankability_checks_per_month, rankability_reset_at
  INTO v_used, v_limit, v_reset
  FROM public.user_profiles WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN json_build_object('used', 0, 'limit', 50, 'reset_at', NULL); END IF;
  IF NOW() >= v_reset THEN v_used := 0; END IF;
  RETURN json_build_object('used', v_used, 'limit', v_limit, 'reset_at', v_reset);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_rankability_usage(UUID) TO authenticated, service_role;
```

> Optionally pair with a "rankability pack" purchase flow to raise the cap (the source app
> has `purchase-rankability-pack` + `RankabilityPackModal`). That's a billing add-on, not
> core to the report — implement only if you sell extra checks.

---

## 9. Frontend Implementation

### 9.1 Client wrapper (`nlp-client.ts`) — **VERBATIM**
```ts
checkRankability: (
  body: {
    keyword: string;
    location: string;
    location_code?: number | null;
    gbp_category: string;
    business_name?: string;
    business_address?: string | null;
    business_review_count?: number | null;
    business_lat?: number | null;
    business_lng?: number | null;
    website?: string | null;
    sab_city?: string;
    gbp_place_id?: string;
  },
  signal?: AbortSignal,
) => nlpPost<RankabilityResult>("/check-rankability", body, signal),
```
The 429 cap response is mapped to `RankabilityLimitError` inside `throwIfInsufficientCredits`:
```ts
export class RankabilityLimitError extends Error {
  readonly limit: number;
  constructor(limit = 50) {
    super(`You've used all ${limit} map pack checks for this month. Resets on the 1st.`);
    this.name = "RankabilityLimitError";
    this.limit = limit;
  }
}
// in throwIfInsufficientCredits:
if (res.status === 429 && d.code === "RANKABILITY_LIMIT_REACHED") {
  throw new RankabilityLimitError(d.limit ?? 50);
}
```

### 9.2 The call — `handleCheckRankability` — **VERBATIM**

Builds the full payload from the selected business (infers SAB from a blank address;
includes `sab_city` only for SABs), stores the result, refreshes usage, and opens the
pack modal on cap. On any other error it sets a benign `verdict: "unknown"` result.
```ts
const handleCheckRankability = async () => {
  const b = businesses.find(b => b.id === selectedBusinessId);
  if (!b || !keyword.trim() || !location) return;
  setRankabilityLoading(true);
  setRankability(null);
  try {
    const isSab = !b.address?.trim();
    const data = await nlp.checkRankability({
      keyword: keyword.trim(),
      location: location.trim(),
      location_code: locationCode,
      gbp_category: b.gbp_category,
      business_name: b.business_name,
      business_address: b.address,
      business_review_count: b.gbp_review_count ?? null,
      business_lat: b.latitude ?? null,
      business_lng: b.longitude ?? null,
      website: b.website,
      sab_city: isSab && sabCity.trim() ? sabCity.trim() : undefined,
      gbp_place_id: b.gbp_place_id ?? undefined,
    });
    setRankability(data);
    invalidateCredits();
  } catch (e: any) {
    if (e instanceof RankabilityLimitError) {
      setShowPackModal(true);
    } else {
      setRankability({
        score: 0, verdict: "unknown", score_breakdown: {},
        has_map_pack: false, competitors: [], ranking_categories: [],
        category_match: "none", distance_ok: true,
        keyword_in_competitor_names: 0, competitor_name_examples: [],
        in_maps_results: false, maps_position: undefined, is_sab: false, sab_pack_mismatch: false,
        physical_competitors_in_pack: 0,
        message: "Could not retrieve map pack data.", match_count: 0, total_results: 0,
      });
    }
  } finally {
    setRankabilityLoading(false);
  }
};
```

### 9.3 The report card — **ADAPT (structure + verbatim breakdown)**

Render when `rankability && rankability.verdict !== "unknown"`. Layout, top to bottom:

1. **Verdict banner** — color-keyed by verdict (green strong / amber moderate / red
   difficult+), with the big numeric `score` and the `message`:
   - strong → "✓ Strong rankability" · moderate → "⚠ Moderate — achievable with work"
   - difficult → "✗ Difficult — real barriers present" · else → very difficult copy.

2. **Score breakdown bars** — **VERBATIM** (drives off `score_breakdown`):
```tsx
{[
  { label: "Category match", key: "category_match", max: 35 },
  { label: "Competition barrier", key: "competition_barrier", max: 15 },
  { label: "Distance to target city", key: "distance", max: 20 },
  { label: "Keyword in competitor names", key: "keyword_in_competitor_names", max: 25 },
  { label: "Appears in Google Maps", key: "in_maps_results", max: 5 },
].map(({ label, key, max }) => {
  const pts = rankability.score_breakdown[key] ?? 0;
  return (
    <div key={key} className="flex items-center gap-2">
      <span className="flex-1 text-muted-foreground truncate">{label}</span>
      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden flex-shrink-0">
        <div className="h-full rounded-full bg-primary/60 transition-all" style={{ width: `${(pts / max) * 100}%` }} />
      </div>
      <span className="w-10 text-right tabular-nums text-muted-foreground">{pts}/{max}</span>
    </div>
  );
})}
{rankability.sab_pack_mismatch && (
  <div className="flex items-center gap-2 text-red-600 font-medium">
    <span className="flex-1">SAB vs physical pack penalty</span>
    <span className="w-10 text-right tabular-nums">{rankability.score_breakdown["sab_penalty"] ?? -40}</span>
  </div>
)}
```

3. **Competitor cards** — list `rankability.competitors` (name, ★ rating, review count);
   highlight the client's own row when `in_maps_results && position === maps_position`.

4. **Review metrics line** — `min/max reviews in pack`, `avg_rating_in_pack`, and the
   `review_gap` ("Need N more reviews to match weakest competitor" / "✓ enough reviews").

5. **Barrier notes** (conditional):
   - `!has_map_pack` → note no local pack rendered.
   - distance: `distance_ok` → "✓ N mi — good proximity"; else "✗ N mi — proximity disadvantage".
   - `keyword_in_competitor_names > 0` → "⚠ N competitor(s) have keyword in name: …examples".
   - `in_maps_results` → "✓ Business appears at position {maps_position} in Maps top 10".
   - `category_match === "none"` → category-mismatch warning.
   - show top-3 `ranking_categories` ("Pack categories: …").

6. **`verdict === "unknown"`** → render just `rankability.message` (transient error state).

**Trigger button** ("Check Map Pack"): disabled unless a business + keyword + resolved
location; shows a spinner while `rankabilityLoading`.

---

## 10. Test Plan & Acceptance Criteria

### 10.1 Scoring (pure-function unit tests on `_rankability_score`)
- exact category + client reviews ≥ pack max + ≤5 mi + 0 branded + in maps →
  35+15+20+25+5 = **100 / strong**.
- partial category, unknown reviews, unknown distance, 1 branded, not in maps →
  18+7+10+10+0 = **45 / moderate**.
- SAB with ≥50% physical pack applies **−40** and sets `sab_pack_mismatch=true`; total floored at 0.
- Verdict bands at boundaries: 70→strong, 69→moderate, 45→moderate, 44→difficult, 20→difficult, 19→very_difficult.

### 10.2 Hard fails (endpoint)
- Pack categories share nothing with GBP category → `score=0`, `verdict="very_difficult"`,
  `category_match="none"`, category-mismatch `message`, competitors still populated (top 3).
- Geocoded distance > 10 mi → `score=0`, `distance_ok=false`, distance `message`.

### 10.3 Signals
- `has_map_pack` reflects the organic `local_pack` presence, independent of Maps top-10.
- `keyword_in_competitor_names` only counts a competitor when **all** keyword tokens are in
  the name ("emergency tree service" must not match a "Tree Service Co").
- SAB inferred when `business_address` blank; distance then uses `sab_city` geocode.
- Maps self-match prefers `gbp_place_id`; falls back to all-significant-token name match.

### 10.4 Cap + errors
- 51st check in a month (non-admin) → 429 `RANKABILITY_LIMIT_REACHED` → frontend opens pack modal.
- New month → counter auto-resets on next check.
- Missing DataForSEO creds → 503. DataForSEO/Nominatim failure → distance unknown (neutral 10 pts), no 500.
- 11 checks/minute → rate-limited (429 from limiter).

### 10.5 Frontend
- Button disabled until business + keyword + location set.
- Breakdown bars render `pts/max` per signal; SAB penalty row only when `sab_pack_mismatch`.
- Client row highlighted in competitor list when present in Maps top-10.
- `verdict="unknown"` shows only the message (graceful error).

---

## 11. Build Checklist

**Service**
- [ ] §7.1 helpers: `_haversine_miles`, `_keyword_in_name`, `_geocode_location`, `_infer_is_sab`, `_rankability_score`.
- [ ] §7.2 `_fetch_maps_top10`; endpoint constants (organic + Maps).
- [ ] §7.3 `POST /check-rankability` (parallel fetch → category → 2 hard fails → score → message), 10/min, `verify_api_key`.
- [ ] §6 request/response models.

**Edge / DB (cap)**
- [ ] §8 `check_rankability_limit` + `get_rankability_usage` RPCs + `user_profiles` columns.
- [ ] `nlp-proxy` rankability gate → 429 `RANKABILITY_LIMIT_REACHED`.

**Frontend**
- [ ] §6.3 `RankabilityResult`/`RankabilityCompetitor` types.
- [ ] §9.1 `checkRankability` wrapper + `RankabilityLimitError` mapping (429).
- [ ] §9.2 `handleCheckRankability` (full payload, SAB city, error fallback).
- [ ] §9.3 report card (verdict banner, breakdown bars, competitors, metrics, barrier notes) + trigger button.

**Verify**
- [ ] §10 test plan green.

---

## 12. Reference File Map (source app)

| Concern | File · symbol |
|---|---|
| Endpoint | `services/nlp/main.py` · `/check-rankability` |
| Scoring | `services/nlp/main.py` · `_rankability_score` |
| Geo / match helpers | `services/nlp/main.py` · `_haversine_miles`, `_geocode_location`, `_keyword_in_name`, `_infer_is_sab` |
| Maps fetch | `services/nlp/main.py` · `_fetch_maps_top10` |
| Models | `services/nlp/main.py` · `RankabilityRequest`, `CompetitorInfo`, `RankabilityResponse` |
| Monthly cap | `supabase/migrations/20260407000001_rankability_check_limit.sql`; `supabase/functions/nlp-proxy/index.ts` |
| Pack purchase (optional) | `supabase/functions/purchase-rankability-pack/index.ts`; `src/components/RankabilityPackModal.tsx` |
| Client wrapper + error | `src/lib/nlp-client.ts` · `checkRankability`, `RankabilityLimitError` |
| Type | `src/lib/nlp-types.ts` · `RankabilityResult`, `RankabilityCompetitor` |
| Call + report UI | `src/components/NewContentView.tsx` · `handleCheckRankability`, rankability card |
| Lightweight variant | `src/components/PlanningView.tsx` · per-keyword rankability chip |
