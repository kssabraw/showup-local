# PRD — Brand Voice Engine (Portable)

> **Purpose:** Re-create the "brand voice" capability from ShowUP Local in a new
> application. Given a business (name + optional website + optional category),
> the system produces a structured **brand voice profile** and a **writer
> execution guide**, stores it, lets the user review/edit/accept it, and injects
> it into downstream AI content generation so generated copy matches the brand's
> tone.
>
> This document is **stack-agnostic**. It specifies behavior, data shapes, the
> exact LLM prompts, and tool (function-calling) schemas. Re-implement the
> orchestration in whatever language/framework the target app uses. The prompts
> and tool schemas should be copied **verbatim** — they are the parts that took
> tuning.

---

## 1. Overview

### 1.1 What it does
1. **Discovers** up to 25 of the most representative pages on the client's website (home, about, service, location pages — skipping blog/legal/admin pages).
2. **Scrapes** those pages and extracts clean paragraph text.
3. Runs **three sequential LLM calls** (cheap/fast model, forced tool-use):
   - **Current Voice** — objectively describes how the site sounds today.
   - **Recommended Voice** — an elevated, optimized voice for this business type.
   - **Writer Execution Guide** — actionable writing system derived from the recommended voice.
4. **Stores** the result as JSON on the business record.
5. Lets the user **edit** the current voice and **accept/reject** the recommended voice.
6. **Injects** the chosen voice into the system prompt of the content generator, defaulting to the current voice unless the recommended one is explicitly accepted.

### 1.2 Two entry paths
- **Website path** (a URL is provided and reachable): crawl → scrape → 3 LLM calls.
- **No-website path** (no URL, or scraping yields nothing): skip "current voice"; generate "recommended voice" from **business name + category** alone, then the guide.

### 1.3 Why it matters
Generated SEO/marketing content otherwise sounds generic. The brand voice block
constrains *expression* (word choice, tone, rhythm) while leaving *structure*
(headings, answer-first formatting) to other rules.

---

## 2. External dependencies

| Dependency | Used for | Notes |
|---|---|---|
| **LLM API with function/tool calling** (e.g. Anthropic Claude) | The 3 analysis calls | Use a cheap, fast model (original used `claude-haiku-4-5`). Forced tool-use guarantees schema-valid JSON output. |
| **HTML scraping** | Fetching page HTML | Original used **ScrapeOwl** (premium/residential proxies, optional JS rendering) to defeat Cloudflare/WAF and render SPA sites. A plain HTTP client works for simple sites but will fail on bot-protected/JS-heavy sites. |
| **HTML parser** | Extracting text from HTML | Original used BeautifulSoup; any equivalent works. |
| **Sitemap/HTTP client** | Page discovery | Standard HTTP client. |

> **Recommendation:** Keep the two-tier scrape (no-JS first, JS-render fallback).
> Many small-business sites are on Wix/Squarespace/Webflow/Duda and need JS
> rendering or `<div>`/`<span>` text extraction.

---

## 3. Data model

Store the brand voice as a single JSON blob on the business record
(e.g. `business_profiles.brand_voice JSONB`).

### 3.1 Stored shape
```jsonc
{
  "current_voice": { /* VoiceProfile, or null if no website */ },
  "recommended_voice": { /* VoiceProfile */ },
  "recommended_accepted": null,        // null = undecided, true = use recommended, false = keep current
  "writer_execution_guide": { /* WriterGuide */ }
}
```

### 3.2 `VoiceProfile` (output of `submit_brand_voice` tool)
```jsonc
{
  "personality": ["string", "string", "string"],        // exactly 3 traits
  "tone": "string",                                       // 1–2 sentences
  "writing_style": {
    "sentence_length": "short | medium | long | mixed",
    "person": "first person | second person | third person | mixed",
    "jargon_level": "low | medium | high — brief explanation",
    "formality": "casual | professional | formal"
  },
  "vocabulary": {
    "use":   ["string", ...],   // 5 words/phrases to use
    "avoid": ["string", ...]    // 3 words/phrases to avoid
  },
  "messaging_themes": ["string", "string", "string"],    // 3 themes
  "sample_phrases": ["string", "string", "string"],      // 3 exemplar phrases
  "content_generation_instructions": "string"            // 2–3 sentences of concrete guidance
}
```

