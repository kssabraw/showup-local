import sys
import os
import logging
import asyncio
import base64

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
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
    from typing import List, Dict, Optional
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

# ── CORS ──────────────────────────────────────────────────────────────────────
# Reads allowed origins from CORS_ORIGINS env var (comma-separated).
# Falls back to * in development. Tighten to your Railway/Vercel frontend
# URL in production via the Railway dashboard.
_cors_origins_env = os.environ.get("CORS_ORIGINS", "*")
CORS_ORIGINS = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info(f"CORS origins: {CORS_ORIGINS}")

STOP_WORDS = set(stopwords.words('english'))

# ── API credentials (set all in Railway environment variables) ────────────────
GOOGLE_NLP_API_KEY   = os.environ.get("GOOGLE_NLP_API_KEY", "")
DATAFORSEO_LOGIN     = os.environ.get("DATAFORSEO_LOGIN", "")
DATAFORSEO_PASSWORD  = os.environ.get("DATAFORSEO_PASSWORD", "")
SCRAPEOWL_API_KEY    = os.environ.get("SCRAPEOWL_API_KEY", "")
ANTHROPIC_API_KEY    = os.environ.get("ANTHROPIC_API_KEY", "")

GOOGLE_NLP_ENDPOINT  = "https://language.googleapis.com/v1/documents:analyzeEntities"
DATAFORSEO_ENDPOINT  = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
SCRAPEOWL_ENDPOINT   = "https://app.scrapeowl.com/api/scrape"

logger.info("App initialized, ready to serve")
for name, val in [
    ("GOOGLE_NLP_API_KEY", GOOGLE_NLP_API_KEY),
    ("DATAFORSEO_LOGIN",   DATAFORSEO_LOGIN),
    ("SCRAPEOWL_API_KEY",  SCRAPEOWL_API_KEY),
]:
    if not val:
        logger.warning(f"{name} not set — related feature will be skipped")

# ── Constants ─────────────────────────────────────────────────────────────────
ZONES = ["title", "h1", "h2_h3", "body"]

RELATED_MIN_PAGE_SPREAD  = 0.49
RELATED_MIN_SIMILARITY   = 0.1
QUADGRAM_MIN_PAGE_SPREAD = 0.49
QUADGRAM_MIN_SIMILARITY  = 0.1
ENTITY_MIN_PAGE_SPREAD   = 0.49
ENTITY_MIN_SALIENCE      = 0.40
GOOGLE_NLP_MAX_BYTES     = 100_000

# DataForSEO: how many organic results to request
SERP_RESULT_COUNT = 10

# Domains to skip — directories, aggregators, social, video
# Intentionally whitelisted: reddit.com, linkedin.com, facebook.com, quora.com
SKIP_DOMAINS = {
    "yelp.com", "yellowpages.com", "bbb.org", "angi.com", "thumbtack.com",
    "homeadvisor.com", "houzz.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "tiktok.com",
    "wikipedia.org", "amazon.com", "ebay.com",
    "angieslist.com", "nextdoor.com", "mapquest.com", "maps.google.com",
}


# ── Request / Response models ─────────────────────────────────────────────────

class AnalysisRequest(BaseModel):
    keyword: str
    location: str                        # e.g. "Anaheim, California, United States"
    urls: Optional[List[str]] = None     # override SERP lookup — pass URLs directly


class ZoneKeywords(BaseModel):
    title: List[dict]
    h1: List[dict]
    h2_h3: List[dict]
    body: List[dict]


class AnalysisResponse(BaseModel):
    keyword: str
    location: str
    serp_urls: List[str]                 # URLs that were actually scraped + analysed
    related_keywords: ZoneKeywords
    top_quadgrams: List[dict]
    google_entities: List[dict]


# ── Step 1: DataForSEO — fetch top organic SERP URLs ─────────────────────────

