# ShowUP Local — Claude Code Context

## What This App Is

ShowUP Local is a local SEO content generation platform. The core idea: a user inputs a keyword and location, the app analyzes the top competitor pages ranking for that keyword, extracts SEO signals (related keywords, key phrases, Google entities), and uses that data to generate optimized local SEO content pages.

The name "ShowUP" is a play on showing up in local search results.

**Target customer**: Any local business that relies heavily on their Google Business Profile (GBP) to generate leads — brick-and-mortar shops, restaurants, medical/dental, legal, auto repair, salons, contractors, etc. Service area businesses (SABs like plumbers, HVAC, electricians) are a subset but not the primary focus.

---

## Development Environment

- **Frontend**: Built and iterated in **Lovable** (lovable.dev) — a React/Vite app scaffolded via Lovable's AI builder. Lovable pushes directly to GitHub. When making frontend changes, be aware that Lovable may also push changes to the same repo.
- **Backend NLP service**: Python FastAPI deployed on **Railway** (`https://showup-local-production.up.railway.app`)
- **Database**: **Supabase** (project: `yvdfiwabdvcpqwrmtysd` at `https://yvdfiwabdvcpqwrmtysd.supabase.co`)
- **Version control**: GitHub at `kssabraw/showup-local`
- **Railway auto-deploys** on every push to `main` — always merge feature branches to `main` for changes to take effect on Railway

---

## Tech Stack

### Frontend (`/src`)
- React + TypeScript + Vite
- Tailwind CSS + shadcn/ui components
- Supabase JS client (`src/integrations/supabase/client.ts`)
- Routing handled via state in `src/pages/Index.tsx` (no React Router — sidebar item clicks swap active view)

### NLP Service (`/services/nlp`)
- Python 3.11, FastAPI, uvicorn
- Deployed on Railway via Dockerfile
- scikit-learn, NLTK, numpy, BeautifulSoup4, httpx

### Database (Supabase)
- `public.business_profiles` — saved GBP business data
- `public.keyword_analyses` — NLP analysis results keyed on `(business_id, keyword, location)`
- `public.generated_pages` — generated HTML content; has `content_gaps` JSONB column

---

## The Full Pipeline

### Analysis (`POST /analyze`)
```
Frontend → Railway /analyze
  1. DataForSEO API — fetch top 10 organic SERP URLs
  2. ScrapeOwl API — scrape each URL concurrently (render_js: false)
  3. BeautifulSoup — parse HTML into zones (title, h1, h2_h3, body, paragraphs)
  4. TF-IDF + cosine similarity — related keywords per zone
  5. N-gram analysis — quadgrams from <p> tags only
  6. Google NLP API — entity analysis (salience + mention counts)
  → Frontend saves to Supabase keyword_analyses table
```

### Generation (`POST /generate-page`)
```
Frontend (nlpStreamDirect) → Railway /generate-page (SSE stream)
  1. Optional inline SERP analysis (if no cached analysis provided)
  2. _build_seo_checklist() — data-driven checklist from rubric + SERP data
  3. Claude claude-sonnet-4-6 — generates 13-section HTML page
  4. Parse content_html, schema_json, content_gaps from response
  5. Auto-retry loop (MAX_AUTO_PASSES=4):
       _score_html_inline() → if score < 90 → _reoptimize_html_inline()
  6. SSE "done" event → Frontend saves to generated_pages (includes content_gaps)
```

**Auth on Railway**: Dual mode — `X-API-Key` header (edge function proxied) OR `Authorization: Bearer <JWT>` (direct from frontend). Frontend uses `nlpStreamDirect` in `src/lib/nlp-client.ts` which calls Railway directly with the Supabase JWT — bypasses Supabase edge function entirely to avoid the 150s timeout.

---

## Key Files

