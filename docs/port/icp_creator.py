"""
ICP Creator — portable, self-contained module.

Ported (with the cross-app glue removed) from ShowUP Local's services/nlp/main.py.
Given a business (name + GBP category + optional website), it discovers the
site's page structure and uses an LLM to detect 1-3 Ideal Customer Profiles
(ICPs) with full psychographic detail, plus differentiators.

Drop this file into a FastAPI app and mount the router:

    from icp_creator import router as icp_router
    app.include_router(icp_router)

Or call the pipeline directly:

    resp = await run_business_analysis(BusinessAnalysisRequest(
        website_url="https://example.com", business_name="Example Plumbing",
        gbp_category="Plumber", gbp_categories=["Plumber", "Drainage service"],
    ))
    detected_icp = resp.detected_icp        # persist on your business record
    icp_block = build_icp_text(detected_icp) # prepend to your generator's prompt

Environment variables:
    ANTHROPIC_API_KEY   — for the ICP detection call (and optional URL classify)

Dependencies (see requirements.txt):
    fastapi, httpx, beautifulsoup4, lxml, anthropic, pydantic

Notes:
  * SHIPPED BEHAVIOR IS URL-ONLY: discovery classifies pages by URL and returns
    empty title/h1 — the LLM sees business name + categories + page URLs, not
    scraped copy. To improve differentiator quality, populate page title/h1
    (or paragraph text) before the LLM call — see the `_ENRICH_PAGES` hook below.
  * The page-discovery + classification helpers are duplicated from brand_voice.py
    so this file is standalone. If you use both, factor them into a shared module.
  * The system prompts say "local service business" — edit if your vertical differs.
"""

from __future__ import annotations

import asyncio
import ipaddress as _ipaddress
import json as json_lib
import logging
import os
import re
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANALYSIS_MODEL = os.environ.get("ICP_MODEL", "claude-haiku-4-5-20251001")

# Set False to skip the extra LLM call that reclassifies ambiguous 'other' URLs.
USE_AI_URL_CLASSIFY = os.environ.get("ICP_AI_URL_CLASSIFY", "true").lower() != "false"

CRAWL_HEADERS = {
    "User-Agent": "ICPBot/1.0 (business-page-discovery; respects robots.txt)",
}


# ── Security: SSRF guard ───────────────────────────────────────────────────────
def block_ssrf(url: str) -> None:
    """Raise HTTPException 400 if the URL targets a private/internal network."""
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(status_code=400, detail="Invalid URL scheme")
        hostname = parsed.hostname or ""
        try:
            ip = _ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise HTTPException(status_code=400, detail="URL targets a private network address")
        except ValueError:
            pass
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")


# ── Request / Response models ──────────────────────────────────────────────────
class BusinessAnalysisRequest(BaseModel):
    website_url: Optional[str] = None
    business_name: str
    gbp_category: str
    gbp_categories: List[str] = []


class BusinessAnalysisResponse(BaseModel):
    existing_pages: List[dict]
    detected_icp: Optional[dict]
    differentiators: List[dict]
    pages_crawled: int
    analysis_status: str  # "complete" | "partial" | "failed"


# ── Page classification vocab ──────────────────────────────────────────────────
STATE_ABBREVS = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
    "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
    "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
    "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
}

SERVICE_WORDS = {
    "repair", "service", "services", "installation", "install", "replacement",
    "maintenance", "inspection", "cleaning", "emergency", "plumbing", "hvac",
    "electrical", "roofing", "pest", "landscaping", "remodeling", "painting",
    "flooring", "gutters", "siding", "windows", "doors", "concrete", "fencing",
    "generator", "insulation", "waterproofing", "restoration", "handyman",
    "appliance", "garage", "deck", "patio", "pool", "irrigation", "sprinkler",
    "locksmith", "mold", "asbestos", "foundation", "basement", "septic", "drain",
    "managed", "cybersecurity", "cyber", "cloud", "network", "backup", "helpdesk",
    "support", "monitoring", "infrastructure", "security", "compliance", "voip",
    "microsoft", "azure", "wireless", "server", "firewall", "endpoint", "siem",
    "consulting", "solutions", "technology", "tech", "software", "hardware", "it",
    "attorney", "lawyer", "litigation", "injury", "divorce", "criminal", "estate",
    "bankruptcy", "immigration", "employment", "law", "legal", "counsel", "defense",
    "dental", "dentist", "orthodontics", "medical", "clinic", "therapy", "therapist",
    "chiropractic", "physical", "wellness", "cosmetic", "implants", "pediatric",
    "dermatology", "optometry", "vision", "hearing", "counseling", "rehabilitation",
    "accounting", "bookkeeping", "tax", "cpa", "financial", "wealth", "insurance",
    "mortgage", "lending", "investment", "payroll", "audit",
    "marketing", "seo", "advertising", "branding", "design", "photography",
    "catering", "moving", "storage", "towing", "auto", "automotive", "collision",
    "salon", "spa", "fitness", "training", "coaching", "tutoring", "staffing",
    "janitorial", "alarm", "surveillance",
}

