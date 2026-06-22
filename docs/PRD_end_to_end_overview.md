# PRD — ShowUP Local: End-to-End Process (Master Overview)

**Status:** Build-ready overview for replication by a coding agent (Claude Code)
**Owner:** Platform
**Last updated:** 2026-06-22
**Scope:** The complete user journey — add business → input service + location → rankability report → silo report → create pages (single/bulk) → score/reoptimize → publish.
**Target stack:** React/Vite + TypeScript · Python 3.11 FastAPI · Supabase · DataForSEO · ScrapeOwl · Google NLP · Anthropic Claude

---

## 0. How to use this document

This is the **master overview** — the connective tissue that explains how the whole
product fits together and in what order a user moves through it. It is detailed at the
**journey, architecture, data-flow, endpoint, and orchestration** level.

For **verbatim, build-ready implementation** of individual features, this doc points to
four companion PRDs (all in `docs/`):

| Companion PRD | Covers |
|---|---|
| `PRD_rankability_report.md` | "Can I rank in the Maps pack?" — `/check-rankability`, scoring rubric, monthly cap |
| `PRD_silo_pages.md` | Silo/related-keyword research + site gap check — `/related-pages` |
| `PRD_bulk_silo_creation.md` | Multi-select missing pages → sequential generate + save |
| (this doc, §6) | The generation/scoring pipeline — `/analyze`, `/generate-page`, `/score-page`, `/reoptimize-page` |

Build order for the new app is in **§10**. Read this doc top-to-bottom first, then build
each phase using the companion PRD for that phase.

---

## 1. Product Overview

**What it is:** a local-SEO content platform. A user connects their Google Business
Profile (GBP), enters a service keyword + target city, and the app (1) tells them whether
that keyword is winnable in the Maps pack, (2) maps the silo of related pages they should
have and which already exist, (3) generates optimized, factually-grounded local landing
pages, and (4) scores + improves them.

**Who:** any local business that relies on its GBP for leads (brick-and-mortar, medical,
legal, auto, salons, contractors; SABs like plumbers/HVAC are a subset).

**Core value loop:** *research before you write* (rankability + silo gap) → *write at
scale* (single or bulk generation) → *prove quality* (8-engine scoring) → *improve*
(reoptimize). The name plays on "showing up" in local search.

---

## 2. The End-to-End Journey (the spine)

The journey is a funnel from "who are you" → "what/where" → "should I?" → "what's missing"
→ "make it" → "is it good". Each phase has a primary view, the endpoints it calls, and the
data it reads/writes.

```
 PHASE 0 ─ Auth (Supabase)
    │
 PHASE 1 ─ Onboarding: search GBP → save business_profiles → background business analysis
    │        (BusinessSearchView → dual-write-business → analyze-business / brand-voice)
    │
 PHASE 2 ─ Intent: pick business + type service keyword + target city (NewContentView)
    │
 PHASE 3 ─ Rankability report  ── "should I target this keyword here?"
    │        (/check-rankability → score, verdict, competitor pack, barriers)
    │
 PHASE 4 ─ Site scan + Silo report ── "what pages should exist, which already do?"
    │        (/find-page-for-keyword  +  /related-pages, in parallel)
    │
 PHASE 5 ─ Create  ──────────────┬── single page  (/generate-page, streaming)
    │                            └── bulk: select N missing → sequential generate+save
    │        (each generate runs: analyze → checklist → Claude → auto-score/reoptimize loop)
    │
 PHASE 6 ─ Score / Reoptimize ── "is it good, and how do I get it to 90+?"
    │        (/score-page, /reoptimize-page, content-gaps "how to reach 100" panel)
    │
 PHASE 7 ─ Manage / Publish: Saved Pages (export HTML+schema), Press Releases, Locations
```

### Phase 0 — Authentication
Supabase email/password auth. The session JWT is the credential for every downstream call
(directly to the FastAPI service, or via the Supabase edge proxy). Unauthenticated → login.

