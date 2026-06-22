# PRD — Silo / Related-Pages Research + Write Handoff

**Status:** Implementation spec for replication
**Owner:** Platform
**Last updated:** 2026-06-22
**Source feature:** ShowUP Local "Content Planning" (`PlanningView` → `/related-pages`)

---

## 1. Purpose & Scope

This document specifies how to replicate ShowUP Local's **silo page research** feature
in another app on the **same stack** (React/Vite frontend, Python FastAPI service,
Supabase, Claude). It covers two things:

1. **Silo / related-pages research** — given one seed keyword + location + a business,
   derive the related keyword silo (parents / siblings / neighbourhood children),
   then check the business's existing website to flag which silo pages already exist
   vs. are missing.
2. **The write handoff** — how a "missing" silo page is handed off to the
   (already-built) content writer so the user can have it written.

**Out of scope:** the content-generation engine itself (prompts, scoring, reoptimize
loop). That is assumed to already exist in the target app. This PRD only defines the
**interface** the planning feature uses to invoke it (§9).

---

## 2. Goals & Non-Goals

### Goals
- Turn a single seed keyword into a structured, SOP-compliant silo of related keywords.
- Detect, against the live site, which silo pages already exist (and where) vs. are missing.
- Let the user trigger generation of any missing page in one click, pre-filled.
- Cheap: no SERP scraping or paid NLP credits required for the research step.

### Non-Goals
- No competitor scraping / TF-IDF / entity analysis during planning (that belongs to
  the separate analyze + generate pipeline).
- No automatic page generation — the user explicitly chooses what to create.
- No write-back to the customer's site; this is read-only crawl + recommendation.

---

## 3. High-Level Architecture

```
┌─────────────┐   relatedPages()    ┌──────────────────┐   X-API-Key + X-User-ID   ┌────────────────────┐
│  Frontend   │ ──────────────────▶ │ Supabase Edge Fn │ ────────────────────────▶ │  FastAPI /related- │
│ PlanningView│                     │  related-pages   │                           │      pages         │
└─────────────┘ ◀────────────────── └──────────────────┘ ◀──────────────────────── └────────────────────┘
       │            { items[] }                                                              │
       │                                                                       ┌─────────────┴──────────────┐
       │ onCreatePage(kw, loc)                                                 │ 1. Claude Haiku: derive kw │
       ▼                                                                       │ 2. Fetch sitemap.xml       │
┌─────────────┐                                                               │ 3. Match kw → existing page│
│  Writer view│  (existing generation pipeline — out of scope)                └────────────────────────────┘
└─────────────┘
```

Three actors:

| Layer | Component | Responsibility |
|---|---|---|
| Frontend | `PlanningView.tsx` | Form, calls API, groups results, "Create" button |
| Edge | Supabase Fn `related-pages` | Auth (verify JWT) + proxy to FastAPI with `X-API-Key` + `X-User-ID` |
| Service | FastAPI `/related-pages` | Keyword derivation (Haiku) + sitemap discovery + page matching |

> The edge function is a thin auth/proxy shim. In the target app you may call the
> FastAPI service directly with a Bearer JWT (the service supports dual auth — see §10).

---

## 4. Reference: Page Taxonomy (the "silo")

The keyword derivation follows a site-architecture SOP. Each derived keyword maps to a
page type in the silo:

| Group (API) | UI label | Page type | URL pattern | Title pattern | Example |
|---|---|---|---|---|---|
| `parents` | Parent | Service / Location / Service+City | `/service/`, `/location/` | `{Service} \| {Brand}` | `plumber`, `plumber Anaheim` |
| `siblings` | Sibling | Peer local landing pages | `/location/service/` | `{Service} {City} \| {Brand}` | `drain cleaning Anaheim` |
| `children` | Neighbourhood | Neighbourhood silo pages | `/location/neighborhood/` | `{Service} {Neighborhood} \| {Brand}` | `emergency plumber Sawtelle` |

