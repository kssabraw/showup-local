# PRD — Silo / Related-Pages Research + Write Handoff (Implementation Reference)

**Status:** Build-ready spec for replication by a coding agent (Claude Code)
**Owner:** Platform
**Last updated:** 2026-06-22
**Source feature:** ShowUP Local "Content Planning" (`PlanningView` → `/related-pages`)
**Target stack:** React/Vite + TypeScript frontend · Python 3.11 FastAPI service · Supabase · Anthropic Claude

---

## 0. How to use this document (read first)

This is a **reproduction spec**. Every function the feature depends on is included
**verbatim** in §7–§10. Build in this order; each step is independently testable:

1. **§5 Environment & dependencies** — install packages, set env vars.
2. **§7.1 Shared primitives** — auth, rate limiter, JSON parser, token/cost helpers,
   `STOP_WORDS`. Everything else depends on these.
3. **§7.2 Keyword derivation** (`_derive_related_keywords`) — the Haiku call.
4. **§7.3 Sitemap discovery** + **§7.4 Page matching** (`_find_page_for_keyword_reuse`).
5. **§7.5 The endpoint** (`/related-pages`) — wires 7.2–7.4 together.
6. **§8 Edge proxy** (optional — skip if calling the service directly with a JWT).
7. **§9 Frontend** — client wrappers, types, `PlanningView`, write handoff.
8. **§7.6 Optional scoring**, **§7.7 Optional rankability** — only if needed.
9. **§11 Test plan** — verify against the acceptance criteria.

**Scope boundary:** the content **writer** (generation pipeline) is assumed to already
exist in the target app. This document specifies only how the planning feature invokes
it (§9.4). The optional **scorer** (§7.6) is shared with the writer's scoring feature; if
the target app already has a scorer, call that instead of porting it.

> ⚠️ Code blocks marked **VERBATIM** are copied from the reference implementation and
> should be reproduced exactly (only adjust imports/paths to the target project). Blocks
> marked **ADAPT** are illustrative and may be rewritten to fit the target framework.

---

## 1. Purpose, Goals, Non-Goals

**Purpose:** Given one seed keyword + location + a business, (a) derive an SOP-compliant
keyword silo (parents / siblings / neighbourhood children), (b) crawl the business's site
to flag which silo pages already exist vs. are missing, and (c) let the user hand any
missing page to the existing writer in one click.

**Goals**
- Deterministic, SOP-aligned silo structure from a single seed keyword.
- Read-only site gap analysis (no writes to the customer site).
- One-click handoff of a missing page to the writer, pre-filled.
- Cheap: one Haiku call + plain HTTP GETs. No paid SERP/NLP credits for the core flow.

**Non-Goals**
- No competitor scraping / TF-IDF / entity analysis during planning.
- No automatic generation — the user explicitly chooses what to create.
- No persistence of planning results (results are ephemeral UI state).

---

## 2. Glossary & Taxonomy

The derivation produces three groups; each maps to a page type in the silo:

| Group (API key) | UI label | Page type | URL pattern | Title pattern | Example (seed = "emergency plumber", city = "Anaheim") |
|---|---|---|---|---|---|
| `parents` | Parent | Service / Location / Service+City | `/service/`, `/location/` | `{Service} \| {Brand}` | `plumber`, `emergency plumber`, `plumber Anaheim` |
| `siblings` | Sibling | Peer local landing pages | `/location/service/` | `{Service} {City} \| {Brand}` | `drain cleaning Anaheim`, `water heater repair Anaheim` |
| `children` | Neighbourhood | Neighbourhood silo pages | `/location/neighborhood/` | `{Service} {Neighborhood} \| {Brand}` | `emergency plumber Anaheim Hills`, `emergency plumber Platinum Triangle` |

**Silo intent:** parents = pages this page links *up* to; siblings = peer services in the
same city; children = the same keyword scoped to neighbourhoods *inside the city only*.

**`status`:** `found` (a live page on the site matches the keyword) or `missing`.

---

## 3. System Architecture

```
┌──────────────┐  nlp.relatedPages()   ┌───────────────────┐  X-API-Key + X-User-ID  ┌────────────────────────┐
│  Frontend    │ ────────────────────▶ │ Supabase Edge Fn  │ ──────────────────────▶ │  FastAPI /related-pages│
│ PlanningView │                       │  related-pages    │                         │                        │
└──────────────┘ ◀──────────────────── └───────────────────┘ ◀────────────────────── └────────────────────────┘
       │           { items[], token_usage }                                                        │
       │                                                                          ┌────────────────┴─────────────────┐
       │ onCreatePage(kw, loc)                                                    │ 1. Haiku: derive parents/sibs/kids│
       ▼                                                                          │ 2. Fetch sitemap.xml (→robots.txt)│
┌──────────────┐                                                                 │ 3. Per-kw: match → existing page  │
│ Writer view  │  (existing generation pipeline — out of scope, §9.4)            └───────────────────────────────────┘
└──────────────┘
```

**Sequence (happy path):**
1. User selects business, enters seed keyword + location, clicks "Scan Site".
2. Frontend `POST`s to the edge function (or directly to the service with a Bearer JWT).
3. Edge function verifies the Supabase session, proxies to FastAPI with `X-API-Key` + `X-User-ID`.
4. FastAPI: Haiku derives keywords → fetch sitemap once → match every keyword concurrently.
5. Returns `{ items, token_usage }`.
6. Frontend groups by `group`, renders found/missing, offers "Create" on missing items.
7. "Create" pre-fills `(keyword, location)` and navigates to the writer view.

**Dual auth:** the endpoint accepts **either** `X-API-Key` (edge-proxied; the proxy
also forwards `X-User-ID`) **or** `Authorization: Bearer <Supabase JWT>` (direct). The
reference `/related-pages` guards with `Depends(verify_api_key)` (X-API-Key). If you call
the service directly from the browser, swap the dependency for the JWT verifier (§7.1).

---

## 4. Page Taxonomy Source