### Phase 1 — Onboarding (connect a business)
**View:** `BusinessSearchView` → on confirm, `Index.handleBusinessConfirm`.
1. User searches their business by name; a Places lookup returns suggestions.
2. Selecting one fetches full details (`BusinessDetails`: place_id, name, description,
   address, phone, website, category + categories, rating, review_count, lat/lng, hours,
   reviews, maps URI).
3. Confirm → `dual-write-business` edge function upserts a `business_profiles` row
   (unique on `gbp_place_id`).
4. App navigates to the Content view; if the business has a website, a **background
   business analysis** kicks off (`analyzeBusiness`): extracts `existing_pages`,
   `detected_icp`, and `differentiators`, and (separately) brand voice — all stored on the
   business row. These enrich later generation (tone, ICP targeting, factual grounding).

> **Why it matters downstream:** the persisted fields are the inputs to every other phase.
> `address` (blank ⇒ SAB), `lat/lng`, `gbp_review_count`, `gbp_category`, and
> `gbp_place_id` drive **rankability**; `website` drives the **silo site scan**;
> `detected_icp`, `differentiators`, `brand_voice`, `reviews`, `hours`, `description` drive
> **generation** (and factual-accuracy constraints).

### Phase 2 — Intent (service + location)
**View:** `NewContentView` (the orchestration hub). The user selects a saved business,
types a **service keyword** (e.g. "emergency plumber"), and picks a **location** via an
autocomplete that resolves a canonical `location` string (and optional DataForSEO
`location_code`). Everything after this keys on `(business, keyword, location)`.

### Phase 3 — Rankability report  → see `PRD_rankability_report.md`
"Check Map Pack" calls `/check-rankability`. Returns a 0–100 score, a verdict
(`strong|moderate|difficult|very_difficult`), a points breakdown, the live competitor
pack (ratings/reviews), and concrete barriers (category mismatch, distance, review gap,
branded competitor names, SAB-vs-physical). Two hard-fails short-circuit to 0: category
mismatch and >10 mi distance. **Purpose:** qualify the keyword *before* spending
generation effort. Governed by a separate **50/month** cap (not content credits).

### Phase 4 — Site scan + Silo report  → see `PRD_silo_pages.md`
Two calls fire in parallel:
- `/find-page-for-keyword` — does a page for *this* keyword already exist on the site?
- `/related-pages` — derive the silo (parents / siblings / neighbourhood children) via
  Claude Haiku, then crawl the site's sitemap to mark each related keyword `found` or
  `missing`.

The **Related Pages panel** renders the silo grouped Parent/Sibling/Neighbourhood. Found
items link out (and can be scored); missing items get a checkbox. **Purpose:** turn one
keyword into a structured content plan and reveal the gaps.

> The standalone **Planning** view (`PlanningView`) is the same silo research as a
> dedicated screen; its "Create" navigates back to the Content view pre-filled.

### Phase 5 — Create  → single = §6 pipeline; bulk = `PRD_bulk_silo_creation.md`
- **Single:** "Create new page" streams `/generate-page` for `(keyword, location,
  business)` and saves the result to `generated_pages`.
- **Bulk:** select N missing silo keywords → a **sequential** client-side queue runs
  `/generate-page` for each, auto-saving every result, with live progress + per-item
  credit refunds on failure.

Either way, generation runs the full pipeline (§6): optional inline SERP analysis →
data-driven SEO checklist → Claude generates a 13-section HTML page + JSON-LD schema →
auto score-and-reoptimize loop targeting 90+ → returns HTML, schema, score, and a
`content_gaps` report.

### Phase 6 — Score / Reoptimize
- **Score My Page** (`ScoreMyPageView`) and the per-page score view call `/score-page`
  (8-engine composite). 
- A page below target can be **reoptimized** (`/reoptimize-page`) or section-level
  improved (`/reoptimize-section`).
- The `content_gaps` panel ("How to reach 100/100") lists unverified facts (response
  times, certifications, pricing) the user can add to GBP/site, then regenerate.