async def fetch_serp_urls(keyword: str, location: str, client: httpx.AsyncClient) -> List[str]:
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

    payload = [{
        "keyword": keyword,
        "location_name": location,
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

async def scrape_url(url: str, client: httpx.AsyncClient) -> Optional[str]:
    """
    Fetches raw HTML for a single URL via ScrapeOwl.
    Returns None on failure so the pipeline continues with remaining pages.
    """
    if not SCRAPEOWL_API_KEY:
        return None

    try:
        response = await client.post(
            SCRAPEOWL_ENDPOINT,
            json={
                "api_key": SCRAPEOWL_API_KEY,
                "url": url,
                "render_js": False,   # static HTML is enough for NLP; faster + cheaper
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        html = data.get("html") or data.get("body") or ""
        if len(html.strip()) < 200:
            logger.warning(f"ScrapeOwl returned thin content for {url}")
            return None
        return html
    except Exception as e:
        logger.warning(f"ScrapeOwl error for {url}: {e}")
        return None


async def scrape_urls(urls: List[str]) -> List[str]:
    """
    Scrapes all URLs concurrently via ScrapeOwl.
    Returns only non-empty HTML strings — failed pages are silently dropped.
    """
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[scrape_url(url, client) for url in urls])

    pages = [html for html in results if html]
    logger.info(f"Successfully scraped {len(pages)}/{len(urls)} pages")
    return pages


# ── HTML parsing ──────────────────────────────────────────────────────────────

def extract_zones(html: str) -> Dict[str, str]:
    """Parse HTML and return text extracted per zone."""
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("title")
    title_text = title_tag.get_text(separator=" ", strip=True) if title_tag else ""

    h1_tags = soup.find_all("h1")
    h1_text = " ".join(t.get_text(separator=" ", strip=True) for t in h1_tags)

    h2h3_tags = soup.find_all(["h2", "h3"])
    h2h3_text = " ".join(t.get_text(separator=" ", strip=True) for t in h2h3_tags)

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

@app.post('/analyze', response_model=AnalysisResponse)
async def analyze(request: AnalysisRequest):
    """
    Full pipeline:
      1. DataForSEO  — fetch top organic URLs for keyword + location
      2. ScrapeOwl   — fetch raw HTML for each URL concurrently
      3. NLP         — related keywords, quadgrams, Google entity analysis

    Pass optional `urls` to skip the DataForSEO SERP step (testing / override).
    """
    # Step 1: get URLs
    if request.urls:
        urls = request.urls
        logger.info(f"Using {len(urls)} manually provided URLs")
    else:
        async with httpx.AsyncClient() as client:
            urls = await fetch_serp_urls(request.keyword, request.location, client)
        if not urls:
            raise HTTPException(status_code=502, detail="DataForSEO returned no usable URLs")

    # Step 2: scrape
    pages = await scrape_urls(urls)
    if len(pages) < 2:
        raise HTTPException(
            status_code=502,
            detail=f"Only {len(pages)} pages scraped successfully — need at least 2"
        )

    # Step 3: parse zones
    zone_buckets: Dict[str, List[str]] = {z: [] for z in ZONES + ["paragraphs"]}
    scraped_urls: List[str] = []
    for url, html in zip(urls, pages):
        zones = extract_zones(html)
        for z in ZONES + ["paragraphs"]:
            zone_buckets[z].append(zones[z])
        scraped_urls.append(url)

    # Step 4: NLP analysis
    related = ZoneKeywords(
        title=get_related_keywords_for_zone(zone_buckets["title"], request.keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], request.keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], request.keyword),
        body=get_related_keywords_for_zone(zone_buckets["body"], request.keyword),
    )
    quadgrams = get_top_quadgrams(zone_buckets["paragraphs"], request.keyword)
    google_entities = await get_google_entities(zone_buckets["paragraphs"])

    return AnalysisResponse(
        keyword=request.keyword,
        location=request.location,
        serp_urls=scraped_urls,
        related_keywords=related,
        top_quadgrams=quadgrams,
        google_entities=google_entities,
    )


@app.get('/health')
async def health():
    return {'status': 'ok'}


# ── Business Analysis: website crawl + ICP/differentiator extraction ──────────

class BusinessAnalysisRequest(BaseModel):
    website_url: str
    business_name: str
    gbp_category: str
    gbp_categories: List[str] = []


class BusinessAnalysisResponse(BaseModel):
    existing_pages: List[dict]
    detected_icp: Optional[dict]
    differentiators: List[dict]
    pages_crawled: int
    analysis_status: str   # "complete" | "partial" | "failed"


STATE_ABBREVS = {
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in',
    'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv',
    'nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn',
    'tx','ut','vt','va','wa','wv','wi','wy',
}
SERVICE_WORDS = {
    'repair','service','services','installation','install','replacement',
    'maintenance','inspection','cleaning','emergency','plumbing','hvac',
    'electrical','roofing','pest','landscaping','remodeling','painting',
    'flooring','gutters','siding','windows','doors','concrete','fencing',
    'generator','insulation','waterproofing','restoration',
}

CRAWL_HEADERS = {
    'User-Agent': 'ShowUPLocalBot/1.0 (business-page-discovery; respects robots.txt)',
}


def classify_page_type(url: str, title: str = '', h1: str = '') -> dict:
    """
    Rule-based page type classifier. Works on URL path alone — title/h1 are
    optional enrichment when available.
    Returns { type, primary_service, primary_city }
    """
    import urllib.parse
    path = urllib.parse.urlparse(url).path.lower().rstrip('/')
    combined = f"{path} {title} {h1}".lower()

    path_parts = set(re.split(r'[-/_]', path))
    has_geo = bool(
        path_parts & STATE_ABBREVS or
        re.search(r'\b\d{5}\b', combined)  # zip code in title/h1
    )
    has_service = bool(path_parts & SERVICE_WORDS or any(w in combined for w in SERVICE_WORDS))

    if has_geo and has_service:
        page_type = 'city_service'
    elif has_geo:
        page_type = 'location'
    elif has_service:
        page_type = 'service'
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
                *[_fetch_sitemap_urls(u, client, depth + 1) for u in child_urls[:10]]
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

    # Fall back to conventional sitemap.xml location
    if not sitemap_url:
        sitemap_url = f"{origin}/sitemap.xml"

    urls = await _fetch_sitemap_urls(sitemap_url, client)
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


async def crawl_website(website_url: str, max_pages: int = 200) -> List[dict]:
    """
    Sitemap-first page discovery pipeline:
      1. robots.txt → sitemap URL
      2. Parse sitemap XML → all <loc> URLs (no per-page HTTP requests)
      3. Fallback: nav extraction from homepage (1 request)
      4. Last resort: shallow 1-level BFS from homepage

    Classifies each URL by pattern — no need to fetch individual pages.
    """
    import urllib.parse

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
            discovered = await _discover_via_nav(url, client)  # same as nav but logged differently

        # Always include the homepage itself
        parsed = urllib.parse.urlparse(url)
        homepage = f"{parsed.scheme}://{parsed.netloc}"
        all_urls = list(dict.fromkeys([homepage] + discovered))  # dedup, preserve order

        # Classify by URL pattern — no per-page fetches needed
        pages = [_make_page_record(u) for u in all_urls[:max_pages]]

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

        page_lines = []
        for p in pages[:25]:
            page_lines.append(
                f"  [{p['page_type']}] {p['url']}\n"
                f"    Title: {p['title']}\n"
                f"    H1: {p['h1']}"
            )
        pages_text = '\n'.join(page_lines) if page_lines else '  (no pages discovered)'

        prompt = f"""You are an expert marketing strategist. Analyze this local service business and identify its ideal customer profiles (ICPs) with full psychographic detail.

Business Name: {business_name}
GBP Primary Category: {gbp_category}
All GBP Categories: {', '.join(gbp_categories) if gbp_categories else 'N/A'}

Discovered website pages:
{pages_text}

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

Extract differentiators only from the page titles and H1s above. Look for speed claims, pricing models, guarantees, specializations. If none are evident, return an empty array.

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


@app.post('/analyze-business', response_model=BusinessAnalysisResponse)
async def analyze_business(request: BusinessAnalysisRequest):
    """
    Phase 1 business setup pipeline:
      1. Sitemap-first page discovery (robots.txt → sitemap.xml → nav fallback)
      2. Classify each page as service / location / city_service / other
      3. Use Claude Haiku to detect ICP and extract differentiators
    """
    if not request.website_url:
        raise HTTPException(status_code=400, detail="website_url is required")

    # Normalize URL
    url = request.website_url.strip()
    if not url.startswith(('http://', 'https://')):
        url = f"https://{url}"

    try:
        pages = await asyncio.wait_for(
            crawl_website(url),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        logger.warning(f"Page discovery timed out for {url}")
        pages = []

    try:
        llm_result = await analyze_business_with_anthropic(
            pages,
            request.business_name,
            request.gbp_category,
            request.gbp_categories,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Anthropic analysis failed: {e}")

    status = 'complete' if pages else 'partial'

    return BusinessAnalysisResponse(
        existing_pages=pages,
        detected_icp=llm_result.get('detected_icp'),
        differentiators=llm_result.get('differentiators', []),
        pages_crawled=len(pages),
        analysis_status=status,
    )
