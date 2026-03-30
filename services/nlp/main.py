import sys
import os
import logging
import asyncio
import base64
import json

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
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.security import APIKeyHeader
    from pydantic import BaseModel
    from typing import List, Dict, Optional
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    import re
    from collections import defaultdict
    from nltk.stem import PorterStemmer
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
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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
NLP_API_KEY          = os.environ.get("NLP_API_KEY", "")

# ── API key auth dependency ───────────────────────────────────────────────────
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Security(_api_key_header)):
    """Validates X-API-Key header. Skipped if NLP_API_KEY env var is not set."""
    if NLP_API_KEY and api_key != NLP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return api_key

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


# ── Service abbreviation / synonym expansion map ──────────────────────────────
# Keys: lowercase abbreviations/short-forms users type in keywords.
# Values: expanded terms that should ALSO match pages about that service.
# Covers the major local SEO niches: HVAC, plumbing, electrical, legal, medical,
# IT/MSP, roofing, automotive, marketing, real estate.
SERVICE_ABBREVIATION_MAP: Dict[str, List[str]] = {
    # HVAC / Climate control
    "ac":       ["air conditioning", "air conditioner", "cooling", "hvac"],
    "a/c":      ["air conditioning", "air conditioner", "cooling", "hvac"],
    "hvac":     ["air conditioning", "heating", "cooling", "furnace", "heat pump"],
    # Plumbing
    "hw":       ["hot water", "water heater"],
    # Electrical
    "ev":       ["electric vehicle", "ev charging", "electric car charger"],
    "led":      ["led lighting", "energy efficient lighting"],
    # IT / MSP
    "msp":      ["managed service provider", "managed services", "it support", "it services"],
    "it":       ["information technology", "tech support", "computer support", "it services"],
    "voip":     ["voip", "business phone", "hosted phone"],
    "cybersec": ["cybersecurity", "cyber security", "network security"],
    # Legal
    "dui":      ["drunk driving", "driving under the influence", "dwi"],
    "dwi":      ["drunk driving", "driving while intoxicated", "dui"],
    "pi":       ["personal injury", "accident attorney", "injury lawyer"],
    "ovi":      ["operating vehicle impaired", "drunk driving", "dui"],
    # Medical / Health
    "pt":       ["physical therapy", "physical therapist"],
    "ot":       ["occupational therapy", "occupational therapist"],
    "chiro":    ["chiropractor", "chiropractic"],
    "obgyn":    ["obgyn", "gynecologist", "obstetrics"],
    # Roofing / Solar
    "solar":    ["solar panel", "solar energy", "photovoltaic", "solar installation"],
    # Security
    "cctv":     ["security camera", "surveillance", "video surveillance"],
    # Marketing / Digital
    "seo":      ["search engine optimization", "seo services"],
    "ppc":      ["pay per click", "paid advertising", "google ads"],
    "smm":      ["social media marketing", "social media management"],
    "cro":      ["conversion rate optimization"],
    # Finance / Accounting
    "cpa":      ["certified public accountant", "accountant", "tax preparation"],
    "cfo":      ["chief financial officer", "financial consulting", "fractional cfo"],
    # Property / Real Estate
    "hoa":      ["homeowners association", "hoa management"],
    "re":       ["real estate", "realtor", "realty"],
    "pm":       ["property management", "property manager"],
    # Staffing
    "hr":       ["human resources", "hr services", "human resource"],
    # Auto
    "awd":      ["all wheel drive", "awd service"],
    "4wd":      ["four wheel drive", "4x4"],
}

NEAR_ME_SIGNALS = ["near me", "nearby", "near by", "closest", "open now", "open 24"]

# Singleton stemmer — created once at module load
try:
    _stemmer = PorterStemmer()
    logger.info("PorterStemmer initialised")
except Exception as e:
    logger.error(f"PorterStemmer init failed: {e}")
    raise

