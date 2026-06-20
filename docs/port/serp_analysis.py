"""
SERP Analysis Pipeline — portable, self-contained module.

Ported (with the cross-app glue removed) from ShowUP Local's services/nlp/main.py.
Given a keyword + location, fetches top organic competitors (DataForSEO), scrapes
them (ScrapeOwl, hybrid no-JS → JS-render), and extracts the SEO signals that power
content generation and scoring: per-zone related keywords (TF-IDF), quadgrams,
Google NLP entities, SERP-bolded keywords, per-zone targets, and competitor
headings.

Drop into a FastAPI app and mount the router:

    from serp_analysis import router as serp_router
    app.include_router(serp_router)          # exposes POST /analyze

Or call directly (also usable as the SERP_ANALYSIS_PROVIDER hook in score_page.py):

    resp = await run_serp_analysis("emergency plumber anaheim",
                                   "Anaheim, California, United States")
    serp_dict = resp.model_dump()            # feed to scoring / generation

Environment variables:
    DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD   — organic SERP URLs (required unless `urls` passed)
    SCRAPEOWL_API_KEY                       — competitor HTML scraping (required)
    GOOGLE_NLP_API_KEY                      — entity analysis (optional; skipped if unset)

Dependencies: fastapi, httpx, beautifulsoup4, lxml, scikit-learn, nltk, numpy, pydantic
NLTK data required: stopwords, punkt, punkt_tab (downloaded on import).

Notes:
  * This is the most expensive operation (3 paid APIs) — CACHE results keyed on
    (keyword, location) and reuse for scoring + generation.
  * Providers are swappable: any source of organic URLs + any HTML scraper works;
    only fetch_serp_urls / _scrape_one need changing.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from collections import defaultdict
from typing import Dict, List, Optional

import httpx
import numpy as np
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

import nltk
from nltk.corpus import stopwords
from nltk.tokenize import word_tokenize
from nltk.util import ngrams

logger = logging.getLogger(__name__)

# NLTK data (no-op if already present)
for _pkg in ("stopwords", "punkt", "punkt_tab"):
    try:
        nltk.download(_pkg, quiet=True)
    except Exception as e:  # pragma: no cover
        logger.warning(f"NLTK download '{_pkg}' failed: {e}")

STOP_WORDS = set(stopwords.words("english"))

# ── Config ───────────────────────────────────────────────────────────────────
GOOGLE_NLP_API_KEY = os.environ.get("GOOGLE_NLP_API_KEY", "")
DATAFORSEO_LOGIN = os.environ.get("DATAFORSEO_LOGIN", "")
DATAFORSEO_PASSWORD = os.environ.get("DATAFORSEO_PASSWORD", "")
SCRAPEOWL_API_KEY = os.environ.get("SCRAPEOWL_API_KEY", "")

GOOGLE_NLP_ENDPOINT = "https://language.googleapis.com/v1/documents:analyzeEntities"
DATAFORSEO_ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
SCRAPEOWL_ENDPOINT = "https://api.scrapeowl.com/v1/scrape"

# ── Constants / tunables ──────────────────────────────────────────────────────
ZONES = ["title", "h1", "h2_h3", "paragraphs"]

RELATED_MIN_PAGE_SPREAD = 0.49
RELATED_MIN_SIMILARITY = 0.1
QUADGRAM_MIN_PAGE_SPREAD = 0.49
QUADGRAM_MIN_SIMILARITY = 0.1
ENTITY_MIN_PAGE_SPREAD = 0.49
ENTITY_MIN_SALIENCE = 0.40
GOOGLE_NLP_MAX_BYTES = 100_000
SERP_RESULT_COUNT = 20

# Cost estimates (USD)
COST_DATAFORSEO_PER_ANALYSIS = 0.0025
COST_SCRAPEOWL_PER_PAGE = 0.0075
COST_SCRAPEOWL_PER_PAGE_JS = 0.0150
COST_GOOGLE_NLP_PER_1K_CHARS = 0.001

# Domains to skip — directories, aggregators, social, video.
# Intentionally whitelisted: reddit.com, linkedin.com, facebook.com, quora.com
SKIP_DOMAINS = {
    "yelp.com", "yellowpages.com", "bbb.org", "angi.com", "thumbtack.com",
    "homeadvisor.com", "houzz.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "tiktok.com",
    "wikipedia.org", "amazon.com", "ebay.com",
    "angieslist.com", "nextdoor.com", "mapquest.com", "maps.google.com",
}


# ── Request / Response models ──────────────────────────────────────────────────
class AnalysisRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    urls: Optional[List[str]] = None


class ZoneKeywords(BaseModel):
    title: List[dict]
    h1: List[dict]
    h2_h3: List[dict]
    paragraphs: List[dict] = []


class AnalysisResponse(BaseModel):
    keyword: str
    location: str
    serp_urls: List[str]
    related_keywords: ZoneKeywords
    top_quadgrams: List[dict]
    google_entities: List[dict]
    serp_bold_keywords: List[dict] = []
    zone_targets: Dict[str, dict] = {}
    competitor_headings: List[dict] = []
    analysis_cost: dict = {}


# ── Step 1: DataForSEO — top organic URLs + bolded snippet terms ────────────────
async def fetch_serp_urls(keyword: str, location: str, client: httpx.AsyncClient, location_code: Optional[int] = None) -> tuple:
    """Returns (urls, bold_terms). Empty lists if DataForSEO creds are unset/errored."""
    if not DATAFORSEO_LOGIN or not DATAFORSEO_PASSWORD:
        logger.warning("DataForSEO credentials not set — skipping SERP fetch")
        return [], []

    credentials = base64.b64encode(f"{DATAFORSEO_LOGIN}:{DATAFORSEO_PASSWORD}".encode()).decode()
    loc_field = {"location_code": location_code} if location_code else {"location_name": location}
    payload = [{"keyword": keyword, **loc_field, "language_name": "English", "depth": SERP_RESULT_COUNT, "se_domain": "google.com"}]

    try:
        response = await client.post(
            DATAFORSEO_ENDPOINT,
            headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/json"},
            json=payload, timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

        urls: List[str] = []
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
                    if re.search(r"\.(pdf|docx?|xlsx?|pptx?|zip)$", url, re.I):
                        continue
                    domain = re.sub(r"^www\.", "", httpx.URL(url).host)
                    if any(domain == d or domain.endswith("." + d) for d in SKIP_DOMAINS):
                        continue
                    for hl in (item.get("highlighted") or []):
                        hl_clean = hl.strip().lower()
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


# ── Step 2: ScrapeOwl — fetch HTML (hybrid no-JS → JS-render) ───────────────────
async def _scrape_one(url: str, client: httpx.AsyncClient, render_js: bool = False) -> Optional[str]:
    """Single ScrapeOwl request. Returns None on failure / thin content."""
    try:
        payload: dict = {"api_key": SCRAPEOWL_API_KEY, "url": url, "premium_proxies": True, "country": "us", "json_response": True}
        if render_js:
            payload["render_js"] = True
            payload["wait_for_selector"] = "body"
        response = await client.post(SCRAPEOWL_ENDPOINT, content=json.dumps(payload), headers={"Content-Type": "application/json"}, timeout=45.0)
        if response.status_code != 200:
            logger.warning(f"ScrapeOwl HTTP {response.status_code} for {url}: {response.text[:200]}")
            return None
        html = response.json().get("html") or ""
        if len(html.strip()) < 200:
            logger.warning(f"Thin content ({len(html)} chars) for {url} (render_js={render_js})")
            return None
        return html
    except Exception as e:
        logger.warning(f"Scrape error for {url} (render_js={render_js}): {type(e).__name__}: {e}")
        return None


async def scrape_urls(urls: List[str]) -> tuple:
    """Hybrid two-pass scraper. Returns (pages, cost_info).

    NOTE: `pages` is the list of successful HTML strings in input order with
    failures dropped — it stays aligned with `urls` only when there are no
    failures. The caller zips serp_urls with pages (matching original behavior).
    """
    sem = asyncio.Semaphore(10)

    async def attempt(url: str, render_js: bool, client: httpx.AsyncClient) -> Optional[str]:
        async with sem:
            return await _scrape_one(url, client, render_js=render_js)

    async with httpx.AsyncClient() as client:
        pass1 = await asyncio.gather(*[attempt(url, False, client) for url in urls])
        failed_urls = [url for url, html in zip(urls, pass1) if not html]
        pass2: List[Optional[str]] = []
        if failed_urls:
            logger.info(f"Retrying {len(failed_urls)} failed URLs with JS rendering")
            pass2 = await asyncio.gather(*[attempt(url, True, client) for url in failed_urls])

    fail_iter = iter(pass2)
    merged: List[Optional[str]] = []
    for html in pass1:
        merged.append(html if html else next(fail_iter, None))

    pages = [html for html in merged if html]
    js_success = sum(1 for html in pass2 if html)
    no_js_success = len(pages) - js_success
    logger.info(f"Scraping complete: {len(pages)}/{len(urls)} pages (no-JS: {no_js_success}, JS: {js_success})")
    return pages, {"no_js_pages": no_js_success, "js_pages": js_success}


# ── Step 3: HTML parsing ─────────────────────────────────────────────────────────
def extract_zones(html: str) -> Dict:
    """Parse HTML → text per zone plus raw heading lists."""
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("title")
    title_text = title_tag.get_text(separator=" ", strip=True) if title_tag else ""
    h1_text = " ".join(t.get_text(separator=" ", strip=True) for t in soup.find_all("h1"))
    h2h3_text = " ".join(t.get_text(separator=" ", strip=True) for t in soup.find_all(["h2", "h3"]))
    h2_list = [t.get_text(separator=" ", strip=True) for t in soup.find_all("h2") if t.get_text(strip=True)]
    h3_list = [t.get_text(separator=" ", strip=True) for t in soup.find_all("h3") if t.get_text(strip=True)]
    paragraph_text = " ".join(t.get_text(separator=" ", strip=True) for t in soup.find_all("p"))

    for tag in soup(["script", "style", "noscript", "title", "h1", "h2", "h3"]):
        tag.decompose()
    body_text = soup.get_text(separator=" ", strip=True)

    return {
        "title": title_text, "h1": h1_text, "h2_h3": h2h3_text,
        "body": body_text, "paragraphs": paragraph_text,
        "h2_list": h2_list, "h3_list": h3_list,
    }


def clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


# ── Step 4: related keywords (TF-IDF + cosine) per zone ─────────────────────────
def get_related_keywords_for_zone(zone_docs: List[str], keyword: str, min_page_spread: float = RELATED_MIN_PAGE_SPREAD, min_similarity: float = RELATED_MIN_SIMILARITY) -> List[dict]:
    cleaned = [clean_text(d) for d in zone_docs if d and len(d.strip()) > 5]
    if len(cleaned) < 2:
        return []

    total_pages = len(cleaned)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    vectorizer = TfidfVectorizer(ngram_range=(1, 3), stop_words="english", max_features=1000, min_df=2, max_df=0.95)
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
                "term": term, "score": round(mean_sim, 4),
                "page_spread": page_count, "page_spread_pct": round(page_count / total_pages, 2),
                "type": "related",
            })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


# ── Step 4b: quadgrams ───────────────────────────────────────────────────────────
def get_top_quadgrams(paragraph_docs: List[str], keyword: str, min_page_spread: float = QUADGRAM_MIN_PAGE_SPREAD, min_similarity: float = QUADGRAM_MIN_SIMILARITY) -> List[dict]:
    total_pages = len(paragraph_docs)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    quadgram_pages: Dict[tuple, set] = defaultdict(set)
    for page_idx, doc in enumerate(paragraph_docs):
        tokens = word_tokenize(clean_text(doc))
        filtered = [t for t in tokens if t.isalpha() and t not in STOP_WORDS and len(t) > 2]
        seen_this_page = set()
        for gram in ngrams(filtered, 4):
            if gram not in seen_this_page:
                quadgram_pages[gram].add(page_idx)
                seen_this_page.add(gram)

    spread_qualified = {gram: pages for gram, pages in quadgram_pages.items() if len(pages) >= min_pages_required}
    if not spread_qualified:
        return []

    cleaned_docs = [clean_text(d) for d in paragraph_docs if d and len(d.strip()) > 5]
    if not cleaned_docs:
        return []

    candidate_phrases = [" ".join(gram) for gram in spread_qualified]
    try:
        vectorizer = TfidfVectorizer(ngram_range=(1, 4), stop_words="english", min_df=1)
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
                "phrase": " ".join(gram), "page_spread": len(pages),
                "page_spread_pct": round(len(pages) / total_pages, 2),
                "similarity_score": round(sim, 4), "type": "quadgram",
            })
    results.sort(key=lambda x: (x["page_spread"], x["similarity_score"]), reverse=True)
    return results


# ── Step 5: Google NLP entity analysis ───────────────────────────────────────────
async def fetch_google_entities(text: str, client: httpx.AsyncClient) -> List[dict]:
    if not GOOGLE_NLP_API_KEY or not text.strip():
        return []
    safe_text = text.encode("utf-8")[:GOOGLE_NLP_MAX_BYTES].decode("utf-8", errors="ignore")
    try:
        response = await client.post(
            GOOGLE_NLP_ENDPOINT, params={"key": GOOGLE_NLP_API_KEY},
            json={"document": {"type": "PLAIN_TEXT", "content": safe_text}, "encodingType": "UTF8"}, timeout=15.0,
        )
        response.raise_for_status()
        return response.json().get("entities", [])
    except Exception as e:
        logger.warning(f"Google NLP API error: {e}")
        return []


async def get_google_entities(paragraph_docs: List[str], min_page_spread: float = ENTITY_MIN_PAGE_SPREAD, min_salience: float = ENTITY_MIN_SALIENCE) -> List[dict]:
    if not GOOGLE_NLP_API_KEY:
        return []

    total_pages = len(paragraph_docs)
    min_pages_required = max(2, int(np.ceil(total_pages * min_page_spread)))

    async with httpx.AsyncClient() as client:
        per_page_entities = await asyncio.gather(*[fetch_google_entities(doc, client) for doc in paragraph_docs])

    entity_data: Dict[tuple, Dict] = defaultdict(lambda: {"saliences": [], "mention_counts": [], "pages": set()})
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
            "name": data["name"], "entity_type": data["entity_type"], "mid": data.get("mid", ""),
            "mean_salience": round(mean_salience, 4), "page_spread": page_count,
            "page_spread_pct": round(page_count / total_pages, 2),
            "recommended_mentions": max(1, recommended_mentions), "type": "google_entity",
        })
    results.sort(key=lambda x: x["mean_salience"], reverse=True)
    return results


# ── Step 6: per-zone targets (75th percentile competitor counts) ─────────────────
def compute_zone_targets(zone_buckets: Dict[str, List[str]], related: ZoneKeywords, google_entities: List[dict]) -> Dict[str, dict]:
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
        term_counts: list = []
        entity_counts: list = []
        for page_text in zone_buckets.get(zone_name, []):
            if not page_text:
                continue
            cleaned = clean_text(page_text)
            if term_set:
                term_counts.append(sum(1 for t in term_set if t in cleaned))
            if entity_names:
                entity_counts.append(sum(1 for e in entity_names if e in cleaned))
        targets[zone_name] = {"target": _p75(term_counts), "entity_target": _p75(entity_counts)}
    return targets


# ── Orchestration ───────────────────────────────────────────────────────────────
async def run_serp_analysis(keyword: str, location: str, location_code: Optional[int] = None, urls: Optional[List[str]] = None) -> AnalysisResponse:
    """Full pipeline: DataForSEO → ScrapeOwl → TF-IDF → quadgrams → Google NLP → aggregate."""
    # Step 1: URLs + bold terms
    bold_terms_from_serp: List[str] = []
    if urls:
        serp_urls = urls
        logger.info(f"Using {len(serp_urls)} manually provided URLs")
    else:
        async with httpx.AsyncClient() as client:
            serp_urls, bold_terms_from_serp = await fetch_serp_urls(keyword, location, client, location_code)
        if not serp_urls:
            raise HTTPException(status_code=502, detail="DataForSEO returned no usable URLs")

    # Step 2: scrape
    pages, scrape_cost_info = await scrape_urls(serp_urls)
    if len(pages) < 2:
        raise HTTPException(status_code=502, detail=f"Only {len(pages)} pages scraped successfully — need at least 2")

    # Step 3: parse zones
    zone_buckets: Dict[str, List[str]] = {z: [] for z in ZONES}
    h2_per_page: List[List[str]] = []
    h3_per_page: List[List[str]] = []
    scraped_urls: List[str] = []
    full_page_texts: List[str] = []
    for url, html in zip(serp_urls, pages):
        zones = extract_zones(html)
        for z in ZONES:
            zone_buckets[z].append(zones[z])
        h2_per_page.append(zones.get("h2_list", []))
        h3_per_page.append(zones.get("h3_list", []))
        scraped_urls.append(url)
        full_page_texts.append(" ".join(zones[z] for z in ("title", "h1", "h2_h3", "paragraphs") if zones.get(z)).lower())

    # Step 4: related keywords + quadgrams
    related = ZoneKeywords(
        title=get_related_keywords_for_zone(zone_buckets["title"], keyword),
        h1=get_related_keywords_for_zone(zone_buckets["h1"], keyword),
        h2_h3=get_related_keywords_for_zone(zone_buckets["h2_h3"], keyword),
        paragraphs=get_related_keywords_for_zone(zone_buckets["paragraphs"], keyword),
    )
    quadgrams = get_top_quadgrams(zone_buckets["paragraphs"], keyword)

    # Step 5: Google NLP entities
    google_entities: List[dict] = []
    nlp_chars = 0
    if GOOGLE_NLP_API_KEY:
        para_texts = [t for t in zone_buckets["paragraphs"] if len(t) > 100]
        if para_texts:
            try:
                google_entities = await get_google_entities(para_texts)
                nlp_chars = sum(min(len(t), GOOGLE_NLP_MAX_BYTES) for t in para_texts)
                logger.info(f"Google NLP: {len(google_entities)} entities from {len(para_texts)} pages")
            except Exception as e:
                logger.warning(f"Google NLP failed (non-fatal): {e}")

    # Step 6: SERP bold keywords
    serp_bold_keywords: List[dict] = []
    total_pages = len(scraped_urls)
    if bold_terms_from_serp and full_page_texts:
        min_bold_spread = max(2, int(np.ceil(total_pages * 0.30)))
        for term in bold_terms_from_serp:
            page_counts: List[int] = []
            pages_with_term = 0
            term_re = re.compile(r"\b" + re.escape(term) + r"\b", re.IGNORECASE)
            for page_text in full_page_texts:
                count = len(term_re.findall(page_text))
                page_counts.append(count)
                if count > 0:
                    pages_with_term += 1
            if pages_with_term < min_bold_spread:
                continue
            serp_bold_keywords.append({
                "term": term, "page_spread": pages_with_term,
                "page_spread_pct": round(pages_with_term / total_pages, 2),
                "max_competitor_uses": max(page_counts),
                "avg_uses": round(sum(page_counts) / len(page_counts), 1),
                "recommended_mentions": max(page_counts),
            })
        serp_bold_keywords.sort(key=lambda x: (-x["page_spread"], -x["max_competitor_uses"]))
        serp_bold_keywords = serp_bold_keywords[:25]

    # Zone targets + competitor headings
    zone_targets = compute_zone_targets(zone_buckets, related, google_entities)

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
            competitor_headings.append({"text": canonical[h_key], "type": tag_type, "page_count": count, "page_pct": round(count / total_pages, 2)})

    # Cost
    no_js_pages = scrape_cost_info["no_js_pages"]
    js_pages = scrape_cost_info["js_pages"]
    scrapeowl_cost = round(no_js_pages * COST_SCRAPEOWL_PER_PAGE + js_pages * COST_SCRAPEOWL_PER_PAGE_JS, 6)
    nlp_cost = round(nlp_chars / 1000 * COST_GOOGLE_NLP_PER_1K_CHARS, 6)
    analysis_cost = {
        "dataforseo": round(COST_DATAFORSEO_PER_ANALYSIS, 6),
        "scrapeowl_pages": len(scraped_urls), "scrapeowl_no_js_pages": no_js_pages, "scrapeowl_js_pages": js_pages,
        "scrapeowl": scrapeowl_cost, "google_nlp_chars": nlp_chars, "google_nlp": nlp_cost,
        "subtotal": round(COST_DATAFORSEO_PER_ANALYSIS + scrapeowl_cost + nlp_cost, 6),
    }

    return AnalysisResponse(
        keyword=keyword, location=location, serp_urls=scraped_urls,
        related_keywords=related, top_quadgrams=quadgrams, google_entities=google_entities,
        serp_bold_keywords=serp_bold_keywords, zone_targets=zone_targets,
        competitor_headings=competitor_headings, analysis_cost=analysis_cost,
    )


# ── FastAPI router ──────────────────────────────────────────────────────────────
# Replace `_auth_dependency` with your app's auth (API key / JWT). No-op by default.
async def _auth_dependency() -> None:
    return None

router = APIRouter()


@router.post("/analyze", response_model=AnalysisResponse, dependencies=[Depends(_auth_dependency)])
async def analyze(request: Request, body: AnalysisRequest) -> AnalysisResponse:
    """
    DataForSEO → ScrapeOwl → TF-IDF related keywords + quadgrams → Google entities.
    Pass `urls` to skip the DataForSEO SERP step (testing / override).

    To add rate limiting, wrap with slowapi (the original capped at 10/minute).
    """
    return await run_serp_analysis(body.keyword, body.location, body.location_code, body.urls)
