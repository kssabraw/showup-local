from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import re
from collections import Counter
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
import nltk
from nltk.corpus import stopwords
from nltk.util import ngrams
from nltk.tokenize import word_tokenize

# Download required NLTK data on startup
nltk.download('stopwords', quiet=True)
nltk.download('punkt', quiet=True)
nltk.download('punkt_tab', quiet=True)

app = FastAPI()
STOP_WORDS = set(stopwords.words('english'))


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
    """
    TF-IDF across all pages — finds terms important to this
    topic that appear consistently across top-ranking pages.
    """
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
        {
            "term": feature_names[i],
            "score": round(float(mean_scores[i]), 4),
            "type": "lsi"
        }
        for i in top_indices
        if mean_scores[i] > 0
    ]


def get_related_keywords(pages: List[str], keyword: str, top_n: int = 20) -> List[dict]:
    """
    Finds keyphrases most similar to the seed keyword using
    TF-IDF cosine similarity — lightweight alternative to KeyBERT.
    """
    cleaned = [clean_text(p) for p in pages if p]
    combined = ' '.join(cleaned)[:50000]

    # Build candidate phrases from the combined text
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=1000,
        min_df=1
    )

    try:
        # Fit on pages + keyword so keyword is in the vocabulary
        all_docs = cleaned + [keyword]
        tfidf_matrix = vectorizer.fit_transform(all_docs)
    except ValueError:
        return []

    feature_names = vectorizer.get_feature_names_out()

    # Get keyword vector (last doc)
    keyword_vec = tfidf_matrix[-1]

    # Get mean page vector
    page_matrix = tfidf_matrix[:-1]
    mean_page_vec = page_matrix.mean(axis=0)

    # Find terms most similar to the keyword vector
    keyword_array = np.asarray(keyword_vec.todense())
    feature_matrix = np.eye(len(feature_names))

    similarities = cosine_similarity(keyword_array, feature_matrix)[0]

    # Also weight by page frequency
    page_mean = np.asarray(mean_page_vec).flatten()
    combined_score = similarities * 0.6 + (page_mean / (page_mean.max() + 1e-9)) * 0.4

    top_indices = combined_score.argsort()[-top_n:][::-1]

    # Filter out the keyword itself
    keyword_clean = clean_text(keyword)
    results = []
    for i in top_indices:
        term = feature_names[i]
        if term != keyword_clean and combined_score[i] > 0:
            results.append({
                "term": term,
                "score": round(float(combined_score[i]), 4),
                "type": "related"
            })

    return results[:top_n]


def get_top_quadgrams(pages: List[str], top_n: int = 20) -> List[dict]:
    """
    Most frequently used 4-word phrases across all pages.
    """
    all_quadgrams = []

    for page in pages:
        text = clean_text(page)
        tokens = word_tokenize(text)
        filtered = [
            t for t in tokens
            if t.isalpha()
            and t not in STOP_WORDS
            and len(t) > 2
        ]
        page_quadgrams = list(ngrams(filtered, 4))
        all_quadgrams.extend(page_quadgrams)

    counter = Counter(all_quadgrams)
    top = counter.most_common(top_n)

    return [
        {
            "phrase": ' '.join(gram),
            "count": count,
            "type": "quadgram"
        }
        for gram, count in top
        if count >= 2
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

    return AnalysisResponse(
        lsi_keywords=lsi,
        related_keywords=related,
        top_quadgrams=quadgrams
    )


@app.get('/health')
async def health():
    return {'status': 'ok'}