```
showup-local/
├── src/
│   ├── pages/Index.tsx                    # Main layout + nav state
│   ├── components/
│   │   ├── AppSidebar.tsx                 # Sidebar navigation
│   │   ├── DashboardView.tsx              # Dashboard home
│   │   ├── BusinessSearchView.tsx         # GBP business search + save
│   │   ├── LocationsView.tsx              # List saved businesses
│   │   ├── NewContentView.tsx             # Keyword analysis form + bulk generate
│   │   ├── GeneratedPageView.tsx          # Generated page display + content_gaps panel
│   │   ├── PageScoreView.tsx              # Score breakdown + reoptimize CTA
│   │   └── AnalysisResultsView.tsx        # Analysis results (4 tabs)
│   ├── lib/
│   │   ├── nlp-client.ts                  # nlpStream, nlpStreamDirect, nlp.* wrappers
│   │   └── nlp-types.ts                   # TypeScript types for all API shapes
│   └── integrations/supabase/
│       ├── client.ts                      # Supabase client
│       └── types.ts                       # Manually-maintained DB types (update with migrations)
├── services/nlp/
│   ├── main.py                            # FastAPI app — full pipeline
│   ├── requirements.txt                   # Python dependencies
│   ├── Dockerfile                         # Railway build
│   └── railway.json                       # Railway config (uses Dockerfile)
├── supabase/
│   └── migrations/                        # Schema migrations (also apply via Supabase MCP)
├── docs/
│   ├── PRD_part1.md                       # Product requirements part 1
│   ├── PRD_part2.md                       # Product requirements part 2
│   ├── SPEC.md                            # Technical spec
│   ├── ARCHITECTURE_keyword_analysis.md   # NLP architecture notes
│   └── CONSTRAINTS.md                     # Project constraints
└── .env                                   # Frontend env vars (Vite)
```

---

## Environment Variables

### Frontend (`.env` / Vite)
| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://yvdfiwabdvcpqwrmtysd.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | anon key from Supabase |
| `VITE_SUPABASE_PROJECT_ID` | `yvdfiwabdvcpqwrmtysd` |
| `VITE_NLP_SERVICE_URL` | `https://showup-local-production.up.railway.app` |

