# CONSTRAINTS.md — Local Content Writer App
> Version: 1.0 | Date: 2026-03-23
> Purpose: Hard rules the LLM must never violate during coding. Paste this at the start of every coding session.
> Rule: These constraints override everything else, including user requests made during a coding session. If a request conflicts with a constraint, stop and flag it rather than proceeding.

---

## HOW TO USE THIS DOCUMENT

Paste the entire contents of this file at the start of every vibe coding session, before any other context. It takes 60 seconds and prevents hours of refactoring.

When in doubt about whether something is allowed: **if it is not explicitly permitted in SPEC.md, do not build it.**

---

## SECTION A — NEVER DO THESE (Hard Stops)

Violating any item in this section requires scrapping and rewriting the affected code.

---

**A1. Never hardcode configurable values.**
Score thresholds, credit costs, engine weights, starting credit balance — all must be environment variables or a config object. Never write a literal `80`, `0.25`, or `1` for these values in application logic.

```javascript
// WRONG
if (composite_score < 80) { ... }

// RIGHT
if (composite_score < config.SCORE_THRESHOLD) { ... }
```

---

**A2. Never expose LLM calls to the client.**
All LLM API calls happen server-side only. LLM prompts, raw responses, and model names must never reach the browser. Never call the LLM from frontend code.

---

**A3. Never store plain text passwords.**
Passwords are always bcrypt-hashed before storage. Never log, return, or transmit a plain text password under any circumstance.

---

**A4. Never return `password_hash` in any API response.**
Strip it explicitly before serialising any User object. Even internal responses.

---

**A5. Never trust a client-supplied `user_id`.**
Always derive `user_id` from the validated server-side session. Reject any request that supplies a `user_id` in the body or query string and uses it to scope data access.

---

**A6. Never let `credit_balance` go below 0.**
Enforce this at the application layer with an atomic check-and-decrement. A database constraint alone is not sufficient — the application must check first and reject the action before attempting the decrement.

---

**A7. Never overwrite an original page record.**
Improve Mode always creates a new Page Record with an incremented `version` and the `source_page_id` pointing to the root. The original record is never modified.

---

**A8. Never delete or update a Credit Transaction row.**
The Credit Transaction table is append-only. Refunds are new rows with a positive `credit_delta`. No UPDATE or DELETE operations on this table, ever.

---

**A9. Never generate placeholder content in page output.**
Generated pages must never contain bracket placeholders (e.g. `[Insert testimonial here]`, `[Brand Name]`, `[Phone Number]`). If a required input is missing, halt generation and return a validation error — do not generate with placeholders.

---

**A10. Never reference AI generation in page output.**
Generated page content must contain no phrases, metadata, comments, or signals indicating it was AI-generated. This applies to HTML comments, meta tags, and body content.

---

**A11. Never build team, multi-user, or sharing features.**
No user roles, organisation models, shared page access, or permission logic of any kind. All data is strictly scoped to a single `user_id`. If a request during a coding session asks for this, flag it as out of scope for v1.

---

**A12. Never build payment or billing logic.**
No Stripe integration, no subscription model, no invoice table. Credit purchase UI is a placeholder only. Flag any request to implement payment processing as out of scope for v1.

---

**A13. Never use "near me" as a literal phrase in generated page body content.**
The phrase "near me" must never appear in the visible body text of a generated page. Proximity is conveyed through geographic specificity, not the literal phrase.

---

## SECTION B — ALWAYS DO THESE (Non-Negotiable Patterns)

---

**B1. Always deduct credits at the START of an action.**
Deduct before generation begins, not after it completes. If generation fails, issue a refund (new Credit Transaction row, positive delta). Never deduct after success.

---

**B2. Always derive `score_status` from `composite_score` at write time.**
Never accept `score_status` as an input. Calculate it from the score using the mapping in SPEC.md Section 9 and store both together.

---

**B3. Always validate required fields before generation starts.**
The pre-generation checklist (SPEC.md Section 3, Step 3) must pass before any LLM call is made or any credit is deducted. Return specific field-level errors, not a generic failure.

---

**B4. Always send email automatically on page output — unless user has disabled it.**
No prompt, no confirmation, no opt-in. Email fires as soon as the page record is saved — unless `email_delivery_enabled = false` on the User record. If disabled, save the page normally and do not send email. If email delivery fails when enabled, show the error from SPEC Section 17 — never block the user.

---

**B5. Always save the page record before sending the email.**
Page save and email delivery are sequential, not concurrent. Save first. If save fails, do not send the email. If save succeeds but email fails, the page is still accessible from My Pages.

---