Silo rules (enforced in the derivation prompt):
- **Parents** = the broader pages this page should link up to (bare service, service+city).
- **Siblings** = peer sub-services in the same city under the same parent service.
- **Children** = the same keyword scoped to specific neighbourhoods **inside the city only**
  (no adjacent cities, counties, or regions).

---

## 5. Data Contracts

### 5.1 Request — `POST /related-pages`

```ts
interface RelatedPagesRequest {
  keyword: string;        // seed keyword, e.g. "emergency plumber"
  location: string;       // "Anaheim, California, United States"
  business_name: string;
  gbp_category: string;   // Google Business Profile category
  address?: string | null;
  website?: string | null; // if absent, every item returns status="missing"
}
```

### 5.2 Response

```ts
interface RelatedPagesResponse {
  items: RelatedPageItem[];
  token_usage: TokenRecord;   // { model, input_tokens, output_tokens, cost_usd }
}

interface RelatedPageItem {
  keyword: string;
  group: "parents" | "siblings" | "children";
  status: "found" | "missing";
  url?: string;             // present when found
  page_title?: string;      // present when found
  // Populated only if the page is scored on demand (§7):
  composite_score?: number;
  composite_status?: string;
  engine_scores?: Record<string, EngineScore>;
  deficiencies?: Array<{ engine: string; issue: string; fix: string }>;
}
```

---

## 6. Service Logic — `/related-pages`

Three sequential steps. Pseudocode mirrors the reference implementation.

### Step 1 — Derive related keywords (Claude Haiku)

Model: `claude-haiku-4-5-20251001`, `max_tokens=512`.
City = `location.split(",")[0].strip()`.

**Exact prompt:**

```
You are a local SEO site architecture expert.

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
{"parents": ["...", "..."], "siblings": ["...", ...], "children": ["...", ...]}
```

Post-processing:
- Parse JSON (strip markdown fences defensively).
- Cap: `siblings[:8]`, `children[:4]`.
- Flatten into `(keyword, group)` tuples preserving order parents → siblings → children.
- Record token usage.

### Step 2 — Discover the site's URLs (once)

Only if `website` is provided. Normalize: strip trailing `/`, prefix `https://` if no scheme.

```
1. GET {base}/sitemap.xml
   - parse <loc> tags (XML parser), keep http(s) URLs, cap at 200.
2. If empty, GET {base}/robots.txt
   - for each line starting "sitemap:", fetch that sitemap, parse <loc>, cap 200, stop at first hit.
3. If still empty → discovered_urls = [] (all keywords become "missing").
```

Use one shared `httpx.AsyncClient(follow_redirects=True, timeout=15s,
User-Agent="Mozilla/5.0 (compatible; ShowUPBot/1.0)")`.

### Step 3 — Match each keyword to an existing page

For every `(keyword, group)`, run `_find_page_for_keyword_reuse(kw, discovered_urls, client)`
**concurrently** (`asyncio.gather`). Algorithm:

1. **Tokenize keyword** → lowercase, split on non-word chars, drop tokens that are
   length ≤ 1, stop-words, or in the **business-descriptor blocklist** (`company`,
   `contractor`, `professional`, `provider`, `specialist`, `expert`, `technician`,
   `team`, `crew`, `agency`, `firm`, `business`, `near`, `me`, `best`, `top`,
   `trusted`, `reliable`, `affordable`, `licensed`, `certified`, `local`, `cheap`,
   `fast`, plural variants). Fall back to keeping stop-word-filtered tokens, then raw
   split, if filtering empties the list.
2. **Rank candidate URLs** by slug overlap: count keyword tokens whose stem matches a
   path-slug word (`==`, or either `startswith` the other for words ≥ 3 chars). Take
   **top 20**.
3. **Fetch + verify** each candidate (`GET`, 8s timeout). Parse `<title>` + `<h1>`.
   Build a word set from `title + h1`. The page is a **match** only if **every**
   keyword token matches a title/h1 word (exact, or prefix-overlap for tokens ≥ 4 chars).
