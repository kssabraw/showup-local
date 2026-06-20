# PRD — Score My Page (Portable)

> **Purpose:** Re-create the "Score My Page" capability from ShowUP Local in a new
> application. Given a page (URL or raw HTML) plus a target keyword + business
> context, the system scores the page 0–100 against **8 local-SEO engines** (7
> scored by an LLM against a rubric, 1 scored **deterministically in Python**),
> returns a weighted **composite score + status**, a per-engine breakdown
> (score, issues, recommendations), and a list of **deficiencies** (engines < 80)
> that downstream "Improve/Reoptimize" can consume.
>
> This document is **stack-agnostic**. It specifies behavior, weights, the exact
> rubric prompt, the deterministic algorithm, data shapes, and UI. The scoring
> rubric (`_SCORE_SYSTEM_PROMPT`) and weights should be copied **verbatim** — they
> are the tuned core.

---

## 1. Overview

### 1.1 What it does
1. Obtains the page HTML (from `page_content`, or fetches `page_url`).
2. Optionally runs/accepts a **SERP analysis** (competitor signal data) for the
   keyword — used by the deterministic engine and injected into the rubric prompt.
3. Computes deterministic **HTML structure facts** (counts of `<ul>/<ol>/<table>`).
4. Calls an LLM **once** to score the **7 rubric engines** (0–100 each) with
   issues + recommendations, as strict JSON.
5. Computes the **8th engine** — `serp_signal_coverage` — deterministically in
   Python (exact keyword/entity/quadgram presence per HTML zone).
6. Combines all 8 via fixed weights → **composite score** + **status** bucket.
7. Builds **deficiencies** (engines < 80) and returns the full breakdown.

### 1.2 The 8 engines & weights
| Engine | Weight | Scored by |
|---|---|---|
| `organic_ranking` | 10% | LLM |
| `gbp_maps` | 20% | LLM |
| `entity_establishment` | 10% | LLM |
| `icp_alignment` | 5% | LLM |
| `aeo_llm_retrieval` | 20% | LLM |
| `geographic_legitimacy` | 10% | LLM |
| `nearme_intent` | 10% | LLM |
| `serp_signal_coverage` | 15% | **Python (deterministic)** |

> The 7 LLM engines = 85% of the composite; the deterministic engine = 15%.
> Weights live in `_ENGINE_WEIGHTS` and must sum to 1.0.

### 1.3 Status buckets (from composite)
`>=90 excellent · >=80 good · >=70 needs_improvement · >=60 below_standard · <60 fail`

### 1.4 Out of scope (adjacent)
The "Improve/Reoptimize" flow that rewrites the page from the deficiencies is a
**separate pipeline** (its own LLM generation call). This PRD covers **scoring
only**. The UI exposes an "Improve This Page / Fix Selected" CTA that hands the
deficiencies to that pipeline via a callback — wire it to your own reoptimizer (or
omit it).

---

## 2. External dependencies

| Dependency | Used for | Notes |
|---|---|---|
| **LLM with strong instruction-following** | The 7-engine rubric scoring | Original uses `claude-sonnet-4-6` (Sonnet, not Haiku — Haiku was unreliable on nuanced rubric criteria). Prompt caching on the system prompt recommended. |
| **HTML parser** | Zone extraction + structure facts | BeautifulSoup or equivalent. |
| **HTTP scraper** | Fetch `page_url` when `page_content` not supplied | Plain GET works for simple sites; a premium scraper (ScrapeOwl) handles bot-protected/JS sites. Optional if callers always pass `page_content`. |
| **SERP analysis** (optional) | Deterministic engine + richer rubric context | The competitor-signal pipeline (DataForSEO + scraping + TF-IDF/entities/quadgrams) is a separate module. Scoring works without it (deterministic engine returns a neutral 50), but accuracy improves a lot with it. |

---

## 3. Data model

### 3.1 Request
```jsonc
{
  "keyword": "emergency plumber anaheim",     // required
  "location": "Anaheim, California, United States",  // required (city = first comma-part)
  "location_code": 1013962,                   // optional — SERP provider location code
  "page_url": "https://example.com/...",      // page_url OR page_content required
  "page_content": "<html>…</html>",           // raw HTML (skips fetch)
  "business_name": "Example Plumbing",        // required
  "gbp_category": "Plumber",                  // required
  "address": "123 Main St, Anaheim, CA",      // optional
  "serp_analysis": { /* §3.3, optional */ }
}
```