### Phase 7 — Manage / Publish
- **Saved Pages** (`SavedPagesView`): list, view, export `content_html` + `schema_json`.
- **Press Releases** (`PressReleasesView`): separate generation flow (`/generate-press-release`).
- **Locations** (`LocationsView`/`LocationDetailView`): manage saved businesses.
- **Settings**: account, password, billing.

---

## 3. System Architecture

Three tiers + two auth paths.

```
┌──────────────────────────┐     ┌───────────────────────────────┐     ┌──────────────────────────────┐
│ Frontend (React/Vite)    │     │ Supabase                      │     │ FastAPI NLP service (Railway)│
│ - views + nav state      │     │ - Postgres (business_profiles,│     │ - full pipeline endpoints    │
│ - nlp-client (fetch/SSE) │     │   keyword_analyses,           │     │ - DataForSEO / ScrapeOwl /   │
│ - Supabase JS client     │     │   generated_pages, …)         │     │   Google NLP / Claude calls  │
│                          │     │ - Auth (JWT)                  │     │ - slowapi rate limits        │
│                          │     │ - Edge functions (nlp-proxy)  │     │ - dual auth (API key / JWT)  │
└──────────┬───────────────┘     └──────────────┬────────────────┘     └───────────────┬──────────────┘
           │                                     │                                       │
           │  A) non-streaming via edge proxy:   │  X-API-Key + X-User-ID                │
           │     fetch ${SUPABASE}/functions/v1/nlp-proxy/<endpoint> ───────────────────▶│
           │        (proxy deducts credits / enforces caps, then forwards)               │
           │                                                                             │
           │  B) streaming, direct to Railway (bypasses 150s edge timeout):              │
           │     fetch ${NLP_SERVICE_URL}/generate-page  (Authorization: Bearer JWT) ───▶│
           │        (service verifies JWT, deducts credits itself)                       │
           └─────────────────────────────────────────────────────────────────────────────
```

**Auth modes (dual):** the FastAPI service accepts **either** `X-API-Key` (set by the
edge proxy, which also forwards `X-User-ID`) **or** `Authorization: Bearer <Supabase JWT>`
(direct from the browser). 
- **Edge-proxied** (`nlpPost`) is used for short calls — the proxy is the single place
  credits are deducted and caps enforced.
- **Direct streaming** (`nlpStreamDirect`) is used for long calls (`/generate-page`,
  `/reoptimize-page`) to avoid the edge function's 150-second timeout; the service deducts
  credits itself via a direct-JWT path.

**Why a Python service at all:** the heavy lifting (SERP fetch, concurrent scraping,
TF-IDF, n-grams, Google entity analysis, deterministic scoring) is Python-native; Claude is
called from there with cached system prompts.

---

## 4. Data Model (Supabase)

| Table | Key columns | Role |
|---|---|---|
| `business_profiles` | `gbp_place_id` (unique), `business_name`, `address`, `phone`, `website`, `gbp_category`/`gbp_categories`, `gbp_rating`, `gbp_review_count`, `latitude`, `longitude`, `hours`, `reviews`, `description`, `detected_icp`, `differentiators`, `brand_voice`, `existing_pages`, `analysis_status` | The connected GBP business + enrichment. Feeds every phase. |
| `keyword_analyses` | unique on `(business_id, keyword, location)`; full SERP analysis JSON | Cached competitor analysis — re-runs upsert to save API credits. |
| `generated_pages` | `business_id`, `keyword`, `location`, `mode` (`generate`/`reoptimize`), `page_title`, `content_html`, `schema_json`, `content_gaps` (jsonb), `composite_score`, `composite_status`, `scored_at` | Generated pages (single + bulk). |
| `user_profiles` | credit balances; `rankability_checks_used`/`_per_month`/`reset_at`; `role` | Billing + the rankability monthly cap. |
| `token_usage` | `model`, `input_tokens`, `output_tokens`, `cost_usd`, `business_id`, `keyword` | Per-call LLM cost logging. |

**Persistence boundaries:** rankability and silo research results are **ephemeral** (UI
state, not stored). Generated pages and SERP analyses **are** persisted.

---

## 5. Endpoint Catalog (FastAPI service)