### 3.3 `WriterGuide` (output of `submit_writer_execution_guide` tool)
```jsonc
{
  "how_to_think_before_writing": "string",     // role/mindset
  "core_writing_objective": "string",          // what every piece must achieve
  "default_writing_formula": "string",         // e.g. Problem → Consequence → Solution → Outcome + example
  "non_negotiable_rules": ["string", ...],     // 5
  "sentence_style_do": ["string", ...],        // 3 DO examples
  "sentence_style_dont": ["string", ...],      // 3 DON'T examples
  "rewriting_framework": ["string", ...],      // 3 rewrite examples (generic→specific, feature→outcome, soft→direct)
  "before_after_weak": "string",
  "before_after_strong": "string",
  "seo_aeo_instructions": "string",            // answer-first, scannable content
  "ai_writing_rules": "string",                // maintaining voice when using AI tools
  "common_failure_modes": ["string", ...],     // 3 failure modes + fixes
  "quick_cheat_sheet": ["string", ...]         // 5 quick rules
}
```

---

## 4. API surface

### 4.1 `POST /analyze-brand-voice`
**Request**
```jsonc
{
  "website_url": "https://example.com",   // optional/null
  "business_name": "Example Plumbing",    // required
  "gbp_category": "Plumber",              // optional — business/category label
  "existing_pages": []                    // optional — reserved
}
```

**Response**
```jsonc
{
  "brand_voice": { /* the stored shape from §3.1 */ },
  "pages_sampled": 12                      // how many pages produced usable text
}
```

**Auth & limits**
- Require auth (API key or user JWT — match the host app).
- **Rate limit:** 5 requests / minute / caller (this endpoint is expensive — 3 LLM calls + up to ~25 scrapes).

**Error handling (return friendly messages, not stack traces):**
- Website returns ≥400 on probe → `422`: "Your website returned a {code} error. Check that the URL is correct and the site is live."
- Website unreachable (connection error) → `422`: "Your website couldn't be reached. Check that the URL is correct and your site is live."
- LLM call fails entirely → `502`: "Our AI analysis service encountered an error. Please try again."
- SSRF guard (see §7) → `400`.

---

## 5. Pipeline detail

### 5.1 Probe (website path only)
`GET` the URL once (follow redirects, ~10s timeout). If status ≥ 400 or a
connection error occurs, fail fast with the `422` messages above. Normalize the
URL first (prepend `https://` if no scheme).

### 5.2 Page discovery — `crawl_pages_for_brand_voice(url, max_pages=25)`
1. Run the **SSRF guard** on the URL (§7).
2. Discover candidate URLs:
   - **Primary:** parse the site's `sitemap.xml` (and nested sitemaps).
   - **Fallback:** scrape homepage nav `<a href>` links if no sitemap.
3. Always include the homepage origin.
4. **Classify & filter** each URL (see §5.3):
   - Drop `blog` pages.
   - Drop URLs whose first path segment is in **`SKIP_SLUGS`** (below).
5. **Priority-sort** so the most voice-representative pages come first, then take the top `max_pages` (25):

   | Priority | Page |
   |---|---|
   | 0 | Homepage (`/`, `/index`, `/home`) |
   | 1 | About pages (slug contains `about`, `who-we-are`, `our-story`, `team`, `about-us`) |
   | 2 | Top-level (single-segment) service pages |
   | 3 | Deeper service pages |
   | 4 | Location / city-service pages |
   | 5 | Everything else |

**`SKIP_SLUGS`** (drop these first-segment slugs):
```
privacy, terms, sitemap, search, tag, tags, category, categories,
author, wp-content, wp-admin, wp-json, cart, checkout, account,
login, register, feed, rss, cdn, admin, dashboard, portal
```

### 5.3 Page classification — `classify_page_type(url, title?, h1?)`
Rule-based classifier returning `{ type, primary_service, primary_city }` where
`type ∈ { service, location, city_service, blog, other }`. Key rules:
- First segment in a known **blog slug set** (e.g. `blog`, `news`, `articles`, `posts`, `resources`) → `blog`.
- Any path segment that **starts with a digit** (e.g. `/4-tips-for…`) → `blog`.
- `vs` as a standalone path word → comparison article → `blog`.
- Location detection requires a **state abbreviation at the end of a path segment** (e.g. `-tx`, `-fl`) to avoid false positives from English words that double as state codes (`in`, `or`, `me`, `ok`).
- About/contact/utility slugs (`about`, `contact`, `team`, `reviews`, `pricing`, etc.) are treated as non-service.

> For a first port you can ship a simplified classifier: treat anything matching
> blog patterns as `blog`, location-slug patterns as `location`, and the rest as
> `service`/`other`. The priority sort is what matters most.