### 3.2 Response
```jsonc
{
  "composite_score": 87.4,
  "composite_status": "good",
  "engine_scores": {
    "organic_ranking":       { "score": 90, "issues": [], "recommendations": [] },
    "gbp_maps":              { "score": 85, "issues": [...], "recommendations": [...] },
    "entity_establishment":  { "score": 80, "issues": [], "recommendations": [] },
    "icp_alignment":         { "score": 75, "icp_detected": "Emergency Homeowner", "issues": [...], "recommendations": [...] },
    "aeo_llm_retrieval":     { "score": 88, "issues": [], "recommendations": [] },
    "geographic_legitimacy": { "score": 82, "issues": [], "recommendations": [] },
    "nearme_intent":         { "score": 78, "issues": [...], "recommendations": [...] },
    "serp_signal_coverage":  { "score": 91, "issues": [...], "recommendations": [...],
                               "keyword_coverage": 88, "entity_coverage": 95, "quadgram_coverage": 90 }
  },
  "deficiencies": [
    { "engine": "ICP Alignment Engine", "engine_key": "icp_alignment", "score": 75,
      "issues": [...], "recommendations": [...] }
  ],
  "token_usage": { "endpoint": "score-page", "model": "...", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 },
  "serp_analysis": { /* populated only when analysis was run inline */ },
  "analysis_cost": null
}
```

### 3.3 SERP analysis shape (consumed by the deterministic engine)
```jsonc
{
  "serp_urls": ["https://…"],
  "related_keywords": {                       // per-zone TF-IDF terms
    "title":  [{ "term": "…" }],
    "h1":     [{ "term": "…" }],
    "h2_h3":  [{ "term": "…" }],
    "paragraphs": [{ "term": "…" }]
  },
  "zone_targets": {                           // per-zone counts to hit (75th-percentile of competitors)
    "title":  { "target": 2, "entity_target": 1 },
    "h1":     { "target": 2, "entity_target": 1 },
    "h2_h3":  { "target": 4, "entity_target": 2 },
    "paragraphs": { "target": 8, "entity_target": 5 }
  },
  "google_entities": [{ "name": "Anaheim", "page_spread": 9, "recommended_mentions": 4 }],
  "top_quadgrams": [{ "phrase": "24 hour emergency plumbing" }]
}
```
(See the companion SERP-analysis module for how this is produced. Scoring only
**reads** it.)

---

## 4. API surface

### 4.1 `POST /score-page`
- **Auth:** dual mode in the original — `X-API-Key` (proxied) **or** bearer JWT
  (direct, with a 1-credit deduction). Match the host app; keep an auth seam.
- **Rate limit:** 10 / minute.
- **Errors:**
  - No LLM key → `503`.
  - Page fetch failed → `422` ("Could not fetch the provided page URL…").
  - Neither `page_content` nor `page_url` → `422`.
  - LLM returns invalid JSON after a retry → `502`.
  - Inline SERP analysis requested but failed → `503` (only if you require SERP data).

---

## 5. Pipeline detail

### 5.1 Get SERP analysis (optional)
If `serp_analysis` is omitted, either (a) run your SERP pipeline inline and return
it in the response so the frontend can cache it, or (b) proceed without it (the
deterministic engine degrades to a neutral 50). The original does (a) and 503s on
failure; the portable default is (b).

### 5.2 Get page HTML
Use `page_content` if provided. Otherwise fetch `page_url`: try a no-JS scrape,
then a JS-render retry; 422 if both fail.

### 5.3 Build prompt context
- `city` = `location.split(",")[0]`.
- `_detect_html_structure(html)` → deterministic facts block (counts of
  `<ul>`, `<ol>`, `<table>`; each marked ✓/✗). Injected so the LLM can't
  hallucinate list/table presence.
- `_serp_context(serp_analysis)` → "COMPETITOR SIGNAL DATA" block (per-zone
  keyword/entity targets, quadgrams, bolded keywords, competitor headings).
  Empty string when no SERP data.
- `page_text` = visible text (first ~8,000 chars).
- `_build_score_prompt(...)` assembles the **user** message (§6.2).

### 5.4 LLM scoring call
- Model: Sonnet-class. `max_tokens: 8192`.
- System = `_SCORE_SYSTEM_PROMPT` (§6.1), cached (ephemeral).
- Parse strict JSON (`_parse_claude_json` strips fences and extracts the first
  `{...}` block on failure). **Retry once** on empty/invalid JSON, then 502.

