# PRD — ICP Creator (Portable)

> **Purpose:** Re-create the "ICP Creator" capability from ShowUP Local in a new
> application. Given a business (name + GBP category + optional website), the
> system discovers the site's page structure, then uses an LLM to detect 1–3
> **Ideal Customer Profiles (ICPs)** with full psychographic detail, plus a list
> of **differentiators**. The result is stored on the business record and
> injected into downstream AI content generation so copy speaks to the right
> customers' pains and motivations.
>
> This document is **stack-agnostic**. It specifies behavior, data shapes, and
> the exact LLM prompt. Re-implement the orchestration in whatever
> language/framework the target app uses. The prompt should be copied
> **verbatim** — it is the part that matters most.

---

## 1. Overview

### 1.1 What it does
1. **Discovers** the business's website page structure (sitemap → nav → homepage
   links), classifies each URL (service / location / city_service / blog / other),
   drops blog/editorial pages, and returns a ranked list of page records.
2. Runs **one LLM call** that, from the **business name + GBP category + the
   discovered page URLs**, returns:
   - `detected_icp` — 1–3 customer segments, each with demographics,
     psychographics (trigger, fears, motivations, buying behavior), and messaging
     (tone, hooks, trust signals), plus a primary flag, confidence, and reasoning.
   - `differentiators` — claims with the mechanism that backs each up.
3. **Stores** the result on the business record.
4. **Injects** the detected ICP into the system prompt of the content generator
   so generated copy targets those segments' pains and motivations.

### 1.2 Two entry paths
- **Website path** (a URL is provided): discover + classify pages, then analyze.
- **No-website path** (no URL, or discovery yields nothing): the LLM infers the
  most likely segments from **business name + GBP category alone**.

### 1.3 ⚠️ Important fidelity note — analysis works off URLs, not page text
The discovery step (`crawl_website`) returns page records whose `title` and `h1`
fields are **empty strings** — it classifies by **URL only** and does **not**
fetch page body content. So in the shipped system the LLM sees the **business
name, GBP categories, and the list of page URLs + their classified types** —
*not* scraped copy. The prompt asks for differentiators "from page titles and
H1s," but since those are blank, differentiators are effectively inferred from
URL slugs + business context.

> **Recommendation for the new app:** decide deliberately. Either (a) keep it
> URL-only (cheapest, matches current behavior), or (b) **enrich** it by fetching
> each service page's real `<title>`/`<h1>` (or paragraph text) before the LLM
> call — this materially improves differentiator quality. The data model and
> prompt already support (b); you just need to populate `title`/`h1`. This PRD
> documents the shipped behavior (a) and flags where to add (b).

### 1.4 Relationship to the Brand Voice engine
This is a sibling of the Brand Voice engine and shares the same page-discovery
and classification helpers (`classify_page_type`, sitemap/nav discovery, SSRF
guard). If you ported Brand Voice already, factor those helpers into a shared
module and reuse them here.

There is also a **separate, much simpler** keyword-based ICP detector used only
inside the page-scoring/generation flow (`detect_icp_from_keyword` → maps keyword
modifiers like "emergency"/"commercial" to a tone + CTA). That is **not** this
feature and is out of scope here; this PRD covers the website-derived ICP Creator.

---

## 2. External dependencies

| Dependency | Used for | Notes |
|---|---|---|
| **LLM API** (e.g. Anthropic Claude) | ICP + differentiator detection (1 call) and optional URL classification (1 call) | Cheap/fast model (original: `claude-haiku-4-5`). Original uses **plain JSON output** with markdown-fence stripping; you may upgrade to forced tool-use for robustness (see §6.3). |
| **Sitemap/HTTP client** | Page discovery | Standard HTTP client (httpx). |
| **HTML parser** | Sitemap XML + nav link extraction | BeautifulSoup or equivalent. |

> No scraping service (ScrapeOwl) is required for the shipped URL-only behavior —
> discovery only fetches `robots.txt`, sitemaps, and the homepage. If you adopt
> the title/H1 enrichment from §1.3(b) you'll want a scraper for bot-protected
> sites.

