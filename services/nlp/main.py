import sys
import os
import logging
import asyncio
import base64
import json
import re
import time

# Configure logging to stderr so Railway captures it
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

logger.info("NLP service starting...")
logger.info(f"PORT={os.environ.get('PORT', 'not set')}")
logger.info(f"Python version: {sys.version}")
logger.info(f"Working directory: {os.getcwd()}")
logger.info(f"Files in cwd: {os.listdir('.')}")

try:
    from fastapi import FastAPI, HTTPException, Depends, Security, Request
    from fastapi.responses import StreamingResponse
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.security import APIKeyHeader
    from pydantic import BaseModel
    from typing import List, Dict, Optional
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    import re
    from collections import defaultdict
    logger.info("Basic imports done")

    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    import numpy as np
    logger.info("sklearn/numpy imports done")

    import nltk
    from nltk.corpus import stopwords
    from nltk.util import ngrams
    from nltk.tokenize import word_tokenize
    logger.info("nltk imports done")

    from bs4 import BeautifulSoup
    logger.info("bs4 imports done")

    import httpx
    logger.info("httpx imports done")
except Exception as e:
    logger.error(f"Import failed: {e}")
    raise

# Download required NLTK data on startup
try:
    nltk.download('stopwords', quiet=True)
    nltk.download('punkt', quiet=True)
    nltk.download('punkt_tab', quiet=True)
    logger.info("NLTK data downloaded")
except Exception as e:
    logger.error(f"NLTK download failed: {e}")
    raise

app = FastAPI()

# ── Rate limiting ──────────────────────────────────────────────────────────────
# All requests arrive via the Supabase nlp-proxy edge function, so X-Forwarded-For
# is the Supabase server IP — useless for per-client limiting. The proxy sets
# X-User-ID to the authenticated Supabase user ID, which we use as the rate limit
# key so each user gets their own independent bucket.
def _real_client_ip(request: Request) -> str:
    user_id = request.headers.get("X-User-ID", "")
    if user_id:
        return user_id
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP", "")
    if real_ip:
        return real_ip.strip()
    return get_remote_address(request)

limiter = Limiter(key_func=_real_client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Reads allowed origins from CORS_ORIGINS env var (comma-separated).
# Falls back to * in development. Tighten to your Railway/Vercel frontend
# URL in production via the Railway dashboard.
_cors_raw = os.environ.get("CORS_ORIGINS", "*")
CORS_ORIGINS = [o.strip() for o in _cors_raw.split(",") if o.strip()]
_cors_wildcard = CORS_ORIGINS == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=not _cors_wildcard,  # Never allow credentials with *
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info(f"CORS origins: {CORS_ORIGINS}")

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

class LimitRequestSizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > 2_000_000:  # 2MB limit
            from starlette.responses import JSONResponse
            return JSONResponse({"detail": "Request body too large"}, status_code=413)
        return await call_next(request)

app.add_middleware(LimitRequestSizeMiddleware)

STOP_WORDS = set(stopwords.words('english'))

# ── API credentials (set all in Railway environment variables) ────────────────
GOOGLE_NLP_API_KEY   = os.environ.get("GOOGLE_NLP_API_KEY", "")
DATAFORSEO_LOGIN     = os.environ.get("DATAFORSEO_LOGIN", "")
DATAFORSEO_PASSWORD  = os.environ.get("DATAFORSEO_PASSWORD", "")
SCRAPEOWL_API_KEY    = os.environ.get("SCRAPEOWL_API_KEY", "")
ANTHROPIC_API_KEY    = os.environ.get("ANTHROPIC_API_KEY", "")
NLP_API_KEY          = os.environ.get("NLP_API_KEY", "")

# ── Supabase (for direct JWT auth + credit management, bypassing edge function) ──
SUPABASE_URL              = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY         = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# ── API key auth dependency ───────────────────────────────────────────────────
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Security(_api_key_header)):
    """Validates X-API-Key header. Fails closed — rejects all requests if NLP_API_KEY is unset."""
    if not NLP_API_KEY:
        raise HTTPException(status_code=503, detail="Service authentication not configured")
    if api_key != NLP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return api_key