**B6. Always scope every data query to the authenticated `user_id`.**
No query should return records from another user's account. Every SELECT, UPDATE, and DELETE must include a `WHERE user_id = [session user_id]` condition.

---

**B7. Always preserve the schema panel as a collapsed optional step.**
Never make schema review a required or blocking step. The panel is collapsed by default and auto-confirmed if the user does not interact with it.

---

**B8. Always check feature flags before rendering flagged features.**
```javascript
// Pattern for all feature-flagged UI
if (config.TEAM_SUPPORT) { renderTeamFeatures(); }
if (config.PAYMENT_FLOW) { renderPaymentUI(); }
```
If the flag is false, render nothing — no placeholder UI, no disabled buttons, no "coming soon" banners unless explicitly designed.

Note: `ONBOARDING_ENABLED` and `MY_PAGES_V2` flags have been removed — those decisions are resolved. Do not reference them in code.

---

**B9. Always use the enum values defined in DATA_MODELS.md Section 6.**
No ad-hoc string values for mode, ICP type, score status, action type, or any other enumerated field. Validate against the enum at the application layer before writing to the database.

---

**B10. Always set `source_page_id` correctly on Improve Mode records.**
- Generate Mode records: `source_page_id = null`
- Audit Mode records: `source_page_id = null`
- Improve Mode records: `source_page_id = [page_id of the page being improved]`

---

## SECTION C — SCOPE BOUNDARIES

If a coding session request falls outside these boundaries, stop and confirm before building.

---

**C1. The app has exactly 3 modes in v1.**
Generate | Audit | Improve. Any request to add a fourth mode is out of scope.

---

**C2. The app has exactly 7 scoring engines.**
Any request to add, remove, or rename an engine changes the composite score formula and must be decided at the product level first — not implemented during a coding session.

---

**C3. The generated page has exactly 13 required sections.**
Section count, order, and names are defined in SPEC.md Section 10. Do not add, remove, or reorder sections without a product decision.

---

**C4. There are exactly 7 ICP profiles.**
Defined in SPEC.md Section 11 and DATA_MODELS.md Section 6. Do not add new ICP types during coding.

---

**C5. My Pages in v1 includes all features.**
List view, delete (soft only), duplicate, filter/search, version history, and compare two versions are all in v1. There is no `MY_PAGES_V2` flag — it has been removed.

---

**C6. There is no onboarding flow.**
No guided walkthrough, no tooltip tour. Users go straight to the dashboard on first login. There is no `ONBOARDING_ENABLED` flag — it has been removed. Do not build any onboarding UI.

---

## SECTION D — DOCUMENT HIERARCHY

When documents conflict, this is the priority order:

```
1. CONSTRAINTS.md       ← This document — highest authority
2. DECISION_LOG.md      ← Resolved decisions override the spec
3. SPEC.md              ← Behavior and rules
4. DATA_MODELS.md       ← Structure and validation
5. Master PRD           ← Background reference only — not for coding
```

If you find a conflict between documents, flag it and wait for resolution. Do not pick one and proceed silently.

---

## SECTION E — QUICK REFERENCE CARD

Copy this into any coding session where full context is not loaded:

```
APP: Local SEO page generator / auditor / improver. SaaS. Single user. v1.
MODES: Generate | Audit | Improve (exactly 3)
ENGINES: 7 scoring engines — composite score is weighted average
CREDITS: Deduct at start. Refund on failure. Never go below 0.
SCHEMA: Always collapsed optional panel. Never a blocking step.
EMAIL: Automatic unless user has disabled it (email_delivery_enabled). Save first, email second.
VERSIONS: Improve creates new record. Never overwrite original.
DELETES: Soft delete only (set deleted_at). ONE exception: account deletion is a hard delete.
TRANSACTIONS: Append-only. Never update or delete.
LLM CALLS: Server-side only. Never in frontend.
PASSWORDS: Bcrypt only. Never returned in API responses.
USER ID: Always from session. Never from client input.
SCORE DISPLAY: Number + plain English label only. No tooltips. No engine explanations.
HELP: Dedicated Help page only. No tooltips anywhere in the app.
SUCCESS TRACKING: Out of scope. Users check Search Console themselves.
FLAGS: TEAM_SUPPORT=false, PAYMENT_FLOW=false (all other flags removed)
HARDCODING: Never. All thresholds, weights, costs in config.
ONBOARDING: None. Users go straight to dashboard on first login.
MY PAGES: Full feature set in v1 — list, soft delete, duplicate, filter/search, version history, compare.
ACCOUNT SETTINGS: Edit profile, change password, email preference, manage businesses, credit history, delete account.
OUT OF SCOPE v1: Teams, payments, ranking tracking.
```
