# 📌 PRD — Local Content Writer App (Part 2 of 2)
> Sections: Geographic Legitimacy Engine, Hyperlocal/Near-Me Engine, Master Input Schema, Content Output Spec, ICP Engine, Master Composite Score, App Modes, Schema Output Spec, Core User Journey, Addendums
> See PRD_part1.md for Part 1

---

# 📌 PRD Section: Geographic Legitimacy Engine

## 🎯 Objective

Ensure every generated page demonstrates genuine, specific local presence — not just city-name insertion.

Two problems solved simultaneously:
1. **Human legibility** — visitor confirms the business genuinely operates in their city
2. **Machine legibility** — search/AI systems receive specific, structured, distributed geographic signals

---

# 1️⃣ Primary City Declaration (Critical Gate)

The page MUST include city in: Title, H1, first paragraph (within first 100 words), combined with service in a single declarative statement.

Weak: "Plumbing Anaheim. Call us today."
Strong: "[Brand] provides licensed plumbing services to homeowners throughout Anaheim, CA."

Output Signals: primary_city_declared, declaration_position, declaration_status

---

# 2️⃣ Neighborhood and District Specificity

MUST include minimum 2 neighborhood/district references in sentence-level body content (not isolated lists).

SHOULD include 3–5 references distributed across the page, tied to specific service scenarios.

Weak: "We serve: Anaheim Hills, West Anaheim, Platinum Triangle"
Strong: "From older pipe systems common in West Anaheim's residential blocks to high-demand commercial properties near the Platinum Triangle, [Brand]'s technicians are equipped for every job type."

Output Signals: neighborhood_reference_count, neighborhood_depth_status (pass | needs_improvement | fail)

---

# 3️⃣ Landmark and Geographic Anchor References

SHOULD include 1–3 landmark or geographic anchor references, connected naturally to service context.

Example: "Serving properties near Disneyland Resort, Angel Stadium, and throughout surrounding Anaheim neighborhoods — [Brand] is available 24/7."

Output Signals: landmark_reference_count, landmark_accuracy_status

---

# 4️⃣ Zip Code Coverage

MUST include minimum 3 zip codes for target city in visible body content (not only schema).

Format: "[Brand] provides plumbing services across all Anaheim zip codes, including 92801, 92802, 92804, 92805, 92806, and 92807."

Output Signals: zip_code_count, zip_code_accuracy_status, zip_codes_in_visible_content

---

# 5️⃣ GBP and NAP Consistency

Page MUST use exact city name from GBP. Address (if shown) must match GBP exactly. Must not reference areas contradicting GBP service area.

Output Signals: gbp_city_match, nap_consistency_status, geo_conflict_detected

---

# 6️⃣ Geo Signal Distribution

Geographic references must appear across: Title, H1, opening paragraph, ≥2 body sections, CTA section, schema markup.

MUST NOT be confined to a single section or metadata only.

Output Signals: geo_distribution_score, zones_covered, zones_missing

---

## Geographic Legitimacy Score Calculation

```
geo_legitimacy_score = (
  primary_city_declaration  * 0.20 +
  neighborhood_specificity  * 0.25 +
  landmark_references       * 0.15 +
  zip_code_coverage         * 0.15 +
  gbp_nap_consistency       * 0.15 +
  geo_distribution          * 0.10
)
```

Pass ≥ 80 | Needs Improvement 60–79 | Fail < 60

---

# 📌 PRD Section: Hyperlocal & Near-Me Intent Engine

## Core Principle

"Near me" is not a keyword — it is a behavioral signal indicating immediacy, proximity preference, mobile context, and purchase readiness.

The engine ensures the page captures the full proximity-based query surface through geographic specificity, proximity signals, and intent alignment.

---

## Query Type Landscape

| Type | Examples | What Page Must Do |
|---|---|---|
| Pure proximity | "plumber near me" | Strong entity-location association, NAP consistency, geo signal density |
| Neighborhood-level | "plumber near anaheim hills" | Substantive sentence-level content about specific neighborhoods |
| Urgency + proximity | "emergency plumber near me open now" | Explicit availability + response time in opening block |
| Conversational/voice | "who is the best plumber near me" | Q&A-structured content directly answering conversational queries |
| Hyperlocal modifiers | "plumber near harbor boulevard anaheim" | Street, corridor, zip code, and landmark references at granular level |

---

# 1️⃣ Proximity Intent Layer

Page MUST:
- Display phone number above the fold
- Include availability language in opening block (hours, same-day, emergency)
- Use language matching the urgency register of the target keyword