# ── Direct JWT auth helpers (used when frontend calls Railway without the proxy) ─
async def _verify_jwt_get_user(authorization: str) -> str:
    """Verify a Supabase JWT and return the user_id, or raise 401."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise HTTPException(status_code=503, detail="Supabase not configured on this service")
    token = authorization[7:]
    async with httpx.AsyncClient(timeout=10) as hx:
        r = await hx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return r.json()["id"]

async def _deduct_credits_direct(user_id: str, amount: int, endpoint: str, description: str) -> bool:
    """Deduct credits via Supabase service role. Returns False if insufficient credits."""
    async with httpx.AsyncClient(timeout=10) as hx:
        r = await hx.post(
            f"{SUPABASE_URL}/rest/v1/rpc/deduct_credits",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json={"p_user_id": user_id, "p_amount": amount, "p_endpoint": endpoint, "p_description": description},
        )
    if r.status_code != 200:
        logger.error(f"_deduct_credits_direct: {r.status_code} {r.text}")
        return False
    return r.json() is True


async def _refund_credits_direct(user_id: str, amount: int, endpoint: str) -> None:
    """Refund credits via Supabase service role. Fire-and-forget on failure."""
    try:
        async with httpx.AsyncClient(timeout=10) as hx:
            await hx.post(
                f"{SUPABASE_URL}/rest/v1/rpc/refund_credits",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                },
                json={"p_user_id": user_id, "p_amount": amount, "p_endpoint": endpoint},
            )
    except Exception as exc:
        logger.warning(f"_refund_credits_direct failed: {exc}")

GOOGLE_NLP_ENDPOINT  = "https://language.googleapis.com/v1/documents:analyzeEntities"
DATAFORSEO_ENDPOINT  = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
SCRAPEOWL_ENDPOINT   = "https://api.scrapeowl.com/v1/scrape"

logger.info("App initialized, ready to serve")
for name, val in [
    ("GOOGLE_NLP_API_KEY", GOOGLE_NLP_API_KEY),
    ("DATAFORSEO_LOGIN",   DATAFORSEO_LOGIN),
    ("SCRAPEOWL_API_KEY",  SCRAPEOWL_API_KEY),
    ("ANTHROPIC_API_KEY",  ANTHROPIC_API_KEY),
]:
    if val:
        logger.info(f"{name} is set")
    else:
        logger.warning(f"{name} not set — related feature will be skipped")

# ── Constants ─────────────────────────────────────────────────────────────────
ZONES = ["title", "h1", "h2_h3", "paragraphs"]

RELATED_MIN_PAGE_SPREAD  = 0.49
RELATED_MIN_SIMILARITY   = 0.1
QUADGRAM_MIN_PAGE_SPREAD = 0.49
QUADGRAM_MIN_SIMILARITY  = 0.1
ENTITY_MIN_PAGE_SPREAD   = 0.49
ENTITY_MIN_SALIENCE      = 0.40
GOOGLE_NLP_MAX_BYTES     = 100_000

# DataForSEO: how many organic results to request
SERP_RESULT_COUNT = 20

# API cost estimates (USD) — used for per-generation cost breakdown display
# DataForSEO organic SERP live/advanced: ~$0.0025 per task
COST_DATAFORSEO_PER_ANALYSIS  = 0.0025
# ScrapeOwl without JS: ~$0.0075/page; with JS render: ~$0.015/page
COST_SCRAPEOWL_PER_PAGE       = 0.0075
COST_SCRAPEOWL_PER_PAGE_JS    = 0.0150
# Google Natural Language API entity analysis: $0.001 per 1,000 chars
COST_GOOGLE_NLP_PER_1K_CHARS  = 0.001

# Domains to skip — directories, aggregators, social, video
# Intentionally whitelisted: reddit.com, linkedin.com, facebook.com, quora.com
SKIP_DOMAINS = {
    "yelp.com", "yellowpages.com", "bbb.org", "angi.com", "thumbtack.com",
    "homeadvisor.com", "houzz.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "tiktok.com",
    "wikipedia.org", "amazon.com", "ebay.com",
    "angieslist.com", "nextdoor.com", "mapquest.com", "maps.google.com",
}


import ipaddress as _ipaddress
import urllib.parse as _urlparse


def _block_ssrf(url: str) -> None:
    """Raise HTTPException 400 if the URL targets a private/internal network."""
    try:
        parsed = _urlparse.urlparse(url)
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


# ── Request / Response models ─────────────────────────────────────────────────

class AnalysisRequest(BaseModel):
    keyword: str
    location: str                        # e.g. "Anaheim, California, United States"
    location_code: Optional[int] = None  # DataForSEO numeric location code (preferred)
    urls: Optional[List[str]] = None     # override SERP lookup — pass URLs directly


class ZoneKeywords(BaseModel):
    title: List[dict]
    h1: List[dict]
    h2_h3: List[dict]
    paragraphs: List[dict] = []


class AnalysisResponse(BaseModel):
    keyword: str
    location: str
    serp_urls: List[str]                 # URLs that were actually scraped + analysed
    related_keywords: ZoneKeywords
    top_quadgrams: List[dict]
    google_entities: List[dict]
    serp_bold_keywords: List[dict] = []       # bolded terms from SERP snippets + competitor usage
    zone_targets: Dict[str, dict] = {}        # max term/entity counts per zone across competitors
    competitor_headings: List[dict] = []      # H2/H3 strings scraped from competitor pages
    analysis_cost: dict = {}                  # estimated API costs for this analysis run


# ── Step 1: DataForSEO — fetch top organic SERP URLs ─────────────────────────

async def fetch_serp_urls(keyword: str, location: str, client: httpx.AsyncClient, location_code: Optional[int] = None) -> tuple:
    """
    Calls DataForSEO organic live/advanced to get the top SERP_RESULT_COUNT
    organic URLs for keyword + location. Also extracts highlighted/bold terms
    from SERP titles and descriptions.

    Returns (urls: List[str], bold_terms: List[str]).
    """
    if not DATAFORSEO_LOGIN or not DATAFORSEO_PASSWORD:
        logger.warning("DataForSEO credentials not set — skipping SERP fetch")
        return [], []

    credentials = base64.b64encode(
        f"{DATAFORSEO_LOGIN}:{DATAFORSEO_PASSWORD}".encode()
    ).decode()

    loc_field = {"location_code": location_code} if location_code else {"location_name": location}
    payload = [{
        "keyword": keyword,
        **loc_field,
        "language_name": "English",
        "depth": SERP_RESULT_COUNT,
        "se_domain": "google.com",
    }]

    try:
        response = await client.post(
            DATAFORSEO_ENDPOINT,
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

        urls = []
        bold_terms_raw: set = set()
        kw_lower = keyword.lower().strip()
        kw_words = set(kw_lower.split())

        for task in (data.get("tasks") or []):
            for result in (task.get("result") or []):
                for item in (result.get("items") or []):
                    if item.get("type") != "organic":
                        continue
                    url = item.get("url", "")
                    if not url:
                        continue
                    # Skip non-HTML extensions
                    if re.search(r'\.(pdf|docx?|xlsx?|pptx?|zip)$', url, re.I):
                        continue
                    # Skip blocklisted domains
                    domain = re.sub(r'^www\.', '', httpx.URL(url).host)
                    if any(domain == d or domain.endswith('.' + d) for d in SKIP_DOMAINS):
                        continue

                    # Extract highlighted/bold terms from this item
                    for hl in (item.get("highlighted") or []):
                        hl_clean = hl.strip().lower()
                        # Skip if it's just the exact keyword or a subset of keyword words
                        if hl_clean and hl_clean != kw_lower and set(hl_clean.split()) != kw_words:
                            bold_terms_raw.add(hl_clean)

                    urls.append(url)
                    if len(urls) >= SERP_RESULT_COUNT:
                        break

        bold_terms = sorted(bold_terms_raw)
        logger.info(f"DataForSEO returned {len(urls)} usable URLs, {len(bold_terms)} bold terms for '{keyword}'")
        return urls, bold_terms

    except Exception as e:
        logger.warning(f"DataForSEO error: {e}")
        return [], []


# ── Phone number linkification ────────────────────────────────────────────────

_PHONE_RE = re.compile(
    r'(?<!["\'/=])'                        # not inside an attribute or URL
    r'(\+?1[\s.\-]?)?'                     # optional country code
    r'(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})'  # core 10-digit pattern
    r'(?![^<]*>)'                          # not inside an HTML tag
)

def _linkify_phones(html: str, phone: Optional[str] = None) -> str:
    """
    Wrap bare phone numbers in <a href="tel:..."> links.
    Already-linked numbers (inside <a href="tel:...">...</a>) are left alone.
    If `phone` is provided it is used to build the canonical tel: digits;
    otherwise digits are extracted directly from the matched text.
    """
    if not html:
        return html

    # Build canonical digits from the business phone if available
    canonical_digits: Optional[str] = None
    if phone:
        canonical_digits = re.sub(r'\D', '', phone)
        if len(canonical_digits) == 11 and canonical_digits.startswith('1'):
            canonical_digits = canonical_digits[1:]  # strip leading 1

    def _replace(m: re.Match) -> str:
        matched = m.group(0)
        digits = re.sub(r'\D', '', matched)
        # Use last 10 digits to handle +1 prefix
        digits = digits[-10:] if len(digits) >= 10 else digits
        if len(digits) < 10:
            return matched  # not a real phone number, leave alone
        tel = canonical_digits if (canonical_digits and canonical_digits == digits) else digits
        return f'<a href="tel:{tel}">{matched}</a>'

    # Split on existing tel: links so we don't double-wrap
    _TEL_LINK_RE = re.compile(r'(<a\s[^>]*href=["\']tel:[^>]*>.*?</a>)', re.IGNORECASE | re.DOTALL)
    parts = _TEL_LINK_RE.split(html)
    result = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            # This is an existing tel: link — leave untouched
            result.append(part)
        else:
            result.append(_PHONE_RE.sub(_replace, part))
    return "".join(result)


_RDFA_TYPE_MAP: Dict[str, str] = {
    "LOCATION":      "Place",
    "ORGANIZATION":  "Organization",
    "PERSON":        "Person",
    "EVENT":         "Event",
    "WORK_OF_ART":   "CreativeWork",
    "CONSUMER_GOOD": "Product",
}
# Tags whose text content must not be modified
_RDFA_SKIP_OPEN  = re.compile(r'^<(a|script|style|code|pre|title|head|link|meta)[\s>/]', re.IGNORECASE)
_RDFA_SKIP_CLOSE = re.compile(r'^</(a|script|style|code|pre|title|head)>', re.IGNORECASE)


def _apply_rdfa_markup(html: str, entities: list) -> str:
    """Wrap first occurrence of each KG entity in an RDFa span with sameAs link.

    Format:
      <span vocab="https://schema.org/" typeof="Place" property="name" content="Anaheim">
        <link property="sameAs" href="https://www.google.com/search?kgmid=/m/0r5yc"/>
        Anaheim
      </span>

    Only entities that have a Knowledge Graph mid are marked up.
    Longest entity names are processed first to avoid substring conflicts.
    Each entity is marked only on its first occurrence.
    Text inside <a>, <script>, <style>, <code>, <pre> tags is left untouched.
    """
    import html as _html_mod

    kg_entities = sorted(
        [e for e in entities if e.get("mid")],
        key=lambda e: len(e["name"]),
        reverse=True,  # longest first — prevents "Orange" matching inside "Orange County"
    )
    if not kg_entities:
        return html

    marked: set = set()

    # Split into alternating [text, tag, text, tag, …] segments
    segments = re.split(r'(<[^>]*>)', html)
    in_skip = 0
    result: list = []

    for i, seg in enumerate(segments):
        if i % 2 == 1:  # HTML tag
            if _RDFA_SKIP_OPEN.match(seg):
                in_skip += 1
            elif _RDFA_SKIP_CLOSE.match(seg):
                in_skip = max(0, in_skip - 1)
            result.append(seg)
            continue

        # Text segment
        if in_skip or not seg:
            result.append(seg)
            continue

        text = seg
        for entity in kg_entities:
            name = entity["name"]
            if name in marked:
                continue
            mid          = entity["mid"]
            schema_type  = _RDFA_TYPE_MAP.get(entity.get("entity_type", ""), "Thing")
            kg_url       = f"https://www.google.com/search?kgmid={mid}"
            pat          = re.compile(r'\b' + re.escape(name) + r'\b', re.IGNORECASE)
            m            = pat.search(text)
            if m:
                rdfa = (
                    f'<span vocab="https://schema.org/" typeof="{schema_type}" '
                    f'property="name" content="{_html_mod.escape(name)}">'
                    f'<link property="sameAs" href="{kg_url}"/>'
                    f'{m.group()}</span>'
                )
                text = text[:m.start()] + rdfa + text[m.end():]
                marked.add(name)

        result.append(text)

    return "".join(result)


# ── Step 2: ScrapeOwl — fetch raw HTML for each URL ──────────────────────────

async def _scrape_one(url: str, client: httpx.AsyncClient, render_js: bool = False) -> Optional[str]:
    """
    Single ScrapeOwl request. render_js=True costs ~2× but handles JS-heavy sites.
    Returns None on failure.
    """
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
            payload["wait_for_selector"] = "body"   # wait until body is present
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


async def scrape_urls(urls: List[str]) -> tuple[List[str], dict]:
    """
    Hybrid two-pass scraper:
      Pass 1 — render_js=False (fast, cheap) for all URLs concurrently.
      Pass 2 — render_js=True  (JS rendering) only for URLs that failed/returned thin HTML.

    Returns (pages, cost_info) where pages contains only non-empty HTML strings.
    cost_info breaks down pages scraped at each tier for billing.
    """
    sem = asyncio.Semaphore(10)

    async def attempt(url: str, render_js: bool) -> Optional[str]:
        async with sem:
            return await _scrape_one(url, client, render_js=render_js)

    async with httpx.AsyncClient() as client:
        # Pass 1: no JS
        pass1 = await asyncio.gather(*[attempt(url, False) for url in urls])
        failed_urls = [url for url, html in zip(urls, pass1) if not html]

        # Pass 2: retry failures with JS rendering
        pass2: List[Optional[str]] = []
        if failed_urls:
            logger.info(f"Retrying {len(failed_urls)} failed URLs with JS rendering")
            pass2 = await asyncio.gather(*[attempt(url, True) for url in failed_urls])

    # Merge: keep pass1 results, fill gaps with pass2
    fail_iter = iter(pass2)
    merged: List[Optional[str]] = []
    for html in pass1:
        if html:
            merged.append(html)
        else:
            merged.append(next(fail_iter, None))

    pages = [html for html in merged if html]
    js_success = sum(1 for html in pass2 if html)
    no_js_success = len(pages) - js_success
    logger.info(
        f"Scraping complete: {len(pages)}/{len(urls)} pages "
        f"(no-JS: {no_js_success}, JS-render: {js_success}, failed: {len(urls) - len(pages)})"
    )
    cost_info = {
        "no_js_pages": no_js_success,
        "js_pages": js_success,
    }
    return pages, cost_info


# ── HTML parsing ──────────────────────────────────────────────────────────────

def extract_zones(html: str) -> Dict:
    """Parse HTML and return text extracted per zone plus raw heading lists."""
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("title")
    title_text = title_tag.get_text(separator=" ", strip=True) if title_tag else ""

    h1_tags = soup.find_all("h1")
    h1_text = " ".join(t.get_text(separator=" ", strip=True) for t in h1_tags)

    h2h3_tags = soup.find_all(["h2", "h3"])
    h2h3_text = " ".join(t.get_text(separator=" ", strip=True) for t in h2h3_tags)

    # Raw heading strings for competitor heading analysis
    h2_list = [t.get_text(separator=" ", strip=True) for t in soup.find_all("h2")
               if t.get_text(strip=True)]
    h3_list = [t.get_text(separator=" ", strip=True) for t in soup.find_all("h3")
               if t.get_text(strip=True)]

    p_tags = soup.find_all("p")
    paragraph_text = " ".join(t.get_text(separator=" ", strip=True) for t in p_tags)

    for tag in soup(["script", "style", "noscript", "title", "h1", "h2", "h3"]):
        tag.decompose()
    body_text = soup.get_text(separator=" ", strip=True)

    return {
        "title": title_text,
        "h1": h1_text,
        "h2_h3": h2h3_text,
        "body": body_text,
        "paragraphs": paragraph_text,
        "h2_list": h2_list,
        "h3_list": h3_list,
    }


def clean_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'http\S+', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()


# ── NLP: related keywords ─────────────────────────────────────────────────────

def get_related_keywords_for_zone(
    zone_docs: List[str],
    keyword: str,
    min_page_spread: float = RELATED_MIN_PAGE_SPREAD,
    min_similarity: float = RELATED_MIN_SIMILARITY,
) -> List[dict]:
    cleaned = [clean_text(d) for d in zone_docs if d and len(d.strip()) > 5]
    if len(cleaned) < 2:
        return []

    total_pages = len(cleaned)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=1000,
        min_df=2,
        max_df=0.95,
    )
    try:
        tfidf_matrix = vectorizer.fit_transform(cleaned)
        keyword_vec = vectorizer.transform([clean_text(keyword)])
    except ValueError:
        return []

    feature_names = vectorizer.get_feature_names_out()
    tfidf_array = tfidf_matrix.toarray()
    page_keyword_sims = cosine_similarity(keyword_vec, tfidf_matrix)[0]
    keyword_clean = clean_text(keyword)
    results = []

    for i, term in enumerate(feature_names):
        if term == keyword_clean:
            continue
        pages_with_term = np.where(tfidf_array[:, i] > 0)[0]
        page_count = len(pages_with_term)
        if page_count < min_pages_required:
            continue
        mean_sim = float(page_keyword_sims[pages_with_term].mean())
        if mean_sim >= min_similarity:
            results.append({
                "term": term,
                "score": round(mean_sim, 4),
                "page_spread": page_count,
                "page_spread_pct": round(page_count / total_pages, 2),
                "type": "related",
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results


# ── NLP: quadgrams ────────────────────────────────────────────────────────────

def get_top_quadgrams(
    paragraph_docs: List[str],
    keyword: str,
    min_page_spread: float = QUADGRAM_MIN_PAGE_SPREAD,
    min_similarity: float = QUADGRAM_MIN_SIMILARITY,
) -> List[dict]:
    total_pages = len(paragraph_docs)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    quadgram_pages: Dict[tuple, set] = defaultdict(set)
    for page_idx, doc in enumerate(paragraph_docs):
        text = clean_text(doc)
        tokens = word_tokenize(text)
        filtered = [t for t in tokens if t.isalpha() and t not in STOP_WORDS and len(t) > 2]
        seen_this_page = set()
        for gram in ngrams(filtered, 4):
            if gram not in seen_this_page:
                quadgram_pages[gram].add(page_idx)
                seen_this_page.add(gram)

    spread_qualified = {
        gram: pages
        for gram, pages in quadgram_pages.items()
        if len(pages) >= min_pages_required
    }
    if not spread_qualified:
        return []

    cleaned_docs = [clean_text(d) for d in paragraph_docs if d and len(d.strip()) > 5]
    if not cleaned_docs:
        return []

    candidate_phrases = [' '.join(gram) for gram in spread_qualified]
    try:
        vectorizer = TfidfVectorizer(ngram_range=(1, 4), stop_words='english', min_df=1)
        tfidf_matrix = vectorizer.fit_transform(cleaned_docs + candidate_phrases + [keyword])
    except ValueError:
        return []

    keyword_vec = np.asarray(tfidf_matrix[-1].todense())
    phrase_start_idx = len(cleaned_docs)
    results = []

    for i, (gram, pages) in enumerate(spread_qualified.items()):
        phrase_vec = np.asarray(tfidf_matrix[phrase_start_idx + i].todense())
        sim = float(cosine_similarity(keyword_vec, phrase_vec)[0][0])
        if sim >= min_similarity:
            results.append({
                "phrase": ' '.join(gram),
                "page_spread": len(pages),
                "page_spread_pct": round(len(pages) / total_pages, 2),
                "similarity_score": round(sim, 4),
                "type": "quadgram",
            })

    results.sort(key=lambda x: (x["page_spread"], x["similarity_score"]), reverse=True)
    return results


# ── NLP: Google entity analysis ───────────────────────────────────────────────

async def fetch_google_entities(text: str, client: httpx.AsyncClient) -> List[dict]:
    if not GOOGLE_NLP_API_KEY or not text.strip():
        return []
    encoded = text.encode("utf-8")[:GOOGLE_NLP_MAX_BYTES]
    safe_text = encoded.decode("utf-8", errors="ignore")
    try:
        response = await client.post(
            GOOGLE_NLP_ENDPOINT,
            params={"key": GOOGLE_NLP_API_KEY},
            json={"document": {"type": "PLAIN_TEXT", "content": safe_text}, "encodingType": "UTF8"},
            timeout=15.0,
        )
        response.raise_for_status()
        return response.json().get("entities", [])
    except Exception as e:
        logger.warning(f"Google NLP API error: {e}")
        return []


async def get_google_entities(
    paragraph_docs: List[str],
    min_page_spread: float = ENTITY_MIN_PAGE_SPREAD,
    min_salience: float = ENTITY_MIN_SALIENCE,
) -> List[dict]:
    if not GOOGLE_NLP_API_KEY:
        return []

    total_pages = len(paragraph_docs)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    async with httpx.AsyncClient() as client:
        per_page_entities = await asyncio.gather(
            *[fetch_google_entities(doc, client) for doc in paragraph_docs]
        )

    entity_data: Dict[tuple, Dict] = defaultdict(lambda: {
        "saliences": [], "mention_counts": [], "pages": set(),
    })

    for page_idx, entities in enumerate(per_page_entities):
        seen_this_page = set()
        for entity in entities:
            name = entity.get("name", "").strip()
            etype = entity.get("type", "UNKNOWN")
            salience = entity.get("salience", 0.0)
            mention_count = len(entity.get("mentions", []))
            mid = entity.get("metadata", {}).get("mid", "")
            if not name:
                continue
            key = (name.lower(), etype)
            if key not in seen_this_page:
                entity_data[key]["saliences"].append(salience)
                entity_data[key]["mention_counts"].append(mention_count)
                entity_data[key]["pages"].add(page_idx)
                entity_data[key]["name"] = name
                entity_data[key]["entity_type"] = etype
                if mid and not entity_data[key].get("mid"):
                    entity_data[key]["mid"] = mid
                seen_this_page.add(key)

    results = []
    for key, data in entity_data.items():
        page_count = len(data["pages"])
        if page_count < min_pages_required:
            continue
        mean_salience = float(np.mean(data["saliences"]))
        if mean_salience < min_salience:
            continue
        recommended_mentions = int(round(float(np.mean(data["mention_counts"]))))
        results.append({
            "name": data["name"],
            "entity_type": data["entity_type"],
            "mid": data.get("mid", ""),
            "mean_salience": round(mean_salience, 4),
            "page_spread": page_count,
            "page_spread_pct": round(page_count / total_pages, 2),
            "recommended_mentions": max(1, recommended_mentions),
            "type": "google_entity",
        })

    results.sort(key=lambda x: x["mean_salience"], reverse=True)
    return results


# ── Endpoint ──────────────────────────────────────────────────────────────────

async def _run_serp_analysis(
    keyword: str,
    location: str,
    location_code: Optional[int] = None,
    urls: Optional[List[str]] = None,
) -> AnalysisResponse:
    """
    Shared SERP analysis pipeline used by both /analyze and /score-page.
    Runs DataForSEO → ScrapeOwl (hybrid JS retry) → TF-IDF → quadgrams → Google NLP.
    """
    # Step 1: get URLs + bold terms from SERP snippets
    bold_terms_from_serp: List[str] = []
    if urls:
        serp_urls = urls
        logger.info(f"Using {len(serp_urls)} manually provided URLs")
    else:
        async with httpx.AsyncClient() as client:
            serp_urls, bold_terms_from_serp = await fetch_serp_urls(keyword, location, client, location_code)
        if not serp_urls:
            raise HTTPException(status_code=502, detail="DataForSEO returned no usable URLs")

    # Step 2: scrape (hybrid: no-JS first, retry failures with JS rendering)
    pages, scrape_cost_info = await scrape_urls(serp_urls)
    if len(pages) < 2:
        raise HTTPException(
            status_code=502,
            detail=f"Only {len(pages)} pages scraped successfully — need at least 2"
        )

    # Step 3: parse zones
    zone_buckets: Dict[str, List[str]] = {z: [] for z in ZONES}
    h2_per_page: List[List[str]] = []
    h3_per_page: List[List[str]] = []
    scraped_urls: List[str] = []
    # Store full page text per page for bold keyword counting
    full_page_texts: List[str] = []
    for url, html in zip(serp_urls, pages):
        zones = extract_zones(html)
        for z in ZONES:
            zone_buckets[z].append(zones[z])
        h2_per_page.append(zones.get("h2_list", []))
        h3_per_page.append(zones.get("h3_list", []))
        scraped_urls.append(url)
        # Combine all text zones for bold term counting
        full_page_texts.append(
            " ".join(zones[z] for z in ("title", "h1", "h2_h3", "paragraphs") if zones.get(z)).lower()
        )

    # Step 4: NLP analysis
    related = ZoneKeywords(
        title=get_related_keywords_for_zone(zone_buckets["title"], keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], keyword),
        paragraphs=get_related_keywords_for_zone(zone_buckets["paragraphs"], keyword),
    )
    quadgrams = get_top_quadgrams(zone_buckets["paragraphs"], keyword)

    # Step 5: Google NLP entity analysis — use paragraph text already in memory
    google_entities: List[dict] = []
    nlp_chars = 0
    if GOOGLE_NLP_API_KEY:
        para_texts = [t for t in zone_buckets["paragraphs"] if len(t) > 100]
        if para_texts:
            try:
                google_entities = await get_google_entities(para_texts)
                nlp_chars = sum(min(len(t), GOOGLE_NLP_MAX_BYTES) for t in para_texts)
                logger.info(f"Google NLP: {len(google_entities)} entities from {len(para_texts)} pages")
            except Exception as _nlp_err:
                logger.warning(f"Google NLP failed (non-fatal): {_nlp_err}")

    # Step 6: SERP bold keyword analysis — count usage across competitor pages
    serp_bold_keywords: List[dict] = []
    total_pages = len(scraped_urls)
    if bold_terms_from_serp and full_page_texts:
        min_bold_spread = max(2, int(np.ceil(total_pages * 0.30)))  # 30% threshold (lower than entities — bolding is a direct Google signal)
        for term in bold_terms_from_serp:
            # Count occurrences per page
            page_counts: List[int] = []
            pages_with_term = 0
            # Build regex for whole-word matching
            term_re = re.compile(r'\b' + re.escape(term) + r'\b', re.IGNORECASE)
            for page_text in full_page_texts:
                count = len(term_re.findall(page_text))
                page_counts.append(count)
                if count > 0:
                    pages_with_term += 1
            if pages_with_term < min_bold_spread:
                continue
            max_uses = max(page_counts)
            avg_uses = round(sum(page_counts) / len(page_counts), 1)
            # recommended_mentions = max competitor usage (benchmark to beat)
            serp_bold_keywords.append({
                "term": term,
                "page_spread": pages_with_term,
                "page_spread_pct": round(pages_with_term / total_pages, 2),
                "max_competitor_uses": max_uses,
                "avg_uses": avg_uses,
                "recommended_mentions": max_uses,
            })
        serp_bold_keywords.sort(key=lambda x: (-x["page_spread"], -x["max_competitor_uses"]))
        serp_bold_keywords = serp_bold_keywords[:25]  # cap at 25 terms
        logger.info(f"SERP bold keywords: {len(serp_bold_keywords)} qualifying terms from {len(bold_terms_from_serp)} extracted")

    zone_targets = compute_zone_targets(zone_buckets, related, google_entities)

    # Aggregate competitor headings by page spread
    competitor_headings: List[dict] = []
    for tag_type, per_page in (("h2", h2_per_page), ("h3", h3_per_page)):
        canonical: Dict[str, str] = {}
        page_count: Dict[str, int] = {}
        for page_headings in per_page:
            seen_this_page: set = set()
            for h in page_headings:
                h_key = h.lower().strip()
                if not h_key or len(h_key) < 3:
                    continue
                if h_key not in seen_this_page:
                    seen_this_page.add(h_key)
                    page_count[h_key] = page_count.get(h_key, 0) + 1
                    if h_key not in canonical:
                        canonical[h_key] = h
        limit = 12 if tag_type == "h2" else 20
        for h_key, count in sorted(page_count.items(), key=lambda x: -x[1])[:limit]:
            competitor_headings.append({
                "text": canonical[h_key],
                "type": tag_type,
                "page_count": count,
                "page_pct": round(count / total_pages, 2),
            })

    no_js_pages = scrape_cost_info["no_js_pages"]
    js_pages = scrape_cost_info["js_pages"]
    scrapeowl_cost = round(
        no_js_pages * COST_SCRAPEOWL_PER_PAGE + js_pages * COST_SCRAPEOWL_PER_PAGE_JS, 6
    )
    nlp_cost = round(nlp_chars / 1000 * COST_GOOGLE_NLP_PER_1K_CHARS, 6)
    analysis_cost = {
        "dataforseo": round(COST_DATAFORSEO_PER_ANALYSIS, 6),
        "scrapeowl_pages": len(scraped_urls),
        "scrapeowl_no_js_pages": no_js_pages,
        "scrapeowl_js_pages": js_pages,
        "scrapeowl": scrapeowl_cost,
        "google_nlp_chars": nlp_chars,
        "google_nlp": nlp_cost,
        "subtotal": round(COST_DATAFORSEO_PER_ANALYSIS + scrapeowl_cost + nlp_cost, 6),
    }

    return AnalysisResponse(
        keyword=keyword,
        location=location,
        serp_urls=scraped_urls,
        related_keywords=related,
        top_quadgrams=quadgrams,
        google_entities=google_entities,
        serp_bold_keywords=serp_bold_keywords,
        zone_targets=zone_targets,
        competitor_headings=competitor_headings,
        analysis_cost=analysis_cost,
    )


@app.post('/analyze', response_model=AnalysisResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def analyze(request: Request, body: AnalysisRequest):
    """
    Full pipeline:
      1. DataForSEO  — fetch top organic URLs for keyword + location
      2. ScrapeOwl   — fetch raw HTML for each URL concurrently
      3. NLP         — related keywords, quadgrams, Google entity analysis

    Pass optional `urls` to skip the DataForSEO SERP step (testing / override).
    """
    return await _run_serp_analysis(body.keyword, body.location, body.location_code, body.urls)


@app.get('/health')
async def health():
    return {'status': 'ok'}


# ── Business Analysis: website crawl + ICP/differentiator extraction ──────────

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
    analysis_status: str   # "complete" | "partial" | "failed"


class BrandVoiceRequest(BaseModel):
    website_url: Optional[str] = None
    business_name: str
    gbp_category: str = ""
    existing_pages: List[dict] = []


class BrandVoiceResponse(BaseModel):
    brand_voice: Optional[dict]
    pages_sampled: int


STATE_ABBREVS = {
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in',
    'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv',
    'nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn',
    'tx','ut','vt','va','wa','wv','wi','wy',
}
SERVICE_WORDS = {
    # Home services
    'repair','service','services','installation','install','replacement',
    'maintenance','inspection','cleaning','emergency','plumbing','hvac',
    'electrical','roofing','pest','landscaping','remodeling','painting',
    'flooring','gutters','siding','windows','doors','concrete','fencing',
    'generator','insulation','waterproofing','restoration','handyman',
    'appliance','garage','deck','patio','pool','irrigation','sprinkler',
    'locksmith','mold','asbestos','foundation','basement','septic','drain',
    # IT / Tech
    'managed','cybersecurity','cyber','cloud','network','backup','helpdesk',
    'support','monitoring','infrastructure','security','compliance','voip',
    'microsoft','azure','wireless','server','firewall','endpoint','siem',
    'consulting','solutions','technology','tech','software','hardware','it',
    # Legal
    'attorney','lawyer','litigation','injury','divorce','criminal','estate',
    'bankruptcy','immigration','employment','law','legal','counsel','defense',
    # Medical / Dental / Health
    'dental','dentist','orthodontics','medical','clinic','therapy','therapist',
    'chiropractic','physical','wellness','cosmetic','implants','pediatric',
    'dermatology','optometry','vision','hearing','counseling','rehabilitation',
    # Financial
    'accounting','bookkeeping','tax','cpa','financial','wealth','insurance',
    'mortgage','lending','investment','payroll','audit',
    # Other professional services
    'marketing','seo','advertising','branding','design','photography',
    'catering','moving','storage','towing','auto','automotive','collision',
    'salon','spa','fitness','training','coaching','tutoring','staffing',
    'cleaning','janitorial','security','alarm','surveillance',
}

# First URL segment patterns that indicate blog/content/editorial pages
BLOG_SLUGS = {
    'blog','news','insights','articles','resources','resource','post','posts',
    'updates','press','media','events','case-studies','whitepapers','guides',
    'tips','podcast','webinars','newsletter','stories','learn','library',
    'knowledge-base','kb','forum','community','careers','jobs',
}

# First URL segment patterns to skip entirely
SKIP_SLUGS = {
    'privacy','terms','sitemap','search','tag','tags','category','categories',
    'author','wp-content','wp-admin','wp-json','cart','checkout','account',
    'login','register','feed','rss','cdn','admin','dashboard','portal',
}

# URL segment patterns that strongly indicate location/area pages
LOCATION_SLUGS = {
    'service-area','service-areas','areas-we-serve','areas-served',
    'locations','location','cities','city','coverage','coverage-area',
    'near-me','local','where-we-serve','our-locations',
}

# Top-level slugs that are definitely NOT service pages
ABOUT_SLUGS = {
    'about','about-us','contact','contact-us','team','staff','our-team',
    'reviews','testimonials','gallery','portfolio','pricing','home','index',
    'sitemap','accessibility','disclaimer','refund','shipping',
}

# Require state abbreviation to appear at the END of a URL path segment (e.g. -tx, -fl).
# This prevents common English words that double as state abbreviations (in=Indiana,
# or=Oregon, me=Maine, ok=Oklahoma) from falsely triggering geo detection mid-slug.
_STATE_ABBREV_PATTERN = re.compile(
    r'-(' + '|'.join(STATE_ABBREVS) + r')(?:/|$)',
    re.IGNORECASE
)

# Function words that appear in blog titles but not in service/location page slugs
BLOG_STOP_WORDS = {
    # Articles & prepositions
    'a','an','the','to','for','in','on','at','by','from','with','about',
    'of','and','or','but','as','if','into','over','out','up','down',
    # Question / clause words
    'how','why','what','when','where','who','which','whether',
    # Common blog verbs
    'do','does','did','get','make','find','choose','fix','know','need',
    'use','keep','avoid','increase','improve','reduce','boost','help',
    'save','build','create','start','stop','prevent','handle','manage',
    # List/tip words
    'tips','ways','reasons','things','steps','signs','mistakes','ideas',
    'questions','examples','facts','benefits','types','differences',
    # Adjectives common in blog titles
    'best','top','great','good','better','new','old','free','easy','quick',
    'simple','complete','ultimate','essential','important','common','right',
    'wrong','perfect','proven','effective','powerful','smart',
    # Numbers as words
    'one','two','three','four','five','six','seven','eight','nine','ten',
    # News / announcement / press release verbs (company updates, achievements)
    'secures','achieves','wins','launches','announces','expands','hires',
    'partners','joins','receives','earns','reveals','unveils','named',
    'recognized','awarded','ranked','acquires','closes','raises','signs',
    # Editorial adjectives common in blog/opinion titles
    'game','changing','groundbreaking','revolutionary','disruptive',
    'innovative','emerging','evolving','latest','modern','upcoming',
    'future','current','global','local','digital','virtual','real',
    # Negative-framing / problem words common in blog titles
    'failures','failure','problems','problem','challenges','challenge',
    'risks','risk','myths','myth','stereotypes','stereotype',
    'misconceptions','misconception','mistakes','mistake','issues','issue',
    'dangers','danger','warning','warnings','pitfalls','pitfall',
}

# Words that almost never start a service/location page slug
BLOG_LEAD_WORDS = {
    # Interrogatives
    'how','why','what','when','where','who','which','whether',
    # Modal / auxiliary verbs
    'is','are','was','were','will','would','can','could','should','do','does','did',
    # Imperative / action verbs that open blog posts
    'get','find','make','learn','discover','explore','understand','read',
    'see','check','avoid','stop','start','build','improve','increase',
    'boost','reduce','save','use','try','need','want',
    # Action verbs common in blog/tutorial titles
    'simplify','configure','integrate','optimize','automate','migrate',
    'secure','protect','leverage','maximize','minimize','streamline',
    'enable','disable','setup','upgrade','deploy','troubleshoot',
    'comparing','choosing','picking','switching','using','getting',
    # Gerunds that open editorial/explainer content
    'clarifying','understanding','navigating','protecting','managing',
    'avoiding','preparing','addressing','implementing','evaluating',
    'identifying','recognizing','overcoming','preventing','handling',
    'building','creating','running','growing','leading','working',
    'finding','becoming','turning','writing','reading','sending',
    'moving','setting','taking','making','giving','keeping',
    # Contractions without apostrophes (common in casual blog titles)
    'dont','cant','wont','isnt','arent','wasnt','didnt',
    'shouldnt','couldnt','wouldnt','havent','hasnt','hadnt',
    # Articles as first word — editorial content, never service pages
    'the','an',
    # Modal verbs not already covered
    'may','might',
    # Action verbs that open blog/news titles
    'become','grow','achieve','master','fix','solve','tackle','beat',
}

# Mid-slug function words: their presence mid-slug signals sentence structure
BLOG_MID_WORDS = {
    'in','the','for','with','of','and','or','to','a','an','by','from',
    'at','on','as','into','over','about',
    # Auxiliary/linking verbs mid-slug indicate a sentence (e.g. cybersecurity-is-fortifying-...)
    'is','are','was','were','has','have','had',
    # Possessive/personal pronouns — never appear in service page slugs
    'your','our','their','my','its',
    # Third-person present verbs mid-slug signal sentence structure
    'needs','takes','makes','gets','helps','keeps','shows','means',
    'works','comes','goes','lets','gives','puts','sets','runs',
    # Month names — dated content (e.g. microsoft-teams-rooms-may-update)
    'january','february','march','april','may','june','july',
    'august','september','october','november','december',
}


def _slug_looks_like_blog(slug: str) -> bool:
    """Return True if a URL leaf slug looks like a blog post rather than a service/location page.

    Four signals are checked (any one is sufficient):
    1. Length — >6 words is almost always editorial content.
    2. Digit prefix — e.g. 5-tips-for-... or 10-reasons-...
    3. Question/verb lead word — slugs starting with 'how', 'why', 'is', 'can', 'do', etc.
    4. Sentence structure — mid-slug prepositions/articles (in, the, for, of) indicate the
       slug reads like a natural-language sentence rather than a short noun phrase.
    Service/location slugs are short noun phrases with no function words.
    """
    words = [w for w in re.split(r'[-_]', slug.lower()) if len(w) > 1]
    if not words:
        return False

    # Signal 1: More than 6 words → almost always a blog post
    if len(words) > 6:
        return True

    # Signal 2: Starts with a digit (e.g. 5-tips-for..., 10-reasons...)
    if words[0].isdigit():
        return True

    # Signal 3: Starts with a question word, modal, or action verb typical of blog titles
    if words[0] in BLOG_LEAD_WORDS:
        return True

    # Signal 4: Mid-slug prepositions or articles indicate sentence structure
    # (e.g. "technology-in-the-medical-field", "guide-for-homeowners")
    # Only trigger on 3+ word slugs to avoid false-positives on short slugs
    if len(words) >= 3 and any(w in BLOG_MID_WORDS for w in words[1:]):
        return True

    # Signal 5: Contains a 4-digit year — dated blog posts, news, annual roundups
    # (e.g. hipaa-compliance-in-2026, it-buzzwords-to-know-in-2021)
    if any(re.match(r'^(19|20)\d{2}$', w) for w in words):
        return True

    # Fallback: 4+ word slugs containing any stop word
    if len(words) >= 4 and any(w in BLOG_STOP_WORDS for w in words):
        return True

    return False

CRAWL_HEADERS = {
    'User-Agent': 'ShowUPLocalBot/1.0 (business-page-discovery; respects robots.txt)',
}


def classify_page_type(url: str, title: str = '', h1: str = '') -> dict:
    """
    Rule-based page type classifier.
    Returns { type, primary_service, primary_city }
    Types: service | location | city_service | blog | other
    """
    import urllib.parse
    path = urllib.parse.urlparse(url).path.lower().rstrip('/')
    combined = f"{path} {title} {h1}".lower()
    segments = [s for s in path.split('/') if s]
    first = segments[0] if segments else ''
    path_words = set(re.split(r'[-_]', ' '.join(segments)))

    # ── Blog / content pages ──────────────────────────────────────────────────
    if first in BLOG_SLUGS or (len(segments) > 1 and segments[0] in BLOG_SLUGS):
        return {'type': 'blog', 'primary_service': None, 'primary_city': None}

    # Any segment starting with a digit → blog (e.g. /4-frequently-visited-sites/)
    for seg in segments:
        seg_words = [w for w in re.split(r'[-_]', seg.lower()) if len(w) > 1]
        if seg_words and seg_words[0].isdigit():
            return {'type': 'blog', 'primary_service': None, 'primary_city': None}

    # "vs" anywhere in path → comparison article, always blog
    if 'vs' in path_words:
        return {'type': 'blog', 'primary_service': None, 'primary_city': None}

    # Slug-complexity check: root-domain blog posts (e.g. /how-to-fix-your-furnace-this-winter)
    # Long slugs (>6 words) or digit-prefixed slugs (5-tips-...) are always blog.
    # Medium slugs (4-6 words with stop words) get a service+geo override to protect
    # verbose city+service URLs like /emergency-plumber-dallas-tx.
    leaf = segments[-1] if segments else ''
    if leaf and _slug_looks_like_blog(leaf):
        leaf_word_list = [w for w in re.split(r'[-_]', leaf.lower()) if len(w) > 1]
        # Signals 1–3 and 5 are definitive — no service-word override.
        definitely_blog = (
            len(leaf_word_list) > 6
            or (leaf_word_list and leaf_word_list[0].isdigit())
            or (leaf_word_list and leaf_word_list[0] in BLOG_LEAD_WORDS)
            or any(re.match(r'^(19|20)\d{2}$', w) for w in leaf_word_list)
        )
        if definitely_blog:
            return {'type': 'blog', 'primary_service': None, 'primary_city': None}
        # Signal 4 (mid-slug function words): allow override only when the slug has BOTH
        # a service word AND a state abbreviation at the end (e.g. /hvac-repair-in-dallas-tx).
        # Requiring both prevents service words alone (compliance, cybersecurity, managed)
        # from blocking blog classification on editorial slugs.
        leaf_words = set(leaf_word_list)
        has_service_word = bool(leaf_words & SERVICE_WORDS)
        has_state_at_end = bool(_STATE_ABBREV_PATTERN.search(leaf))
        if not (has_service_word and has_state_at_end):
            return {'type': 'blog', 'primary_service': None, 'primary_city': None}

    # ── Skip patterns (admin, privacy, etc.) ─────────────────────────────────
    if first in SKIP_SLUGS:
        return {'type': 'other', 'primary_service': None, 'primary_city': None}

    # ── Geo detection ─────────────────────────────────────────────────────────
    has_geo = bool(
        # State abbrev as standalone path word (e.g. /dallas-tx, /services/houston-tx)
        _STATE_ABBREV_PATTERN.search(path) or
        # Zip code anywhere
        re.search(r'\b\d{5}\b', combined) or
        # Explicit location slug
        any(s in LOCATION_SLUGS for s in segments) or
        # "near" as a path word
        'near' in path_words
    )

    # ── Service detection ─────────────────────────────────────────────────────
    has_service = bool(
        path_words & SERVICE_WORDS or
        any(w in combined for w in SERVICE_WORDS)
    )

    # ── Classification ────────────────────────────────────────────────────────
    if has_geo and has_service:
        page_type = 'city_service'
    elif has_geo:
        page_type = 'location'
    elif has_service:
        page_type = 'service'
    elif len(segments) == 1 and first not in ABOUT_SLUGS:
        # Short root-level slugs (≤3 words) are likely service/product pages (/hvac/, /plumbing-repair/)
        # Longer ones are ambiguous — return 'other' so Haiku can reclassify them
        slug_words = [w for w in re.split(r'[-_]', first) if len(w) > 1]
        page_type = 'service' if len(slug_words) <= 3 else 'other'
    else:
        page_type = 'other'

    return {'type': page_type, 'primary_service': None, 'primary_city': None}


def _make_page_record(url: str, title: str = '', h1: str = '') -> dict:
    c = classify_page_type(url, title, h1)
    return {
        'url': url,
        'title': title[:200],
        'h1': h1[:200],
        'page_type': c['type'],
        'primary_service': c['primary_service'],
        'primary_city': c['primary_city'],
    }


async def _fetch_sitemap_urls(sitemap_url: str, client: httpx.AsyncClient, depth: int = 0) -> List[str]:
    """
    Fetches a sitemap (or sitemap index) and returns all <loc> URLs.
    Handles sitemap index files recursively (one level deep).
    """
    if depth > 1:
        return []
    try:
        r = await client.get(sitemap_url, timeout=15.0)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, 'xml')
        # Sitemap index — recurse into child sitemaps
        sitemap_tags = soup.find_all('sitemap')
        if sitemap_tags:
            child_urls = [t.find('loc').get_text(strip=True) for t in sitemap_tags if t.find('loc')]
            results = await asyncio.gather(
                *[_fetch_sitemap_urls(u, client, depth + 1) for u in child_urls[:50]]
            )
            return [url for sublist in results for url in sublist]
        # Regular sitemap — return all <loc>
        return [t.get_text(strip=True) for t in soup.find_all('loc')]
    except Exception as e:
        logger.warning(f"Sitemap fetch error ({sitemap_url}): {e}")
        return []


async def _discover_via_sitemap(base_url: str, client: httpx.AsyncClient) -> List[str]:
    """
    Step 1: Read robots.txt to find Sitemap: directive.
    Step 2: Fetch and parse sitemap.xml.
    Returns list of internal page URLs, or [] if sitemap not found.
    """
    import urllib.parse
    parsed = urllib.parse.urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    sitemap_url: Optional[str] = None

    # Try robots.txt first
    try:
        r = await client.get(f"{origin}/robots.txt", timeout=10.0)
        if r.status_code == 200:
            for line in r.text.splitlines():
                if line.lower().startswith('sitemap:'):
                    sitemap_url = line.split(':', 1)[1].strip()
                    break
    except Exception:
        pass

    # Try common sitemap locations if robots.txt didn't specify one
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
    # Filter to same domain, HTML-like URLs
    internal = []
    for u in urls:
        try:
            p = urllib.parse.urlparse(u)
            if p.netloc != parsed.netloc:
                continue
            if re.search(r'\.(jpg|jpeg|png|gif|pdf|css|js|ico|svg|zip|xml)$', p.path, re.I):
                continue
            internal.append(u)
        except Exception:
            continue

    logger.info(f"Sitemap discovery: found {len(internal)} internal URLs from {sitemap_url}")
    return internal


async def _discover_via_nav(base_url: str, client: httpx.AsyncClient) -> List[str]:
    """
    Fallback: fetch the homepage, extract links from <nav> / header elements only.
    Much lighter than BFS — only 1 page fetch.
    """
    import urllib.parse
    try:
        r = await client.get(base_url, timeout=15.0)
        if r.status_code != 200:
            return []
        parsed = urllib.parse.urlparse(base_url)
        base_domain = parsed.netloc
        soup = BeautifulSoup(r.text, 'html.parser')

        # Look for nav elements; fall back to header, then all links
        nav_els = soup.find_all(['nav', 'header']) or [soup]
        urls = set()
        for container in nav_els:
            for a in container.find_all('a', href=True):
                href = str(a['href']).strip()
                if not href or href.startswith(('#', 'mailto:', 'tel:', 'javascript:')):
                    continue
                full = urllib.parse.urljoin(base_url, href)
                p = urllib.parse.urlparse(full)
                if p.netloc != base_domain:
                    continue
                if re.search(r'\.(jpg|jpeg|png|gif|pdf|css|js|ico|svg|zip|xml)$', p.path, re.I):
                    continue
                clean = f"{p.scheme}://{p.netloc}{p.path.rstrip('/')}"
                urls.add(clean)

        logger.info(f"Nav discovery: found {len(urls)} links on homepage")
        return list(urls)
    except Exception as e:
        logger.warning(f"Nav discovery error: {e}")
        return []


async def _classify_urls_with_ai(urls: List[str]) -> Dict[str, str]:
    """
    Use Claude Haiku to classify a batch of ambiguous URLs by page type.
    Only called for URLs the rule-based classifier couldn't confidently resolve.
    Returns {url: page_type} — city_service | service | location | blog | other.
    Falls back to empty dict on any failure so the caller can use rule-based results.
    """
    if not ANTHROPIC_API_KEY or not urls:
        return {}

    try:
        import anthropic
        import json as json_lib

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
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )

        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)

        result = json_lib.loads(raw)
        logger.info(f"Haiku classified {len(result)} ambiguous URLs")
        return result

    except Exception as e:
        logger.warning(f"AI URL classification failed, using rule-based only: {e}")
        return {}


async def crawl_website(website_url: str, max_pages: int = 200) -> List[dict]:
    """
    Sitemap-first page discovery pipeline:
      1. robots.txt → sitemap URL
      2. Parse sitemap XML → all <loc> URLs (no per-page HTTP requests)
      3. Fallback: nav extraction from homepage (1 request)
      4. Last resort: shallow 1-level BFS from homepage

    Two-tier classification:
      - Rule-based classifier handles clear-cut cases (fast, free)
      - Haiku handles only 'other'-typed URLs the rules couldn't resolve
    """
    import urllib.parse

    _block_ssrf(website_url)
    url = website_url.strip()
    if not url.startswith(('http://', 'https://')):
        url = f"https://{url}"

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=15.0,
        headers=CRAWL_HEADERS,
    ) as client:
        # Stage 1: sitemap
        discovered = await _discover_via_sitemap(url, client)

        # Stage 2: nav fallback
        if not discovered:
            logger.info(f"No sitemap found for {url} — falling back to nav extraction")
            discovered = await _discover_via_nav(url, client)

        # Stage 3: shallow BFS (homepage links only, no recursion)
        if not discovered:
            logger.info(f"Nav empty for {url} — falling back to homepage link scan")
            discovered = await _discover_via_nav(url, client)

    # Always include the homepage itself
    parsed = urllib.parse.urlparse(url)
    homepage = f"{parsed.scheme}://{parsed.netloc}"
    all_urls = list(dict.fromkeys([homepage] + discovered))  # dedup, preserve order

    # Pass 1: rule-based classification on every URL
    rule_results: Dict[str, str] = {}
    for u in all_urls:
        c = classify_page_type(u)
        rule_results[u] = c['type']

    # Pass 2: collect URLs the rules left as 'other' — send to Haiku for reclassification
    # Cap at 150 to keep the Haiku call fast (typically only 10-50 URLs reach this)
    ambiguous = [u for u, t in rule_results.items() if t == 'other'][:150]
    ai_types = await _classify_urls_with_ai(ambiguous)
    logger.info(f"Rule-based: {len(rule_results)} URLs — sent {len(ambiguous)} ambiguous to Haiku")

    # Merge: AI result takes precedence for ambiguous URLs
    final_types = {**rule_results, **ai_types}

    # Build page records, drop blogs
    all_pages = []
    for u in all_urls:
        page_type = final_types.get(u, 'other')
        if page_type not in ('city_service', 'service', 'location', 'blog', 'other'):
            page_type = 'other'
        if page_type == 'blog':
            continue
        all_pages.append({
            'url': u,
            'title': '',
            'h1': '',
            'page_type': page_type,
            'primary_service': None,
            'primary_city': None,
        })

    # Sort: city_service → service → location → other
    def _sort_key(p: dict) -> int:
        return {'city_service': 0, 'service': 1, 'location': 2, 'other': 3}.get(p['page_type'], 3)

    pages = sorted(all_pages, key=_sort_key)[:max_pages]
    type_counts: Dict[str, int] = {}
    for p in pages:
        type_counts[p['page_type']] = type_counts.get(p['page_type'], 0) + 1
    logger.info(f"Page classification: {type_counts}")

    logger.info(f"Page discovery complete: {len(pages)} pages from {website_url}")
    return pages


async def analyze_business_with_anthropic(
    pages: List[dict],
    business_name: str,
    gbp_category: str,
    gbp_categories: List[str],
) -> dict:
    """
    Use Claude Haiku to detect ICP and extract differentiators from crawled page data.
    Returns { detected_icp, differentiators }
    """
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping LLM analysis")
        return {'detected_icp': None, 'differentiators': []}

    try:
        import anthropic
        import json as json_lib

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
            pages_text = '\n'.join(page_lines)
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
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{'role': 'user', 'content': prompt}],
        )

        usage = message.usage
        logger.info(
            f"Anthropic ICP usage — input: {usage.input_tokens} tokens, "
            f"output: {usage.output_tokens} tokens, "
            f"est. cost: ${(usage.input_tokens * 0.0000008) + (usage.output_tokens * 0.000004):.5f}"
        )

        text = message.content[0].text.strip()
        # Strip markdown code fences if model wrapped the JSON
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```$', '', text.strip())
        result = json_lib.loads(text)
        return result

    except Exception as e:
        logger.error(f"Anthropic analysis error: {e}")
        raise


@app.post('/analyze-business', response_model=BusinessAnalysisResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def analyze_business(request: Request, body: BusinessAnalysisRequest):
    """
    Phase 1 business setup pipeline:
      1. Sitemap-first page discovery (robots.txt → sitemap.xml → nav fallback)
      2. Classify each page as service / location / city_service / other
      3. Use Claude Haiku to detect ICP and extract differentiators
    """
    if body.website_url and body.website_url.strip():
        _block_ssrf(body.website_url)
    pages = []
    if body.website_url and body.website_url.strip():
        url = body.website_url.strip()
        if not url.startswith(('http://', 'https://')):
            url = f"https://{url}"
        try:
            pages = await asyncio.wait_for(
                crawl_website(url),
                timeout=90.0,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Page discovery timed out for {url}")
            pages = []

    try:
        llm_result = await analyze_business_with_anthropic(
            pages,
            body.business_name,
            body.gbp_category,
            body.gbp_categories,
        )
    except Exception as e:
        logger.exception("Anthropic analysis failed")
        raise HTTPException(status_code=502, detail="Analysis service temporarily unavailable")

    status = 'complete' if pages else 'partial'

    return BusinessAnalysisResponse(
        existing_pages=pages,
        detected_icp=llm_result.get('detected_icp'),
        differentiators=llm_result.get('differentiators', []),
        pages_crawled=len(pages),
        analysis_status=status,
    )


# ── Brand Voice ────────────────────────────────────────────────────────────────

async def _crawl_pages_for_brand_voice(website_url: str, client: httpx.AsyncClient, max_pages: int = 25) -> List[dict]:
    """
    Discover up to max_pages pages for brand voice analysis.
    Priority: home → about → top-level service → service → location/city_service → other
    Skips blog pages and admin/legal slugs.
    """
    import urllib.parse
    _block_ssrf(website_url)
    parsed = urllib.parse.urlparse(website_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    # Discover URLs via sitemap; fallback to homepage nav links
    sitemap_urls = await _discover_via_sitemap(website_url, client)
    if sitemap_urls:
        candidate_urls = sitemap_urls
    else:
        candidate_urls = await _discover_via_nav(website_url, client)

    # Always include homepage
    homepage = origin
    all_urls = list({homepage} | {u.rstrip('/') for u in candidate_urls} | {website_url.rstrip('/')})

    classified = []
    for url in all_urls:
        result = classify_page_type(url)
        page_type = result['type']
        if page_type == 'blog':
            continue
        path = urllib.parse.urlparse(url).path.lower().rstrip('/')
        first = path.split('/')[1] if '/' in path[1:] else path.lstrip('/')
        if first in SKIP_SLUGS:
            continue
        classified.append({'url': url, 'page_type': page_type})

    def _priority(p: dict) -> int:
        u = p['url'].rstrip('/')
        path = urllib.parse.urlparse(u).path.lower().rstrip('/')
        segments = [s for s in path.split('/') if s]
        slug = segments[-1] if segments else ''
        # Homepage
        if not segments or u in {origin, origin + '/index', origin + '/home'}:
            return 0
        # About pages
        if any(x in slug for x in ('about', 'who-we-are', 'our-story', 'team', 'about-us')):
            return 1
        # Top-level (single-segment) service pages
        pt = p['page_type']
        if pt == 'service' and len(segments) == 1:
            return 2
        # Deeper service pages
        if pt == 'service':
            return 3
        if pt in ('location', 'city_service'):
            return 4
        return 5

    classified.sort(key=_priority)
    logger.info(f"Brand voice crawl: {len(classified)} candidate pages for {website_url}")
    return classified[:max_pages]


async def _fetch_page_text(url: str, client: httpx.AsyncClient) -> str:
    """Fetch a page and extract meaningful paragraph text."""
    try:
        resp = await client.get(url, timeout=10.0, follow_redirects=True)
        if resp.status_code != 200:
            return ""
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
            tag.decompose()
        paragraphs = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
        paragraphs = [p for p in paragraphs if len(p) > 40]
        return " ".join(paragraphs[:30])
    except Exception:
        return ""


async def analyze_brand_voice_with_anthropic(page_contents: List[str], business_name: str, gbp_category: str = "", **kwargs) -> dict:
    """Use Claude Haiku to extract brand voice from sampled page copy.
    Runs three sequential API calls:
      1. Current voice — purely descriptive (what the site sounds like now)
      2. Recommended voice — aspirational (what it should sound like)
      3. Writer Execution Guide — based on the recommended voice
    """
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping brand voice analysis")
        return {}

    import anthropic

    has_content = bool(page_contents)
    content_text = "\n\n---\n\n".join(page_contents) if page_contents else ""

    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    # Tool definitions force structured JSON output — Anthropic validates against
    # the schema server-side, so we can't hit a JSON parse error from unescaped
    # quotes / stray characters in string values (the Call 1 failure mode).
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
                "personality": {
                    "type": "array",
                    "description": "3 personality traits.",
                    "items": {"type": "string"},
                },
                "tone": {
                    "type": "string",
                    "description": "1-2 sentence description of the overall tone.",
                },
                "writing_style": {
                    "type": "object",
                    "required": ["sentence_length", "person", "jargon_level", "formality"],
                    "properties": {
                        "sentence_length": {"type": "string", "description": "short / medium / long / mixed"},
                        "person":          {"type": "string", "description": "first person / second person / third person / mixed"},
                        "jargon_level":    {"type": "string", "description": "low / medium / high — brief explanation"},
                        "formality":       {"type": "string", "description": "casual / professional / formal"},
                    },
                },
                "vocabulary": {
                    "type": "object",
                    "required": ["use", "avoid"],
                    "properties": {
                        "use":   {"type": "array", "description": "5 words/phrases to use.",   "items": {"type": "string"}},
                        "avoid": {"type": "array", "description": "3 words/phrases to avoid.", "items": {"type": "string"}},
                    },
                },
                "messaging_themes": {
                    "type": "array",
                    "description": "3 messaging themes.",
                    "items": {"type": "string"},
                },
                "sample_phrases": {
                    "type": "array",
                    "description": "3 sample phrases that exemplify this voice.",
                    "items": {"type": "string"},
                },
                "content_generation_instructions": {
                    "type": "string",
                    "description": "2-3 sentences of concrete guidance for writing content that matches this brand voice.",
                },
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
                "core_writing_objective":      {"type": "string", "description": "What every piece of content must achieve."},
                "default_writing_formula":     {"type": "string", "description": "e.g. Problem → Consequence → Solution → Outcome — include a concrete example sentence."},
                "non_negotiable_rules":        {"type": "array",  "description": "5 non-negotiable rules.",                                       "items": {"type": "string"}},
                "sentence_style_do":           {"type": "array",  "description": "3 DO examples.",                                                "items": {"type": "string"}},
                "sentence_style_dont":         {"type": "array",  "description": "3 DON'T examples.",                                             "items": {"type": "string"}},
                "rewriting_framework":         {"type": "array",  "description": "3 rewrite examples (generic→specific, feature→outcome, soft→direct).", "items": {"type": "string"}},
                "before_after_weak":           {"type": "string", "description": "A weak copy example."},
                "before_after_strong":         {"type": "string", "description": "The improved version of the weak example."},
                "seo_aeo_instructions":        {"type": "string", "description": "Guidance for answer-first, scannable content for SEO and AI retrieval."},
                "ai_writing_rules":            {"type": "string", "description": "Instructions for maintaining voice when using AI tools."},
                "common_failure_modes":        {"type": "array",  "description": "3 failure modes paired with fixes.",                            "items": {"type": "string"}},
                "quick_cheat_sheet":           {"type": "array",  "description": "5 quick rules.",                                                "items": {"type": "string"}},
            },
        },
    }

    def _extract_tool_input(message: any, tool_name: str) -> dict:
        """Pull the structured `input` dict out of a tool_use response block."""
        for block in message.content:
            if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == tool_name:
                return dict(block.input)
        raise ValueError(f"No tool_use block named {tool_name!r} in response")

    if not has_content:
        # ── No-website path: skip current voice, generate recommended + guide from category ──
        logger.info(f"Brand voice: no website content for {business_name} — using category-based inference")

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
                model="claude-haiku-4-5-20251001",
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend a high-performing brand voice based on business type.",
                messages=[{'role': 'user', 'content': prompt_recommended_no_site}],
            )
            u_rec = msg_rec.usage
            logger.info(f"Brand voice (no-site recommended) — input: {u_rec.input_tokens}, output: {u_rec.output_tokens}")
            recommended_voice = _extract_tool_input(msg_rec, "submit_brand_voice")
            current_voice = None  # No website — current voice cannot be analyzed
        except Exception as e:
            logger.error(f"Brand voice no-site recommended error: {e}")
            recommended_voice = {}
            current_voice = None
    else:
        # ── Website path: Call 1 — Current voice (purely descriptive) ────────────────────────────
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
                model="claude-haiku-4-5-20251001",
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a brand analyst. Describe brand voice objectively based on evidence from the website copy. Do not prescribe or recommend — only describe what you observe.",
                messages=[{'role': 'user', 'content': prompt_current}],
            )
            u1 = msg1.usage
            logger.info(f"Brand voice call 1 (current) — input: {u1.input_tokens}, output: {u1.output_tokens}, est. cost: ${(u1.input_tokens * 0.0000008) + (u1.output_tokens * 0.000004):.5f}")
            current_voice = _extract_tool_input(msg1, "submit_brand_voice")
        except Exception as e:
            logger.error(f"Brand voice call 1 error: {e}")
            current_voice = None

        # ── Call 2: Recommended voice (aspirational) ──────────────────────────────
        cv_personality = ', '.join((current_voice or {}).get('personality', []))
        cv_tone = (current_voice or {}).get('tone', '')
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
                model="claude-haiku-4-5-20251001",
                max_tokens=2048,
                tools=[VOICE_TOOL],
                tool_choice={"type": "tool", "name": "submit_brand_voice"},
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend an elevated, optimized brand voice.",
                messages=[{'role': 'user', 'content': prompt_recommended}],
            )
            u2 = msg2.usage
            logger.info(f"Brand voice call 2 (recommended) — input: {u2.input_tokens}, output: {u2.output_tokens}, est. cost: ${(u2.input_tokens * 0.0000008) + (u2.output_tokens * 0.000004):.5f}")
            recommended_voice = _extract_tool_input(msg2, "submit_brand_voice")
        except Exception as e:
            logger.error(f"Brand voice call 2 error: {e}")
            recommended_voice = {}

    # ── Call 3 (shared): Writer Execution Guide (based on recommended voice) ────────────
    guide_lead = "Website copy:" if has_content else "No website available — write the guide based on the recommended voice and business category."
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
            model="claude-haiku-4-5-20251001",
            max_tokens=3000,
            tools=[GUIDE_TOOL],
            tool_choice={"type": "tool", "name": "submit_writer_execution_guide"},
            system="You are a senior brand strategist and direct-response copywriter building brand voice systems for local service businesses.",
            messages=[{'role': 'user', 'content': prompt_guide}],
        )
        u3 = msg3.usage
        logger.info(f"Brand voice call 3 (guide) — input: {u3.input_tokens}, output: {u3.output_tokens}, est. cost: ${(u3.input_tokens * 0.0000008) + (u3.output_tokens * 0.000004):.5f}")
        guide = _extract_tool_input(msg3, "submit_writer_execution_guide")
    except Exception as e:
        logger.error(f"Brand voice call 3 error: {e}")
        guide = {}

    return {
        "current_voice": current_voice,
        "recommended_voice": recommended_voice,
        "recommended_accepted": None,   # null = not yet decided
        "writer_execution_guide": guide,
    }


def _build_brand_voice_text(brand_voice: Optional[dict]) -> str:
    """Render brand voice + writer guide as a plain-text block for the system prompt.

    Voice selection: defaults to the **current** voice (what the site already
    sounds like). Only switches to the recommended voice when the user
    explicitly accepted it (`recommended_accepted == True`). When the chosen
    voice is missing (e.g. no website, so current_voice is null) we fall back
    to the other so we still inject something useful.
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
    if ws.get("sentence_length"): style_parts.append(f"{ws['sentence_length']} sentences")
    if ws.get("person"):          style_parts.append(str(ws['person']))
    if ws.get("formality"):       style_parts.append(f"{ws['formality']} formality")
    if ws.get("jargon_level"):    style_parts.append(f"jargon: {ws['jargon_level']}")
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

    # Writer execution guide — only the high-signal subset, rendered as bullets.
    # Strategic content (how_to_think_before_writing, common_failure_modes,
    # before_after_*) is omitted to keep the prompt block compact.
    if isinstance(guide, dict) and guide:
        if guide.get("default_writing_formula"):
            lines.append(f"  Default writing formula: {guide['default_writing_formula']}")
        for key, label in (
            ("non_negotiable_rules", "Non-negotiable rules"),
            ("sentence_style_do",    "Sentence style — DO"),
            ("sentence_style_dont",  "Sentence style — DON'T"),
            ("quick_cheat_sheet",    "Quick cheat sheet"),
        ):
            items = guide.get(key) or []
            if items:
                lines.append(f"  {label}:")
                for item in items:
                    lines.append(f"    - {item}")

    return "\n".join(lines)


