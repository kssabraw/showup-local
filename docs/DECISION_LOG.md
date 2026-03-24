# Decision Log — Local Content Writer App
> Last updated: 2026-03-23
> Purpose: Resolved and unresolved product decisions for use as LLM coding reference.
> Rule: The LLM codes only against RESOLVED decisions. OPEN items must be decided before coding that feature begins.

---

## How to use this document

- **RESOLVED** = decision is final. Code against it.
- **OPEN** = decision is pending. Do not build this feature until resolved. Use a placeholder or skip entirely.
- When an OPEN item is decided, update status to RESOLVED and add the decision before continuing.

---

## Decision Index

| # | Topic | Status |
|---|-------|--------|
| 1 | Schema review screen timing | RESOLVED |
| 2 | Email delivery of finished page | RESOLVED |
| 3 | Page generation limits | RESOLVED |
| 4 | Multi-user / team support (v1) | RESOLVED |
| 5 | Below-threshold content handling | RESOLVED |
| 6 | Onboarding for new users | RESOLVED |
| 7 | My Pages — v1 scope | RESOLVED |
| 8 | Real-world success tracking | RESOLVED |
| 9 | Account and settings — v1 scope | RESOLVED |
| 10 | Score communication | RESOLVED |
| 11 | In-app help and guidance | RESOLVED |
| 12 | Audit Mode depth | RESOLVED |

---

## Resolved Decisions

---

### Decision 1 — Schema review screen timing
**Status:** RESOLVED

**Decision:** Schema review appears as a collapsed, optional step AFTER the page is revealed to the user.

**Implementation rules:**
- Page content is displayed first, always
- Schema review panel is collapsed by default below the page output
- User can expand it to review and edit schema fields
- A visible but unobtrusive prompt should indicate schema is ready to review (e.g. "Schema generated — review optional")
- User does not need to interact with schema to proceed — it is auto-confirmed if left collapsed
- Schema is finalized and included in email and database record regardless of whether user reviewed it

**What this replaces:** The original spec required a full Schema Review Screen before the page was shown. That is now removed.

---

### Decision 2 — Email delivery of finished page
**Status:** RESOLVED

**Decision:** Email is sent automatically upon page generation completion. No user action required.

**Implementation rules:**
- Email is triggered automatically when a page reaches the output step
- Email is sent to the account email address on file
- Email contains all three formats as attachments: rich text, HTML, schema JSON-LD
- No opt-in prompt is shown during generation flow
- User cannot cancel or delay the email from within the generation flow
- Email preference settings (on/off) may be added to account settings in a future iteration — not in v1

**Note:** Because email is automatic, the account setup flow must capture and confirm a valid email address before the user can generate their first page.

---

### Decision 3 — Page generation limits
**Status:** RESOLVED

**Decision:** Credit-based system. Users have a credit balance that is consumed per generation action.

**Implementation rules:**
- Each page generation (Generate Mode) costs 1 credit
- Each Audit (Audit Mode) costs 1 credit
- Each Improve run (Improve Mode) costs 1 credit
- Credit balance is displayed persistently in the UI (header or sidebar)
- User cannot initiate a generation action with 0 credits — action button is disabled with a clear message
- Credit top-up / purchase flow is required but the payment implementation detail is a future decision
- Starting credit balance for new users is TBD — treat as a configurable value, not a hardcoded number
- Credit deduction happens at the point of generation start, not at output

**What is NOT decided yet:** Pricing per credit, free tier allotment, plan tiers. Do not hardcode any of these values. Use config variables.

---

### Decision 4 — Multi-user / team support (v1)
**Status:** RESOLVED

**Decision:** Single user only. No team or multi-user features in v1.

**Implementation rules:**
- One account = one user
- No user roles, permissions, or sharing features
- No client management or workspace concept
- Database schema should not be designed to block multi-user later, but no UI or logic for it now
- All pages and business profiles are scoped to the individual user account

---

### Decision 5 — Below-threshold content handling
**Status:** RESOLVED

**Decision:** If generated content scores below the threshold (composite score < 80), the app asks the user if they want to regenerate.