BLOG_SLUGS = {
    "blog", "news", "insights", "articles", "resources", "resource", "post", "posts",
    "updates", "press", "media", "events", "case-studies", "whitepapers", "guides",
    "tips", "podcast", "webinars", "newsletter", "stories", "learn", "library",
    "knowledge-base", "kb", "forum", "community", "careers", "jobs",
}

SKIP_SLUGS = {
    "privacy", "terms", "sitemap", "search", "tag", "tags", "category", "categories",
    "author", "wp-content", "wp-admin", "wp-json", "cart", "checkout", "account",
    "login", "register", "feed", "rss", "cdn", "admin", "dashboard", "portal",
}

LOCATION_SLUGS = {
    "service-area", "service-areas", "areas-we-serve", "areas-served",
    "locations", "location", "cities", "city", "coverage", "coverage-area",
    "near-me", "local", "where-we-serve", "our-locations",
}

ABOUT_SLUGS = {
    "about", "about-us", "contact", "contact-us", "team", "staff", "our-team",
    "reviews", "testimonials", "gallery", "portfolio", "pricing", "home", "index",
    "sitemap", "accessibility", "disclaimer", "refund", "shipping",
}

_STATE_ABBREV_PATTERN = re.compile(
    r"-(" + "|".join(STATE_ABBREVS) + r")(?:/|$)", re.IGNORECASE
)

BLOG_STOP_WORDS = {
    "a", "an", "the", "to", "for", "in", "on", "at", "by", "from", "with", "about",
    "of", "and", "or", "but", "as", "if", "into", "over", "out", "up", "down",
    "how", "why", "what", "when", "where", "who", "which", "whether",
    "do", "does", "did", "get", "make", "find", "choose", "fix", "know", "need",
    "use", "keep", "avoid", "increase", "improve", "reduce", "boost", "help",
    "save", "build", "create", "start", "stop", "prevent", "handle", "manage",
    "tips", "ways", "reasons", "things", "steps", "signs", "mistakes", "ideas",
    "questions", "examples", "facts", "benefits", "types", "differences",
    "best", "top", "great", "good", "better", "new", "old", "free", "easy", "quick",
    "simple", "complete", "ultimate", "essential", "important", "common", "right",
    "wrong", "perfect", "proven", "effective", "powerful", "smart",
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "secures", "achieves", "wins", "launches", "announces", "expands", "hires",
    "partners", "joins", "receives", "earns", "reveals", "unveils", "named",
    "recognized", "awarded", "ranked", "acquires", "closes", "raises", "signs",
    "game", "changing", "groundbreaking", "revolutionary", "disruptive",
    "innovative", "emerging", "evolving", "latest", "modern", "upcoming",
    "future", "current", "global", "local", "digital", "virtual", "real",
    "failures", "failure", "problems", "problem", "challenges", "challenge",
    "risks", "risk", "myths", "myth", "stereotypes", "stereotype",
    "misconceptions", "misconception", "mistakes", "mistake", "issues", "issue",
    "dangers", "danger", "warning", "warnings", "pitfalls", "pitfall",
}

