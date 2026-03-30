# Site Architecture, URL Structure, and Internal Linking SOP

**Current as of:** 19 Nov 2024
**Applies to:** All SEO and Web Design clients
**Used internally by:** ShowUP Local NLP service — `analyze_site_architecture()`, `classify_page_type()`, `INTERNAL_LINKING_RULES`

---

## Page Taxonomy

### Utility Pages (every site)

| Page | URL Pattern | Title Tag Pattern |
|---|---|---|
| Home | `site.com/` | `{Brand}` or `{Primary Service} \| {Brand}` |
| About Us | `site.com/about-us/` | `About Us \| {Brand}` |
| Contact Us | `site.com/contact-us/` | `Contact Us \| {Brand}` |
| Privacy Policy | `site.com/privacy-policy/` | `Privacy Policy \| {Brand}` |
| Services Index | `site.com/services/` | `Services \| {Brand}` |
| Areas We Serve | `site.com/areas-we-serve/` | `Areas We Serve \| {Brand}` |
| Media / Newsroom | `site.com/media/` | `Media \| {Brand}` |

### Top-Level Category Pages (Tier 1)

| Page | URL Pattern | Title Tag Pattern | Example |
|---|---|---|---|
| Location Page | `site.com/location/` | `{City} \| {Brand}` | `Los Angeles \| XYZ Plumber` |
| Service Page | `site.com/service/` | `{Service} \| {Brand}` | `Residential Plumber \| XYZ Plumber` |
| Blog Archive | `site.com/blog/` | `{Brand} Blog` | |

**Service pages must NOT be geo-targeted** unless the business targets only one city.
**Location pages must NOT focus on a single service** — cover all major services in H2s.

### Second-Level Category Pages (Tier 2)

| Page | URL Pattern | Title Tag Pattern | Example |
|---|---|---|---|
| Bio Page | `site.com/about-us/person/` | `{Name} \| {Brand}` | `Clayton Kershaw \| XYZ Plumber` |
| Sub-Service | `site.com/service/subservice/` | `{SubService} \| {Brand}` | `Drain Cleaning \| XYZ Plumber` |
| Blog Post | `site.com/blog/post-name/` | `{Post Title} \| {Brand}` | `What Is A Plumbing Emergency? \| XYZ Plumber` |
| Press Release | `site.com/media/press-release/` | `{Announcement} \| {Brand}` | `XYZ Plumber Announces New Santa Monica Location \| XYZ Plumber` |

### Local Landing Pages

| Page | URL Pattern | Title Tag Pattern | Example |
|---|---|---|---|
| City + Service | `site.com/location/service/` | `{Service} {City} \| {Brand}` | `Residential Plumber Los Angeles \| XYZ Plumber` |
| City + SubService | `site.com/location/service/subservice/` | `{SubService} {City} \| {Brand}` | `Water Heater Repair Los Angeles \| XYZ Plumber` |

**Local landing pages:** location slug FIRST, service slug SECOND.
**Most geo-relevant pages on the site** — primary driver of GBP signal.

### Silo Pages

| Page | URL Pattern | Title Tag Pattern | Example |
|---|---|---|---|
| Neighborhood | `site.com/location/neighborhood/` | `{Service} {Neighborhood} \| {Brand}` | `Plumber Sawtelle \| XYZ Plumber` |
| POI | `site.com/location/poi/` | `{Service} near {POI} \| {Brand}` | |

Neighborhood pages: only for large cities with recognized neighborhoods (verify in Google Maps — must have left-panel entity info).

---

## Page Type Detection (Classifier Types)

The NLP service classifies each discovered page into one of these types:

| Type | Description | Detection |
|---|---|---|
| `service` | Top-level service page, no geo | Service words in URL/title/H1, no geo signal |
| `location` | Top-level city page, no service | Geo signal in URL/title/H1, no service words |
| `city_service` | Local landing page — service + city | Both service words AND geo signal |
| `blog` | Blog post or content page | Under `/blog/`, `/news/`, `/articles/`, etc. |
| `media` | Press release or newsroom content | Under `/media/`, `/newsroom/`, `/press-room/`, `/press-releases/` |
| `other` | About, contact, home, utility pages | Everything else |

---

## Title Tag Patterns Summary

| Page Type | Pattern |
|---|---|
| Location | `{City} \| {Brand}` |
| Service | `{Service} \| {Brand}` |
| Local landing (city+service) | `{Service} {City} \| {Brand}` |
| Local landing (city+subservice) | `{SubService} {City} \| {Brand}` |
| Neighborhood silo | `{Service} {Neighborhood} \| {Brand}` |
| Bio | `{Full Name} \| {Brand}` |
| Sub-service | `{SubService} \| {Brand}` |
| Blog post | `{Post Title} \| {Brand}` |
| Press release | `{Announcement headline} \| {Brand}` |

---

## Internal Linking Rules

### All pages must link via nav/footer to:
- Home, About Us, Contact Us, Privacy Policy
- Top-level service pages (or Services index if too many for nav)
- Top-level location pages (or Areas We Serve if too many for nav)
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

- Every page distributes its equity equally across all outbound links.
- Adding pages to a category dilutes equity per page in that category.
- Direct external links pass more value than internal links (15%+ dampening).
- Deep pages only receive equity from their category index page.
- Keep navigation focused — too many nav links dilutes equity to each destination.

---

## Content Silos

Group semantically related pages through internal linking. Each silo = one main topic with related subtopics all linked together.

Benefits:
1. Reinforces keyword relevance within the topic cluster
2. Distributes link equity efficiently within the silo
3. Improves user navigation and time-on-site