The derivation prompt encodes the site-architecture SOP. For the full taxonomy,
internal-linking rules, and PageRank principles, see `docs/site_architecture_sop.md` in
the source repo. The only part the *research* feature needs is the parent/sibling/child
mapping in §2; linking rules apply when the writer builds the page, not during planning.

---

## 5. Environment, Dependencies, Configuration

### 5.1 Service (FastAPI) dependencies
```
fastapi
uvicorn
httpx
beautifulsoup4
lxml                # XML parser for sitemap (BeautifulSoup(..., "xml"))
nltk                # stopwords corpus
numpy               # only if porting the scorer / zone targets
anthropic           # Claude SDK
slowapi             # rate limiting
pydantic
```
NLTK stopwords must be downloaded at build time:
```python
import nltk; nltk.download("stopwords")
```

### 5.2 Service environment variables
| Var | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | core | Haiku derivation + optional scoring |
| `NLP_API_KEY` | core (if using edge proxy) | shared secret for `X-API-Key`; **fails closed** if unset |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | direct JWT auth | for `_verify_jwt_get_user` |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | §7.7 rankability only | optional |
| `CORS_ORIGINS` | prod | comma-separated; `*` in dev |

### 5.3 Frontend environment variables (Vite)
| Var | Purpose |
|---|---|
| `VITE_NLP_SERVICE_URL` | Railway service base URL (direct calls) |
| `VITE_SUPABASE_URL` | base for edge function URL (`/functions/v1/nlp-proxy`) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase client |

### 5.4 Model
- Derivation + scoring use **`claude-haiku-4-5-20251001`**. Pricing in §7.1.

---

## 6. Data Contracts

### 6.1 Request — `POST /related-pages` (Pydantic) — **VERBATIM**
```python
class RelatedPagesRequest(BaseModel):
    keyword: str
    location: str
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    website: Optional[str] = None
```

### 6.2 Response models — **VERBATIM**
```python
class RelatedPageItem(BaseModel):
    keyword: str
    group: str  # "parents" | "siblings" | "children"
    status: str  # "found" | "missing"
    url: Optional[str] = None
    page_title: Optional[str] = None
    composite_score: Optional[float] = None
    composite_status: Optional[str] = None
    engine_scores: Optional[dict] = None
    deficiencies: Optional[List[dict]] = None


class RelatedPagesResponse(BaseModel):
    items: List[RelatedPageItem]
    token_usage: dict
```

### 6.3 Frontend types (`nlp-types.ts`) — **VERBATIM**
```ts
export interface RelatedPageItem {
  keyword: string;
  group: "parents" | "siblings" | "children";
  status: "found" | "missing";
  url?: string;
  page_title?: string;
  composite_score?: number;
  composite_status?: string;
  engine_scores?: Record<string, EngineScore>;
  deficiencies?: Array<{ engine: string; issue: string; fix: string }>;
}
```

---

## 7. Service Implementation

### 7.1 Shared primitives — **VERBATIM**

**Stop words** (module load):
```python
from nltk.corpus import stopwords
STOP_WORDS = set(stopwords.words('english'))
```

**Model pricing + cost + token record:**
```python
_MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-sonnet-4-6":          {"input": 3.00,  "output": 15.00},
    "claude-haiku-4-5-20251001":  {"input": 0.80,  "output":  4.00},
}

def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = _MODEL_PRICING.get(model, {"input": 3.00, "output": 15.00})
    return (input_tokens * p["input"] / 1_000_000) + (output_tokens * p["output"] / 1_000_000)

def _token_record(endpoint: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    cost = _calc_cost(model, input_tokens, output_tokens)
    logger.info(f"[tokens] {endpoint} model={model} in={input_tokens} out={output_tokens} cost=${cost:.5f}")
    return {
        "endpoint": endpoint,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": round(cost, 6),
    }
```

**Lenient Claude-JSON parser** (Haiku sometimes wraps JSON in fences or prose):
```python
def _parse_claude_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract JSON object from preamble text (model may add prose before/after)
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        logger.warning(f"_parse_claude_json: failed to parse JSON, returning empty dict. Raw: {text[:300]}")
        return {}
```

**Rate limiter** (slowapi, keyed on real client IP behind a proxy):
```python
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler

def _real_client_ip(request) -> str:
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP", "")
    if real_ip:
        return real_ip.strip()
    return get_remote_address(request)

limiter = Limiter(key_func=_real_client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```

**Auth — X-API-Key (edge proxy path), fails closed:**
```python
from fastapi.security import APIKeyHeader
from fastapi import Security, HTTPException

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Security(_api_key_header)):
    """Validates X-API-Key header. Fails closed — rejects all requests if NLP_API_KEY is unset."""
    if not NLP_API_KEY:
        raise HTTPException(status_code=503, detail="Service authentication not configured")
    if api_key != NLP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return api_key
```

**Auth — direct Supabase JWT path** (use this dependency instead if the browser calls
the service directly):
```python
async def _verify_jwt_get_user(authorization: str) -> str:
    """Verify a Supabase JWT and return the user_id, or raise 401."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise HTTPException(status_code=503, detail="Supabase not configured on this service")
    token = authorization[7:]
    async with httpx.AsyncClient(timeout=10) as hx:
        r = await hx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return r.json()["id"]
```

### 7.2 Keyword derivation — **VERBATIM**

Model `claude-haiku-4-5-20251001`, `max_tokens=512`. City = first comma-segment of
`location`. Caps siblings to 8, children to 4. **Do not edit the prompt** — the strict
rules are what keep children inside city limits and prevent the seed leaking into
siblings/parents.