| Endpoint | Method | Stream | Credits¹ | Purpose | Spec |
|---|---|---|---|---|---|
| `/check-rankability` | POST | no | 50/mo cap² | Map-pack rankability report | `PRD_rankability_report.md` |
| `/related-pages` | POST | no | — | Silo derivation + site gap check | `PRD_silo_pages.md` |
| `/find-page-for-keyword` | POST | no | — | Does a page for this keyword exist on the site? | `PRD_silo_pages.md` (matching) |
| `/analyze` | POST | no | 2 | Competitor SERP analysis (TF-IDF, quadgrams, entities) | §6.1 |
| `/generate-page` | POST | **SSE** | 2 | Generate a full local landing page | §6.2, `PRD_bulk_silo_creation.md` |
| `/score-page` | POST | no | 1 | 8-engine composite score for a page/URL | §6.3 |
| `/reoptimize-page` | POST | **SSE** | 2 | Rewrite a page to fix deficiencies | §6.4 |
| `/reoptimize-section` | POST | no | 0 | Rewrite one HTML section | §6.4 |
| `/analyze-business` | POST | no | — | Site/ICP/differentiator extraction (onboarding) | Phase 1 |
| `/analyze-brand-voice` | POST | no | — | Brand-voice extraction (onboarding) | Phase 1 |
| `/generate-social-posts` | POST | no | — | GBP post drafts from a page | (adjacent) |
| `/generate-press-release` | POST | no | PR credit³ | Press release generation | (adjacent) |

¹ Credits deducted by the edge proxy (`nlp-proxy`) for proxied calls; `/generate-page` and
`/reoptimize-page` deduct via the direct-JWT path when streamed directly.
² Rankability is gated by a **monthly cap** (default 50, admins bypass), not content credits.
³ Press releases use a separately-purchased PR-credit pool.

All endpoints are `verify_api_key`-guarded and slowapi rate-limited.

---

## 6. The Generation / Scoring Pipeline (detail)

This is the engine behind Phase 5–6. The other three companion PRDs assume it exists; this
section specifies it at overview level.

### 6.1 Analysis — `POST /analyze`
```
Frontend → /analyze
  1. DataForSEO — top-N organic SERP URLs (blocklist filters directories/social)
  2. ScrapeOwl — scrape each URL concurrently
  3. BeautifulSoup — parse into zones (title, h1, h2_h3, body, paragraphs)
  4. TF-IDF + cosine similarity — related keywords per zone (page-spread thresholds)
  5. N-gram analysis — quadgrams from <p> tags
  6. Google NLP API — entity analysis (salience + page spread)
  → returns related_keywords{by zone}, top_quadgrams, google_entities, zone_targets
  → frontend upserts to keyword_analyses (cache)
```

### 6.2 Generation — `POST /generate-page` (SSE stream)
```
1. Optional inline SERP analysis (if no cached analysis passed)
2. _build_seo_checklist() — deterministic checklist from the scoring rubric + SERP data
   (ZIP codes, target quadgrams, entity targets with mention counts, ICP CTA, etc.)
3. Claude (sonnet-class) — generates a 13-section HTML page + JSON-LD schema, under a
   system prompt enforcing AEO/structural rules + FACTUAL ACCURACY (never invent response
   times, certifications, years, pricing, team size — only assert what's in GBP data)
4. Parse content_html, schema_json, content_gaps
5. Auto score-and-reoptimize loop (up to MAX_AUTO_PASSES): score → if < 90, reoptimize
6. SSE "done" event → result; frontend saves to generated_pages (+ token_usage)
```
SSE events: `{progress, message}` during work; `{step:"done", result}` at the end;
`{step:"error", message}` on failure. (Event types are verbatim in `PRD_bulk_silo_creation.md` §3.)

### 6.3 Scoring — `POST /score-page` (8 engines, weighted composite)
| Engine | Weight | Scored by |
|---|---|---|
| organic_ranking | 0.10 | Claude |
| gbp_maps | 0.20 | Claude |
| entity_establishment | 0.10 | Claude |
| icp_alignment | 0.05 | Claude |
| aeo_llm_retrieval | 0.20 | Claude |
| geographic_legitimacy | 0.10 | Claude |
| nearme_intent | 0.10 | Claude |
| serp_signal_coverage | 0.15 | **deterministic (Python)** |