4. **Blog de-prioritization:** flag a URL as a blog post if its path matches blog
   segments (`/blog/`, `/news/`, `/articles/`, `/posts/`, `/insights/`, `/resources/`,
   `/guides/`, `/tips/`, `/press/`, `/media/`, `/events/`, `/learn/`, …) or blog-style
   slugs (`/2024/03/`, `why-`, `how-`, `top-10-`, `ultimate-guide-`, `\d-tips-`, …).
   Sort matches so **non-blog pages win**; return the first.
5. Return `{url, title, h1, is_blog_post}` or `None`.

Map result → `RelatedPageItem`:
- match → `status="found"`, `url`, `page_title=title`.
- no match → `status="missing"`.

If `website` was absent, skip steps 2–3 and mark **all** items `missing`.

Return `{ items, token_usage }`.

---

## 7. Optional — Score an existing "found" page on demand

When the user wants to know how good an existing silo page is, score it without
re-running SERP analysis. `_score_page_for_related(...)`:

1. Fetch the page HTML (15s, browser UA).
2. Detect HTML structure + extract visible text.
3. Build the standard score prompt and call Haiku with the cached scoring system prompt.
4. Parse engine scores. `serp_signal_coverage` is computed deterministically (neutral,
   since no SERP analysis is present in this path).
5. Compute composite + status; build the `deficiencies` list.
6. Populate `composite_score`, `composite_status`, `engine_scores`, `deficiencies` on
   the item.

> This reuses the target app's existing scorer. If the writer app already exposes a
> "score this URL" function, call that instead of duplicating logic.

---

## 8. Optional — Rankability check (`/check-rankability`)

