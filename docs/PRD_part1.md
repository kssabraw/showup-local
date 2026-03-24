# 📌 PRD — Local Content Writer App (Part 1 of 2)
> Sections: Organic Ranking Engine, GBP/Maps Engine, Entity Establishment, AEO/LLM Retrieval, Differentiation Framework, Topical Authority
> Continue in PRD_part2.md

---

# 📌 PRD Section: Organic Ranking Engine (Local SEO Content)

## 🎯 Objective

The Organic Ranking Engine ensures that every generated local service page is optimized to rank in organic search results by aligning with:

- User intent (primary ranking gate)
- Semantic relevance (topic + geo alignment)
- Authority signals (trust + coverage)
- Usability (engagement + UX)

---

## 🧠 Core Ranking Framework

Intent Match → Relevance → Authority → Usability → Ranking Eligibility

---

# 1️⃣ Intent Matching Layer (Critical Gate)

The page MUST:
- Clearly state the service + location in Title, H1, and opening paragraph
- Confirm availability of services (not informational content)
- Include phone number and CTA above the fold
- Avoid blog-style or informational framing

IF page contains informational tone, no clear service offering, or no CTA above the fold → Fail Intent Match

Output Signals: intent_score (0–100), intent_status (pass | fail | needs_improvement)

---

# 2️⃣ Relevance Layer (Semantic + Keyword Alignment)

Requirements:
- Primary keyword in title, H1, URL slug
- Keyword variations included naturally
- Semantic coverage: core services + related terminology
- Geo relevance: city + neighborhoods + zip codes + landmarks
- Entity relationships: Brand ↔ Service ↔ Location

Output Signals: relevance_score, keyword_coverage (%), semantic_coverage (%), geo_coverage (%)

---

# 3️⃣ Authority Layer (Trust + Competitive Strength)

Requirements:
- Clear service descriptions + supporting sections
- Internal links to related services (2–5, descriptive anchor text)
- Consistent NAP aligned with GBP
- Reviews/testimonials, experience indicators, proof elements

Output Signals: authority_score, trust_signal_count, internal_link_count, topical_depth_score

---

# 4️⃣ Usability Layer (Engagement Optimization)

Requirements:
- Clear heading hierarchy (H1 → H2 → H3)
- Scannable content (lists, short paragraphs)
- CTA visible above the fold
- Clear, direct language

Output Signals: usability_score, readability_score, CTA_visibility (true/false), structure_score

---

# 🚫 Common Failure Patterns

- Keyword stuffing without service clarity
- Blog-style content for transactional queries
- Missing CTAs
- No geo specificity
- Thin content with no service depth
- No internal linking

---

# ✅ Definition of Success

A generated page is successful if it:
- Passes all four layers
- Achieves organic_ranking_score ≥ 85
- Is capable of ranking for primary keyword + at least 5 variations
- Is conversion-ready upon publishing

---

# 📌 PRD Section: GBP / Maps Relevance Signal Engine

## 🎯 Objective

Ensure all generated pages systematically increase a business's ability to rank in Google Map Pack results by reinforcing service relevance, geographic relevance, and entity association.

## Core Principle

Google cross-references a business's website to validate GBP claims. The website acts as a source of truth and validation layer for GBP rankings.

---

# 1️⃣ Service Relevance Signals

Each page must:
- Clearly define the primary service
- Include supporting services
- Align with GBP categories

The website transforms a category claim into a validated service profile.

---

# 2️⃣ Geographic Relevance Signals

Each page must:
- Explicitly mention the primary city
- Include secondary geo signals (neighborhoods, zip codes, nearby context)
- Use natural, contextual phrasing

The page acts as evidence of geographic legitimacy, not just a claim.

---

# 3️⃣ Entity Reinforcement Signals

Each page must reinforce Brand → Service → Location using consistent phrasing patterns:
- "[Brand] is a trusted [service] in [City]"
- "[Brand] provides [service] services throughout [City]"

These must appear in intro, body content, and supporting sections.

Output Signals: gbp_maps_score, service_relevance_score, geo_relevance_score, entity_reinforcement_score, nap_consistency (pass | fail | not_checked)

---

# 📌 PRD Section: Entity Establishment Engine

## 🎯 Objective

Systematically increase Google's confidence that a business is a primary, reliable entity for a specific service within a defined geographic area.

Goal: Brand = Service + Location (e.g., "[Brand] = Plumber in Anaheim")

---

# 1️⃣ Co-Occurrence Density & Distribution

Brand + Service + Location must appear across:
- Title, H1, intro paragraph, body sections, conclusion, CTA sections, anchor text

Google evaluates distribution, not just frequency. Evenly distributed signals → strong association.

---

# 2️⃣ Topical Expansion (Entity Graph Thickening)

Expand coverage beyond primary service to all sub-services and related services, all tied to the same location. Creates multi-edge entity graph:

Brand → Plumbing → Anaheim  
Brand → Drain Cleaning → Anaheim  
Brand → Water Heater Repair → Anaheim

---

# 3️⃣ Internal Linking as Relationship Signals

Create structured internal links between service pages and location pages using descriptive anchor text:
- "Emergency plumbing in Anaheim"
- "Anaheim drain cleaning services"

---

# 4️⃣ Structured Data (Explicit Entity Definition)

Generate schema including LocalBusiness, Service, AreaServed. Schema must match page content and align with GBP data.

Output Signals: entity_strength_score, co_occurrence_density_score, topical_expansion_score, internal_link_structure_score

---