def _build_icp_text(detected_icp: Optional[dict], max_segments: int = 3) -> str:
    """Render the detected ICP as a plain-text block for the system prompt.

    Reads the schema produced by analyze_business_website_with_anthropic:
    segments[].label, demographics{description,situation},
    psychographics{trigger,fears,motivations,buying_behavior},
    messaging{tone,hooks,trust_signals}. The primary segment is listed first.
    Returns "" when ICP is empty so callers can safely f-string the result.
    """
    if not detected_icp:
        return ""
    segments = detected_icp.get("segments") or []
    if not segments:
        return ""

    # Primary first, then remaining in original order, capped at max_segments.
    ordered = sorted(segments, key=lambda s: 0 if s.get("primary") else 1)

    lines = ["TARGET CUSTOMER PROFILES (write to these pain points and motivations):"]
    for seg in ordered[:max_segments]:
        label = seg.get("label") or "Customer"
        marker = " — PRIMARY" if seg.get("primary") else ""
        lines.append(f"  [{label}{marker}]")

        demo = seg.get("demographics") or {}
        if demo.get("description"): lines.append(f"    Demographics: {demo['description']}")
        if demo.get("situation"):   lines.append(f"    Situation: {demo['situation']}")

        psy = seg.get("psychographics") or {}
        if psy.get("trigger"):         lines.append(f"    Search trigger: {psy['trigger']}")
        if psy.get("fears"):           lines.append(f"    Fears (address these): {'; '.join(psy['fears'])}")
        if psy.get("motivations"):     lines.append(f"    Motivations (emphasise these): {'; '.join(psy['motivations'])}")
        if psy.get("buying_behavior"): lines.append(f"    Buying behaviour: {psy['buying_behavior']}")

        msg = seg.get("messaging") or {}
        if msg.get("tone"):          lines.append(f"    Messaging tone: {msg['tone']}")
        if msg.get("hooks"):          lines.append(f"    Headline hooks: {'; '.join(msg['hooks'])}")
        if msg.get("trust_signals"):  lines.append(f"    Trust signals: {'; '.join(msg['trust_signals'])}")

    return "\n".join(lines)


@app.post('/analyze-brand-voice', response_model=BrandVoiceResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def analyze_brand_voice(request: Request, body: BrandVoiceRequest):
    """
    Brand voice pipeline:
      - With website: crawl up to 25 pages, extract text, analyze with Claude Haiku
      - Without website: generate category-based recommended voice with Claude Haiku
    """
    if body.website_url and body.website_url.strip():
        _block_ssrf(body.website_url)
    page_contents: List[str] = []
    pages_sampled = 0

    if body.website_url and body.website_url.strip():
        url = body.website_url.strip()
        if not url.startswith(('http://', 'https://')):
            url = f"https://{url}"

        # Probe the site first to catch dead links / 4xx errors
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=CRAWL_HEADERS) as client:
            try:
                probe = await client.get(url, timeout=10.0)
                if probe.status_code >= 400:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Your website returned a {probe.status_code} error. Check that the URL is correct and the site is live."
                    )
            except httpx.RequestError as e:
                logger.warning(f"Brand voice website probe failed for {url}: {type(e).__name__}: {e}")
                raise HTTPException(
                    status_code=422,
                    detail="Your website couldn't be reached. Check that the URL is correct and your site is live."
                )

            selected = await _crawl_pages_for_brand_voice(url, client, max_pages=25)

        async def _scrapeowl_extract(pages: List[dict], render_js: bool) -> List[str]:
            """Fetch pages via ScrapeOwl and extract text content."""
            # ScrapeOwl plan caps concurrency at 10 — bound below that to leave
            # headroom for any other in-flight scrape calls in the same process.
            sem = asyncio.Semaphore(8)

            async def _bounded(p: dict, sc_client: httpx.AsyncClient) -> Optional[str]:
                async with sem:
                    return await _scrape_one(p['url'], sc_client, render_js=render_js)

            async with httpx.AsyncClient() as sc:
                htmls = await asyncio.gather(
                    *[_bounded(p, sc) for p in pages],
                    return_exceptions=True,
                )
            results = []
            for p, html in zip(pages, htmls):
                if not html or isinstance(html, Exception):
                    continue
                soup = BeautifulSoup(html, "html.parser")
                for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "aside"]):
                    tag.decompose()
                # Try <p> tags first; fall back to all block-level text if none found
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
                text = " ".join(paragraphs[:30])
                if text.strip():
                    results.append(f"[{p.get('page_type', 'page')}] {p['url']}\n{text[:600]}")
            return results

        # Tier 1: ScrapeOwl without JS (residential proxies, handles Cloudflare/WAF-protected sites)
        logger.info(f"Brand voice: scraping {len(selected)} pages via ScrapeOwl for {url}")
        page_contents = await _scrapeowl_extract(selected, render_js=False)
        pages_sampled = len(page_contents)
        logger.info(f"Brand voice: got {pages_sampled}/{len(selected)} pages (no JS) for {url}")

        if not page_contents and selected:
            # Tier 2: ScrapeOwl with JS render (handles React/Vue/Wix/Webflow sites)
            logger.info(f"Brand voice: no text from tier 1 — retrying top 5 pages with JS render")
            page_contents = await _scrapeowl_extract(selected[:5], render_js=True)
            if page_contents:
                logger.info(f"Brand voice: JS render recovered {len(page_contents)} pages for {url}")
            else:
                logger.warning(f"Brand voice: all scraping tiers failed for {url} — falling back to category inference")
    else:
        logger.info(f"Brand voice: no website for {body.business_name} — using category inference")

    try:
        brand_voice = await analyze_brand_voice_with_anthropic(
            page_contents,
            body.business_name,
            gbp_category=getattr(body, 'gbp_category', ''),
        )
    except Exception as e:
        identifier = body.website_url or body.business_name
        logger.error(f"Brand voice Anthropic error for {identifier}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Our AI analysis service encountered an error. Please try again — if the problem continues, contact ShowUP support."
        )

    return BrandVoiceResponse(brand_voice=brand_voice, pages_sampled=pages_sampled)


# ══════════════════════════════════════════════════════════════════════════════
# Content Generation — Score, Generate, Reoptimize
# ══════════════════════════════════════════════════════════════════════════════

GENERATION_MODEL = "claude-sonnet-4-6"
SCORE_MODEL = "claude-sonnet-4-6"  # Sonnet for accurate rubric scoring — Haiku was unreliable on nuanced criteria

# Pricing per million tokens (cached input tokens billed at ~10% of normal input rate)
_MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-sonnet-4-6":          {"input": 3.00,  "output": 15.00},
    "claude-haiku-4-5-20251001":  {"input": 0.80,  "output":  4.00},
}

# ── Cached system prompts ────────────────────────────────────────────────────
# These are sent as system messages with cache_control so Anthropic caches the
# large static instruction blocks. Cache TTL is 5 minutes, refreshed on each hit.
# Cost on cache hit: ~10% of normal input token price.

_GEN_SYSTEM_PROMPT = """You are an expert local SEO content writer. Generate a complete, publish-ready local service page following the exact structure below.

OUTPUT FORMAT
Return valid HTML only. No markdown. No explanations outside the HTML. Structure:
<title>[SEE TITLE FORMULA BELOW]</title>
<article>
  [13 sections as specified below]
</article>
Then on a NEW LINE after </article>, output the JSON-LD schema block starting with <script type="application/ld+json"> (3 schema blocks in one script tag).

TITLE TAG FORMULA (follow exactly — do not deviate):
<title>[Power Word]! [Exact Match Keyword] | [Brand Name] | [Justification using entities] | [Additional persuasion + entities]</title>
- Power Word: a single urgent/emotional word (e.g. Trusted, Fast, Expert, Certified, Local, Licensed)
- Exact Match Keyword: the primary keyword verbatim
- Brand Name: the business name
- Justification: a short phrase using 1–2 Google entities that validates the claim (e.g. "Serving Anaheim Hills & Orange County")
- Additional persuasion: a benefit or proof point that includes 1–2 more entities (e.g. "Same-Day Response, No Overtime Fees")
- Total title length: no character limit — prioritise keyword density and entity coverage over brevity

AEO / LLM WRITING RULES — apply throughout every section

These rules make content retrievable by AI assistants (ChatGPT, Gemini, Perplexity) and
optimised for Answer Engine Optimisation. Follow all of them in every section.

1. ANSWER-FIRST: Open every section, paragraph, and FAQ answer with a direct claim.
   State the conclusion before the explanation.
   ✗ Bad:  "Tree service is a complex process that requires professional expertise..."
   ✓ Good: "[Brand] handles tree removal in Anaheim — including emergency situations."

2. ONE IDEA PER PARAGRAPH: Each <p> covers exactly one point. 3–5 sentences max.
   Wall-of-text paragraphs are not cited by LLMs. Short, focused paragraphs are.

3. QUESTION-FORMAT H3s: Where natural, write H3s as questions a real searcher would type.
   e.g. "Do you offer emergency tree removal in Anaheim?"
        "How much does tree trimming cost in Orange County?"
   LLMs use these as retrieval anchors — they match them against user queries directly.

4. DIRECT FAQ ANSWERS: Every FAQ answer opens with a direct yes/no or factual statement.
   ✗ Bad:  "That's a great question. It depends on..."
   ✓ Good: "Yes, [Brand] offers 24/7 emergency tree removal in Anaheim and surrounding cities."

5. BULLETED LISTS — use <ul> for features, services, inclusions, and what-to-expect items:
   - Each bullet is a complete, self-contained statement (no sentence fragments)
   - Lead with the outcome or benefit, not the feature name
   - 1–2 lines per bullet maximum
   - Minimum 3 bullets, maximum 8 per list
   - ✗ Bad bullet:  "Fast service"
   - ✓ Good bullet: "Same-day response — crews dispatched within 2 hours for Anaheim emergencies"

6. NUMBERED LISTS — use <ol> for processes, steps, and how-it-works sequences:
   - Each step begins with an action verb
   - Include what the customer does AND what [Brand] does at each step
   - 3–5 steps is ideal; never exceed 7

7. TABLES — use <table><thead><tbody> only when content is genuinely comparative or multi-attribute.
   Do NOT force a table where a list or prose is more natural.
   USE a table when the page has data that fits 2–4 columns and ≥3 rows, such as:
   - Service tiers (e.g. trim vs. removal vs. emergency) with price range, timeline, availability
   - Response time by area/neighbourhood
   - What's included vs. excluded for a service
   - Side-by-side comparison of two or more service types
   DO NOT use a table for:
   - A simple list of services (use <ul> instead)
   - FAQ entries (question/answer is not tabular)
   - Step-by-step processes (use <ol> instead)
   - Geographic coverage lists (use prose or <ul> instead)
   When you do use a table:
   - Column headers must be specific (never "Option A / Option B")
   - Include a locally-relevant column where it fits naturally (e.g. city, response time)
   - Keep to 2–4 columns; never exceed 6
   - Precede every table with a <p> sentence introducing what it shows

8. SPECIFIC FACTS OVER VAGUE CLAIMS — LLMs cite specificity, not generalities:
   ✗ "We respond quickly."              → ✓ "Call us to confirm response time in Anaheim." (only use a specific timeframe if it is in the business data)
   ✗ "Serving the local area."          → ✓ "Serving Anaheim, Anaheim Hills, Yorba Linda & Orange County."
   ✗ "Competitive pricing."             → ✓ "Free estimates — no trip fee within a 15-mile radius." (only if stated in business data)

9. ENTITY TRIPLETS in ≥3 sections: [Brand] + [service] + [city] must co-occur in the
   intro, the main services body, the local section, and the FAQ. This establishes the
   entity relationship in LLM retrieval.

10. SECTION LENGTH ≤300 words: LLMs extract from dense sections poorly. If a topic needs
    more depth, split it into multiple H2 subsections rather than lengthening one section.

11. GEO SIGNALS ACROSS SECTIONS: City name, neighborhood references, and availability language
    must appear in ≥3 separate sections — not only in Section 10. Required distribution:
    - Section 1 (Intro): city name + at least 1 neighborhood or service area
    - Section 6 (Services): city name + coverage note in at least 1 H3
    - Section 10 (Local): full geo block (neighborhoods, landmark, ZIPs, coverage, response time)
    - Section 12 (FAQ): ≥2 answers reference a specific city or neighborhood

12. RESPONSE TIME — ONLY FROM BUSINESS DATA: Never write "quickly", "promptly", "fast response",
    or "soon". If response time IS in the business data (hours, GBP description, or reviews),
    state it with a specific number: ✓ "We arrive within 2–4 hours." ✓ "Same-day — book by 2pm."
    If response time is NOT in the business data, do NOT invent one. Write "Call us for availability"
    or omit the claim entirely. Add it to the Content Gaps report instead.
    NEVER fabricate: "same-day", "within X hours", "call before noon", or any specific time window
    that is not explicitly stated in the provided business data.

13. PHONE NUMBER PLACEMENT: The phone number must appear in Section 1 (intro paragraph).
    This ensures it is visible above the fold. It must also appear in Sections 4, 8, and 11.

14. ICP-MATCHED CTA TONE: The SEO checklist in the user prompt identifies the Ideal Customer
    Profile (ICP) for this keyword. All CTAs must match the ICP tone exactly:
    - Emergency ICP → urgency language: "Call Now", "Available 24/7", "Dispatch in 60 min"
    - Commercial ICP → professional: "Request a Quote", "Schedule a Site Assessment"
    - Budget ICP → value-first: "Get a Free Estimate", "No Trip Fee", "Transparent Pricing"
    - General ICP → confident: "Get a Quote Today", "Schedule Service"
    Repeat the ICP-appropriate CTA in ≥3 sections (hero, mid-page, closing).

BRAND VOICE vs. AEO STRUCTURE — TIEBREAKER RULES

These two sets of rules rarely conflict, but when they appear to, apply this hierarchy:

AEO rules govern STRUCTURE — where the answer sits, paragraph length, heading format,
list usage. These are layout decisions and are non-negotiable regardless of brand voice.

Brand voice governs EXPRESSION — word choice, tone, personality, sentence rhythm,
vocabulary. These apply within every structural element.

In practice: a warm, conversational brand still writes short paragraphs and answer-first
openings — it just does so in its own voice, not in a clinical or generic one.

THE ONE REAL CONFLICT ZONE — FAQ and section openers:
A direct answer must always come first, but it must be written in the brand's register.
✗ Cold brand voice applied wrongly: "Yes." (technically direct but robotic)
✗ Warm brand voice applied wrongly: "What a great question — it really depends on..." (buries the answer)
✓ Direct answer in brand voice:
  - Warm/friendly brand:   "Absolutely — our crews are on call 24/7, including weekends and holidays."
  - Professional/authoritative brand: "Yes. [Brand] provides 24/7 emergency response across Anaheim."
  - Urgent/emergency brand: "Yes — call now and we'll dispatch a crew within the hour."

The rule: lead with the answer, then let the rest of the sentence and paragraph carry the brand tone.

Section 1 — Intro / Direct Answer Block (100–150 words)
<section id="intro">
  <h1>[Exact Match Keyword] + [1–2 entities that reinforce location or service scope]</h1>
  H1 FORMULA: Write the primary keyword verbatim, then append relevant entities naturally (e.g. "Emergency Plumber Anaheim — Serving Anaheim Hills, Yorba Linda & Orange County")
  <p>[Brand] provides [service] to [city] — [primary differentiator stated in first sentence]. [Availability signal with specific timeframe, e.g. "available 24/7 with crews on-site within 2 hours".] [Phone number as a CTA, e.g. "Call [phone] now".] [Close with direct service claim + city + 1 neighborhood.]</p>
  NOTE: Phone number MUST appear in this paragraph. This section must mention city + ≥1 neighborhood.
</section>

Section 2 — USP / Value Proposition (150–200 words)
<section id="usp">
  <h2>[Single sentence combining: exact match keyword + persuasion/outcome + 1–2 entities]</h2>
  FIRST H2 FORMULA: Must be a complete sentence (not a fragment) that includes the primary keyword, a persuasive outcome or differentiator, and 1–2 entities. (e.g. "When Anaheim Homeowners Need an Emergency Plumber Fast, [Brand] Delivers Same-Day Repairs Across Orange County")
  [Min 3 differentiators with mechanisms. One contrast statement. One proof signal.]
</section>

Section 3 — Special Offers (omit this section if no offer data provided)
<section id="offers">...</section>

Section 4 — CTA Block Primary (50–75 words)
<section id="cta-primary">
  <h2>[Action-oriented H2]</h2>
  [Differentiated CTA — not "Contact us today". Include phone.]
</section>

Section 5 — Features and Benefits (150–200 words)
<section id="features">
  <h2>[Benefit-focused H2]</h2>
  <ul>[Min 4 feature/benefit pairs — outcome-first, ICP pain points addressed]</ul>
</section>

Section 6 — Main Service Body (800–1400 words)
<section id="services">
  Use the COMPETITOR H2/H3 HEADINGS from the SERP data above as your structural baseline.
  Cover every topic competitors cover, then add H2/H3 sections for topics competitors DON'T cover
  that would more fully answer the user's implied query — this is called INFORMATION GAIN and
  is critical for outranking competitors.

  Structure rules:
  - You MUST use MULTIPLE H2s within this section — each H2 block must be ≤300 words; split further into additional H2s if needed
  - Each H2 should represent a distinct major topic or service category
  - Use H3s under each H2 for sub-services, use cases, or scenarios
  - Every heading: include service/city naturally where it fits (not forced)
  - Open with a primary service description paragraph (answer-first)
  - Each H3: 2–4 sentences covering description, real-world scenario, differentiator, geo reference
  - List ALL sub-services or service types in individual H3 sections (e.g. if keyword is "plumber", include H3s for drain cleaning, water heater repair, pipe repair, etc. — each 2–4 sentences)
  - At least one H3 must include city or neighborhood name naturally in the heading text
  - Include a coverage or geo reference in at least one H3 body paragraph
  - Weave in the EXACT competitor 4-word phrases from the SEO checklist verbatim (do not paraphrase)
  - Do NOT copy competitor headings verbatim — use them to understand topic coverage, then write
    headings that are more specific, benefit-oriented, or locally relevant
</section>

Section 7 — Testimonials (include only if reviews provided above; omit if none)
<section id="testimonials">
  <h2>[Social proof H2]</h2>
  [Verbatim reviews only — first name + last initial, stars, date, full text]
</section>

Section 8 — CTA Block Secondary (50–75 words — different angle from Section 4)
<section id="cta-secondary">...</section>

Section 9 — Getting Started (150–200 words)
<section id="getting-started">
  <h2>[Process-focused H2]</h2>
  <ol>[3–5 steps, plain language, close with CTA]</ol>
</section>

Section 10 — Geographic / Local SEO Section (200–300 words)
<section id="local">
  <h2>[City + service in heading]</h2>
  [City + min 3 neighborhoods in sentence context (not just a list) + min 1 landmark + min 2 streets + zip codes (min 3). Use only real, verifiable geographic details. If neighborhood/landmark/street/zip data is not provided in the business data, include only what you are certain is accurate for the target city. Do not invent or guess street names, zip codes, or landmarks. Coverage area required. Response time: ONLY include if explicitly stated in business hours, GBP description, or reviews — otherwise write "Call us for availability" or omit entirely.]
</section>

Section 11 — CTA Block Tertiary (50–75 words — urgency-forward)
<section id="cta-tertiary">...</section>

Section 12 — FAQ (min 4, max 7 entries — 40–80 words each)
<section id="faq">
  <h2>Frequently Asked Questions</h2>
  [Min 4, max 7 FAQ entries. Every answer opens with a direct yes/no or factual statement.]
  REQUIRED PROXIMITY FAQs — at least 2 entries must follow this pattern:
    Q: "Do you serve [specific neighborhood or city]?"
    A: "Yes, [Brand] serves [neighborhood]." (add availability language ONLY if explicitly in business data)
    Q: "How quickly can you respond to [city/neighborhood]?"
    A: If response time IS in business data: state it specifically (e.g. "Crews arrive within 2 hours").
       If response time is NOT in business data: "Contact us directly to confirm scheduling and availability in [neighborhood]."
       NEVER invent a timeframe — not "same-day", not "within X hours", not "call before noon".
  REQUIRED TOPICS (spread remaining entries across): coverage area, service process, what to expect, pricing (only if stated), emergency service (only if offered per business data).
  Each answer must include a specific verifiable fact — city name, service name, or process step. Do NOT invent specific times, prices, or credentials.
</section>

Section 13 — Schema (delivered AFTER </article> as a separate <script> block)
Generate 3 schema blocks as a single JSON-LD array inside one <script type="application/ld+json"> tag:
1. LocalBusiness (subtype from category: Plumber/HVACBusiness/Electrician etc.)
2. Service
3. FAQPage (auto-extracted from Section 12)

HARD RULES — NEVER:
- Start with "Welcome to [Brand]"
- Use "We are a [city] [service] company" as first sentence
- Write "Contact us today" as standalone CTA
- Use generic headings ("About Us", "Our Services", "Why Choose Us")
- Use "near me" literally in body content
- Include placeholder text like [Insert here]
- Fabricate reviews
- Use vague differentiators ("trusted", "professional", "high quality") without a mechanism
- Invent or guess phone numbers, addresses, hours, zip codes, street names, or landmarks not explicitly provided in the business data
- Use vague response language ("quickly", "promptly", "fast", "soon") — always use a specific timeframe
- Ignore the GBP_CATEGORY provided in the SEO checklist — the exact category label must appear naturally in title, H1, and ≥2 body sections

FACTUAL ACCURACY — CRITICAL
Only assert claims that are explicitly present in the business data provided in the user prompt.
Do NOT invent or assume:
- Response times or arrival windows (unless in GBP description, reviews, or hours)
- Certifications, licenses, bonding, insurance (unless explicitly stated in business data)
- Years in business, founding date, or team size
- Specific pricing, fees, or guarantees
- Named team members, technicians, or owners
- Awards, accreditations, or recognitions
- Specific sub-services beyond what appears in the GBP category, GBP description, or reviews

You MAY include:
- Standard industry service types implied by the GBP category (e.g. "Plumber" implies drain cleaning, pipe repair — but NOT "licensed plumber" or specific credentials)
- Geographic facts (city, neighborhoods, zip codes) provided in the SEO checklist
- Competitor-informed topic structure (headings, sections) without copying their specific claims
- For response times and availability: ONLY use explicit values from GBP hours, description, or reviews; if not available write "Contact us for availability" or omit the claim entirely

You MUST NOT imply or state:
- Certifications, credentials, or professional designations (e.g. "certified arborist", "licensed contractor", "NATE-certified", "ISA member") unless explicitly in business data — these are NOT implied by GBP category
- Insurance, bonding, or licensing status unless explicitly stated in business data
- Response times, scheduling windows, or availability promises (e.g. "same-day", "call before noon", "within 2 hours", "next-day") unless explicitly stated in business data

CONTENT GAPS REPORT — REQUIRED OUTPUT
After the JSON-LD </script> block, on a new line output:
CONTENT_GAPS_REPORT_START
Then output a JSON array (minified, no extra whitespace) of gap objects, each with these fields:
  category: string  (e.g. "Response Time", "Certifications", "Pricing")
  missing: string   (what fact is absent)
  score_impact: "high" | "medium" | "low"
  why_important: string  (1-2 sentences on how it would improve the SEO score)
  how_to_add: string  (practical instruction for the user: where to find/add this info)
Then output:
CONTENT_GAPS_REPORT_END

Only include gaps for facts that would measurably improve the page score and that you could NOT include because they weren't in the provided business data. Do not include gaps for information that is already present. If there are no gaps, output an empty array [].

ALWAYS check for these high-impact gaps and include them if missing from the business data:
1. Response time — if no specific arrival/response window (e.g. "within 2 hours", "same-day") was present in the business data, include this gap:
   {"category":"Response Time","missing":"Specific response or arrival window (e.g. 'within 2 hours', 'same-day appointments')","score_impact":"high","why_important":"The nearme_intent scoring engine requires an explicit response time. Without it the page cannot score 90+ — this is the single most common reason for a sub-90 score. Having this prominently on your website also builds trust with visitors and improves conversions.","how_to_add":"Add your typical response or arrival time to your website (e.g. on your homepage, about page, or services page). Once it's there, you can either manually add it to this page, or start the process over once all missing information has been added to your site for a fully optimised result."}
2. Service area / neighborhoods — if no specific neighborhoods or coverage areas were in the business data, flag it as a medium-impact gap with how_to_add explaining that having a clear service area listed on the website helps both customers and search engines understand coverage, and that they can manually add it to this page or restart once the site is updated.
3. Certifications / licences — if the GBP category implies them (plumber, electrician, HVAC, contractor) but none were stated, flag as medium-impact with how_to_add explaining that licences and certifications are a key trust signal that customers look for, and that they should be listed on the website's about or services page — then either manually added to this page or the process restarted."""

