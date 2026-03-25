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
    from typing import List
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


class AnalysisRequest(BaseModel):
    keyword: str
    pages: List[str]


class AnalysisResponse(BaseModel):
    lsi_keywords: List[dict]
    related_keywords: List[dict]
    top_quadgrams: List[dict]


def clean_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'http\S+', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()


def get_lsi_keywords(pages: List[str], top_n: int = 30) -> List[dict]:
    cleaned = [clean_text(p) for p in pages if p]
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


def get_related_keywords(pages: List[str], keyword: str, top_n: int = 20) -> List[dict]:
    cleaned = [clean_text(p) for p in pages if p]
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=1000,
        min_df=1
    )
    try:
        all_docs = cleaned + [keyword]
        tfidf_matrix = vectorizer.fit_transform(all_docs)
    except ValueError:
        return []
    feature_names = vectorizer.get_feature_names_out()
    keyword_vec = tfidf_matrix[-1]
    page_matrix = tfidf_matrix[:-1]
    mean_page_vec = page_matrix.mean(axis=0)
    keyword_array = np.asarray(keyword_vec.todense())
    feature_matrix = np.eye(len(feature_names))
    similarities = cosine_similarity(keyword_array, feature_matrix)[0]
    page_mean = np.asarray(mean_page_vec).flatten()
    combined_score = similarities * 0.6 + (page_mean / (page_mean.max() + 1e-9)) * 0.4
    top_indices = combined_score.argsort()[-top_n:][::-1]
    keyword_clean = clean_text(keyword)
    results = []
    for i in top_indices:
        term = feature_names[i]
        if term != keyword_clean and combined_score[i] > 0:
            results.append({"term": term, "score": round(float(combined_score[i]), 4), "type": "related"})
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
    lsi = get_lsi_keywords(pages)
    related = get_related_keywords(pages, request.keyword)
    quadgrams = get_top_quadgrams(pages)
    return AnalysisResponse(lsi_keywords=lsi, related_keywords=related, top_quadgrams=quadgrams)


@app.get('/health')
async def health():
    return {'status': 'ok'}