| Keyword Modifier | Required Register |
|---|---|
| No modifier | Professional, available, local |
| "emergency", "now" | Immediate, fast, available right now |
| "near me" | Proximity-first, availability-first |
| "open now", "tonight" | Hours explicit, response time explicit |

Output Signals: proximity_intent_score, availability_language_present, urgency_register_match (pass | mismatch | not_applicable)

---

# 2️⃣ Neighborhood-Level Proximity Content

MUST include minimum 2 neighborhood-level proximity content blocks. Each block must contain: neighborhood name + service reference + proximity/availability signal.

Weak: "We serve Anaheim Hills and surrounding areas."
Strong: "[Brand] provides plumbing throughout Anaheim Hills, including emergency callouts along Serrano Avenue. Most Anaheim Hills jobs receive same-day dispatch."

Output Signals: neighborhood_proximity_block_count, neighborhood_proximity_depth, local_context_detected

---

# 3️⃣ Landmark and Street-Level Proximity Anchors

MUST include: minimum 1 major landmark reference, minimum 2 major street/corridor references.

Example: "From the commercial corridor along Ball Road to properties near Angel Stadium, [Brand] covers the full Anaheim service area with same-day availability."

Output Signals: landmark_proximity_count, street_level_reference_count, hyperlocal_anchor_status (pass | needs_improvement | fail)

---

# 4️⃣ Urgency + Proximity Signal Integration

MUST include: explicit hours, response time language where applicable, same-day/emergency availability in opening block.

Weak: "We offer 24/7 emergency plumbing in Anaheim."
Strong: "[Brand] provides 24/7 emergency plumbing throughout Anaheim, with technicians typically on-site within 60–90 minutes. Evening, weekend, and holiday callouts at no additional travel fee."

Output Signals: urgency_proximity_present, response_time_stated, hours_explicit, urgency_cta_present

---

# 5️⃣ Voice and Conversational Query Alignment

MUST include minimum 2 FAQ entries addressing conversational proximity queries. Each FAQ answer must contain both a geographic signal and an availability signal.

Required FAQ categories: Availability | Response time | Coverage | Emergency

Output Signals: proximity_faq_count, proximity_faq_completeness, conversational_alignment_score

---

## Near-Me Intent Score Calculation

```
nearme_intent_score = (
  proximity_intent_alignment    * 0.20 +
  neighborhood_proximity_depth  * 0.25 +
  landmark_street_anchors       * 0.15 +
  urgency_proximity_integration * 0.20 +
  conversational_alignment      * 0.10 +
  proximity_schema_completeness * 0.10
)
```

Pass ≥ 80 | Needs Improvement 60–79 | Fail < 60

**NEVER use "near me" as a literal phrase in body content.**

---

# 📌 PRD Section: Master Input Schema

## Data Collection Phases

### Phase 1: Business Setup (once per business)

**GBP Import:** business name, address, phone, website, categories, hours, place_id, service area, business type, Maps URL, rating, review count, description, reviews (4–5 stars only: reviewer first name + last initial, rating, text, date)

**Website Data (scraped/inferred):** differentiators, special offers, service list, sub-services, related services, brand voice, licensing, years in business

**Business Identity:** brand name, NAP, email, primary CTA type, secondary CTA type

**Existing Page Inventory (scraped from website):** catalogued automatically when a new location is added. Used to avoid duplicating existing content and to inform internal linking opportunities.

Three page types are identified and stored:

| Page Type | Definition | Detection Signal |
|---|---|---|
| Service pages | Pages targeting a single service with no geo modifier | URL pattern + H1 containing service name, no city |
| Location pages | Pages targeting a city/region with no specific service | URL pattern + H1 containing city name, no service |
| City + service pages | Pages targeting a specific service in a specific city | URL pattern + H1 containing both service and city |

**Scrape behavior:**
- Triggered automatically on new location save (after GBP import)
- Crawls all internal links from the homepage up to 3 levels deep
- For each discovered page: records URL, page title, H1, detected page type, primary service (if any), primary city (if any)
- Results stored in `business_profiles` as `existing_pages` (JSONB array)
- User can review, re-classify, or dismiss individual pages from the UI
- Re-scan available manually at any time from the location profile

**ICP Detection (auto, once per business):**
- Triggered immediately after website scrape completes
- LLM infers ICP from: GBP primary category + website service list + brand voice signals + detected page types
- ICP stored on `business_profiles` as `detected_icp` — user can override per page at generation time
- If multiple ICPs are plausible, all are listed with confidence scores; highest confidence is used as default

