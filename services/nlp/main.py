import sys
import os
import logging
import asyncio

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
STOP_WORDS = set(stopwords.words('english'))

# Google NLP API key — set GOOGLE_NLP_API_KEY in Railway environment variables
GOOGLE_NLP_API_KEY = os.environ.get("GOOGLE_NLP_API_KEY", "")
GOOGLE_NLP_ENDPOINT = "https://language.googleapis.com/v1/documents:analyzeEntities"

logger.info("App initialized, ready to serve")
if not GOOGLE_NLP_API_KEY:
    logger.warning("GOOGLE_NLP_API_KEY not set — Google entity analysis will be skipped")

ZONES = ["title", "h1", "h2_h3", "body"]

# Minimum fraction of pages a term must appear in to be considered signal
RELATED_MIN_PAGE_SPREAD = 0.49

# Minimum mean page-similarity score for a related keyword to be returned
RELATED_MIN_SIMILARITY = 0.1

# Minimum fraction of pages a quadgram must appear in to be considered signal
QUADGRAM_MIN_PAGE_SPREAD = 0.49

# Minimum cosine similarity to the target keyword for a quadgram to be returned
QUADGRAM_MIN_SIMILARITY = 0.1

# Minimum fraction of pages an entity must appear in
ENTITY_MIN_PAGE_SPREAD = 0.49

# Only return entities Google considers highly central to the content
ENTITY_MIN_SALIENCE = 0.40

# Google NLP API max content size (bytes)
GOOGLE_NLP_MAX_BYTES = 100_000


class AnalysisRequest(BaseModel):
    keyword: str
    pages: List[str]


class ZoneKeywords(BaseModel):
    title: List[dict]
    h1: List[dict]
    h2_h3: List[dict]
    body: List[dict]


class AnalysisResponse(BaseModel):
    related_keywords: ZoneKeywords
    top_quadgrams: List[dict]
    google_entities: List[dict]


def extract_zones(html: str) -> Dict[str, str]:
    """Parse HTML and return text extracted per zone."""
    soup = BeautifulSoup(html, "html.parser")

    # Title
    title_tag = soup.find("title")
    title_text = title_tag.get_text(separator=" ", strip=True) if title_tag else ""

    # H1
    h1_tags = soup.find_all("h1")
    h1_text = " ".join(t.get_text(separator=" ", strip=True) for t in h1_tags)

    # H2 + H3
    h2h3_tags = soup.find_all(["h2", "h3"])
    h2h3_text = " ".join(t.get_text(separator=" ", strip=True) for t in h2h3_tags)

    # Paragraphs: only <p> tags — clean prose content for quadgrams and entity analysis
    p_tags = soup.find_all("p")
    paragraph_text = " ".join(t.get_text(separator=" ", strip=True) for t in p_tags)

    # Body: everything else (strip scripts/styles/headings)
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


def get_related_keywords_for_zone(
    zone_docs: List[str],
    keyword: str,
    min_page_spread: float = RELATED_MIN_PAGE_SPREAD,
    min_similarity: float = RELATED_MIN_SIMILARITY,
) -> List[dict]:
    """
    Returns terms from this zone that are both:
      1. Present in >= 49% of competitor pages (page spread gate)
      2. Appearing on pages that are topically close to the keyword

    Scoring approach:
      - Fit TF-IDF on all zone docs
      - Compute cosine similarity of each page to the keyword vector
      - A term's score = mean keyword-similarity of pages that contain it
      - Drop terms below min_similarity threshold
      - Return all passing terms sorted by score, no fixed top N
    """
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


def get_top_quadgrams(
    paragraph_docs: List[str],
    keyword: str,
    min_page_spread: float = QUADGRAM_MIN_PAGE_SPREAD,
    min_similarity: float = QUADGRAM_MIN_SIMILARITY,
) -> List[dict]:
    """
    Extracts meaningful quadgrams from <p> tag content only.
    Filtered by page spread (>= 49%) and keyword cosine similarity.
    No fixed top N — returns everything that passes both filters.
    """
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
        all_texts = cleaned_docs + candidate_phrases + [keyword]
        tfidf_matrix = vectorizer.fit_transform(all_texts)
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