# In-process cache for Haiku abbreviation expansions (survives for the lifetime
# of the Railway process — cheap and avoids redundant API calls for common terms)
_haiku_expansion_cache: Dict[str, List[str]] = {}


def _is_likely_abbreviation(token: str) -> bool:
    """
    Returns True if a token looks like an industry abbreviation that Haiku
    should try to expand. Heuristics:
    - ≤ 4 chars (ac, msp, dui, pt, etc.)
    - Mixed alphanumeric like 4wd, b2b, b2c
    Already-known stopwords and city words are filtered before this is called.
    """
    if len(token) <= 4:
        return True
    if re.match(r'^[a-z0-9]+$', token) and any(c.isdigit() for c in token):
        return True
    return False


async def _haiku_expand_abbreviations(tokens: List[str]) -> Dict[str, List[str]]:
    """
    Sends a batch of suspected abbreviations to Claude Haiku and returns a
    dict mapping each token → up to 3 expanded forms (lowercase).
    Returns {} if ANTHROPIC_API_KEY is not set or call fails.
    Only non-empty lists are included for real abbreviations; complete words
    get an empty list which is then omitted from the returned dict.
    """
    if not tokens or not ANTHROPIC_API_KEY:
        return {}

    import anthropic
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    terms_str = ", ".join(f'"{t}"' for t in tokens)
    prompt = (
        "You are a local SEO specialist.\n"
        "The following terms were extracted from a local service keyword.\n"
        "For each term, if it looks like an industry abbreviation or short form, "
        "list up to 3 common full-form alternatives that would appear in a "
        "business's page titles, H1s, or URLs.\n"
        "If the term is already a complete, common English word (not an abbreviation), "
        "return an empty list for it.\n\n"
        f"Terms: {terms_str}\n\n"
        "Respond with ONLY valid JSON in this exact format:\n"
        '{"term1": ["expansion1", "expansion2"], "term2": [], ...}\n\n'
        "Examples:\n"
        '- "ac" → ["air conditioning", "air conditioner", "cooling"]\n'
        '- "msp" → ["managed service provider", "managed services", "it services"]\n'
        '- "dui" → ["drunk driving", "dui defense", "driving under the influence"]\n'
        '- "hvls" → ["high volume low speed fans", "industrial fans", "warehouse fans"]\n'
        '- "repair" → []  (already a complete word)\n'
        '- "plumber" → []  (already a complete word)'
    )

    try:
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        # Strip markdown code fences if Haiku wrapped the JSON
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        data = json.loads(raw)
        return {
            k.lower(): [str(x).lower() for x in v[:3]]
            for k, v in data.items()
            if isinstance(v, list) and v  # omit empty lists
        }
    except Exception as e:
        logger.warning(f"Haiku abbreviation expansion failed: {e}")
        return {}


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

    # Standard HTTP Basic Auth encoding — credentials come from Railway env vars,
    # not source code. Base64 is transport encoding, not encryption.
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
    # Step 1: get URLs
    if body.urls:
        urls = body.urls
        logger.info(f"Using {len(urls)} manually provided URLs")
    else:
        async with httpx.AsyncClient() as client:
            urls = await fetch_serp_urls(body.keyword, body.location, client)
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
        title=get_related_keywords_for_zone(zone_buckets["title"], body.keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], body.keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], body.keyword),
        body=get_related_keywords_for_zone(zone_buckets["body"], body.keyword),
    )
    quadgrams = get_top_quadgrams(zone_buckets["paragraphs"], body.keyword)
    google_entities = await get_google_entities(zone_buckets["paragraphs"])

    return AnalysisResponse(
        keyword=body.keyword,
        location=body.location,
        serp_urls=scraped_urls,
        related_keywords=related,
        top_quadgrams=quadgrams,
        google_entities=google_entities,
    )


@app.get('/health')
async def health():
    return {'status': 'ok'}