Composite → status bands: `≥90 excellent · ≥80 good · ≥70 needs_improvement · ≥60
below_standard · else fail`. Deficiencies (engines < 80) drive the improve flow. (Scoring
internals are reproduced in `PRD_silo_pages.md` §7.6.)

### 6.4 Reoptimize — `/reoptimize-page` (whole page) / `/reoptimize-section` (one section)
Takes the deficiencies list from scoring and rewrites to fix them, re-scoring after. This
is the "Improve Mode" that closes the gap to 90+.

---

## 7. The Content View State Machine (orchestration hub)

`NewContentView` is where Phases 2–6 converge for a single keyword. Its internal state
machine ties the features together:

```
form (idle)
  │  user: business + keyword + location set
  ├─ "Check Map Pack" ──▶ rankabilityLoading ──▶ rankability result card (Phase 3)
  │
  └─ "Check site"      ──▶ scanning
         │  parallel: /find-page-for-keyword  +  /related-pages
         ├─ found page  ──▶ checkState="found" (advisory: confirm/override) ──▶ score view
         ├─ no page     ──▶ checkState="not_found"
         └─ relatedPages ──▶ Related Pages panel (Phase 4)
                                ├─ missing item → checkbox → selectedForCreate
                                │     └─ "Create N selected" → bulk queue (Phase 5 bulk)
                                ├─ missing item → "Create" → generate single (Phase 5)
                                └─ found item   → "Score →" → score view (Phase 6)

generation (single or bulk) ──▶ /generate-page SSE ──▶ save generated_pages ──▶ Saved Pages
score view ──▶ /score-page ──▶ breakdown + deficiencies ──▶ /reoptimize-page (Phase 6)
```

Key state: `checkState` (`idle|scanning|found|not_found`), `view` (`form|score|generating`),
`rankability`, `relatedPages`, `selectedForCreate`, plus the bulk-run state (see
`PRD_bulk_silo_creation.md` §7.1). The same Related Pages panel is reused across the form,
score, and generating views.

---

## 8. Navigation / Information Architecture

Sidebar (`AppSidebar`), single-page app with view-swap state in `Index.tsx` (no router):

| Nav item | View | Phase |
|---|---|---|
| **New Location** (button) | `BusinessSearchView` | 1 |
| Dashboard | `DashboardView` | — (home/metrics) |
| **Content** | `NewContentView` | 2–6 (hub) |
| Saved Pages | `SavedPagesView` | 7 |
| Planning | `PlanningView` | 4 (standalone silo) |
| Score My Page | `ScoreMyPageView` | 6 |
| Press Releases | `PressReleasesView` | 7 |
| Locations | `LocationsView`/`LocationDetailView` | 1 (manage) |
| Settings | `SettingsView` | — |

The sidebar also shows three live balances: **Analysis & Content** credits (monthly),
**Map Pack Checks** (monthly cap), **Press Releases** (purchased pool).

---

## 9. Cross-Cutting Concerns

| Concern | Spec |
|---|---|
| **Auth** | Supabase JWT everywhere. Service dual-auth: `X-API-Key` (edge proxy) or `Bearer JWT` (direct). Edge proxy verifies the session before forwarding. |
| **Credits** | Edge proxy (`nlp-proxy`) deducts per-endpoint credits and refunds on 5xx. Streaming endpoints deduct via direct-JWT path; the client refunds on failure (see bulk PRD §9). Rankability uses a 50/month cap instead of credits. |
| **Rate limits** | Per-endpoint slowapi limits (e.g. `/related-pages` 5/min, `/check-rankability` & `/score-page`-class 10/min). |
| **Timeouts** | Long generations stream **direct to Railway** to dodge the 150s edge limit. |
| **Cost control** | SERP analyses cached in `keyword_analyses`; rankability/silo use no paid SERP credits beyond their own calls; `token_usage` logs every LLM cost. |
| **Factual accuracy** | Generation may only assert facts present in GBP/business data; unverifiable facts go into `content_gaps`, never the page body. |
| **Error handling** | Per-call try/catch; graceful degradation (e.g. silo keyword → "missing" on crawl failure; rankability → neutral points on geocode failure); edge proxy returns 502 on upstream failure. |
| **External data** | DataForSEO (SERP + Maps), ScrapeOwl (scraping), Google NLP (entities), Nominatim (geocoding), Anthropic (LLM). Keys via service env vars. |