_REOPT_SYSTEM_PROMPT = """You are an expert local SEO content writer. Fix the SEO deficiencies in the existing page while keeping its design intact.

WHAT YOU CAN CHANGE:
- Text between existing HTML tags (rewrite copy freely)
- SEO attributes: alt, title, meta[content], og:title, og:description, aria-label, JSON-LD schema text values
- Add new HTML elements (paragraphs, lists, headings, sections) inserted wherever they fit most naturally in the page flow

WHAT YOU MUST NOT CHANGE:
- Existing HTML tag names, CSS classes, IDs, data-* attributes, href, src, or any non-content attributes
- Do not remove or reorder any existing HTML elements

SERP SIGNAL COVERAGE — EXACT SUBSTRING MATCHING (15% of composite score):
15% of the composite score is computed by a deterministic Python engine that checks for
exact lowercase substring matches of competitor keywords, Google entities, and 4-word phrases
in specific HTML zones (title, H1, H2/H3 headings, paragraph text).
Paraphrasing, synonyms, or reordering DO NOT count — the exact string must appear in the zone.
The user prompt contains COMPETITOR SIGNAL DATA showing which terms are still missing per zone.
Prioritise adding those exact strings before making any other changes.

SERP SIGNAL TARGETS — apply these to the corresponding zones:
The user prompt contains COMPETITOR SIGNAL DATA with per-zone keyword and entity targets.
Follow those targets exactly:
- PAGE TITLE: rewrite the <title> tag text to hit the keyword and entity targets for that zone
- H1: rewrite the H1 text to hit the keyword and entity targets for that zone
- H2/H3: rewrite existing subheadings and add new ones where needed to hit those targets
- PARAGRAPHS: weave missing keywords, entities, and quadgram phrases naturally into paragraph text
If the existing page is missing a zone entirely (e.g. no H1, no FAQ), add it at the most natural location.

PLACEMENT RULES FOR NEW CONTENT:
- Insert new content where it reads most naturally — not always at the bottom
- A missing FAQ? Insert it after the main service description
- A missing local geo block? Insert it near any existing location references
- Think about page flow: intro → services → social proof → local → FAQ → CTA
- New elements use semantic HTML (<section>, <h2>, <ul>, <p> etc.) — the site's CSS will style them

AEO / LLM WRITING RULES — apply to all text and any new content added:
1. ANSWER-FIRST: Open every section and FAQ answer with a direct claim.
2. ONE IDEA PER PARAGRAPH: Each <p> covers exactly one point. 3–5 sentences max.
3. QUESTION-FORMAT H3s: Where natural, write H3s as questions a real searcher would type.
4. DIRECT FAQ ANSWERS: Every FAQ answer opens with a direct yes/no or factual statement.
5. BULLETED LISTS — use <ul> for features, services, inclusions, what-to-expect items.
6. NUMBERED LISTS — use <ol> for processes, steps, how-it-works sequences.
7. TABLES — only when content is genuinely comparative. Never force a table.
8. SPECIFIC FACTS OVER VAGUE CLAIMS — cite numbers, timeframes, named places.
9. ENTITY TRIPLETS in ≥3 sections: [Brand] + [service] + [city] must co-occur.
10. SECTION LENGTH ≤300 words.

HARD RULES — NEVER:
- Change any CSS class, ID, or HTML attribute on existing elements
- Remove or reorder existing HTML elements
- Use "near me" literally in body content
- Fabricate reviews or invent addresses/phone numbers not provided
- Include placeholder text like [Insert here]

Return the complete page HTML with all changes applied. No markdown, no explanations."""

_SCORE_SYSTEM_PROMPT = """You are an expert local SEO analyst. Score the provided page against all 7 engines below.

IMPORTANT: These 7 engines account for 85% of the composite score. The remaining 15% is
scored separately by a deterministic Python engine (SERP Signal Coverage) that checks
exact keyword/entity/quadgram presence per HTML zone. You do NOT score that engine —
focus only on the 7 below.

SCORING CRITERIA — score each engine 0–100:

1. organic_ranking (weight 10%): keyword in title + H1 + opening ¶; service/transactional tone (not blog); CTA + phone visible; clear service offering.

2. gbp_maps (weight 20%): exact city name present; service matches GBP category; brand+service+city entity triplet; NAP signals consistent; multiple service mentions.

3. entity_establishment (weight 10%): brand+service+city co-occurrence in ≥3 sections; sub-services mentioned; descriptive anchor text signals; topical depth.

4. icp_alignment (weight 5%): detect ICP from keyword modifier (emergency→urgent tone; commercial→B2B tone; general→professional/reliable); CTA tone matches ICP (e.g. emergency ICP requires urgency/fear-based CTA, not generic "call for a free estimate"); pain points addressed; emotional register of copy matches searcher intent.

5. aeo_llm_retrieval (weight 20%): answer-first formatting (direct claim before explanation); FAQ with 4–7 entries (penalise if fewer than 4 or more than 7), each opening with a direct yes/no or factual statement; question-format H3s where appropriate; each section ≤300 words; ≥1 bulleted list with outcome-first bullets; ≥1 numbered list for a process or steps; tables used where content is genuinely comparative (service tiers, response times, inclusions) — penalise only if comparative data is present but no table was used; specific operational facts (numbers, timeframes, named places) rather than generic filler.

6. geographic_legitimacy (weight 10%): city in title+H1+opening ¶; ≥2 neighborhood references in sentence context; ≥1 landmark reference; ≥3 zip codes in visible content; geo signals in ≥3 page sections.

7. nearme_intent (weight 10%): phone above fold; availability language in opening block ("available now", "same-day", "emergency response"); response time stated explicitly (e.g. "arrive within 2 hours", "respond in 15 minutes"); ≥2 neighborhood+service+availability blocks; ≥1 street reference; ≥2 proximity FAQs (availability/response/coverage/emergency).

Return ONLY valid JSON — no markdown, no explanation:
{
  "organic_ranking":       {"score": 0, "issues": [], "recommendations": []},
  "gbp_maps":              {"score": 0, "issues": [], "recommendations": []},
  "entity_establishment":  {"score": 0, "issues": [], "recommendations": []},
  "icp_alignment":         {"score": 0, "icp_detected": "", "issues": [], "recommendations": []},
  "aeo_llm_retrieval":     {"score": 0, "issues": [], "recommendations": []},
  "geographic_legitimacy": {"score": 0, "issues": [], "recommendations": []},
  "nearme_intent":         {"score": 0, "issues": [], "recommendations": []}
}

Be specific — reference actual content found (or missing) in the page."""

def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = _MODEL_PRICING.get(model, {"input": 3.00, "output": 15.00})
    return (input_tokens * p["input"] / 1_000_000) + (output_tokens * p["output"] / 1_000_000)

def _token_record(endpoint: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    cost = _calc_cost(model, input_tokens, output_tokens)
    logger.info(f"[tokens] {endpoint} model={model} in={input_tokens} out={output_tokens} cost=${cost:.5f}")
    return {
        "endpoint": endpoint,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": round(cost, 6),
    }

_ENGINE_WEIGHTS = {
    "organic_ranking":      0.10,
    "gbp_maps":             0.20,
    "entity_establishment": 0.10,
    "icp_alignment":        0.05,
    "aeo_llm_retrieval":    0.20,
    "geographic_legitimacy":0.10,
    "nearme_intent":        0.10,
    "serp_signal_coverage": 0.15,   # deterministic — scored in Python, not Claude
}

_ENGINE_LABELS = {
    "organic_ranking":       "Organic Ranking Engine",
    "gbp_maps":              "GBP / Maps Relevance Engine",
    "entity_establishment":  "Entity Establishment Engine",
    "icp_alignment":         "ICP Alignment Engine",
    "aeo_llm_retrieval":     "AEO / LLM Retrieval Engine",
    "geographic_legitimacy": "Geographic Legitimacy Engine",
    "nearme_intent":         "Hyperlocal / Near-Me Engine",
    "serp_signal_coverage":  "SERP Signal Coverage",
}

def _compute_serp_signal_coverage(page_html: str, serp_analysis: Optional[dict]) -> dict:
    """
    Deterministically score how well the page covers the SERP signals identified
    from competitor analysis: related keywords (per zone), Google NLP entities,
    and quadgrams.  Runs in Python — not scored by Claude — so results are
    precise, reproducible, and cost no extra tokens.
    """
    if not serp_analysis:
        return {
            "score": 50,
            "issues": ["No SERP analysis available — signal coverage could not be measured."],
            "recommendations": ["Run a keyword analysis first to enable SERP signal coverage scoring."],
        }

    soup = BeautifulSoup(page_html, "html.parser")
    page_text_lower = soup.get_text(" ", strip=True).lower()

    # Zone text (mirrors _parse_page_zones; falls back to full text for plain-text input)
    title_el = soup.find("title")
    h1_el    = soup.find("h1")
    p_text   = " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all("p"))
    zones = {
        "title":     title_el.get_text(" ", strip=True).lower() if title_el else page_text_lower[:300],
        "h1":        h1_el.get_text(" ", strip=True).lower() if h1_el else "",
        "h2_h3":     " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all(["h2", "h3"])),
        "paragraphs": p_text or page_text_lower,
    }

    rk       = serp_analysis.get("related_keywords", {})
    zt       = serp_analysis.get("zone_targets", {})
    entities = serp_analysis.get("google_entities", [])
    quadgrams = serp_analysis.get("top_quadgrams", [])

    issues: list[str] = []
    recommendations: list[str] = []

    # ── 1. Related keyword coverage per zone  (50% of engine score) ─────────────
    zone_label_map = {
        "title": "title tag", "h1": "H1",
        "h2_h3": "H2/H3 headings", "paragraphs": "paragraphs",
    }
    zone_scores: list[float] = []
    for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
        terms  = rk.get(zone_key, [])[:12]
        target = zt.get(zone_key, {}).get("target", 0)
        if not terms or not target:
            continue
        zone_text = zones[zone_key]
        found   = [t["term"] for t in terms if t["term"].lower() in zone_text]
        missing = [t["term"] for t in terms if t["term"].lower() not in zone_text]
        coverage = min(len(found) / max(target, 1), 1.0)
        zone_scores.append(coverage)
        gap = max(0, target - len(found))
        if gap > 0 and missing:
            zlabel = zone_label_map[zone_key]
            issues.append(
                f"{zlabel.capitalize()}: {len(found)}/{target} keyword targets met — "
                f"missing: {', '.join(missing[:5])}"
            )
            recommendations.append(
                f"Add {gap} more keyword{'s' if gap > 1 else ''} to {zlabel}: "
                f"{', '.join(missing[:5])}"
            )

    kw_score = (sum(zone_scores) / len(zone_scores) * 100) if zone_scores else 50.0

    # ── 2. Google NLP entity coverage per zone  (50% of engine score) ──────────
    top_entities = sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:15]
    ent_zone_scores: list[float] = []
    if top_entities:
        for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
            entity_target = zt.get(zone_key, {}).get("entity_target", 0)
            if not entity_target:
                continue
            zone_text = zones[zone_key]
            found_ents   = [e["name"] for e in top_entities if e["name"].lower() in zone_text]
            missing_ents = [e["name"] for e in top_entities if e["name"].lower() not in zone_text]
            coverage = min(len(found_ents) / max(entity_target, 1), 1.0)
            ent_zone_scores.append(coverage)
            gap = max(0, entity_target - len(found_ents))
            if gap > 0 and missing_ents:
                zlabel = zone_label_map[zone_key]
                issues.append(
                    f"{zlabel.capitalize()}: {len(found_ents)}/{entity_target} entity targets met — "
                    f"missing: {', '.join(missing_ents[:5])}"
                )
                recommendations.append(
                    f"Add {gap} more {'entity' if gap == 1 else 'entities'} to {zlabel}: "
                    f"{', '.join(missing_ents[:5])}"
                )
        ent_score = (sum(ent_zone_scores) / len(ent_zone_scores) * 100) if ent_zone_scores else 75.0
    else:
        ent_score = 75.0

    # ── 3. Quadgram coverage  (20% of engine score) ──────────────────────────────
    top_qg = quadgrams[:10]
    if top_qg:
        found_qg   = [q["phrase"] for q in top_qg if q["phrase"].lower() in page_text_lower]
        missing_qg = [q["phrase"] for q in top_qg if q["phrase"].lower() not in page_text_lower]
        qg_score = (len(found_qg) / len(top_qg)) * 100
        if missing_qg:
            issues.append(
                f"Missing {len(missing_qg)}/{len(top_qg)} competitor phrases: "
                f"{', '.join(missing_qg[:4])}"
            )
            recommendations.append(
                f"Weave these competitor phrases into paragraph text: "
                f"{', '.join(missing_qg[:4])}"
            )
    else:
        qg_score = 75.0

    composite = round(kw_score * 0.30 + ent_score * 0.50 + qg_score * 0.20, 1)
    return {
        "score":             composite,
        "issues":            issues,
        "recommendations":   recommendations,
        "keyword_coverage":  round(kw_score, 1),
        "entity_coverage":   round(ent_score, 1),
        "quadgram_coverage": round(qg_score, 1),
    }


def _composite_from_scores(scores: dict) -> tuple[float, str]:
    composite = sum(scores[k]["score"] * w for k, w in _ENGINE_WEIGHTS.items() if k in scores)
    if composite >= 90:   status = "excellent"
    elif composite >= 80: status = "good"
    elif composite >= 70: status = "needs_improvement"
    elif composite >= 60: status = "below_standard"
    else:                 status = "fail"
    return round(composite, 1), status

def _build_deficiencies(scores: dict) -> List[dict]:
    out = []
    for key, label in _ENGINE_LABELS.items():
        eng = scores.get(key, {})
        if eng.get("score", 100) < 80:
            out.append({
                "engine": label,
                "engine_key": key,
                "score": eng.get("score", 0),
                "issues": eng.get("issues", []),
                "recommendations": eng.get("recommendations", []),
            })
    return out


async def _score_html_inline(
    page_html: str,
    keyword: str,
    location: str,
    business_name: str,
    gbp_category: str,
    address: Optional[str],
    serp_analysis_dict: Optional[dict],
    client,
) -> tuple:
    """Score a page in-process (no HTTP). Returns (composite_score, deficiencies, scores, token_rec)."""
    from bs4 import BeautifulSoup as _BS
    html_structure = _detect_html_structure(page_html)
    page_text = _BS(page_html, "html.parser").get_text(separator="\n", strip=True)
    city = location.split(",")[0].strip()
    serp_ctx = _serp_context(serp_analysis_dict)
    user_prompt = _build_score_prompt(business_name, gbp_category, keyword, city, address, serp_ctx, page_text, html_structure)

    msg = await client.messages.create(
        model=SCORE_MODEL,
        max_tokens=8192,
        system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {"role": "user", "content": user_prompt},
        ],
    )
    token_rec = _token_record("score-page-inline", SCORE_MODEL, msg.usage.input_tokens, msg.usage.output_tokens)
    scores = _parse_claude_json(msg.content[0].text)
    if not scores:
        raise Exception("Inline scoring returned invalid JSON")
    scores["serp_signal_coverage"] = _compute_serp_signal_coverage(page_html, serp_analysis_dict)
    composite, _ = _composite_from_scores(scores)
    deficiencies = _build_deficiencies(scores)
    return composite, deficiencies, scores, token_rec


def _extract_reopt_parts(raw: str) -> tuple:
    """Extract (content_html, schema_json) from a reoptimized page HTML string.

    Real website pages have JSON-LD in the <head>, so a simple string split at
    '<script type="application/ld+json">' would cut off everything in <head> and
    leave content_html as just the head HTML (which renders as nothing visible).
    This function uses BeautifulSoup to properly extract body content and schemas.
    """
    from bs4 import BeautifulSoup as _BS
    soup = _BS(raw, 'html.parser')

    # Collect all JSON-LD scripts from anywhere in the doc
    ld_scripts = soup.find_all('script', type='application/ld+json')
    if ld_scripts:
        schema_json = '\n'.join(str(s) for s in ld_scripts)
        for s in ld_scripts:
            s.decompose()
    else:
        schema_json = None

    # Remove <head> entirely — we only want visible body content for the preview
    head = soup.find('head')
    if head:
        head.decompose()

    # Prefer body content; fall back to entire soup output
    body = soup.find('body')
    if body:
        content_html = body.decode_contents().strip()
    else:
        content_html = str(soup).strip()

    # Final fallback: if extraction somehow produced nothing, return raw as-is
    if not content_html:
        logger.warning("_extract_reopt_parts: body extraction yielded empty content; falling back to raw")
        content_html = raw

    return content_html, schema_json


async def _reoptimize_html_inline(
    existing_html: str,
    keyword: str,
    location: str,
    city: str,
    business_name: str,
    gbp_category: str,
    address: Optional[str],
    phone: Optional[str],
    deficiencies: List[dict],
    serp_analysis_dict: Optional[dict],
    seo_checklist: str,
    client,
) -> tuple:
    """Reoptimize HTML in-process. Returns (content_html, schema_json, page_title, token_rec)."""
    page_zones = _parse_page_zones(existing_html)
    serp_ctx = _reopt_serp_context(page_zones, serp_analysis_dict)

    deficiency_text = "\n".join(
        f"  Engine: {d['engine']} (score: {d['score']}/100)\n"
        f"  Issues: {'; '.join(d.get('issues', []))}\n"
        f"  Fixes needed: {'; '.join(d.get('recommendations', []))}"
        for d in deficiencies
    )

    user_prompt = f"""BUSINESS: {business_name} | CATEGORY: {gbp_category}
KEYWORD: {keyword} | CITY: {city}
PHONE: {phone or "[PHONE]"}
ADDRESS: {address or "Not provided"}
{serp_ctx}

{seo_checklist}

SEO DEFICIENCIES TO FIX (these must all be addressed in the rewrite):
{deficiency_text}

EXISTING PAGE (use as reference — preserve accurate facts, fix everything else):
{existing_html}"""

    claude_msg = await client.messages.create(
        model=GENERATION_MODEL,
        max_tokens=8000,
        system=[{"type": "text", "text": _REOPT_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_prompt}],
    )
    token_rec = _token_record("reoptimize-page-inline", GENERATION_MODEL, claude_msg.usage.input_tokens, claude_msg.usage.output_tokens)
    raw = claude_msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = re.sub(r'^```[a-zA-Z]*\n?', '', raw)
        raw = re.sub(r'\n?```$', '', raw)
        raw = raw.strip()

    title_match = re.search(r'<title>(.*?)</title>', raw, re.IGNORECASE | re.DOTALL)
    page_title = title_match.group(1).strip() if title_match else ""

    content_html, schema_json = _extract_reopt_parts(raw)
    content_html = _linkify_phones(content_html, phone)
    inline_entities = (serp_analysis_dict or {}).get("google_entities", [])
    content_html = _apply_rdfa_markup(content_html, inline_entities)

    return content_html, schema_json, page_title, token_rec


def _sse(data: dict) -> str:
    """Format a dict as a Server-Sent Event line."""
    return f"data: {json.dumps(data)}\n\n"


async def _sse_stream(worker_coro) -> StreamingResponse:
    """
    Wraps an async worker coroutine in an SSE StreamingResponse.
    The worker receives a queue and puts dicts onto it; this wrapper
    flushes keepalive pings every 10 s while waiting, so proxy timeouts
    don't kill the connection during long Claude calls.
    """
    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        try:
            await worker_coro(queue)
        except Exception as e:
            await queue.put({"step": "error", "message": str(e)})
        finally:
            await queue.put(None)  # sentinel

    async def _generate():
        task = asyncio.create_task(_run())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=10.0)
                    if item is None:
                        break
                    yield _sse(item)
                except asyncio.TimeoutError:
                    yield _sse({"step": "keepalive"})
        finally:
            task.cancel()

    return StreamingResponse(_generate(), media_type="text/event-stream")


def _parse_claude_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract JSON object from preamble text (model may add prose before/after)
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        logger.warning(f"_parse_claude_json: failed to parse JSON, returning empty dict. Raw: {text[:300]}")
        return {}

def compute_zone_targets(
    zone_buckets: Dict[str, List[str]],
    related: ZoneKeywords,
    google_entities: List[dict],
) -> Dict[str, dict]:
    """
    For each zone, count how many of the filtered related-keyword terms appear in
    each competitor page's zone text, then return the 75th-percentile count as the
    target. Using the 75th percentile (rather than max) avoids outlier competitor
    pages setting unrealistically high targets that inflate serp_signal_coverage
    scoring difficulty.
    Also computes per-zone entity targets using the same 75th-percentile approach.
    """
    targets: Dict[str, dict] = {}
    entity_names = {e["name"].lower() for e in google_entities} if google_entities else set()

    def _p75(values: list) -> int:
        if not values:
            return 0
        sorted_vals = sorted(values)
        idx = int(np.ceil(0.75 * len(sorted_vals))) - 1
        return sorted_vals[max(idx, 0)]

    for zone_name in ZONES:
        terms = getattr(related, zone_name, [])
        term_set = {t["term"].lower() for t in terms} if terms else set()
        term_counts: list[int] = []
        entity_counts: list[int] = []

        for page_text in zone_buckets.get(zone_name, []):
            if not page_text:
                continue
            cleaned = clean_text(page_text).lower()
            if term_set:
                term_counts.append(sum(1 for t in term_set if t in cleaned))
            if entity_names:
                entity_counts.append(sum(1 for e in entity_names if e in cleaned))

        targets[zone_name] = {
            "target":        _p75(term_counts),
            "entity_target": _p75(entity_counts),
        }

    return targets


def _detect_html_structure(page_html: str) -> str:
    """Return a plain-English summary of HTML structural elements present/missing."""
    from bs4 import BeautifulSoup as _BS
    soup = _BS(page_html, "html.parser")
    uls   = len(soup.find_all("ul"))
    ols   = len(soup.find_all("ol"))
    tables = len(soup.find_all("table"))
    lines = ["HTML STRUCTURE FACTS (deterministic — do NOT override):"]
    lines.append(f"  • <ul> (bulleted lists): {uls} found" + (" ✓" if uls >= 1 else " ✗ MISSING"))
    lines.append(f"  • <ol> (numbered lists): {ols} found" + (" ✓" if ols >= 1 else " ✗ MISSING"))
    lines.append(f"  • <table> elements: {tables} found" + (" ✓" if tables >= 1 else " — not required unless content is comparative"))
    return "\n".join(lines)


def _build_score_prompt(
    business_name: str,
    gbp_category: str,
    keyword: str,
    city: str,
    address: Optional[str],
    serp_ctx: str,
    page_text: str,
    html_structure: str = "",
) -> str:
    """Returns the dynamic user-message portion of the scoring prompt.
    The static system instructions are in _SCORE_SYSTEM_PROMPT (cached separately)."""
    structure_block = f"\n{html_structure}\n" if html_structure else ""
    return f"""CONTEXT
Business: {business_name}
Category: {gbp_category}
Keyword: {keyword}
City: {city}
Address: {address or "Not provided"}
{serp_ctx}{structure_block}
PAGE CONTENT (first 8,000 chars):
{page_text}"""


async def _derive_related_keywords(keyword: str, location: str, haiku_client) -> tuple:
    """Uses Claude Haiku to derive related keywords per site architecture SOP."""
    city = location.split(",")[0].strip()
    prompt = f"""You are a local SEO site architecture expert.

Given the keyword: "{keyword}"
And the city: "{city}"

Derive related keywords following these STRICT rules:

PARENTS (2-3 items):
- The bare service with no geo (e.g. "emergency plumber" → "plumber")
- The modifier + base service, no city (e.g. "emergency plumber")
- The base service + city (e.g. "plumber {city}")
Do NOT include the original keyword itself.

SIBLINGS (5-8 items):
- Other common sub-services under the SAME parent service + SAME city
- Format: [sub-service] {city} (e.g. "drain cleaning {city}")
- Peer services only — not the original keyword, not parent keywords

CHILDREN (3-4 items):
- Original keyword + specific NEIGHBORHOODS that are geographically WITHIN {city} only
- NOT adjacent cities, NOT county names, NOT broader regions
- Only include neighborhoods you are confident exist inside {city} city limits
- If uncertain, return fewer items

Return ONLY valid JSON, no markdown:
{{"parents": ["...", "..."], "siblings": ["...", ...], "children": ["...", ...]}}"""

    response = await haiku_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    token_rec = _token_record(
        "related-pages/derive", "claude-haiku-4-5-20251001",
        response.usage.input_tokens, response.usage.output_tokens,
    )
    result = _parse_claude_json(response.content[0].text)
    result["siblings"] = result.get("siblings", [])[:8]
    result["children"] = result.get("children", [])[:4]
    return result, token_rec


async def _find_page_for_keyword_reuse(
    kw: str,
    discovered_urls: List[str],
    client: httpx.AsyncClient,
) -> Optional[dict]:
    """Checks pre-discovered URLs for a page matching kw. Returns {url, title, h1} or None."""
    import urllib.parse as _up
    _BD = {
        "company","companies","contractor","contractors","professional","professionals",
        "provider","providers","specialist","specialists","expert","experts",
        "technician","technicians","team","crew","agency","firm","business",
        "near","me","best","top","trusted","reliable","affordable","licensed",
        "certified","local","cheap","fast",
    }
    kw_lower = kw.lower().strip()
    kw_words = [w for w in re.split(r'[\W_]+', kw_lower) if w and len(w) > 1 and w not in STOP_WORDS and w not in _BD]
    if not kw_words:
        kw_words = [w for w in re.split(r'[\W_]+', kw_lower) if w and len(w) > 1 and w not in STOP_WORDS]
    if not kw_words:
        kw_words = kw_lower.split()

    def _kw_match_local(kw_word: str, page_words: set) -> bool:
        if kw_word in page_words:
            return True
        if len(kw_word) >= 4:
            return any(pw.startswith(kw_word) or kw_word.startswith(pw) for pw in page_words if len(pw) >= 4)
        return False

    def _slug_score_local(u: str) -> int:
        path = _up.urlparse(u).path.lower()
        slug_words = set(re.split(r'[\W/_-]+', path))
        return sum(1 for w in kw_words if any(sw == w or sw.startswith(w) or w.startswith(sw) for sw in slug_words if len(sw) >= 3))

    _blog_seg = re.compile(
        r'/(blog|news|articles?|posts?|insights?|resources?|guides?|tips?|'
        r'updates?|press|media|events?|stories|announcements?|learn)(/|$)',
        re.IGNORECASE,
    )
    _blog_slug = re.compile(
        r'/\d{4}/\d{2}/|/\d{4}-\d{2}-\d{2}[-_]|'
        r'[/-](why|how|what|when|where|top-\d+|best-\d+|\d+-tips|\d+-ways|'
        r'everything-you-need|ultimate-guide|expert-tips|must-know|'
        r'beginners?-guide|complete-guide)-',
        re.IGNORECASE,
    )

    def _is_blog(u: str) -> bool:
        path = _up.urlparse(u).path
        return bool(_blog_seg.search(path) or _blog_slug.search(path))

    async def _check(u: str) -> Optional[dict]:
        try:
            resp = await client.get(u, timeout=8.0)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, 'html.parser')
            t = soup.find('title')
            h = soup.find('h1')
            title_text = t.get_text(strip=True) if t else ''
            h1_text = h.get_text(strip=True) if h else ''
            combined = set(re.split(r'[\W]+', f"{title_text} {h1_text}".lower()))
            if all(_kw_match_local(w, combined) for w in kw_words):
                return {'url': str(resp.url), 'title': title_text or u, 'h1': h1_text,
                        'is_blog_post': _is_blog(u)}
        except Exception:
            pass
        return None

    scored = sorted(discovered_urls, key=_slug_score_local, reverse=True)[:20]
    results = await asyncio.gather(*[_check(u) for u in scored], return_exceptions=True)
    matches = [r for r in results if isinstance(r, dict) and r]
    matches.sort(key=lambda r: r.get('is_blog_post', False))
    return matches[0] if matches else None


