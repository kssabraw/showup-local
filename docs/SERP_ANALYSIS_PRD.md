# PRD — SERP Analysis Pipeline (Portable)

> **Purpose:** Re-create the "SERP analysis" pipeline from ShowUP Local in a new
> application. Given a **keyword + location**, it fetches the top organic
> competitors, scrapes them, and extracts the **SEO signals** that power content
> generation and scoring: per-zone **related keywords** (TF-IDF), **quadgram**
> phrases, **Google NLP entities**, **SERP-bolded keywords**, per-zone **targets**,
> and **competitor headings**.
>
> This is the shared upstream dependency for **Score My Page** (`serp_analysis`)
> and the page generator. This document is **stack-agnostic** but the algorithms
> are numeric (TF-IDF / cosine similarity / n-grams); the reference is Python with
> scikit-learn + NLTK. Port the math faithfully — the thresholds are tuned.

---

## 1. Overview

### 1.1 Pipeline (6 steps)
```
keyword + location
  1. DataForSEO  — top N organic SERP URLs (+ bolded snippet terms)
  2. ScrapeOwl   — fetch raw HTML per URL (hybrid: no-JS first, JS-render retry)
  3. Parse zones — title / h1 / h2_h3 / paragraphs + raw heading lists per page
  4. NLP         — related keywords per zone (TF-IDF + cosine), quadgrams
  5. Google NLP  — entity analysis (salience + mentions) across paragraph text
  6. Aggregate   — SERP bold-keyword usage, per-zone targets, competitor headings, cost
→ AnalysisResponse
```

### 1.2 Why each signal exists
- **Related keywords (per zone)** — TF-IDF terms competitors use in each HTML zone
  (title/h1/h2_h3/paragraphs), filtered to terms that appear on ≥49% of pages and
  are cosine-similar to the keyword. Tells the generator/scorer what to put *where*.
- **Quadgrams** — 4-word phrases competitors repeat in body copy (page-spread +
  similarity filtered). Natural-language phrasing to weave in.
- **Google entities** — entities Google's NLP recognises across competitor copy,
  with salience ≥0.40 and ≥49% page spread, plus a recommended mention count and a
  Knowledge-Graph mid (for RDFa markup).
- **SERP bold keywords** — terms Google **bolds** in result snippets (a direct
  relevance signal), with how many times the top competitor uses each.
- **Zone targets** — for each zone, the 75th-percentile count of related terms /
  entities competitors hit. These are the numeric targets the deterministic
  scoring engine measures against.
- **Competitor headings** — the most common H2/H3 strings across competitors, to
  inform page structure.

---

## 2. External dependencies