BLOG_LEAD_WORDS = {
    "how", "why", "what", "when", "where", "who", "which", "whether",
    "is", "are", "was", "were", "will", "would", "can", "could", "should", "do", "does", "did",
    "get", "find", "make", "learn", "discover", "explore", "understand", "read",
    "see", "check", "avoid", "stop", "start", "build", "improve", "increase",
    "boost", "reduce", "save", "use", "try", "need", "want",
    "simplify", "configure", "integrate", "optimize", "automate", "migrate",
    "secure", "protect", "leverage", "maximize", "minimize", "streamline",
    "enable", "disable", "setup", "upgrade", "deploy", "troubleshoot",
    "comparing", "choosing", "picking", "switching", "using", "getting",
    "clarifying", "understanding", "navigating", "protecting", "managing",
    "avoiding", "preparing", "addressing", "implementing", "evaluating",
    "identifying", "recognizing", "overcoming", "preventing", "handling",
    "building", "creating", "running", "growing", "leading", "working",
    "finding", "becoming", "turning", "writing", "reading", "sending",
    "moving", "setting", "taking", "making", "giving", "keeping",
    "dont", "cant", "wont", "isnt", "arent", "wasnt", "didnt",
    "shouldnt", "couldnt", "wouldnt", "havent", "hasnt", "hadnt",
    "the", "an", "may", "might",
    "become", "grow", "achieve", "master", "fix", "solve", "tackle", "beat",
}

BLOG_MID_WORDS = {
    "in", "the", "for", "with", "of", "and", "or", "to", "a", "an", "by", "from",
    "at", "on", "as", "into", "over", "about",
    "is", "are", "was", "were", "has", "have", "had",
    "your", "our", "their", "my", "its",
    "needs", "takes", "makes", "gets", "helps", "keeps", "shows", "means",
    "works", "comes", "goes", "lets", "gives", "puts", "sets", "runs",
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
}


def _slug_looks_like_blog(slug: str) -> bool:
    """True if a URL leaf slug reads like a blog post rather than a service/location page."""
    words = [w for w in re.split(r"[-_]", slug.lower()) if len(w) > 1]
    if not words:
        return False
    if len(words) > 6:
        return True
    if words[0].isdigit():
        return True
    if words[0] in BLOG_LEAD_WORDS:
        return True
    if len(words) >= 3 and any(w in BLOG_MID_WORDS for w in words[1:]):
        return True
    if any(re.match(r"^(19|20)\d{2}$", w) for w in words):
        return True
    if len(words) >= 4 and any(w in BLOG_STOP_WORDS for w in words):
        return True
    return False


def classify_page_type(url: str, title: str = "", h1: str = "") -> dict:
    """Rule-based page type classifier. Returns { type, primary_service, primary_city }.

    Types: service | location | city_service | blog | other
    """
    path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    combined = f"{path} {title} {h1}".lower()
    segments = [s for s in path.split("/") if s]
    first = segments[0] if segments else ""
    path_words = set(re.split(r"[-_]", " ".join(segments)))

    if first in BLOG_SLUGS or (len(segments) > 1 and segments[0] in BLOG_SLUGS):
        return {"type": "blog", "primary_service": None, "primary_city": None}

    for seg in segments:
        seg_words = [w for w in re.split(r"[-_]", seg.lower()) if len(w) > 1]
        if seg_words and seg_words[0].isdigit():
            return {"type": "blog", "primary_service": None, "primary_city": None}

    if "vs" in path_words:
        return {"type": "blog", "primary_service": None, "primary_city": None}

    leaf = segments[-1] if segments else ""
    if leaf and _slug_looks_like_blog(leaf):
        leaf_word_list = [w for w in re.split(r"[-_]", leaf.lower()) if len(w) > 1]
        definitely_blog = (
            len(leaf_word_list) > 6
            or (leaf_word_list and leaf_word_list[0].isdigit())
            or (leaf_word_list and leaf_word_list[0] in BLOG_LEAD_WORDS)
            or any(re.match(r"^(19|20)\d{2}$", w) for w in leaf_word_list)
        )
        if definitely_blog:
            return {"type": "blog", "primary_service": None, "primary_city": None}
        leaf_words = set(leaf_word_list)
        has_service_word = bool(leaf_words & SERVICE_WORDS)
        has_state_at_end = bool(_STATE_ABBREV_PATTERN.search(leaf))
        if not (has_service_word and has_state_at_end):
            return {"type": "blog", "primary_service": None, "primary_city": None}

    if first in SKIP_SLUGS:
        return {"type": "other", "primary_service": None, "primary_city": None}

    has_geo = bool(
        _STATE_ABBREV_PATTERN.search(path)
        or re.search(r"\b\d{5}\b", combined)
        or any(s in LOCATION_SLUGS for s in segments)
        or "near" in path_words
    )
    has_service = bool(path_words & SERVICE_WORDS or any(w in combined for w in SERVICE_WORDS))

    if has_geo and has_service:
        page_type = "city_service"
    elif has_geo:
        page_type = "location"
    elif has_service:
        page_type = "service"
    elif len(segments) == 1 and first not in ABOUT_SLUGS:
        slug_words = [w for w in re.split(r"[-_]", first) if len(w) > 1]
        page_type = "service" if len(slug_words) <= 3 else "other"
    else:
        page_type = "other"

    return {"type": page_type, "primary_service": None, "primary_city": None}


