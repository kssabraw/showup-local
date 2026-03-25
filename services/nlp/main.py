import sys
import os
import logging

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
    from typing import List, Dict
    import re
    from collections import Counter
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

logger.info("App initialized, ready to serve")

ZONES = ["title", "h1", "h2_h3", "body"]


class AnalysisRequest(BaseModel):
    keyword: str
    pages: List[str]


class ZoneKeywords(BaseModel):
    title: List[dict]
    h1: List[dict]
    h2_h3: List[dict]
    body: List[dict]


class AnalysisResponse(BaseModel):
    lsi_keywords: ZoneKeywords
    related_keywords: ZoneKeywords
    top_quadgrams: List[dict]


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

    # Body: everything else (strip scripts/styles/headings)
    for tag in soup(["script", "style", "noscript", "title", "h1", "h2", "h3"]):
        tag.decompose()
    body_text = soup.get_text(separator=" ", strip=True)

    return {
        "title": title_text,
        "h1": h1_text,
        "h2_h3": h2h3_text,
        "body": body_text,
    }


def clean_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'http\S+', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()


def get_lsi_keywords_for_zone(zone_docs: List[str], top_n: int = 30) -> List[dict]:
    """
    Returns the top TF-IDF terms actually present in this zone across competitor pages.
    Score = mean TF-IDF across all pages — no blending, no external weighting.
    """
    cleaned = [clean_text(d) for d in zone_docs if d and len(d.strip()) > 5]
    if len(cleaned) < 2:
        return []
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=500,
        min_df=2,
        max_df=0.95
    )
    try:
        tfidf_matrix = vectorizer.fit_transform(cleaned)
    except ValueError:
        return []
    feature_names = vectorizer.get_feature_names_out()
    mean_scores = tfidf_matrix.toarray().mean(axis=0)
    top_indices = mean_scores.argsort()[-top_n:][::-1]
    return [
        {"term": feature_names[i], "score": round(float(mean_scores[i]), 4), "type": "lsi"}
        for i in top_indices if mean_scores[i] > 0
    ]


def get_related_keywords_for_zone(zone_docs: List[str], keyword: str, top_n: int = 20) -> List[dict]:
    """
    Returns terms from this zone that are most semantically related to the target keyword.
    Score = pure cosine similarity between the keyword vector and each feature term
    in the zone's TF-IDF space. No blending with page frequency.
    """
    cleaned = [clean_text(d) for d in zone_docs if d and len(d.strip()) > 5]
    if not cleaned:
        return []
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=1000,
        min_df=1
    )
    try:
        # Include the keyword as a document so it lands in the same vector space
        tfidf_matrix = vectorizer.fit_transform(cleaned + [keyword])
    except ValueError:
        return []
    feature_names = vectorizer.get_feature_names_out()

    # Vector for the keyword document
    keyword_vec = np.asarray(tfidf_matrix[-1].todense())

    # Cosine similarity between the keyword and each individual feature term
    feature_matrix = np.eye(len(feature_names))
    similarities = cosine_similarity(keyword_vec, feature_matrix)[0]

    top_indices = similarities.argsort()[-top_n:][::-1]
    keyword_clean = clean_text(keyword)
    results = []
    for i in top_indices:
        term = feature_names[i]
        if term != keyword_clean and similarities[i] > 0:
            results.append({"term": term, "score": round(float(similarities[i]), 4), "type": "related"})
    return results[:top_n]


def get_top_quadgrams(pages: List[str], top_n: int = 20) -> List[dict]:
    all_quadgrams = []
    for page in pages:
        text = clean_text(page)
        tokens = word_tokenize(text)
        filtered = [t for t in tokens if t.isalpha() and t not in STOP_WORDS and len(t) > 2]
        page_quadgrams = list(ngrams(filtered, 4))
        all_quadgrams.extend(page_quadgrams)
    counter = Counter(all_quadgrams)
    top = counter.most_common(top_n)
    return [
        {"phrase": ' '.join(gram), "count": count, "type": "quadgram"}
        for gram, count in top if count >= 2
    ]


@app.post('/analyze', response_model=AnalysisResponse)
async def analyze(request: AnalysisRequest):
    if not request.pages:
        raise HTTPException(status_code=400, detail='No pages provided')

    pages = [p for p in request.pages if p and len(p.strip()) > 100]
    if len(pages) < 2:
        raise HTTPException(status_code=400, detail='Not enough valid pages to analyze')

    # Extract per-zone text from each page
    zone_buckets: Dict[str, List[str]] = {z: [] for z in ZONES}
    for page in pages:
        zones = extract_zones(page)
        for z in ZONES:
            zone_buckets[z].append(zones[z])

    # LSI keywords per zone
    lsi = ZoneKeywords(
        title=get_lsi_keywords_for_zone(zone_buckets["title"]),
        h1=get_lsi_keywords_for_zone(zone_buckets["h1"]),
        h2_h3=get_lsi_keywords_for_zone(zone_buckets["h2_h3"]),
        body=get_lsi_keywords_for_zone(zone_buckets["body"]),
    )

    # Related keywords per zone — pure cosine similarity, no blending
    related = ZoneKeywords(
        title=get_related_keywords_for_zone(zone_buckets["title"], request.keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], request.keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], request.keyword),
        body=get_related_keywords_for_zone(zone_buckets["body"], request.keyword),
    )

    # Quadgrams run on full page text
    quadgrams = get_top_quadgrams(pages)

    return AnalysisResponse(lsi_keywords=lsi, related_keywords=related, top_quadgrams=quadgrams)


@app.get('/health')
async def health():
    return {'status': 'ok'}
