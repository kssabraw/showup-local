# System Overview & Build Orchestrator — Local SEO Content Platform

> **Read this first.** This is the master document for rebuilding (a portable
> version of) the ShowUP Local platform in a new app. It explains what the system
> is, how the modules fit together, the shared data model, and the order to build
> in. Each module has its own detailed PRD (linked below) and a drop-in code file.
>
> **How to use this in a fresh chat:** upload this file + the PRDs + the
> `port/` code files, then say: *"Build this system per SYSTEM_OVERVIEW.md. Start
> with the foundation (data model + SERP analysis), then the modules in the build
> order. Ask me before each module if anything is ambiguous."*

---

## 1. What you are building

A **local-SEO content generation platform**. A user adds a local business (a
"client"), and the system helps them **show up in local search** by:

1. Understanding the business (its **ICP**, **differentiators**, **brand voice**).
2. Analysing the **competitors** ranking for a target keyword in a target city.
3. **Planning** which pages the business should have (and which are missing).
4. **Scoring** any page against a local-SEO rubric.
5. (Adjacent, not yet ported) **Generating / improving** optimized pages.

**Target customer:** any local business that relies on its Google Business
Profile to generate leads — restaurants, dental/medical, legal, auto, salons,
contractors, home services, etc.

**The throughline:** every feature is grounded in **real competitor data** (the
SERP analysis pipeline) and the **client's own facts** (ICP / brand voice /
differentiators) — never generic filler.

---

## 2. The modules at a glance

| # | Module | PRD | Backend code | Frontend code | External APIs |
|---|---|---|---|---|---|
| 0 | **SERP Analysis** (shared upstream) | `SERP_ANALYSIS_PRD.md` | `serp_analysis.py` | *(4-tab results view — not ported)* | DataForSEO, ScrapeOwl, Google NLP |
| 1 | **ICP Creator** | `ICP_CREATOR_PRD.md` | `icp_creator.py` | *(in Client Dashboard)* | LLM |
| 2 | **Brand Voice** | `BRAND_VOICE_PRD.md` | `brand_voice.py` | *(in Client Dashboard)* | LLM, ScrapeOwl |
| 3 | **Client Dashboard** | `CLIENT_DASHBOARD_PRD.md` | — (UI only) | `ClientDashboard.tsx` | — |
| 4 | **Content Planning** | `CONTENT_PLANNING_PRD.md` | `content_planning.py` | `PlanningView.tsx` | LLM (+ optional DataForSEO Maps) |
| 5 | **Score My Page** | `SCORE_MY_PAGE_PRD.md` | `score_page.py` | `PageScoreView.tsx` | LLM (+ SERP Analysis) |

All backend modules are **drop-in FastAPI routers** with a no-op `_auth_dependency`
seam; all frontend components are **React + TypeScript + Tailwind** decoupled from
any backend via an injected `api` adapter.

---

## 3. How it fits together (data flow)

```
                         ┌─────────────────────────────┐
                         │   Client (business) record   │  ← shared entity (§5)
                         │  name, category, website,    │
                         │  detected_icp, differentiators,
                         │  brand_voice, ...            │
                         └──────────────┬──────────────┘
        ┌───────────────┬──────────────┼───────────────┬────────────────┐
        ▼               ▼              ▼                ▼                ▼
  [1 ICP Creator]  [2 Brand Voice]  [3 Client Dashboard]   [4 Content Planning]   [5 Score My Page]
   /analyze-business /analyze-brand-voice  (view/edit all   /related-pages         /score-page
        │               │           the client's data)          │                     │
        └───────────────┴── write detected_icp / brand_voice ───┘                     │
                                    │                                                  │
                                    ▼                                                  ▼
                          ┌──────────────────────────  [0 SERP Analysis: /analyze]  ──────────┐
                          │  DataForSEO → ScrapeOwl → TF-IDF / quadgrams / Google entities      │
                          │  → serp_analysis dict (CACHE by keyword+location)                   │
                          └─────────────────────────────────────────────────────────────────┘
                                    │ feeds                                  │ feeds
                                    ▼                                        ▼
                         (Score My Page rubric +                  (Page generation /
                          deterministic engine)                    reoptimize — not ported)
```