# ── Page discovery ──────────────────────────────────────────────────────────────
async def _fetch_sitemap_urls(sitemap_url: str, client: httpx.AsyncClient, depth: int = 0) -> List[str]:
    """Fetch a sitemap (or sitemap index) and return all <loc> URLs (recurses one level)."""
    if depth > 1:
        return []
    try:
        r = await client.get(sitemap_url, timeout=15.0)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, "xml")
        sitemap_tags = soup.find_all("sitemap")
        if sitemap_tags:
            child_urls = [t.find("loc").get_text(strip=True) for t in sitemap_tags if t.find("loc")]
            results = await asyncio.gather(
                *[_fetch_sitemap_urls(u, client, depth + 1) for u in child_urls[:50]]
            )
            return [url for sublist in results for url in sublist]
        return [t.get_text(strip=True) for t in soup.find_all("loc")]
    except Exception as e:
        logger.warning(f"Sitemap fetch error ({sitemap_url}): {e}")
        return []


async def _discover_via_sitemap(base_url: str, client: httpx.AsyncClient) -> List[str]:
    """Read robots.txt for a Sitemap: directive, else try common locations. Returns internal URLs."""
    parsed = urllib.parse.urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    sitemap_url: Optional[str] = None
    try:
        r = await client.get(f"{origin}/robots.txt", timeout=10.0)
        if r.status_code == 200:
            for line in r.text.splitlines():
                if line.lower().startswith("sitemap:"):
                    sitemap_url = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass

    candidate_sitemaps = [sitemap_url] if sitemap_url else [
        f"{origin}/sitemap.xml",
        f"{origin}/sitemap.xml.gz",
        f"{origin}/sitemap_index.xml",
        f"{origin}/index-sitemap.xml",
        f"{origin}/wp-sitemap.xml",
        f"{origin}/page-sitemap.xml",
        f"{origin}/page-sitemap1.xml",
        f"{origin}/post-sitemap.xml",
        f"{origin}/post-sitemap1.xml",
        f"{origin}/category-sitemap.xml",
        f"{origin}/sitemap1.xml",
    ]

    urls: List[str] = []
    for sm_url in candidate_sitemaps:
        urls = await _fetch_sitemap_urls(sm_url, client)
        if urls:
            logger.info(f"Sitemap discovery: found working sitemap at {sm_url}")
            break

    internal = []
    for u in urls:
        try:
            p = urllib.parse.urlparse(u)
            if p.netloc != parsed.netloc:
                continue
            if re.search(r"\.(jpg|jpeg|png|gif|pdf|css|js|ico|svg|zip|xml)$", p.path, re.I):
                continue
            internal.append(u)
        except Exception:
            continue

    logger.info(f"Sitemap discovery: found {len(internal)} internal URLs")
    return internal