---

## 3. Data model

Store the ICP as JSON on the business record (e.g. `business_profiles.detected_icp
JSONB`) and differentiators in a parallel column (`differentiators JSONB`).

### 3.1 `detected_icp`
```jsonc
{
  "segments": [
    {
      "label": "Emergency Homeowner",        // short human-readable name
      "confidence": 0.0,                       // 0.0–1.0
      "primary": true,                         // exactly one segment should be primary
      "demographics": {
        "description": "age/income/ownership or business size — whatever is most relevant",
        "situation": "the life/business situation that makes them a customer"
      },
      "psychographics": {
        "trigger": "the specific moment/event that causes them to search — concrete",
        "fears": ["fear 1", "fear 2", "fear 3"],
        "motivations": ["motivation 1", "motivation 2"],
        "buying_behavior": "1 sentence on how they evaluate and choose a provider"
      },
      "messaging": {
        "tone": "the tone that resonates, e.g. 'Calm and reassuring'",
        "hooks": ["headline hook 1", "headline hook 2", "headline hook 3"],
        "trust_signals": ["trust signal 1", "trust signal 2", "trust signal 3"]
      }
    }
    // 1–3 segments total
  ],
  "reasoning": "2–3 sentences explaining why these segments were chosen"
}
```

### 3.2 `differentiators`
```jsonc
[
  {
    "claim": "specific claim",
    "mechanism": "how they achieve / back up the claim",
    "type": "speed | cost | guarantee | specialization | availability | other"
  }
]
```
(Empty array when none are evident.)

### 3.3 Page record (intermediate, returned in the response)
```jsonc
{
  "url": "https://example.com/hvac-repair",
  "title": "",                 // empty in URL-only mode (see §1.3)
  "h1": "",                    // empty in URL-only mode
  "page_type": "service",      // service | location | city_service | other (blogs dropped)
  "primary_service": null,
  "primary_city": null
}
```

---

## 4. API surface

### 4.1 `POST /analyze-business`
**Request**
```jsonc
{
  "website_url": "https://example.com",   // optional/null
  "business_name": "Example Plumbing",    // required
  "gbp_category": "Plumber",              // required — primary category
  "gbp_categories": ["Plumber", "Drainage service"]  // optional — all categories
}
```

**Response**
```jsonc
{
  "existing_pages": [ /* page records, §3.3 */ ],
  "detected_icp": { /* §3.1, or null */ },
  "differentiators": [ /* §3.2 */ ],
  "pages_crawled": 12,
  "analysis_status": "complete"           // "complete" if pages found, else "partial"
}
```

**Auth & limits**
- Require auth (API key or user JWT — match the host app).
- **Rate limit:** 5 requests / minute / caller (LLM call + discovery + optional URL-classification call).

**Error handling**
- LLM ICP call fails → `502`: "Analysis service temporarily unavailable".
- SSRF guard (private/loopback/reserved IP) → `400`.
- Page discovery timeout (90s) → proceed with no pages (degrades to no-website path; status `partial`).

---

## 5. Pipeline detail