**Key relationships**
- **SERP Analysis (0)** is the shared upstream. **Score My Page (5)** consumes its
  output (`serp_analysis`); so does the (not-yet-ported) generator.
- **ICP Creator (1)** and **Brand Voice (2)** both write JSON onto the **client
  record**; the **Client Dashboard (3)** is the UI to view/edit that data and to
  trigger (1) and (2).
- **Content Planning (4)** derives related keywords and checks the client's site
  for gaps; "Create" on a missing page hands `(keyword, location)` to generation;
  "Score" on an existing page hands its URL to **Score My Page (5)**.
- **Score My Page (5)** can run **SERP Analysis (0)** inline when no cached
  `serp_analysis` is provided (via the `SERP_ANALYSIS_PROVIDER` hook).

---

## 4. Dependency graph & build order

Build foundation-first. Each step is independently testable.

```
Foundation
  A. Data model + client record (§5)            ← everything writes here
  B. Auth seam + (optional) rate limiting        ← every backend router
  C. SERP Analysis (0)  serp_analysis.py         ← upstream for 5 (+ generation)

Client knowledge (parallel-ok, all write the client record)
  1. ICP Creator         icp_creator.py
  2. Brand Voice         brand_voice.py
  3. Client Dashboard    ClientDashboard.tsx     ← surfaces + edits 1 & 2

Workflows (depend on the above)
  4. Content Planning    content_planning.py + PlanningView.tsx
  5. Score My Page       score_page.py + PageScoreView.tsx   ← consumes C

Adjacent (not in this package — wire callbacks/hooks)
  • Page generation / reoptimize  (the largest module)
  • Rankability check (DataForSEO Maps)  — optional in Content Planning
```

**Recommended sequence for the new chat:** A → B → C → (1, 2) → 3 → 4 → 5.

---

## 5. Shared data model (the client record)

All modules read/write one central record (call it `clients` /
`business_profiles`). Minimum fields and the JSON blobs each module owns:

```jsonc
{
  "id": "uuid",
  // ── identity (from onboarding / a GBP lookup) ──
  "business_name": "Example Plumbing",
  "gbp_category": "Plumber",
  "gbp_categories": ["Plumber", "Drainage service"],
  "website": "https://example.com",
  "address": "123 Main St, Anaheim, CA",
  "phone": "+1 714-555-0100",
  "description": "…", "hours": ["…"], "rating": 4.8, "review_count": 212,
  "logo": "…", "photo": "…", "maps_uri": "…",

  // ── written by ICP Creator (module 1) ──
  "existing_pages": [ /* page records {url,title,h1,page_type,…} */ ],
  "detected_icp": { "segments": [ /* IcpSegment */ ], "reasoning": "…" },
  "differentiators": [ { "claim": "…", "mechanism": "…", "type": "speed" } ],
  "analysis_status": "complete",          // pending|running|complete|partial|failed

  // ── written by Brand Voice (module 2) ──
  "brand_voice": {
    "current_voice": { /* VoiceProfile */ },
    "recommended_voice": { /* VoiceProfile */ },
    "recommended_accepted": null,         // null|true|false
    "writer_execution_guide": { /* … */ }
  }
}
```

Plus a **separate cache** for SERP analysis (the expensive op):
```jsonc
// keyword_analyses, unique on (client_id?, keyword, location)
{ "client_id": "…", "keyword": "…", "location": "…", "serp_analysis": { /* AnalysisResponse */ } }
```
And, if you persist scores: a `generated_pages` / `page_scores` table holding
`content_html`, `composite_score`, `composite_status`, `deficiencies`, etc.

> Exact per-module field shapes (VoiceProfile, IcpSegment, AnalysisResponse,
> ScoreResult) are defined in each module's PRD §3 and mirrored in the code files'
> type definitions / Pydantic models.

---

## 6. External services & environment variables

| Service | Used by | Env vars | Notes |
|---|---|---|---|
| **LLM** (Anthropic Claude) | 1, 2, 4, 5 | `ANTHROPIC_API_KEY` | Cheap/fast model (`claude-haiku-4-5`) for 1/2/4; **Sonnet-class** (`claude-sonnet-4-6`) for 5 (rubric scoring). SERP Analysis (0) does **not** use the LLM. |
| **DataForSEO** | 0, (4 rankability) | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Organic SERP URLs; Maps pack for the optional rankability check. |
| **ScrapeOwl** | 0, 2 | `SCRAPEOWL_API_KEY` | Premium-proxy scraping; optional for 2 (`USE_SCRAPEOWL=false` → plain GET). |
| **Google Cloud NLP** | 0 | `GOOGLE_NLP_API_KEY` | Entity analysis; optional (skipped if unset). |
| Model overrides | various | `BRAND_VOICE_MODEL`, `ICP_MODEL`, `SCORE_MODEL`, `RELATED_MODEL` | Per-module model override. |