**UVP / Differentiator Extraction (auto, once per business):**
- Triggered alongside ICP detection
- LLM extracts differentiators from website copy: speed claims, pricing model, guarantees, specializations, service area, certifications
- Minimum 3 differentiators required before generation is unlocked; user prompted to add manually if fewer are found
- Stored on `business_profiles` as `differentiators` (JSONB array of `{ claim, mechanism, type }`)
- User can edit, add, or remove at any time from the location profile

### Phase 2: Per-Page Generation

**Required:** Primary keyword, Target city, Main service

**Optional (LLM fallback):** Urgency modifier, Service category, ICP type, Target word count

**Geographic Data:** Primary city (from keyword), Neighborhoods, Landmarks, Streets, Zip codes — all LLM auto-suggested if not provided, presented for user confirmation

### Word Count Rules

| Condition | Target |
|---|---|
| Page Optimizer Pro API available | Use POP recommendation |
| POP unavailable — standard service | 2,000 words max |
| POP unavailable — legal/health | No max — follow engine requirements |

### Pre-Generation Checklist

All of the following must be confirmed before generation starts and credits are deducted:
- GBP data loaded and confirmed
- GBP reviews imported
- Business name confirmed
- NAP confirmed consistent with GBP
- Primary service + sub-services confirmed
- Differentiators confirmed
- Primary keyword confirmed
- Target city confirmed
- ICP determined
- Geographic data confirmed (neighborhoods, landmarks, streets, zip codes)
- Word count target determined
- CTA type confirmed
- Hours of operation confirmed

---

# 📌 PRD Section: Content Output Specification

## Output Formats

| Format | Use Case |
|---|---|
| Rich text | Copy/paste into WordPress visual editor or any CMS |
| HTML | Copy/paste into HTML editor or page builders |

JSON-LD schema is output as a separate copyable block.

## Page Structure (13 Sections — Mandatory Order)

1. **Intro / Direct Answer Block** (Required) — declarative brand+service+location statement, primary keyword in first sentence, primary differentiator stated, phone + CTA above fold. 100–150 words.

2. **USP / Value Proposition Block** (Required) — min 3 differentiators with mechanisms, proof signal, contrast statement. 150–200 words.

3. **Special Offers** (Conditional — only if data available) — offer + terms + CTA. 50–100 words.

4. **CTA Block Primary** (Required) — differentiated language, primary differentiator, phone/booking. 50–75 words.

5. **Features and Benefits** (Required) — min 4 feature/benefit pairs, outcome-first, ICP pain points. 150–200 words.

6. **Main Service Body** (Required) — primary service section + sub-service H2/H3 subsections. Each subsection: service+city in heading, 2–4 sentence description, scenario-based sentence, differentiator/availability signal, geo reference where natural. Answer-first formatting. Each subsection independently retrievable. 600–900 words.

7. **Testimonials** (Conditional — only when ≥2 qualifying GBP reviews) — pulled from GBP only, 4–5 stars only. Selection priority: (1) mentions primary service, (2) mentions city/neighborhood, (3) references differentiator, (4) matches ICP, (5) most recent. Display: first name + last initial, star rating, date, full review text verbatim. Min 2, max 5. If <2 qualifying reviews: section omitted entirely. 100–250 words.

8. **CTA Block Secondary** (Required) — different wording from primary, different benefit angle. 50–75 words.

9. **Getting Started** (Required) — 3–5 step process, plain language, closes with CTA. 150–200 words.

10. **Local SEO / Geographic Section** (Required) — city + min 3 neighborhoods in sentence context + min 1 landmark + min 2 streets + zip codes. If storefront: driving directions from 2 local reference points. If SAB: coverage + response time. 200–300 words.

11. **CTA Block Tertiary** (Required) — urgency-forward, availability confirmed, phone. 50–75 words.

12. **FAQ** (Required) — min 6, max 10 entries. Self-contained answers. Must cover: availability, response time, coverage, emergency. 40–80 words per answer. 300–500 words total.

13. **JSON-LD Schema** (Required — delivered as separate block)

## Output Anti-Patterns (Never Generate)

- "Welcome to [Brand]" as opening
- "We are a [city] [service] company" as first sentence
- Any placeholder text (e.g., "[Insert testimonial here]")
- Fabricated reviews
- "Contact us today" as standalone CTA
- Generic headings ("About Us", "Our Services", "Why Choose Us")
- Any AI generation signals
- "near me" as literal phrase in body content

---

# 📌 PRD Section: ICP Engine

## Detection Priority