async def _score_page_for_related(
    keyword: str,
    location: str,
    page_url: str,
    business_name: str,
    gbp_category: str,
    address: Optional[str],
    haiku_client,
) -> tuple:
    """Scores a single found page using Haiku. Returns (score_dict, token_rec)."""
    from bs4 import BeautifulSoup as _BS2
    async with httpx.AsyncClient() as _fc:
        _resp = await _fc.get(page_url, timeout=15.0,
                              headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"})
        _resp.raise_for_status()
        page_html = _resp.text
    html_structure = _detect_html_structure(page_html)
    page_text = _BS2(page_html, "html.parser").get_text(separator="\n", strip=True)
    city = location.split(",")[0].strip()
    user_prompt = _build_score_prompt(business_name, gbp_category, keyword, city, address, "", page_text, html_structure)
    msg = await haiku_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {"role": "user", "content": user_prompt},
        ],
    )
    token_rec = _token_record(
        "related-pages/score", "claude-haiku-4-5-20251001",
        msg.usage.input_tokens, msg.usage.output_tokens,
    )
    scores = _parse_claude_json(msg.content[0].text)
    # No serp_analysis available in the related-pages path — coverage engine scores neutral
    scores["serp_signal_coverage"] = _compute_serp_signal_coverage(page_text, None)
    composite, status = _composite_from_scores(scores)
    return {
        "composite_score": composite,
        "composite_status": status,
        "engine_scores": scores,
        "deficiencies": _build_deficiencies(scores),
    }, token_rec


def _serp_context(serp_analysis: Optional[dict]) -> str:
    if not serp_analysis:
        return ""

    rk = serp_analysis.get("related_keywords", {})
    zt = serp_analysis.get("zone_targets", {})
    entities = serp_analysis.get("google_entities", [])
    quadgrams = serp_analysis.get("top_quadgrams", [])
    total_pages = len(serp_analysis.get("serp_urls", [])) or 10

    zone_labels = [
        ("title",      "PAGE TITLE (<title> tag)"),
        ("h1",         "H1 HEADING"),
        ("h2_h3",      "H2/H3 SUBHEADINGS"),
        ("paragraphs", "PARAGRAPHS (<p> tags)"),
    ]

    top_entities = sorted(entities, key=lambda e: e["page_spread"], reverse=True)[:15] if entities else []

    parts = ["""COMPETITOR SIGNAL DATA — match or exceed these targets in the corresponding zones:

NOTE: Related keywords and Google entities are two separate lists derived independently.
Related keywords come from TF-IDF analysis of competitor page text (topical relevance signal).
Google entities come from Google's Natural Language API (entity establishment signal).
There may be overlap — a term like "Anaheim" can appear on both lists. If it does,
using it once counts toward both the keyword target and the entity target for that zone."""]

    # Show entity list once up front so per-zone instructions can reference it
    if top_entities:
        ent_items = [f"{e['name']} (×{e['recommended_mentions']})" for e in top_entities]
        parts.append(f"\nGOOGLE ENTITIES — use these across the zones per the targets below:")
        parts.append(f"  {', '.join(ent_items)}")

    zone_display = {
        "title":      "title tag",
        "h1":         "H1",
        "h2_h3":      "H2 and H3 headings",
        "paragraphs": "paragraphs",
    }

    for zone_key, zone_label in zone_labels:
        terms = rk.get(zone_key, [])[:20]
        zone_data = zt.get(zone_key, {})
        term_target = zone_data.get("target", 0)
        entity_target = zone_data.get("entity_target", 0)
        if not terms and not entity_target:
            continue
        parts.append(f"\n{zone_label}:")
        if term_target and terms:
            parts.append(f"  Use {term_target} of these keywords in the {zone_display[zone_key]}: {', '.join(t['term'] for t in terms)}")
        elif terms:
            parts.append(f"  Keywords (ranked by relevance): {', '.join(t['term'] for t in terms)}")
        if entity_target and top_entities:
            parts.append(f"  Use {entity_target} of the above entities in the {zone_display[zone_key]}")

    if quadgrams:
        parts.append(f"\nTOP COMPETITOR PHRASES (4-word phrases — use naturally in body):")
        parts.append(f"  {', '.join(q['phrase'] for q in quadgrams[:15])}")

    # SERP bold keywords — terms Google highlights in search results
    bold_kws = serp_analysis.get("serp_bold_keywords", [])
    if bold_kws:
        parts.append(
            "\nGOOGLE-BOLDED KEYWORDS — these are the exact terms Google highlights in SERP "
            "snippets for this query. Use each term at least as many times as the top competitor:"
        )
        for bk in bold_kws[:20]:
            parts.append(
                f"  \"{bk['term']}\" — use ≥{bk['recommended_mentions']}× "
                f"(top competitor: {bk['max_competitor_uses']}×, "
                f"appears on {bk['page_spread']}/{total_pages} pages)"
            )

    headings = serp_analysis.get("competitor_headings", [])
    if headings:
        h2s = [h for h in headings if h["type"] == "h2"]
        h3s = [h for h in headings if h["type"] == "h3"]
        parts.append("\nCOMPETITOR H2/H3 HEADINGS (scraped from top-ranking pages — use these to inform Section 6 structure):")
        if h2s:
            parts.append("  H2s by frequency:")
            for h in h2s[:12]:
                parts.append(f"    \"{h['text']}\" ({h['page_count']} pages)")
        if h3s:
            parts.append("  H3s by frequency:")
            for h in h3s[:20]:
                parts.append(f"    \"{h['text']}\" ({h['page_count']} pages)")

    return "\n".join(parts)


def _parse_page_zones(html: str) -> dict:
    """Extract text content from each zone of an existing page."""
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.find("title")
    h1_el = soup.find("h1")
    return {
        "title": title_el.get_text(" ", strip=True).lower() if title_el else "",
        "h1": h1_el.get_text(" ", strip=True).lower() if h1_el else "",
        "h2_h3": " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all(["h2", "h3"])),
        "paragraphs": " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all("p")),
    }


def _reopt_serp_context(page_zones: dict, serp_analysis: Optional[dict]) -> str:
    """
    Build zone-by-zone delta instructions for reoptimize-page.
    For each zone, shows which keywords/entities are already present and
    which are still missing, with an explicit count of how many more are needed.
    """
    if not serp_analysis:
        return ""

    rk = serp_analysis.get("related_keywords", {})
    zt = serp_analysis.get("zone_targets", {})
    entities = serp_analysis.get("google_entities", [])
    quadgrams = serp_analysis.get("top_quadgrams", [])

    top_entities = sorted(entities, key=lambda e: e["page_spread"], reverse=True)[:15] if entities else []

    zone_labels = [
        ("title",      "PAGE TITLE (<title> tag)"),
        ("h1",         "H1 HEADING"),
        ("h2_h3",      "H2/H3 SUBHEADINGS"),
        ("paragraphs", "PARAGRAPHS (<p> tags)"),
    ]

    parts = [
        "COMPETITOR SIGNAL DATA — close the gap between this page and the top competitor in each zone.",
        "",
        "NOTE: Related keywords (TF-IDF) and Google entities (NLP API) are separate lists.",
        "A term appearing on both lists counts toward both targets when used once.",
    ]

    for zone_key, zone_label in zone_labels:
        terms = rk.get(zone_key, [])[:20]
        zone_data = zt.get(zone_key, {})
        term_target = zone_data.get("target", 0)
        entity_target = zone_data.get("entity_target", 0)
        if not terms and not entity_target:
            continue

        zone_text = page_zones.get(zone_key, "")

        parts.append(f"\n{zone_label}:")

        # Keywords delta
        if terms and term_target:
            present_kw = [t["term"] for t in terms if t["term"].lower() in zone_text]
            missing_kw = [t["term"] for t in terms if t["term"].lower() not in zone_text]
            still_need = max(0, term_target - len(present_kw))
            if present_kw:
                parts.append(f"  Keywords already present: {', '.join(present_kw)}")
            if still_need > 0 and missing_kw:
                parts.append(f"  ADD {still_need} more of these keywords: {', '.join(missing_kw[:15])}")
            elif still_need == 0:
                parts.append(f"  Keyword target met ({len(present_kw)}/{term_target})")

        # Entities delta
        if entity_target and top_entities:
            present_ent = [e["name"] for e in top_entities if e["name"].lower() in zone_text]
            missing_ent = [e["name"] for e in top_entities if e["name"].lower() not in zone_text]
            still_need_ent = max(0, entity_target - len(present_ent))
            if present_ent:
                parts.append(f"  Entities already present: {', '.join(present_ent)}")
            if still_need_ent > 0 and missing_ent:
                parts.append(f"  ADD {still_need_ent} more of these entities: {', '.join(missing_ent[:10])}")
            elif still_need_ent == 0:
                parts.append(f"  Entity target met ({len(present_ent)}/{entity_target})")

    # Quadgrams delta — check against full page text
    if quadgrams:
        full_page_text = " ".join(page_zones.values())
        missing_qg = [q["phrase"] for q in quadgrams[:15] if q["phrase"].lower() not in full_page_text]
        present_qg = [q["phrase"] for q in quadgrams[:15] if q["phrase"].lower() in full_page_text]
        parts.append("\nCOMPETITOR PHRASES (4-word phrases from top-ranking pages):")
        if present_qg:
            parts.append(f"  Already present: {', '.join(present_qg)}")
        if missing_qg:
            parts.append(f"  Weave these in naturally: {', '.join(missing_qg)}")

    # Competitor headings for structural reference
    headings = serp_analysis.get("competitor_headings", [])
    if headings:
        h2s = [h for h in headings if h["type"] == "h2"][:8]
        if h2s:
            parts.append("\nCOMPETITOR H2 HEADINGS (for structural reference):")
            for h in h2s:
                parts.append(f"  \"{h['text']}\" ({h['page_count']} pages)")

    return "\n".join(parts)


# ── Strategy-3 SEO checklist ──────────────────────────────────────────────────

def _detect_icp_from_keyword(keyword: str) -> tuple[str, str, str]:
    """Returns (icp_label, tone_instruction, cta_instruction) based on keyword modifiers."""
    kw = keyword.lower()
    if any(w in kw for w in ["emergency", "urgent", "24/7", "same day", "same-day", "asap", "immediate"]):
        return (
            "Emergency Homeowner (fear/urgency-driven)",
            "urgency and reassurance — they are stressed and need immediate help",
            '"Call now — we\'re available 24/7" / "Available right now" / "Don\'t wait — call us"',
        )
    if any(w in kw for w in ["commercial", "business", "office", "property", "hoa", "industrial"]):
        return (
            "Commercial Client (B2B, professional)",
            "professional and businesslike — emphasise reliability, insurance, minimal disruption",
            '"Request a commercial quote" / "Schedule a site assessment"',
        )
    if any(w in kw for w in ["cheap", "affordable", "budget", "low cost", "low-cost", "inexpensive"]):
        return (
            "Budget-Conscious Homeowner",
            "transparent and value-focused — lead with pricing clarity and no hidden fees",
            '"Get a free, no-obligation estimate"',
        )
    return (
        "General Homeowner (professional/reliable)",
        "confident and trustworthy — emphasise expertise, safety, and quality",
        '"Get a free estimate" / "Call for a quote"',
    )


async def _fetch_zip_codes_for_city(city: str, state: str, address: Optional[str], client) -> str:
    """Return a comma-separated list of ZIP codes for the city via a tiny Haiku call."""
    # Try extracting from address first
    zip_from_addr = None
    if address:
        m = re.search(r'\b(\d{5})\b', address)
        if m:
            zip_from_addr = m.group(1)

    location_str = f"{city}, {state}".strip(", ") or city
    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=80,
            messages=[{
                "role": "user",
                "content": (
                    f"List 6 real ZIP codes that serve {location_str}. "
                    "Return ONLY a comma-separated list of 5-digit ZIP codes, nothing else."
                ),
            }],
        )
        raw = msg.content[0].text.strip()
        zips = [z.strip() for z in raw.replace("\n", ",").split(",") if re.match(r'^\d{5}$', z.strip())]
        if zip_from_addr and zip_from_addr not in zips:
            zips = [zip_from_addr] + zips
        return ", ".join(zips[:6]) if zips else (zip_from_addr or f"local ZIP codes for {city}")
    except Exception:
        return zip_from_addr or f"local ZIP codes for {city}"


async def _build_seo_checklist(
    keyword: str,
    location: str,
    address: Optional[str],
    phone: Optional[str],
    gbp_category: str,
    serp_analysis: Optional[dict],
    client,   # Anthropic client — used for ZIP lookup
) -> str:
    """
    Build a concrete, data-driven SEO checklist from scoring rubric + SERP data + business data.
    Maps every engine requirement to specific values so Claude knows exactly what to produce.
    """
    city = location.split(",")[0].strip()
    state_parts = location.split(",")
    state = state_parts[1].strip() if len(state_parts) > 1 else ""

    icp_label, icp_tone, icp_cta = _detect_icp_from_keyword(keyword)
    is_emergency = "Emergency" in icp_label

    # ── Geo entities from SERP ───────────────────────────────────────────────
    # Extract LOCATION-type entities found across competitor pages — these are
    # real, verified local areas (neighborhoods, districts, nearby cities) that
    # top-ranking pages reference. More reliable than Claude's training knowledge.
    geo_names: list[str] = []
    if serp_analysis:
        state_lower = (state or "").lower()
        country_terms = {"united states", "us", "usa", "california", "texas", "florida", "new york",
                         "illinois", "ohio", "georgia", "north carolina", "michigan", "new jersey",
                         "virginia", "washington", "arizona", "massachusetts", "tennessee", "indiana",
                         "missouri", "maryland", "wisconsin", "colorado", "minnesota", "south carolina",
                         "alabama", "louisiana", "kentucky", "oregon", "connecticut", "utah", "iowa",
                         "nevada", "arkansas", "mississippi", "kansas", "new mexico", "nebraska",
                         "idaho", "west virginia", "hawaii", "new hampshire", "maine", "montana",
                         "rhode island", "delaware", "south dakota", "north dakota", "alaska",
                         "vermont", "wyoming", state_lower}
        for e in sorted(serp_analysis.get("google_entities", []),
                        key=lambda x: (-x.get("page_spread", 0), -x.get("mean_salience", 0))):
            if e.get("entity_type") != "LOCATION":
                continue
            name = e["name"].strip()
            name_lower = name.lower()
            # Skip the target city itself, state, country-level terms, and very short strings
            if name_lower == city.lower() or name_lower in country_terms or len(name) < 3:
                continue
            # Skip strings that are just numbers (ZIP codes handled separately)
            if name.isdigit():
                continue
            geo_names.append(name)
            if len(geo_names) >= 15:
                break

    # ── ZIP codes ────────────────────────────────────────────────────────────
    zip_codes = await _fetch_zip_codes_for_city(city, state, address, client)

    # ── Street reference from address ────────────────────────────────────────
    street_ref = ""
    if address:
        street_ref = address.split(",")[0].strip()

    # ── FAQ question suggestions from competitor headings ────────────────────
    faq_suggestions: list[str] = []
    if serp_analysis:
        for h in serp_analysis.get("competitor_headings", []):
            text = h.get("text", "")
            if "?" in text or any(text.lower().startswith(w) for w in
                                  ["how", "what", "when", "where", "why", "do ", "can ", "is ", "are ", "will "]):
                faq_suggestions.append(f'"{text}"')
            if len(faq_suggestions) >= 4:
                break

    # ── Build checklist ──────────────────────────────────────────────────────
    lines = [
        "━" * 60,
        "SEO SCORING CHECKLIST — satisfy ALL items below to score 90+.",
        "These are derived from the exact rubric used to grade your page.",
        "━" * 60,
        "",
        "【KEYWORD PLACEMENT — organic_ranking 10%】",
        f'  • <title> tag: must contain "{keyword}" and "{city}"',
        f'  • <h1>: must contain "{keyword}"',
        f'  • Opening paragraph: mention "{keyword}" within the first 2 sentences',
        f'  • Page tone: transactional/service (NOT informational or blog-style)',
        f'  • CTA and {phone or "phone number"} visible without scrolling',
        "",
        "【GBP / LOCAL SIGNALS — gbp_maps 20%】",
        f'  • Exact city name "{city}" in title, H1, and opening paragraph',
        f'  • Reference GBP category: "{gbp_category}"',
        f'  • Business name + service type + "{city}" must co-occur in ≥3 separate sections',
    ]

    if phone:
        lines.append(f'  • NAP: include phone {phone} in the page')
    if address:
        lines.append(f'  • NAP: include address "{address}"')

    lines += [
        "",
        "【GEOGRAPHIC LEGITIMACY — geographic_legitimacy 10%】",
        f'  • "{city}" must appear in title, H1, and opening paragraph',
    ]
    if geo_names:
        lines.append(f'  • Neighborhoods/areas to mention in sentence context (use ≥2): {", ".join(geo_names)}')
    else:
        lines.append(f'  • Include ≥2 neighborhood or district references near {city} in sentence context')
    lines += [
        f'  • ZIP codes — embed ≥3 of these in visible body text: {zip_codes}',
        f'  • Include ≥1 local landmark, street name, or recognizable reference near {city}',
        f'  • Geo signals must appear across ≥3 separate page sections (not all bunched together)',
        f'  • DISTRIBUTION RULE: do NOT save ZIP codes and neighborhood names only for Section 10.',
        f'    – Section 6 (services): mention {city} + at least 1 neighborhood in at least one H3 body paragraph',
        f'    – Section 12 (FAQ): at least 2 FAQ answers must reference a specific neighborhood or ZIP code',
        f'    – Section 10 (local): full geo block with all neighborhoods, landmarks, ZIPs, streets. Response time only if in business data.',
    ]
    if street_ref:
        lines.append(f'  • Street reference available from business address: "{street_ref}"')

    lines += [
        "",
        "【NEAR-ME INTENT — nearme_intent 10%】",
    ]
    if phone:
        lines.append(f'  • {phone} must appear ABOVE THE FOLD (in the hero/header section)')
    if is_emergency:
        lines.append('  • Opening block must include availability language — ONLY use what is in business data (e.g. hours show 24/7 → use "available 24/7"). If not in business data, write "Contact us for emergency availability" — do NOT invent "same-day" or response windows.')
    else:
        lines.append('  • Include availability language near the top ONLY if supported by business hours or GBP description.')
        lines.append('  • If no scheduling/response data is available, omit time claims and add them to the Content Gaps report.')
    lines += [
        '  • Include ≥2 blocks combining: [neighborhood name] + [service] + [availability signal]',
        '  • Include ≥2 FAQ entries on coverage area, response time, or service availability (proximity FAQs)',
    ]
    if street_ref:
        lines.append(f'  • Include street-level reference: "{street_ref}" or nearby street names')

    lines += [
        "",
        "【AEO / LLM RETRIEVAL STRUCTURE — aeo_llm_retrieval 20% ★ HIGHEST WEIGHT】",
        '  • Answer-first format: lead every section with the direct claim or answer BEFORE the explanation',
        '  • FAQ section: 4–7 entries EXACTLY (fewer than 4 or more than 7 will be penalised); each entry must OPEN with a direct yes/no or factual statement',
        '  • ≥2 of those FAQ entries must be proximity FAQs (coverage area, response time, emergency availability)',
    ]
    if faq_suggestions:
        lines.append(f'  • Suggested FAQ questions from top-ranking competitors: {", ".join(faq_suggestions)}')
    lines += [
        '  • ≥1 bulleted list with outcome-first bullets (benefit or result stated first)',
        '  • ≥1 numbered list for a process, steps, or how-it-works section',
        '  • Each content section ≤300 words — split longer topics into multiple H2 subsections',
        '  • Use question-format H3s where the content is naturally Q&A',
        '  • Include specific operational facts: named places, response times, certifications, service counts',
        '  • If the service involves tiers, response-time ranges by area, or pricing options, present them in an HTML <table> (header row + ≥2 data rows)',
    ]

    lines += [
        "",
        f'【ICP ALIGNMENT — icp_alignment 5%】',
        f'  • Detected ICP: {icp_label}',
        f'  • Tone: {icp_tone}',
        f'  • Primary CTA must match ICP intent: {icp_cta}',
        f'  • Repeat or rephrase the CTA in ≥2 additional sections (hero, mid-page, and closing)',
        f'  • Address the ICP\'s primary pain point directly in the first 2 sections',
        f'  • CTA button/link text must use ICP-appropriate urgency language (e.g. "Call Now" for emergency, "Get a Free Quote" for general)',
    ]

    # ── SERP keyword + entity targets (entity_establishment 15%) ────────────
    if serp_analysis:
        rk = serp_analysis.get("related_keywords", {})
        zt = serp_analysis.get("zone_targets", {})
        entities = serp_analysis.get("google_entities", [])
        quadgrams = serp_analysis.get("top_quadgrams", [])

        lines.append("")
        lines.append("【KEYWORD & ENTITY TARGETS — entity_establishment 10%】")
        for zone_key, zone_label in [
            ("title",      "Title tag"),
            ("h1",         "H1 heading"),
            ("h2_h3",      "H2/H3 subheadings"),
            ("paragraphs", "Paragraph text"),
        ]:
            terms = [t["term"] for t in rk.get(zone_key, [])[:12]]
            target = zt.get(zone_key, {}).get("target", 0)
            if terms and target:
                lines.append(f'  • {zone_label}: include ≥{target} of: {", ".join(terms)}')

        if entities:
            top_ents = sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:15]
            ent_names = [e["name"] for e in top_ents]
            lines.append(f'  • Entity pool (Google NLP — use these to establish topical authority): {", ".join(ent_names)}')
            lines.append(  '  • Distribute entities across zones as follows (≥N means at least that many from the pool above):')
            for zone_key, zone_label in [
                ("title",      "Title tag"),
                ("h1",         "H1 heading"),
                ("h2_h3",      "H2/H3 subheadings"),
                ("paragraphs", "Paragraph text"),
            ]:
                entity_target = zt.get(zone_key, {}).get("entity_target", 0)
                if entity_target:
                    lines.append(f'      – {zone_label}: ≥{entity_target} entities')
            lines.append(f'  • Business name + service + city must co-occur in ≥3 sections')

        if quadgrams:
            phrases = [q["phrase"] for q in quadgrams[:10]]
            lines.append(f'  • Competitor 4-word phrases — include these EXACT phrases verbatim in paragraph text (do NOT paraphrase): {", ".join(phrases)}')

    # ── SERP SIGNAL COVERAGE — deterministic engine (15% of composite) ────────
    if serp_analysis:
        rk = serp_analysis.get("related_keywords", {})
        zt = serp_analysis.get("zone_targets", {})
        entities = serp_analysis.get("google_entities", [])
        quadgrams_list = serp_analysis.get("top_quadgrams", [])
        top_entities_list = sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:15]

        lines.append("")
        lines.append("【SERP SIGNAL COVERAGE — serp_signal_coverage 15% ★ DETERMINISTIC SCORING】")
        lines.append("  ⚠ This engine is scored by EXACT SUBSTRING MATCHING in Python — not by AI judgement.")
        lines.append("  Every term below is checked as an exact lowercase substring in the corresponding HTML zone.")
        lines.append("  If the exact string is not found in the zone, it counts as a miss. Paraphrasing does NOT count.")
        lines.append("  Score formula: keyword coverage (30%) + entity coverage (50%) + quadgram coverage (20%)")
        lines.append("")

        for zone_key, zone_label in [
            ("title",      "TITLE TAG (<title>)"),
            ("h1",         "H1 HEADING (<h1>)"),
            ("h2_h3",      "H2/H3 SUBHEADINGS (across all <h2> and <h3> tags)"),
            ("paragraphs", "PARAGRAPH TEXT (across all <p> tags)"),
        ]:
            terms = rk.get(zone_key, [])[:12]
            zone_data = zt.get(zone_key, {})
            term_target = zone_data.get("target", 0)
            entity_target = zone_data.get("entity_target", 0)
            if not terms and not entity_target:
                continue

            lines.append(f"  {zone_label}:")
            if terms and term_target:
                term_names = [t["term"] for t in terms]
                lines.append(f'    Keywords (need ≥{term_target} EXACT matches): {", ".join(term_names)}')
            if entity_target and top_entities_list:
                ent_names = [e["name"] for e in top_entities_list]
                lines.append(f'    Entities (need ≥{entity_target} EXACT matches): {", ".join(ent_names)}')
            lines.append("")

        if quadgrams_list:
            qg_phrases = [q["phrase"] for q in quadgrams_list[:10]]
            lines.append(f'  QUADGRAM PHRASES (checked as exact substrings across full page text):')
            lines.append(f'    Include as many of these VERBATIM: {", ".join(qg_phrases)}')
            lines.append("")

    lines += ["", "━" * 60]
    return "\n".join(lines)


class FindPageRequest(BaseModel):
    website_url: str
    keyword: str
    location: Optional[str] = None

class FindPageResponse(BaseModel):
    found: bool
    page: Optional[dict] = None  # { url, title, h1 }
    is_blog_post: bool = False

