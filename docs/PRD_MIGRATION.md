# ShowUP Local — Portable Product Requirements Document (Migration PRD)

> **Purpose:** A complete, self-contained specification of ShowUP Local as it is *actually built today*, written so the product can be rebuilt or migrated onto a different stack/app without access to this codebase.
> **Audience:** Engineers and product owners standing the app up on a new platform.
> **Status reference:** Reflects the live implementation (8-engine scoring, DataForSEO → ScrapeOwl → TF-IDF → Google NLP → Claude pipeline), not just the original design docs.
> **Date:** 2026-06-22

---

## 1. Product Summary

**What it is:** A SaaS web app that generates, scores, and improves **local SEO service pages** for local businesses. A user enters a keyword + location; the app analyzes the live competitor pages currently ranking for that query, extracts SEO signals, and uses them to generate a fully written, publish-ready HTML page (plus JSON-LD schema), graded against a multi-engine scoring rubric.

**The name** "ShowUP" = showing up in local search.

**Target customer:** Any local business that relies on its Google Business Profile (GBP) for leads — restaurants, medical/dental, legal, auto, salons, retail, contractors, and service-area businesses (plumbers, HVAC, electricians).

**Core value proposition:** Turn one keyword + business into a page that is optimized simultaneously for (a) Google organic ranking, (b) Google Map Pack relevance, (c) AI/LLM answer-engine retrieval (ChatGPT/Gemini/Perplexity), and (d) conversion — graded with a transparent composite score and a "how to reach 100" gap report.

**Explicit non-goals (v1):** publishing directly to a CMS, rank tracking, keyword research, backlink analysis, social distribution, CRM/lead tracking, AI image generation, multi-user/team accounts.

---

## 2. System Architecture (current implementation)

Four cooperating layers. When rebuilding, these roles must be preserved; the specific vendors can be swapped.

| Layer | Current tech | Role | Swappable with |
|---|---|---|---|
| **Frontend** | React + TypeScript + Vite, Tailwind + shadcn/ui | UI, auth session, calls NLP service directly | Any SPA framework |
| **NLP / generation service** | Python 3.11 FastAPI on Railway (Docker) | The brain: SERP analysis, scoring, all LLM calls | Any server runtime (Node, Python, Go) |
| **Database + Auth** | Supabase (Postgres + Auth + RLS) | Users, businesses, analyses, generated pages, credits | Any Postgres + auth provider |
| **External APIs** | DataForSEO, ScrapeOwl, Google Cloud NLP, Anthropic Claude | SERP fetch, scraping, entity extraction, generation/scoring | See §5 |

**Critical architectural decision:** The frontend calls the FastAPI service **directly** (sending the Supabase JWT as `Authorization: Bearer <token>`), *bypassing* any serverless edge-function proxy. This was done to avoid a 150-second serverless timeout — page generation with auto-retry can take minutes. The generation endpoint streams progress via **Server-Sent Events (SSE)**. **Any rebuild must preserve a long-lived, streaming-capable request path for generation** — do not route generation through a short-timeout serverless function.

