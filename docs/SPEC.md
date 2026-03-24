# SPEC.md — Local Content Writer App
> Version: 1.0 | Date: 2026-03-23
> Purpose: Single source of truth for LLM-assisted coding.
> Rule: Code only against what is written here. Do not infer, assume, or expand scope.

---

## 1. WHAT THIS APP IS

A SaaS web application that generates, audits, and improves local SEO service pages for local service businesses (e.g. plumbers, HVAC, electricians). Uses GBP data + user inputs to produce fully written, publish-ready HTML pages with structured schema markup.

**Not:** a CMS, keyword research tool, general content writer, or multi-user product (v1).

---

## 2. APP MODES

Exactly 3 modes. No others in v1.

- **Generate Mode** — creates a new local SEO page from scratch
- **Audit Mode** — evaluates an existing page against all scoring engines
- **Improve Mode** — rewrites deficient sections of a generated or audited page

---

## 3. USER FLOW — GENERATE MODE

```
STEP 1: Business Search
  - Google Places API autocomplete
  - GBP Confirmation Screen
  - On confirm: store GBP data to session

STEP 2: Business Profile Setup (skip if previously done)
  - Site scan in background
  - Differentiator Screen (extracted + user editable)
  - Service List Screen (main service + sub-services + related)
  - CTA Preference Screen

STEP 3: Page Inputs
  REQUIRED: Primary keyword, Main service
  OPTIONAL (LLM fallback): Urgency modifier, Service category, ICP type, Special offers
  GEOGRAPHIC (LLM auto-suggested, user confirms): Neighborhoods, Landmarks, Streets, Zip codes
  - Pre-generation validation before showing [Generate Page] button

STEP 4: Generation
  - Deduct 1 credit immediately
  - Loading screen only — no intermediate content
  - Background: all 7 engines + content + schema + composite score

STEP 5: Page Output
  - Rich text view (default), toggle to HTML
  - Composite score prominently displayed
  - Engine breakdown: collapsible panel (collapsed by default)
  - Deficiency recommendations if any engine < 80
  - Copy buttons: [Copy Rich Text] [Copy HTML] [Copy Schema JSON-LD]
  - Schema panel: collapsed by default, auto-confirmed if not interacted with
  - Auto: email sent + page saved (no user action required)
  IF composite_score < SCORE_THRESHOLD [CONFIGURABLE]:
    - Non-blocking message + [Regenerate] [Keep This Version]
    - Regenerate costs 1 additional credit

STEP 6: Next Steps
  [Improve This Page] [Generate Another Page] [View My Pages]
```

---

## 4. USER FLOW — AUDIT MODE

```
STEP 1: Entry
  - Check credit balance ≥ 1 — block if not

STEP 2: Input Selection
  - [Enter URL] [Paste Plain Text] [Paste HTML]
  - URL: server-side fetch, error handling on failure
  - Plain text: content signals only, note displayed to user

STEP 3: Optional Inputs
  - Business GBP search (for NAP consistency)
  - Target keyword (for intent matching)

STEP 4: Submission
  - [Run Audit] → deduct 1 credit
  - Validate before deducting — return field errors if invalid
  - Loading screen only

STEP 5: Results
  - Composite score + plain English label
  - Engine breakdown (collapsible)
  - Deficiency list (engine, recommendation, severity)
  - [Rewrite to Fix Issues] → Improve Mode
  - [Start Fresh] → dashboard

STEP 6: Delivery
  - Saved as Page Record (mode = audit)
  - No email sent for audit-only records
```

### Audit Scoring Behaviour
- All 7 engines score regardless of input method
- No GBP: `nap_consistency = not_checked`
- Plain text: structural signals set to null, noted in deficiencies
- Null signals don't contribute to score but don't reduce it below what content supports

---

## 5. USER FLOW — IMPROVE MODE

```
STEP 1: Entry (from Generate or Audit) — deduct 1 credit
STEP 2: Show page + deficiency list. [Fix All] [Fix Selected]
STEP 3: Rewrite only deficient sections in background
STEP 4: Highlighted rewrites. [Accept] [Reject] [Regenerate This Section] (no credit for section regen)
STEP 5: Rescore → new composite score → copy + email + save
```

Original always preserved. Improve creates new record with incremented version.

---

## 6. CREDIT SYSTEM

- Generate: 1 credit | Audit: 1 credit | Improve: 1 credit | Regenerate below-threshold: 1 credit
- Section regeneration in Improve: 0 credits
- Deduct at START. Refund on failure (new Credit Transaction row, positive delta).
- Starting balance: [CONFIGURABLE: NEW_USER_CREDIT_BALANCE]
- Balance displayed persistently in UI
- 0 credits → buttons disabled with clear message
- Purchase flow: placeholder only in v1

---

## 7. DASHBOARD