@app.post('/find-page-for-keyword', response_model=FindPageResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def find_page_for_keyword(request: Request, body: FindPageRequest):
    """
    Lightweight site scan: check if the business has a page targeting the keyword.
    1. Discover URLs via sitemap (no per-page HTTP) or homepage nav fallback.
    2. Sort by URL slug keyword score (higher = more keyword words in path).
    3. Fetch top 20 pages concurrently and check title + H1 for keyword match.
    Returns { found, page? }.
    """
    import urllib.parse

    url = body.website_url.strip()
    if not url.startswith(('http://', 'https://')):
        url = f"https://{url}"

    kw = body.keyword.lower().strip()
    # Build keyword word list — filter stopwords and single-char tokens only
    kw_words = [w for w in re.split(r'[\W_]+', kw) if w and len(w) > 1 and w not in STOP_WORDS]
    if not kw_words:
        kw_words = [w for w in re.split(r'\s+', kw) if w]
    # Extract location words from the business location field for boosted slug scoring.
    # e.g. "Newport Beach, California" → ["newport", "beach", "california"]
    # These are used to rank location-specific service pages higher (slug scoring only,
    # not used in the keyword-match gate which is keyword-only).
    loc_words: list[str] = []
    if body.location:
        loc_raw = body.location.lower()
        loc_words = [w for w in re.split(r'[\W_]+', loc_raw) if w and len(w) > 2 and w not in STOP_WORDS]
    # Combined score words: service words + location words
    slug_score_words = kw_words + [w for w in loc_words if w not in kw_words]

    logger.info(f"find-page-for-keyword: kw_words={kw_words} loc_words={loc_words} for keyword='{body.keyword}'")

    parsed_base = urllib.parse.urlparse(url)
    base_netloc = parsed_base.netloc

    def _same_domain(u: str) -> bool:
        try:
            return urllib.parse.urlparse(u).netloc == base_netloc
        except Exception:
            return False

    def _word_in_slug(word: str, path: str) -> bool:
        """True if word matches the URL path, handling plurals in both directions.
        - singular keyword finds plural slug:  'service' in 'services' ✓
        - plural keyword finds singular slug:  'trees' finds 'tree-service' ✓ (via stem)
        """
        path = path.lower()
        word = word.lower()
        if word in path:
            return True
        # Strip trailing 's' or 'es' to get a stem, then check the stem
        if word.endswith('es') and len(word) > 4:
            return word[:-2] in path
        if word.endswith('s') and len(word) > 3:
            return word[:-1] in path
        return False

    def _slug_match_score(u: str) -> tuple:
        """Return (has_both_service_and_location, service_hits, loc_hits) for sorting."""
        path = urllib.parse.urlparse(u).path.lower()
        svc = sum(1 for w in kw_words if _word_in_slug(w, path))
        loc = sum(1 for w in loc_words if _word_in_slug(w, path))
        return (svc > 0 and loc > 0, svc, loc)

    def _kw_match(kw_word: str, page_words: set) -> bool:
        """Match a keyword word against page words, allowing plural/suffix variants."""
        if kw_word in page_words:
            return True
        if len(kw_word) >= 4:
            return any(pw.startswith(kw_word) or kw_word.startswith(pw) for pw in page_words if len(pw) >= 4)
        return False

    _BLOG_SEGMENTS = re.compile(
        r'/(blog|news|articles?|posts?|insights?|resources?|guides?|tips?|'
        r'updates?|press|media|events?|stories|announcements?|learn)(/|$)',
        re.IGNORECASE,
    )
    _BLOG_SLUG_PATTERNS = re.compile(
        r'/\d{4}/\d{2}/|'                      # /2024/03/ date path
        r'/\d{4}-\d{2}-\d{2}[-_]|'             # /2024-03-15-title
        r'[/-](why|how|what|when|where|top-\d+|'
        r'best-\d+|\d+-tips|\d+-ways|'
        r'everything-you-need|ultimate-guide|expert-tips|must-know|'
        r'beginners?-guide|complete-guide)-',
        re.IGNORECASE,
    )

    def _is_likely_blog_post(u: str) -> bool:
        path = urllib.parse.urlparse(u).path
        return bool(_BLOG_SEGMENTS.search(path) or _BLOG_SLUG_PATTERNS.search(path))

    async def _check_page(u: str, client: httpx.AsyncClient) -> Optional[dict]:
        try:
            resp = await client.get(u, timeout=8.0)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, 'html.parser')
            title_tag = soup.find('title')
            h1_tag = soup.find('h1')
            title_text = title_tag.get_text(strip=True) if title_tag else ''
            h1_text = h1_tag.get_text(strip=True) if h1_tag else ''
            combined_words = set(re.split(r'[\W]+', f"{title_text} {h1_text}".lower()))
            matched = sum(1 for w in kw_words if _kw_match(w, combined_words))
            # Require 75% of keyword words to match (so "company"/"contractor" etc.
            # not appearing in a service page title doesn't block a valid match)
            threshold = max(1, round(len(kw_words) * 0.75))
            if matched >= threshold:
                return {'url': str(resp.url), 'title': title_text or u, 'h1': h1_text,
                        'is_blog_post': _is_likely_blog_post(u)}
        except Exception:
            pass
        return None

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=15.0,
            headers=CRAWL_HEADERS,
        ) as client:
            # Discover site URLs
            discovered = await _discover_via_sitemap(url, client)
            if not discovered:
                logger.info(f"find-page-for-keyword: no sitemap for {url} — trying nav")
                discovered = await _discover_via_nav(url, client)

            origin = f"{parsed_base.scheme}://{parsed_base.netloc}"
            all_urls = list(dict.fromkeys(
                [origin] + [u for u in discovered if _same_domain(u)]
            ))
            logger.info(f"find-page-for-keyword: {len(all_urls)} URLs discovered for {url}")

            biz_location = (body.location or "").strip()

            # ── Step 1: Python substring filter ──────────────────────────────────────
            # Find every URL whose slug contains at least one service word OR one
            # location word.  No scoring heuristics — just plain string contains.
            svc_matches  = [u for u in all_urls if any(_word_in_slug(w, urllib.parse.urlparse(u).path) for w in kw_words)]
            loc_matches  = [u for u in all_urls if any(_word_in_slug(w, urllib.parse.urlparse(u).path) for w in loc_words)]
            # Union, deduplicated
            seen: set = set()
            candidate_pool: list = []
            for u in svc_matches + loc_matches:
                if u not in seen:
                    seen.add(u)
                    candidate_pool.append(u)
            # Sort: pages with both service + location in slug first, then by hit count
            candidate_pool.sort(key=_slug_match_score, reverse=True)
            candidate_pool = candidate_pool[:25]

            # ── site: search fallback ─────────────────────────────────────────────
            # Run when the sitemap had no keyword/location slug matches — meaning
            # the page either isn't in the sitemap or uses an unexpected URL pattern.
            # Uses Google's index via DataForSEO site: query to find indexed pages.
            if not svc_matches and not loc_matches and DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD:
                try:
                    city = (body.location or "").split(",")[0].strip()
                    site_query = f"site:{base_netloc} {body.keyword} {city}".strip()
                    logger.info(f"find-page-for-keyword: no sitemap slug matches — site-search: {site_query!r}")
                    credentials = base64.b64encode(
                        f"{DATAFORSEO_LOGIN}:{DATAFORSEO_PASSWORD}".encode()
                    ).decode()
                    _sr = await client.post(
                        DATAFORSEO_ENDPOINT,
                        headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
                        json=[{"keyword": site_query, "language_name": "English", "depth": 10, "se_domain": "google.com"}],
                        timeout=30.0,
                    )
                    if _sr.status_code == 200:
                        _sd = _sr.json()
                        for _task in (_sd.get("tasks") or []):
                            for _result in (_task.get("result") or []):
                                for _item in (_result.get("items") or []):
                                    if _item.get("type") == "organic":
                                        _u = _item.get("url", "")
                                        if _u and base_netloc in _u and _u not in candidate_pool:
                                            candidate_pool.append(_u)
                        logger.info(f"find-page-for-keyword: site-search added results, pool now {len(candidate_pool)}")
                except Exception as _se:
                    logger.warning(f"find-page-for-keyword: site-search failed ({_se})")

            # ── Direct URL guessing ───────────────────────────────────────────────
            # Probe slug permutations built from keyword + location words.
            # Runs after site: search so Google results take precedence; catches
            # pages not yet indexed by Google or missing from the sitemap.
            svc_slug = "-".join(kw_words)
            loc_slug = "-".join(loc_words[:2]) if loc_words else ""  # e.g. "newport-beach"
            guesses = []
            if svc_slug and loc_slug:
                guesses += [
                    f"{origin}/{loc_slug}-{svc_slug}/",
                    f"{origin}/{loc_slug}-{svc_slug}s/",
                    f"{origin}/{svc_slug}-{loc_slug}/",
                    f"{origin}/{svc_slug}s-{loc_slug}/",
                ]
            if svc_slug:
                guesses += [f"{origin}/{svc_slug}/", f"{origin}/{svc_slug}s/"]
            # Skip any URL already in the pool
            guesses = [g for g in guesses if g not in candidate_pool and g.rstrip('/') not in candidate_pool]

            async def _probe(u: str) -> Optional[str]:
                try:
                    r = await client.head(u, timeout=5.0)
                    return u if r.status_code in (200, 301, 302) else None
                except Exception:
                    return None

            probe_results = await asyncio.gather(*[_probe(g) for g in guesses])
            guessed = [u for u in probe_results if u]
            if guessed:
                logger.info(f"find-page-for-keyword: direct-guess found {guessed}")
                candidate_pool = candidate_pool + guessed

            # Generic fallback: if still nothing, take top 10 discovered URLs
            if not candidate_pool:
                candidate_pool = all_urls[:10]

            logger.info(f"find-page-for-keyword: {len(candidate_pool)} candidates ({len(svc_matches)} svc, {len(loc_matches)} loc matches from {len(all_urls)} total)")
            for i, u in enumerate(candidate_pool[:15]):
                score = _slug_match_score(u)
                logger.info(f"  candidate #{i+1} (both={score[0]}, svc={score[1]}, loc={score[2]}): {u}")

            # ── Step 2: Haiku picks the best candidate ────────────────────────────────
            haiku_pick: Optional[str] = None
            if ANTHROPIC_API_KEY and candidate_pool:
                try:
                    _ac = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
                    url_list_text = "\n".join(f"{i+1}. {u}" for i, u in enumerate(candidate_pool))

                    # Build location context line
                    location_context = biz_location if biz_location else "unknown"

                    location_rule = (
                        f"  - Target location: {location_context}\n"
                        f"  - Strongly prefer URLs whose slug contains BOTH the service words AND location words (e.g. city name).\n"
                        f"  - A URL with just the service words (no location in slug) is acceptable if no location-specific page exists.\n"
                    ) if biz_location else (
                        "  - Find the best dedicated service page for this service type.\n"
                    )
                    _msg = await _ac.messages.create(
                        model="claude-haiku-4-5-20251001",
                        max_tokens=64,
                        temperature=0,
                        messages=[{"role": "user", "content": (
                            f"Keyword: \"{body.keyword}\"\n"
                            f"Location: {location_context}\n\n"
                            f"Pick the single best URL below that is a DEDICATED SERVICE PAGE targeting this keyword for this location.\n"
                            f"Guidelines:\n"
                            f"{location_rule}"
                            f"  - Business-type words in the keyword (company, contractor, professional, etc.) will NOT appear in URL slugs — ignore them when scoring slug relevance\n"
                            f"  - Prefer URLs whose slug contains the core service concept (e.g. 'tree-service', 'tree-trimming') and optionally the location\n"
                            f"  - Reject blog posts, news, guides, how-to articles, about pages, homepages\n"
                            f"  - A near-match service page is better than no result — prefer the closest match over 0\n\n"
                            f"Reply with ONLY the number of the best URL, or 0 only if every URL is clearly a blog post or unrelated.\n\n"
                            f"{url_list_text}"
                        )}],
                    )
                    raw_pick = _msg.content[0].text.strip()
                    logger.info(f"find-page-for-keyword: Haiku raw response: {repr(raw_pick)}")
                    pick_num = int(re.search(r'\d+', raw_pick).group()) if re.search(r'\d+', raw_pick) else 0
                    if 1 <= pick_num <= len(candidate_pool):
                        haiku_pick = candidate_pool[pick_num - 1]
                        logger.info(f"find-page-for-keyword: Haiku picked #{pick_num} → {haiku_pick}")
                    else:
                        logger.info(f"find-page-for-keyword: Haiku returned 0 or out-of-range ({pick_num}), using regex fallback")
                except Exception as _he:
                    logger.warning(f"find-page-for-keyword: Haiku selection failed ({_he}), falling back to regex")

            # If Haiku picked a URL, trust it — fetch just enough to get title/H1
            if haiku_pick:
                try:
                    resp = await client.get(haiku_pick, timeout=8.0)
                    if resp.status_code == 200:
                        soup = BeautifulSoup(resp.text, 'html.parser')
                        title_tag = soup.find('title')
                        h1_tag = soup.find('h1')
                        title_text = title_tag.get_text(strip=True) if title_tag else haiku_pick
                        h1_text = h1_tag.get_text(strip=True) if h1_tag else ''
                        is_blog = _is_likely_blog_post(haiku_pick)
                        return FindPageResponse(
                            found=True,
                            page={'url': str(resp.url), 'title': title_text, 'h1': h1_text, 'is_blog_post': is_blog},
                            is_blog_post=is_blog,
                        )
                except Exception as _fe:
                    logger.warning(f"find-page-for-keyword: failed to fetch Haiku pick ({_fe}), falling back")

            # Fallback: check top candidates with keyword-in-title gate
            to_check = [u for u in candidate_pool if u != haiku_pick]
            results = await asyncio.gather(*[_check_page(u, client) for u in to_check])
            matches = [r for r in results if r]
            matches.sort(key=lambda r: r.get('is_blog_post', False))
            if matches:
                res = matches[0]
                is_blog = res.get('is_blog_post', False)
                logger.info(f"find-page-for-keyword: found {'blog' if is_blog else 'service'} page → {res['url']}")
                return FindPageResponse(found=True, page=res, is_blog_post=is_blog)

    except Exception as e:
        logger.warning(f"find-page-for-keyword error ({url}): {e}")

    logger.info(f"find-page-for-keyword: no match found for keyword='{body.keyword}' on {url}")
    return FindPageResponse(found=False)


# ── /score-page ───────────────────────────────────────────────────────────────

class ScorePageRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None  # DataForSEO numeric location code
    page_url: Optional[str] = None
    page_content: Optional[str] = None  # if omitted, fetched from page_url
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    serp_analysis: Optional[dict] = None

class ScorePageResponse(BaseModel):
    composite_score: float
    composite_status: str
    engine_scores: dict
    deficiencies: List[dict]
    token_usage: dict
    serp_analysis: Optional[dict] = None   # populated when analysis was run inline
    analysis_cost: Optional[dict] = None   # cost of the inline SERP analysis


@app.post('/score-page', response_model=ScorePageResponse)
@limiter.limit("10/minute")
async def score_page(request: Request, body: ScorePageRequest):
    # Dual auth: X-API-Key (proxied) OR Authorization Bearer JWT (direct)
    api_key = request.headers.get("X-API-Key")
    if api_key:
        if not NLP_API_KEY or api_key != NLP_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
    else:
        user_id = await _verify_jwt_get_user(request.headers.get("Authorization", ""))
        ok = await _deduct_credits_direct(user_id, 1, "/score-page", "Page scoring")
        if not ok:
            raise HTTPException(
                status_code=402,
                detail=json.dumps({"error": "Insufficient credits", "credits_required": 1, "code": "INSUFFICIENT_CREDITS"}),
            )

    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic
    client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    # ── Run SERP analysis inline if not provided ───────────────────────────────
    # Scoring against competitors requires SERP data. If the caller doesn't pass
    # serp_analysis (e.g. user hits Score directly without a prior analysis run),
    # we run the full pipeline here and return it so the frontend can cache it.
    inline_serp: Optional[AnalysisResponse] = None
    serp_analysis_dict: Optional[dict] = body.serp_analysis
    if not serp_analysis_dict:
        logger.info(f"score-page: no serp_analysis provided — running inline SERP analysis for '{body.keyword}'")
        try:
            inline_serp = await _run_serp_analysis(body.keyword, body.location, body.location_code)
            serp_analysis_dict = inline_serp.model_dump()
        except Exception as _serp_err:
            logger.warning(f"score-page: inline SERP analysis failed ({_serp_err})")
            raise HTTPException(status_code=503, detail="Could not fetch competitor data. Please try again in a moment.")

    from bs4 import BeautifulSoup as _BS
    page_html = body.page_content
    if not page_html and body.page_url:
        async with httpx.AsyncClient() as _fc:
            page_html = await _scrape_one(body.page_url, _fc, render_js=False)
            if not page_html:
                page_html = await _scrape_one(body.page_url, _fc, render_js=True)
        if not page_html:
            raise HTTPException(status_code=422, detail="Could not fetch the provided page URL. Check that it is correct and publicly accessible.")
    if not page_html:
        raise HTTPException(status_code=422, detail="Either page_content or page_url is required")
    html_structure = _detect_html_structure(page_html)
    page_text = _BS(page_html, "html.parser").get_text(separator="\n", strip=True)
    city = body.location.split(",")[0].strip()
    serp_ctx = _serp_context(serp_analysis_dict)

    user_prompt = _build_score_prompt(body.business_name, body.gbp_category, body.keyword, city, body.address, serp_ctx, page_text, html_structure)

    scores = None
    token_rec = None
    for attempt in range(2):
        try:
            msg = await client.messages.create(
                model=SCORE_MODEL,
                max_tokens=8192,
                system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[
                    {"role": "user", "content": user_prompt},
                ],
            )
            token_rec = _token_record("score-page", SCORE_MODEL, msg.usage.input_tokens, msg.usage.output_tokens)
            parsed = _parse_claude_json(msg.content[0].text)
            if parsed:
                scores = parsed
                break
            logger.warning(f"score-page: Claude returned empty/invalid JSON on attempt {attempt + 1}, {'retrying' if attempt == 0 else 'giving up'}")
        except Exception as e:
            logger.exception(f"Claude scoring error on attempt {attempt + 1}")
            if attempt == 1:
                raise HTTPException(status_code=502, detail="Scoring service temporarily unavailable. Please try again.")

    if not scores:
        raise HTTPException(status_code=502, detail="Scoring service returned an invalid response. Please try again.")

    # Inject deterministic SERP signal coverage (Python, not Claude)
    scores["serp_signal_coverage"] = _compute_serp_signal_coverage(page_html, serp_analysis_dict)

    composite, status = _composite_from_scores(scores)

    return ScorePageResponse(
        composite_score=composite,
        composite_status=status,
        engine_scores=scores,
        deficiencies=_build_deficiencies(scores),
        token_usage=token_rec,
        serp_analysis=serp_analysis_dict if inline_serp else None,
        analysis_cost=inline_serp.analysis_cost if inline_serp else None,
    )


# ── /augment-page ─────────────────────────────────────────────────────────────
# Patches an existing page with missing SEO signals (entities, related keywords,
# quadgrams, geographic modifiers, reviews) without rewriting unchanged content.
# Strict content preservation — sentences are rewritten only when needed to
# weave in target signals; structure, voice, and facts are kept intact.

_READABLE_KEEP_TAGS = {
    "main", "article", "section", "header", "footer", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "ul", "ol", "li", "dl", "dt", "dd", "blockquote",
    "table", "thead", "tbody", "tr", "th", "td", "caption",
    "strong", "em", "b", "i", "a", "br", "hr",
}
_READABLE_DROP_TAGS = {
    "script", "style", "link", "noscript", "iframe", "embed", "object",
    "video", "audio", "source", "canvas", "svg", "picture", "img", "figure",
    "figcaption", "form", "button", "input", "select", "textarea", "label",
    "nav", "menu",
}


def _strip_readable_html(html: str) -> tuple[str, str, str]:
    """Extract user-facing content from a scraped page.

    Returns (body_html, title, meta_description) — body_html is clean semantic
    markup with all classes, IDs, styles, comments, and non-content elements
    stripped. Headings, paragraphs, lists, tables, blockquotes, and links
    (with href only) are preserved.
    """
    soup = BeautifulSoup(html, "html.parser")

    title_el = soup.find("title")
    title = title_el.get_text(" ", strip=True) if title_el else ""

    meta_desc = ""
    md_el = soup.find("meta", attrs={"name": "description"})
    if md_el and md_el.get("content"):
        meta_desc = md_el["content"].strip()

    # Drop non-content elements entirely.
    for tag in soup(list(_READABLE_DROP_TAGS)):
        tag.decompose()
    # Drop HTML comments.
    from bs4 import Comment
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()

    # Prefer <main> or <article>; fall back to <body>.
    root = soup.find("main") or soup.find("article") or soup.find("body") or soup

    # Unwrap any tag we don't keep (preserves children).
    for tag in root.find_all(True):
        if tag.name not in _READABLE_KEEP_TAGS:
            tag.unwrap()

    # Strip every attribute except href on <a>.
    for tag in root.find_all(True):
        if tag.name == "a":
            href = tag.get("href")
            tag.attrs = {"href": href} if href else {}
        else:
            tag.attrs = {}

    # Serialize the cleaned root's children. Avoid the wrapper itself.
    body_html = "".join(str(c) for c in root.children).strip()
    # Collapse runs of empty whitespace lines.
    body_html = re.sub(r'\n\s*\n\s*\n+', '\n\n', body_html)
    return body_html, title, meta_desc


def _zone_text_from_clean_html(clean_body: str, title: str) -> dict:
    """Extract per-zone lowercase text from the cleaned body for gap detection."""
    soup = BeautifulSoup(clean_body, "html.parser")
    h1 = soup.find("h1")
    return {
        "title":     (title or "").lower(),
        "h1":        (h1.get_text(" ", strip=True).lower() if h1 else ""),
        "h2_h3":     " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all(["h2", "h3"])),
        "paragraphs": " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all("p")) or
                      soup.get_text(" ", strip=True).lower(),
    }


def _compute_augment_manifest(
    clean_body: str,
    title: str,
    serp_analysis: Optional[dict],
    has_testimonials_on_page: bool,
    reviews_available: int,
) -> dict:
    """Build a structured list of exactly what to add and where.

    Output shape:
    {
      "missing_keywords":  [{"term", "zone", "score"}, ...],
      "missing_entities":  [{"name", "zone", "salience"}, ...],
      "missing_quadgrams": [{"phrase"}, ...],
      "needs_testimonials": bool,
      "reviews_available":  int,
    }
    """
    manifest = {
        "missing_keywords":   [],
        "missing_entities":   [],
        "missing_quadgrams":  [],
        "needs_testimonials": (not has_testimonials_on_page) and reviews_available > 0,
        "reviews_available":  reviews_available,
    }
    if not serp_analysis:
        return manifest

    zones = _zone_text_from_clean_html(clean_body, title)
    full_text = " ".join(zones.values())

    rk = serp_analysis.get("related_keywords", {}) or {}
    zt = serp_analysis.get("zone_targets", {}) or {}
    for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
        terms  = (rk.get(zone_key) or [])[:12]
        target = (zt.get(zone_key) or {}).get("target", 0) or 0
        if not terms or not target:
            continue
        zone_text = zones[zone_key]
        already   = sum(1 for t in terms if t["term"].lower() in zone_text)
        gap       = max(0, target - already)
        if gap <= 0:
            continue
        for t in terms:
            if t["term"].lower() in zone_text:
                continue
            manifest["missing_keywords"].append({
                "term":  t["term"],
                "zone":  zone_key,
                "score": t.get("score", 0),
            })
            if sum(1 for x in manifest["missing_keywords"] if x["zone"] == zone_key) >= gap:
                break

    entities = sorted(serp_analysis.get("google_entities", []) or [],
                       key=lambda e: e.get("page_spread", 0), reverse=True)[:15]
    if entities:
        for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
            entity_target = (zt.get(zone_key) or {}).get("entity_target", 0) or 0
            if not entity_target:
                continue
            zone_text = zones[zone_key]
            already   = sum(1 for e in entities if e["name"].lower() in zone_text)
            gap       = max(0, entity_target - already)
            if gap <= 0:
                continue
            for e in entities:
                if e["name"].lower() in zone_text:
                    continue
                manifest["missing_entities"].append({
                    "name":     e["name"],
                    "zone":     zone_key,
                    "salience": e.get("mean_salience", 0),
                })
                if sum(1 for x in manifest["missing_entities"] if x["zone"] == zone_key) >= gap:
                    break

    for q in (serp_analysis.get("top_quadgrams") or [])[:10]:
        if q["phrase"].lower() not in full_text:
            manifest["missing_quadgrams"].append({"phrase": q["phrase"]})

    return manifest


def _build_reviews_block(reviews: List[dict]) -> Optional[str]:
    """Render a verbatim testimonials section from GBP reviews. Returns None if empty."""
    import html as _html
    qualifying = [r for r in (reviews or []) if (r.get("rating") or 0) >= 4][:5]
    if not qualifying:
        return None
    items = []
    for r in qualifying:
        rating = r.get("rating", 5)
        reviewer = (r.get("reviewer") or "").strip()
        text = (r.get("text") or "").strip()
        date = (r.get("date") or "").strip()
        # First name + last initial only (privacy).
        if reviewer:
            parts = reviewer.split()
            if len(parts) >= 2 and parts[-1]:
                reviewer = f"{parts[0]} {parts[-1][0]}."
        cite_bits = " — ".join(b for b in [reviewer, f"{rating}★", date] if b)
        items.append(
            f"<blockquote><p>{_html.escape(text)}</p>"
            f"<p><em>{_html.escape(cite_bits)}</em></p></blockquote>"
        )
    return "<section><h2>What Our Patients Say</h2>" + "\n".join(items) + "</section>"


_AUGMENT_SYSTEM_PROMPT = (
    "You augment an existing local-business page with missing SEO signals. "
    "Your prime directive is content preservation: the user's voice, structure, "
    "section ordering, and factual claims must be kept. You may rewrite an "
    "individual sentence to weave in a missing keyword, entity, or quadgram, "
    "but change as few words as possible — never remove information, change "
    "meaning, reorder sections, or invent facts that are not provided.\n\n"
    "Output rules:\n"
    "1. Return clean semantic HTML in the augmented_body_html field — no class, "
    "id, style, or data-* attributes. Allowed tags: section, article, header, "
    "footer, aside, h1-h6, p, ul, ol, li, dl, dt, dd, blockquote, table, thead, "
    "tbody, tr, th, td, strong, em, a (with href), br, hr.\n"
    "2. Insert the provided reviews block (if any) verbatim — do not modify the "
    "review text, ratings, or dates.\n"
    "3. For missing keywords/entities/quadgrams, weave them into the indicated "
    "zone (title, h1, h2_h3, or paragraphs). For paragraphs zone, prefer "
    "rewriting an existing sentence over appending a new one.\n"
    "4. For geographic gaps (neighborhoods, ZIPs, streets, landmarks), add a "
    "single natural sentence in the body — do not invent any geographic name "
    "that wasn't supplied in the manifest.\n"
    "5. Do not fabricate reviews, response times, certifications, prices, or "
    "guarantees not present in the original page or the supplied data.\n"
    "6. Track every change you make in applied_changes — every weave, every "
    "insertion, every heading rewrite."
)


_AUGMENT_TOOL = {
    "name": "submit_augmented_page",
    "description": "Submit the augmented page content and a structured changelog.",
    "input_schema": {
        "type": "object",
        "required": ["augmented_title", "augmented_meta_description",
                     "augmented_body_html", "applied_changes"],
        "properties": {
            "augmented_title":            {"type": "string", "description": "Rewritten <title> content (40-60 chars ideal)."},
            "augmented_meta_description": {"type": "string", "description": "Rewritten meta description (140-160 chars ideal)."},
            "augmented_body_html":        {"type": "string", "description": "Clean semantic HTML for the body content."},
            "applied_changes": {
                "type": "object",
                "required": ["entities_added", "related_keywords_added",
                             "quadgrams_added", "testimonials_added",
                             "geographic_signals_added", "title_rewritten",
                             "meta_description_rewritten", "headings_rewritten"],
                "properties": {
                    "entities_added": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["name", "zone"],
                            "properties": {
                                "name": {"type": "string"},
                                "zone": {"type": "string", "description": "title | h1 | h2_h3 | paragraphs"},
                                "mentions": {"type": "integer"},
                            },
                        },
                    },
                    "related_keywords_added": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["term", "zone"],
                            "properties": {
                                "term": {"type": "string"},
                                "zone": {"type": "string"},
                            },
                        },
                    },
                    "quadgrams_added": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["phrase"],
                            "properties": {"phrase": {"type": "string"}},
                        },
                    },
                    "testimonials_added":      {"type": "integer"},
                    "geographic_signals_added": {
                        "type": "object",
                        "properties": {
                            "neighborhoods": {"type": "integer"},
                            "zips":          {"type": "integer"},
                            "streets":       {"type": "integer"},
                            "landmarks":     {"type": "integer"},
                        },
                    },
                    "title_rewritten":            {"type": "boolean"},
                    "meta_description_rewritten": {"type": "boolean"},
                    "headings_rewritten": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["tag", "original", "new"],
                            "properties": {
                                "tag":      {"type": "string"},
                                "original": {"type": "string"},
                                "new":      {"type": "string"},
                            },
                        },
                    },
                },
            },
        },
    },
}


class AugmentPageRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    page_url: str
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    phone: Optional[str] = None
    reviews: Optional[List[dict]] = None
    serp_analysis: Optional[dict] = None  # cached SERP analysis from a prior /score-page call


class AugmentPageResponse(BaseModel):
    augmented_title: str
    augmented_meta_description: str
    augmented_body_html: str
    applied_changes: dict
    token_usage: dict
    serp_analysis: Optional[dict] = None
    analysis_cost: Optional[dict] = None


@app.post('/augment-page', response_model=AugmentPageResponse)
@limiter.limit("10/minute")
async def augment_page(request: Request, body: AugmentPageRequest):
    # Dual auth: X-API-Key (proxied) OR Authorization Bearer JWT (direct).
    api_key = request.headers.get("X-API-Key")
    if api_key:
        if not NLP_API_KEY or api_key != NLP_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
    else:
        user_id = await _verify_jwt_get_user(request.headers.get("Authorization", ""))
        ok = await _deduct_credits_direct(user_id, 1, "/augment-page", "Page augmentation")
        if not ok:
            raise HTTPException(
                status_code=402,
                detail=json.dumps({"error": "Insufficient credits", "credits_required": 1, "code": "INSUFFICIENT_CREDITS"}),
            )

    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    _block_ssrf(body.page_url)
    async with httpx.AsyncClient() as _fc:
        page_html = await _scrape_one(body.page_url, _fc, render_js=False)
        if not page_html:
            page_html = await _scrape_one(body.page_url, _fc, render_js=True)
    if not page_html:
        raise HTTPException(status_code=422, detail="Could not fetch the provided page URL. Check that it is correct and publicly accessible.")

    clean_body, original_title, original_meta = _strip_readable_html(page_html)

    # SERP analysis (cached or inline).
    inline_serp: Optional[AnalysisResponse] = None
    serp_analysis_dict: Optional[dict] = body.serp_analysis
    if not serp_analysis_dict:
        logger.info(f"augment-page: no serp_analysis provided — running inline for '{body.keyword}'")
        try:
            inline_serp = await _run_serp_analysis(body.keyword, body.location, body.location_code)
            serp_analysis_dict = inline_serp.model_dump()
        except Exception as e:
            logger.warning(f"augment-page: inline SERP analysis failed ({e})")
            raise HTTPException(status_code=503, detail="Could not fetch competitor data. Please try again.")

    # Detect whether the page already has a testimonials/reviews section — we
    # only auto-insert the reviews block if it doesn't.
    body_lower = clean_body.lower()
    has_testimonials_on_page = any(
        marker in body_lower
        for marker in ("testimonial", "patient review", "client review", "what our patients say",
                        "what our clients say", "review", "★")
    )

    qualifying_reviews_count = sum(1 for r in (body.reviews or []) if (r.get("rating") or 0) >= 4)
    manifest = _compute_augment_manifest(
        clean_body, original_title, serp_analysis_dict,
        has_testimonials_on_page=has_testimonials_on_page,
        reviews_available=qualifying_reviews_count,
    )

    reviews_block = None
    if manifest["needs_testimonials"]:
        reviews_block = _build_reviews_block(body.reviews or [])

    # Geographic context — let Claude weave these in only from the supplied list.
    address_zip = ""
    if body.address:
        m = re.search(r'\b(\d{5})\b', body.address)
        if m:
            address_zip = m.group(1)
    city = body.location.split(",")[0].strip()

    # ── Build user prompt ──────────────────────────────────────────────────────
    import json as _json
    manifest_block = _json.dumps({
        "missing_keywords":   manifest["missing_keywords"],
        "missing_entities":   manifest["missing_entities"],
        "missing_quadgrams":  manifest["missing_quadgrams"],
    }, indent=2)

    parts = [
        f"Business: {body.business_name}",
        f"Category: {body.gbp_category}",
        f"Target keyword: {body.keyword}",
        f"Target city: {city}",
        f"Address: {body.address or 'not provided'}{f' (ZIP {address_zip})' if address_zip else ''}",
        f"Phone: {body.phone or 'not provided'}",
        "",
        "ORIGINAL TITLE:",
        original_title or "(missing)",
        "",
        "ORIGINAL META DESCRIPTION:",
        original_meta or "(missing)",
        "",
        "ORIGINAL BODY HTML (this is what visitors read — preserve voice, facts, structure):",
        clean_body,
        "",
        "GAP MANIFEST (weave these in at the indicated zones):",
        manifest_block,
    ]
    if reviews_block:
        parts += [
            "",
            "TESTIMONIALS BLOCK (insert this verbatim as a new <section> in the body — do not modify):",
            reviews_block,
        ]
    parts += [
        "",
        f"Call submit_augmented_page with the rewritten title, meta description, "
        f"augmented body HTML, and a complete applied_changes log."
    ]
    user_prompt = "\n".join(parts)

    import anthropic as _anthropic
    aclient = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    msg = None
    for attempt in range(2):
        try:
            msg = await aclient.messages.create(
                model=GENERATION_MODEL,
                max_tokens=8192,
                tools=[_AUGMENT_TOOL],
                tool_choice={"type": "tool", "name": "submit_augmented_page"},
                system=[{"type": "text", "text": _AUGMENT_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_prompt}],
            )
            break
        except Exception as e:
            logger.exception(f"augment-page Claude error on attempt {attempt + 1}")
            if attempt == 1:
                raise HTTPException(status_code=502, detail="Augmentation service temporarily unavailable. Please try again.")

    if msg is None:
        raise HTTPException(status_code=502, detail="Augmentation service returned no response.")

    payload = None
    for block in msg.content:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == "submit_augmented_page":
            payload = dict(block.input)
            break
    if payload is None:
        raise HTTPException(status_code=502, detail="Augmentation service returned an invalid response.")

    token_rec = _token_record("augment-page", GENERATION_MODEL, msg.usage.input_tokens, msg.usage.output_tokens)

    return AugmentPageResponse(
        augmented_title=payload.get("augmented_title", original_title),
        augmented_meta_description=payload.get("augmented_meta_description", original_meta),
        augmented_body_html=payload.get("augmented_body_html", clean_body),
        applied_changes=payload.get("applied_changes", {}),
        token_usage=token_rec,
        serp_analysis=serp_analysis_dict if inline_serp else None,
        analysis_cost=inline_serp.analysis_cost if inline_serp else None,
    )