```python
async def _derive_related_keywords(keyword: str, location: str, haiku_client) -> tuple:
    """Uses Claude Haiku to derive related keywords per site architecture SOP."""
    city = location.split(",")[0].strip()
    prompt = f"""You are a local SEO site architecture expert.

Given the keyword: "{keyword}"
And the city: "{city}"

Derive related keywords following these STRICT rules:

PARENTS (2-3 items):
- The bare service with no geo (e.g. "emergency plumber" → "plumber")
- The modifier + base service, no city (e.g. "emergency plumber")
- The base service + city (e.g. "plumber {city}")
Do NOT include the original keyword itself.

SIBLINGS (5-8 items):
- Other common sub-services under the SAME parent service + SAME city
- Format: [sub-service] {city} (e.g. "drain cleaning {city}")
- Peer services only — not the original keyword, not parent keywords

CHILDREN (3-4 items):
- Original keyword + specific NEIGHBORHOODS that are geographically WITHIN {city} only
- NOT adjacent cities, NOT county names, NOT broader regions
- Only include neighborhoods you are confident exist inside {city} city limits
- If uncertain, return fewer items

Return ONLY valid JSON, no markdown:
{{"parents": ["...", "..."], "siblings": ["...", ...], "children": ["...", ...]}}"""

    response = await haiku_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    token_rec = _token_record(
        "related-pages/derive", "claude-haiku-4-5-20251001",
        response.usage.input_tokens, response.usage.output_tokens,
    )
    result = _parse_claude_json(response.content[0].text)
    result["siblings"] = result.get("siblings", [])[:8]
    result["children"] = result.get("children", [])[:4]
    return result, token_rec
```

### 7.3 Sitemap discovery

Runs **once per request** (not per keyword). Strategy: `sitemap.xml` → fallback to
`robots.txt`'s `Sitemap:` lines. Caps at 200 URLs. All wrapped in try/except — failure
yields an empty list (→ everything "missing"). This logic lives inline in the endpoint
(§7.5); the verbatim block is reproduced there.

Key parameters:
- Shared client: `httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"})`
- Base normalization: strip trailing `/`, prefix `https://` if no scheme.
- Parse `<loc>` tags with `BeautifulSoup(text, "xml")`, keep `http`-prefixed, `[:200]`.

### 7.4 Page matching — **VERBATIM**

The single most important algorithm to reproduce exactly. For a keyword it returns the
best matching live page `{url, title, h1, is_blog_post}` or `None`. Note the
business-descriptor blocklist `_BD`, the slug-overlap ranking, the strict all-tokens
title/h1 match, and the blog de-prioritization.

```python
async def _find_page_for_keyword_reuse(
    kw: str,
    discovered_urls: List[str],
    client: httpx.AsyncClient,
) -> Optional[dict]:
    """Checks pre-discovered URLs for a page matching kw. Returns {url, title, h1} or None."""
    import urllib.parse as _up
    _BD = {
        "company","companies","contractor","contractors","professional","professionals",
        "provider","providers","specialist","specialists","expert","experts",
        "technician","technicians","team","crew","agency","firm","business",
        "near","me","best","top","trusted","reliable","affordable","licensed",
        "certified","local","cheap","fast",
    }
    kw_lower = kw.lower().strip()
    kw_words = [w for w in re.split(r'[\W_]+', kw_lower) if w and len(w) > 1 and w not in STOP_WORDS and w not in _BD]
    if not kw_words:
        kw_words = [w for w in re.split(r'[\W_]+', kw_lower) if w and len(w) > 1 and w not in STOP_WORDS]
    if not kw_words:
        kw_words = kw_lower.split()

    def _kw_match_local(kw_word: str, page_words: set) -> bool:
        if kw_word in page_words:
            return True
        if len(kw_word) >= 4:
            return any(pw.startswith(kw_word) or kw_word.startswith(pw) for pw in page_words if len(pw) >= 4)
        return False

    def _slug_score_local(u: str) -> int:
        path = _up.urlparse(u).path.lower()
        slug_words = set(re.split(r'[\W/_-]+', path))
        return sum(1 for w in kw_words if any(sw == w or sw.startswith(w) or w.startswith(sw) for sw in slug_words if len(sw) >= 3))

    _blog_seg = re.compile(
        r'/(blog|news|articles?|posts?|insights?|resources?|guides?|tips?|'
        r'updates?|press|media|events?|stories|announcements?|learn)(/|$)',
        re.IGNORECASE,
    )
    _blog_slug = re.compile(
        r'/\d{4}/\d{2}/|/\d{4}-\d{2}-\d{2}[-_]|'
        r'[/-](why|how|what|when|where|top-\d+|best-\d+|\d+-tips|\d+-ways|'
        r'everything-you-need|ultimate-guide|expert-tips|must-know|'
        r'beginners?-guide|complete-guide)-',
        re.IGNORECASE,
    )

    def _is_blog(u: str) -> bool:
        path = _up.urlparse(u).path
        return bool(_blog_seg.search(path) or _blog_slug.search(path))

    async def _check(u: str) -> Optional[dict]:
        try:
            resp = await client.get(u, timeout=8.0)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, 'html.parser')
            t = soup.find('title')
            h = soup.find('h1')
            title_text = t.get_text(strip=True) if t else ''
            h1_text = h.get_text(strip=True) if h else ''
            combined = set(re.split(r'[\W]+', f"{title_text} {h1_text}".lower()))
            if all(_kw_match_local(w, combined) for w in kw_words):
                return {'url': str(resp.url), 'title': title_text or u, 'h1': h1_text,
                        'is_blog_post': _is_blog(u)}
        except Exception:
            pass
        return None

    scored = sorted(discovered_urls, key=_slug_score_local, reverse=True)[:20]
    results = await asyncio.gather(*[_check(u) for u in scored], return_exceptions=True)
    matches = [r for r in results if isinstance(r, dict) and r]
    matches.sort(key=lambda r: r.get('is_blog_post', False))
    return matches[0] if matches else None
```

**Behavioural notes for the agent:**
- Tokenization drops stop-words **and** business descriptors so "best plumber company"
  matches a `/plumber/` page. If filtering empties the list, it degrades gracefully.
- Ranking fetches only the **top 20** slug-scoring URLs (bounds fan-out per keyword).
- A page is a match **only if every** keyword token hits the title/h1 word set (exact, or
  prefix overlap for tokens ≥ 4 chars). This is intentionally strict to avoid false matches.
- `matches.sort(key=is_blog_post)` puts `False` (non-blog) first → a real service/location
  page always wins over a blog mention of the keyword.

### 7.5 The endpoint — **VERBATIM**

