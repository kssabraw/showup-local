import sys
import os
import logging
import asyncio
import base64
import json
import re

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

# ── API key auth dependency ───────────────────────────────────────────────────
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Security(_api_key_header)):
    """Validates X-API-Key header. Fails closed — rejects all requests if NLP_API_KEY is unset."""
    if not NLP_API_KEY:
        raise HTTPException(status_code=503, detail="Service authentication not configured")
    if api_key != NLP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return api_key

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
    zone_targets: Dict[str, dict] = {}        # max term/entity counts per zone across competitors
    competitor_headings: List[dict] = []      # H2/H3 strings scraped from competitor pages
    analysis_cost: dict = {}                  # estimated API costs for this analysis run


# ── Step 1: DataForSEO — fetch top organic SERP URLs ─────────────────────────

async def fetch_serp_urls(keyword: str, location: str, client: httpx.AsyncClient, location_code: Optional[int] = None) -> List[str]:
    """
    Calls DataForSEO organic live/advanced to get the top SERP_RESULT_COUNT
    organic URLs for keyword + location. Filters out skip-listed domains and
    non-HTML resources. Returns [] on any error.
    """
    if not DATAFORSEO_LOGIN or not DATAFORSEO_PASSWORD:
        logger.warning("DataForSEO credentials not set — skipping SERP fetch")
        return []

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
                    urls.append(url)
                    if len(urls) >= SERP_RESULT_COUNT:
                        break

        logger.info(f"DataForSEO returned {len(urls)} usable URLs for '{keyword}'")
        return urls

    except Exception as e:
        logger.warning(f"DataForSEO error: {e}")
        return []


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
            if not name:
                continue
            key = (name.lower(), etype)
            if key not in seen_this_page:
                entity_data[key]["saliences"].append(salience)
                entity_data[key]["mention_counts"].append(mention_count)
                entity_data[key]["pages"].add(page_idx)
                entity_data[key]["name"] = name
                entity_data[key]["entity_type"] = etype
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
    # Step 1: get URLs
    if urls:
        serp_urls = urls
        logger.info(f"Using {len(serp_urls)} manually provided URLs")
    else:
        async with httpx.AsyncClient() as client:
            serp_urls = await fetch_serp_urls(keyword, location, client, location_code)
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
    for url, html in zip(serp_urls, pages):
        zones = extract_zones(html)
        for z in ZONES:
            zone_buckets[z].append(zones[z])
        h2_per_page.append(zones.get("h2_list", []))
        h3_per_page.append(zones.get("h3_list", []))
        scraped_urls.append(url)

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
        para_texts = [t for t in zone_buckets["paragraphs"] if len(t) > 100][:5]
        if para_texts:
            try:
                google_entities = await get_google_entities(para_texts)
                nlp_chars = sum(min(len(t), GOOGLE_NLP_MAX_BYTES) for t in para_texts)
                logger.info(f"Google NLP: {len(google_entities)} entities from {len(para_texts)} pages")
            except Exception as _nlp_err:
                logger.warning(f"Google NLP failed (non-fatal): {_nlp_err}")

    zone_targets = compute_zone_targets(zone_buckets, related, google_entities)

    # Aggregate competitor headings by page spread
    total_pages = len(scraped_urls)
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
    import json as json_lib

    has_content = bool(page_contents)
    content_text = "\n\n---\n\n".join(page_contents) if page_contents else ""

    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    def _parse(message: any) -> dict:
        text = message.content[0].text.strip()
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```$', '', text.strip())
        return json_lib.loads(text)

    VOICE_SCHEMA = """{
  "personality": ["<trait 1>", "<trait 2>", "<trait 3>"],
  "tone": "<1-2 sentence description of the overall tone>",
  "writing_style": {
    "sentence_length": "<short / medium / long / mixed>",
    "person": "<first person / second person / third person / mixed>",
    "jargon_level": "<low / medium / high — brief explanation>",
    "formality": "<casual / professional / formal>"
  },
  "vocabulary": {
    "use": ["<word or phrase>", "<word or phrase>", "<word or phrase>", "<word or phrase>", "<word or phrase>"],
    "avoid": ["<word or phrase>", "<word or phrase>", "<word or phrase>"]
  },
  "messaging_themes": ["<theme 1>", "<theme 2>", "<theme 3>"],
  "sample_phrases": ["<phrase>", "<phrase>", "<phrase>"],
  "content_generation_instructions": "<2-3 sentences of concrete guidance for writing content that matches this brand voice>"
}"""

    if not has_content:
        # ── No-website path: skip current voice, generate recommended + guide from category ──
        logger.info(f"Brand voice: no website content for {business_name} — using category-based inference")

        prompt_recommended_no_site = f"""Business: {business_name}
GBP Category: {gbp_category}

No website is available for this business. Based solely on the business name and category, recommend a high-performing brand voice that would work well for a local {gbp_category or 'service'} business. Draw on best practices for this business type.

Return a JSON object with exactly this structure:
{VOICE_SCHEMA}"""

        try:
            msg_rec = await client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend a high-performing brand voice based on business type. Return only valid JSON, no markdown, no explanation.",
                messages=[{'role': 'user', 'content': prompt_recommended_no_site}],
            )
            u_rec = msg_rec.usage
            logger.info(f"Brand voice (no-site recommended) — input: {u_rec.input_tokens}, output: {u_rec.output_tokens}")
            recommended_voice = _parse(msg_rec)
            current_voice = {}
        except Exception as e:
            logger.error(f"Brand voice no-site recommended error: {e}")
            raise
    else:
        # ── Website path: Call 1 — Current voice (purely descriptive) ────────────────────────────
        prompt_current = f"""Business: {business_name}

Website copy (service, location, and core business pages only):
{content_text[:8000]}

Describe the brand voice EXACTLY as it currently exists on this website. Be objective and descriptive — report what you observe, do not prescribe or improve anything.

Return a JSON object with exactly this structure:
{VOICE_SCHEMA}"""

        try:
            msg1 = await client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system="You are a brand analyst. Describe brand voice objectively based on evidence from the website copy. Do not prescribe or recommend — only describe what you observe. Return only valid JSON, no markdown, no explanation.",
                messages=[{'role': 'user', 'content': prompt_current}],
            )
            u1 = msg1.usage
            logger.info(f"Brand voice call 1 (current) — input: {u1.input_tokens}, output: {u1.output_tokens}, est. cost: ${(u1.input_tokens * 0.0000008) + (u1.output_tokens * 0.000004):.5f}")
            current_voice = _parse(msg1)
        except Exception as e:
            logger.error(f"Brand voice call 1 error: {e}")
            raise

        # ── Call 2: Recommended voice (aspirational) ──────────────────────────────
        prompt_recommended = f"""Business: {business_name}

Current brand voice:
- Personality: {', '.join(current_voice.get('personality', []))}
- Tone: {current_voice.get('tone', '')}

Website copy (service, location, and core business pages only):
{content_text[:8000]}

Based on the current brand voice and business type, recommend an elevated brand voice that would better serve this business. Do NOT simply mirror the existing copy — improve weak or generic messaging.

Return a JSON object with exactly this structure:
{VOICE_SCHEMA}"""

        try:
            msg2 = await client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system="You are a senior brand strategist and direct-response copywriter for local service businesses. Recommend an elevated, optimized brand voice. Return only valid JSON, no markdown, no explanation.",
                messages=[{'role': 'user', 'content': prompt_recommended}],
            )
            u2 = msg2.usage
            logger.info(f"Brand voice call 2 (recommended) — input: {u2.input_tokens}, output: {u2.output_tokens}, est. cost: ${(u2.input_tokens * 0.0000008) + (u2.output_tokens * 0.000004):.5f}")
            recommended_voice = _parse(msg2)
        except Exception as e:
            logger.error(f"Brand voice call 2 error: {e}")
            recommended_voice = {}

    # ── Call 3 (shared): Writer Execution Guide (based on recommended voice) ────────────
    prompt_guide = f"""Business: {business_name}
Recommended brand voice summary: {recommended_voice.get('tone', '')}
Personality: {', '.join(recommended_voice.get('personality', []))}

{"Website copy:" if has_content else "No website available — write the guide based on the recommended voice and business category."}
{content_text[:6000]}

Return a JSON object with exactly this structure:
{{
  "how_to_think_before_writing": "<role and mindset the writer should assume>",
  "core_writing_objective": "<what every piece of content must achieve>",
  "default_writing_formula": "<e.g. Problem → Consequence → Solution → Outcome — include a concrete example sentence>",
  "non_negotiable_rules": ["<rule 1>", "<rule 2>", "<rule 3>", "<rule 4>", "<rule 5>"],
  "sentence_style_do": ["<DO example 1>", "<DO example 2>", "<DO example 3>"],
  "sentence_style_dont": ["<DON'T example 1>", "<DON'T example 2>", "<DON'T example 3>"],
  "rewriting_framework": ["<generic → specific example>", "<feature → outcome example>", "<soft → direct example>"],
  "before_after_weak": "<a weak copy example>",
  "before_after_strong": "<the improved version>",
  "seo_aeo_instructions": "<guidance for answer-first, scannable content for SEO and AI retrieval>",
  "ai_writing_rules": "<instructions for maintaining voice when using AI tools>",
  "common_failure_modes": ["<failure mode 1 and fix>", "<failure mode 2 and fix>", "<failure mode 3 and fix>"],
  "quick_cheat_sheet": ["<rule 1>", "<rule 2>", "<rule 3>", "<rule 4>", "<rule 5>"]
}}"""

    try:
        msg3 = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=3000,
            system="You are a senior brand strategist and direct-response copywriter building brand voice systems for local service businesses. Return only valid JSON, no markdown, no explanation.",
            messages=[{'role': 'user', 'content': prompt_guide}],
        )
        u3 = msg3.usage
        logger.info(f"Brand voice call 3 (guide) — input: {u3.input_tokens}, output: {u3.output_tokens}, est. cost: ${(u3.input_tokens * 0.0000008) + (u3.output_tokens * 0.000004):.5f}")
        guide = _parse(msg3)
    except Exception as e:
        logger.error(f"Brand voice call 3 error: {e}")
        guide = {}

    return {
        "current_voice": current_voice,
        "recommended_voice": recommended_voice,
        "recommended_accepted": None,   # null = not yet decided
        "writer_execution_guide": guide,
    }


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

        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=15.0,
            headers=CRAWL_HEADERS,
        ) as client:
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
            texts = await asyncio.gather(*[_fetch_page_text(p['url'], client) for p in selected])

        page_contents = [
            f"[{p.get('page_type', 'page')}] {p['url']}\n{text[:600]}"
            for p, text in zip(selected, texts)
            if text.strip()
        ]
        pages_sampled = len(page_contents)
        logger.info(f"Brand voice: sampled {pages_sampled}/{len(selected)} pages for {url}")

        if not page_contents:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Your website was reached but no readable text content was found. "
                    "This usually means the site is JavaScript-rendered (React, Vue, etc.) "
                    "and requires server-side rendering to be crawlable. "
                    "Contact ShowUP support for assistance."
                )
            )
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
SCORE_MODEL = "claude-haiku-4-5-20251001"  # Structured JSON grading — Haiku is sufficient

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
- Total title length: 60–70 characters ideal, 80 max

AEO / LLM WRITING RULES — apply throughout every section

These rules make content retrievable by AI assistants (ChatGPT, Gemini, Perplexity) and
optimised for Answer Engine Optimisation. Follow all of them in every section.

1. ANSWER-FIRST: Open every section, paragraph, and FAQ answer with a direct claim.
   State the conclusion before the explanation.
   ✗ Bad:  "Tree service is a complex process that requires professional expertise..."
   ✓ Good: "[Brand] removes trees same-day in Anaheim — including emergency situations."

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
   ✗ "We respond quickly."              → ✓ "Crews arrive within 2–4 hours for Anaheim emergencies."
   ✗ "Serving the local area."          → ✓ "Serving Anaheim, Anaheim Hills, Yorba Linda & Orange County."
   ✗ "Competitive pricing."             → ✓ "Free estimates — no trip fee within a 15-mile radius."

9. ENTITY TRIPLETS in ≥3 sections: [Brand] + [service] + [city] must co-occur in the
   intro, the main services body, the local section, and the FAQ. This establishes the
   entity relationship in LLM retrieval.

10. SECTION LENGTH ≤300 words: LLMs extract from dense sections poorly. If a topic needs
    more depth, split it into multiple H2 subsections rather than lengthening one section.

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
  <p>[Brand] provides [service] to [city] — [primary differentiator stated in first sentence]. [2–3 sentences: service confirmation, availability, phone CTA.] [Close with direct service claim + city.]</p>
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
  - You may use MULTIPLE H2s within this section if the content warrants separate major topics
  - Each H2 should represent a distinct major topic or service category
  - Use H3s under each H2 for sub-services, use cases, or scenarios
  - Every heading: include service/city naturally where it fits (not forced)
  - Open with a primary service description paragraph (answer-first)
  - Each H3: 2–4 sentences covering description, real-world scenario, differentiator, geo reference
  - Naturally weave in competitor entities and phrases from SERP data throughout
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
  [City + min 3 neighborhoods in sentence context (not just a list) + min 1 landmark + min 2 streets + zip codes (min 3). Use only real, verifiable geographic details. If neighborhood/landmark/street/zip data is not provided in the business data, include only what you are certain is accurate for the target city. Do not invent or guess street names, zip codes, or landmarks. Coverage + response time.]
</section>

Section 11 — CTA Block Tertiary (50–75 words — urgency-forward)
<section id="cta-tertiary">...</section>

Section 12 — FAQ (min 6, max 10 entries — 40–80 words each)
<section id="faq">
  <h2>Frequently Asked Questions</h2>
  [Must cover: availability, response time, coverage area, emergency service. Answer-first. Geographic + availability signal in each proximity FAQ.]
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
- Invent or guess phone numbers, addresses, hours, zip codes, street names, or landmarks not explicitly provided in the business data"""

_REOPT_SYSTEM_PROMPT = """You are an expert local SEO content writer. Fix the SEO deficiencies in the page provided by updating its text content only.

STRICT RULES — follow exactly:
1. TEXT ONLY: Only change text content (words between HTML tags). You may also update SEO-relevant attributes: alt, title, meta[content], og:title, og:description, aria-label, and JSON-LD schema text values.
2. PRESERVE EVERYTHING ELSE: Do not change any element types, CSS classes, IDs, data-* attributes, href, src, or any non-content attributes. Do not add, remove, or reorder any HTML elements.
3. Fix every deficiency listed through word choices, phrasing, and copy — not by adding new HTML sections.
4. Naturally incorporate competitor entities and phrases from SERP data where missing.
5. Do not fabricate reviews or placeholder text. Do not use "near me" literally in body copy.

Return your response in EXACTLY this format (do not deviate):

<<<NOTES>>>
List each HTML/CSS structural change that would further improve SEO but that you could NOT make because it requires adding/moving/removing elements or changing classes. Be specific (e.g. "Add an FAQ section with schema markup", "H1 tag is missing — the page title is wrapped in a <div> instead"). If none, write "None."
<<<HTML>>>
[Complete page HTML with ONLY text content and SEO attributes changed]"""

_SCORE_SYSTEM_PROMPT = """You are an expert local SEO analyst. Score the provided page against all 7 engines below.

SCORING CRITERIA — score each engine 0–100:

1. organic_ranking (weight 20%): keyword in title + H1 + opening ¶; service/transactional tone (not blog); CTA + phone visible; clear service offering.

2. gbp_maps (weight 25%): exact city name present; service matches GBP category; brand+service+city entity triplet; NAP signals consistent; multiple service mentions.

3. entity_establishment (weight 15%): brand+service+city co-occurrence in ≥3 sections; sub-services mentioned; descriptive anchor text signals; topical depth.

4. icp_alignment (weight 10%): detect ICP from keyword modifier (emergency→urgent tone; commercial→B2B tone; general→professional/reliable); CTA tone matches ICP (e.g. emergency ICP requires urgency/fear-based CTA, not generic "call for a free estimate"); pain points addressed; emotional register of copy matches searcher intent.

5. aeo_llm_retrieval (weight 10%): answer-first formatting (direct claim before explanation); FAQ with ≥4 entries, each opening with a direct yes/no or factual statement; question-format H3s where appropriate; each section ≤300 words; ≥1 bulleted list with outcome-first bullets; ≥1 numbered list for a process or steps; tables used where content is genuinely comparative (service tiers, response times, inclusions) — penalise only if comparative data is present but no table was used; specific operational facts (numbers, timeframes, named places) rather than generic filler.

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
    "organic_ranking":      0.20,
    "gbp_maps":             0.25,
    "entity_establishment": 0.15,
    "icp_alignment":        0.10,
    "aeo_llm_retrieval":    0.10,
    "geographic_legitimacy":0.10,
    "nearme_intent":        0.10,
}

_ENGINE_LABELS = {
    "organic_ranking":       "Organic Ranking Engine",
    "gbp_maps":              "GBP / Maps Relevance Engine",
    "entity_establishment":  "Entity Establishment Engine",
    "icp_alignment":         "ICP Alignment Engine",
    "aeo_llm_retrieval":     "AEO / LLM Retrieval Engine",
    "geographic_legitimacy": "Geographic Legitimacy Engine",
    "nearme_intent":         "Hyperlocal / Near-Me Engine",
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
        logger.warning(f"_parse_claude_json: failed to parse JSON, returning empty dict. Raw: {text[:300]}")
        return {}

def compute_zone_targets(
    zone_buckets: Dict[str, List[str]],
    related: ZoneKeywords,
    google_entities: List[dict],
) -> Dict[str, dict]:
    """
    For each zone, count how many of the filtered related-keyword terms appear in
    each competitor page's zone text, then return the max count as the target.
    Also computes per-zone entity targets by counting how many Google entities
    appear in each zone across competitor pages.
    """
    targets: Dict[str, dict] = {}
    entity_names = {e["name"].lower() for e in google_entities} if google_entities else set()

    for zone_name in ZONES:
        terms = getattr(related, zone_name, [])
        term_set = {t["term"].lower() for t in terms} if terms else set()
        max_term_count = 0
        max_entity_count = 0

        for page_text in zone_buckets.get(zone_name, []):
            if not page_text:
                continue
            cleaned = clean_text(page_text).lower()
            if term_set:
                max_term_count = max(max_term_count, sum(1 for t in term_set if t in cleaned))
            if entity_names:
                max_entity_count = max(max_entity_count, sum(1 for e in entity_names if e in cleaned))

        targets[zone_name] = {"target": max_term_count, "entity_target": max_entity_count}

    return targets


def _build_score_prompt(
    business_name: str,
    gbp_category: str,
    keyword: str,
    city: str,
    address: Optional[str],
    serp_ctx: str,
    page_text: str,
) -> str:
    """Returns the dynamic user-message portion of the scoring prompt.
    The static system instructions are in _SCORE_SYSTEM_PROMPT (cached separately)."""
    return f"""CONTEXT
Business: {business_name}
Category: {gbp_category}
Keyword: {keyword}
City: {city}
Address: {address or "Not provided"}
{serp_ctx}

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
    page_text = _BS2(page_html, "html.parser").get_text(separator="\n", strip=True)[:8000]
    city = location.split(",")[0].strip()
    user_prompt = _build_score_prompt(business_name, gbp_category, keyword, city, address, "", page_text)
    msg = await haiku_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {"role": "user", "content": user_prompt},
            {"role": "assistant", "content": "{"},
        ],
    )
    token_rec = _token_record(
        "related-pages/score", "claude-haiku-4-5-20251001",
        msg.usage.input_tokens, msg.usage.output_tokens,
    )
    scores = _parse_claude_json("{" + msg.content[0].text)
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


# ── /find-page-for-keyword ────────────────────────────────────────────────────

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

            # ── Direct URL guessing (runs if sitemap found nothing useful) ─────────
            # Generate slug permutations from service + location words and probe them.
            # Catches cases where sitemap discovery fails entirely.
            if not svc_matches and not loc_matches:
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
                    candidate_pool = guessed + candidate_pool

            # ── site: search fallback ─────────────────────────────────────────────
            # If all sitemap + guessing attempts found nothing, query Google via
            # DataForSEO with  site:{domain} {keyword} {city}  and use the results.
            if not candidate_pool and DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD:
                try:
                    city = (body.location or "").split(",")[0].strip()
                    site_query = f"site:{base_netloc} {body.keyword} {city}".strip()
                    logger.info(f"find-page-for-keyword: falling back to site-search: {site_query!r}")
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
                        logger.info(f"find-page-for-keyword: site-search returned {len(candidate_pool)} results")
                except Exception as _se:
                    logger.warning(f"find-page-for-keyword: site-search failed ({_se})")

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


@app.post('/score-page', response_model=ScorePageResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def score_page(request: Request, body: ScorePageRequest):
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
    page_text = _BS(page_html, "html.parser").get_text(separator="\n", strip=True)[:8000]
    city = body.location.split(",")[0].strip()
    serp_ctx = _serp_context(serp_analysis_dict)

    user_prompt = _build_score_prompt(body.business_name, body.gbp_category, body.keyword, city, body.address, serp_ctx, page_text)

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
                    {"role": "assistant", "content": "{"},  # prefill: forces JSON start, prevents preamble
                ],
            )
            token_rec = _token_record("score-page", SCORE_MODEL, msg.usage.input_tokens, msg.usage.output_tokens)
            parsed = _parse_claude_json("{" + msg.content[0].text)  # prepend the prefilled "{"
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
    differentiators: Optional[List[dict]] = None
    icp_type: Optional[str] = None
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


@app.post('/generate-page', dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def generate_page(request: Request, body: GeneratePageRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic

    async def _worker(q: asyncio.Queue):
        client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        city = body.location.split(",")[0].strip()

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

        icp = body.icp_type or "General Homeowner"

        # Build brand voice block
        brand_voice_text = ""
        if body.brand_voice:
            bv = body.brand_voice
            # Use recommended_accepted voice if user accepted one, otherwise fall back to recommended, then current
            accepted = bv.get("recommended_accepted")
            if accepted == "recommended":
                voice = bv.get("recommended_voice") or bv.get("current_voice") or {}
            elif accepted == "current":
                voice = bv.get("current_voice") or {}
            else:
                voice = bv.get("recommended_voice") or bv.get("current_voice") or {}
            guide = bv.get("writer_execution_guide", "")
            if voice or guide:
                lines = ["BRAND VOICE (match this exactly):"]
                if voice.get("tone"):
                    lines.append(f"  Tone: {voice['tone']}")
                if voice.get("personality"):
                    lines.append(f"  Personality: {', '.join(voice['personality'])}")
                ws = voice.get("writing_style", {})
                if ws:
                    lines.append(f"  Writing style: {ws.get('sentence_length','')} sentences, {ws.get('person','')} person, {ws.get('formality','')} formality")
                vocab = voice.get("vocabulary", {})
                if vocab.get("use"):
                    lines.append(f"  Words/phrases to use: {', '.join(vocab['use'])}")
                if vocab.get("avoid"):
                    lines.append(f"  Words/phrases to avoid: {', '.join(vocab['avoid'])}")
                if guide:
                    lines.append(f"  Writer instructions: {guide}")
                brand_voice_text = "\n".join(lines)

        # Build ICP block
        icp_text = ""
        if body.detected_icp:
            segments = body.detected_icp.get("segments", [])
            if segments:
                lines = ["TARGET CUSTOMER PROFILES (write to these):"]
                for seg in segments[:3]:  # cap at 3 segments
                    name = seg.get("name", "")
                    desc = seg.get("description", "")
                    msg_data = seg.get("messaging", {})
                    tone = msg_data.get("tone", "")
                    hooks = msg_data.get("hooks", [])
                    pain = msg_data.get("trust_signals", [])
                    lines.append(f"  [{name}] {desc}")
                    if tone:
                        lines.append(f"    Messaging tone: {tone}")
                    if hooks:
                        lines.append(f"    Headline hooks: {'; '.join(hooks[:2])}")
                    if pain:
                        lines.append(f"    Trust signals: {'; '.join(pain[:2])}")
                icp_text = "\n".join(lines)

        user_prompt = f"""BUSINESS DATA
Name: {body.business_name}
Category: {body.gbp_category}
Address: {body.address}
Phone: {body.phone or "Not provided — use [PHONE] as placeholder"}
Website: {body.website or ""}
Hours: {body.hours or "Not provided"}
Primary keyword: {body.keyword}
Target city: {city}
Full location: {body.location}
ICP: {icp}

{brand_voice_text}
{icp_text}
{diff_text}
{reviews_text}
{serp_ctx}"""

        await q.put({"step": "progress", "progress": 65, "message": "Generating your page…"})

        try:
            claude_msg = await client.messages.create(
                model=GENERATION_MODEL,
                max_tokens=6000,
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

        # Split content_html from schema_json
        schema_split = raw.find('<script type="application/ld+json">')
        if schema_split != -1:
            content_html = raw[:schema_split].strip()
            schema_json = raw[schema_split:].strip()
        else:
            content_html = raw
            schema_json = ""

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
                "token_usage": token_rec,
                "cost_breakdown": cost_breakdown,
                "serp_analysis": serp_analysis_dict,
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


@app.post('/reoptimize-page', dependencies=[Depends(verify_api_key)])
@limiter.limit("5/minute")
async def reoptimize_page(request: Request, body: ReoptimizePageRequest):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic as _anthropic

    async def _worker(q: asyncio.Queue):
        client = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        city = body.location.split(",")[0].strip()
        serp_ctx = _serp_context(body.serp_analysis)

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

        deficiency_text = "\n".join(
            f"  Engine: {d['engine']} (score: {d['score']}/100)\n"
            f"  Issues: {'; '.join(d.get('issues', []))}\n"
            f"  Fixes needed: {'; '.join(d.get('recommendations', []))}"
            for d in body.deficiencies
        )

        user_prompt = f"""BUSINESS: {body.business_name} | CATEGORY: {body.gbp_category}
KEYWORD: {body.keyword} | CITY: {city}
PHONE: {body.phone or "[PHONE]"}
ADDRESS: {body.address or "Not provided"}
{serp_ctx}

DEFICIENCIES TO FIX:
{deficiency_text}

EXISTING PAGE:
{existing_html[:12000]}"""

        await q.put({"step": "progress", "progress": 40, "message": "Reoptimizing your page…"})

        try:
            claude_msg = await client.messages.create(
                model=GENERATION_MODEL,
                max_tokens=6000,
                system=[{"type": "text", "text": _REOPT_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
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

        # Split on delimiter to extract notes and HTML separately
        html_css_notes: List[str] = []
        if "<<<HTML>>>" in raw:
            parts = raw.split("<<<HTML>>>", 1)
            notes_block = parts[0]
            html_block = parts[1].strip()
            # Extract bullet lines from the notes block (between <<<NOTES>>> and <<<HTML>>>)
            if "<<<NOTES>>>" in notes_block:
                notes_text = notes_block.split("<<<NOTES>>>", 1)[1].strip()
            else:
                notes_text = notes_block.strip()
            if notes_text and notes_text.lower() != "none.":
                for line in notes_text.splitlines():
                    line = line.strip().lstrip("-•*123456789. ").strip()
                    if line and line.lower() != "none.":
                        html_css_notes.append(line)
        else:
            html_block = raw

        schema_split = html_block.find('<script type="application/ld+json">')
        if schema_split != -1:
            content_html = html_block[:schema_split].strip()
            schema_json = html_block[schema_split:].strip()
        else:
            content_html = html_block
            schema_json = None

        await q.put({"step": "progress", "progress": 95, "message": "Finishing up…"})
        await q.put({
            "step": "done",
            "result": {
                "content_html": content_html,
                "schema_json": schema_json,
                "token_usage": token_rec,
                "html_css_notes": html_css_notes,
            },
        })

    return await _sse_stream(_worker)


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

    # Build ICP block
    icp_text = ""
    if body.detected_icp:
        segments = body.detected_icp.get("segments", [])
        if segments:
            lines = ["\nTARGET CUSTOMER PROFILES (write to these pain points and motivations):"]
            for seg in segments[:2]:
                name = seg.get("name", "")
                desc = seg.get("description", "")
                msg = seg.get("messaging", {})
                tone = msg.get("tone", "")
                hooks = msg.get("hooks", [])
                lines.append(f"  [{name}] {desc}")
                if tone:
                    lines.append(f"    Tone: {tone}")
                if hooks:
                    lines.append(f"    Hooks: {'; '.join(hooks[:2])}")
            icp_text = "\n".join(lines)

    # Build brand voice block
    brand_voice_text = ""
    if body.brand_voice:
        bv = body.brand_voice
        accepted = bv.get("recommended_accepted")
        if accepted == "recommended":
            voice = bv.get("recommended_voice") or bv.get("current_voice") or {}
        elif accepted == "current":
            voice = bv.get("current_voice") or {}
        else:
            voice = bv.get("recommended_voice") or bv.get("current_voice") or {}
        guide = bv.get("writer_execution_guide", "")
        if voice or guide:
            lines = ["\nBRAND VOICE (match this exactly):"]
            if voice.get("tone"):
                lines.append(f"  Tone: {voice['tone']}")
            if voice.get("personality"):
                lines.append(f"  Personality: {', '.join(voice['personality'])}")
            ws = voice.get("writing_style", {})
            if ws:
                lines.append(f"  Style: {ws.get('sentence_length','')} sentences, {ws.get('person','')} person, {ws.get('formality','')} formality")
            vocab = voice.get("vocabulary", {})
            if vocab.get("use"):
                lines.append(f"  Words/phrases to use: {', '.join(vocab['use'])}")
            if vocab.get("avoid"):
                lines.append(f"  Words/phrases to avoid: {', '.join(vocab['avoid'])}")
            if guide:
                lines.append(f"  Writer instructions: {guide}")
            brand_voice_text = "\n".join(lines)

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
    """True if 60%+ of keyword tokens appear in business name (case-insensitive)."""
    kw_tokens = set(re.sub(r'[^a-z0-9\s]', '', keyword.lower()).split())
    name_lower = re.sub(r'[^a-z0-9\s]', '', business_name.lower())
    if not kw_tokens:
        return False
    matches = sum(1 for t in kw_tokens if t in name_lower)
    return matches / len(kw_tokens) >= 0.6


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