# ── Keyword classifier ────────────────────────────────────────────────────────

class ClassifyKeywordRequest(BaseModel):
    keyword: str
    location: str   # e.g. "Anaheim, California, United States"


class ClassifyKeywordResponse(BaseModel):
    intent: str                              # "local" | "service_only"
    city: str                                # lowercase city extracted from location
    raw_service_terms: List[str]             # tokens after city + stopword removal
    match_words: List[str]                   # single words — use \b word-boundary matching
    match_phrases: List[str]                 # multi-word phrases — use substring matching
    haiku_expansions: Dict[str, List[str]]   # unknown abbrevs → Haiku suggestions (need user confirmation)


@app.post('/classify-keyword', response_model=ClassifyKeywordResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("60/minute")
async def classify_keyword_endpoint(request: Request, body: ClassifyKeywordRequest):
    """
    Extracts service terms from a keyword and expands abbreviations/synonyms so
    the frontend can find matching pages regardless of how the page titles phrase
    the same concept (e.g. "AC" vs "Air Conditioning" vs "HVAC").

    Steps:
    1. Detect intent: local (city in keyword or proximity signal) vs service-only
    2. Tokenise keyword; identify and expand abbreviations before stopword removal
    3. For tokens in SERVICE_ABBREVIATION_MAP → expand immediately (no confirmation needed)
    4. For tokens that look like unknown abbreviations → ask Haiku (cached), return in
       haiku_expansions so frontend can confirm/edit before applying
    5. Porter-stem known terms and collect single-word + multi-word phrase buckets
    """
    kw = body.keyword.lower().strip()
    city = body.location.split(",")[0].strip().lower()
    city_words = [w for w in city.split() if w]

    # Intent detection
    city_in_kw = any(
        re.search(r'\b' + re.escape(w) + r'\b', kw)
        for w in city_words if len(w) > 2
    )
    proximity = any(s in kw for s in NEAR_ME_SIGNALS)
    intent = "local" if (city_in_kw or proximity) else "service_only"

    city_word_set = set(city_words)

    # Tokenise: keep letters, digits, slashes (for "a/c")
    tokens = re.findall(r'[a-z][a-z0-9/]*', kw)

    raw_service_terms: List[str] = []
    abbrev_expanded_words: List[str] = []
    abbrev_expanded_phrases: List[str] = []
    unknown_abbrev_candidates: List[str] = []   # go to Haiku

    for tok in tokens:
        if tok in city_word_set:
            continue
        if tok in SERVICE_ABBREVIATION_MAP:
            raw_service_terms.append(tok)
            for exp in SERVICE_ABBREVIATION_MAP[tok]:
                if " " in exp:
                    abbrev_expanded_phrases.append(exp)
                else:
                    abbrev_expanded_words.append(exp)
        elif tok not in STOP_WORDS:
            raw_service_terms.append(tok)
            if _is_likely_abbreviation(tok):
                unknown_abbrev_candidates.append(tok)

    # Build match_words + match_phrases from known terms (static map + stems)
    match_words_set: set = set()
    for term in raw_service_terms + abbrev_expanded_words:
        match_words_set.add(term)
        stemmed = _stemmer.stem(term)
        if len(stemmed) >= 3:
            match_words_set.add(stemmed)

    match_phrases_set: set = set(abbrev_expanded_phrases)

    # Haiku expansion for unknown abbreviation candidates
    # Check cache first; only call Haiku for tokens we haven't seen before
    haiku_expansions: Dict[str, List[str]] = {}
    uncached = [t for t in unknown_abbrev_candidates if t not in _haiku_expansion_cache]
    if uncached:
        new_expansions = await _haiku_expand_abbreviations(uncached)
        _haiku_expansion_cache.update({t: new_expansions.get(t, []) for t in uncached})

    for tok in unknown_abbrev_candidates:
        cached = _haiku_expansion_cache.get(tok, [])
        if cached:
            haiku_expansions[tok] = cached

    return ClassifyKeywordResponse(
        intent=intent,
        city=city,
        raw_service_terms=raw_service_terms,
        match_words=sorted(match_words_set),
        match_phrases=sorted(match_phrases_set),
        haiku_expansions=haiku_expansions,
    )


# ── Existing page scorer ──────────────────────────────────────────────────────

class ScorePageRequest(BaseModel):
    url: str
    keyword: str
    city: str       # Just the city name, e.g. "Anaheim"
    business_name: str = ""


class ScorePageResponse(BaseModel):
    url: str
    title: str
    h1: str
    word_count: int
    score: int      # 0–100
    keyword_in_title: bool
    city_in_title: bool
    keyword_in_h1: bool
    city_in_h1: bool
    keyword_mentions: int
    city_mentions: int
    has_phone: bool
    signals: List[dict]


def compute_page_score(html: str, keyword: str, city: str) -> dict:
    """
    Lightweight signal check for a single page.
    Returns a 0–100 score based on basic on-page SEO signals.
    Total possible: 100 pts.
    """
    zones = extract_zones(html)

    kw = keyword.lower().strip()
    cy = city.lower().strip()

    title  = zones["title"].lower()
    h1     = zones["h1"].lower()
    h2h3   = zones["h2_h3"].lower()
    body   = zones["body"].lower()

    word_count   = len(body.split())
    kw_in_title  = kw in title
    cy_in_title  = cy in title
    kw_in_h1     = kw in h1
    cy_in_h1     = cy in h1
    kw_in_h2h3   = kw in h2h3
    cy_in_h2h3   = cy in h2h3
    kw_mentions  = body.count(kw)
    cy_mentions  = body.count(cy)
    has_phone    = bool(re.search(r'\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', zones["body"]))
    has_h2h3     = len(h2h3.strip()) > 30

    score   = 0
    signals = []

    def sig(label: str, status: str, pts: int) -> int:
        signals.append({"signal": label, "status": status, "points": pts})
        return pts

    # Title (20 pts)
    score += sig("Keyword in title", "pass" if kw_in_title else "fail", 10 if kw_in_title else 0)
    score += sig("City in title",    "pass" if cy_in_title else "fail", 10 if cy_in_title else 0)

    # H1 (20 pts)
    score += sig("Keyword in H1", "pass" if kw_in_h1 else "fail", 10 if kw_in_h1 else 0)
    score += sig("City in H1",    "pass" if cy_in_h1 else "fail", 10 if cy_in_h1 else 0)

    # H2/H3 (10 pts)
    score += sig("Keyword in H2/H3", "pass" if kw_in_h2h3 else "fail", 5 if kw_in_h2h3 else 0)
    score += sig("City in H2/H3",    "pass" if cy_in_h2h3 else "fail", 5 if cy_in_h2h3 else 0)

    # Word count (15 pts)
    if word_count >= 1500:
        wc_pts, wc_status = 15, "pass"
    elif word_count >= 800:
        wc_pts, wc_status = 10, "partial"
    elif word_count >= 400:
        wc_pts, wc_status = 5, "partial"
    else:
        wc_pts, wc_status = 0, "fail"
    score += sig(f"Word count ({word_count:,} words)", wc_status, wc_pts)

    # City mentions (15 pts)
    if cy_mentions >= 5:
        cm_pts, cm_status = 15, "pass"
    elif cy_mentions >= 3:
        cm_pts, cm_status = 10, "partial"
    elif cy_mentions >= 1:
        cm_pts, cm_status = 5, "partial"
    else:
        cm_pts, cm_status = 0, "fail"
    score += sig(f"City mentions ({cy_mentions}×)", cm_status, cm_pts)

    # Keyword mentions (10 pts)
    if kw_mentions >= 3:
        km_pts, km_status = 10, "pass"
    elif kw_mentions >= 1:
        km_pts, km_status = 5, "partial"
    else:
        km_pts, km_status = 0, "fail"
    score += sig(f"Keyword mentions ({kw_mentions}×)", km_status, km_pts)

    # H2/H3 headings (5 pts)
    score += sig("H2/H3 headings present", "pass" if has_h2h3 else "fail", 5 if has_h2h3 else 0)

    # Phone number (5 pts)
    score += sig("Phone number present", "pass" if has_phone else "fail", 5 if has_phone else 0)

    return {
        "title":           zones["title"],
        "h1":              zones["h1"],
        "word_count":      word_count,
        "score":           score,
        "keyword_in_title": kw_in_title,
        "city_in_title":   cy_in_title,
        "keyword_in_h1":   kw_in_h1,
        "city_in_h1":      cy_in_h1,
        "keyword_mentions": kw_mentions,
        "city_mentions":   cy_mentions,
        "has_phone":       has_phone,
        "signals":         signals,
    }


@app.post('/score-existing-page', response_model=ScorePageResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("20/minute")
async def score_existing_page(request: Request, body: ScorePageRequest):
    """
    Scrapes one URL and returns a 0–100 on-page score against keyword + city.
    Used to evaluate the business's best existing city+service page before
    generating new content.
    """
    if not re.match(r'^https?://', body.url, re.I):
        raise HTTPException(status_code=422, detail="URL must start with http:// or https://")

    async with httpx.AsyncClient() as client:
        html = await scrape_url(body.url, client)

    if not html:
        raise HTTPException(status_code=502, detail="Could not fetch page — ScrapeOwl returned no content")

    result = compute_page_score(html, body.keyword, body.city)
    return ScorePageResponse(url=body.url, **result)


@app.post('/analyze-site-architecture', response_model=SiteArchitectureResponse, dependencies=[Depends(verify_api_key)])
@limiter.limit("20/minute")
async def analyze_site_architecture_endpoint(request: Request, body: SiteArchitectureRequest):
    """
    Evaluates a list of existing_pages records against the Site Architecture SOP.
    Returns URL structure issues, missing essential pages, page type summary,
    internal linking rules, and actionable recommendations.
    """
    result = analyze_site_architecture(body.pages)
    return SiteArchitectureResponse(**result)


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
    analysis_status: str            # "complete" | "partial" | "failed"
    site_architecture: Optional[dict] = None  # SOP audit result


class SiteArchitectureRequest(BaseModel):
    pages: List[dict]   # List of existing_page records from analyze-business


class SiteArchitectureResponse(BaseModel):
    missing_essential_pages: List[str]
    page_type_summary: dict
    total_pages_analyzed: int
    recommendations: List[dict]
    internal_linking_rules: dict


class BrandVoiceRequest(BaseModel):
    website_url: str
    business_name: str
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
# Media/press archive slugs — classified as 'media' type, distinct from blog
MEDIA_SLUGS = {
    'media', 'newsroom', 'press-room', 'press-releases', 'news-releases',
}

BLOG_SLUGS = {
    'blog','news','insights','articles','resources','resource','post','posts',
    'updates','press','events','case-studies','whitepapers','guides',
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

    # ── Media / press release pages ───────────────────────────────────────────
    if first in MEDIA_SLUGS or (len(segments) > 1 and segments[0] in MEDIA_SLUGS):
        return {'type': 'media', 'primary_service': None, 'primary_city': None}

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


# ── Site Architecture SOP — internal ruleset ──────────────────────────────────
# Source: Site Architecture, URL Structure, and Internal Linking SOP (Nov 2024)
# This encodes the agency SOP so every page analysis and site audit is SOP-aware.

# Essential pages every site must have per SOP
ESSENTIAL_PAGE_SLUGS: Dict[str, set] = {
    'about':   {'about', 'about-us', 'our-story', 'who-we-are', 'our-company', 'our-team'},
    'contact': {'contact', 'contact-us', 'get-in-touch', 'reach-us', 'get-a-quote'},
    'privacy': {'privacy', 'privacy-policy', 'terms', 'terms-of-service', 'legal'},
}

# Internal linking rules per page type.
# nav_footer = links required in site-wide navigation or footer.
# body       = links that must appear in the page body content.
INTERNAL_LINKING_RULES: Dict[str, Dict[str, List[str]]] = {
    'home': {
        'nav_footer': ['about', 'contact', 'privacy', 'top_level_service_pages',
                       'top_level_location_pages', 'areas_we_serve', 'blog'],
        'body':       ['each_service_page', 'each_location_page', 'contact'],
    },
    'about': {
        'nav_footer': ['home', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['bio_pages', 'areas_we_serve', 'top_level_service_page'],
    },
    'contact': {
        'nav_footer': ['home', 'about', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       [],
    },
    'service': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'areas_we_serve', 'blog'],
        'body':       ['subservices', 'contact', 'related_local_landing_pages', 'services_page'],
    },
    'location': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['neighborhood_pages', 'poi_pages', 'related_local_landing_pages',
                       'contact', 'areas_we_serve'],
    },
    'city_service': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['parent_location_page', 'relevant_service_page',
                       'relevant_subservice_page', 'contact'],
    },
    'subservice': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['parent_service_page', 'contact',
                       'related_hyper_specific_local_landing_pages'],
    },
    'neighborhood': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['parent_location_page', 'related_neighborhoods', 'related_poi',
                       'related_service'],
    },
    'blog': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'areas_we_serve', 'blog'],
        'body':       ['related_blog_posts_in_silo', 'related_service_or_subservice'],
    },
    'areas_we_serve': {
        'nav_footer': ['home', 'about', 'contact', 'privacy', 'top_level_service_pages',
                       'blog'],
        'body':       ['each_individual_location_page'],
    },
}


