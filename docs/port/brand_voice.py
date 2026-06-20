"""
Brand Voice Engine — portable, self-contained module.

Ported verbatim (with the cross-app glue removed) from ShowUP Local's
services/nlp/main.py. Drop this file into a FastAPI app and mount the router:

    from brand_voice import router as brand_voice_router
    app.include_router(brand_voice_router)

Or call the pieces directly:

    bv = await analyze_brand_voice(BrandVoiceRequest(
        website_url="https://example.com", business_name="Example Plumbing",
        gbp_category="Plumber",
    ))

Environment variables required:
    ANTHROPIC_API_KEY   — for the 3 LLM analysis calls
    SCRAPEOWL_API_KEY   — for page scraping (optional; see USE_SCRAPEOWL below)

Dependencies (see requirements.txt):
    fastapi, httpx, beautifulsoup4, lxml, anthropic, pydantic
    slowapi  (optional — only for the rate limiter on the router)

Notes on portability:
  * The scraper defaults to ScrapeOwl (premium proxies + optional JS render),
    which is what defeats Cloudflare/WAF and renders SPA/builder sites. If you
    set USE_SCRAPEOWL=false (or leave SCRAPEOWL_API_KEY empty) it falls back to
    a plain httpx GET — fine for simple sites, will fail on bot-protected ones.
  * All prompts and tool schemas are copied verbatim. They mention "local
    service businesses" — adjust the system prompts if your vertical differs.
"""

from __future__ import annotations

