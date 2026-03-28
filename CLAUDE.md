# ShowUP Local — Claude Code Context

## What This App Is

ShowUP Local is a local SEO content generation platform. The core idea: a user inputs a keyword and location, the app analyzes the top competitor pages ranking for that keyword, extracts SEO signals (related keywords, key phrases, Google entities), and uses that data to generate optimized local SEO content pages.

The name "ShowUP" is a play on showing up in local search results.

**Target customer**: Any local business that relies heavily on their Google Business Profile (GBP) to generate leads — brick-and-mortar shops, restaurants, medical/dental, legal, auto repair, salons, contractors, etc. Service area businesses (SABs like plumbers, HVAC, electricians) are a subset but not the primary focus.

---

## Development Environment

- **Frontend**: Built and iterated in **Lovable** (lovable.dev) — a React/Vite app scaffolded via Lovable's AI builder. Lovable pushes directly to GitHub. When making frontend changes, be aware that Lovable may also push changes to the same repo.
- **Backend NLP service**: Python FastAPI deployed on **Railway**
- **Database**: **Supabase** (project: `yvdfiwabdvcpqwrmtysd` at `https://yvdfiwabdvcpqwrmtysd.supabase.co`)
- **Version control**: GitHub at `kssabraw/showup-local`

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

---

## The Full Pipeline

When a user submits a keyword + location on the Content page:

```
Frontend → POST /analyze (Railway NLP service)
              ↓
         1. DataForSEO API — fetch top 10 organic SERP URLs
              ↓
         2. ScrapeOwl API — scrape each URL concurrently (render_js: false)
              ↓
         3. BeautifulSoup — parse HTML into zones (title, h1, h2_h3, body, paragraphs)
              ↓
         4. TF-IDF + cosine similarity — related keywords per zone
         5. N-gram analysis — quadgrams from <p> tags only
         6. Google NLP API — entity analysis (salience + mention counts)
              ↓
         Response → Frontend saves to Supabase keyword_analyses table
```

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
│   │   ├── NewContentView.tsx             # Keyword analysis form
│   │   └── AnalysisResultsView.tsx        # Analysis results (4 tabs)
│   └── integrations/supabase/
│       ├── client.ts                      # Supabase client
│       └── types.ts                       # Generated DB types
├── services/nlp/
│   ├── main.py                            # FastAPI app — full pipeline
│   ├── requirements.txt                   # Python dependencies
│   ├── Dockerfile                         # Railway build
│   └── railway.json                       # Railway config (uses Dockerfile)
├── supabase/
│   └── migrations/
│       ├── 20260324193906_*.sql           # business_profiles table
│       └── 20260325030000_keyword_analyses.sql
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
| `CORS_ORIGINS` | Comma-separated allowed origins for CORS |

---

## NLP Service — Key Constants (`services/nlp/main.py`)

```python
SERP_RESULT_COUNT = 10          # How many URLs to fetch from DataForSEO
RELATED_MIN_PAGE_SPREAD = 0.49  # Term must appear on >= 49% of competitor pages
RELATED_MIN_SIMILARITY = 0.1    # Min cosine similarity to keyword
QUADGRAM_MIN_PAGE_SPREAD = 0.49 # Same for quadgrams
QUADGRAM_MIN_SIMILARITY = 0.1   # Same for quadgrams
ENTITY_MIN_PAGE_SPREAD = 0.49   # Same for Google entities
ENTITY_MIN_SALIENCE = 0.40      # Only entities Google scores >= 0.40 salience
```

### Domain blocklist (skip these from SERP results)
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
    "h1": [...],
    "h2_h3": [...],
    "body": [...]
  },
  "top_quadgrams": [{ "phrase": "...", "page_spread": 6, "page_spread_pct": 0.6, "similarity_score": 0.31, "type": "quadgram" }],
  "google_entities": [{ "name": "Anaheim", "entity_type": "LOCATION", "mean_salience": 0.52, "page_spread": 9, "page_spread_pct": 0.9, "recommended_mentions": 4, "type": "google_entity" }]
}
```

---

## Supabase Schema

### `business_profiles`
Stores Google Business Profile data. Unique on `gbp_place_id`. Populated via the business search flow in `BusinessSearchView.tsx`.

### `keyword_analyses`
Stores full NLP analysis results. Unique on `(business_id, keyword, location)` — re-running the same keyword upserts rather than duplicating (avoids burning API credits).

---

## What's Built

- ✅ Business search + GBP data save (Supabase)
- ✅ Locations view (list saved businesses)
- ✅ Full NLP pipeline: DataForSEO → ScrapeOwl → TF-IDF → quadgrams → Google NLP entities
- ✅ CORS on NLP service
- ✅ Frontend analysis form + results UI (4 tabs: Related Keywords, Quadgrams, Entities, Sources)
- ✅ Analysis results saved to Supabase

## What's Next (in order)

1. **Content generation** — take analysis results + business profile data and generate the 13-section page structure defined in `docs/PRD_part2.md` using the Anthropic API
2. **Supabase `generated_pages` table** — store generated content keyed to `business_id` + `keyword`
3. **Scoring engines** — Geographic Legitimacy, Near-Me Intent, and other engines defined in `docs/PRD_part2.md` that evaluate generated content quality
4. **Improve Mode** — rewrite only deficient sections based on scoring engine output
5. **Audit Mode** — analyse an existing URL against the scoring engines

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

## Notes

- The Supabase project (`yvdfiwabdvcpqwrmtysd`) is under the user's personal Supabase account — NOT Lovable's cloud. The original Lovable-created Supabase instance was separate and inaccessible.
- Railway auto-deploys on every push to `main` (NLP service via Dockerfile).
- The frontend is also deployed somewhere (likely Lovable's hosting or Railway) — confirm the production frontend URL before making CORS changes.
- `nixpacks.toml` in `services/nlp/` is dead code — Railway uses the Dockerfile as configured in `railway.json`.