async def _discover_via_nav(base_url: str, client: httpx.AsyncClient) -> List[str]:
    """Fallback: fetch homepage, extract links from <nav>/<header> (then all links)."""
    try:
        r = await client.get(base_url, timeout=15.0)
        if r.status_code != 200:
            return []
        parsed = urllib.parse.urlparse(base_url)
        base_domain = parsed.netloc
        soup = BeautifulSoup(r.text, "html.parser")

        nav_els = soup.find_all(["nav", "header"]) or [soup]
        urls = set()
        for container in nav_els:
            for a in container.find_all("a", href=True):
                href = str(a["href"]).strip()
                if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
                    continue
                full = urllib.parse.urljoin(base_url, href)
                p = urllib.parse.urlparse(full)
                if p.netloc != base_domain:
                    continue
                if re.search(r"\.(jpg|jpeg|png|gif|pdf|css|js|ico|svg|zip|xml)$", p.path, re.I):
                    continue
                clean = f"{p.scheme}://{p.netloc}{p.path.rstrip('/')}"
                urls.add(clean)

        logger.info(f"Nav discovery: found {len(urls)} links on homepage")
        return list(urls)
    except Exception as e:
        logger.warning(f"Nav discovery error: {e}")
        return []


async def _classify_urls_with_ai(urls: List[str]) -> Dict[str, str]:
    """Use the LLM to classify ambiguous URLs by page type.

    Returns {url: page_type}. Falls back to {} on any failure so the caller keeps
    rule-based results.
    """
    if not ANTHROPIC_API_KEY or not urls or not USE_AI_URL_CLASSIFY:
        return {}
    try:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        url_list = "\n".join(urls)
        prompt = f"""Classify each URL from a business website. Return ONLY a JSON object mapping URL→type.

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

{url_list}

JSON only: {{"url1": "type1", "url2": "type2"}}"""

        response = await client.messages.create(
            model=ANALYSIS_MODEL,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        result = json_lib.loads(raw)
        logger.info(f"AI classified {len(result)} ambiguous URLs")
        return result
    except Exception as e:
        logger.warning(f"AI URL classification failed, using rule-based only: {e}")
        return {}


async def crawl_website(website_url: str, max_pages: int = 200) -> List[dict]:
    """Sitemap-first page discovery + two-tier classification.

    Returns page records (url, title='', h1='', page_type, ...) with blogs dropped,
    sorted city_service → service → location → other.
    """
    block_ssrf(website_url)
    url = website_url.strip()
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=CRAWL_HEADERS) as client:
        discovered = await _discover_via_sitemap(url, client)
        if not discovered:
            logger.info(f"No sitemap found for {url} — falling back to nav extraction")
            discovered = await _discover_via_nav(url, client)

    parsed = urllib.parse.urlparse(url)
    homepage = f"{parsed.scheme}://{parsed.netloc}"
    all_urls = list(dict.fromkeys([homepage] + discovered))  # dedup, preserve order

    # Pass 1: rule-based classification
    rule_results: Dict[str, str] = {u: classify_page_type(u)["type"] for u in all_urls}

    # Pass 2: send ambiguous 'other' URLs to the LLM (cap 150)
    ambiguous = [u for u, t in rule_results.items() if t == "other"][:150]
    ai_types = await _classify_urls_with_ai(ambiguous)
    logger.info(f"Rule-based: {len(rule_results)} URLs — sent {len(ambiguous)} ambiguous to LLM")

    final_types = {**rule_results, **ai_types}

    all_pages = []
    for u in all_urls:
        page_type = final_types.get(u, "other")
        if page_type not in ("city_service", "service", "location", "blog", "other"):
            page_type = "other"
        if page_type == "blog":
            continue
        all_pages.append({
            "url": u, "title": "", "h1": "", "page_type": page_type,
            "primary_service": None, "primary_city": None,
        })

    def _sort_key(p: dict) -> int:
        return {"city_service": 0, "service": 1, "location": 2, "other": 3}.get(p["page_type"], 3)

    pages = sorted(all_pages, key=_sort_key)[:max_pages]
    logger.info(f"Page discovery complete: {len(pages)} pages from {website_url}")
    return pages


# ── (Optional) page enrichment hook ─────────────────────────────────────────────
async def _ENRICH_PAGES(pages: List[dict]) -> List[dict]:
    """OPTIONAL quality upgrade — populate real title/h1 for service pages.

    Shipped behavior leaves title/h1 empty (URL-only analysis). Implement this to
    fetch each top page and fill in `title`/`h1` (or paragraph text) before the
    ICP call — it materially improves differentiator quality. No-op by default.
    """
    return pages


