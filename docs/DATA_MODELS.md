# DATA_MODELS.md — Local Content Writer App
> Version: 1.0 | Date: 2026-03-23
> Purpose: Defines every data model, field, type, validation rule, relationship, and index for the app.
> Rule: All database work is coded against this document. If a field is not here, it does not exist in v1.

---

## Overview — Model Relationships

```
User
 └── has many → Business Profiles
 └── has many → Page Records
 └── has many → Credit Transactions

Business Profile
 └── belongs to → User
 └── has many → Page Records

Page Record
 └── belongs to → User
 └── belongs to → Business Profile
 └── has many → Credit Transactions (via page_id)
```

---

## 1. User

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `user_id` | UUID | PRIMARY KEY, NOT NULL | Generated on creation |
| `email` | string | UNIQUE, NOT NULL, max 255 | Validated email format |
| `password_hash` | string | NOT NULL | Bcrypt hash — never store plain text |
| `credit_balance` | integer | NOT NULL, DEFAULT [CONFIGURABLE], ≥ 0 | Never goes below 0 |
| `email_delivery_enabled` | boolean | NOT NULL, DEFAULT true | User email preference |
| `name` | string | NULLABLE, max 255 | Display name |
| `created_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |
| `updated_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |

### Indexes
```
PRIMARY KEY (user_id)
UNIQUE INDEX ON (email)
```

---

## 2. Business Profile

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `business_id` | UUID | PRIMARY KEY, NOT NULL | |
| `user_id` | UUID | NOT NULL, FK → User.user_id | |
| `gbp_place_id` | string | NOT NULL, max 255 | Google Place ID |
| `business_name` | string | NOT NULL, max 255 | Exact match to GBP |
| `address` | string | NOT NULL, max 500 | |
| `phone` | string | NOT NULL, max 50 | |
| `website` | string | NULLABLE, max 500 | |
| `gbp_category` | string | NOT NULL, max 255 | |
| `gbp_rating` | float | NULLABLE | 0.0–5.0 |
| `gbp_review_count` | integer | NULLABLE, ≥ 0 | |
| `latitude` | float | NULLABLE | |
| `longitude` | float | NULLABLE | |
| `hours` | JSONB | NULLABLE | |
| `differentiators` | JSONB | NOT NULL, DEFAULT '[]' | Array of strings |
| `services` | JSONB | NOT NULL, DEFAULT '[]' | Array of service objects |
| `cta_preferences` | JSONB | NOT NULL, DEFAULT '{}' | |
| `site_scan_completed` | boolean | NOT NULL, DEFAULT false | |
| `site_scan_raw` | text | NULLABLE | |
| `deleted_at` | timestamp | NULLABLE | Soft delete |
| `created_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |
| `updated_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |

### Indexes
```
PRIMARY KEY (business_id)
INDEX ON (user_id)
UNIQUE INDEX ON (user_id, gbp_place_id)
```

---

## 3. Page Record

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `page_id` | UUID | PRIMARY KEY, NOT NULL | |
| `user_id` | UUID | NOT NULL, FK → User.user_id | |
| `business_id` | UUID | NOT NULL, FK → Business Profile | |
| `source_page_id` | UUID | NULLABLE, FK → Page Record | Null for originals, set for improve versions |
| `target_keyword` | string | NOT NULL, max 255 | |
| `target_city` | string | NOT NULL, max 100 | |
| `mode` | string | NOT NULL | generate \| audit \| improve |
| `icp_type` | string | NOT NULL | One of 7 ICP values |
| `icp_source` | string | NOT NULL | user_selected \| llm_inferred |
| `icp_confidence` | float | NULLABLE | 0.0–1.0 |
| `composite_score` | float | NOT NULL, 0–100 | |
| `score_status` | string | NOT NULL | Derived from composite_score at write time |
| `engine_scores` | JSONB | NOT NULL | All 7 engine score objects |
| `deficiencies` | JSONB | NOT NULL, DEFAULT '[]' | |
| `content_rich_text` | text | NULLABLE | Null for audit-only |
| `content_html` | text | NULLABLE | Null for audit-only |
| `schema_json` | JSONB | NULLABLE | |
| `audit_input_type` | string | NULLABLE | url \| plain_text \| html |
| `audit_input_url` | string | NULLABLE | |
| `version` | integer | NOT NULL, DEFAULT 1, ≥ 1 | |
| `email_sent` | boolean | NOT NULL, DEFAULT false | |
| `deleted_at` | timestamp | NULLABLE, DEFAULT NULL | Soft delete |
| `created_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |
| `updated_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |

### ICP Enum Values
```
emergency_homeowner | general_homeowner | commercial_business |
property_manager | vulnerable_homeowner | trade_contractor |
landlord_rental_owner
```

### Score Status Enum (derived at write time)
```
excellent        → 90–100
good             → 80–89
needs_improvement→ 70–79
below_standard   → 60–69
fail             → 0–59
```

### Indexes
```
PRIMARY KEY (page_id)
INDEX ON (user_id)
INDEX ON (business_id)
INDEX ON (user_id, created_at DESC)
INDEX ON (source_page_id)
```

---

## 4. Credit Transaction

Append-only. Never UPDATE or DELETE rows.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `transaction_id` | UUID | PRIMARY KEY, NOT NULL | |
| `user_id` | UUID | NOT NULL, FK → User | |
| `action` | string | NOT NULL | See action enum |
| `credit_delta` | integer | NOT NULL, ≠ 0 | Negative = debit, positive = credit |
| `page_id` | UUID | NULLABLE, FK → Page Record | |
| `created_at` | timestamp | NOT NULL, DEFAULT NOW() | UTC |

### Action Enum
```
generate | audit | improve | regenerate | refund | purchase | adjustment
```

### Indexes
```
PRIMARY KEY (transaction_id)
INDEX ON (user_id)
INDEX ON (user_id, created_at DESC)
INDEX ON (page_id)
```

---

## 5. Session / Auth (notes only)

- Sessions scoped to single `user_id`
- Auth tokens never stored in plain form
- `user_id` validated on every authenticated API request — never trust client-supplied user IDs

---

## 6. Enum Reference

```
Mode: generate | audit | improve
ICP Type: emergency_homeowner | general_homeowner | commercial_business | property_manager | vulnerable_homeowner | trade_contractor | landlord_rental_owner
ICP Source: user_selected | llm_inferred
Score Status: excellent | good | needs_improvement | below_standard | fail
NAP Consistency: pass | fail | not_checked
Deficiency Severity: critical | improvement
Credit Action: generate | audit | improve | regenerate | refund | purchase | adjustment
Audit Input Type: url | plain_text | html
CTA Type: call | book | quote | contact
Service Type: primary | sub | related
```

---

## 7. What Is NOT Stored in v1

| Item | Reason |
|------|--------|
| Team / organisation model | Multi-user not in v1 |
| Subscription / plan model | Payment not in v1 |
| My Pages filter/search state | UI state only — never persisted |
| Onboarding completion state | No onboarding in v1 |