**Auth model (dual):** the NLP service accepts EITHER an `X-API-Key` header (for trusted server-to-server / proxy calls) OR a `Authorization: Bearer <JWT>` (verified against the auth provider's user API). Generation/scoring endpoints that cost credits require the JWT so the user can be identified and charged.

---

## 3. The Core Pipeline

### 3.1 Analysis (`POST /analyze`)

Given `{ keyword, location }`, produce the SEO signal set from live competitors:

1. **DataForSEO** — fetch the top **10** organic SERP URLs for the keyword+location.
2. **Domain blocklist** — drop aggregators/social that can't be competed with structurally:
   `yelp.com, yellowpages.com, bbb.org, angi.com, thumbtack.com, homeadvisor.com, houzz.com, instagram.com, twitter.com, x.com, youtube.com, tiktok.com, wikipedia.org, amazon.com, ebay.com, angieslist.com, nextdoor.com, mapquest.com, maps.google.com`
   **Intentionally allowed (not blocked):** `reddit.com, linkedin.com, facebook.com, quora.com`.
3. **ScrapeOwl** — scrape each surviving URL concurrently (`render_js: false`).
4. **BeautifulSoup** — parse each page into **zones**: `title`, `h1`, `h2_h3`, `body`, `paragraphs`.
5. **TF-IDF + cosine similarity** — extract *related keywords per zone*, ranked by similarity to the target keyword and filtered by how many competitor pages they appear on (page spread).
6. **N-gram analysis** — extract **quadgrams** (4-word phrases) from `<p>` tags only.
7. **Google Cloud NLP API** — entity analysis: salience + mention counts per entity across pages.

**Filtering constants (tunable thresholds — keep them configurable):**

```
SERP_RESULT_COUNT       = 10     # URLs fetched from DataForSEO
RELATED_MIN_PAGE_SPREAD = 0.49   # term must appear on >= 49% of competitor pages
RELATED_MIN_SIMILARITY  = 0.10   # min cosine similarity to the keyword
QUADGRAM_MIN_PAGE_SPREAD= 0.49
QUADGRAM_MIN_SIMILARITY = 0.10
ENTITY_MIN_PAGE_SPREAD  = 0.49
ENTITY_MIN_SALIENCE     = 0.40   # keep only entities Google scores >= 0.40 salience
```

The analysis result is cached in the DB keyed on `(business_id, keyword, location)` so re-running does not re-burn API credits.

**`/analyze` response shape:**

```json
{
  "keyword": "emergency plumber anaheim",
  "location": "Anaheim, California, United States",
  "serp_urls": ["https://..."],
  "related_keywords": {
    "title": [{ "term": "...", "score": 0.42, "page_spread": 7, "page_spread_pct": 0.7, "type": "related" }],
    "h1": [], "h2_h3": [], "body": []
  },
  "top_quadgrams": [{ "phrase": "...", "page_spread": 6, "page_spread_pct": 0.6, "similarity_score": 0.31 }],
  "google_entities": [{ "name": "Anaheim", "entity_type": "LOCATION", "mean_salience": 0.52,
                        "page_spread": 9, "page_spread_pct": 0.9, "recommended_mentions": 4 }]
}
```

### 3.2 Generation (`POST /generate-page`, SSE stream)

1. **Optional inline SERP analysis** — if no cached analysis is passed in, run §3.1 first.
2. **`_build_seo_checklist()`** — pre-compute a deterministic, data-filled checklist from the scoring rubric + SERP data. This injects *exact* targets into the LLM prompt: ZIP codes, the quadgram phrases to include, per-zone keyword/entity targets, the ICP and its CTA tone, neighborhoods, etc. **This is the heart of the generation strategy ("Strategy 3"): the LLM is not asked to be clever about SEO — it is handed the exact strings to place in exact zones.**
3. **Claude (generation model: `claude-sonnet-4-6`)** — generate the full 13-section HTML page + 3 JSON-LD schema blocks + a Content Gaps report.
4. **Parse** `content_html`, `schema_json`, and `content_gaps` from the response.
5. **Auto-retry loop** (`MAX_AUTO_PASSES = 4`): score the page in-process; if composite `< 90`, reoptimize and re-score. Repeat up to 4 passes.
6. **SSE `done` event** → frontend saves the final page to the DB (including `content_gaps`).

### 3.3 Scoring & Reoptimization

- **Scoring model:** `claude-sonnet-4-6` (Sonnet, not Haiku — Haiku was unreliable on nuanced rubric criteria).
- **Reoptimization** preserves the page's HTML structure/CSS and only rewrites text + adds missing elements (see §6.3).

---

## 4. The Scoring System (8 engines)

The composite score is a weighted blend of **8 engines**. Seven are scored by an LLM against a rubric; one (**SERP Signal Coverage**) is computed deterministically in code (no LLM, reproducible, zero token cost).

### 4.1 Engine weights (must be configurable, never hardcoded inline)

```
organic_ranking        0.10   # LLM
gbp_maps               0.20   # LLM
entity_establishment   0.10   # LLM
icp_alignment          0.05   # LLM
aeo_llm_retrieval      0.20   # LLM
geographic_legitimacy  0.10   # LLM
nearme_intent          0.10   # LLM
serp_signal_coverage   0.15   # DETERMINISTIC (Python)
```

The 7 LLM engines = 85% of the score; SERP Signal Coverage = 15%. Note GBP/Maps (0.20) + AEO (0.20) are the two heaviest LLM engines; the Maps-heavy weighting is intentional because Map Pack visibility is the primary local battleground.

### 4.2 Composite → status label

| Composite | Status | Display |
|---|---|---|
| 90–100 | `excellent` | Green — "Publish-ready — strong across all engines" |
| 80–89 | `good` | Green — "Publish-ready — minor improvements available" |
| 70–79 | `needs_improvement` | Amber — "Publishable but with identified weaknesses" |
| 60–69 | `below_standard` | Amber — "Do not publish without addressing deficiencies" |
| 0–59 | `fail` | Red — "Significant rework required" |

### 4.3 LLM scoring rubric (what each engine checks)

The scorer is told it covers 85% of the score and must NOT score SERP Signal Coverage. Each engine returns `{score 0–100, issues[], recommendations[]}`; `icp_alignment` also returns `icp_detected`.

1. **organic_ranking (10%)** — keyword in title + H1 + opening paragraph; service/transactional tone (not blog); CTA + phone visible; clear service offering.
2. **gbp_maps (20%)** — exact city name present; service matches GBP category; brand+service+city entity triplet; NAP signals consistent; multiple service mentions.
3. **entity_establishment (10%)** — brand+service+city co-occurrence across ≥3 sections; sub-services mentioned; descriptive anchor-text signals; topical depth.
4. **icp_alignment (5%)** — detect ICP from keyword modifier; CTA tone must match ICP (emergency → urgency/fear-based CTA, not "free estimate"); pain points addressed; emotional register matches searcher intent.
5. **aeo_llm_retrieval (20%)** — answer-first formatting; FAQ with **4–7 entries** (penalize <4 or >7), each opening with a direct yes/no or factual statement; question-format H3s; each section ≤300 words; ≥1 outcome-first bulleted list; ≥1 numbered list for a process; tables only where genuinely comparative; specific operational facts over filler.
6. **geographic_legitimacy (10%)** — city in title+H1+opening; ≥2 neighborhood references in sentence context; ≥1 landmark; ≥3 ZIP codes in *visible* content; geo signals across ≥3 sections.
7. **nearme_intent (10%)** — phone above the fold; availability language in opening block; explicit stated response time; ≥2 neighborhood+service+availability blocks; ≥1 street reference; ≥2 proximity FAQs. **Never use the literal phrase "near me" in body copy.**

### 4.4 SERP Signal Coverage engine (15%, deterministic)

Computed in code, not by an LLM. It does **exact lowercase substring matching** of the competitor signals from §3.1 against the page's HTML zones:

- Related keywords matched **per zone** (title term must appear in `<title>`, H1 term in the H1, etc.).
- Google entities matched in headings/body.
- Quadgram phrases matched in paragraph text.

Paraphrases/synonyms/reordering **do not count** — the exact string must appear in the correct zone. If no SERP analysis is available it returns a neutral baseline (≈50). This engine is what makes the reoptimization loop convergent: it gives the model an exact, checkable list of missing strings per zone.

---

## 5. External Service Dependencies

| Service | Used for | Notes for migration |
|---|---|---|
| **DataForSEO** | Top-10 organic SERP URLs per keyword+location | Auth: login + password. Any SERP API works; must return organic URLs by geo. |
| **ScrapeOwl** | Concurrent HTML scrape of competitor URLs (`render_js:false`) | Any scraping API; concurrency + JS-render toggle needed. |
| **Google Cloud Natural Language API** | Entity salience + mention counts | API key. Replaceable by any entity/NER service that returns salience. |
| **Anthropic Claude** | Generation, scoring, reoptimization, and supporting LLM tasks | See model map below. |
| **Auth/DB provider (Supabase)** | Postgres, Auth (JWT), Row-Level Security | Any Postgres + JWT auth. |

### 5.1 LLM model map (Claude)

| Task | Model | Why |
|---|---|---|
| Page generation | `claude-sonnet-4-6` | Quality of long structured HTML |
| Page scoring | `claude-sonnet-4-6` | Sonnet needed for nuanced rubric accuracy (Haiku was unreliable) |
| Reoptimization | `claude-sonnet-4-6` | Structure-preserving rewrites |
| Supporting tasks (business analysis, brand-voice, related-pages derive/score, social posts, etc.) | `claude-haiku-4-5-20251001` | Cheap, fast, good enough |

Approx. pricing used for cost accounting (USD per 1M tokens): Sonnet 4.6 — input $3.00 / output $15.00; Haiku 4.5 — input $0.80 / output $4.00. Cached system-prompt input tokens bill at ~10% of normal input. **When rebuilding, use the latest equivalent capable model; do not hardcode prices — keep a pricing config table for cost accounting.**

> Migration note: if porting to a different LLM vendor, the *prompt strategy* (deterministic checklist + exact-string targets + structure-preserving reoptimization) is what matters and is vendor-agnostic. The system prompts are large and static — use prompt caching where available.

---

## 6. Generation Prompt Strategy (the actual "secret sauce")

Three components, all preserved verbatim conceptually when rebuilding.

### 6.1 Deterministic SEO checklist (`_build_seo_checklist`)

Before any LLM call, code assembles a checklist filled with exact data: the ICP and its CTA language, ZIP codes, neighborhoods, the quadgram phrases to include, and per-zone keyword/entity targets derived from competitor analysis. The LLM is handed targets, not asked to invent SEO strategy.

### 6.2 Generation system prompt (`_GEN_SYSTEM_PROMPT`)

Static, cached. Key rules:

- **Output format:** valid HTML only — `<title>…</title>` then `<article>` with the 13 sections, then on a new line a single `<script type="application/ld+json">` containing **3 schema blocks**, then a Content Gaps report block.
- **Title formula:** `[Power Word]! [Exact Keyword] | [Brand] | [Justification using entities] | [Additional persuasion + entities]` — entity-dense, no character limit (density over brevity).
- **14 AEO/structural writing rules:** answer-first; one idea per `<p>` (3–5 sentences); question-format H3s; direct FAQ answers; outcome-first bulleted lists (3–8 bullets); numbered lists for processes; tables only when genuinely comparative; specific facts over vague claims; entity triplets (Brand+service+city) in ≥3 sections; sections ≤300 words; geo signals across ≥3 sections; **response time only if present in business data**; phone in sections 1/4/8/11; ICP-matched CTA tone repeated in ≥3 sections.
- **Factual-accuracy constraint (critical):** never invent response times, certifications, years in business, pricing, or team size. Only assert facts present in the provided GBP/business data. If a high-value fact is missing, omit it and log it as a content gap instead of fabricating.
- **Brand voice vs. AEO tiebreaker:** AEO rules govern *structure* (non-negotiable); brand voice governs *tone*.

### 6.3 Reoptimization system prompt (`_REOPT_SYSTEM_PROMPT`)

Used by the auto-retry loop and Improve mode. Rules:

- **May change:** text between existing tags; SEO attributes (`alt`, `title`, meta `content`, og tags, `aria-label`, JSON-LD text values); may add new semantic HTML elements inserted where they read naturally.
- **Must NOT change:** existing tag names, CSS classes, IDs, `data-*`, `href`, `src`, or any non-content attribute; must not remove or reorder existing elements.
- It receives the **COMPETITOR SIGNAL DATA** showing exactly which strings are still missing per zone, and is told to prioritize adding those exact substrings (because SERP Signal Coverage is exact-match).

### 6.4 Content Gaps report (`CONTENT_GAPS_REPORT_START/END`)

After the schema, the LLM outputs a JSON array of gap objects:

```json
{ "category": "Response Time",
  "missing": "Specific arrival window (e.g. 'within 2 hours')",
  "score_impact": "high",
  "why_important": "nearme_intent scorer requires an explicit response time; without it the page cannot reach 90+",
  "how_to_add": "Add it to your GBP description or website, then regenerate." }
```

The prompt *always* checks for three high-impact gaps and emits them if missing: (1) response time, (2) service area/neighborhoods, (3) certifications/licenses implied by the GBP category. Gaps are stored on the page and surfaced in the UI as a **"How to reach 100/100"** panel.

---

## 7. Data Model

Current store is Supabase Postgres with Row-Level Security (each user sees only their rows). Core tables:

### `business_profiles`
Saved GBP data. Unique on `gbp_place_id`. Holds: business name, address, phone, website, categories, hours, place_id, service area, rating, review count, description, and **reviews** (JSONB — 4–5★ only). Detected ICP, differentiators, and existing-page inventory belong here (per design).

### `keyword_analyses`
Full NLP analysis result. **Unique on `(business_id, keyword, location)`** — re-running upserts to avoid re-burning API credits. Includes `related_keywords` per zone, `top_quadgrams`, `google_entities`, `serp_urls`, and zone targets.

### `generated_pages`
Generated pages. Key columns: `content_html`, `schema_json`, `page_title`, `content_gaps` (JSONB), `composite_score`, `composite_status`, `mode` (`generate` | `reoptimize` | `audit`), version. Original versions are always preserved; Improve creates a new row with an incremented version.

### Supporting tables
`user_profiles` / `profiles` (user data, default location, role), `credit_transactions` (ledger), `press_releases` + `press_release_reports`, `notifications`, `team_members`, plus rankability-check limits and credit-pack purchases.

> Migration note: types for the client were **manually maintained** alongside migrations. On a new stack, generate types from the schema to avoid drift.

---

## 8. Credit System

| Action | Cost |
|---|---|
| Generate | 1 credit |
| Audit | 1 credit |
| Improve | 1 credit |
| Below-threshold regeneration | 1 additional credit |
| Section regeneration (in Improve) | 0 credits |

Rules: deduct at **action start**; **auto-refund on failure** (new positive ledger row); balance shown persistently; at 0 credits, actions are disabled with a clear message. Pricing/tiers are *not* hardcoded — config only. A `SUPABASE_SERVICE_ROLE_KEY` (server-side secret) is used to write credit deductions/refunds securely.

---

## 9. Application Surface (NLP service endpoints)

All POST unless noted. `verify_api_key` = X-API-Key or JWT; credit-charging endpoints require JWT.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `/analyze` | SERP competitor analysis (§3.1) |
| `/analyze-business` | Derive business attributes from GBP/site |
| `/analyze-brand-voice` | Infer brand voice for tone matching |
| `/find-page-for-keyword` | Find an existing page on the business's site for a keyword |
| `/score-page` | Score arbitrary HTML against all 8 engines (Audit/Score-my-page) |
| `/augment-page` | Add/expand content on a page |
| `/generate-page` | **SSE stream** — full generation + auto-retry loop (§3.2) |
| `/reoptimize-page` | Structure-preserving reoptimization of a full page |
| `/reoptimize-section` | Rewrite a single deficient section (Improve mode, free) |
| `/related-pages` | Derive + score a cluster of related service pages |
| `/generate-social-posts` | Social posts derived from a page |
| `/check-rankability` | Pre-flight check on whether a keyword is winnable |
| `/generate-press-release` | Separate press-release generation flow |

> Not every endpoint is part of the v1 core loop; `generate`, `score`, `reoptimize`/`reoptimize-section`, and `analyze` are the essential ones. The rest (social, press release, rankability, related-pages) are adjacent features built on the same infrastructure.

---

## 10. Frontend Surface (views)

Routing is **state-based** (no router): clicking a sidebar item swaps the active view.

| View | Role |
|---|---|
| `DashboardView` | Home / entry points + credit balance |
| `BusinessSearchView` + `GBPConfirmation` + `LocationAutocomplete` | GBP search, confirm, save |
| `LocationsView` / `LocationDetailView` | List + manage saved businesses |
| `NewContentView` | Keyword analysis form + bulk generate |
| `AnalysisResultsView` | SERP analysis results (4 tabs: related keywords / quadgrams / entities / URLs) |
| `GeneratedPageView` | Generated page display + Content Gaps "How to reach 100" panel |
| `PageScoreView` / `ScoreMyPageView` | Score breakdown + reoptimize CTA; audit arbitrary HTML |
| `ImproveDiffView` | Side-by-side diff of Improve rewrites (accept/reject) |
| `SavedPagesView` / `SavedPagesList` | My Pages list, filter, versions |
| `PressReleasesView` + modals | Press-release flow |
| `PlanningView` | Content planning |
| `SettingsView` | Account, email prefs, credits, business profiles |
| `AdminView` | Admin/user management |
| `LoginView` | Auth |
| `NotificationBell` / `CreditPackModal` / `*PackModal` | Notifications + credit/pack purchase modals |

---

## 11. App Modes (product behavior)

1. **Generate Mode** — business search → (one-time) profile setup → page inputs (keyword, service, optional ICP/urgency, geo data) → pre-generation checklist → deduct credit → SSE generation with auto-retry → page + score + gaps → save + (optional) email. Next: Improve / Generate Another / View My Pages.
2. **Audit / Score Mode** — input a URL (server-side fetch), HTML, or plain text → score against all 8 engines → composite + engine breakdown + deficiency list. Saved as a page record (`mode=audit`), no email. Can transition into Improve (requires full HTML).
3. **Improve Mode** — show page + deficiency list → Fix All / Fix Selected → only deficient sections rewritten (structure-preserving) → accept/reject diffs → rescore → save as a new version. Original always preserved. Section regen is free.

---

## 12. Content Output Spec (the page the app produces)

A single publish-ready HTML article. **13 sections, fixed order** (the live generator's structure):

1. Intro / direct-answer hero — brand+service+location declarative, keyword in first sentence, primary differentiator, phone + CTA above the fold (100–150 words).
2. USP / value proposition — ≥3 differentiators *with mechanisms*, a proof signal, an explicit contrast statement.
3. Special offers (only if data exists).
4. Primary CTA block.
5. Features & benefits — ≥4 outcome-first pairs tied to ICP pain points.
6. Main service body — primary service + sub-service H2/H3 subsections; each self-contained and independently retrievable; brand+service+city in headings.
7. Testimonials (only when ≥2 qualifying 4–5★ GBP reviews; verbatim; first name + last initial).
8. Secondary CTA (different angle).
9. Getting started — 3–5 step process.
10. Local SEO / geographic section — city + ≥3 neighborhoods in sentence context + ≥1 landmark + ≥2 streets + ZIP codes; directions if storefront, coverage+response time if SAB.
11. Tertiary CTA — urgency-forward.
12. FAQ — 6–10 entries (scorer prefers 4–7), self-contained, covering availability/response/coverage/emergency.
13. JSON-LD schema — delivered as a separate block (see §13).

**Never generate:** "Welcome to [Brand]", "We are a [city] [service] company" as first sentence, any placeholder text, fabricated reviews, "Contact us today" as a standalone CTA, generic headings (About Us / Our Services / Why Choose Us), any AI-disclosure signal, or the literal phrase "near me" in body copy.

---

## 13. Schema (JSON-LD) Output Spec

Three blocks in one `<script type="application/ld+json">`:

1. **LocalBusiness** (auto-detected subtype from GBP category — Plumber → `Plumber`, HVAC → `HVACBusiness`, Electrician → `Electrician`, Locksmith → `Locksmith`, Roofing → `RoofingContractor`, else `LocalBusiness`): name/phone/address **exact GBP match**, geo, hasMap, openingHoursSpecification (exact GBP hours), areaServed (target city), aggregateRating, sameAs (GBP URL).
2. **Service** — serviceType, provider, areaServed, description from page content, phone availableChannel.
3. **FAQPage** — auto-extracted from the generated FAQ section.

Consistency checks before finalizing: name/phone/address must match GBP exactly; `areaServed` city must match the keyword city; hours must match GBP. Conflicts are flagged side-by-side. Schema review never blocks publishing.

---

## 14. ICP Engine (7 profiles)

ICP is user-selected if provided, otherwise inferred by LLM from keyword modifier + GBP category + site. Each ICP drives tone + CTA language:

| ICP | Keyword signals | CTA tone |
|---|---|---|
| emergency_homeowner | emergency, urgent, burst, flooding, tonight, now | "Call Now — Technician Dispatched Immediately" |
| general_homeowner | no urgency modifier | "Get a Free Estimate" / "Schedule Service Today" |
| commercial_business | commercial, office, restaurant, retail, industrial | "Request a Commercial Quote" |
| property_manager | property management, HOA, apartment, portfolio | "Set Up a Preferred Vendor Account" |
| vulnerable_homeowner | senior, elderly, accessible, disability | "Call Us — We'll Walk You Through Everything" |
| trade_contractor | new construction, renovation, contractor, builder | "Get a Project Quote" |
| landlord_rental_owner | landlord, rental property, tenant, investment | "Book a Rental Property Service Call" |

---

## 15. Environment / Configuration

**Frontend:** auth/DB URL + anon key + project id, NLP service base URL.

**NLP service (server-side secrets):** DataForSEO login/password, ScrapeOwl key, Google NLP key, Anthropic key, DB URL + anon key + **service-role key** (for credit writes), CORS origins, auth issuer for JWT verification.

**Tunable constants (keep all in config, never hardcode):** the §3.1 thresholds, `MAX_AUTO_PASSES=4`, the §4.1 engine weights, the §4.2 status cut-points, the LLM model map + pricing, and all credit values/thresholds.

---

## 16. Standing Constraints (non-negotiable invariants)

1. No hardcoded thresholds, weights, credit values, or prices — all config.
2. All LLM calls are server-side only.
3. Generation must run on a long-lived, streaming-capable path (no short serverless timeout).
4. Credits deduct at start, refund on failure.
5. No fabricated facts in output (response times, certs, pricing, years, team size) — gap-report them instead.
6. No placeholder text and no AI-disclosure in output.
7. Original page versions always preserved; Improve = new version.
8. Reoptimization must preserve existing HTML structure/CSS/attributes.
9. SERP analysis cached per (business, keyword, location) to avoid re-spending API credits.
10. "near me" never appears literally in body copy.

---

## 17. Build Order Recommendation (for the new app)

1. **Foundations:** auth + DB schema (§7) + RLS + credits ledger (§8).
2. **Analysis pipeline** (§3.1) — SERP → scrape → TF-IDF/quadgrams → entities, cached.
3. **Deterministic scorer** — SERP Signal Coverage engine (§4.4) first; it's pure code and anchors everything.
4. **Generation** (§3.2 + §6) — checklist builder → generation prompt → parse HTML/schema/gaps → SSE.
5. **LLM scorer** (§4.3) + **auto-retry loop** (`MAX_AUTO_PASSES`).
6. **Reoptimization / Improve** (§6.3) + diff UI.
7. **Frontend views** (§10) + modes (§11).
8. **Adjacent features:** audit, related-pages, social posts, press releases, rankability.

---

## 18. Source Material

This PRD supersedes and consolidates the original design docs for migration purposes. For deeper rationale see, in the original repo: `docs/PRD_part1.md` (Organic Ranking, GBP/Maps, Entity, AEO, Differentiation, Topical Authority engines), `docs/PRD_part2.md` (Geographic Legitimacy, Near-Me, Input Schema, Content Output, ICP, Composite Score, Modes, Schema, User Journey), `docs/SPEC.md` (single-source build spec), and `CLAUDE.md` (live architecture notes). Where the original design docs describe **7 engines**, the *shipped* system uses **8** (the deterministic SERP Signal Coverage engine was added) — this document reflects the shipped 8-engine reality.