# ── ICP detection (1 LLM call) ──────────────────────────────────────────────────
async def analyze_business_with_anthropic(
    pages: List[dict],
    business_name: str,
    gbp_category: str,
    gbp_categories: List[str],
) -> dict:
    """Detect ICP + differentiators. Returns { detected_icp, differentiators }."""
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping LLM analysis")
        return {"detected_icp": None, "differentiators": []}

    try:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        has_pages = bool(pages)

        if has_pages:
            page_lines = []
            for p in pages[:25]:
                page_lines.append(
                    f"  [{p['page_type']}] {p['url']}\n"
                    f"    Title: {p['title']}\n"
                    f"    H1: {p['h1']}"
                )
            pages_text = "\n".join(page_lines)
            pages_section = f"""Discovered website pages (URL-classified, may include misclassified blog/content pages):
{pages_text}

IMPORTANT: Before analyzing, mentally discard any pages that look like blog posts, articles, news, or general content (e.g. URLs with date patterns, long descriptive slugs, how-to or tips-style titles). Only use pages that represent actual services, locations, or core business offerings for your analysis."""
        else:
            pages_section = "No website available. Base your analysis entirely on the business name and GBP categories above. Use your knowledge of this business type to infer the most likely customer segments."

        prompt = f"""You are an expert marketing strategist. Analyze this local service business and identify its ideal customer profiles (ICPs) with full psychographic detail.

Business Name: {business_name}
GBP Primary Category: {gbp_category}
All GBP Categories: {', '.join(gbp_categories) if gbp_categories else 'N/A'}

{pages_section}

Identify 1-3 distinct customer segments this business serves. For each segment provide deep psychographic insight a marketer could use to write targeted local SEO content.

Return a JSON object with exactly this structure:
{{
  "detected_icp": {{
    "segments": [
      {{
        "label": "<short human-readable segment name, e.g. 'Emergency Homeowner' or 'Commercial Facilities Manager'>",
        "confidence": <0.0-1.0>,
        "primary": <true for the top segment, false for others>,
        "demographics": {{
          "description": "<age range, income level, ownership status, or business size — whatever is most relevant>",
          "situation": "<the life or business situation that makes them a customer>"
        }},
        "psychographics": {{
          "trigger": "<the specific moment or event that causes them to search — be concrete>",
          "fears": ["<fear 1>", "<fear 2>", "<fear 3>"],
          "motivations": ["<motivation 1>", "<motivation 2>"],
          "buying_behavior": "<1 sentence describing how they evaluate and choose a provider>"
        }},
        "messaging": {{
          "tone": "<the tone that resonates with this segment, e.g. 'Calm and reassuring' or 'Direct and ROI-focused'>",
          "hooks": ["<headline hook 1>", "<headline hook 2>", "<headline hook 3>"],
          "trust_signals": ["<trust signal 1>", "<trust signal 2>", "<trust signal 3>"]
        }}
      }}
    ],
    "reasoning": "<2-3 sentences explaining why these segments were chosen based on the business category and page structure>"
  }},
  "differentiators": [
    {{"claim": "<specific claim from page titles or H1s>", "mechanism": "<how they achieve or back up the claim>", "type": "<speed|cost|guarantee|specialization|availability|other>"}}
  ]
}}

Extract differentiators only from the page titles and H1s of service/core pages. Ignore any content that appears to be blog or editorial. If no differentiators are evident, return an empty array.

Return only valid JSON, no markdown or explanation."""

        message = await client.messages.create(
            model=ANALYSIS_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        text = message.content[0].text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text.strip())
        return json_lib.loads(text)
    except Exception as e:
        logger.error(f"Anthropic analysis error: {e}")
        raise