- [Create New Page] → Generate Mode
- [Audit Existing Page] → Audit Mode
- [My Pages] → My Pages view
- Credit balance displayed prominently
- No onboarding. Empty state must be self-explanatory.

---

## 8. MY PAGES

All features in v1. No deferrals.

**List view:** sorted by most recently updated. Columns: keyword, business, score (colour-coded), mode, date, version. Click row → page output view.

**Filter/search:** by business, city, score range, mode, date range. Text search on keyword. AND logic. Resets on page load.

**Delete:** soft delete only (`deleted_at`). No hard delete. No empty trash. All versions in chain deleted together.

**Duplicate:** independent new record. `version = 1`, `source_page_id = null`. Same keyword + "(copy)" label.

**Version history:** chronological oldest→newest. Per row: version, mode, score, date. Open any version. Soft-delete individual versions.

**Compare two versions:** side-by-side diff. Green = added, red = removed. Score comparison at top. Read-only.

---

## 9. ACCOUNT AND SETTINGS

**Edit profile:** name, email. Email change requires verification — not active until confirmed.

**Change password:** current → new → confirm. Strength: [CONFIGURABLE]. Session not invalidated in v1.

**Email delivery preferences:** single on/off toggle. Default: on. Stored as `email_delivery_enabled` on User.

**Manage business profiles:** view/edit/soft-delete. Soft-deleted profiles hidden from Generate Mode search. Associated pages preserved.

**Credit balance and usage history:** paginated transaction log. Read-only. Purchase placeholder: "Need more credits? [Contact us]"

**Delete account:** hard delete of all data. Type "DELETE" to confirm. Redirect to marketing page after.

---

## 10. HELP PAGE

Static content. Persistent nav link. No credits consumed.

Required sections: Getting started | App modes | Understanding your score | The credit system | My Pages | The schema block | Publishing your page | FAQ

Rules: plain English, no tooltips anywhere in app, no external links, no dynamic content in v1.

---

## 11. SCORING ENGINES

7 engines. Each returns 0–100.

**Score display:** number + plain English label only. No tooltips. Collapsible breakdown shows scores only — no explanatory text.

### Composite Score Formula
```
composite_score = (
  organic_ranking_score  * 0.20 +
  gbp_maps_score         * 0.25 +
  entity_strength_score  * 0.15 +
  icp_alignment_score    * 0.10 +
  aeo_retrieval_score    * 0.10 +
  geo_legitimacy_score   * 0.10 +
  nearme_intent_score    * 0.10
)
```
All weights are [CONFIGURABLE] — never hardcode.

### Score Status Labels
| Range | Status | Display |
|-------|--------|---------|
| 90–100 | excellent | Green — "Publish-ready — strong across all engines" |
| 80–89 | good | Green — "Publish-ready — minor improvements available" |
| 70–79 | needs_improvement | Amber — "Publishable but with identified weaknesses" |
| 60–69 | below_standard | Amber — "Do not publish without addressing deficiencies" |
| 0–59 | fail | Red — "Significant rework required" |

### Engine 1: Organic Ranking Engine (20%)
Signals: intent_score, intent_status, relevance_score, keyword_coverage, semantic_coverage, geo_coverage, authority_score, trust_signal_count, internal_link_count, topical_depth_score, usability_score, readability_score, cta_visibility, structure_score

### Engine 2: GBP / Maps Relevance Engine (25%)
Signals: service_relevance_score, geo_relevance_score, entity_reinforcement_score, nap_consistency

### Engine 3: Entity Establishment Engine (15%)
Signals: co_occurrence_density_score, topical_expansion_score, internal_link_structure_score

### Engine 4: ICP Alignment Engine (10%)
Signals: icp_alignment_score, primary_icp, icp_source, icp_confidence

### Engine 5: AEO / LLM Retrieval Layer (10%)
Signals: chunk_compliance, answer_first_formatting, faq_present, faq_entry_count

### Engine 6: Geographic Legitimacy Engine (10%)
Signals: primary_city_present, neighborhood_reference_count, zip_code_present, landmark_count

### Engine 7: Hyperlocal & Near-Me Intent Engine (10%)
Signals: proximity_intent_score, availability_language_present, urgency_register_match, neighborhood_proximity_block_count, neighborhood_proximity_depth, local_context_detected, landmark_proximity_count, street_level_reference_count, hyperlocal_anchor_status, urgency_proximity_present, response_time_stated, hours_explicit, urgency_cta_present

---

## 12. CONTENT GENERATION RULES