---

## 10. Build Order for the New App

Phase the build so each step is demoable on its own:

1. **Foundation** — Supabase project + auth; `business_profiles`, `generated_pages`,
   `keyword_analyses`, `user_profiles`, `token_usage` tables; the FastAPI service skeleton
   with dual auth + slowapi (see `PRD_silo_pages.md` §7.1 for the verbatim primitives).
2. **Onboarding (Phase 1)** — GBP search + `dual-write-business`; background
   `analyze-business`/`analyze-brand-voice`. Now you have businesses with rich fields.
3. **Generation pipeline (Phase 5–6 core, §6)** — `/analyze`, `/generate-page` (SSE),
   `/score-page`, `/reoptimize-page`. This is "the writer" the other PRDs depend on.
4. **Rankability (Phase 3)** — build from `PRD_rankability_report.md` (+ monthly cap).
5. **Silo research (Phase 4)** — build from `PRD_silo_pages.md` (`/related-pages`,
   `/find-page-for-keyword`, the Related Pages panel).
6. **Bulk creation (Phase 5 bulk)** — build from `PRD_bulk_silo_creation.md`.
7. **Content view orchestration (§7)** — wire rankability + scan + silo + create into the
   single hub view with the state machine above.
8. **Manage/Publish (Phase 7)** — Saved Pages export, Locations, Press Releases.
9. **Credits/limits + sidebar balances (§9)** — the edge proxy gating + UI meters.

> Minimum viable slice: Phases 1 → 2 → 4 → 5(single). Rankability (3) and bulk (5-bulk)
> are high-value add-ons that layer cleanly on top once the pipeline exists.

---

## 11. Companion PRDs & Reference Map

| Companion PRD | Phase | What to copy from it |
|---|---|---|
| `docs/PRD_rankability_report.md` | 3 | `/check-rankability` endpoint, scoring rubric, geo/SAB helpers, monthly cap RPCs, report UI |
| `docs/PRD_silo_pages.md` | 4 | `/related-pages` + matching, Haiku derivation prompt, shared primitives (auth/limiter/JSON/cost), `PlanningView` |
| `docs/PRD_bulk_silo_creation.md` | 5 (bulk) | `nlpStreamDirect`, `createAndSavePage`, `handleBulkCreate`, progress UI, refund model |
| this doc §6 | 5–6 (core) | Pipeline shape for `/analyze`, `/generate-page`, `/score-page`, `/reoptimize-page` |

**Key source files (overview):**

| Concern | File |
|---|---|
| Nav + view-swap state | `src/pages/Index.tsx`, `src/components/AppSidebar.tsx` |
| Onboarding | `src/components/BusinessSearchView.tsx`; edge `dual-write-business` |
| Orchestration hub | `src/components/NewContentView.tsx` |
| Standalone silo | `src/components/PlanningView.tsx` |
| Score / improve | `src/components/ScoreMyPageView.tsx`, `PageScoreView.tsx`, `GeneratedPageView.tsx` |
| Saved pages | `src/components/SavedPagesView.tsx` |
| API client (fetch + SSE) | `src/lib/nlp-client.ts`; types in `src/lib/nlp-types.ts` |
| Edge proxy (credits/caps) | `supabase/functions/nlp-proxy/index.ts` |
| Service (all endpoints) | `services/nlp/main.py` |
| Product spec | `docs/PRD_part1.md`, `docs/PRD_part2.md`, `docs/SPEC.md` |
```