import asyncio
import ipaddress as _ipaddress
import json
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
SCRAPEOWL_API_KEY = os.environ.get("SCRAPEOWL_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
SCRAPEOWL_ENDPOINT = "https://api.scrapeowl.com/v1/scrape"
USE_SCRAPEOWL = os.environ.get("USE_SCRAPEOWL", "true").lower() != "false" and bool(SCRAPEOWL_API_KEY)

# Cheap/fast model used for all 3 analysis calls. Forced tool-use guarantees
# schema-valid JSON output, so there's no JSON parse step to fail on.
ANALYSIS_MODEL = os.environ.get("BRAND_VOICE_MODEL", "claude-haiku-4-5-20251001")

CRAWL_HEADERS = {
    "User-Agent": "BrandVoiceBot/1.0 (business-page-discovery; respects robots.txt)",
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
            pass  # Not an IP address — hostname, allow
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")


# ── Request / Response models ──────────────────────────────────────────────────
class BrandVoiceRequest(BaseModel):
    website_url: Optional[str] = None
    business_name: str
    gbp_category: str = ""
    existing_pages: List[dict] = []


class BrandVoiceResponse(BaseModel):
    brand_voice: Optional[dict]
    pages_sampled: int


# ── Page classification vocab ──────────────────────────────────────────────────
STATE_ABBREVS = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
    "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
    "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
    "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
}

SERVICE_WORDS = {
    # Home services
    "repair", "service", "services", "installation", "install", "replacement",
    "maintenance", "inspection", "cleaning", "emergency", "plumbing", "hvac",
    "electrical", "roofing", "pest", "landscaping", "remodeling", "painting",
    "flooring", "gutters", "siding", "windows", "doors", "concrete", "fencing",
    "generator", "insulation", "waterproofing", "restoration", "handyman",
    "appliance", "garage", "deck", "patio", "pool", "irrigation", "sprinkler",
    "locksmith", "mold", "asbestos", "foundation", "basement", "septic", "drain",
    # IT / Tech
    "managed", "cybersecurity", "cyber", "cloud", "network", "backup", "helpdesk",
    "support", "monitoring", "infrastructure", "security", "compliance", "voip",
    "microsoft", "azure", "wireless", "server", "firewall", "endpoint", "siem",
    "consulting", "solutions", "technology", "tech", "software", "hardware", "it",
    # Legal
    "attorney", "lawyer", "litigation", "injury", "divorce", "criminal", "estate",
    "bankruptcy", "immigration", "employment", "law", "legal", "counsel", "defense",
    # Medical / Dental / Health
    "dental", "dentist", "orthodontics", "medical", "clinic", "therapy", "therapist",
    "chiropractic", "physical", "wellness", "cosmetic", "implants", "pediatric",
    "dermatology", "optometry", "vision", "hearing", "counseling", "rehabilitation",
    # Financial
    "accounting", "bookkeeping", "tax", "cpa", "financial", "wealth", "insurance",
    "mortgage", "lending", "investment", "payroll", "audit",
    # Other professional services
    "marketing", "seo", "advertising", "branding", "design", "photography",
    "catering", "moving", "storage", "towing", "auto", "automotive", "collision",
    "salon", "spa", "fitness", "training", "coaching", "tutoring", "staffing",
    "janitorial", "alarm", "surveillance",
}

# First URL segment patterns that indicate blog/content/editorial pages
BLOG_SLUGS = {
    "blog", "news", "insights", "articles", "resources", "resource", "post", "posts",
    "updates", "press", "media", "events", "case-studies", "whitepapers", "guides",
    "tips", "podcast", "webinars", "newsletter", "stories", "learn", "library",
    "knowledge-base", "kb", "forum", "community", "careers", "jobs",
}

# First URL segment patterns to skip entirely
SKIP_SLUGS = {
    "privacy", "terms", "sitemap", "search", "tag", "tags", "category", "categories",
    "author", "wp-content", "wp-admin", "wp-json", "cart", "checkout", "account",
    "login", "register", "feed", "rss", "cdn", "admin", "dashboard", "portal",
}

# URL segment patterns that strongly indicate location/area pages
LOCATION_SLUGS = {
    "service-area", "service-areas", "areas-we-serve", "areas-served",
    "locations", "location", "cities", "city", "coverage", "coverage-area",
    "near-me", "local", "where-we-serve", "our-locations",
}

# Top-level slugs that are definitely NOT service pages
ABOUT_SLUGS = {
    "about", "about-us", "contact", "contact-us", "team", "staff", "our-team",
    "reviews", "testimonials", "gallery", "portfolio", "pricing", "home", "index",
    "sitemap", "accessibility", "disclaimer", "refund", "shipping",
}

# Require a state abbreviation at the END of a path segment (e.g. -tx, -fl) so
# English words that double as state codes (in, or, me, ok) don't trigger geo.
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
    """Rule-based page type classifier.

    Returns { type, primary_service, primary_city }
    Types: service | location | city_service | blog | other
    """
    path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    combined = f"{path} {title} {h1}".lower()
    segments = [s for s in path.split("/") if s]
    first = segments[0] if segments else ""
    path_words = set(re.split(r"[-_]", " ".join(segments)))

    # ── Blog / content pages ──────────────────────────────────────────────────
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

    # ── Skip patterns (admin, privacy, etc.) ─────────────────────────────────
    if first in SKIP_SLUGS:
        return {"type": "other", "primary_service": None, "primary_city": None}

    # ── Geo detection ─────────────────────────────────────────────────────────
    has_geo = bool(
        _STATE_ABBREV_PATTERN.search(path)
        or re.search(r"\b\d{5}\b", combined)
        or any(s in LOCATION_SLUGS for s in segments)
        or "near" in path_words
    )

    # ── Service detection ─────────────────────────────────────────────────────
    has_service = bool(path_words & SERVICE_WORDS or any(w in combined for w in SERVICE_WORDS))

    # ── Classification ────────────────────────────────────────────────────────
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


# ── Scraping ───────────────────────────────────────────────────────────────────
async def _scrape_one(url: str, client: httpx.AsyncClient, render_js: bool = False) -> Optional[str]:
    """Fetch a single page's HTML. Uses ScrapeOwl when configured, else a plain GET.

    render_js=True costs ~2x on ScrapeOwl but handles JS-heavy sites. Returns None on failure.
    """
    if not USE_SCRAPEOWL:
        # Plain-HTTP fallback — fine for simple sites, fails on bot-protected ones.
        try:
            resp = await client.get(url, timeout=20.0, follow_redirects=True, headers=CRAWL_HEADERS)
            if resp.status_code != 200:
                return None
            html = resp.text or ""
            return html if len(html.strip()) >= 200 else None
        except Exception as e:
            logger.warning(f"Plain scrape error for {url}: {type(e).__name__}: {e}")
            return None
    try:
        payload: dict = {
            "api_key": SCRAPEOWL_API_KEY,
            "url": url,
            "premium_proxies": True,
            "country": "us",
            "json_response": True,
        }
        if render_js:
            payload["render_js"] = True
            payload["wait_for_selector"] = "body"
        response = await client.post(
            SCRAPEOWL_ENDPOINT,
            content=json.dumps(payload),
            headers={"Content-Type": "application/json"},
            timeout=45.0,
        )
        if response.status_code != 200:
            logger.warning(f"ScrapeOwl HTTP {response.status_code} for {url}: {response.text[:200]}")
            return None
        data = response.json()
        html = data.get("html") or ""
        if len(html.strip()) < 200:
            logger.warning(f"Thin content ({len(html)} chars) for {url} (render_js={render_js})")
            return None
        return html
    except Exception as e:
        logger.warning(f"Scrape error for {url} (render_js={render_js}): {type(e).__name__}: {e}")
        return None


def _extract_text_from_html(html: str) -> List[str]:
    """Extract clean paragraph text from HTML. Falls back to block lines for builder sites."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "aside"]):
        tag.decompose()
    paragraphs = [el.get_text(" ", strip=True) for el in soup.find_all("p")]
    paragraphs = [t for t in paragraphs if len(t) > 40]
    if not paragraphs:
        # Many builder sites (Duda, Wix, Squarespace) use <div>/<span> not <p>
        lines = soup.get_text("\n", strip=True).splitlines()
        seen = set()
        for line in lines:
            line = line.strip()
            if len(line) > 40 and line not in seen:
                paragraphs.append(line)
                seen.add(line)
            if len(paragraphs) >= 30:
                break
    return paragraphs[:30]


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


async def crawl_pages_for_brand_voice(
    website_url: str, client: httpx.AsyncClient, max_pages: int = 25
) -> List[dict]:
    """Discover up to max_pages voice-representative pages.

    Priority: home → about → top-level service → service → location/city_service → other.
    Skips blog pages and admin/legal slugs.
    """
    block_ssrf(website_url)
    parsed = urllib.parse.urlparse(website_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    sitemap_urls = await _discover_via_sitemap(website_url, client)
    candidate_urls = sitemap_urls if sitemap_urls else await _discover_via_nav(website_url, client)

    homepage = origin
    all_urls = list({homepage} | {u.rstrip("/") for u in candidate_urls} | {website_url.rstrip("/")})

    classified = []
    for url in all_urls:
        result = classify_page_type(url)
        if result["type"] == "blog":
            continue
        path = urllib.parse.urlparse(url).path.lower().rstrip("/")
        first = path.split("/")[1] if "/" in path[1:] else path.lstrip("/")
        if first in SKIP_SLUGS:
            continue
        classified.append({"url": url, "page_type": result["type"]})

    def _priority(p: dict) -> int:
        u = p["url"].rstrip("/")
        path = urllib.parse.urlparse(u).path.lower().rstrip("/")
        segments = [s for s in path.split("/") if s]
        slug = segments[-1] if segments else ""
        if not segments or u in {origin, origin + "/index", origin + "/home"}:
            return 0
        if any(x in slug for x in ("about", "who-we-are", "our-story", "team", "about-us")):
            return 1
        pt = p["page_type"]
        if pt == "service" and len(segments) == 1:
            return 2
        if pt == "service":
            return 3
        if pt in ("location", "city_service"):
            return 4
        return 5

    classified.sort(key=_priority)
    logger.info(f"Brand voice crawl: {len(classified)} candidate pages for {website_url}")
    return classified[:max_pages]


# ── Analysis (3 LLM calls) ──────────────────────────────────────────────────────
VOICE_TOOL = {
    "name": "submit_brand_voice",
    "description": "Submit the analyzed brand voice profile.",
    "input_schema": {
        "type": "object",
        "required": [
            "personality", "tone", "writing_style", "vocabulary",
            "messaging_themes", "sample_phrases", "content_generation_instructions",
        ],
        "properties": {
            "personality": {"type": "array", "description": "3 personality traits.", "items": {"type": "string"}},
            "tone": {"type": "string", "description": "1-2 sentence description of the overall tone."},
            "writing_style": {
                "type": "object",
                "required": ["sentence_length", "person", "jargon_level", "formality"],
                "properties": {
                    "sentence_length": {"type": "string", "description": "short / medium / long / mixed"},
                    "person": {"type": "string", "description": "first person / second person / third person / mixed"},
                    "jargon_level": {"type": "string", "description": "low / medium / high — brief explanation"},
                    "formality": {"type": "string", "description": "casual / professional / formal"},
                },
            },
            "vocabulary": {
                "type": "object",
                "required": ["use", "avoid"],
                "properties": {
                    "use": {"type": "array", "description": "5 words/phrases to use.", "items": {"type": "string"}},
                    "avoid": {"type": "array", "description": "3 words/phrases to avoid.", "items": {"type": "string"}},
                },
            },
            "messaging_themes": {"type": "array", "description": "3 messaging themes.", "items": {"type": "string"}},
            "sample_phrases": {"type": "array", "description": "3 sample phrases that exemplify this voice.", "items": {"type": "string"}},
            "content_generation_instructions": {"type": "string", "description": "2-3 sentences of concrete guidance for writing content that matches this brand voice."},
        },
    },
}

GUIDE_TOOL = {
    "name": "submit_writer_execution_guide",
    "description": "Submit the writer execution guide derived from the recommended brand voice.",
    "input_schema": {
        "type": "object",
        "required": [
            "how_to_think_before_writing", "core_writing_objective", "default_writing_formula",
            "non_negotiable_rules", "sentence_style_do", "sentence_style_dont",
            "rewriting_framework", "before_after_weak", "before_after_strong",
            "seo_aeo_instructions", "ai_writing_rules", "common_failure_modes",
            "quick_cheat_sheet",
        ],
        "properties": {
            "how_to_think_before_writing": {"type": "string", "description": "Role and mindset the writer should assume."},
            "core_writing_objective": {"type": "string", "description": "What every piece of content must achieve."},
            "default_writing_formula": {"type": "string", "description": "e.g. Problem → Consequence → Solution → Outcome — include a concrete example sentence."},
            "non_negotiable_rules": {"type": "array", "description": "5 non-negotiable rules.", "items": {"type": "string"}},
            "sentence_style_do": {"type": "array", "description": "3 DO examples.", "items": {"type": "string"}},
            "sentence_style_dont": {"type": "array", "description": "3 DON'T examples.", "items": {"type": "string"}},
            "rewriting_framework": {"type": "array", "description": "3 rewrite examples (generic→specific, feature→outcome, soft→direct).", "items": {"type": "string"}},
            "before_after_weak": {"type": "string", "description": "A weak copy example."},
            "before_after_strong": {"type": "string", "description": "The improved version of the weak example."},
            "seo_aeo_instructions": {"type": "string", "description": "Guidance for answer-first, scannable content for SEO and AI retrieval."},
            "ai_writing_rules": {"type": "string", "description": "Instructions for maintaining voice when using AI tools."},
            "common_failure_modes": {"type": "array", "description": "3 failure modes paired with fixes.", "items": {"type": "string"}},
            "quick_cheat_sheet": {"type": "array", "description": "5 quick rules.", "items": {"type": "string"}},
        },
    },
}


def _extract_tool_input(message: Any, tool_name: str) -> dict:
    """Pull the structured `input` dict out of a tool_use response block."""
    for block in message.content:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == tool_name:
            return dict(block.input)
    raise ValueError(f"No tool_use block named {tool_name!r} in response")


async def analyze_brand_voice_with_anthropic(
    page_contents: List[str], business_name: str, gbp_category: str = "", **kwargs
) -> dict:
    """Run the 3-call brand voice analysis. Returns the stored brand_voice shape.

    1. Current voice — purely descriptive (skipped when no website content)
    2. Recommended voice — aspirational
    3. Writer Execution Guide — based on the recommended voice
    """
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping brand voice analysis")
        return {}

    import anthropic

    has_content = bool(page_contents)
    content_text = "\n\n---\n\n".join(page_contents) if page_contents else ""
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    current_voice: Optional[dict]
    recommended_voice: dict

    if not has_content:
        # ── No-website path: recommended + guide from category ──
        logger.info(f"Brand voice: no website content for {business_name} — category inference")
        prompt_recommended_no_site = (
            f"Business: {business_name}\n"
            f"GBP Category: {gbp_category}\n\n"
            f"No website is available for this business. Based solely on the business name and category, "
            f"recommend a high-performing brand voice that would work well for a local "
            f"{gbp_category or 'service'} business. Draw on best practices for this business type.\n\n"
            f"Call the submit_brand_voice tool with the recommended brand voice."
        )
        try:
            msg_rec = await client.messages.create(
                model=ANALYSIS_MODEL,
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend a high-performing brand voice based on business type.",
                messages=[{"role": "user", "content": prompt_recommended_no_site}],
            )
            recommended_voice = _extract_tool_input(msg_rec, "submit_brand_voice")
            current_voice = None
        except Exception as e:
            logger.error(f"Brand voice no-site recommended error: {e}")
            recommended_voice = {}
            current_voice = None
    else:
        # ── Website path: Call 1 — Current voice (descriptive) ──
        prompt_current = (
            f"Business: {business_name}\n\n"
            f"Website copy (service, location, and core business pages only):\n"
            f"{content_text[:8000]}\n\n"
            f"Describe the brand voice EXACTLY as it currently exists on this website. "
            f"Be objective and descriptive — report what you observe, do not prescribe or improve anything.\n\n"
            f"Call the submit_brand_voice tool with what you observe."
        )
        try:
            msg1 = await client.messages.create(
                model=ANALYSIS_MODEL,
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a brand analyst. Describe brand voice objectively based on evidence from the website copy. Do not prescribe or recommend — only describe what you observe.",
                messages=[{"role": "user", "content": prompt_current}],
            )
            current_voice = _extract_tool_input(msg1, "submit_brand_voice")
        except Exception as e:
            logger.error(f"Brand voice call 1 error: {e}")
            current_voice = None

        # ── Call 2: Recommended voice (aspirational) ──
        cv_personality = ", ".join((current_voice or {}).get("personality", []))
        cv_tone = (current_voice or {}).get("tone", "")
        prompt_recommended = (
            f"Business: {business_name}\n\n"
            f"Current brand voice:\n"
            f"- Personality: {cv_personality}\n"
            f"- Tone: {cv_tone}\n\n"
            f"Website copy (service, location, and core business pages only):\n"
            f"{content_text[:8000]}\n\n"
            f"Based on the current brand voice and business type, recommend an elevated brand voice that "
            f"would better serve this business. Do NOT simply mirror the existing copy — improve weak or "
            f"generic messaging.\n\n"
            f"Call the submit_brand_voice tool with the recommended brand voice."
        )
        try:
            msg2 = await client.messages.create(
                model=ANALYSIS_MODEL,
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend an elevated, optimized brand voice.",
                messages=[{"role": "user", "content": prompt_recommended}],
            )
            recommended_voice = _extract_tool_input(msg2, "submit_brand_voice")
        except Exception as e:
            logger.error(f"Brand voice call 2 error: {e}")
            recommended_voice = {}

    # ── Call 3 (shared): Writer Execution Guide (based on recommended voice) ──
    guide_lead = (
        "Website copy:" if has_content
        else "No website available — write the guide based on the recommended voice and business category."
    )
    prompt_guide = (
        f"Business: {business_name}\n"
        f"Recommended brand voice summary: {recommended_voice.get('tone', '')}\n"
        f"Personality: {', '.join(recommended_voice.get('personality', []))}\n\n"
        f"{guide_lead}\n"
        f"{content_text[:6000]}\n\n"
        f"Call the submit_writer_execution_guide tool with the writer execution guide."
    )
    try:
        msg3 = await client.messages.create(
            model=ANALYSIS_MODEL,
            max_tokens=3000,
            tools=[GUIDE_TOOL],
            tool_choice={"type": "tool", "name": "submit_writer_execution_guide"},
            system="You are a senior brand strategist and direct-response copywriter building brand voice systems for local service businesses.",
            messages=[{"role": "user", "content": prompt_guide}],
        )
        guide = _extract_tool_input(msg3, "submit_writer_execution_guide")
    except Exception as e:
        logger.error(f"Brand voice call 3 error: {e}")
        guide = {}

    return {
        "current_voice": current_voice,
        "recommended_voice": recommended_voice,
        "recommended_accepted": None,  # null = not yet decided
        "writer_execution_guide": guide,
    }


# ── Render voice into a prompt block for downstream content generation ──────────
def build_brand_voice_text(brand_voice: Optional[dict]) -> str:
    """Render brand voice + writer guide as a plain-text block for a system prompt.

    Defaults to the current voice; switches to the recommended voice only when the
    user explicitly accepted it (recommended_accepted == True). Falls back to the
    other when the chosen voice is missing. Returns "" when there's nothing to inject.
    """
    if not brand_voice:
        return ""
    bv = brand_voice
    if bv.get("recommended_accepted") is True:
        voice = bv.get("recommended_voice") or bv.get("current_voice") or {}
    else:
        voice = bv.get("current_voice") or bv.get("recommended_voice") or {}
    guide = bv.get("writer_execution_guide") or {}
    if not voice and not guide:
        return ""

    lines = ["BRAND VOICE (match this exactly):"]
    if voice.get("tone"):
        lines.append(f"  Tone: {voice['tone']}")
    if voice.get("personality"):
        lines.append(f"  Personality: {', '.join(voice['personality'])}")

    ws = voice.get("writing_style") or {}
    style_parts: List[str] = []
    if ws.get("sentence_length"):
        style_parts.append(f"{ws['sentence_length']} sentences")
    if ws.get("person"):
        style_parts.append(str(ws["person"]))
    if ws.get("formality"):
        style_parts.append(f"{ws['formality']} formality")
    if ws.get("jargon_level"):
        style_parts.append(f"jargon: {ws['jargon_level']}")
    if style_parts:
        lines.append(f"  Writing style: {', '.join(style_parts)}")

    vocab = voice.get("vocabulary") or {}
    if vocab.get("use"):
        lines.append(f"  Words/phrases to use: {', '.join(vocab['use'])}")
    if vocab.get("avoid"):
        lines.append(f"  Words/phrases to avoid: {', '.join(vocab['avoid'])}")
    if voice.get("messaging_themes"):
        lines.append(f"  Messaging themes: {'; '.join(voice['messaging_themes'])}")
    if voice.get("sample_phrases"):
        lines.append(f"  Sample phrases (mirror this style): {'; '.join(voice['sample_phrases'])}")
    if voice.get("content_generation_instructions"):
        lines.append(f"  Writer instructions: {voice['content_generation_instructions']}")

    if isinstance(guide, dict) and guide:
        if guide.get("default_writing_formula"):
            lines.append(f"  Default writing formula: {guide['default_writing_formula']}")
        for key, label in (
            ("non_negotiable_rules", "Non-negotiable rules"),
            ("sentence_style_do", "Sentence style — DO"),
            ("sentence_style_dont", "Sentence style — DON'T"),
            ("quick_cheat_sheet", "Quick cheat sheet"),
        ):
            items = guide.get(key) or []
            if items:
                lines.append(f"  {label}:")
                for item in items:
                    lines.append(f"    - {item}")

    return "\n".join(lines)


# ── Orchestration ───────────────────────────────────────────────────────────────
async def run_brand_voice_analysis(body: BrandVoiceRequest) -> BrandVoiceResponse:
    """Full pipeline: probe → crawl → scrape (2 tiers) → 3 LLM calls. Framework-agnostic."""
    if body.website_url and body.website_url.strip():
        block_ssrf(body.website_url)
    page_contents: List[str] = []
    pages_sampled = 0

    if body.website_url and body.website_url.strip():
        url = body.website_url.strip()
        if not url.startswith(("http://", "https://")):
            url = f"https://{url}"

        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=CRAWL_HEADERS) as client:
            # Probe first to catch dead links / 4xx errors
            try:
                probe = await client.get(url, timeout=10.0)
                if probe.status_code >= 400:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Your website returned a {probe.status_code} error. Check that the URL is correct and the site is live.",
                    )
            except httpx.RequestError as e:
                logger.warning(f"Brand voice website probe failed for {url}: {type(e).__name__}: {e}")
                raise HTTPException(
                    status_code=422,
                    detail="Your website couldn't be reached. Check that the URL is correct and your site is live.",
                )
            selected = await crawl_pages_for_brand_voice(url, client, max_pages=25)

        async def _scrapeowl_extract(pages: List[dict], render_js: bool) -> List[str]:
            sem = asyncio.Semaphore(8)

            async def _bounded(p: dict, sc_client: httpx.AsyncClient) -> Optional[str]:
                async with sem:
                    return await _scrape_one(p["url"], sc_client, render_js=render_js)

            async with httpx.AsyncClient() as sc:
                htmls = await asyncio.gather(*[_bounded(p, sc) for p in pages], return_exceptions=True)
            results = []
            for p, html in zip(pages, htmls):
                if not html or isinstance(html, Exception):
                    continue
                paragraphs = _extract_text_from_html(html)
                text = " ".join(paragraphs)
                if text.strip():
                    results.append(f"[{p.get('page_type', 'page')}] {p['url']}\n{text[:600]}")
            return results

        # Tier 1: no JS
        logger.info(f"Brand voice: scraping {len(selected)} pages for {url}")
        page_contents = await _scrapeowl_extract(selected, render_js=False)
        pages_sampled = len(page_contents)

        # Tier 2: JS render fallback for the top 5 pages
        if not page_contents and selected:
            logger.info("Brand voice: no text from tier 1 — retrying top 5 pages with JS render")
            page_contents = await _scrapeowl_extract(selected[:5], render_js=True)
            pages_sampled = len(page_contents)
            if not page_contents:
                logger.warning("Brand voice: all scraping tiers failed — falling back to category inference")
    else:
        logger.info(f"Brand voice: no website for {body.business_name} — using category inference")

    try:
        brand_voice = await analyze_brand_voice_with_anthropic(
            page_contents, body.business_name, gbp_category=body.gbp_category,
        )
    except Exception as e:
        identifier = body.website_url or body.business_name
        logger.error(f"Brand voice Anthropic error for {identifier}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Our AI analysis service encountered an error. Please try again.",
        )

    return BrandVoiceResponse(brand_voice=brand_voice, pages_sampled=pages_sampled)


# ── FastAPI router ──────────────────────────────────────────────────────────────
# Replace `_auth_dependency` with your app's auth (API key / JWT). No-op by default.
async def _auth_dependency() -> None:
    return None

router = APIRouter()


@router.post("/analyze-brand-voice", response_model=BrandVoiceResponse, dependencies=[Depends(_auth_dependency)])
async def analyze_brand_voice(request: Request, body: BrandVoiceRequest) -> BrandVoiceResponse:
    """
    Brand voice pipeline:
      - With website: crawl up to 25 pages, extract text, analyze with the LLM.
      - Without website: generate category-based recommended voice with the LLM.

    To add rate limiting, wrap with slowapi, e.g.:
        from slowapi import Limiter
        limiter = Limiter(key_func=get_remote_address)
        # then decorate with @limiter.limit("5/minute") and pass `request`.
    """
    return await run_brand_voice_analysis(body)