### 5.1 Page discovery — `crawl_website(url, max_pages=200)`
1. Run the **SSRF guard** on the URL (§7). Normalize (prepend `https://` if no scheme).
2. Discover candidate URLs, in order of preference:
   - **Sitemap:** read `robots.txt` for a `Sitemap:` directive; else try common
     locations (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`,
     `/page-sitemap.xml`, `/post-sitemap.xml`, …). Recurse one level into sitemap
     indexes. Filter to same-domain, non-asset URLs.
   - **Nav fallback:** if no sitemap, fetch the homepage and extract `<nav>`/`<header>`
     links (same-domain, non-asset).
3. Always include the homepage origin; dedupe preserving order.
4. **Classify every URL** with the rule-based classifier (§5.2).
5. **AI reclassification (optional but recommended):** collect URLs the rules left
   as `other` (cap 150) and send them to a single LLM call (§6.3) for
   reclassification; AI results take precedence for those URLs.
6. **Drop `blog`** pages. Build page records (with empty `title`/`h1` — see §1.3).
7. **Sort** `city_service → service → location → other`, take top `max_pages` (200).

> Wrap discovery in a **90s timeout**; on timeout, proceed with zero pages.

### 5.2 Rule-based page classification — `classify_page_type(url, title?, h1?)`
Returns `{ type, primary_service, primary_city }`, `type ∈ {service, location,
city_service, blog, other}`. Key rules (full vocab sets ship in the code port):
- First segment in a blog-slug set (`blog`, `news`, `articles`, `resources`, …) → `blog`.
- Any path segment starting with a digit (e.g. `/5-tips-…`) → `blog`.
- `vs` as a standalone path word → `blog`.
- Leaf slug that "looks like a blog" (>6 words, lead question/verb word, mid-slug
  function words, a 4-digit year, or 4+ words with a stop word) → `blog`,
  *unless* it has both a service word AND a state abbrev at the end (protects
  `/emergency-plumber-dallas-tx`).
- Geo signal = state abbrev at end of a segment (`-tx`), a 5-digit ZIP, a location
  slug (`/locations`, `/service-areas`), or `near` as a path word.
- Service signal = any known service word in the path.
- `has_geo & has_service` → `city_service`; geo only → `location`; service only →
  `service`; single short non-about slug → `service`; else `other`.

### 5.3 Analysis — one LLM call
- Cheap/fast model, `max_tokens ≈ 4096`.
- Builds a prompt (§6) with business name, GBP categories, and up to **25** page
  records (`[type] url / Title / H1`).
- **No-website path:** swap the page list for an instruction to infer segments
  from name + categories only.
- Original parses **plain JSON** from the text response (stripping ```` ``` ````
  fences). See §6.3 for the optional tool-use upgrade.
- On exception, raise → caller returns `502`.

### 5.4 Assemble result
Return `existing_pages`, `detected_icp`, `differentiators`, `pages_crawled`, and
`analysis_status` (`complete` if any pages were found, else `partial`).

---

## 6. LLM prompt (copy verbatim)

### 6.1 ICP + differentiator prompt
Model: cheap/fast. `max_tokens: 4096`. No system prompt in the original (all
instruction is in the user message). `{pages_section}` is either the rendered page
list or the no-website instruction (§6.2).

```
You are an expert marketing strategist. Analyze this local service business and identify its ideal customer profiles (ICPs) with full psychographic detail.

Business Name: {business_name}
GBP Primary Category: {gbp_category}
All GBP Categories: {comma-joined gbp_categories, or 'N/A'}

{pages_section}

Identify 1-3 distinct customer segments this business serves. For each segment provide deep psychographic insight a marketer could use to write targeted local SEO content.

Return a JSON object with exactly this structure:
{
  "detected_icp": {
    "segments": [
      {
        "label": "<short human-readable segment name, e.g. 'Emergency Homeowner' or 'Commercial Facilities Manager'>",
        "confidence": <0.0-1.0>,
        "primary": <true for the top segment, false for others>,
        "demographics": {
          "description": "<age range, income level, ownership status, or business size — whatever is most relevant>",
          "situation": "<the life or business situation that makes them a customer>"
        },
        "psychographics": {
          "trigger": "<the specific moment or event that causes them to search — be concrete>",
          "fears": ["<fear 1>", "<fear 2>", "<fear 3>"],
          "motivations": ["<motivation 1>", "<motivation 2>"],
          "buying_behavior": "<1 sentence describing how they evaluate and choose a provider>"
        },
        "messaging": {
          "tone": "<the tone that resonates with this segment, e.g. 'Calm and reassuring' or 'Direct and ROI-focused'>",
          "hooks": ["<headline hook 1>", "<headline hook 2>", "<headline hook 3>"],
          "trust_signals": ["<trust signal 1>", "<trust signal 2>", "<trust signal 3>"]
        }
      }
    ],
    "reasoning": "<2-3 sentences explaining why these segments were chosen based on the business category and page structure>"
  },
  "differentiators": [
    {"claim": "<specific claim from page titles or H1s>", "mechanism": "<how they achieve or back up the claim>", "type": "<speed|cost|guarantee|specialization|availability|other>"}
  ]
}

Extract differentiators only from the page titles and H1s of service/core pages. Ignore any content that appears to be blog or editorial. If no differentiators are evident, return an empty array.

Return only valid JSON, no markdown or explanation.
```