1. User-selected → use directly
2. Auto-detected → LLM infers from keyword modifier + GBP category + website + service category

## ICP Profiles

### ICP 1: Emergency Homeowner
Signals: "emergency", "urgent", "burst", "flooding", "not working", "tonight", "now"
Fears: property damage worsening, can't reach anyone, excessive emergency fees, late arrival
Tone: immediate, calm, reassuring
First sentence: must state availability and response time before anything else
CTA: "Call Now — Technician Dispatched Immediately"

### ICP 2: General Homeowner
Signals: no urgency modifier, core service keywords
Fears: overcharged, poor workmanship, unreliable scheduling, mess left behind
Tone: confident, professional, locally established
CTA: "Get a Free Estimate" / "Schedule Your Service Today"

### ICP 3: Commercial / Business
Signals: "commercial", "office", "restaurant", "retail", "industrial"
Fears: downtime, contractor no-shows, no commercial licensing, liability gaps
Tone: B2B, professional, capability-focused
CTA: "Request a Commercial Quote" / "Schedule a Site Assessment"

### ICP 4: Property Manager
Signals: "property management", "HOA", "apartment", "portfolio", "multi-unit"
Fears: vendor unreliability at scale, tenant complaints, lack of documentation, variable pricing
Tone: partnership-oriented, process-focused
CTA: "Set Up a Preferred Vendor Account"

### ICP 5: Vulnerable / Assisted Homeowner
Signals: "senior", "elderly", "accessible", "disability", "assisted living"
Fears: being taken advantage of, confusing communication, surprise charges
Tone: warm, clear, patient, trustworthy
CTA: "Call Us — We'll Walk You Through Everything"

### ICP 6: Trade / Contractor
Signals: "new construction", "renovation", "contractor", "builder", "rough-in"
Fears: delays affecting project timeline, inadequate licensing, poor site coordination
Tone: trade-to-trade, technical, schedule-focused
CTA: "Get a Project Quote" / "Discuss Your Build Timeline"

### ICP 7: Landlord / Rental Owner
Signals: "landlord", "rental property", "tenant", "investment property"
Fears: tenant complaints, overpriced repairs, unreliable contractors
Tone: practical, value-focused, reliability-led
CTA: "Book a Rental Property Service Call" / "Get a Landlord Rate"

---

# 📌 PRD Section: Master Composite Score

## Engine Weights

| Engine | Weight | Rationale |
|---|---|---|
| Organic Ranking | 20% | Baseline — all others depend on this passing |
| GBP / Maps Relevance | 25% | Maps visibility is primary local battleground |
| Entity Establishment | 15% | Long-term ranking stability |
| ICP Alignment | 10% | Conversion impact |
| AEO / LLM Retrieval | 10% | Future-proofing |
| Geographic Legitimacy | 10% | Supports both Maps and organic |
| Hyperlocal / Near-Me | 10% | Reinforces Maps weighting |

Note: GBP/Maps + Near-Me together = 35% — Maps-heavy weighting is intentional.

## Score Output

| Range | Status | Display |
|---|---|---|
| 90–100 | ✅ Excellent | Publish-ready — strong across all engines |
| 80–89 | ✅ Good | Publish-ready — minor improvements available |
| 70–79 | ⚠️ Needs Improvement | Publishable but with identified weaknesses |
| 60–69 | ⚠️ Below Standard | Do not publish without addressing deficiencies |
| 0–59 | ❌ Fail | Significant rework required |

## Actionable Recommendations Format

For every engine scoring below 80, generate specific recommendations (not generic advice):

```
Engine: Geographic Legitimacy Engine — 64/100
Issues detected:
→ Only 1 neighborhood reference found — minimum 2 required
→ No landmark references detected
Recommended fixes:
→ Add references to [Neighborhood A] and [Neighborhood B] within service content
→ Reference [Landmark] as a proximity anchor in the intro or local SEO section
```

---

# 📌 PRD Section: App Modes

## Mode 1: Generate Mode

User flow:
1. Select "Create New Page"
2. Business search (Google Places autocomplete) → GBP confirmation
3. Business Profile Setup (skip if done before): site scan → differentiators → services → CTA preferences
4. Page inputs: required fields + optional fields + geographic data
5. Pre-generation checklist confirmed
6. Click "Generate Page" → deduct credit → loading screen
7. Complete page displayed
8. Auto: email sent + page saved
9. Options: [Improve] [Generate Another] [View My Pages]

Session persistence: business data saved after first GBP import, pre-populated on subsequent sessions.

## Mode 2: Audit Mode