def check_url_sop_compliance(url: str, page_type: str) -> dict:
    """
    Validates a URL against the Site Architecture SOP rules for its detected page type.

    SOP URL structure expectations:
      service      → /service/               (root-level, NOT geo-targeted)
      location     → /location/              (root-level)
      city_service → /location/service/      (2 segments, location FIRST)
      blog         → /blog/post-name/        (nested under blog parent)

    Returns { compliant, issues, expected_url_pattern }
    """
    import urllib.parse
    path     = urllib.parse.urlparse(url).path.lower().rstrip('/')
    segments = [s for s in path.split('/') if s]
    depth    = len(segments)
    issues: List[str] = []
    expected_pattern: Optional[str] = None

    if page_type == 'city_service':
        expected_pattern = '/location/service/'
        if depth == 1:
            issues.append(
                "Local landing page at root level — SOP requires /location/service/ structure"
            )
        elif depth == 2:
            # Detect reversed order: /service/location/ instead of /location/service/
            seg0_words = set(re.split(r'[-_]', segments[0]))
            seg1_words = set(re.split(r'[-_]', segments[1]))
            seg0_is_service = bool(seg0_words & SERVICE_WORDS)
            seg1_has_geo    = bool(_STATE_ABBREV_PATTERN.search(segments[1]))
            if seg0_is_service and seg1_has_geo:
                issues.append(
                    "URL appears reversed — SOP requires /location/service/, not /service/location/"
                )
        # depth >= 3 → could be /location/service/subservice/ — acceptable per SOP

    elif page_type == 'service':
        expected_pattern = '/service/'
        # Service pages must NOT be geo-targeted in the URL
        if _STATE_ABBREV_PATTERN.search(path):
            issues.append(
                "Top-level service page URL contains a geo signal (state abbreviation) — "
                "SOP: service pages should not be geo-targeted; use /location/service/ for local pages"
            )
        if re.search(r'\b\d{5}\b', path):
            issues.append(
                "Top-level service page URL contains a zip code — service pages must not be geo-targeted"
            )
        if depth > 2:
            issues.append(
                f"Service page nested {depth} levels deep — SOP expects /service/ or /services/service/"
            )

    elif page_type == 'location':
        expected_pattern = '/location/'
        if depth > 2:
            issues.append(
                f"Location page nested {depth} levels deep — SOP expects /location/ at root level"
            )

    elif page_type == 'blog':
        expected_pattern = '/blog/post-name/'
        if depth == 1 and segments and segments[0] not in BLOG_SLUGS:
            issues.append(
                "Blog post at root level — SOP recommends nesting under /blog/post-name/"
            )

    return {
        'compliant':            len(issues) == 0,
        'issues':               issues,
        'expected_url_pattern': expected_pattern,
    }