### 5.5 Deterministic engine — `_compute_serp_signal_coverage(html, serp_analysis)`
Runs in Python (no tokens, reproducible). Composite of three sub-scores:

- **Keyword coverage (30%)** — for each zone (title/h1/h2_h3/paragraphs), take up
  to 12 related terms and the zone's `target`; `coverage = min(found/target, 1)`;
  average across zones with a target. Emits issues/recs listing missing terms.
- **Entity coverage (50%)** — top 15 entities by `page_spread`; per-zone
  `entity_target`; same coverage math; default 75 if no entity targets.
- **Quadgram coverage (20%)** — top 10 quadgram phrases; fraction present in full
  page text × 100; default 75 if none.
- `score = round(kw*0.30 + ent*0.50 + qg*0.20, 1)`.
- When `serp_analysis` is missing entirely → `{ score: 50, issues:[…], recommendations:[…] }`.

Zone text extraction mirrors the analyzer: `<title>`, first `<h1>`, all
`<h2>/<h3>`, all `<p>` (paragraphs fall back to full page text).

### 5.6 Composite & deficiencies
- `_composite_from_scores` = Σ(engine.score × weight) over all 8 → round 1dp +
  status bucket (§1.3).
- `_build_deficiencies` = list of engines whose score < 80, each with label,
  `engine_key`, score, issues, recommendations.

---

## 6. LLM prompt (copy verbatim)

### 6.1 System prompt — `_SCORE_SYSTEM_PROMPT`
```
You are an expert local SEO analyst. Score the provided page against all 7 engines below.

IMPORTANT: These 7 engines account for 85% of the composite score. The remaining 15% is
scored separately by a deterministic Python engine (SERP Signal Coverage) that checks
exact keyword/entity/quadgram presence per HTML zone. You do NOT score that engine —
focus only on the 7 below.

SCORING CRITERIA — score each engine 0–100:

1. organic_ranking (weight 10%): keyword in title + H1 + opening ¶; service/transactional tone (not blog); CTA + phone visible; clear service offering.

2. gbp_maps (weight 20%): exact city name present; service matches GBP category; brand+service+city entity triplet; NAP signals consistent; multiple service mentions.

3. entity_establishment (weight 10%): brand+service+city co-occurrence in ≥3 sections; sub-services mentioned; descriptive anchor text signals; topical depth.

4. icp_alignment (weight 5%): detect ICP from keyword modifier (emergency→urgent tone; commercial→B2B tone; general→professional/reliable); CTA tone matches ICP (e.g. emergency ICP requires urgency/fear-based CTA, not generic "call for a free estimate"); pain points addressed; emotional register of copy matches searcher intent.

5. aeo_llm_retrieval (weight 20%): answer-first formatting (direct claim before explanation); FAQ with 4–7 entries (penalise if fewer than 4 or more than 7), each opening with a direct yes/no or factual statement; question-format H3s where appropriate; each section ≤300 words; ≥1 bulleted list with outcome-first bullets; ≥1 numbered list for a process or steps; tables used where content is genuinely comparative (service tiers, response times, inclusions) — penalise only if comparative data is present but no table was used; specific operational facts (numbers, timeframes, named places) rather than generic filler.

6. geographic_legitimacy (weight 10%): city in title+H1+opening ¶; ≥2 neighborhood references in sentence context; ≥1 landmark reference; ≥3 zip codes in visible content; geo signals in ≥3 page sections.

7. nearme_intent (weight 10%): phone above fold; availability language in opening block ("available now", "same-day", "emergency response"); response time stated explicitly (e.g. "arrive within 2 hours", "respond in 15 minutes"); ≥2 neighborhood+service+availability blocks; ≥1 street reference; ≥2 proximity FAQs (availability/response/coverage/emergency).

Return ONLY valid JSON — no markdown, no explanation:
{
  "organic_ranking":       {"score": 0, "issues": [], "recommendations": []},
  "gbp_maps":              {"score": 0, "issues": [], "recommendations": []},
  "entity_establishment":  {"score": 0, "issues": [], "recommendations": []},
  "icp_alignment":         {"score": 0, "icp_detected": "", "issues": [], "recommendations": []},
  "aeo_llm_retrieval":     {"score": 0, "issues": [], "recommendations": []},
  "geographic_legitimacy": {"score": 0, "issues": [], "recommendations": []},
  "nearme_intent":         {"score": 0, "issues": [], "recommendations": []}
}

Be specific — reference actual content found (or missing) in the page.
```

