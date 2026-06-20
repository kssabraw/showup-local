# PRD — Content Planning (Portable)

> **Purpose:** Re-create the "Content Planning" capability from ShowUP Local in a
> new application. Given a **seed keyword + location + business** (with a website),
> the system derives a structured set of **related keywords** (parents / siblings /
> neighbourhood-children) following a local-SEO site-architecture SOP, checks which
> of those pages the business's site **already has**, and returns a grouped
> **gap report** — "exists" vs "missing" — so the user can plan and create the
> missing pages.
>
> This document is **stack-agnostic**. It specifies behavior, data shapes, and the
> exact LLM prompt. The keyword-derivation prompt should be copied **verbatim** —
> it encodes the site-architecture rules that make the output useful.

---

## 1. Overview

### 1.1 What it does
1. **Derives related keywords** from the seed keyword + city via one LLM call,
   in three groups:
   - **parents** (2–3): broader terms above the seed (bare service, modifier+service, service+city).
   - **siblings** (5–8): peer sub-services under the same parent + same city.
   - **children** (3–4): the seed keyword + specific **neighbourhoods inside the city**.
2. **Discovers the site's pages** (sitemap.xml → robots.txt sitemap) — once.
3. For each derived keyword, **checks whether a matching page already exists** on
   the site (slug + title/H1 token matching, blog pages de-prioritised).
4. Returns a flat list of items, each tagged with `group` and
   `status` = `"found"` (with url + title) or `"missing"`.
5. (Optional, per keyword) **rankability check** against the Google Maps pack —
   an adjacent feature, see §1.4.

### 1.2 The mental model
This is a **page-gap planner**: "for this topic in this city, what pages should a
local business have, and which are missing from their site?" Missing items feed
directly into page creation; existing items can be linked/scored.

### 1.3 Output groups
| Group | Count | Meaning | Display label |
|---|---|---|---|
| `parents` | 2–3 | Broader service terms | "Parent" |
| `siblings` | 5–8 | Peer sub-services in same city | "Sibling" |
| `children` | 3–4 | Seed keyword × neighbourhoods in the city | "Neighbourhood" |

### 1.4 Out of scope (adjacent)
- **Rankability check** (`/check-rankability`): a per-keyword "can this business
  realistically rank in the Maps pack?" verdict. It calls a SERP/Maps provider
  (DataForSEO Maps) and is a substantial separate engine. The planning UI exposes
  it as an optional per-row action; this PRD documents its request/response shape
  (§6.3) but the engine itself is a separate module.
- **Page creation / scoring**: "Create" on a missing item hands `(keyword,
  location)` to the generation flow; "Score" on an existing item hands its URL to
  the Score My Page module. Both via callbacks — not part of this module.

---

## 2. External dependencies

| Dependency | Used for | Notes |
|---|---|---|
| **LLM (cheap/fast)** | Deriving related keywords | Original uses `claude-haiku-4-5`. Plain JSON output (fence-stripped). |
| **HTTP + XML/HTML parser** | Sitemap discovery + page fetch for matching | httpx + BeautifulSoup. |
| **(Optional) SERP/Maps provider** | Rankability check | DataForSEO Maps — only for the adjacent §1.4 feature. |

No scraping service is required — discovery reads `sitemap.xml`/`robots.txt`, and
page matching does light `GET`s of candidate URLs (title/H1 only).

---

## 3. Data model

### 3.1 Request
```jsonc
{
  "keyword": "tree service",                       // seed keyword (required)
  "location": "Anaheim, California, United States", // city = first comma-part (required)
  "business_name": "Example Tree Co",              // required
  "gbp_category": "Tree service",                  // required
  "address": "123 Main St, Anaheim, CA",           // optional
  "website": "https://example.com"                 // optional — without it, all items are "missing"
}
```

### 3.2 Response
```jsonc
{
  "items": [
    { "keyword": "tree service anaheim", "group": "parents", "status": "found",
      "url": "https://example.com/tree-service", "page_title": "Tree Service in Anaheim",
      "composite_score": null, "composite_status": null, "engine_scores": null, "deficiencies": null },
    { "keyword": "stump grinding anaheim", "group": "siblings", "status": "missing" }
  ],
  "token_usage": { "endpoint": "related-pages", "model": "...", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 }
}
```

`RelatedPageItem` fields: `keyword`, `group`, `status`, and (when found) `url`,
`page_title`. The `composite_*` / `engine_scores` / `deficiencies` fields exist so
a caller *can* attach Score-My-Page results to an existing page, but the planning
endpoint itself leaves them null (scoring is explicit/user-triggered).

---

## 4. API surface

### 4.1 `POST /related-pages`
- **Auth:** require auth (API key / JWT) — keep a seam.
- **Rate limit:** 5 / minute.
- **Errors:** no LLM key → `503`. Sitemap/page-fetch failures degrade gracefully
  (keywords just come back "missing"); the endpoint does not hard-fail on them.

---

## 5. Pipeline detail

### 5.1 Derive related keywords — `_derive_related_keywords(keyword, location)`
One LLM call (cheap model, `max_tokens: 512`), `city = location.split(",")[0]`.
Returns `{ parents: [...], siblings: [...], children: [...] }` (siblings capped at
8, children at 4). Prompt is verbatim in §6.1.

### 5.2 Discover site URLs (once)
If `website` provided (normalise to `https://`):
1. `GET {base}/sitemap.xml` → collect `<loc>` URLs (cap 200).
2. Fallback: `GET {base}/robots.txt`, find a `Sitemap:` directive, fetch it,
   collect `<loc>` URLs (cap 200).
If no website → skip; every derived keyword is returned as `status: "missing"`.

