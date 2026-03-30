# Site Architecture, URL Structure, and Internal Linking SOP

**Current as of:** 19 Nov 2024
**Applies to:** All SEO and Web Design clients
**Used internally by:** ShowUP Local NLP service — `analyze_site_architecture()`, `check_url_sop_compliance()`, `INTERNAL_LINKING_RULES`

---

## URL Structure

### Top-Level Pages (Tier 1)

| Page | URL Pattern |
|---|---|
| Home | `https://site.com/` |
| About Us | `https://site.com/about-us/` |
| Bio Pages | `https://site.com/bio/` |
| Contact Us | `https://site.com/contact-us/` |
| Privacy Policy | `https://site.com/privacy-policy/` |
| Service Pages | `https://site.com/service/`, `https://site.com/service-2/` |
| Location Pages | `https://site.com/location/`, `https://site.com/location-2/` |
| Blog Archive | `https://site.com/blog/` |
| Areas We Serve | `https://site.com/areas-we-serve/` |

**Service pages must NOT be geo-targeted** unless the company targets only one city.
**Location pages must NOT include service terms** — one page per city.

### Second-Level Pages (Tier 2)

| Page | URL Pattern |
|---|---|
| Local Landing Page | `https://site.com/location/service/` |
| Blog Posts | `https://site.com/blog/blog-name-here/` |
| Sub Services | `https://site.com/service/subservice/` |
| Neighborhoods | `https://site.com/location/neighborhood/` |

**Local landing pages:** location slug FIRST, service slug SECOND — `/location/service/` not `/service/location/`.

### Third-Level Pages (Tier 3 — competitive/difficult keywords only)

| Page | URL Pattern |
|---|---|
| Hyper-Specific Local | `https://site.com/location/service/sub-service/` |
| Hyper-Specific Neighborhood | `https://site.com/location/neighborhood/sub-service/` |

---

## Page Purposes

- **Home:** Brand-focused. Do NOT optimize for the main keyword — optimize for brand search intent.
- **About Us:** Company history, mission, USP, leadership team. Not service-focused.
- **Bio Pages:** Leadership credentials, work history, education, professional orgs. Builds authority.
- **Contact Us:** NAP, GBP embed, form fill, click-to-call, social links. Keep short.
- **Service Pages:** Expertise + authority for the service. No geo-targeting (unless single-city business).
- **Location Pages:** City-focused. Include all major services in H2s. No single-service focus.
- **Local Landing Pages:** Optimized for `[service] in [city]` and `[service] near me`. Most geo-relevant power. Pushes GBP signal.
- **Blog Posts:** Informational intent. Nationwide traffic + brand authority. Do NOT geo-target informational posts.
- **Sub-Service Pages:** For keywords on a different intent vector (e.g., "24-hour plumber" vs "plumber").
- **Neighborhood Pages:** For large cities with recognized neighborhoods verified in Google Maps.

---

## Internal Linking Rules

### All pages must link via nav/footer to:
- Home, About Us, Contact Us, Privacy Policy
- Top-level service pages (or Services index if too many)
- Top-level location pages (or Areas We Serve if too many)
- Blog Archive

### Body content links by page type:

| Page Type | Must Link To (Body) |
|---|---|
| Home | Each service page, each location page, Contact |
| About Us | Bio pages, Areas We Serve, top-level service page |
| Service Page | Subservices, Contact, related local landing pages |
| Location Page | Neighborhood pages, POI pages, related local landing pages, Contact, Areas We Serve |
| Local Landing Page | Parent location page, relevant service page, relevant subservice page, Contact |
| Sub-Service Page | Parent service page, Contact, related hyper-specific local landing pages |
| Neighborhood Page | Parent location page, related neighborhoods, related POI, related service |
| Blog Post | Related blog posts in silo, related service or subservice |
| Areas We Serve | Each individual location page |

---

## PageRank / Link Equity Principles

- Every page has a finite amount of link equity to distribute equally across all outbound links.
- Adding pages to a category dilutes equity to all other pages in that category.
- Direct external links pass more value than internal links (15%+ dampening factor).
- Deep pages that aren't linked site-wide only receive equity from their category index page.
- Keep navigation focused — too many links in nav dilutes equity to each destination.

---

## Content Silos

Group semantically related pages through internal linking. Each silo = one main topic with related subtopics linked together.

Benefits:
1. Reinforces keyword relevance within the silo
2. Distributes link equity efficiently within the topic cluster
3. Improves user navigation and time-on-site