# 📌 PRD Section: AEO / LLM Retrieval Layer

## Core Principle

Content must be designed as independent, reusable answer units — not just full-page narratives.

---

# 1️⃣ Chunk-Level Optimization (Hard Requirement)

Each section must:
- Be ≤ 300 words (ideal: 100–300 tokens)
- Contain one primary idea only
- Be fully self-contained
- Be understandable without relying on other sections

---

# 2️⃣ Answer-First Formatting (Mandatory)

Each section must begin with a direct answer sentence, followed by supporting explanation, bullets, or examples.

Weak: "Plumbing services are important for homeowners in Anaheim…"
Strong: "Emergency plumbing in Anaheim includes burst pipe repair, drain cleaning, and same-day service."

---

# 3️⃣ Semantic Triple Encoding

Content must explicitly encode: Subject → Predicate → Object
- "[Brand] provides [Service] in [Location]"
- "[Business] offers [Service Type] with [Differentiator]"

---

# 4️⃣ Q&A Structural Integration

Q&A format used throughout the page, not only in FAQ sections. Structure: Question (heading) → Direct answer (first sentence) → Expansion.

---

# 5️⃣ Information Gain Requirement

Each page must provide net-new, unique information:
- Specific service scenarios
- Operational details
- Local geography specificity
- Process explanations

Prohibited: generic city-page filler, high-level non-specific descriptions.

---

# 6️⃣ Minimize Transformation Cost

Content must be direct, complete, ready-to-use, and low-ambiguity. The lower the transformation cost, the higher the selection probability by AI systems.

Output Signals: aeo_retrieval_score, chunk_compliance, answer_first_formatting, faq_present, faq_entry_count

---

# 📌 PRD Section: Differentiation Framework

## Core Principle

Local SEO pages win by being distinctly relevant for a specific version of search intent — not just "optimized."

---

# Section 1: Title Tag Differentiation

Formula: Primary Keyword + Differentiator + Location (+ Optional Brand)

Every title MUST include a clear, specific differentiator.

Valid: "Same-Day HVAC Repair Anaheim | 2-Hour Arrival Window"
Invalid: "HVAC Repair Anaheim"

Acceptable differentiator types: Speed ("Same-Day", "24/7"), Cost ("No Overtime Fees"), Guarantee ("Flat-Rate Pricing"), Specialization.

Disallowed: "Trusted", "Professional", "High Quality", "Reliable" — these don't improve rankings or CTR.

SEO constraints: 50–60 characters, primary keyword front-loaded.

---

# Section 2: H1 (Support + Reinforcement)

Must align with title intent, include keyword variation, and reinforce the same differentiator (not introduce a new one).

---

# Section 3: H2 Structure (Differentiated Service Framing)

Each H2 must reflect a specific outcome or benefit:

Invalid: "HVAC Repair Services"
Valid: "Fast HVAC Repairs That Restore Comfort the Same Day"

---

# Section 4: Required Differentiation Signal Types

Each page must include at least:
1. Time-Based Claim ("2-hour response time")
2. Mechanism (HOW the claim is achieved: "GPS-dispatched technicians")
3. Outcome-Based Claim ("restore comfort faster")
4. Proof Signal ("serving 1,000+ customers")

---

# Section 5: Mechanisms (Critical)

Every major claim must include a mechanism:
Weak: "Fast service"
Strong: "Fast service with GPS-dispatched technicians and real-time routing"

---

# Section 6: Explicit Contrast

Include at least one contrast statement:
- "Unlike companies that charge overtime fees, we offer flat-rate pricing"
- "Most HVAC companies schedule days out — we guarantee same-day service"

---

# Section 7: Intent Alignment

| Query Type | Differentiation Angle |
|---|---|
| emergency | speed / availability |
| "best" | proof / authority |
| price-sensitive | cost / value |
| niche service | specialization |

---

# Section 8: Full-Page Reinforcement

Differentiation must appear in: title, H1, intro paragraph, H2s, service descriptions, CTAs.

CTA: "Book your same-day HVAC repair with a 2-hour arrival window" (not "Contact us today")

---

# 📌 PRD Section: Topical Authority for Related Services

## Core Definition

Topical authority = clearly demonstrating that the business is deeply and specifically associated with a cluster of related services within a geographic area.

---

## Why It Matters

1. Strengthens entity understanding — Google sees a network of related services
2. Expands ranking surface area without cannibalization
3. Prevents over-reliance on one page
4. Enables internal linking that reinforces relevance
5. Aligns with real search behavior (problem-based queries)
6. Increases conversion rates (specific pages convert better)
7. Future-proofs for AI/LLM retrieval

---

## Implementation Requirements

### Define Service Clusters

Example HVAC Cluster:
- Core: HVAC Repair
- Sub-services: AC Repair, Furnace Repair, Heat Pump Repair
- Situational: Emergency HVAC Repair, Same-Day HVAC Repair
- Problem-based: AC Not Cooling, Heater Not Turning On

### One Page = One Primary Intent

No two pages should compete for the same primary intent.

### Internal Linking

Each page links to 2–5 related service pages with descriptive anchor text.

### Consistent Differentiation

If positioning = "same-day service" → all pages in cluster reflect this.

### Avoid Thin Pages

Each page must add unique value and address a distinct problem.

---

## Success Criteria

A site has achieved topical authority when:
1. It covers all major service variations
2. It targets multiple intent layers
3. It includes problem-based content
4. It maintains strong internal linking
5. It reinforces consistent differentiation