A supporting per-keyword check the planning UI offers ("can this business realistically
rank in the Maps pack?"). Requires DataForSEO credentials.

Inputs: `{ keyword, location, gbp_category, ... }`.
Logic:
1. In parallel: fetch organic SERP (`depth=10`) and Google Maps top-10 for the keyword.
2. `has_map_pack` = whether the organic SERP rendered a `local_pack` widget.
3. From Maps top-10: collect competitor names/ratings/review counts, count businesses
   with the keyword in their name, tally `category` values → `ranking_categories`.
4. **Category match** vs the business's `gbp_category`:
   - `exact` if the GBP category contains / is contained by a pack category;
   - `partial` if any GBP category token (>3 chars) appears in a pack category;
   - `none` otherwise.
5. **Hard fail:** if `category_match == "none"`, return `score=0`,
   `verdict="very_difficult"` immediately (ranking is effectively impossible).
6. Otherwise score competition (review gaps, ratings, distance) → `verdict` of
   `strong | moderate | difficult | very_difficult`.

This is **optional** to replicate — it depends on DataForSEO and is not required for the
core silo research flow. Include only if the target app already has SERP access.

---

## 9. The Write Handoff

The whole point of the research is to feed the writer. The planning UI never writes
content itself — it pre-fills the existing writer:

```ts
// PlanningView receives a callback prop:
onCreatePage: (keyword: string, location: string) => void;

// "Create" button on a MISSING item:
<Button onClick={() => onCreatePage(item.keyword, location)}>Create</Button>
```

In the host page (`Index.tsx`), the callback stashes the keyword/location into state and
switches the active view to the content writer, which reads `initialKeyword` /
`initialLocation`:

```ts
onCreatePage={(kw, loc) => {
  setPlanningKeyword(kw);
  setPlanningLocation(loc);
  setActiveItem("content");   // navigate to the existing writer view
}}
```

**Contract for the target app:** the writer view must accept `initialKeyword` and
`initialLocation` props (or equivalent query/route params) and start its normal
generation flow pre-populated. No other coupling is required — research and writing stay
decoupled, communicating only through `(keyword, location)`.

---

## 10. Cross-Cutting Concerns

### Auth
- Endpoint guarded by `Depends(verify_api_key)`. Dual mode:
  - `X-API-Key` header (used by the edge-function proxy; proxy also forwards `X-User-ID`), or
  - `Authorization: Bearer <Supabase JWT>` (direct frontend → service).
- Edge function verifies the Supabase session before proxying; rejects with 401 if absent.

### Rate limits
- `/related-pages`: **5 / minute** per client.
- `/check-rankability` and scoring: **10 / minute**.

### Timeouts
- Sitemap discovery client: 15s.
- Per-candidate page fetch in matching: 8s.
- On-demand scoring fetch: 15s.
- All page fetches wrapped in try/except — failures degrade to "missing", never 500.

### Cost
- Research = a single Haiku call (~≤512 output tokens) + plain HTTP GETs. No paid SERP /
  NLP credits. Track via `token_usage` in the response.

### Error handling
- Edge proxy returns `502 {"error":"Service temporarily unavailable"}` on upstream failure.
- Network errors during crawl are swallowed per-URL; the keyword simply reports `missing`.

---

## 11. Frontend Spec — `PlanningView`

State/flow:
1. Lazy-load the user's saved businesses on dropdown open.
2. Form: business select, seed keyword input, location autocomplete. "Scan Site" disabled
   until business + keyword + resolved location are set.
3. On scan: call `relatedPages({ keyword, location, business_name, gbp_category, address,
   website })`, set `items`.
4. Group results by `group` in fixed order `parents → siblings → children`, render under
   labels **Parent / Sibling / Neighbourhood**; hide empty groups.
5. Summary line: total checked, `N pages exist` (green), `M missing` (amber).
6. Per item:
   - `found` → green "Exists" badge, link to `page_title`/`url`, optional composite-score
     badge (green ≥80, amber ≥60, red <60), open-link button.
   - `missing` → amber "Missing" badge + **Create** button → `onCreatePage`.
   - Optional "Check rankability" affordance per item → `checkRankability(...)`, render
     verdict chip (match / partial / mismatch with `match_count/total_results`).
7. Loading + error states; ~30–60s expected scan duration messaging.

---

## 12. Implementation Checklist

**Service**
- [ ] `POST /related-pages` with request/response models (§5).
- [ ] `_derive_related_keywords()` — exact prompt (§6.1), JSON parse, caps, token record.
- [ ] Sitemap discovery (sitemap.xml → robots.txt fallback, cap 200) (§6.2).
- [ ] `_find_page_for_keyword_reuse()` — tokenize + blocklist + slug ranking + title/h1
      verification + blog de-prioritization (§6.3).
- [ ] Concurrent per-keyword matching via `asyncio.gather`.
- [ ] Dual auth dependency + 5/min rate limit.
- [ ] (Optional) on-demand page scoring (§7); (optional) `/check-rankability` (§8).

**Edge / proxy**
- [ ] `related-pages` edge function: verify JWT, forward to service with `X-API-Key` +
      `X-User-ID`, stream response, 502 on failure. (Skip if calling service directly.)

**Frontend**
- [ ] `relatedPages()` / `checkRankability()` client wrappers + TS types (§5).
- [ ] `PlanningView` component (§11).
- [ ] `onCreatePage(kw, loc)` wired to pre-fill and navigate to the existing writer (§9).

---

## 13. Appendix — Reference Files (source app)

| Concern | File |
|---|---|
| Keyword derivation | `services/nlp/main.py` → `_derive_related_keywords()` |
| Page matching | `services/nlp/main.py` → `_find_page_for_keyword_reuse()` |
| On-demand scoring | `services/nlp/main.py` → `_score_page_for_related()` |
| Endpoint | `services/nlp/main.py` → `/related-pages` |
| Rankability | `services/nlp/main.py` → `/check-rankability` |
| Edge proxy | `supabase/functions/related-pages/index.ts` |
| Client wrappers | `src/lib/nlp-client.ts` (`relatedPages`, `checkRankability`) |
| Types | `src/lib/nlp-types.ts` (`RelatedPageItem`, `RankabilityResult`) |
| UI | `src/components/PlanningView.tsx` |
| Write handoff | `src/pages/Index.tsx` (`onCreatePage` → `setActiveItem("content")`) |
| Taxonomy SOP | `docs/site_architecture_sop.md` |
```