def analyze_site_architecture(pages: List[dict]) -> dict:
    """
    Evaluates a list of existing_pages records against the Site Architecture SOP.

    Note: URL structure is intentionally NOT checked — client sites vary widely
    and the SOP URL patterns are the ideal, not a compliance requirement.

    Checks:
    - Missing essential pages (about, contact, privacy)
    - Presence of key page types (service, location, city_service)
    - Actionable recommendations based on page type gaps

    Returns a structured audit result included in business analysis responses.
    """
    import urllib.parse

    found_essential: set = set()
    page_type_counts: Dict[str, int] = {
        'service': 0, 'location': 0, 'city_service': 0,
        'blog': 0, 'media': 0, 'other': 0,
    }

    for page in pages:
        url       = page.get('url', '')
        page_type = page.get('page_type', 'other')

        page_type_counts[page_type] = page_type_counts.get(page_type, 0) + 1

        # Essential page detection via first URL path segment
        path     = urllib.parse.urlparse(url).path.lower().rstrip('/')
        segments = [s for s in path.split('/') if s]
        first    = segments[0] if segments else ''
        for essential, slugs in ESSENTIAL_PAGE_SLUGS.items():
            if first in slugs:
                found_essential.add(essential)

    missing_essential = [e for e in ESSENTIAL_PAGE_SLUGS if e not in found_essential]

    recommendations: List[dict] = []
    if missing_essential:
        recommendations.append({
            'priority': 'high',
            'type':     'missing_pages',
            'message':  (
                f"Missing essential pages: {', '.join(missing_essential)}. "
                "Every site should have About, Contact, and Privacy pages."
            ),
        })
    if page_type_counts['city_service'] == 0 and page_type_counts['location'] > 0:
        recommendations.append({
            'priority': 'medium',
            'type':     'missing_local_landing_pages',
            'message':  (
                "Location pages found but no city+service local landing pages detected. "
                "Create dedicated pages targeting each service+city combination."
            ),
        })
    if page_type_counts['service'] == 0 and page_type_counts['city_service'] > 0:
        recommendations.append({
            'priority': 'medium',
            'type':     'missing_service_pages',
            'message':  (
                "Local landing pages found but no top-level service pages detected. "
                "Add non-geo-targeted service pages to build topical authority."
            ),
        })
    if page_type_counts['location'] == 0 and page_type_counts['city_service'] > 0:
        recommendations.append({
            'priority': 'medium',
            'type':     'missing_location_pages',
            'message':  (
                "Local landing pages found but no top-level location pages detected. "
                "Add a dedicated page for each city served."
            ),
        })

    return {
        'missing_essential_pages': missing_essential,
        'page_type_summary':       page_type_counts,
        'total_pages_analyzed':    len(pages),
        'recommendations':         recommendations,
        'internal_linking_rules':  INTERNAL_LINKING_RULES,
    }