### 6.2 `{pages_section}` content
**Website path** (render up to 25 page records):
```
Discovered website pages (URL-classified, may include misclassified blog/content pages):
  [service] https://example.com/hvac-repair
    Title: 
    H1: 
  [city_service] https://example.com/plumbing-dallas-tx
    Title: 
    H1: 
  ... (up to 25)

IMPORTANT: Before analyzing, mentally discard any pages that look like blog posts, articles, news, or general content (e.g. URLs with date patterns, long descriptive slugs, how-to or tips-style titles). Only use pages that represent actual services, locations, or core business offerings for your analysis.
```
**No-website path:**
```
No website available. Base your analysis entirely on the business name and GBP categories above. Use your knowledge of this business type to infer the most likely customer segments.
```

### 6.3 (Optional) URL classification prompt — `classify_urls_with_ai`
Used in §5.1 step 5 to reclassify ambiguous `other` URLs. Plain JSON output.
```
Classify each URL from a business website. Return ONLY a JSON object mapping URL→type.

Types: city_service | service | location | blog | other
- city_service: service targeting a specific city, ends with city/state (e.g. /plumbing-dallas-tx/, /managed-it-miami-fl/)
- service: bare noun-phrase service page, MAX 3 words (e.g. /hvac-repair/, /cybersecurity/, /managed-it-services/)
- location: city or service-area listing (e.g. /locations/, /service-areas/)
- blog: post, article, news, press release, how-to guide, opinion, product update, monthly roundup, tips, announcement, dated content — anything informational or editorial
- other: about, contact, team, privacy, homepage, etc.

CRITICAL RULES:
1. Service page slugs are BARE NOUN PHRASES of 1–3 words. No verbs, no articles (the/a/an), no pronouns, no modifiers.
2. Any slug with 4+ words that is NOT a clear city+service combo → blog or other.
3. Topics about specific software products (Teams, Yammer, Office 365), compliance issues, security threats, or IT tips are BLOG posts — not service pages.
4. Gerunds (building, becoming, creating), question words, and contractions always indicate blog.
5. When genuinely uncertain → blog.

{newline-joined urls}

JSON only: {"url1": "type1", "url2": "type2"}
```

> **Robustness upgrade:** the original uses free-text JSON + fence-stripping for
> both calls, which can occasionally fail to parse. For the new app, consider
> **forced tool-use** with an `input_schema` matching §3 (as the Brand Voice
> engine does) to make output parsing bulletproof. Keep the prompt text identical.

---

## 7. Security: SSRF guard
Before fetching any user-supplied URL (discovery, sitemap, homepage):
- Scheme must be `http`/`https` (else `400 Invalid URL scheme`).
- If the hostname parses as an IP, reject **private, loopback, reserved, or
  link-local** addresses (`400`).
- Hostnames (non-IP) are allowed.

Use a polite crawler User-Agent, e.g.
`ICPBot/1.0 (business-page-discovery; respects robots.txt)`.

---

## 8. Frontend / UX requirements

This typically runs as part of **business onboarding** (right after the user
saves a business / Google Business Profile), not a manual button — but expose a
re-run too. Recommended UI (an "ICP & Differentiators" tab on the business detail
screen):

1. **Trigger:** automatically on business save, or a **"Detect ICP"** /
   **"Re-analyze"** button. Show progress ("Analyzing your business…").
2. On success, `POST /analyze-business`, then **persist** `detected_icp` and
   `differentiators` to the business record.
3. **Display** each segment: label (+ "PRIMARY" badge), confidence, demographics,
   psychographics (trigger, fears, motivations, buying behavior), messaging
   (tone, hooks, trust signals), and the overall `reasoning`.