Everything degrades gracefully when a key is missing (the PRDs specify each
fallback). The two hard requirements for the core loop: **ANTHROPIC_API_KEY** and,
for real competitor data, **DataForSEO + ScrapeOwl**.

---

## 7. Integration seams (what the new app must supply)

Each ported file is intentionally decoupled. Wire these:

1. **Auth** — replace `_auth_dependency` in every backend router with your API-key
   / JWT check (and credit deduction if you meter usage).
2. **Persistence** — the frontends call an injected `api` adapter; implement
   `saveClient` / `scorePage` / `relatedPages` / `runIcpAnalysis` /
   `scanBrandVoice` against your DB + these endpoints (examples in `README.md`).
3. **SERP cache** — persist `AnalysisResponse` by `(keyword, location)`; pass the
   cached dict into Score My Page; only run `/analyze` on a miss. Set
   `score_page.SERP_ANALYSIS_PROVIDER` to run it inline when missing.
4. **Model choice** — keep Sonnet for scoring; Haiku for the cheaper LLM calls.
5. **Rate limiting** — the originals used slowapi (5–10/min); wire if desired.
6. **Vertical/tone** — prompts say "local service business"; edit the system
   prompts if your customers differ.

---

## 8. File manifest

**PRDs (specs — `docs/`)**
- `SYSTEM_OVERVIEW.md` — this file (start here)
- `SERP_ANALYSIS_PRD.md`, `ICP_CREATOR_PRD.md`, `BRAND_VOICE_PRD.md`,
  `CLIENT_DASHBOARD_PRD.md`, `CONTENT_PLANNING_PRD.md`, `SCORE_MY_PAGE_PRD.md`

**Code (drop-in — `docs/port/`)**
- Backend (FastAPI): `serp_analysis.py`, `icp_creator.py`, `brand_voice.py`,
  `content_planning.py`, `score_page.py`
- Frontend (React/TS): `ClientDashboard.tsx`, `PlanningView.tsx`, `PageScoreView.tsx`
- `requirements.txt`, `README.md` (per-module quick starts + adapter examples)

> The backend modules each **duplicate** small shared helpers (SSRF guard, page
> classification, sitemap discovery) so each is standalone. If you prefer DRY,
> factor those into one `web_discovery.py` and import — but duplication keeps each
> file independently droppable.

---

## 9. What's NOT in this package (build separately if needed)

- **Page generation / reoptimize pipeline** — the 13-section HTML generator, the
  SEO-checklist builder, and the auto-retry score→reoptimize loop. This is the
  largest single module; the others are designed to feed it (`serp_analysis`,
  `detected_icp`, `brand_voice`, `differentiators`, deficiencies). Score My Page's
  "Improve" CTA and Content Planning's "Create" action are the hooks into it.
- **Rankability check** (`/check-rankability`) — DataForSEO-Maps engine; optional
  per-keyword action in Content Planning.
- **Onboarding / GBP lookup** — how the client record is first populated (a Google
  Places lookup in the original). Modules 1 & 2 can also infer from name+category
  when no website exists.
- **Credits/billing, the SERP results UI, and app shell/navigation.**

---

## 10. Suggested first message to the new chat

> "We're building a portable local-SEO content platform. Read
> `SYSTEM_OVERVIEW.md` for the architecture, then the per-module PRDs. The
> `port/` files are drop-in FastAPI routers + React components decoupled via auth
> dependencies and `api` adapters. Our stack is **[your stack/DB]**. Start with
> the foundation: create the client data model (§5), wire auth, and stand up the
> SERP Analysis service (`serp_analysis.py`). Then do ICP + Brand Voice, the
> Client Dashboard, Content Planning, and Score My Page in that order. Before each
> module, confirm the data-model fields and the adapter wiring with me."
```