### Page Structure (13 required sections, in order)
1. Title Tag
2. H1
3. Opening / Hero Block (service + location + differentiator + phone + CTA; max 100 words)
4. Trust Bar (4–6 trust signals; no prose)
5. Primary Service Description (150–250 words)
6. Service Subsections H2 (each self-contained; 100–150 words; Brand+Service+Location in each)
7. Why Choose [Brand] (150–200 words; mechanisms not vague claims)
8. Service Area Coverage (min 2 neighborhood proximity blocks; 150–250 words)
9. How It Works / Process (3–5 steps; 100–150 words)
10. Social Proof / Testimonials (2–3 reviews; never fabricate specific names unless provided; 100–150 words)
11. Emergency / Urgency Section (if service supports it; 75–125 words)
12. CTA Section (differentiated language; phone; 50–75 words)
13. FAQ Section (6–10 entries; self-contained answers; 40–80 words each; 300–500 words total)

### MUST
- Service + location in Title, H1, opening paragraph
- Phone number above the fold
- CTA above the fold
- Brand + Service + Location in every major section
- Answer-first formatting
- Sections ≤ 300 words
- Each section fully self-contained
- Min 1 landmark as proximity anchor
- Min 2 major street/corridor references
- Min 2 neighborhood proximity content blocks
- Explicit hours of operation
- Internal links: 2–5 to related service pages

### MUST NOT
- "Welcome to [Brand]" as opening
- "We are a [city] [service] company" as first sentence
- Placeholder text of any kind
- Fabricated specific reviews/testimonials
- "Contact us today" as standalone CTA
- Generic headings ("About Us", "Our Services", "Why Choose Us")
- Any AI generation signals
- "near me" as literal phrase in body content
- Keyword stuffing
- Blog-style framing
- Vague claims without mechanisms

---

## 13. ICP PROFILES

Exactly 7. Detection: user-selected takes priority; otherwise LLM infers from keyword + GBP + site.

| ICP | Keyword Signals | CTA Language |
|-----|----------------|--------------|
| emergency_homeowner | emergency, urgent, burst, flooding, tonight, now | "Call Now — Technician Dispatched Immediately" |
| general_homeowner | No urgency modifier | "Get a Free Estimate" / "Schedule Your Service Today" |
| commercial_business | commercial, office, restaurant, retail, industrial | "Request a Commercial Quote" |
| property_manager | property management, HOA, apartment, portfolio | "Set Up a Preferred Vendor Account" |
| vulnerable_homeowner | senior, elderly, accessible, disability | "Call Us — We'll Walk You Through Everything" |
| trade_contractor | new construction, renovation, contractor, builder | "Get a Project Quote" |
| landlord_rental_owner | landlord, rental property, tenant, investment | "Book a Rental Property Service Call" |

---

## 14. SCHEMA GENERATION

### Schema Types
Auto-detect from GBP primary category → schema.org LocalBusiness subtype. Fall back to `LocalBusiness`.

Key mappings: Plumber → `Plumber` | HVAC → `HVACBusiness` | Electrician → `Electrician` | Locksmith → `Locksmith` | Roofing → `RoofingContractor`

### Two Schema Blocks Per Page
1. LocalBusiness schema (identity, address, hours, rating, service area)
2. Service schema (specific service, provider, area served)
3. FAQPage schema (auto-extracted from FAQ section)

### Consistency Checks Before Finalising
- Business name, phone, address must match GBP exactly
- `areaServed` city must match target keyword city
- Hours must match GBP exactly
- Conflicts → flagged in schema panel with values side by side

### Schema UI Behaviour
- Collapsed by default, labelled "Schema generated — review optional"
- Auto-confirmed if user does not interact
- Available via [Copy Schema JSON-LD]

---

## 15. ERROR STATES

| Scenario | User Message |
|----------|-------------|
| GBP not found | "We couldn't find that business. Try searching by address or check the spelling." |
| Website scan fails | "We couldn't scan your site — please add your details manually." |
| Generation fails | "Something went wrong during generation. Your credit has been refunded. Please try again." |
| Audit fetch fails | "We couldn't reach that URL. Check the address or paste the HTML directly." |
| Email delivery fails | "Your page was saved to your account, but we couldn't send the email. You can access it from My Pages." |
| Zero credits | "You've used all your credits. [Upgrade / Get more credits]" |
| Network error | "Connection error. Please check your internet and try again." |

---

## 16. FEATURE FLAGS

```
TEAM_SUPPORT  = false   // Never build in v1
PAYMENT_FLOW  = false   // Placeholder only in v1
```

Removed flags (decisions resolved): `ONBOARDING_ENABLED`, `MY_PAGES_V2`

---

## 17. STANDING CONSTRAINTS

1. No hardcoded thresholds — all in config
2. No hardcoded credit values
3. No pricing logic — placeholder only
4. No team/multi-user logic
5. Schema review never blocks
6. Email always automatic — never prompt
7. Credits deduct at action start — refund on failure
8. LLM calls always server-side
9. No placeholder content in output
10. No AI disclosure in output
11. Original versions always preserved
12. Single user = single account