```python
@app.post('/related-pages', response_model=RelatedPagesResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def related_pages(request: Request, body: RelatedPagesRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic
    haiku_client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    total_input_tokens = 0
    total_output_tokens = 0

    # Step 1: Derive related keywords via Haiku
    related_kws, derive_tok = await _derive_related_keywords(body.keyword, body.location, haiku_client)
    total_input_tokens += derive_tok.get("input_tokens", 0)
    total_output_tokens += derive_tok.get("output_tokens", 0)

    all_keywords: List[tuple] = []  # (kw, group)
    for kw in related_kws.get("parents", []):
        all_keywords.append((kw, "parents"))
    for kw in related_kws.get("siblings", []):
        all_keywords.append((kw, "siblings"))
    for kw in related_kws.get("children", []):
        all_keywords.append((kw, "children"))

    # Step 2: Discover sitemap / crawlable URLs once
    discovered_urls: List[str] = []
    if body.website:
        base = body.website.strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            base = f"https://{base}"
        async with httpx.AsyncClient(follow_redirects=True,
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"},
                                     timeout=15.0) as http_client:
            # Try sitemap.xml
            try:
                sm_resp = await http_client.get(f"{base}/sitemap.xml")
                if sm_resp.status_code == 200:
                    soup_sm = BeautifulSoup(sm_resp.text, "xml")
                    locs = [tag.get_text(strip=True) for tag in soup_sm.find_all("loc")]
                    discovered_urls = [u for u in locs if u.startswith("http")][:200]
            except Exception:
                pass

            # Fallback: sitemap_index or robots.txt
            if not discovered_urls:
                try:
                    robots_resp = await http_client.get(f"{base}/robots.txt")
                    if robots_resp.status_code == 200:
                        for line in robots_resp.text.splitlines():
                            if line.lower().startswith("sitemap:"):
                                sm_url = line.split(":", 1)[1].strip()
                                sm2 = await http_client.get(sm_url)
                                if sm2.status_code == 200:
                                    soup2 = BeautifulSoup(sm2.text, "xml")
                                    locs2 = [t.get_text(strip=True) for t in soup2.find_all("loc")]
                                    discovered_urls = [u for u in locs2 if u.startswith("http")][:200]
                                    break
                except Exception:
                    pass

            # Step 3: For each keyword, find matching page (no auto-scoring — user scores explicitly)
            async def _process_keyword(kw: str, group: str) -> RelatedPageItem:
                found = await _find_page_for_keyword_reuse(kw, discovered_urls, http_client)
                if found:
                    return RelatedPageItem(
                        keyword=kw,
                        group=group,
                        status="found",
                        url=found["url"],
                        page_title=found.get("title"),
                    )
                else:
                    return RelatedPageItem(keyword=kw, group=group, status="missing")

            results = await asyncio.gather(
                *[_process_keyword(kw, group) for kw, group in all_keywords],
                return_exceptions=True,
            )
            items = [r for r in results if isinstance(r, RelatedPageItem)]
    else:
        # No website — all keywords are "missing"
        items = [RelatedPageItem(keyword=kw, group=group, status="missing")
                 for kw, group in all_keywords]

    token_rec = _token_record(
        "related-pages", "claude-haiku-4-5-20251001",
        total_input_tokens, total_output_tokens,
    )
    return RelatedPagesResponse(items=items, token_usage=token_rec)
```

### 7.6 OPTIONAL — Score an existing "found" page on demand

The planning UI can show a composite score for an existing page. This **reuses the
writer's scorer**. If the target app already has a "score this URL" function, call it and
skip this section. Otherwise port the following.

`_score_page_for_related` (the related-pages-specific wrapper) — **VERBATIM**:
```python
async def _score_page_for_related(
    keyword: str,
    location: str,
    page_url: str,
    business_name: str,
    gbp_category: str,
    address: Optional[str],
    haiku_client,
) -> tuple:
    """Scores a single found page using Haiku. Returns (score_dict, token_rec)."""
    from bs4 import BeautifulSoup as _BS2
    async with httpx.AsyncClient() as _fc:
        _resp = await _fc.get(page_url, timeout=15.0,
                              headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"})
        _resp.raise_for_status()
        page_html = _resp.text
    html_structure = _detect_html_structure(page_html)
    page_text = _BS2(page_html, "html.parser").get_text(separator="\n", strip=True)
    city = location.split(",")[0].strip()
    user_prompt = _build_score_prompt(business_name, gbp_category, keyword, city, address, "", page_text, html_structure)
    msg = await haiku_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {"role": "user", "content": user_prompt},
        ],
    )
    token_rec = _token_record(
        "related-pages/score", "claude-haiku-4-5-20251001",
        msg.usage.input_tokens, msg.usage.output_tokens,
    )
    scores = _parse_claude_json(msg.content[0].text)
    # No serp_analysis available in the related-pages path — coverage engine scores neutral
    scores["serp_signal_coverage"] = _compute_serp_signal_coverage(page_text, None)
    composite, status = _composite_from_scores(scores)
    return {
        "composite_score": composite,
        "composite_status": status,
        "engine_scores": scores,
        "deficiencies": _build_deficiencies(scores),
    }, token_rec
```