4. **Display** differentiators (claim + mechanism + type).
5. Allow the user to **edit** segments/differentiators inline and save back.
6. **Re-analyze** button to regenerate.

---

## 9. Consuming the ICP in content generation

Render the detected ICP into a plain-text block prepended to the generator's
prompt. Differentiators are rendered separately (claim + mechanism).

### 9.1 ICP block format (`build_icp_text`, default max 3 segments)
Primary segment first, then the rest, capped at `max_segments`:
```
TARGET CUSTOMER PROFILES (write to these pain points and motivations):
  [Emergency Homeowner — PRIMARY]
    Demographics: {demographics.description}
    Situation: {demographics.situation}
    Search trigger: {psychographics.trigger}
    Fears (address these): {psychographics.fears joined '; '}
    Motivations (emphasise these): {psychographics.motivations joined '; '}
    Buying behaviour: {psychographics.buying_behavior}
    Messaging tone: {messaging.tone}
    Headline hooks: {messaging.hooks joined '; '}
    Trust signals: {messaging.trust_signals joined '; '}
  [Second Segment]
    ...
```
Return `""` when ICP is empty so callers can safely interpolate.

### 9.2 Differentiators block format
```
DIFFERENTIATORS (weave these in naturally — include the mechanism, not just the claim):
  - {claim} (mechanism: {mechanism})
  - ...
```

> Content generators typically cap ICP at 2–3 segments to keep the prompt focused
> (the original uses `max_segments=3` for pages, `2` for shorter posts).

---

## 10. Tunable constants (defaults)

| Constant | Default | Meaning |
|---|---|---|
| `crawl_website` max_pages | 200 | Page records kept after sort |
| Pages shown to ICP LLM | 25 | First N records rendered into the prompt |
| Ambiguous-URL cap for AI classify | 150 | Max `other` URLs sent for reclassification |
| Discovery timeout | 90s | Then proceed with zero pages |
| `max_tokens` (ICP call) | 4096 | — |
| `max_tokens` (URL classify call) | 2048 | — |
| ICP segments | 1–3 | Detected per business |
| `build_icp_text` max_segments | 3 (pages) / 2 (posts) | Segments injected downstream |
| Rate limit | 5/min | On `/analyze-business` |
| Model | cheap/fast (e.g. `claude-haiku-4-5`) | All calls |

---

## 11. Acceptance criteria

- [ ] `POST /analyze-business` returns `existing_pages`, `detected_icp`, `differentiators`, `pages_crawled`, `analysis_status`.
- [ ] `detected_icp.segments` has 1–3 entries; exactly one has `primary: true`; each has demographics, psychographics, and messaging populated per §3.1.
- [ ] No-website path returns a sensible category-inferred ICP and `analysis_status: "partial"`.
- [ ] Blog/editorial URLs are excluded from the pages passed to the LLM.
- [ ] SSRF guard blocks private/loopback/reserved IPs with `400`.
- [ ] Discovery timeout (90s) degrades gracefully to the no-website path.
- [ ] LLM output parses reliably (fence-stripped JSON, or tool-use per §6.3).
- [ ] Result persists to the business record; user can edit and re-analyze.
- [ ] Content generator injects the ICP block (and differentiators) per §9.

---

## 12. Build order (suggested)
1. Data model + `POST /analyze-business` skeleton + auth/rate limit.
2. SSRF guard + URL normalization.
3. Page discovery (sitemap → nav) + rule-based `classify_page_type` + sort + blog drop.
4. (Optional) ambiguous-URL AI reclassification call.
5. The ICP LLM call with the exact prompt (§6) + JSON parsing (or tool-use).
6. Assemble + return + persist (`detected_icp`, `differentiators`).
7. Frontend ICP & Differentiators tab (display, edit, re-analyze).
8. `build_icp_text` + differentiators block; wire into the content generator.
9. *(Optional quality upgrade)* populate page `title`/`h1` before the LLM call (§1.3b).
```
