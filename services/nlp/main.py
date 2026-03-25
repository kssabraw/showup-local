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


def classify_page_type(url: str, title: str, h1: str) -> dict:
    """
    Rule-based page type classifier.
    Returns { type, primary_service, primary_city }
    """
    import urllib.parse
    path = urllib.parse.urlparse(url).path.lower().rstrip('/')
    combined = f"{title} {h1}".lower()

    # Heuristic geo signals in URL path or headings
    geo_patterns = [
        r'\b[a-z]+-[a-z]+\b',   # hyphenated city-state patterns
        r'\b(near|in|serving|around)\s+[a-z]+\b',
    ]
    us_states = {
        'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
        'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
        'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
        'minnesota','mississippi','missouri','montana','nebraska','nevada',
        'new hampshire','new jersey','new mexico','new york','north carolina',
        'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
        'south carolina','south dakota','tennessee','texas','utah','vermont',
        'virginia','washington','west virginia','wisconsin','wyoming',
    }
    state_abbrevs = {
        'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in',
        'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv',
        'nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn',
        'tx','ut','vt','va','wa','wv','wi','wy',
    }

    path_parts = set(re.split(r'[-/]', path))
    has_geo = bool(
        path_parts & state_abbrevs or
        any(s in combined for s in us_states) or
        re.search(r'\b\d{5}\b', combined)  # zip code
    )

    # Service signals: anything that isn't purely informational
    service_words = {
        'repair','service','services','installation','install','replacement',
        'maintenance','inspection','cleaning','emergency','plumbing','hvac',
        'electrical','roofing','pest','landscaping','remodeling','painting',
    }
    has_service = bool(path_parts & service_words or any(w in combined for w in service_words))

    if has_geo and has_service:
        page_type = 'city_service'
    elif has_geo:
        page_type = 'location'
    elif has_service:
        page_type = 'service'
    else:
        page_type = 'other'

    return {'type': page_type, 'primary_service': None, 'primary_city': None}


async def crawl_website(website_url: str, max_pages: int = 30, max_depth: int = 3) -> List[dict]:
    """
    Crawl a business website via direct httpx requests.
    Returns a list of page records with url, title, h1, page_type.
    """
    import urllib.parse

    try:
        parsed_base = urllib.parse.urlparse(website_url)
        base_domain = parsed_base.netloc
    except Exception:
        return []

    visited: set = set()
    queue: List[tuple] = [(website_url, 0)]
    pages: List[dict] = []

    headers = {'User-Agent': 'Mozilla/5.0 (compatible; ShowUPBot/1.0; +https://showuplocal.com)'}

    async with httpx.AsyncClient(follow_redirects=True, timeout=10.0, headers=headers) as client:
        while queue and len(pages) < max_pages:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            try:
                response = await client.get(url)
                if response.status_code != 200:
                    continue
                content_type = response.headers.get('content-type', '')
                if 'text/html' not in content_type:
                    continue

                html = response.text
                soup = BeautifulSoup(html, 'html.parser')

                title_tag = soup.find('title')
                title_text = title_tag.get_text(strip=True) if title_tag else ''
                h1_tag = soup.find('h1')
                h1_text = h1_tag.get_text(strip=True) if h1_tag else ''

                classification = classify_page_type(url, title_text, h1_text)
                pages.append({
                    'url': url,
                    'title': title_text[:200],
                    'h1': h1_text[:200],
                    'page_type': classification['type'],
                    'primary_service': classification['primary_service'],
                    'primary_city': classification['primary_city'],
                })

                if depth < max_depth:
                    for link in soup.find_all('a', href=True):
                        href = str(link['href']).strip()
                        if not href or href.startswith(('#', 'mailto:', 'tel:', 'javascript:')):
                            continue
                        full_url = urllib.parse.urljoin(url, href)
                        parsed = urllib.parse.urlparse(full_url)
                        if parsed.netloc != base_domain:
                            continue
                        if re.search(r'\.(pdf|jpg|jpeg|png|gif|css|js|ico|svg|xml|json|zip)$', parsed.path, re.I):
                            continue
                        clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
                        if clean_url and clean_url not in visited:
                            queue.append((clean_url, depth + 1))

            except Exception as e:
                logger.warning(f"Crawl error for {url}: {e}")
                continue

    logger.info(f"Crawled {len(pages)} pages from {website_url}")
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

        prompt = f"""Analyze this local service business and return a JSON object.

Business Name: {business_name}
GBP Primary Category: {gbp_category}
All GBP Categories: {', '.join(gbp_categories) if gbp_categories else 'N/A'}

Discovered website pages:
{pages_text}

Return a JSON object with exactly this structure:
{{
  "detected_icp": {{
    "primary": "<icp_type>",
    "confidence": <0.0-1.0>,
    "all": [{{"type": "<icp_type>", "confidence": <0.0-1.0>}}],
    "reasoning": "<1-2 sentences>"
  }},
  "differentiators": [
    {{"claim": "<specific claim>", "mechanism": "<how achieved>", "type": "<speed|cost|guarantee|specialization|availability|other>"}}
  ]
}}

ICP types: emergency_homeowner, general_homeowner, commercial, property_manager, vulnerable_homeowner, trade_contractor, landlord

Extract differentiators only from the page titles and H1s above. Look for speed claims, pricing models, guarantees, specializations. If none are evident, return an empty array.

Return only valid JSON, no markdown or explanation."""

        message = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{'role': 'user', 'content': prompt}],
        )

        result = json_lib.loads(message.content[0].text)
        return result

    except Exception as e:
        logger.warning(f"Anthropic analysis error: {e}")
        return {'detected_icp': None, 'differentiators': []}


@app.post('/analyze-business', response_model=BusinessAnalysisResponse)
async def analyze_business(request: BusinessAnalysisRequest):
    """
    Phase 1 business setup pipeline:
      1. Crawl the business website (up to 30 pages, 3 levels deep)
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
            timeout=45.0,
        )
    except asyncio.TimeoutError:
        logger.warning(f"Crawl timed out for {url}")
        pages = []

    llm_result = await analyze_business_with_anthropic(
        pages,
        request.business_name,
        request.gbp_category,
        request.gbp_categories,
    )

    status = 'complete' if pages else 'partial'

    return BusinessAnalysisResponse(
        existing_pages=pages,
        detected_icp=llm_result.get('detected_icp'),
        differentiators=llm_result.get('differentiators', []),
        pages_crawled=len(pages),
        analysis_status=status,
    )