async def fetch_google_entities(text: str, client: httpx.AsyncClient) -> List[dict]:
    """
    Calls the Google Natural Language API analyzeEntities endpoint for a single
    document. Returns raw entity dicts including mention counts.
    Truncates to GOOGLE_NLP_MAX_BYTES. Returns [] on any error.
    """
    if not GOOGLE_NLP_API_KEY or not text.strip():
        return []

    encoded = text.encode("utf-8")[:GOOGLE_NLP_MAX_BYTES]
    safe_text = encoded.decode("utf-8", errors="ignore")

    payload = {
        "document": {"type": "PLAIN_TEXT", "content": safe_text},
        "encodingType": "UTF8",
    }
    try:
        response = await client.post(
            GOOGLE_NLP_ENDPOINT,
            params={"key": GOOGLE_NLP_API_KEY},
            json=payload,
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
    """
    Runs Google NLP entity analysis across all competitor paragraph texts.

    Filters:
      - mean_salience >= 0.40: only entities Google considers highly central
      - page spread >= 49%: must appear on majority of competitor pages

    recommended_mentions: the average number of times competitors mention this
    entity on pages where it appears — derived from the API's mentions array,
    which counts every occurrence in the document. This becomes the target
    mention count for your own page.

    All API calls run concurrently. Returns [] if API key is missing.
    Sorted by mean_salience descending.
    """
    if not GOOGLE_NLP_API_KEY:
        return []

    total_pages = len(paragraph_docs)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    # Concurrent API calls across all pages
    async with httpx.AsyncClient() as client:
        tasks = [fetch_google_entities(doc, client) for doc in paragraph_docs]
        per_page_entities = await asyncio.gather(*tasks)

    # Aggregate per entity: salience, mention counts, page spread
    # Key: (normalized_name, entity_type)
    entity_data: Dict[tuple, Dict] = defaultdict(lambda: {
        "saliences": [],
        "mention_counts": [],  # how many times entity was mentioned on each page
        "pages": set(),
    })

    for page_idx, entities in enumerate(per_page_entities):
        seen_this_page = set()
        for entity in entities:
            name = entity.get("name", "").strip()
            etype = entity.get("type", "UNKNOWN")
            salience = entity.get("salience", 0.0)
            # mentions is a list of occurrence objects — its length is the count
            mention_count = len(entity.get("mentions", []))

            if not name:
                continue

            key = (name.lower(), etype)
            if key not in seen_this_page:
                entity_data[key]["saliences"].append(salience)
                entity_data[key]["mention_counts"].append(mention_count)
                entity_data[key]["pages"].add(page_idx)
                entity_data[key]["name"] = name  # preserve original casing
                entity_data[key]["entity_type"] = etype
                seen_this_page.add(key)

    results = []
    for key, data in entity_data.items():
        page_count = len(data["pages"])

        # Page spread gate
        if page_count < min_pages_required:
            continue

        mean_salience = float(np.mean(data["saliences"]))

        # Salience gate — only highly central entities
        if mean_salience < min_salience:
            continue

        # Average mention count across pages where this entity appears
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


@app.post('/analyze', response_model=AnalysisResponse)
async def analyze(request: AnalysisRequest):
    if not request.pages:
        raise HTTPException(status_code=400, detail='No pages provided')

    pages = [p for p in request.pages if p and len(p.strip()) > 100]
    if len(pages) < 2:
        raise HTTPException(status_code=400, detail='Not enough valid pages to analyze')

    # Extract per-zone text from each page
    zone_buckets: Dict[str, List[str]] = {z: [] for z in ZONES + ["paragraphs"]}
    for page in pages:
        zones = extract_zones(page)
        for z in ZONES + ["paragraphs"]:
            zone_buckets[z].append(zones[z])

    # Related keywords per zone — page-similarity scoring + 49% spread gate
    related = ZoneKeywords(
        title=get_related_keywords_for_zone(zone_buckets["title"], request.keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], request.keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], request.keyword),
        body=get_related_keywords_for_zone(zone_buckets["body"], request.keyword),
    )

    # Quadgrams: <p> tag text only, filtered by page spread + keyword similarity
    quadgrams = get_top_quadgrams(zone_buckets["paragraphs"], request.keyword)

    # Google NLP entity analysis: concurrent calls, salience >= 0.40, spread >= 49%
    google_entities = await get_google_entities(zone_buckets["paragraphs"])

    return AnalysisResponse(
        related_keywords=related,
        top_quadgrams=quadgrams,
        google_entities=google_entities,
    )


@app.get('/health')
async def health():
    return {'status': 'ok'}