Its scorer dependencies — **VERBATIM**:
```python
_ENGINE_WEIGHTS = {
    "organic_ranking":      0.10,
    "gbp_maps":             0.20,
    "entity_establishment": 0.10,
    "icp_alignment":        0.05,
    "aeo_llm_retrieval":    0.20,
    "geographic_legitimacy":0.10,
    "nearme_intent":        0.10,
    "serp_signal_coverage": 0.15,   # deterministic — scored in Python, not Claude
}

_ENGINE_LABELS = {
    "organic_ranking":       "Organic Ranking Engine",
    "gbp_maps":              "GBP / Maps Relevance Engine",
    "entity_establishment":  "Entity Establishment Engine",
    "icp_alignment":         "ICP Alignment Engine",
    "aeo_llm_retrieval":     "AEO / LLM Retrieval Engine",
    "geographic_legitimacy": "Geographic Legitimacy Engine",
    "nearme_intent":         "Hyperlocal / Near-Me Engine",
    "serp_signal_coverage":  "SERP Signal Coverage",
}

def _composite_from_scores(scores: dict) -> tuple[float, str]:
    composite = sum(scores[k]["score"] * w for k, w in _ENGINE_WEIGHTS.items() if k in scores)
    if composite >= 90:   status = "excellent"
    elif composite >= 80: status = "good"
    elif composite >= 70: status = "needs_improvement"
    elif composite >= 60: status = "below_standard"
    else:                 status = "fail"
    return round(composite, 1), status

def _build_deficiencies(scores: dict) -> List[dict]:
    out = []
    for key, label in _ENGINE_LABELS.items():
        eng = scores.get(key, {})
        if eng.get("score", 100) < 80:
            out.append({
                "engine": label,
                "engine_key": key,
                "score": eng.get("score", 0),
                "issues": eng.get("issues", []),
                "recommendations": eng.get("recommendations", []),
            })
    return out

def _detect_html_structure(page_html: str) -> str:
    """Return a plain-English summary of HTML structural elements present/missing."""
    from bs4 import BeautifulSoup as _BS
    soup = _BS(page_html, "html.parser")
    uls   = len(soup.find_all("ul"))
    ols   = len(soup.find_all("ol"))
    tables = len(soup.find_all("table"))
    lines = ["HTML STRUCTURE FACTS (deterministic — do NOT override):"]
    lines.append(f"  • <ul> (bulleted lists): {uls} found" + (" ✓" if uls >= 1 else " ✗ MISSING"))
    lines.append(f"  • <ol> (numbered lists): {ols} found" + (" ✓" if ols >= 1 else " ✗ MISSING"))
    lines.append(f"  • <table> elements: {tables} found" + (" ✓" if tables >= 1 else " — not required unless content is comparative"))
    return "\n".join(lines)

def _build_score_prompt(business_name, gbp_category, keyword, city, address,
                        serp_ctx, page_text, html_structure="") -> str:
    structure_block = f"\n{html_structure}\n" if html_structure else ""
    return f"""CONTEXT
Business: {business_name}
Category: {gbp_category}
Keyword: {keyword}
City: {city}
Address: {address or "Not provided"}
{serp_ctx}{structure_block}
PAGE CONTENT (first 8,000 chars):
{page_text}"""
```

> `_compute_serp_signal_coverage(page_text, None)` returns a neutral score of 50 with an
> "no SERP analysis available" note when called without competitor data (the related-pages
> path). The full function is in the source repo (`services/nlp/main.py`) — port it only
> if you want deterministic SERP-coverage scoring; otherwise a stub returning
> `{"score": 50, "issues": [...], "recommendations": [...]}` is sufficient for this path.
> `_SCORE_SYSTEM_PROMPT` is the writer's scoring rubric (large, shared) — reuse the
> existing one in the target app.

> The reference `/related-pages` does **not** auto-score; scoring is triggered by an
> explicit, separate user action. Wire `_score_page_for_related` behind its own endpoint
> (e.g. `POST /score-related-page`) or fold it into your existing score endpoint, then
> have the UI populate `composite_score`/`deficiencies` on the item from that response.

### 7.7 OPTIONAL — Rankability check (`/check-rankability`)

A supporting per-keyword check ("can this business realistically rank in the Maps pack?").
**Requires DataForSEO credentials.** Skip entirely if the target app has no SERP access.

Request/response models — **VERBATIM (abridged to the fields the UI uses):**
```python
class RankabilityRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    gbp_category: str
    business_name: Optional[str] = None
    gbp_place_id: Optional[str] = None
    # … plus optional business_address / review_count / lat / lng / website / sab_city

# Response includes: score, verdict, score_breakdown, has_map_pack, competitors[],
# ranking_categories[{category,count}], category_match ("exact"|"partial"|"none"),
# review gap metrics, distance, maps presence, message.
```

Core logic (`@limiter.limit("10/minute")`, `Depends(verify_api_key)`):
1. In parallel: fetch organic SERP (`depth=10`, `DATAFORSEO_ENDPOINT`) and Google Maps
   top-10 for the keyword.
2. `has_map_pack` = the organic SERP rendered a `local_pack` item (honest signal).
3. From Maps top-10: collect competitor names/ratings/review counts, count keyword-in-name,
   tally `category` → `ranking_categories` (sorted desc by count).
4. **Category match** vs the business's `gbp_category`:
   `exact` if GBP category contains / is contained by a pack category; `partial` if any
   GBP token > 3 chars appears in a pack category; else `none`.
5. **Hard fail:** if `category_match == "none"`, return `score=0`,
   `verdict="very_difficult"` immediately (ranking is effectively impossible).
6. Otherwise score competition (review gaps, ratings, distance) → verdict ∈
   `strong | moderate | difficult | very_difficult`.

Full source (incl. `_fetch_maps_top10`, `_keyword_in_name`, scoring math) is in
`services/nlp/main.py` `/check-rankability`. Port verbatim if you need this feature.

---

## 8. Edge Proxy (optional) — `supabase/functions/related-pages/index.ts` — **VERBATIM**

Thin auth shim: verifies the Supabase session, forwards to FastAPI with `X-API-Key` +
`X-User-ID`, streams the response back. Skip this entirely if the browser calls the
service directly with a Bearer JWT (then guard the endpoint with `_verify_jwt_get_user`).