**Implementation rules:**
- Threshold is composite score < 80
- Page is shown to the user regardless of score
- A clear, non-blocking message is displayed when score < 80 (e.g. "This page scored 72/100 — would you like to regenerate for a better result?")
- User is presented with two options: [Regenerate] [Keep This Version]
- If user selects Regenerate: a new generation runs, consuming 1 additional credit, and replaces the current output
- If user selects Keep This Version: page proceeds to delivery (email + save) as normal
- The below-threshold message must not block the user from copying or saving their content
- Score threshold of 80 is configurable, not hardcoded

---

### Decision 6 — Onboarding for new users
**Status:** RESOLVED

**Decision:** No onboarding walkthrough. New users land directly on the dashboard on first login. The UI is expected to be self-explanatory.

**Implementation rules:**
- No guided walkthrough screens
- No tooltip tour
- No onboarding-specific UI of any kind
- New users see the same dashboard as returning users
- Empty state on the dashboard must be self-explanatory (e.g. clear labels on the three action buttons, brief descriptor text under each)
- The `ONBOARDING_ENABLED` feature flag is removed — it is no longer needed
- If onboarding is ever added in a future version, it will be designed from scratch at that time

**What this means for coding:** Remove the `ONBOARDING_ENABLED` feature flag from the codebase entirely. Do not leave it as a dead flag.

---

### Decision 7 — My Pages — v1 scope
**Status:** RESOLVED

**Decision:** My Pages includes the full feature set in v1. No features are deferred.