### 5.4 Scrape + extract text
For each selected page, fetch HTML and extract paragraph text:
1. Strip `<script>, <style>, <nav>, <footer>, <header>, <noscript>, <aside>`.
2. Collect `<p>` text where length > 40 chars; keep up to 30 per page.
3. **Fallback for builder sites** (Wix/Squarespace/Duda often avoid `<p>`): if no
   paragraphs found, split `get_text()` by lines, keep unique lines > 40 chars (up to 30).
4. Prefix each page's text with a tag: `[{page_type}] {url}\n{text[:600]}`.

**Two-tier scraping (resilience):**
- **Tier 1:** scrape all selected pages **without JS rendering** (cheaper/faster), concurrency capped (≤ 8 concurrent).
- **Tier 2:** if Tier 1 yields **zero** usable pages, retry the **top 5** pages **with JS rendering**.
- If both tiers fail → fall back to the **no-website path** (category inference).

`pages_sampled` = count of pages that produced usable text.

### 5.5 Analysis — three LLM calls
All three use:
- A cheap/fast model.
- **Forced tool use** (`tool_choice` set to the specific tool) → guarantees the
  response is a schema-valid JSON object, eliminating JSON-parse failures from
  stray quotes in free-text fields.
- `max_tokens`: 2048 for voice calls, ~3000 for the guide call.
- Extract the tool-call `input` object as the result. On any single-call
  exception, log it and continue with an empty/null result for that call (the
  pipeline is resilient to partial failure).

The three calls and their prompts are specified verbatim in §6.

### 5.6 Assemble result
Return the §3.1 stored shape:
```jsonc
{
  "current_voice": <Call1 result or null>,
  "recommended_voice": <Call2 result>,
  "recommended_accepted": null,
  "writer_execution_guide": <Call3 result>
}
```
(No-website path sets `current_voice` to `null`.)

---

## 6. LLM prompts & tool schemas (copy verbatim)

### 6.1 Tool: `submit_brand_voice`
```jsonc
{
  "name": "submit_brand_voice",
  "description": "Submit the analyzed brand voice profile.",
  "input_schema": {
    "type": "object",
    "required": ["personality","tone","writing_style","vocabulary",
                 "messaging_themes","sample_phrases","content_generation_instructions"],
    "properties": {
      "personality": { "type": "array", "description": "3 personality traits.", "items": {"type":"string"} },
      "tone": { "type": "string", "description": "1-2 sentence description of the overall tone." },
      "writing_style": {
        "type": "object",
        "required": ["sentence_length","person","jargon_level","formality"],
        "properties": {
          "sentence_length": {"type":"string","description":"short / medium / long / mixed"},
          "person":          {"type":"string","description":"first person / second person / third person / mixed"},
          "jargon_level":    {"type":"string","description":"low / medium / high — brief explanation"},
          "formality":       {"type":"string","description":"casual / professional / formal"}
        }
      },
      "vocabulary": {
        "type": "object",
        "required": ["use","avoid"],
        "properties": {
          "use":   {"type":"array","description":"5 words/phrases to use.","items":{"type":"string"}},
          "avoid": {"type":"array","description":"3 words/phrases to avoid.","items":{"type":"string"}}
        }
      },
      "messaging_themes": {"type":"array","description":"3 messaging themes.","items":{"type":"string"}},
      "sample_phrases": {"type":"array","description":"3 sample phrases that exemplify this voice.","items":{"type":"string"}},
      "content_generation_instructions": {"type":"string","description":"2-3 sentences of concrete guidance for writing content that matches this brand voice."}
    }
  }
}
```

### 6.2 Tool: `submit_writer_execution_guide`
```jsonc
{
  "name": "submit_writer_execution_guide",
  "description": "Submit the writer execution guide derived from the recommended brand voice.",
  "input_schema": {
    "type": "object",
    "required": ["how_to_think_before_writing","core_writing_objective","default_writing_formula",
                 "non_negotiable_rules","sentence_style_do","sentence_style_dont",
                 "rewriting_framework","before_after_weak","before_after_strong",
                 "seo_aeo_instructions","ai_writing_rules","common_failure_modes","quick_cheat_sheet"],
    "properties": {
      "how_to_think_before_writing": {"type":"string","description":"Role and mindset the writer should assume."},
      "core_writing_objective":      {"type":"string","description":"What every piece of content must achieve."},
      "default_writing_formula":     {"type":"string","description":"e.g. Problem → Consequence → Solution → Outcome — include a concrete example sentence."},
      "non_negotiable_rules":        {"type":"array","description":"5 non-negotiable rules.","items":{"type":"string"}},
      "sentence_style_do":           {"type":"array","description":"3 DO examples.","items":{"type":"string"}},
      "sentence_style_dont":         {"type":"array","description":"3 DON'T examples.","items":{"type":"string"}},
      "rewriting_framework":         {"type":"array","description":"3 rewrite examples (generic→specific, feature→outcome, soft→direct).","items":{"type":"string"}},
      "before_after_weak":           {"type":"string","description":"A weak copy example."},
      "before_after_strong":         {"type":"string","description":"The improved version of the weak example."},
      "seo_aeo_instructions":        {"type":"string","description":"Guidance for answer-first, scannable content for SEO and AI retrieval."},
      "ai_writing_rules":            {"type":"string","description":"Instructions for maintaining voice when using AI tools."},
      "common_failure_modes":        {"type":"array","description":"3 failure modes paired with fixes.","items":{"type":"string"}},
      "quick_cheat_sheet":           {"type":"array","description":"5 quick rules.","items":{"type":"string"}}
    }
  }
}
```