### 5.3 Match each keyword to an existing page — `_find_page_for_keyword_reuse`
For each derived keyword (run concurrently):
1. **Tokenise** the keyword: lowercase, split on non-word chars, drop stopwords
   and a "business-descriptor" blocklist (company, contractor, near, me, best,
   licensed, …) and 1-char tokens. Fall back progressively if that empties.
2. **Rank candidate URLs** by slug-token overlap with the keyword tokens; take the
   top 20.
3. **Fetch** each candidate (`GET`, 8s): parse `<title>` + `<h1>`; tokenise; a
   page **matches** only if **every** keyword token is present in title+H1 (with a
   prefix-match allowance for tokens ≥ 4 chars).
4. Among matches, **prefer non-blog** pages (blog detected via path segments like
   `/blog`, `/news`, dated slugs, `how/why/top-N/ultimate-guide`, …).
5. Return `{ url, title, h1, is_blog_post }` for the best match, or `None`.

Build the item: `status="found"` with `url`+`page_title` when matched, else
`status="missing"`.

### 5.4 Assemble
Return all items (preserving parents → siblings → children order) + a token-usage
record.

---

## 6. LLM prompt & adjacent shapes

### 6.1 Keyword derivation prompt — `_derive_related_keywords` (copy verbatim)
Model: cheap/fast. `max_tokens: 512`. No system prompt. `{city}` = first
comma-part of location.
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

### 6.2 Page-match tokeniser constants
- **Stopwords:** standard English stopword list.
- **Business-descriptor blocklist** (dropped from keyword tokens):
  `company, companies, contractor, contractors, professional, professionals,
  provider, providers, specialist, specialists, expert, experts, technician,
  technicians, team, crew, agency, firm, business, near, me, best, top, trusted,
  reliable, affordable, licensed, certified, local, cheap, fast`.
- **Blog detection** (de-prioritise matches): path segments
  `blog|news|articles|posts|insights|resources|guides|tips|updates|press|media|
  events|stories|announcements|learn`, or dated/listicle slugs
  (`/YYYY/MM/`, `why-|how-|what-|top-N-|best-N-|N-tips|N-ways|ultimate-guide|…`).

### 6.3 (Adjacent) rankability check — `/check-rankability`
Optional per-keyword Maps-pack analysis. Request: `{ keyword, location,
gbp_category, business_name?, business_address?, gbp_place_id?, … }`. Response
(abbreviated): `{ score, verdict ("strong"|"moderate"|"difficult"|"very_difficult"),
has_map_pack, competitors[], ranking_categories[], category_match, … }`. The
planning UI maps verdict → a colored badge ("Strong/Partial/Mismatch Maps
rankability"). Requires a SERP/Maps provider; port separately if needed.

---

## 7. Frontend / UX requirements

A "Content Planning" screen (reference: `PlanningView.tsx`):

1. **Form:** business selector (lazy-loaded), seed-keyword input, location
   autocomplete. **Scan Site** button (disabled until business + keyword +
   location set).
2. **Loading state:** spinner + "Discovering related keywords and checking your
   site…" (~30–60s).
3. **Summary bar:** "N related keywords checked", a green "X pages exist" badge,
   an amber "Y missing" badge.
4. **Grouped results** (Parent → Sibling → Neighbourhood). Each row:
   - keyword; if found, a link to the existing page (title);
   - optional composite-score badge (when a score is attached);
   - an **Exists** (green) / **Missing** (amber) badge;
   - **Create** button on missing items → `onCreatePage(keyword, location)`;
   - external-link button on found items;
   - optional **rankability** line (colored verdict + "(m/n map results match
     your category)") when the optional check has been run.

---

## 8. Tunable constants (defaults)

| Constant | Default | Meaning |
|---|---|---|
| Parents | 2–3 | Broader terms |
| Siblings | 5–8 (capped 8) | Peer sub-services |
| Children | 3–4 (capped 4) | Seed × neighbourhoods |
| Sitemap URL cap | 200 | URLs collected |
| Candidate URLs fetched | top 20 by slug overlap | Per keyword |
| Page fetch timeout | 8s | Per candidate |
| Prefix-match min token length | 4 chars | Token fuzzy match |
| `max_tokens` (derive) | 512 | — |
| Model | cheap/fast (e.g. `claude-haiku-4-5`) | Derivation |
| Rate limit | 5/min | On `/related-pages` |

---

## 9. Acceptance criteria

- [ ] `POST /related-pages` returns grouped items (parents/siblings/children) with
      `status` found/missing and a token-usage record.
- [ ] Derived keywords obey the SOP: parents have no city-or-bare variants of the
      seed duplicated, siblings are `[sub-service] {city}`, children are seed ×
      in-city neighbourhoods.
- [ ] With a website, existing pages are matched by slug + title/H1 tokens; blog
      pages are de-prioritised vs service pages.
- [ ] Without a website, all items return `missing`.
- [ ] Sitemap/page-fetch failures degrade gracefully (no hard 5xx).
- [ ] UI groups results, shows exists/missing counts, and exposes Create on
      missing items and an external link on found items.

---

## 10. Build order (suggested)
1. Models + `POST /related-pages` skeleton + auth/rate limit.
2. `_derive_related_keywords` with the verbatim prompt (§6.1) + JSON parse.
3. Sitemap discovery (sitemap.xml → robots.txt).
4. `_find_page_for_keyword_reuse` (tokenise → slug rank → fetch → title/H1 match → blog de-prioritise).
5. Assemble grouped items + token usage.
6. Frontend: form → scan → grouped gap report with Create / external-link actions.
7. (Optional) wire the rankability check and the Create→generate / Score→score callbacks.
```