### 6.2 User prompt — `_build_score_prompt`
```
CONTEXT
Business: {business_name}
Category: {gbp_category}
Keyword: {keyword}
City: {city}
Address: {address or "Not provided"}
{serp_ctx}
{html_structure}
PAGE CONTENT (first 8,000 chars):
{page_text}
```
(`serp_ctx` and `html_structure` may each be empty.)

---

## 7. Frontend / UX requirements

A "Page Score" screen (reference: `PageScoreView.tsx`):

1. **Pre-score state:** brief explainer + **Score This Page** button (shows cost,
   e.g. "1 credit"). While scoring, show a spinner with copy that differs by
   whether SERP data is already available ("Scoring page…" vs "Analyzing
   competitors…") and an estimated time + Cancel.
2. **Composite card:** big colored number / 100 (green ≥80, amber ≥60, red <60),
   status label, count of issues to address, token cost.
3. **Engine breakdown:** one row per LLM engine (the 7) showing a status icon,
   label, a progress bar, the score, and an expand chevron. Expanding reveals
   **Issues** (red) and **Recommended fixes** (green); for `icp_alignment` also
   show `icp_detected`. Engines scoring < 80 get a **checkbox** to select for
   fixing (pre-checked = all deficiencies).
4. **Improve CTA (optional / adjacent):** "Fix All Issues" and "Fix Selected (n)"
   buttons that hand the (selected) deficiencies to the reoptimize callback; plus
   "Create New Page Instead". When there are no deficiencies, show a success
   message instead.

> Color thresholds: `>=80` green, `>=60` amber, else red. Note the engine
> breakdown UI lists only the 7 LLM engines by default; `serp_signal_coverage`
> still counts toward the composite (display it too if you want full transparency).

---

## 8. Tunable constants (defaults)

| Constant | Default | Meaning |
|---|---|---|
| `_ENGINE_WEIGHTS` | see §1.2 | Must sum to 1.0 |
| Score model | Sonnet-class | Haiku unreliable on rubric nuance |
| `max_tokens` (scoring) | 8192 | — |
| Page text cap | 8,000 chars | Sent to the LLM |
| Deficiency threshold | score < 80 | Engines flagged for improvement |
| JSON parse retries | 1 | Then 502 |
| Deterministic sub-weights | kw 30% / entity 50% / quadgram 20% | Inside `serp_signal_coverage` |
| Keyword terms per zone | 12 | Considered for coverage |
| Entities considered | top 15 by page_spread | — |
| Quadgrams considered | top 10 | — |
| Rate limit | 10/min | On `/score-page` |
| Status buckets | 90/80/70/60 | excellent/good/needs_improvement/below_standard/fail |

---

## 9. Acceptance criteria

- [ ] `POST /score-page` returns composite_score, composite_status, engine_scores
      (8 keys), deficiencies, token_usage per §3.2.
- [ ] Weights sum to 1.0; composite = weighted sum; status bucket correct.
- [ ] The 7 LLM engines come back as valid JSON; one retry on parse failure, then 502.
- [ ] `serp_signal_coverage` is computed in Python and present even with no SERP
      data (neutral 50 fallback).
- [ ] HTML structure facts are computed deterministically and injected into the prompt.
- [ ] `deficiencies` lists exactly the engines scoring < 80 with issues + recs.
- [ ] Page can be scored from `page_content` or a fetched `page_url`; 422 on fetch failure.
- [ ] UI renders composite + expandable engine breakdown with issues/recs and
      per-engine selection for deficient engines.

---

## 10. Build order (suggested)
1. Models + `POST /score-page` skeleton + auth/rate limit.
2. Page acquisition (`page_content` or fetch `page_url`).
3. `_detect_html_structure` + `_serp_context` + `_build_score_prompt`.
4. LLM scoring call + `_parse_claude_json` (+ retry).
5. `_compute_serp_signal_coverage` (deterministic engine).
6. `_composite_from_scores` + `_build_deficiencies` + response assembly.
7. Frontend: score button → composite card → engine breakdown → (optional) improve CTA.
8. (Optional) inline SERP analysis hook + the separate reoptimize pipeline.
```