### 6.3 Call 1 — Current Voice (website path only)
- **System:** `You are a brand analyst. Describe brand voice objectively based on evidence from the website copy. Do not prescribe or recommend — only describe what you observe.`
- **Tool:** force `submit_brand_voice`.
- **User prompt** (`content_text` = joined page texts, truncated to 8000 chars):
```
Business: {business_name}

Website copy (service, location, and core business pages only):
{content_text[:8000]}

Describe the brand voice EXACTLY as it currently exists on this website. Be objective and descriptive — report what you observe, do not prescribe or improve anything.

Call the submit_brand_voice tool with what you observe.
```

### 6.4 Call 2 — Recommended Voice (website path)
- **System:** `You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend an elevated, optimized brand voice.`
- **Tool:** force `submit_brand_voice`.
- **User prompt** (inject current voice summary; `content_text` truncated to 8000):
```
Business: {business_name}

Current brand voice:
- Personality: {current.personality joined}
- Tone: {current.tone}

Website copy (service, location, and core business pages only):
{content_text[:8000]}

Based on the current brand voice and business type, recommend an elevated brand voice that would better serve this business. Do NOT simply mirror the existing copy — improve weak or generic messaging.

Call the submit_brand_voice tool with the recommended brand voice.
```

### 6.5 Call 2′ — Recommended Voice (no-website path)
- **System:** `You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend a high-performing brand voice based on business type.`
- **Tool:** force `submit_brand_voice`.
- **User prompt:**
```
Business: {business_name}
GBP Category: {gbp_category}

No website is available for this business. Based solely on the business name and category, recommend a high-performing brand voice that would work well for a local {gbp_category or 'service'} business. Draw on best practices for this business type.

Call the submit_brand_voice tool with the recommended brand voice.
```
(Set `current_voice = null` on this path.)

### 6.6 Call 3 — Writer Execution Guide (both paths)
- **System:** `You are a senior brand strategist and direct-response copywriter building brand voice systems for local service businesses.`
- **Tool:** force `submit_writer_execution_guide`. `max_tokens ≈ 3000`.
- **User prompt** (`guide_lead` = `"Website copy:"` when content exists, else `"No website available — write the guide based on the recommended voice and business category."`; `content_text` truncated to 6000):
```
Business: {business_name}
Recommended brand voice summary: {recommended.tone}
Personality: {recommended.personality joined}

{guide_lead}
{content_text[:6000]}

Call the submit_writer_execution_guide tool with the writer execution guide.
```

---

## 7. Security: SSRF guard
Before fetching any user-supplied URL (probe, crawl, scrape), validate it:
- Scheme must be `http`/`https` (else `400 Invalid URL scheme`).
- If the hostname parses as an IP, reject **private, loopback, reserved, or
  link-local** addresses (`400 URL targets a private network address`).
- Hostnames (non-IP) are allowed.

Use a polite crawler User-Agent for first-party fetches, e.g.:
`ShowUPLocalBot/1.0 (business-page-discovery; respects robots.txt)`.

---

## 8. Frontend / UX requirements

A **Brand Voice** tab/section on the business detail screen:

1. **Empty state CTA:**
   - If website on file → button **"Scan Website"**.
   - If no website → button **"Generate from Category"**.
   - While running, show progress text:
     - website: "Scanning website for brand voice signals…"
     - no website: "Generating brand voice from business category…"
2. On success, `POST /analyze-brand-voice`, then **persist** `brand_voice` to the business record.
3. **Display** the active voice profile (tone, personality, writing style, vocab use/avoid, messaging themes, sample phrases).
4. **Edit** (current voice): inline editor; on save, write the edited profile back into `current_voice` (preserve the rest of the blob).
5. **Recommended voice review:** show the recommended voice alongside current, with **Accept / Reject** controls that set `recommended_accepted` to `true`/`false` and persist.
6. **Re-scan** button to regenerate.