Input options: URL (server-side fetch) | Plain text (content signals only) | HTML (full signals)
Optional: GBP selection (for NAP checks) + target keyword (for intent evaluation)
Flow: input → [Run Audit] → deduct credit → loading → results (score + breakdown + deficiency list)
Output: saved as Page Record (mode = audit). No email sent.
Transition: [Rewrite to Fix Issues] → Improve Mode (costs 1 credit)

## Mode 3: Improve Mode

Entry: from Generate Mode or Audit Mode
Flow:
1. Page + deficiency list displayed
2. [Fix All] or [Fix Selected]
3. Only deficient sections rewritten in background
4. Highlighted rewrites: [Accept] [Reject] [Regenerate This Section] (no credit for section regen)
5. Final rescore → new composite score
6. Copy + email + save

Original always preserved. Improve creates new record with incremented version number.

---

# 📌 PRD Section: Schema Output Specification

## Schema Types

Auto-detect business subtype from GBP primary category → schema.org LocalBusiness subtype. Fall back to `LocalBusiness`.

Key mappings: Plumber → `Plumber` | HVAC → `HVACBusiness` | Electrician → `Electrician` | Locksmith → `Locksmith` | Roofing → `RoofingContractor`

## Three Schema Blocks Per Page

**1. LocalBusiness schema** — name (exact GBP match), url, telephone (exact GBP), address, geo coordinates, hasMap, openingHoursSpecification (exact GBP hours), areaServed (target city), serviceArea, aggregateRating, description, sameAs (GBP URL)

**2. Service schema** — serviceType, provider (business name + type), areaServed, description (generated from page content), availableChannel (phone contact point)

**3. FAQPage schema** — auto-extracted from generated FAQ section, no manual entry required

## Schema Generation Behavior

All fields auto-populated from input schema data. User reviews in collapsed panel before finalization.

Consistency checks before finalizing:
- Business name, phone, address must match GBP exactly
- areaServed city must match target keyword city
- openingHoursSpecification must match GBP hours exactly
- Conflicts flagged with side-by-side values shown

---

# 📌 PRD Section: Core User Journey

## Database Record Structure

Every page saved contains: page_id, user_id, business_id, target_keyword, target_city, icp_type, mode, composite_score, engine_scores (JSON), content_rich_text, content_html, schema_json, deficiencies, version, created_at, updated_at

## Definition of Success

A user journey is complete and successful when:
- Composite score ≥ 80
- Page is in clipboard (rich text or HTML)
- Schema is in clipboard
- Copy has been emailed
- Copy is saved in account
- Page is ready to paste into CMS and publish with no additional formatting

---

# 📌 Master PRD Addendum

## Addendum A: Audit Mode (Complete)

See SPEC.md Section 4 for full user flow. Key additions:
- URL fetch is server-side. On failure: offer paste fallback (HTML or plain text).
- Plain text audits note that structural signals are unavailable.
- Audit records saved to My Pages but no email sent.
- Transitioning to Improve Mode requires full HTML — prompt user to paste if audit was URL or plain text only.

## Addendum B: Account and Settings

See SPEC.md Section 9 for full specification.

## Addendum C: In-App Help

See SPEC.md Section 10 for full specification.

## Addendum D: Credit System

| Action | Credit Cost |
|---|---|
| Generate Mode | 1 credit |
| Audit Mode | 1 credit |
| Improve Mode | 1 credit |
| Below-threshold regeneration | 1 additional credit |
| Section regeneration in Improve Mode | 0 credits |

Deducted at start of action. Refunded automatically on failure. Balance displayed persistently. 0 credits → actions disabled.

Pricing, starting balance, and plan tiers: not defined — commercial decisions. All values in config, never hardcoded.

## Addendum E: Real-World Success Tracking

Out of scope. The app does not track whether published pages rank. Users use Google Search Console.

## Addendum F: Non-Goals (Explicit Scope Exclusions)

Not in v1: publishing to CMS, ranking tracking, keyword research, competitor analysis, team accounts, client management, social media/content distribution, CRM/lead tracking, backlink analysis, AI image generation.

## Addendum G: Open Items Pending Future Decisions

| Item | Decision Needed |
|---|---|
| Credit pricing | Price per credit, starting balance, plan tiers |
| Credit purchase flow | Payment provider, purchase UX |
| Team / multi-user | Scope, roles, pricing model |
| Password strength requirements | Minimum length, character requirements |
| Email verification token expiry | How long pending email change stays active |
| Soft-deleted record retention | How long before permanent purge |