# ── /generate-page ────────────────────────────────────────────────────────────

class GeneratePageRequest(BaseModel):
    keyword: str
    location: str
    business_name: str
    gbp_category: str
    address: str
    phone: Optional[str] = None
    website: Optional[str] = None
    hours: Optional[str] = None
    gbp_description: Optional[str] = None
    differentiators: Optional[List[dict]] = None
    brand_voice: Optional[dict] = None
    detected_icp: Optional[dict] = None
    reviews: Optional[List[dict]] = None
    serp_analysis: Optional[dict] = None

class GeneratePageResponse(BaseModel):
    content_html: str
    schema_json: str
    page_title: str
    token_usage: dict
    cost_breakdown: dict = {}
    content_gaps: list = []


@app.post('/generate-page')
@limiter.limit("5/minute")
async def generate_page(request: Request, body: GeneratePageRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    # Auth: X-API-Key = proxied call (credits already deducted by edge function)
    #       Authorization Bearer = direct call (deduct credits here)
    api_key = request.headers.get("X-API-Key")
    if api_key:
        if not NLP_API_KEY or api_key != NLP_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
    else:
        user_id = await _verify_jwt_get_user(request.headers.get("Authorization", ""))
        ok = await _deduct_credits_direct(user_id, 2, "/generate-page", "New page creation")
        if not ok:
            raise HTTPException(
                status_code=402,
                detail=json.dumps({"error": "Insufficient credits", "credits_required": 2, "code": "INSUFFICIENT_CREDITS"}),
            )

    import anthropic as _anthropic

    async def _worker(q: asyncio.Queue):
        client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        city = body.location.split(",")[0].strip()
        _worker_start = time.monotonic()

        await q.put({"step": "progress", "progress": 5, "message": "Starting…"})

        # Run SERP analysis inline if not provided
        serp_analysis_dict = body.serp_analysis
        if not serp_analysis_dict:
            await q.put({"step": "progress", "progress": 10, "message": "Fetching top search results…"})
            try:
                inline_serp = await _run_serp_analysis(body.keyword, body.location)
                serp_analysis_dict = inline_serp.model_dump() if hasattr(inline_serp, "model_dump") else dict(inline_serp)
                await q.put({"step": "progress", "progress": 50, "message": "Analyzing competitor pages…"})
            except Exception as _serp_err:
                logger.warning(f"generate-page: inline SERP analysis failed ({_serp_err})")
                serp_analysis_dict = None

        serp_ctx = _serp_context(serp_analysis_dict)

        diff_text = ""
        if body.differentiators:
            diff_text = "Differentiators (use these — include mechanism for each):\n" + \
                "\n".join(f"  - {d.get('claim','')} (mechanism: {d.get('mechanism','')})" for d in body.differentiators)

        reviews_text = ""
        if body.reviews:
            qualifying = [r for r in body.reviews if r.get("rating", 0) >= 4][:5]
            if qualifying:
                reviews_text = "GBP Reviews (use verbatim in Section 7 — do NOT fabricate):\n" + \
                    "\n".join(f'  ★{r.get("rating")} — {r.get("reviewer","")}: "{r.get("text","")}" ({r.get("date","")})'
                              for r in qualifying)

        # Build brand voice block — defaults to the current voice; switches to
        # recommended only when the user explicitly accepted it.
        brand_voice_text = _build_brand_voice_text(body.brand_voice)

        # Build ICP block from the detailed Claude-generated profile (segments,
        # demographics, psychographics, messaging). Keyword-based ICP labelling
        # for CTA tone alignment lives separately in _detect_icp_from_keyword
        # and is injected by _build_seo_checklist().
        icp_text = _build_icp_text(body.detected_icp)

        # Scrape the business website for factual context (certifications, services, team info).
        # Strategy: ScrapeOwl no-JS → ScrapeOwl JS (if thin) → direct httpx (if ScrapeOwl unavailable).
        # Hits homepage + up to 3 key subpages concurrently. Total budget: 8,000 chars.
        website_text = ""
        if body.website:
            _SUBPAGE_KEYWORDS = ["about", "service", "certif", "team", "staff", "what-we-do", "our-work", "credential"]
            _WEBSITE_CHAR_BUDGET = 8000
            _PER_PAGE_LIMIT = 4000  # homepage gets up to this; subpages share the remainder

            def _extract_page_text(html: str) -> str:
                _s = BeautifulSoup(html, "html.parser")
                for _t in _s(["script", "style", "nav", "footer", "head"]):
                    _t.decompose()
                return _s.get_text(separator=" ", strip=True)

            def _find_subpage_urls(html: str, base: str) -> list:
                """Return up to 3 internal links that look like key subpages."""
                _s = BeautifulSoup(html, "html.parser")
                _base_netloc = _urlparse.urlparse(base).netloc
                _base_path = _urlparse.urlparse(base).path.rstrip("/")
                _seen: set = set()
                _matches: list = []
                for _a in _s.find_all("a", href=True):
                    _href = _a["href"].strip()
                    _full = _urlparse.urljoin(base, _href)
                    _p = _urlparse.urlparse(_full)
                    if _p.netloc != _base_netloc:
                        continue
                    _path = _p.path.rstrip("/").lower()
                    if _path in _seen or _path == _base_path:
                        continue
                    if any(kw in _path for kw in _SUBPAGE_KEYWORDS):
                        _seen.add(_path)
                        _matches.append(_full)
                    if len(_matches) >= 3:
                        break
                return _matches

            async def _fetch_html_for_website(url: str, so_client: httpx.AsyncClient) -> Optional[str]:
                """Fetch a page via ScrapeOwl (no-JS first, JS fallback), then direct httpx."""
                if SCRAPEOWL_API_KEY:
                    html = await _scrape_one(url, so_client, render_js=False)
                    if not html:
                        # JS fallback for Wix/Squarespace/Webflow sites
                        html = await _scrape_one(url, so_client, render_js=True)
                    if html:
                        return html
                # Last resort: direct httpx (no cost, but misses JS-rendered content)
                try:
                    _r = await so_client.get(
                        url,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"},
                        follow_redirects=True,
                    )
                    return _r.text if _r.status_code == 200 else None
                except Exception:
                    return None

            try:
                async with httpx.AsyncClient(timeout=45.0) as _so_client:
                    # Homepage
                    _home_html = await _fetch_html_for_website(body.website, _so_client)
                    _home_text = _extract_page_text(_home_html)[:_PER_PAGE_LIMIT] if _home_html else ""

                    # Detect subpages from homepage links, fetch concurrently
                    _subpage_urls = _find_subpage_urls(_home_html, body.website) if _home_html else []
                    _remaining_budget = _WEBSITE_CHAR_BUDGET - len(_home_text)
                    _per_sub = max(1000, _remaining_budget // max(len(_subpage_urls), 1)) if _subpage_urls else 0

                    _sub_texts: list = []
                    if _subpage_urls and _per_sub > 0:
                        _sub_htmls = await asyncio.gather(
                            *[_fetch_html_for_website(u, _so_client) for u in _subpage_urls],
                            return_exceptions=True,
                        )
                        for _u, _h in zip(_subpage_urls, _sub_htmls):
                            if isinstance(_h, Exception) or not _h:
                                continue
                            _st = _extract_page_text(_h)[:_per_sub]
                            if len(_st.strip()) > 100:
                                _sub_texts.append(f"[{_u}]\n{_st.strip()}")

                _sections: list = []
                if len(_home_text.strip()) > 100:
                    _sections.append(f"[{body.website}]\n{_home_text.strip()}")
                _sections.extend(_sub_texts)

                if _sections:
                    _combined = "\n\n".join(_sections)
                    website_text = (
                        "BUSINESS WEBSITE CONTENT (extract and use factual details — certifications, "
                        "license numbers, service areas, team credentials, specialties, etc.):\n"
                        + _combined
                    )
                    logger.info(
                        f"generate-page: scraped {len(_combined)} chars from {body.website} "
                        f"({len(_sections)} page(s), {len(_subpage_urls)} subpage(s) found)"
                    )
            except Exception as _we:
                logger.info(f"generate-page: website scrape skipped for {body.website}: {_we}")

        # If scraping yielded nothing, tell Claude explicitly so it can surface
        # certifications/credentials as a content gap rather than silently omitting them
        if body.website and not website_text:
            website_text = (
                f"BUSINESS WEBSITE NOTE: The website ({body.website}) could not be scraped "
                f"(JS-rendered or blocked). Certifications, license numbers, and credentials "
                f"were NOT available from the website — flag these as content gaps."
            )

        await q.put({"step": "progress", "progress": 60, "message": "Building SEO checklist…"})
        seo_checklist = await _build_seo_checklist(
            keyword=body.keyword,
            location=body.location,
            address=body.address,
            phone=body.phone,
            gbp_category=body.gbp_category,
            serp_analysis=serp_analysis_dict,
            client=client,
        )

        gbp_description_text = (
            f"GBP Description: {body.gbp_description}"
            if body.gbp_description else
            "GBP Description: Not provided"
        )

        user_prompt = f"""BUSINESS DATA
Name: {body.business_name}
Category: {body.gbp_category}
Address: {body.address}
Phone: {body.phone or "Not provided — use [PHONE] as placeholder"}
Website: {body.website or "Not provided"}
Hours: {body.hours or "Not provided"}
{gbp_description_text}
Primary keyword: {body.keyword}
Target city: {city}
Full location: {body.location}

{brand_voice_text}
{icp_text}
{diff_text}
{reviews_text}
{website_text}
{serp_ctx}

{seo_checklist}"""

        await q.put({"step": "progress", "progress": 65, "message": "Generating your page…"})

        try:
            claude_msg = await client.messages.create(
                model=GENERATION_MODEL,
                max_tokens=16000,
                system=[{"type": "text", "text": _GEN_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_prompt}],
            )
        except Exception as e:
            logger.exception("Claude generation error")
            raise Exception("Content generation failed. Please try again.")

        token_rec = _token_record("generate-page", GENERATION_MODEL, claude_msg.usage.input_tokens, claude_msg.usage.output_tokens)
        raw = claude_msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = re.sub(r'^```[a-zA-Z]*\n?', '', raw)
            raw = re.sub(r'\n?```$', '', raw)
            raw = raw.strip()

        # Extract <title> tag
        title_match = re.search(r'<title>(.*?)</title>', raw, re.IGNORECASE | re.DOTALL)
        page_title = title_match.group(1).strip() if title_match else ""
        if title_match:
            raw = raw[:title_match.start()] + raw[title_match.end():]
            raw = raw.strip()

        # Extract CONTENT_GAPS_REPORT from raw first (it may appear before or after JSON-LD)
        content_gaps: list = []
        gaps_start_raw = raw.find("CONTENT_GAPS_REPORT_START")
        gaps_end_raw   = raw.find("CONTENT_GAPS_REPORT_END")
        if gaps_start_raw != -1 and gaps_end_raw != -1:
            gaps_json_str = raw[gaps_start_raw + len("CONTENT_GAPS_REPORT_START"):gaps_end_raw].strip()
            raw = (raw[:gaps_start_raw] + raw[gaps_end_raw + len("CONTENT_GAPS_REPORT_END"):]).strip()
            try:
                content_gaps = json.loads(gaps_json_str)
                if not isinstance(content_gaps, list):
                    content_gaps = []
            except Exception:
                content_gaps = []

        # Split content_html from schema_json
        schema_split = raw.find('<script type="application/ld+json">')
        if schema_split != -1:
            content_html = raw[:schema_split].strip()
            schema_json  = raw[schema_split:].strip()
        else:
            content_html = raw
            schema_json  = ""

        # Linkify phone numbers + RDFa entity markup
        content_html = _linkify_phones(content_html, body.phone)
        google_entities = (serp_analysis_dict or {}).get("google_entities", [])
        content_html = _apply_rdfa_markup(content_html, google_entities)

        # ── Score the generated page (single pass) ───────────────────────────────
        # Structural requirements (keywords, entities, FAQ, geo, AEO) are covered
        # by the generation prompt. Any remaining gaps are business-data gaps that
        # retrying cannot fix — those are reported in content_gaps instead.
        await q.put({"step": "progress", "progress": 90, "message": "Scoring your page…"})
        inline_score = None
        for _score_attempt in range(3):
            try:
                inline_score, _, _, score_tok = await _score_html_inline(
                    content_html, body.keyword, body.location, body.business_name,
                    body.gbp_category, body.address, serp_analysis_dict, client,
                )
                token_rec["input_tokens"]  += score_tok["input_tokens"]
                token_rec["output_tokens"] += score_tok["output_tokens"]
                token_rec["cost_usd"]       = round(token_rec["cost_usd"] + score_tok["cost_usd"], 6)
                break  # scoring succeeded
            except Exception as _ae:
                if _score_attempt < 2:
                    await asyncio.sleep(2 ** _score_attempt)  # 1s then 2s
                else:
                    logger.warning(f"generate-page: scoring failed after 3 attempts: {_ae}")

        # Build combined cost breakdown
        ac = (serp_analysis_dict or {}).get("analysis_cost", {})
        claude_cost = token_rec["cost_usd"]
        cost_breakdown = {
            "dataforseo":           ac.get("dataforseo", 0),
            "scrapeowl_pages":      ac.get("scrapeowl_pages", 0),
            "scrapeowl":            ac.get("scrapeowl", 0),
            "google_nlp_chars":     ac.get("google_nlp_chars", 0),
            "google_nlp":           ac.get("google_nlp", 0),
            "claude_model":         token_rec["model"],
            "claude_input_tokens":  token_rec["input_tokens"],
            "claude_output_tokens": token_rec["output_tokens"],
            "claude":               round(claude_cost, 6),
            "total":                round(ac.get("subtotal", 0) + claude_cost, 6),
        }

        await q.put({"step": "progress", "progress": 95, "message": "Finishing up…"})
        await q.put({
            "step": "done",
            "result": {
                "content_html": content_html,
                "schema_json": schema_json,
                "page_title": page_title,
                "composite_score": inline_score,
                "token_usage": token_rec,
                "cost_breakdown": cost_breakdown,
                "serp_analysis": serp_analysis_dict,
                "content_gaps": content_gaps,
            },
        })

    return await _sse_stream(_worker)


# ── /reoptimize-page ──────────────────────────────────────────────────────────

class ReoptimizePageRequest(BaseModel):
    keyword: str
    location: str
    existing_page_html: Optional[str] = None   # if omitted, fetched from existing_page_url
    existing_page_url: Optional[str] = None
    deficiencies: List[dict]
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    phone: Optional[str] = None
    serp_analysis: Optional[dict] = None

class ReoptimizePageResponse(BaseModel):
    content_html: str
    schema_json: Optional[str] = None
    token_usage: dict
    html_css_notes: List[str] = []


@app.post('/reoptimize-page')
@limiter.limit("5/minute")
async def reoptimize_page(request: Request, body: ReoptimizePageRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    # Auth: X-API-Key = proxied call (credits already deducted by edge function)
    #       Authorization Bearer = direct call (deduct credits here)
    api_key = request.headers.get("X-API-Key")
    if api_key:
        if not NLP_API_KEY or api_key != NLP_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
    else:
        user_id = await _verify_jwt_get_user(request.headers.get("Authorization", ""))
        ok = await _deduct_credits_direct(user_id, 2, "/reoptimize-page", "Page reoptimization")
        if not ok:
            raise HTTPException(
                status_code=402,
                detail=json.dumps({"error": "Insufficient credits", "credits_required": 2, "code": "INSUFFICIENT_CREDITS"}),
            )

    import anthropic as _anthropic

    async def _worker(q: asyncio.Queue):
        client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        city = body.location.split(",")[0].strip()
        _worker_start = time.monotonic()

        await q.put({"step": "progress", "progress": 10, "message": "Fetching existing page…"})

        # Fetch existing page if URL given but no HTML
        existing_html = body.existing_page_html or ""
        if not existing_html and body.existing_page_url:
            async with httpx.AsyncClient() as _fc:
                existing_html = await _scrape_one(body.existing_page_url, _fc, render_js=False)
                if not existing_html:
                    existing_html = await _scrape_one(body.existing_page_url, _fc, render_js=True)
            if not existing_html:
                raise Exception("Could not fetch the provided page URL. Check that it is correct and publicly accessible.")
        if not existing_html:
            raise Exception("Either existing_page_html or existing_page_url is required")

        # Extract plain text from the existing page — used as reference for facts,
        # not as HTML to preserve.  Real-world pages are often JS-rendered shells
        # that produce blank output when injected into our preview.  Instead we
        # generate a fresh clean <article> page (same format as /generate-page)
        # informed by the deficiency analysis.
        existing_page_text = BeautifulSoup(existing_html, "html.parser").get_text(separator="\n", strip=True)

        # Extract main content HTML for section-level diff display in Improve Mode.
        # Strip nav/header/footer noise then grab article/main/body in that order.
        _orig_soup = BeautifulSoup(existing_html, "html.parser")
        for _tag in _orig_soup.find_all(['nav', 'header', 'footer', 'script', 'style', 'aside', 'noscript']):
            _tag.decompose()
        _main_el = (_orig_soup.find('article') or _orig_soup.find('main') or _orig_soup.find('body'))
        original_content_html = str(_main_el)[:30000] if _main_el else ""

        # Parse existing page zones and compute delta-based SERP context
        page_zones = _parse_page_zones(existing_html)
        serp_ctx = _reopt_serp_context(page_zones, body.serp_analysis)

        deficiency_text = "\n".join(
            f"  Engine: {d['engine']} (score: {d['score']}/100)\n"
            f"  Issues: {'; '.join(d.get('issues', []))}\n"
            f"  Fixes needed: {'; '.join(d.get('recommendations', []))}"
            for d in body.deficiencies
        )

        user_prompt = f"""BUSINESS DATA
Name: {body.business_name}
Category: {body.gbp_category}
Address: {body.address or "Not provided"}
Phone: {body.phone or "Not provided — use [PHONE] as placeholder"}
Primary keyword: {body.keyword}
Target city: {city}
Full location: {body.location}

{serp_ctx}

SEO DEFICIENCIES TO FIX — address ALL of these in the new page:
{deficiency_text}

EXISTING PAGE CONTENT (extract accurate business facts from this — do NOT invent any facts not present here):
{existing_page_text[:4000]}"""

        await q.put({"step": "progress", "progress": 40, "message": "Rewriting your page…"})

        try:
            claude_msg = await client.messages.create(
                model=GENERATION_MODEL,
                max_tokens=8000,
                system=[{"type": "text", "text": _GEN_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_prompt}],
            )
        except Exception as e:
            logger.exception("Claude reoptimize error")
            raise Exception("Content generation failed. Please try again.")

        token_rec = _token_record("reoptimize-page", GENERATION_MODEL, claude_msg.usage.input_tokens, claude_msg.usage.output_tokens)
        raw = claude_msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = re.sub(r'^```[a-zA-Z]*\n?', '', raw)
            raw = re.sub(r'\n?```$', '', raw)
            raw = raw.strip()

        # Extract <title> tag (same as generate-page)
        title_match = re.search(r'<title>(.*?)</title>', raw, re.IGNORECASE | re.DOTALL)
        page_title = title_match.group(1).strip() if title_match else ""
        if title_match:
            raw = raw[:title_match.start()] + raw[title_match.end():]
            raw = raw.strip()

        # Split content_html from schema_json (our <article> format always has JSON-LD at the end)
        schema_split = raw.find('<script type="application/ld+json">')
        if schema_split != -1:
            content_html = raw[:schema_split].strip()
            schema_json  = raw[schema_split:].strip()
        else:
            content_html = raw
            schema_json  = None

        # Linkify phone numbers + RDFa entity markup
        content_html = _linkify_phones(content_html, body.phone)
        reopt_entities = (body.serp_analysis or {}).get("google_entities", [])
        content_html = _apply_rdfa_markup(content_html, reopt_entities)

        # ── Auto-retry: one scoring pass + one reoptimize pass if score < 90 ──
        # Reoptimize already has deficiency context so one retry is enough.
        # Keeping passes low reduces cost significantly vs. the generate-page flow.
        current_html   = content_html
        current_schema = schema_json
        current_title  = page_title
        MAX_AUTO_PASSES = 2

        await q.put({"step": "progress", "progress": 78, "message": "Scoring your page…"})
        try:
            inline_score, inline_defs, _, score_tok = await _score_html_inline(
                current_html, body.keyword, body.location, body.business_name,
                body.gbp_category, body.address, body.serp_analysis, client,
            )
            token_rec["input_tokens"]  += score_tok["input_tokens"]
            token_rec["output_tokens"] += score_tok["output_tokens"]
            token_rec["cost_usd"]       = round(token_rec["cost_usd"] + score_tok["cost_usd"], 6)

            for pass_num in range(2, MAX_AUTO_PASSES + 1):
                if inline_score >= 90:
                    break
                pct = min(92, 78 + pass_num * 3)
                await q.put({
                    "step": "progress",
                    "progress": pct,
                    "message": f"Score {inline_score}/100 — optimizing (pass {pass_num} of {MAX_AUTO_PASSES})…",
                })
                try:
                    new_html, new_schema, new_title, reopt_tok = await _reoptimize_html_inline(
                        current_html, body.keyword, body.location, city,
                        body.business_name, body.gbp_category, body.address, body.phone,
                        inline_defs, body.serp_analysis, seo_checklist, client,
                    )
                    token_rec["input_tokens"]  += reopt_tok["input_tokens"]
                    token_rec["output_tokens"] += reopt_tok["output_tokens"]
                    token_rec["cost_usd"]       = round(token_rec["cost_usd"] + reopt_tok["cost_usd"], 6)
                    # Guard: only update if we got non-empty content
                    if new_html:
                        current_html   = new_html
                        current_schema = new_schema if new_schema is not None else current_schema
                        if new_title:
                            current_title = new_title
                    else:
                        logger.warning(f"reoptimize-page auto-retry pass {pass_num} returned empty HTML; keeping previous")
                        break
                except Exception as _re:
                    logger.warning(f"reoptimize-page auto-retry pass {pass_num} reoptimize failed: {_re}")
                    break

                try:
                    inline_score, inline_defs, _, score_tok = await _score_html_inline(
                        current_html, body.keyword, body.location, body.business_name,
                        body.gbp_category, body.address, body.serp_analysis, client,
                    )
                    token_rec["input_tokens"]  += score_tok["input_tokens"]
                    token_rec["output_tokens"] += score_tok["output_tokens"]
                    token_rec["cost_usd"]       = round(token_rec["cost_usd"] + score_tok["cost_usd"], 6)
                except Exception as _se:
                    logger.warning(f"reoptimize-page auto-retry pass {pass_num} score failed: {_se}")
                    break

        except Exception as _ae:
            logger.warning(f"reoptimize-page: auto-retry loop failed: {_ae}")

        content_html = current_html
        schema_json  = current_schema
        page_title   = current_title

        if not content_html:
            raise Exception("Reoptimization produced empty content. Please try again.")

        await q.put({"step": "progress", "progress": 95, "message": "Finishing up…"})
        await q.put({
            "step": "done",
            "result": {
                "content_html": content_html,
                "schema_json": schema_json,
                "page_title": page_title,
                "token_usage": token_rec,
                "html_css_notes": [],
                "original_html": original_content_html,
            },
        })

    return await _sse_stream(_worker)


# ── /reoptimize-section ────────────────────────────────────────────────────────

class ReoptimizeSectionRequest(BaseModel):
    section_html: str
    engine: str
    issues: List[str] = []
    recommendations: List[str] = []
    keyword: str
    location: str
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    phone: Optional[str] = None


class ReoptimizeSectionResponse(BaseModel):
    section_html: str
    token_usage: dict


_SECTION_ENGINE_LABELS = {
    "organic_ranking":       "Organic Ranking",
    "gbp_maps":              "GBP / Maps Relevance",
    "entity_establishment":  "Entity Establishment",
    "icp_alignment":         "ICP Alignment",
    "aeo_llm_retrieval":     "AEO / LLM Retrieval",
    "geographic_legitimacy": "Geographic Legitimacy",
    "nearme_intent":         "Hyperlocal / Near-Me Intent",
}


@app.post('/reoptimize-section', response_model=ReoptimizeSectionResponse)
@limiter.limit("20/minute")
async def reoptimize_section(request: Request, body: ReoptimizeSectionRequest):
    """Rewrite a single HTML section to fix a specific SEO deficiency. No credits deducted."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    # Auth: X-API-Key (proxied) OR JWT (direct) — no credits charged either way
    api_key = request.headers.get("X-API-Key")
    if api_key:
        if not NLP_API_KEY or api_key != NLP_API_KEY:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
    else:
        await _verify_jwt_get_user(request.headers.get("Authorization", ""))

    import anthropic as _anthropic
    client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    engine_label = _SECTION_ENGINE_LABELS.get(body.engine, body.engine)
    city = body.location.split(",")[0].strip()
    issues_text   = "\n".join(f"  - {i}" for i in body.issues)   if body.issues         else "  - General quality improvements needed"
    recs_text     = "\n".join(f"  - {r}" for r in body.recommendations) if body.recommendations else ""

    user_prompt = f"""DEFICIENCY TO FIX
Engine: {engine_label}
Issues:
{issues_text}
{f"Recommended changes:{chr(10)}{recs_text}" if recs_text else ""}

BUSINESS CONTEXT
Business: {body.business_name}
Category: {body.gbp_category}
Keyword: {body.keyword}
City: {city}
{f"Phone: {body.phone}" if body.phone else ""}

ORIGINAL SECTION HTML:
{body.section_html[:3000]}

Rewrite this section to fix the listed issues. Preserve all accurate business facts. Return only the HTML for this section — no other text, no code fences."""

    system_prompt = (
        "You are an SEO content editor specialising in local service businesses. "
        "You rewrite individual page sections to fix specific SEO deficiencies while preserving factual accuracy. "
        "Return clean HTML only — no markdown, no code fences, no explanation."
    )

    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2000,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception:
        logger.exception("Section reoptimize error")
        raise HTTPException(status_code=502, detail="Section reoptimization temporarily unavailable")

    section_html = msg.content[0].text.strip()
    if section_html.startswith("```"):
        section_html = re.sub(r'^```(?:html)?\s*', '', section_html)
        section_html = re.sub(r'\s*```$', '', section_html.strip())

    token_rec = _token_record("reoptimize-section", "claude-haiku-4-5-20251001",
                              msg.usage.input_tokens, msg.usage.output_tokens)

    return ReoptimizeSectionResponse(section_html=section_html, token_usage=token_rec)


# ── /related-pages ─────────────────────────────────────────────────────────────

class RelatedPagesRequest(BaseModel):
    keyword: str
    location: str
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    website: Optional[str] = None


class RelatedPageItem(BaseModel):
    keyword: str
    group: str  # "parents" | "siblings" | "children"
    status: str  # "found" | "missing"
    url: Optional[str] = None
    page_title: Optional[str] = None
    composite_score: Optional[float] = None
    composite_status: Optional[str] = None
    engine_scores: Optional[dict] = None
    deficiencies: Optional[List[dict]] = None


class RelatedPagesResponse(BaseModel):
    items: List[RelatedPageItem]
    token_usage: dict


@app.post('/related-pages', response_model=RelatedPagesResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def related_pages(request: Request, body: RelatedPagesRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic
    haiku_client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    total_input_tokens = 0
    total_output_tokens = 0

    # Step 1: Derive related keywords via Haiku
    related_kws, derive_tok = await _derive_related_keywords(body.keyword, body.location, haiku_client)
    total_input_tokens += derive_tok.get("input_tokens", 0)
    total_output_tokens += derive_tok.get("output_tokens", 0)

    all_keywords: List[tuple] = []  # (kw, group)
    for kw in related_kws.get("parents", []):
        all_keywords.append((kw, "parents"))
    for kw in related_kws.get("siblings", []):
        all_keywords.append((kw, "siblings"))
    for kw in related_kws.get("children", []):
        all_keywords.append((kw, "children"))

    # Step 2: Discover sitemap / crawlable URLs once
    discovered_urls: List[str] = []
    if body.website:
        base = body.website.strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            base = f"https://{base}"
        async with httpx.AsyncClient(follow_redirects=True,
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; ShowUPBot/1.0)"},
                                     timeout=15.0) as http_client:
            # Try sitemap.xml
            try:
                sm_resp = await http_client.get(f"{base}/sitemap.xml")
                if sm_resp.status_code == 200:
                    soup_sm = BeautifulSoup(sm_resp.text, "xml")
                    locs = [tag.get_text(strip=True) for tag in soup_sm.find_all("loc")]
                    discovered_urls = [u for u in locs if u.startswith("http")][:200]
            except Exception:
                pass

            # Fallback: sitemap_index or robots.txt
            if not discovered_urls:
                try:
                    robots_resp = await http_client.get(f"{base}/robots.txt")
                    if robots_resp.status_code == 200:
                        for line in robots_resp.text.splitlines():
                            if line.lower().startswith("sitemap:"):
                                sm_url = line.split(":", 1)[1].strip()
                                sm2 = await http_client.get(sm_url)
                                if sm2.status_code == 200:
                                    soup2 = BeautifulSoup(sm2.text, "xml")
                                    locs2 = [t.get_text(strip=True) for t in soup2.find_all("loc")]
                                    discovered_urls = [u for u in locs2 if u.startswith("http")][:200]
                                    break
                except Exception:
                    pass

            # Step 3: For each keyword, find matching page (no auto-scoring — user scores explicitly)
            async def _process_keyword(kw: str, group: str) -> RelatedPageItem:
                found = await _find_page_for_keyword_reuse(kw, discovered_urls, http_client)
                if found:
                    return RelatedPageItem(
                        keyword=kw,
                        group=group,
                        status="found",
                        url=found["url"],
                        page_title=found.get("title"),
                    )
                else:
                    return RelatedPageItem(keyword=kw, group=group, status="missing")

            results = await asyncio.gather(
                *[_process_keyword(kw, group) for kw, group in all_keywords],
                return_exceptions=True,
            )
            items = [r for r in results if isinstance(r, RelatedPageItem)]
    else:
        # No website — all keywords are "missing"
        items = [RelatedPageItem(keyword=kw, group=group, status="missing")
                 for kw, group in all_keywords]

    token_rec = _token_record(
        "related-pages", "claude-haiku-4-5-20251001",
        total_input_tokens, total_output_tokens,
    )
    return RelatedPagesResponse(items=items, token_usage=token_rec)


# ── /generate-social-posts ────────────────────────────────────────────────────

_SOCIAL_SYSTEM_PROMPT = """You are a social media copywriter specialising in local service businesses. Given a page's content and business details, generate Google Business Profile posts that drive local leads.

Rules:
- GBP posts: max 200 words. Conversational, benefit-led, clear CTA mentioning the city.
- Vary the angle across the 5 posts (e.g. urgency, social proof, education, offer, story).
- Never fabricate reviews, prices, or guarantees not mentioned in the page content.
- If brand voice instructions are provided, match that tone and style exactly.
- If target customer profiles are provided, write to those specific pain points and motivations.
- If differentiators are provided, weave them into posts naturally — include the mechanism, not just the claim.
- If SEO signal data is provided (related keywords and Google entities), weave them into posts
  naturally where they fit — do not force them in, do not list them verbatim. The goal is natural
  language that happens to contain these terms, not keyword stuffing.
- Output valid JSON only — no markdown fences, no commentary."""

class SocialPostsRequest(BaseModel):
    keyword: str
    location: str
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    phone: Optional[str] = None
    page_content: str          # plain text of the generated page
    differentiators: Optional[List[dict]] = None
    detected_icp: Optional[dict] = None
    brand_voice: Optional[dict] = None
    serp_analysis: Optional[dict] = None

class SocialPostsResponse(BaseModel):
    gbp: List[str]
    token_usage: dict

@app.post('/generate-social-posts', response_model=SocialPostsResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def generate_social_posts(request: Request, body: SocialPostsRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic
    client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    city = body.location.split(",")[0].strip()
    page_text = body.page_content[:4000]  # cap context to keep cost low

    # Build differentiators block
    diff_text = ""
    if body.differentiators:
        diff_text = "\nDIFFERENTIATORS (weave these in naturally — include the mechanism, not just the claim):\n" + \
            "\n".join(f"  - {d.get('claim','')} (mechanism: {d.get('mechanism','')})" for d in body.differentiators)

    # Build ICP block. Cap at 2 segments — social posts are short and need a
    # tighter focus than a full content page. Leading newline separates the
    # block from preceding inline text in the prompt template.
    icp_text = _build_icp_text(body.detected_icp, max_segments=2)
    if icp_text:
        icp_text = "\n" + icp_text

    # Build brand voice block — defaults to the current voice; switches to
    # recommended only when the user explicitly accepted it. The leading
    # newline separates this block from preceding text in the inline prompt.
    brand_voice_text = _build_brand_voice_text(body.brand_voice)
    if brand_voice_text:
        brand_voice_text = "\n" + brand_voice_text

    # Build SEO signals block from serp_analysis — entities + top keywords, used naturally
    seo_signals_text = ""
    if body.serp_analysis:
        entities = body.serp_analysis.get("google_entities", [])
        rk = body.serp_analysis.get("related_keywords", {})
        top_entities = [e["name"] for e in sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:8]]
        # Flatten related keywords across zones, deduplicate, take top terms
        seen: set = set()
        top_keywords = []
        for zone in ("paragraphs", "h2_h3", "h1", "title"):
            for t in rk.get(zone, []):
                term = t["term"]
                if term.lower() not in seen:
                    seen.add(term.lower())
                    top_keywords.append(term)
                if len(top_keywords) >= 12:
                    break
            if len(top_keywords) >= 12:
                break
        lines = ["\nSEO SIGNALS (weave these naturally into posts where they fit — do not force or list verbatim):"]
        if top_entities:
            lines.append(f"  Entities: {', '.join(top_entities)}")
        if top_keywords:
            lines.append(f"  Keywords: {', '.join(top_keywords)}")
        if len(lines) > 1:
            seo_signals_text = "\n".join(lines)

    user_prompt = f"""Business: {body.business_name}
Category: {body.gbp_category}
Location: {city}
Keyword: {body.keyword}
Address: {body.address or ""}
Phone: {body.phone or "not provided"}{diff_text}{icp_text}{brand_voice_text}{seo_signals_text}

PAGE CONTENT:
{page_text}

Generate exactly 5 Google Business Profile posts. Return this JSON structure:
{{
  "gbp": ["post1", "post2", "post3", "post4", "post5"]
}}"""

    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=3000,
            system=[{"type": "text", "text": _SOCIAL_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception:
        logger.exception("Social posts generation error")
        raise HTTPException(status_code=502, detail="Social posts generation temporarily unavailable")

    token_rec = _token_record("generate-social-posts", "claude-haiku-4-5-20251001",
                              msg.usage.input_tokens, msg.usage.output_tokens)
    data = _parse_claude_json(msg.content[0].text)

    return SocialPostsResponse(
        gbp=data.get("gbp", []),
        token_usage=token_rec,
    )


# ── /check-rankability ────────────────────────────────────────────────────────

def _haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles between two lat/lng points."""
    import math
    R = 3958.8  # Earth radius in miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _keyword_in_name(keyword: str, business_name: str) -> bool:
    """True if ALL keyword tokens appear in business name (case-insensitive).
    Requires 100% match so that e.g. 'tree service' doesn't flag a competitor
    for the keyword 'emergency tree service' — the modifier matters.
    """
    kw_tokens = set(re.sub(r'[^a-z0-9\s]', '', keyword.lower()).split())
    name_lower = re.sub(r'[^a-z0-9\s]', '', business_name.lower())
    if not kw_tokens:
        return False
    return all(t in name_lower for t in kw_tokens)


async def _geocode_location(location: str) -> Optional[tuple[float, float]]:
    """Geocode a city/location string using Nominatim (free, no key)."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": location, "format": "json", "limit": 1},
                headers={"User-Agent": "ShowUPLocal/1.0 (contact@showuplocal.com)"},
            )
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as e:
        logger.warning(f"Geocoding failed for '{location}': {e}")
    return None


def _rankability_score(
    category_match: str,           # "exact" | "partial" | "none"
    client_reviews: Optional[int], # client's own GBP review count
    max_reviews: Optional[int],    # highest review count in map pack
    min_reviews: Optional[int],    # lowest review count in map pack
    distance_miles: Optional[float],
    keyword_name_count: int,       # how many of 3 competitors have keyword in name
    in_maps_results: bool,
    is_sab: bool = False,
    physical_competitor_count: int = 0,
    total_pack_count: int = 0,
) -> dict:
    """Compute 0-100 rankability score with breakdown."""

    # 1. Category match (35 pts)
    cat_pts = {"exact": 35, "partial": 18, "none": 0}.get(category_match, 0)

    # 2. Competition barrier — client reviews vs. pack (15 pts)
    if client_reviews is None or min_reviews is None or max_reviews is None:
        comp_pts = 7  # neutral when data unavailable
    elif client_reviews >= max_reviews:
        comp_pts = 15
    elif client_reviews >= min_reviews:
        comp_pts = 10
    elif min_reviews > 0 and client_reviews >= min_reviews * 0.80:
        comp_pts = 5   # up to 20% below lowest in pack
    else:
        comp_pts = 0

    # 3. Distance from city center (20 pts)
    if distance_miles is None:
        dist_pts = 10  # neutral / unknown
    elif distance_miles <= 5:
        dist_pts = 20
    elif distance_miles <= 7:
        dist_pts = 5
    else:
        dist_pts = 0

    # 4. Keyword in competitor names (25 pts)
    kw_name_pts = {0: 25, 1: 10, 2: 5, 3: 0}.get(min(keyword_name_count, 3), 0)

    # 5. Business website in top 10 organic (5 pts)
    organic_pts = 5 if in_maps_results else 0

    total = cat_pts + comp_pts + dist_pts + kw_name_pts + organic_pts

    # SAB vs physical-dominant pack penalty (-40 pts)
    sab_penalty = 0
    sab_pack_mismatch = False
    if is_sab and total_pack_count > 0:
        physical_ratio = physical_competitor_count / total_pack_count
        if physical_ratio >= 0.5:
            sab_penalty = -40
            sab_pack_mismatch = True

    total = max(0, total + sab_penalty)

    if total >= 70:
        verdict = "strong"
    elif total >= 45:
        verdict = "moderate"
    elif total >= 20:
        verdict = "difficult"
    else:
        verdict = "very_difficult"

    return {
        "total": total,
        "verdict": verdict,
        "sab_pack_mismatch": sab_pack_mismatch,
        "breakdown": {
            "category_match": cat_pts,
            "competition_barrier": comp_pts,
            "distance": dist_pts,
            "keyword_in_competitor_names": kw_name_pts,
            "in_maps_results": organic_pts,
            "sab_penalty": sab_penalty,
        },
    }


def _infer_is_sab(address: Optional[str]) -> bool:
    """
    SABs don't display an address on their GBP listing, so the address field
    is empty or null when pulled from the API. Physical locations have a
    street address stored.
    """
    return not bool(address and address.strip())


class RankabilityRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    gbp_category: str
    business_name: Optional[str] = None
    business_address: Optional[str] = None   # used to infer SAB (empty = SAB)
    business_review_count: Optional[int] = None  # client's own GBP review count
    business_lat: Optional[float] = None
    business_lng: Optional[float] = None
    website: Optional[str] = None  # to check top-10 organic presence
    sab_city: Optional[str] = None  # SAB only: city where GBP is physically located
    gbp_place_id: Optional[str] = None  # GBP place_id for exact Maps match


class CompetitorInfo(BaseModel):
    name: str
    rating: Optional[float] = None
    review_count: Optional[int] = None
    has_keyword_in_name: bool = False


class RankabilityResponse(BaseModel):
    # Score
    score: int
    verdict: str          # "strong" | "moderate" | "difficult" | "very_difficult"
    score_breakdown: dict

    # Map pack data
    has_map_pack: bool
    competitors: List[CompetitorInfo]
    ranking_categories: List[dict]    # [{category, count}]

    # Competition metrics
    min_reviews_in_pack: Optional[int] = None
    max_reviews_in_pack: Optional[int] = None
    avg_reviews_in_pack: Optional[float] = None
    avg_rating_in_pack: Optional[float] = None
    review_gap: Optional[int] = None  # vs. weakest competitor in pack

    # Category match
    category_match: str               # "exact" | "partial" | "none"

    # Distance
    distance_miles: Optional[float] = None
    distance_ok: bool = True

    # Keyword-in-name
    keyword_in_competitor_names: int = 0  # count of 3-pack with keyword in name
    competitor_name_examples: List[str] = []

    # Google Maps top-10 presence
    in_maps_results: bool = False
    maps_position: Optional[int] = None  # 1–10 if found, None otherwise

    # SAB vs physical pack
    is_sab: bool = False
    sab_pack_mismatch: bool = False  # True when SAB faces majority-physical pack
    physical_competitors_in_pack: int = 0

    # Legacy fields for backward compat with existing frontend
    message: str = ""
    match_count: int = 0
    total_results: int = 0


DATAFORSEO_MAPS_ENDPOINT = "https://api.dataforseo.com/v3/serp/google/maps/live/advanced"


async def _fetch_maps_top10(
    keyword: str,
    loc_field: dict,
    business_name: str,
    credentials: str,
    place_id: Optional[str] = None,
) -> tuple[bool, int, list[dict]]:
    """
    Query DataForSEO Google Maps endpoint for top-10 results.
    Returns (business_found, position, maps_items).
    - business_found: True if client business appears in top-10
    - position: rank_group (1–10) if found, 0 otherwise
    - maps_items: full list of maps_search items for competitor/category analysis

    Match priority: place_id (exact) → business_name (fuzzy, high threshold)
    """
    payload = [{
        "keyword": keyword,
        **loc_field,
        "language_name": "English",
        "depth": 10,
    }]
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                DATAFORSEO_MAPS_ENDPOINT,
                headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        maps_items = []
        for task in (data.get("tasks") or []):
            for result in (task.get("result") or []):
                for item in (result.get("items") or []):
                    if item.get("type") == "maps_search":
                        maps_items.append(item)
        for item in maps_items:
            pos = item.get("rank_group") or item.get("rank_absolute") or 0
            # Prefer exact place_id match
            if place_id and item.get("place_id") == place_id:
                return True, int(pos), maps_items
            # Fallback: require ALL significant tokens (len >= 5) to appear in result name
            if business_name and not place_id:
                name = item.get("title", "")
                sig_tokens = [t for t in re.sub(r'[^a-z0-9\s]', '', business_name.lower()).split() if len(t) >= 5]
                name_norm = re.sub(r'[^a-z0-9\s]', '', name.lower())
                if sig_tokens and all(t in name_norm for t in sig_tokens):
                    return True, int(pos), maps_items
        return False, 0, maps_items
    except Exception as e:
        logger.warning(f"Maps top-10 check failed for '{keyword}': {e}")
    return False, 0, []


@app.post('/check-rankability', response_model=RankabilityResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def check_rankability(request: Request, body: RankabilityRequest):
    if not DATAFORSEO_LOGIN or not DATAFORSEO_PASSWORD:
        raise HTTPException(status_code=503, detail="DataForSEO credentials not configured")

    credentials = base64.b64encode(
        f"{DATAFORSEO_LOGIN}:{DATAFORSEO_PASSWORD}".encode()
    ).decode()
    loc_field = {"location_code": body.location_code} if body.location_code else {"location_name": body.location}

    # Run SERP (organic + local_pack) and Google Maps top-10 in parallel
    serp_payload = [{
        "keyword": body.keyword,
        **loc_field,
        "language_name": "English",
        "depth": 10,
        "se_domain": "google.com",
    }]

    async def _fetch_serp() -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                DATAFORSEO_ENDPOINT,
                headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
                json=serp_payload,
            )
            resp.raise_for_status()
            return resp.json()

    # Run SERP and Maps in parallel. SERP determines has_map_pack (organic signal only).
    # Maps top-10 is used for all competitor/category analysis regardless.
    maps_task = _fetch_maps_top10(body.keyword, loc_field, body.business_name or "", credentials, place_id=body.gbp_place_id)
    serp_data, (in_maps_results, maps_position, maps_items) = await asyncio.gather(
        _fetch_serp(), maps_task
    )

    # Parse organic SERP — only used to determine if a local pack appears in search results
    local_pack_items: List[dict] = []
    for task in (serp_data.get("tasks") or []):
        for result in (task.get("result") or []):
            for item in (result.get("items") or []):
                if item.get("type") == "local_pack":
                    local_pack_items.append(item)

    # has_map_pack is determined solely by organic SERP (honest signal)
    has_map_pack = len(local_pack_items) > 0

    # ── Competitor & category analysis from Maps top-10 ────────────────────────
    # Maps endpoint reliably returns the top local businesses regardless of
    # whether the organic SERP happened to render the local pack widget.
    competitors: List[CompetitorInfo] = []
    category_counts: Dict[str, int] = {}
    keyword_name_count = 0
    competitor_name_examples: List[str] = []
    physical_competitor_count = 0

    for item in maps_items[:10]:
        name = item.get("title", "")
        rating_obj = item.get("rating") or {}
        rating = rating_obj.get("value") if isinstance(rating_obj, dict) else rating_obj
        review_count = rating_obj.get("votes_count") if isinstance(rating_obj, dict) else None

        # Physical location = has a street address (not just city)
        address_val = item.get("address", "") or ""
        is_physical = bool(address_val)
        if is_physical:
            physical_competitor_count += 1

        has_kw = _keyword_in_name(body.keyword, name)
        if has_kw:
            keyword_name_count += 1
            competitor_name_examples.append(name)

        # Maps items use singular "category" field
        cat = item.get("category", "")
        if cat:
            category_counts[cat] = category_counts.get(cat, 0) + 1

        competitors.append(CompetitorInfo(
            name=name,
            rating=float(rating) if rating else None,
            review_count=int(review_count) if review_count else None,
            has_keyword_in_name=has_kw,
        ))

    ranking_categories = [{"category": k, "count": v}
                          for k, v in sorted(category_counts.items(), key=lambda x: -x[1])]

    # ── Category match ─────────────────────────────────────────────────────────
    gbp_cat_lower = body.gbp_category.lower()
    cat_tokens = set(re.sub(r'[^a-z0-9\s]', '', gbp_cat_lower).split())
    match_count = sum(1 for rc in ranking_categories
                      if gbp_cat_lower in rc["category"].lower()
                      or rc["category"].lower() in gbp_cat_lower)
    partial_count = sum(1 for rc in ranking_categories
                        for t in cat_tokens
                        if len(t) > 3 and t in rc["category"].lower())
    if match_count > 0:
        category_match = "exact"
    elif partial_count > 0:
        category_match = "partial"
    else:
        category_match = "none"

    # ── Category mismatch — hard fail ─────────────────────────────────────────
    # If none of the Maps top-10 businesses share the client's GBP category,
    # ranking in Maps is essentially impossible. Skip all other checks and
    # return immediately with a clear "do not target" verdict.
    if category_match == "none":
        logger.info(
            f"Rankability '{body.keyword}' @ '{body.location}': "
            f"category mismatch — returning hard fail (pack cats: {[r['category'] for r in ranking_categories]})"
        )
        return RankabilityResponse(
            score=0,
            verdict="very_difficult",
            score_breakdown={"category_match": 0},
            has_map_pack=has_map_pack,
            competitors=competitors[:3],
            ranking_categories=ranking_categories,
            category_match="none",
            keyword_in_competitor_names=keyword_name_count,
            competitor_name_examples=competitor_name_examples,
            in_maps_results=in_maps_results,
            maps_position=maps_position if in_maps_results else None,
            is_sab=_infer_is_sab(body.business_address),
            sab_pack_mismatch=False,
            physical_competitors_in_pack=physical_competitor_count,
            message=(
                "Your GBP category doesn't match any category in the Maps results — "
                "you will not rank in Maps for this keyword. "
                "The businesses ranking here are in a different category. "
                "Target a different keyword, or create content for organic search instead."
            ),
            match_count=0,
            total_results=len(maps_items),
        )

    # ── Review metrics (top 3 only — mirrors the visible 3-pack) ───────────────
    top3 = competitors[:3]
    review_counts = [c.review_count for c in top3 if c.review_count is not None]
    ratings = [c.rating for c in top3 if c.rating is not None]
    min_reviews = min(review_counts) if review_counts else None
    max_reviews = max(review_counts) if review_counts else None
    avg_reviews = round(sum(review_counts) / len(review_counts), 1) if review_counts else None
    avg_rating = round(sum(ratings) / len(ratings), 2) if ratings else None

    # ── SAB auto-detection ─────────────────────────────────────────────────────
    is_sab = _infer_is_sab(body.business_address)

    # ── Distance ───────────────────────────────────────────────────────────────
    # Physical business: measure from their lat/lng to the target city center.
    # SAB: measure from the center of their registered city to the target city center
    #      (they hide their address, so we use sab_city supplied by the user).
    distance_miles = None
    distance_ok = True
    target_coords = await _geocode_location(body.location)
    if target_coords:
        if is_sab and body.sab_city:
            origin_coords = await _geocode_location(body.sab_city)
            if origin_coords:
                distance_miles = round(_haversine_miles(
                    origin_coords[0], origin_coords[1],
                    target_coords[0], target_coords[1]
                ), 1)
                distance_ok = distance_miles <= 10.0
        elif not is_sab and body.business_lat and body.business_lng:
            distance_miles = round(_haversine_miles(
                body.business_lat, body.business_lng,
                target_coords[0], target_coords[1]
            ), 1)
            distance_ok = distance_miles <= 10.0

    # ── Distance hard fail ─────────────────────────────────────────────────────
    # >10 miles from the target city = effectively impossible to rank in Maps.
    # Return immediately, same as category mismatch.
    if distance_miles is not None and distance_miles > 10.0:
        logger.info(
            f"Rankability '{body.keyword}' @ '{body.location}': "
            f"distance hard fail — {distance_miles} mi"
        )
        return RankabilityResponse(
            score=0,
            verdict="very_difficult",
            score_breakdown={"distance": 0},
            has_map_pack=has_map_pack,
            competitors=competitors[:3],
            ranking_categories=ranking_categories,
            category_match=category_match,
            keyword_in_competitor_names=keyword_name_count,
            competitor_name_examples=competitor_name_examples,
            in_maps_results=in_maps_results,
            maps_position=maps_position if in_maps_results else None,
            is_sab=is_sab,
            sab_pack_mismatch=False,
            physical_competitors_in_pack=physical_competitor_count,
            distance_miles=distance_miles,
            distance_ok=False,
            message=(
                f"Your business is {distance_miles} miles from {body.location} — "
                "Google Maps heavily favors businesses within 5 miles of the search location. "
                "You are unlikely to rank in Maps for this keyword. "
                "Target a city closer to your location or target organic rankings instead."
            ),
            match_count=match_count,
            total_results=len(maps_items),
        )

    # ── Score ──────────────────────────────────────────────────────────────────
    score_data = _rankability_score(
        category_match=category_match,
        client_reviews=body.business_review_count,
        max_reviews=max_reviews,
        min_reviews=min_reviews,
        distance_miles=distance_miles,
        keyword_name_count=keyword_name_count,
        in_maps_results=in_maps_results,
        is_sab=is_sab,
        physical_competitor_count=physical_competitor_count,
        total_pack_count=len(maps_items[:10]),
    )

    # ── Review gap — reviews needed to match weakest competitor ───────────────
    review_gap = None
    if body.business_review_count is not None and min_reviews is not None:
        review_gap = max(0, min_reviews - body.business_review_count)

    # ── Human-readable message ─────────────────────────────────────────────────
    verdict_labels = {
        "strong": "Strong map pack rankability",
        "moderate": "Moderate — achievable with work",
        "difficult": "Difficult — real barriers present",
        "very_difficult": "Very difficult — consider a different keyword or location",
    }
    message = verdict_labels.get(score_data["verdict"], "")
    if not has_map_pack:
        # Organic SERP didn't show a local pack — note it but still scored from Maps data
        no_pack_note = " (no local pack in organic SERP for this query)" if maps_items else ""
        if not maps_items:
            message = "No map pack found for this keyword — may be a low local-intent query"
        else:
            message = verdict_labels.get(score_data["verdict"], "") + no_pack_note
    elif score_data.get("sab_pack_mismatch"):
        message += f". Your service area business faces a pack dominated by {physical_competitor_count} physical location(s) — Google heavily favors proximity for this keyword"

    logger.info(
        f"Rankability '{body.keyword}' @ '{body.location}': "
        f"score={score_data['total']} verdict={score_data['verdict']} "
        f"cat={category_match} dist={distance_miles}mi pack={has_map_pack}"
    )

    return RankabilityResponse(
        score=score_data["total"],
        verdict=score_data["verdict"],
        score_breakdown=score_data["breakdown"],
        has_map_pack=has_map_pack,
        competitors=competitors,
        ranking_categories=ranking_categories,
        min_reviews_in_pack=min_reviews,
        max_reviews_in_pack=max_reviews,
        avg_reviews_in_pack=avg_reviews,
        avg_rating_in_pack=avg_rating,
        review_gap=review_gap,
        category_match=category_match,
        distance_miles=distance_miles,
        distance_ok=distance_ok,
        keyword_in_competitor_names=keyword_name_count,
        competitor_name_examples=competitor_name_examples,
        in_maps_results=in_maps_results,
        maps_position=maps_position if in_maps_results else None,
        is_sab=is_sab,
        sab_pack_mismatch=score_data.get("sab_pack_mismatch", False),
        physical_competitors_in_pack=physical_competitor_count,
        message=message,
        match_count=match_count,
        total_results=len(local_pack_items),
    )


# ── /generate-press-release ───────────────────────────────────────────────────

_PRESS_RELEASE_SYSTEM_PROMPT = """You are an SEO press release journalist specialising in local service businesses. You write detailed, neutral, journalistic press releases that are optimised for search engines.

MANDATORY RULES:
1. Body word count: 650–800 words. After writing, count the words in the body (everything between the title and the About section). If under 650, add extra paragraphs until the minimum is met.
2. Write in strict 3rd-person neutral tone. Never promotional.
3. Forbidden words: "top-notch", "look no further", "you", "yours". No questions anywhere.
4. No hyperlinks or anchor text in the press release body — links are handled separately.
5. Write a dedicated section (with an <h2>) for each related keyword provided.
6. Weave in as many of the provided quadgrams and entities as possible while maintaining readability.
7. Feature the main keyword in the title and 2–3 times in the body.
8. The ONLY allowable CTA is the contact line — no other calls to action.

TITLE FORMAT: "[main keyword] (provided by|now provided by|offered by|now offered by|proudly offered by|is delighted to offer|expanded by) [business name]"
Readability is the priority — fix grammar as needed (e.g. "Bronx Car Accident Legal Services Now Offered By Kerner Law Group" not "Bronx Car Accident Attorney Now Offered By Kerner Law Group").

FIRST PARAGRAPH: Must contain an RDF triple sentence that directly states the business name, the service, and the location. Example: "ABC Plumbing offers emergency plumbing services in Chicago." Focus on grammatical correctness and readability.

QUOTE: Include one positive quote attributed to the spokesperson.

OUTPUT FORMAT: Return clean HTML only — no markdown, no code fences, no explanation.
Use this exact structure:
<h1>Title</h1>
<p>First paragraph with RDF triple...</p>
[body paragraphs and h2 sections]
<blockquote><p>"Quote text." — Spokesperson Name, Business Name</p></blockquote>
<p>For more information, please contact SPOKESPERSON_NAME at PAGE_URL</p>
<h2>About BUSINESS_NAME</h2>
<p>About paragraph...</p>
<hr>
<p><strong>Reminder:</strong> Place your additional links in the body above. ADDITIONAL_LINKS_LIST Include your GBP embed iframe: GBP_EMBED_CODE</p>
<p><strong>Main keyword:</strong> MAIN_KEYWORD</p>
<p><strong>Related keywords used:</strong> RELATED_KEYWORDS_LIST</p>"""


class AdditionalLink(BaseModel):
    url: str
    anchor_text: str


class PressReleaseGenerationRequest(BaseModel):
    # Business info
    business_name: str
    website: str
    gbp_place_id: Optional[str] = None
    address: Optional[str] = None
    gbp_category: str
    # Content
    keyword: str
    location: str
    page_content: str        # plain text of the generated page
    # SEO signals from keyword analysis
    related_keywords: List[str] = []   # top terms
    entities: List[str] = []           # Google entity names
    quadgrams: List[str] = []          # top quadgram phrases
    # User-supplied inputs
    spokesperson: str
    contact_email: str
    page_url: Optional[str] = None     # defaults to website
    additional_links: List[AdditionalLink] = []


class PressReleaseGenerationResponse(BaseModel):
    content_html: str
    word_count: int
    gbp_embed_html: Optional[str]
    token_usage: dict


@app.post('/generate-press-release', response_model=PressReleaseGenerationResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def generate_press_release(request: Request, body: PressReleaseGenerationRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic
    client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    city = body.location.split(",")[0].strip()
    page_url = (body.page_url or body.website or "").strip()
    page_text = body.page_content[:5000]

    # Build related keywords block (cap at 5 for the spec requirement)
    related_kw = body.related_keywords[:8]
    entities_list = body.entities[:15]
    quadgrams_list = body.quadgrams[:15]

    # Additional links block
    add_links_text = ""
    if body.additional_links:
        add_links_text = "Additional links to place (use branded anchor text as shown):\n" + \
            "\n".join(f"  - Anchor: \"{l.anchor_text}\" → URL: {l.url}" for l in body.additional_links)

    # GBP embed
    gbp_embed_html: Optional[str] = None
    if body.gbp_place_id:
        gbp_embed_html = (
            f'<iframe src="https://maps.google.com/maps?q=place_id:{body.gbp_place_id}&output=embed" '
            f'width="600" height="450" style="border:0;" allowfullscreen loading="lazy" '
            f'referrerpolicy="no-referrer-when-downgrade"></iframe>'
        )

    user_prompt = f"""BUSINESS DATA
Name: {body.business_name}
Category: {body.gbp_category}
Location: {city}
Address: {body.address or ""}
Website: {body.website}
Spokesperson: {body.spokesperson}
Contact email: {body.contact_email}
Page URL (use in CTA): {page_url}

MAIN KEYWORD: {body.keyword}

RELATED KEYWORDS (write a section for each, feature each at least once):
{chr(10).join(f"  - {kw}" for kw in related_kw)}

ENTITIES (weave as many as possible):
{chr(10).join(f"  - {e}" for e in entities_list)}

QUADGRAMS (weave as many as possible):
{chr(10).join(f"  - {q}" for q in quadgrams_list)}

PAGE CONTENT (use as factual source material — do not fabricate):
{page_text}

{add_links_text}

Write the press release now. Remember: minimum 650 words in the body. Check your word count before finishing."""

    try:
        msg = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4000,
            system=[{"type": "text", "text": _PRESS_RELEASE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception:
        logger.exception("Press release generation error")
        raise HTTPException(status_code=502, detail="Press release generation temporarily unavailable")

    content_html = msg.content[0].text.strip()

    # Strip accidental markdown fences
    if content_html.startswith("```"):
        content_html = re.sub(r'^```(?:html)?\s*', '', content_html)
        content_html = re.sub(r'\s*```$', '', content_html.strip())

    # Rough word count on plain text
    import html as _html
    plain = re.sub(r'<[^>]+>', ' ', content_html)
    plain = _html.unescape(plain)
    word_count = len(plain.split())

    token_rec = _token_record("generate-press-release", "claude-sonnet-4-6",
                              msg.usage.input_tokens, msg.usage.output_tokens)

    return PressReleaseGenerationResponse(
        content_html=content_html,
        word_count=word_count,
        gbp_embed_html=gbp_embed_html,
        token_usage=token_rec,
    )