---

## 9. Consuming the voice in content generation

When generating content for a business, render the chosen voice into a plain-text
block prepended to the generator's system/user prompt.

### 9.1 Voice selection logic (`build_brand_voice_text`)
```
if brand_voice.recommended_accepted == true:
    voice = recommended_voice || current_voice || {}
else:
    voice = current_voice || recommended_voice || {}     // default: current
guide = writer_execution_guide || {}
if no voice and no guide: return ""   // inject nothing
```
> **Default is the current voice.** Only switch to recommended when the user has
> explicitly accepted it. Fall back to whichever exists if the preferred is missing.

### 9.2 Rendered block format
```
BRAND VOICE (match this exactly):
  Tone: {voice.tone}
  Personality: {voice.personality joined}
  Writing style: {sentence_length} sentences, {person}, {formality} formality, jargon: {jargon_level}
  Words/phrases to use: {vocabulary.use joined}
  Words/phrases to avoid: {vocabulary.avoid joined}
  Messaging themes: {messaging_themes joined with '; '}
  Sample phrases (mirror this style): {sample_phrases joined with '; '}
  Writer instructions: {content_generation_instructions}
  Default writing formula: {guide.default_writing_formula}
  Non-negotiable rules:
    - {each}
  Sentence style — DO:
    - {each}
  Sentence style — DON'T:
    - {each}
  Quick cheat sheet:
    - {each}
```
> Inject only the **high-signal** subset of the guide (formula, non-negotiable
> rules, DO/DON'T, cheat sheet). Omit strategic fields (mindset, failure modes,
> before/after) to keep the prompt compact.

### 9.3 Tiebreaker rule (put in the generator's system prompt)
> Brand voice governs **expression** — word choice, tone, personality, sentence
> rhythm. It does **not** override structural/formatting rules (answer-first
> responses, heading structure, list usage). When voice and structure conflict,
> structure wins; apply the voice to the wording *within* the required structure.

---

## 10. Tunable constants (defaults)

| Constant | Default | Meaning |
|---|---|---|
| `MAX_PAGES` | 25 | Pages discovered/sampled for analysis |
| Tier-2 JS-render page cap | 5 | Top-priority pages retried with JS rendering |
| Scrape concurrency | 8 | Concurrent scrape requests |
| `content_text` cap (Calls 1 & 2) | 8000 chars | Truncation of joined page copy |
| `content_text` cap (Call 3) | 6000 chars | Truncation for the guide call |
| Per-page text | ≤ 30 paragraphs, each > 40 chars, prefix ≤ 600 chars | Extraction limits |
| `max_tokens` (voice calls) | 2048 | — |
| `max_tokens` (guide call) | 3000 | — |
| Rate limit | 5/min | On `/analyze-brand-voice` |
| Model | cheap/fast (e.g. `claude-haiku-4-5`) | All 3 calls |

---

## 11. Acceptance criteria

- [ ] `POST /analyze-brand-voice` returns the §3.1 shape with `pages_sampled`.
- [ ] Website path produces non-null `current_voice` and a `recommended_voice` that is **not** a verbatim copy of current.
- [ ] No-website path returns `current_voice: null` and a category-appropriate `recommended_voice`.
- [ ] Unreachable / 4xx site returns a friendly `422`.
- [ ] SSRF guard blocks private/loopback/reserved IPs with `400`.
- [ ] JS-heavy and builder (Wix/Squarespace) sites yield usable text via the Tier-2 fallback.
- [ ] All 3 LLM outputs validate against their tool schemas (no JSON parse step needed).
- [ ] A single failed LLM call degrades gracefully (others still return).
- [ ] Result persists to the business record; user can edit current voice and accept/reject recommended.
- [ ] Content generator injects the brand voice block, defaulting to current voice and only using recommended when `recommended_accepted === true`.

---

## 12. Build order (suggested)
1. Data model + `POST /analyze-brand-voice` skeleton + auth/rate limit.
2. SSRF guard + URL normalization + probe.
3. Page discovery (sitemap → nav fallback) + classify + priority sort + `SKIP_SLUGS`.
4. Scrape + text extraction (Tier 1, then Tier 2 JS fallback, then builder-site `<div>` fallback).
5. The 3 LLM calls with the exact prompts/tool schemas (§6).
6. Assemble + return + persist.
7. Frontend Brand Voice tab (scan/generate, display, edit, accept/reject, re-scan).
8. `build_brand_voice_text` + wire into the content generator with the §9.3 tiebreaker.
```
```