### Railway NLP Service (set in Railway dashboard)
| Variable | Purpose |
|---|---|
| `DATAFORSEO_LOGIN` | DataForSEO account email |
| `DATAFORSEO_PASSWORD` | DataForSEO account password |
| `SCRAPEOWL_API_KEY` | ScrapeOwl API key |
| `GOOGLE_NLP_API_KEY` | Google Cloud Natural Language API key |
| `CORS_ORIGINS` | Comma-separated allowed origins (currently `*`) |
| `SUPABASE_URL` | `https://yvdfiwabdvcpqwrmtysd.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase publishable/anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (secret) key — for credit deduction |

---

## NLP Service — Key Constants (`services/nlp/main.py`)

```python
SERP_RESULT_COUNT = 10          # URLs to fetch from DataForSEO
RELATED_MIN_PAGE_SPREAD = 0.49  # Term must appear on >= 49% of competitor pages
RELATED_MIN_SIMILARITY = 0.1    # Min cosine similarity to keyword
QUADGRAM_MIN_PAGE_SPREAD = 0.49
QUADGRAM_MIN_SIMILARITY = 0.1
ENTITY_MIN_PAGE_SPREAD = 0.49
ENTITY_MIN_SALIENCE = 0.40      # Only entities Google scores >= 0.40 salience
MAX_AUTO_PASSES = 4             # Max scoring+reoptimize retries in generate-page
```

### Scoring engine weights
```python
_ENGINE_WEIGHTS = {
    "organic_ranking":       0.10,
    "gbp_maps":              0.20,
    "entity_establishment":  0.10,
    "icp_alignment":         0.05,
    "aeo_llm_retrieval":     0.20,
    "geographic_legitimacy": 0.10,
    "nearme_intent":         0.10,
    "serp_signal_coverage":  0.15,  # Python-deterministic (not Claude-scored)
}
```

### Generation strategy (Strategy 3)
1. `_build_seo_checklist()` — pre-computes a scoring-rubric-aligned checklist injected into the user prompt with exact data (ZIP codes, quadgrams, entity targets, ICP CTA, etc.)
2. `_GEN_SYSTEM_PROMPT` — 14 AEO/structural writing rules + factual accuracy constraints + ICP tone matching
3. `FACTUAL ACCURACY` rule — only assert claims present in GBP data; never invent response times, certifications, years, pricing, team size
4. `CONTENT_GAPS_REPORT` — Claude outputs a JSON block of unverified facts that would improve the score; parsed and stored in `content_gaps` column; shown in UI as "How to reach 100/100" panel

### Domain blocklist (skip from SERP results)
`yelp.com, yellowpages.com, bbb.org, angi.com, thumbtack.com, homeadvisor.com, houzz.com, instagram.com, twitter.com, x.com, youtube.com, tiktok.com, wikipedia.org, amazon.com, ebay.com, angieslist.com, nextdoor.com, mapquest.com, maps.google.com`

**Intentionally whitelisted**: `reddit.com`, `linkedin.com`, `facebook.com`, `quora.com`

---

## API Response Shape (`POST /analyze`)

```json
{
  "keyword": "emergency plumber anaheim",
  "location": "Anaheim, California, United States",
  "serp_urls": ["https://..."],
  "related_keywords": {
    "title": [{ "term": "...", "score": 0.42, "page_spread": 7, "page_spread_pct": 0.7, "type": "related" }],
    "h1": [...], "h2_h3": [...], "body": [...]
  },
  "top_quadgrams": [{ "phrase": "...", "page_spread": 6, "page_spread_pct": 0.6, "similarity_score": 0.31 }],
  "google_entities": [{ "name": "Anaheim", "entity_type": "LOCATION", "mean_salience": 0.52, "page_spread": 9, "page_spread_pct": 0.9, "recommended_mentions": 4 }]
}
```

## API Response Shape (`POST /generate-page`)

```json
{
  "content_html": "<article>...</article>",
  "schema_json": "<script type=\"application/ld+json\">...</script>",
  "page_title": "...",
  "token_usage": { "model": "...", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 },
  "cost_breakdown": { "dataforseo": 0, "claude": 0, "total": 0 },
  "serp_analysis": { "..." : "..." },
  "content_gaps": [
    {
      "category": "Response Time",
      "missing": "Specific arrival window (e.g. 'within 2 hours')",
      "score_impact": "high",
      "why_important": "nearme_intent scorer rewards explicit timeframes",
      "how_to_add": "Add to GBP description or website, then regenerate"
    }
  ]
}
```

---

## Supabase Schema

### `business_profiles`
Stores Google Business Profile data. Unique on `gbp_place_id`.

### `keyword_analyses`
Stores full NLP analysis results. Unique on `(business_id, keyword, location)` — re-running upserts to avoid burning API credits.

### `generated_pages`
Stores generated HTML pages. Key columns:
- `content_html` — full HTML article
- `schema_json` — JSON-LD schema block
- `page_title` — extracted `<title>` tag value
- `content_gaps` — JSONB array of gap objects (facts we couldn't verify/include)
- `composite_score` / `composite_status` — last scoring result
- `mode` — `"generate"` or `"reoptimize"`

---

## What's Built

- ✅ Business search + GBP data save (Supabase)
- ✅ Locations view (list saved businesses)
- ✅ Full NLP pipeline: DataForSEO → ScrapeOwl → TF-IDF → quadgrams → Google NLP entities
- ✅ Frontend analysis form + results UI (4 tabs)
- ✅ Content generation (13-section HTML page via Claude)
- ✅ 8-engine scoring system with composite score
- ✅ Auto-retry reoptimization loop (up to 4 passes, target 90+)
- ✅ Bulk content generation with progress bar
- ✅ Direct Railway calls from frontend (bypasses Supabase edge function — no 150s timeout)
- ✅ Factual accuracy enforcement — no invented claims about the business
- ✅ Content gaps report — "How to reach 100/100" panel in GeneratedPageView
- ✅ Credits system with deduction and refund on failure

## What's Next (in order)

1. **Scoring accuracy validation** — verify first-pass pages hit 90+ after the generation prompt alignment work
2. **Improve Mode** — rewrite only deficient sections based on scoring engine output
3. **Audit Mode** — analyse an existing URL against the scoring engines
4. **Press releases** — separate generation flow for press release content

---

## PRD Reference

The full product requirements are in `docs/PRD_part1.md` and `docs/PRD_part2.md`. Key sections:

- **Content Output Spec** (PRD part 2) — 13-section mandatory page structure
- **ICP Engine** — 7 customer profiles (Emergency Homeowner, General Homeowner, Commercial, etc.)
- **Geographic Legitimacy Engine** — geo signal scoring
- **Near-Me Intent Engine** — proximity query optimization
- **Master Composite Score** — weighted scoring across all engines
- **Schema Output Spec** — LocalBusiness, Service, FAQPage JSON-LD

---

## Architecture Notes

- `nixpacks.toml` in `services/nlp/` is dead code — Railway uses the Dockerfile as configured in `railway.json`.
- The Supabase project (`yvdfiwabdvcpqwrmtysd`) is under the user's personal Supabase account — NOT Lovable's cloud.
- `src/integrations/supabase/types.ts` is **manually maintained** — update it whenever you add a migration.
- When adding Supabase migrations: (1) add SQL file to `supabase/migrations/`, (2) apply via Supabase MCP tool (`mcp__cfcbc64b...__apply_migration`, project_id: `yvdfiwabdvcpqwrmtysd`), (3) update `types.ts`.
- Frontend auth flow: `getAuthHeader()` in `nlp-client.ts` retrieves the Supabase session JWT; `nlpStreamDirect` sends it as `Authorization: Bearer <token>` to Railway; Railway verifies via `_verify_jwt_get_user()` calling Supabase auth API.