```ts
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NLP_SERVICE_URL = Deno.env.get("NLP_SERVICE_URL") ?? "";
const NLP_API_KEY = Deno.env.get("NLP_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const nlpResponse = await fetch(`${NLP_SERVICE_URL}/related-pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": NLP_API_KEY,
        "X-User-ID": user.id,
      },
      body: req.body,
      // @ts-ignore
      duplex: "half",
    });

    const responseHeaders = new Headers(corsHeaders);
    const contentType = nlpResponse.headers.get("Content-Type");
    if (contentType) responseHeaders.set("Content-Type", contentType);

    return new Response(nlpResponse.body, {
      status: nlpResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("related-pages proxy error:", err);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

> Note: the reference frontend posts to a generic `nlp-proxy` function at
> `${SUPABASE_URL}/functions/v1/nlp-proxy` + endpoint path (see §9.1). A dedicated
> `related-pages` function (above) is functionally equivalent — pick one convention and be
> consistent. Register `NLP_SERVICE_URL` and `NLP_API_KEY` as edge-function secrets.

---

## 9. Frontend Implementation

### 9.1 Transport + client wrappers (`nlp-client.ts`) — **VERBATIM**

```ts
export const NLP_SERVICE_URL =
  import.meta.env.VITE_NLP_SERVICE_URL ?? "https://showup-local-production.up.railway.app";
const PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nlp-proxy`;

async function getAuthHeader(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? `Bearer ${session.access_token}` : "";
}

/** Non-streaming POST — resolves to JSON or throws a human-readable error. */
async function nlpPost<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${PROXY_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { detail?: string; error?: string }).detail
      || (d as { detail?: string; error?: string }).error
      || `NLP error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const nlp = {
  relatedPages: (
    body: {
      keyword: string;
      location: string;
      business_name: string;
      gbp_category: string;
      address: string;
      website?: string | null;
    },
    signal?: AbortSignal,
  ) => nlpPost<{ items: RelatedPageItem[] }>("/related-pages", body, signal),

  checkRankability: (
    body: {
      keyword: string;
      location: string;
      gbp_category: string;
      // …optional: location_code, business_name, business_address, business_review_count,
      //   business_lat, business_lng, website, sab_city, gbp_place_id
    },
    signal?: AbortSignal,
  ) => nlpPost<RankabilityResult>("/check-rankability", body, signal),
};
```
> `PROXY_URL` posts to a generic `nlp-proxy` edge function that routes by the endpoint
> path. If you instead use the dedicated `related-pages` function from §8, point
> `relatedPages` at that function's URL.

### 9.2 `PlanningView` component — **VERBATIM**

This is the entire research UI. Key contracts:
- Props: `onCreatePage(keyword, location)`, optional `initialKeyword`/`initialLocation`.
- Loads the user's saved businesses lazily on dropdown open.
- Groups results in fixed order `parents → siblings → children` under labels
  **Parent / Sibling / Neighbourhood**.
- "Create" appears only on `missing` items and calls `onCreatePage`.

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Plus, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { nlp } from "@/lib/nlp-client";
import { LocationAutocomplete } from "@/components/LocationAutocomplete";
import type { RelatedPageItem } from "@/lib/nlp-types";

interface Business {
  id: string;
  business_name: string;
  website?: string;
  gbp_category?: string;
  address?: string;
}

interface RankabilityResult {
  verdict: string;
  match_count: number;
  total_results: number;
  ranking_categories: { category: string; count: number }[];
  message: string;
}

interface Props {
  onCreatePage: (keyword: string, location: string) => void;
  initialKeyword?: string;
  initialLocation?: string;
}

// Map API group names to display labels
const GROUP_LABELS: Record<string, string> = {
  parents:  "Parent",
  siblings: "Sibling",
  children: "Neighbourhood",
};
const GROUP_ORDER = ["parents", "siblings", "children"];

export default function PlanningView({ onCreatePage, initialKeyword = "", initialLocation = "" }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessesLoaded, setBusinessesLoaded] = useState(false);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [keyword, setKeyword] = useState(initialKeyword);
  const [location, setLocation] = useState(initialLocation);
  const [locationInput, setLocationInput] = useState(initialLocation);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<RelatedPageItem[]>([]);
  const [error, setError] = useState("");
  const [rankabilityMap, setRankabilityMap] = useState<Record<string, RankabilityResult>>({});
  const [rankabilityLoading, setRankabilityLoading] = useState<Record<string, boolean>>({});

  // Lazy-load businesses
  const loadBusinesses = async () => {
    if (businessesLoaded) return;
    const { data } = await supabase
      .from("business_profiles")
      .select("id, business_name, website, gbp_category, address")
      .order("business_name");
    setBusinesses(data ?? []);
    setBusinessesLoaded(true);
  };

  const selectedBusiness = businesses.find(b => b.id === selectedBusinessId);

  const handleScan = async () => {
    if (!selectedBusiness || !keyword.trim() || !location) return;
    setScanning(true);
    setResults([]);
    setError("");
    setRankabilityMap({});

    try {
      const { items } = await nlp.relatedPages({
        keyword: keyword.trim(),
        location,
        business_name: selectedBusiness.business_name,
        gbp_category: selectedBusiness.gbp_category ?? "",
        address: selectedBusiness.address,
        website: selectedBusiness.website,
      });
      setResults(items);
    } catch (e: any) {
      setError(e.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const handleCheckRankability = async (kw: string) => {
    if (!selectedBusiness?.gbp_category || !location) return;
    setRankabilityLoading(prev => ({ ...prev, [kw]: true }));
    try {
      const data = await nlp.checkRankability({
        keyword: kw,
        location,
        gbp_category: selectedBusiness.gbp_category,
      });
      setRankabilityMap(prev => ({ ...prev, [kw]: data }));
    } catch {
      setRankabilityMap(prev => ({
        ...prev,
        [kw]: { verdict: "unknown", match_count: 0, total_results: 0, ranking_categories: [], message: "Could not retrieve map pack data." },
      }));
    } finally {
      setRankabilityLoading(prev => ({ ...prev, [kw]: false }));
    }
  };

  const grouped = GROUP_ORDER.map(grp => ({
    group: grp,
    label: GROUP_LABELS[grp],
    items: results.filter(r => r.group === grp),
  })).filter(g => g.items.length > 0);

  const missingCount = results.filter(r => r.status === "missing").length;
  const existsCount  = results.filter(r => r.status === "found").length;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Planning</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Discover missing local SEO pages for a keyword by checking what related pages your site already has.
        </p>
      </div>

      {/* Form */}
      <div className="bg-card border rounded-xl p-5 space-y-4">
        <div className="space-y-1.5">
          <Label>Business</Label>
          <Select
            value={selectedBusinessId}
            onValueChange={setSelectedBusinessId}
            onOpenChange={open => open && loadBusinesses()}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a business…" />
            </SelectTrigger>
            <SelectContent>
              {businesses.map(b => (
                <SelectItem key={b.id} value={b.id}>{b.business_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedBusiness?.website && (
            <p className="text-xs text-muted-foreground">{selectedBusiness.website}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Seed Keyword</Label>
            <Input
              placeholder="e.g. tree service"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              disabled={scanning}
            />
          </div>
          <LocationAutocomplete
            label="Location"
            value={location}
            inputValue={locationInput}
            onSelect={(loc) => { setLocation(loc.name); setLocationInput(loc.name); }}
            onInputChange={(raw) => { setLocationInput(raw); setLocation(""); }}
            onClear={() => { setLocation(""); setLocationInput(""); }}
            disabled={scanning}
          />
        </div>

        <Button
          className="w-full"
          onClick={handleScan}
          disabled={scanning || !selectedBusiness || !keyword.trim() || !location}
        >
          {scanning
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing…</>
            : <><Search className="w-4 h-4 mr-2" />Scan Site</>
          }
        </Button>
      </div>

      {/* Loading */}
      {scanning && (
        <div className="bg-muted/30 border rounded-xl p-6 flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-sm">Discovering related keywords and checking your site…</p>
          <p className="text-xs opacity-60">This takes about 30–60 seconds</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">{error}</p>
      )}

      {/* Results */}
      {!scanning && results.length > 0 && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{results.length} related keywords checked</span>
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100">{existsCount} pages exist</Badge>
            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">{missingCount} missing</Badge>
          </div>

          {/* Grouped results */}
          {grouped.map(({ group, label, items }) => (
            <div key={group} className="bg-card border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/40 border-b">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label} Keywords</span>
              </div>
              <div className="divide-y">
                {items.map((item, i) => {
                  const rank = rankabilityMap[item.keyword];
                  const rankLoading = rankabilityLoading[item.keyword];
                  return (
                    <div key={i} className="px-4 py-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.keyword}</p>
                          {item.url && (
                            <a href={item.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-muted-foreground hover:text-accent flex items-center gap-1 mt-0.5 truncate">
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <span className="truncate">{item.page_title || item.url}</span>
                            </a>
                          )}
                        </div>

                        {item.composite_score != null && (
                          <span className={`text-xs font-semibold shrink-0 ${
                            item.composite_score >= 80 ? "text-green-500"
                            : item.composite_score >= 60 ? "text-amber-500"
                            : "text-red-500"
                          }`}>
                            {Math.round(item.composite_score)}/100
                          </span>
                        )}

                        <Badge className={`shrink-0 ${item.status === "found"
                            ? "bg-green-100 text-green-700 hover:bg-green-100"
                            : "bg-amber-100 text-amber-700 hover:bg-amber-100"}`}>
                          {item.status === "found" ? "Exists" : "Missing"}
                        </Badge>

                        {item.status === "missing" && (
                          <Button size="sm" variant="outline" className="shrink-0"
                            onClick={() => onCreatePage(item.keyword, location)}>
                            <Plus className="w-3.5 h-3.5 mr-1" />
                            Create
                          </Button>
                        )}
                        {item.status === "found" && item.url && (
                          <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" asChild>
                            <a href={item.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </Button>
                        )}
                      </div>

                      {rank && (
                        <div className={`text-xs px-2.5 py-1.5 rounded-md border ${
                          rank.verdict === "match"   ? "bg-green-50 border-green-200 text-green-700" :
                          rank.verdict === "partial" ? "bg-amber-50 border-amber-200 text-amber-700" :
                                                       "bg-red-50 border-red-200 text-red-700"
                        }`}>
                          <span className="font-medium">{
                            rank.verdict === "match"    ? "✓ Strong Maps rankability" :
                            rank.verdict === "partial"  ? "⚠ Partial category match" :
                            rank.verdict === "mismatch" ? "✗ Category mismatch" : "Unknown"
                          }</span>
                          {rank.total_results > 0 && (
                            <span className="ml-1.5 opacity-80">({rank.match_count}/{rank.total_results} map results match your category)</span>
                          )}
                          {rank.verdict === "partial" && (
                            <p className="mt-0.5 opacity-90">You may be able to rank with a highly optimized page, but will need strong off-page signals.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```
> The component declares `handleCheckRankability` and `rankLoading`; wire a "Check
> rankability" button per item if you ship §7.7, otherwise they're harmless no-ops. The
> `RankabilityResult` interface here is the UI subset; the full type is in §6/`nlp-types.ts`.

### 9.3 Saved-business data source

`PlanningView` reads businesses from a Supabase `business_profiles` table with at least
`id, business_name, website, gbp_category, address`. The target app must have an
equivalent table/RLS so the dropdown and the request payload (`business_name`,
`gbp_category`, `address`, `website`) can be populated.

### 9.4 The write handoff — **VERBATIM**

The research UI never generates content; it pre-fills the existing writer. In the host
page (`Index.tsx`):
```tsx
const [planningKeyword, setPlanningKeyword] = useState("");
const [planningLocation, setPlanningLocation] = useState("");

// …
{activeItem === "planning" && (
  <PlanningView
    initialKeyword={planningKeyword}
    initialLocation={planningLocation}
    onCreatePage={(kw, loc) => {
      setPlanningKeyword(kw);
      setPlanningLocation(loc);
      setActiveItem("content");   // navigate to the existing writer view
    }}
  />
)}
```

**Contract for the target app:** the writer view must accept `initialKeyword` and
`initialLocation` (props, route params, or query string) and start its normal generation
flow pre-populated. Research and writing stay decoupled — they communicate only through
`(keyword, location)`. No shared state, no DB coupling.

---

## 10. Cross-Cutting Concerns

| Concern | Spec |
|---|---|
| **Auth** | `/related-pages` guarded by `Depends(verify_api_key)` (X-API-Key, fails closed). For direct browser→service, swap to `_verify_jwt_get_user`. Edge proxy verifies the Supabase session first. |
| **Rate limits** | `/related-pages`: **5/min**. `/check-rankability` & scoring: **10/min**. Keyed on real client IP (`X-Forwarded-For` aware). |
| **Timeouts** | Sitemap client 15s; per-candidate page fetch 8s; scoring fetch 15s. |
| **Concurrency** | Keyword matching uses `asyncio.gather` across all derived keywords; each match fetches ≤20 candidate pages concurrently. |
| **Error handling** | All crawl fetches in try/except → degrade keyword to `missing`, never 500. Edge proxy returns `502 {"error":"Service temporarily unavailable"}` on upstream failure. |
| **Cost** | Core flow = one Haiku call (≤512 output tokens) + HTTP GETs. No paid SERP/NLP credits. Returned in `token_usage`. Pricing: Haiku $0.80/$4.00 per Mtok in/out. |
| **Request size** | Reference service caps request bodies at 2 MB via middleware. |
| **CORS** | `CORS_ORIGINS` env (comma-separated); never allow credentials with `*`. |

---

## 11. Test Plan & Acceptance Criteria

### 11.1 Unit / behavioural
- **Derivation:** seed `"emergency plumber"`, city `"Anaheim"` → parents exclude the seed;
  siblings are `"<subservice> Anaheim"` peers; children are `"emergency plumber <neighborhood>"`
  with neighborhoods inside Anaheim only; caps respected (siblings ≤8, children ≤4).
- **`_parse_claude_json`:** handles bare JSON, ```json fenced, and prose-wrapped JSON;
  returns `{}` on garbage.
- **`_find_page_for_keyword_reuse`:**
  - tokenization drops stop-words + descriptors (`"best plumber company"` → `["plumber"]`);
  - a `/services/drain-cleaning/` page matches `"drain cleaning Anaheim"` only if every
    non-filtered token hits title/h1;
  - given both a blog post and a service page that match, the **service page** is returned;
  - non-200 / timeout / parse error → `None` (no exception).
- **Endpoint, no `website`:** every item returns `status="missing"`.
- **Endpoint, sitemap 404 + robots has Sitemap:** falls back and still discovers URLs.

### 11.2 Integration
- Full request returns grouped items; `token_usage.cost_usd > 0`; latency ~30–60s for a
  real site with a large sitemap.
- 6th request within a minute → HTTP 429.
- Missing `ANTHROPIC_API_KEY` → 503; missing/incorrect `X-API-Key` (proxy path) → 401/503.

### 11.3 Frontend acceptance
- Scan disabled until business + non-empty keyword + resolved location.
- Results render under Parent / Sibling / Neighbourhood; empty groups hidden; summary
  counts correct.
- "Create" only on missing items; clicking navigates to the writer pre-filled with the
  item's keyword + the scanned location.
- Found items link out to the discovered URL/title.

### 11.4 Edge cases to handle
- Website with no sitemap and no robots Sitemap line → all `missing` (graceful).
- Sitemap index pointing to nested sitemaps → reference only follows robots-listed
  sitemaps one level; deep nesting may under-discover (known limitation — document it).
- Non-ASCII / accented neighbourhood names — pass through untouched.
- Very large sitemaps — capped at 200 URLs; matching capped at top-20 per keyword.

---

## 12. Build Checklist

**Service**
- [ ] §7.1 primitives: `STOP_WORDS`, pricing/`_calc_cost`/`_token_record`,
      `_parse_claude_json`, limiter, `verify_api_key` (+ `_verify_jwt_get_user` if direct).
- [ ] §7.2 `_derive_related_keywords` (prompt verbatim, caps).
- [ ] §7.4 `_find_page_for_keyword_reuse` (verbatim).
- [ ] §7.5 `POST /related-pages` with models from §6 (verbatim), 5/min limit, dual-auth dep.
- [ ] (Optional) §7.6 scoring endpoint; (optional) §7.7 `/check-rankability`.

**Edge / proxy** (skip if calling service directly)
- [ ] §8 `related-pages` (or generic `nlp-proxy`) function; secrets `NLP_SERVICE_URL`, `NLP_API_KEY`.

**Frontend**
- [ ] §9.1 `nlpPost` + `getAuthHeader` + `nlp.relatedPages` (+ `checkRankability`).
- [ ] §6.3 `RelatedPageItem` type (+ `RankabilityResult` if used).
- [ ] §9.2 `PlanningView`; §9.3 `business_profiles` data source; `LocationAutocomplete`.
- [ ] §9.4 `onCreatePage` wired to pre-fill + navigate to the existing writer.

**Verify**
- [ ] §11 test plan green.

---

## 13. Reference File Map (source app)

| Concern | File · symbol |
|---|---|
| Keyword derivation | `services/nlp/main.py` · `_derive_related_keywords` |
| Page matching | `services/nlp/main.py` · `_find_page_for_keyword_reuse` |
| Endpoint + models | `services/nlp/main.py` · `/related-pages`, `RelatedPages*` |
| Shared primitives | `services/nlp/main.py` · `STOP_WORDS`, `_parse_claude_json`, `_token_record`, `_calc_cost`, `_MODEL_PRICING`, `verify_api_key`, `_verify_jwt_get_user`, `limiter` |
| Optional scoring | `services/nlp/main.py` · `_score_page_for_related`, `_composite_from_scores`, `_build_deficiencies`, `_detect_html_structure`, `_build_score_prompt`, `_compute_serp_signal_coverage`, `_ENGINE_WEIGHTS` |
| Optional rankability | `services/nlp/main.py` · `/check-rankability`, `_fetch_maps_top10`, `_keyword_in_name` |
| Edge proxy | `supabase/functions/related-pages/index.ts` |
| Client wrappers | `src/lib/nlp-client.ts` · `relatedPages`, `checkRankability`, `nlpPost`, `getAuthHeader` |
| Types | `src/lib/nlp-types.ts` · `RelatedPageItem`, `RankabilityResult`, `EngineScore` |
| UI | `src/components/PlanningView.tsx` |
| Write handoff | `src/pages/Index.tsx` · `onCreatePage` → `setActiveItem("content")` |
| Taxonomy SOP | `docs/site_architecture_sop.md` |
```