# ── Render ICP / differentiators into prompt blocks for content generation ──────
def build_icp_text(detected_icp: Optional[dict], max_segments: int = 3) -> str:
    """Render the detected ICP as a plain-text block for a system prompt.

    Primary segment listed first. Returns "" when ICP is empty.
    """
    if not detected_icp:
        return ""
    segments = detected_icp.get("segments") or []
    if not segments:
        return ""

    ordered = sorted(segments, key=lambda s: 0 if s.get("primary") else 1)

    lines = ["TARGET CUSTOMER PROFILES (write to these pain points and motivations):"]
    for seg in ordered[:max_segments]:
        label = seg.get("label") or "Customer"
        marker = " — PRIMARY" if seg.get("primary") else ""
        lines.append(f"  [{label}{marker}]")

        demo = seg.get("demographics") or {}
        if demo.get("description"):
            lines.append(f"    Demographics: {demo['description']}")
        if demo.get("situation"):
            lines.append(f"    Situation: {demo['situation']}")

        psy = seg.get("psychographics") or {}
        if psy.get("trigger"):
            lines.append(f"    Search trigger: {psy['trigger']}")
        if psy.get("fears"):
            lines.append(f"    Fears (address these): {'; '.join(psy['fears'])}")
        if psy.get("motivations"):
            lines.append(f"    Motivations (emphasise these): {'; '.join(psy['motivations'])}")
        if psy.get("buying_behavior"):
            lines.append(f"    Buying behaviour: {psy['buying_behavior']}")

        msg = seg.get("messaging") or {}
        if msg.get("tone"):
            lines.append(f"    Messaging tone: {msg['tone']}")
        if msg.get("hooks"):
            lines.append(f"    Headline hooks: {'; '.join(msg['hooks'])}")
        if msg.get("trust_signals"):
            lines.append(f"    Trust signals: {'; '.join(msg['trust_signals'])}")

    return "\n".join(lines)


def build_differentiators_text(differentiators: Optional[List[dict]]) -> str:
    """Render differentiators as a plain-text block. Returns "" when empty."""
    if not differentiators:
        return ""
    lines = ["DIFFERENTIATORS (weave these in naturally — include the mechanism, not just the claim):"]
    for d in differentiators:
        claim = d.get("claim", "")
        mechanism = d.get("mechanism", "")
        lines.append(f"  - {claim} (mechanism: {mechanism})")
    return "\n".join(lines)


# ── Orchestration ───────────────────────────────────────────────────────────────
async def run_business_analysis(body: BusinessAnalysisRequest) -> BusinessAnalysisResponse:
    """Full pipeline: discover pages → (optional enrich) → ICP LLM call. Framework-agnostic."""
    if body.website_url and body.website_url.strip():
        block_ssrf(body.website_url)

    pages: List[dict] = []
    if body.website_url and body.website_url.strip():
        url = body.website_url.strip()
        if not url.startswith(("http://", "https://")):
            url = f"https://{url}"
        try:
            pages = await asyncio.wait_for(crawl_website(url), timeout=90.0)
        except asyncio.TimeoutError:
            logger.warning(f"Page discovery timed out for {url}")
            pages = []
        if pages:
            pages = await _ENRICH_PAGES(pages)  # no-op unless you implement it

    try:
        llm_result = await analyze_business_with_anthropic(
            pages, body.business_name, body.gbp_category, body.gbp_categories,
        )
    except Exception:
        logger.exception("Anthropic analysis failed")
        raise HTTPException(status_code=502, detail="Analysis service temporarily unavailable")

    status = "complete" if pages else "partial"
    return BusinessAnalysisResponse(
        existing_pages=pages,
        detected_icp=llm_result.get("detected_icp"),
        differentiators=llm_result.get("differentiators", []),
        pages_crawled=len(pages),
        analysis_status=status,
    )


# ── FastAPI router ──────────────────────────────────────────────────────────────
# Replace `_auth_dependency` with your app's auth (API key / JWT). No-op by default.
async def _auth_dependency() -> None:
    return None

router = APIRouter()


@router.post("/analyze-business", response_model=BusinessAnalysisResponse, dependencies=[Depends(_auth_dependency)])
async def analyze_business(request: Request, body: BusinessAnalysisRequest) -> BusinessAnalysisResponse:
    """
    Business setup pipeline:
      1. Sitemap-first page discovery (robots.txt → sitemap.xml → nav fallback)
      2. Classify each page (rule-based + optional LLM for ambiguous URLs)
      3. Detect ICP + differentiators with one LLM call

    To add rate limiting, wrap with slowapi (the original capped at 5/minute).
    """
    return await run_business_analysis(body)