def _make_page_record(url: str, title: str = '', h1: str = '') -> dict:
    c = classify_page_type(url, title, h1)
    return {
        'url':             url,
        'title':           title[:200],
        'h1':              h1[:200],
        'page_type':       c['type'],
        'primary_service': c['primary_service'],
        'primary_city':    c['primary_city'],
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

Discovered website pages (URL-classified, may include misclassified blog/content pages):
{pages_text}

IMPORTANT: Before analyzing, mentally discard any pages that look like blog posts, articles, news, or general content (e.g. URLs with date patterns, long descriptive slugs, how-to or tips-style titles). Only use pages that represent actual services, locations, or core business offerings for your analysis.

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
@limiter.limit("20/minute")
async def analyze_business(request: Request, body: BusinessAnalysisRequest):
    """
    Phase 1 business setup pipeline:
      1. Sitemap-first page discovery (robots.txt → sitemap.xml → nav fallback)
      2. Classify each page as service / location / city_service / other
      3. Use Claude Haiku to detect ICP and extract differentiators
    """
    if not body.website_url:
        raise HTTPException(status_code=400, detail="website_url is required")

    # Normalize URL
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
        logger.error(f"Business Anthropic error for {url}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Our AI analysis service encountered an error. Please try again — if the problem continues, contact ShowUP support."
        )

    status = 'complete' if pages else 'partial'
    architecture = analyze_site_architecture(pages) if pages else None

    return BusinessAnalysisResponse(
        existing_pages=pages,
        detected_icp=llm_result.get('detected_icp'),
        differentiators=llm_result.get('differentiators', []),
        pages_crawled=len(pages),
        analysis_status=status,
        site_architecture=architecture,
    )


# ── Brand Voice ────────────────────────────────────────────────────────────────

async def _crawl_pages_for_brand_voice(website_url: str, client: httpx.AsyncClient, max_pages: int = 25) -> List[dict]:
    """
    Discover up to max_pages pages for brand voice analysis.
    Priority: home → about → top-level service → service → location/city_service → other
    Skips blog pages and admin/legal slugs.
    """
    import urllib.parse
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


async def analyze_brand_voice_with_anthropic(page_contents: List[str], business_name: str) -> dict:
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

    content_text = "\n\n---\n\n".join(page_contents) if page_contents else "(no content available)"

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

    # ── Call 1: Current voice (purely descriptive) ────────────────────────────
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

    # ── Call 3: Writer Execution Guide (based on recommended voice) ────────────
    prompt_guide = f"""Business: {business_name}
Recommended brand voice summary: {recommended_voice.get('tone', '')}
Personality: {', '.join(recommended_voice.get('personality', []))}

Website copy:
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
@limiter.limit("20/minute")
async def analyze_brand_voice(request: Request, body: BrandVoiceRequest):
    """
    Brand voice pipeline:
      1. Crawl up to 25 pages from the site (home → about → service → other)
      2. Fetch paragraph text from each page
      3. Send to Claude Haiku for brand voice extraction
    """
    if not body.website_url:
        raise HTTPException(status_code=400, detail="website_url is required")

    url = body.website_url.strip()
    if not url.startswith(('http://', 'https://')):
        url = f"https://{url}"

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=15.0,
        headers=CRAWL_HEADERS,
    ) as client:
        # Check homepage is reachable before doing anything else
        try:
            probe = await client.get(url, timeout=10.0)
            if probe.status_code >= 400:
                raise HTTPException(
                    status_code=422,
                    detail=f"Your website returned a {probe.status_code} error. Check that the URL is correct and the site is live."
                )
        except httpx.RequestError as e:
            logger.warning(f"Brand voice probe error for {url}: {type(e).__name__}: {e}")
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

    try:
        brand_voice = await analyze_brand_voice_with_anthropic(page_contents, body.business_name)
    except Exception as e:
        logger.error(f"Brand voice Anthropic error for {url}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Our AI analysis service encountered an error. Please try again — if the problem continues, contact ShowUP support."
        )

    return BrandVoiceResponse(brand_voice=brand_voice, pages_sampled=pages_sampled)