**Full v1 feature list:**
- List view with composite scores
- Version history per page (view all versions in a page's history)
- Delete pages (soft delete — page is hidden from list but data is preserved)
- Duplicate a page (creates a new independent page record from an existing one)
- Filter and search (filter by business, keyword, score, date; search by keyword)
- Compare two versions (side-by-side diff of any two versions in a page's history)

**Implementation rules:**

**List view:**
- Sorted by most recently updated by default
- Each row shows: target keyword, business name, composite score (with colour), mode, date, version number
- Clicking a row opens the page output view for that record

**Delete:**
- Soft delete only — sets `deleted_at` timestamp, hides from list view
- Deleted pages are NOT permanently removed in v1
- No "empty trash" or permanent delete in v1
- Deleted pages do not count toward any limits

**Duplicate:**
- Creates a brand new Page Record with the same content, keyword, and business
- New record gets: new `page_id`, `version = 1`, `source_page_id = null`, new timestamps
- Duplicate is independent — improving or deleting the original does not affect the duplicate
- Duplicate appears in the list as a new entry labelled with the same keyword + "(copy)"

**Filter and search:**
- Filter options: by business name, by target city, by score range, by mode (generate/audit/improve), by date range
- Search: text search across target keyword field
- Filters and search are combined (AND logic)
- Filter state is not persisted between sessions — resets on page load

**Version history:**
- Accessible from any page record in the list
- Shows all versions in chronological order (oldest to newest)
- Each version row shows: version number, mode, composite score, date
- User can open any version in the page output view
- User can delete individual versions (soft delete, same rules as above)

**Compare two versions:**
- User selects any two versions from a page's version history
- Side-by-side diff view showing content differences
- Score comparison shown at the top (version A score vs version B score)
- Diff highlights added content (green) and removed content (red)

**`MY_PAGES_V2` feature flag is removed** — it is no longer needed. All My Pages features are in v1.

---

### Decision 8 — Real-world success tracking
**Status:** RESOLVED

**Decision:** Out of scope. The app does not track whether published pages ranked. Users check Google Search Console themselves.

**Implementation rules:**
- No ranking check API integration
- No follow-up prompts or notifications about page performance
- No "did this rank?" UI of any kind
- If a user asks about ranking within the app, that is outside the product's scope

---

### Decision 9 — Account and settings — v1 scope
**Status:** RESOLVED

**Decision:** Account settings includes the following features in v1.

**Feature list:**
- Edit profile (name and email address)
- Change password
- Email delivery preferences (toggle automatic email on or off per account)
- Manage saved business profiles (edit details, soft delete a profile)
- Credit balance and usage history (view current balance and full transaction log)
- Delete account (permanent — requires confirmation)

**Implementation rules:**

**Edit profile:**
- User can update their name and email address
- Changing email requires re-confirmation via a verification email to the new address
- Email is not changed until the new address is confirmed

**Change password:**
- Standard current password → new password → confirm new password flow
- New password must meet minimum strength requirements (define in config)
- Session is not invalidated after password change in v1

**Email delivery preferences:**
- Single toggle: automatic email on / off
- Default: on
- When off: pages are still saved to the account but no email is sent after generation
- This overrides the global "always automatic" email rule — user preference takes priority
- Stored as `email_delivery_enabled` boolean on the User model

**Manage saved business profiles:**
- User can view all business profiles associated with their account
- User can edit: business name, phone, website, differentiators, services, CTA preferences
- User can soft delete a business profile
- Soft deleting a business profile does NOT delete associated page records — they are preserved but the business profile is hidden from the business search step
- A soft-deleted business profile cannot be selected for new page generation

**Credit balance and usage history:**
- Shows current credit balance prominently
- Shows a paginated log of all credit transactions (action type, credit delta, date, associated keyword if applicable)
- Read-only — no ability to purchase credits from this screen in v1 (placeholder only)

**Delete account:**
- Permanently deletes the user account and all associated data
- Requires the user to type "DELETE" to confirm (or equivalent strong confirmation)
- Shows a clear warning that this action cannot be undone
- All page records, business profiles, and credit transactions are hard deleted on account deletion
- This is the only hard delete in v1 — all other deletes are soft

---

### Decision 10 — Score communication
**Status:** RESOLVED

**Decision:** Plain English label only. No engine breakdown, no tooltips, no explanations by default.

**Implementation rules:**
- The composite score is displayed as a number and a plain English label
- Label text is derived from score range — see SPEC.md Section 9 for the five labels
- No engine breakdown shown by default
- No tooltips on the score
- Deficiency list (if any) is shown below the score as specific actionable recommendations — this is the only additional context provided
- The collapsible engine breakdown panel still exists (defined in the original SPEC) but is collapsed by default and contains scores only — no explanatory text inside it

**What this means for coding:** Do not build tooltip components or explanatory copy for individual engine scores. The score number, the label, and the deficiency list are the complete user-facing scoring UI.

---

### Decision 11 — In-app help and guidance
**Status:** RESOLVED

**Decision:** A dedicated help / FAQ page within the app. No tooltips anywhere.

**Implementation rules:**
- A Help page is accessible from the main navigation (persistent link)
- The Help page contains a static FAQ covering:
  - What each app mode does (Generate, Audit, Improve)
  - How the credit system works
  - What the composite score means and how to improve it
  - How to use My Pages features (delete, duplicate, compare, etc.)
  - What the schema block is and where to put it
  - How to publish a generated page to a CMS
  - Frequently asked questions about local SEO (non-technical, plain English)
- Content is static — no dynamic content, no search, no categories in v1
- No tooltips anywhere in the app — the Help page is the single help entry point
- Help page does not consume credits and does not require a business profile

---

### Decision 12 — Audit Mode depth
**Status:** RESOLVED

**Decision:** Audit Mode is expanded in SPEC.md to match the depth of Generate Mode. The master PRD gap is addressed in the coding documents, not in the master PRD itself.

**Implementation rules:** See SPEC.md Section 4 (Audit Mode) — that section has been fully expanded with the complete user flow, input handling, scoring behavior, and output display rules.

---

## Standing Rules (Apply to all coding decisions)

These apply globally and do not require per-feature decisions:

| Rule | Detail |
|------|--------|
| All score thresholds | Configurable values, never hardcoded |
| All credit amounts | Configurable values, never hardcoded |
| Starting credit balance | Configurable value, never hardcoded |
| Pricing | Not in v1 scope — use placeholder |
| Payment processing | Not in v1 scope — use placeholder |
| Team/multi-user | Not in v1 scope — no UI, no logic |
| Schema review | Collapsed panel, never a blocking screen |
| Email delivery | Always automatic, no prompt |
| Page deletes | Soft delete only — never hard delete in v1 |
| Duplicated pages | Independent records — no link to original |