| Dependency | Used for | Env / cost |
|---|---|---|
| **DataForSEO** (Google organic live/advanced) | Top organic URLs + bolded snippet terms | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` · ~$0.0025/run |
| **ScrapeOwl** (premium proxies, optional JS render) | Fetch competitor HTML | `SCRAPEOWL_API_KEY` · ~$0.0075/page no-JS, ~$0.015/page JS |
| **Google Cloud Natural Language API** | Entity analysis | `GOOGLE_NLP_API_KEY` · $0.001/1k chars |
| **scikit-learn** | TF-IDF + cosine similarity | — |
| **NLTK** | tokenizer, stopwords, n-grams | needs `stopwords`, `punkt`, `punkt_tab` |
| **numpy**, **BeautifulSoup4 + lxml** | math + HTML parsing | — |

> All three external APIs degrade gracefully: missing DataForSEO creds → no URLs
> (502 if not overridden); missing Google NLP key → entities skipped (non-fatal).
> Providers are swappable — any SERP source that yields organic URLs + any scraper
> that returns HTML will work; only the response mapping changes.

---

## 3. Data model

### 3.1 Request
```jsonc
{
  "keyword": "emergency plumber anaheim",            // required
  "location": "Anaheim, California, United States",  // required (location_name)
  "location_code": 1013962,                          // optional — preferred over location_name
  "urls": ["https://…"]                              // optional — skip DataForSEO, analyze these
}
```

### 3.2 Response (`AnalysisResponse`) — consumed by scoring + generation
```jsonc
{
  "keyword": "...",
  "location": "...",
  "serp_urls": ["https://…"],                  // URLs actually scraped + analyzed
  "related_keywords": {
    "title":      [{ "term": "...", "score": 0.42, "page_spread": 7, "page_spread_pct": 0.7, "type": "related" }],
    "h1":         [ ... ],
    "h2_h3":      [ ... ],
    "paragraphs": [ ... ]
  },
  "top_quadgrams": [{ "phrase": "24 hour emergency plumbing", "page_spread": 6, "page_spread_pct": 0.6, "similarity_score": 0.31, "type": "quadgram" }],
  "google_entities": [{ "name": "Anaheim", "entity_type": "LOCATION", "mid": "/m/0r5yc", "mean_salience": 0.52, "page_spread": 9, "page_spread_pct": 0.9, "recommended_mentions": 4, "type": "google_entity" }],
  "serp_bold_keywords": [{ "term": "...", "page_spread": 6, "page_spread_pct": 0.6, "max_competitor_uses": 5, "avg_uses": 2.4, "recommended_mentions": 5 }],
  "zone_targets": {
    "title":  { "target": 2, "entity_target": 1 },
    "h1":     { "target": 2, "entity_target": 1 },
    "h2_h3":  { "target": 4, "entity_target": 2 },
    "paragraphs": { "target": 8, "entity_target": 5 }
  },
  "competitor_headings": [{ "text": "Our Emergency Services", "type": "h2", "page_count": 5, "page_pct": 0.5 }],
  "analysis_cost": { "dataforseo": 0.0025, "scrapeowl": 0.06, "google_nlp": 0.01, "subtotal": 0.07, "...": "..." }
}
```

---

## 4. API surface

### 4.1 `POST /analyze`
- **Auth:** API key / JWT (keep a seam). **Rate limit:** 10 / minute.
- **Errors:** DataForSEO returns no usable URLs → `502`; fewer than 2 pages
  scraped → `502` (need ≥2 for TF-IDF cross-document stats).

---

## 5. Pipeline detail

### 5.1 Step 1 — DataForSEO (`fetch_serp_urls`)
- POST organic `live/advanced`: `{ keyword, location_code|location_name,
  language_name:"English", depth: SERP_RESULT_COUNT (20), se_domain:"google.com" }`.
- Keep `type=="organic"` items; collect URLs up to `SERP_RESULT_COUNT`.
- **Skip** non-HTML extensions (`.pdf/.docx/.xlsx/.pptx/.zip`) and blocklisted
  domains (`SKIP_DOMAINS` — Yelp, YellowPages, BBB, Angi, Thumbtack, social,
  YouTube, Wikipedia, Amazon, etc.; **whitelisted**: reddit, linkedin, facebook,
  quora).
- Also extract **bolded** terms from each item's `highlighted` array (drop the
  exact keyword / keyword-subset). Returns `(urls, bold_terms)`.
- If override `urls` are passed, skip this step.

### 5.2 Step 2 — Scrape (`scrape_urls`)
Two-pass hybrid, concurrency capped (semaphore 10):
- **Pass 1:** all URLs no-JS.
- **Pass 2:** retry only failures (None / <200 chars HTML) with `render_js=true`.
- Merge keeping pass-1 wins; return non-empty HTML list + cost info (no-JS vs JS
  counts). Need ≥2 successful pages or 502.

### 5.3 Step 3 — Parse zones (`extract_zones` per page)
Returns per page: `title` text, `h1` text, `h2_h3` text, `paragraphs` text, full
`body` text, and raw `h2_list` / `h3_list` heading strings. Build `zone_buckets`
(one list per zone across pages) + per-page heading lists + per-page combined text
(for bold-keyword counting).

### 5.4 Step 4 — Related keywords (`get_related_keywords_for_zone`) per zone
- `clean_text` each doc (strip tags/urls, lowercase); need ≥2 non-trivial docs.
- `TfidfVectorizer(ngram_range=(1,3), stop_words="english", max_features=1000, min_df=2, max_df=0.95)`.
- Cosine-similar each candidate term's pages to the keyword vector.
- Keep terms appearing on ≥`ceil(total_pages × RELATED_MIN_PAGE_SPREAD)` pages
  (0.49) **and** mean similarity ≥`RELATED_MIN_SIMILARITY` (0.1). Exclude the exact
  keyword. Sort by score desc.

### 5.5 Step 4b — Quadgrams (`get_top_quadgrams`, paragraphs only)
- Tokenise (alpha, non-stopword, len>2), 4-grams; track page-spread per gram.
- Keep grams on ≥`ceil(pages × 0.49)` pages; TF-IDF the candidate phrases + docs +
  keyword; keep those with cosine ≥0.1. Sort by (page_spread, similarity) desc.

### 5.6 Step 5 — Google entities (`get_google_entities`, paragraphs >100 chars)
- Per page, POST paragraph text (≤100k bytes) to Google NLP `analyzeEntities`.
- Aggregate per `(name.lower(), type)`: saliences, mention counts, page set, mid.
- Keep entities on ≥`ceil(pages × 0.49)` pages **and** mean salience ≥0.40.
  `recommended_mentions = max(1, round(mean mention count))`. Sort by salience desc.

### 5.7 Step 6 — Aggregations
- **SERP bold keywords:** for each bolded term, count whole-word occurrences across
  each page's combined text; keep terms on ≥`ceil(pages × 0.30)` pages (lower
  threshold — bolding is a direct Google signal); record max/avg uses;
  `recommended_mentions = max competitor uses`; sort, cap 25.
- **Zone targets (`compute_zone_targets`):** per zone, count how many related terms
  (and entities) each competitor's zone text contains; the **75th percentile** of
  those counts becomes `target` / `entity_target` (p75 avoids outlier inflation).
- **Competitor headings:** per H2/H3, count page-spread (dedup per page); keep top
  12 H2s / 20 H3s by spread, with the canonical-cased text.
- **Cost:** sum DataForSEO + ScrapeOwl (no-JS×rate + JS×rate) + Google NLP
  (chars/1000 × rate).

---

## 6. Tunable constants (defaults)

| Constant | Default | Meaning |
|---|---|---|
| `SERP_RESULT_COUNT` | 20 | Organic URLs requested/kept |
| `RELATED_MIN_PAGE_SPREAD` | 0.49 | Term must appear on ≥49% of pages |
| `RELATED_MIN_SIMILARITY` | 0.1 | Min cosine to keyword |
| `QUADGRAM_MIN_PAGE_SPREAD` | 0.49 | Quadgram page-spread floor |
| `QUADGRAM_MIN_SIMILARITY` | 0.1 | Quadgram cosine floor |
| `ENTITY_MIN_PAGE_SPREAD` | 0.49 | Entity page-spread floor |
| `ENTITY_MIN_SALIENCE` | 0.40 | Min mean salience to keep an entity |
| Bold-keyword spread | 0.30 | Lower floor (direct Google signal) |
| `GOOGLE_NLP_MAX_BYTES` | 100,000 | Per-page text cap to Google NLP |
| Zone-target percentile | 75th | Avoids outlier competitors inflating targets |
| TF-IDF (related) | (1,3)-gram, max_features 1000, min_df 2, max_df 0.95 | — |
| Scrape concurrency | 10 | Semaphore |
| Min pages to proceed | 2 | TF-IDF needs cross-document stats |
| Heading caps | 12 H2 / 20 H3 | Competitor headings kept |
| Bold-keyword cap | 25 | — |
| Rate limit | 10/min | On `/analyze` |

---

## 7. Caching & reuse (important)
SERP analysis is the most expensive operation (3 paid APIs). Cache results keyed
on `(business_id?, keyword, location)` and reuse:
- **Score My Page** accepts a cached `serp_analysis` and only runs this pipeline
  inline when none is supplied (then returns it so the caller can cache).
- The page generator accepts cached `serp_analysis` too.
Persist the full `AnalysisResponse` JSON; re-running the same keyword/location
should upsert rather than burn API credits.

---

## 8. Frontend / UX (summary)
The reference UI (`AnalysisResultsView.tsx`) renders the response in **4 tabs**:
1. **Related Keywords** — grouped by zone (title/h1/h2_h3/paragraphs) with score,
   page-spread %, and the zone target.
2. **Quadgrams** — phrase list with page-spread + similarity.
3. **Entities** — name, type, salience, page-spread, recommended mentions.
4. **Competitor signals** — SERP bold keywords + competitor headings.
A form (keyword + location autocomplete + business) triggers `POST /analyze`; show
a long-running spinner (2–4 min: it scrapes ~20 pages). This UI is a pure render of
§3.2 — build it to taste. (Can be ported on request.)

---

## 9. Acceptance criteria

- [ ] `POST /analyze` returns the §3.2 shape for a real keyword+location.
- [ ] Blocklisted domains and non-HTML URLs are excluded from SERP URLs.
- [ ] Scrape uses no-JS then JS-render fallback; needs ≥2 pages or 502.
- [ ] Related keywords are per-zone, page-spread ≥49% and cosine ≥0.1 filtered.
- [ ] Quadgrams are page-spread + similarity filtered from paragraph text.
- [ ] Entities require salience ≥0.40 and ≥49% spread; include mid + recommended mentions.
- [ ] SERP bold keywords counted per competitor with max/avg uses (≥30% spread).
- [ ] Zone targets use the 75th-percentile competitor count.
- [ ] Missing Google NLP key degrades gracefully (entities empty, no error).
- [ ] `analysis_cost` reflects DataForSEO + ScrapeOwl tiers + Google NLP chars.

---

## 10. Build order (suggested)
1. Models + constants (`ZONES`, thresholds, `SKIP_DOMAINS`, endpoints) + `POST /analyze`.
2. `fetch_serp_urls` (DataForSEO + bold-term extraction + domain/extension filters).
3. `_scrape_one` + `scrape_urls` (hybrid no-JS → JS-render).
4. `extract_zones` + `clean_text`.
5. `get_related_keywords_for_zone` (TF-IDF per zone).
6. `get_top_quadgrams`.
7. `fetch_google_entities` + `get_google_entities`.
8. Bold-keyword counting + `compute_zone_targets` + competitor-heading aggregation + cost.
9. Wire `_run_serp_analysis`; cache the result; feed Score My Page + generation.
10. (Optional) the 4-tab results UI.
```
