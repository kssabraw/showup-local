from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import re
from collections import Counter
from sklearn.feature_extraction.text import TfidfVectorizer
from keybert import KeyBERT
import nltk
from nltk.corpus import stopwords
from nltk.util import ngrams
from nltk.tokenize import word_tokenize

# Download required NLTK data on startup
nltk.download('stopwords', quiet=True)
nltk.download('punkt', quiet=True)
nltk.download('punkt_tab', quiet=True)

app = FastAPI()
kw_model = KeyBERT()
STOP_WORDS = set(stopwords.words('english'))


class AnalysisRequest(BaseModel):
    keyword: str
    pages: List[str]  # list of plain text strings, one per page


class AnalysisResponse(BaseModel):
    lsi_keywords: List[dict]
    related_keywords: List[dict]
    top_quadgrams: List[dict]


def clean_text(text: str) -> str:
    """Remove HTML tags, URLs, extra whitespace."""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'http\S+', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()


def get_lsi_keywords(pages: List[str], top_n: int = 30) -> List[dict]:
    """
    TF-IDF across all pages to find terms that are
    important to this topic but not generic stop words.
    Uses bigrams and trigrams as well as unigrams.
    """
    cleaned = [clean_text(p) for p in pages if p]

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words='english',
        max_features=500,
        min_df=2,          # must appear in at least 2 pages
        max_df=0.95        # ignore terms in 95%+ of pages (too generic)
    )

    try:
        tfidf_matrix = vectorizer.fit_transform(cleaned)
    except ValueError:
        return []

    import numpy as np
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
    KeyBERT extracts keyphrases most semantically similar
    to the seed keyword from across all page content.
    """
    combined = ' '.join([clean_text(p) for p in pages if p])

    # Truncate to avoid memory issues — 50k chars is plenty
    combined = combined[:50000]

    try:
        keywords = kw_model.extract_keywords(
            combined,
            keyphrase_ngram_range=(1, 3),
            stop_words='english',
            top_n=top_n,
            diversity=0.6,       # avoids near-duplicate terms
            use_mmr=True         # maximal marginal relevance for diversity
        )
    except Exception:
        return []

    return [
        {
            "term": kw,
            "score": round(score, 4),
            "type": "related"
        }
        for kw, score in keywords
    ]


def get_top_quadgrams(pages: List[str], top_n: int = 20) -> List[dict]:
    """
    Finds the most frequently used 4-word phrases (quadgrams)
    across all pages. These are the exact phrases Google sees
    repeated across top-ranking content — high signal for
    what language to use.
    """
    all_quadgrams = []

    for page in pages:
        text = clean_text(page)
        tokens = word_tokenize(text)

        # Remove stop words and short tokens
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
        if count >= 2  # must appear in more than one place
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
