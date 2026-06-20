"""
Content Planning — portable, self-contained module.

Ported (with the cross-app glue removed) from ShowUP Local's services/nlp/main.py.
Given a seed keyword + location + business (with website), derives related
keywords (parents / siblings / neighbourhood-children) per a local-SEO
site-architecture SOP, checks which pages the site already has, and returns a
grouped "exists vs missing" gap report.

Drop into a FastAPI app and mount the router:

    from content_planning import router as planning_router
    app.include_router(planning_router)          # exposes POST /related-pages

Or call directly:

    resp = await run_related_pages(RelatedPagesRequest(
        keyword="tree service",
        location="Anaheim, California, United States",
        business_name="Example Tree Co", gbp_category="Tree service",
        website="https://example.com",
    ))
    for item in resp.items:
        print(item.group, item.status, item.keyword, item.url)

Environment variables:
    ANTHROPIC_API_KEY   — required for keyword derivation
    RELATED_MODEL       — optional override (default: claude-haiku-4-5-20251001)

Dependencies: fastapi, httpx, beautifulsoup4, lxml, anthropic, pydantic

Notes:
  * No scraping service needed — reads sitemap.xml / robots.txt and does light
    GETs of candidate pages (title/H1 only).
  * Without `website`, every derived keyword is returned as "missing".
  * The per-keyword rankability check (/check-rankability) is a separate
    DataForSEO-backed engine and is NOT included here — wire it separately if needed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.parse as _up
from typing import List, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
RELATED_MODEL = os.environ.get("RELATED_MODEL", "claude-haiku-4-5-20251001")

CRAWL_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ContentPlanningBot/1.0)"}

# Compact English stopword set (avoids an NLTK dependency).
STOP_WORDS = {
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "to", "in",
    "on", "at", "by", "for", "with", "about", "as", "into", "from", "up", "down",
    "out", "over", "under", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "we",
    "they", "them", "your", "our", "their", "my", "me", "do", "does", "did", "so",
    "not", "no", "yes", "can", "will", "would", "should", "could", "have", "has", "had",
}

# Business-descriptor words to strip from keyword tokens before page matching.
_BIZ_DESCRIPTORS = {
    "company", "companies", "contractor", "contractors", "professional", "professionals",
    "provider", "providers", "specialist", "specialists", "expert", "experts",
    "technician", "technicians", "team", "crew", "agency", "firm", "business",
    "near", "me", "best", "top", "trusted", "reliable", "affordable", "licensed",
    "certified", "local", "cheap", "fast",
}


# ── Request / Response models ──────────────────────────────────────────────────
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


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _token_record(endpoint: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    logger.info(f"[tokens] {endpoint} model={model} in={input_tokens} out={output_tokens}")
    return {"endpoint": endpoint, "model": model, "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": 0}


def _parse_claude_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        logger.warning(f"_parse_claude_json: failed to parse. Raw: {text[:300]}")
        return {}


async def _derive_related_keywords(keyword: str, location: str, haiku_client) -> tuple:
    """Derive parents/siblings/children related keywords per the site-architecture SOP."""
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
        model=RELATED_MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    token_rec = _token_record("related-pages/derive", RELATED_MODEL, response.usage.input_tokens, response.usage.output_tokens)
    result = _parse_claude_json(response.content[0].text)
    result["parents"] = result.get("parents", [])
    result["siblings"] = result.get("siblings", [])[:8]
    result["children"] = result.get("children", [])[:4]
    return result, token_rec


_BLOG_SEG = re.compile(
    r"/(blog|news|articles?|posts?|insights?|resources?|guides?|tips?|"
    r"updates?|press|media|events?|stories|announcements?|learn)(/|$)",
    re.IGNORECASE,
)
_BLOG_SLUG = re.compile(
    r"/\d{4}/\d{2}/|/\d{4}-\d{2}-\d{2}[-_]|"
    r"[/-](why|how|what|when|where|top-\d+|best-\d+|\d+-tips|\d+-ways|"
    r"everything-you-need|ultimate-guide|expert-tips|must-know|"
    r"beginners?-guide|complete-guide)-",
    re.IGNORECASE,
)


def _is_blog(u: str) -> bool:
    path = _up.urlparse(u).path
    return bool(_BLOG_SEG.search(path) or _BLOG_SLUG.search(path))


async def _find_page_for_keyword_reuse(kw: str, discovered_urls: List[str], client: httpx.AsyncClient) -> Optional[dict]:
    """Find an existing page matching kw among discovered URLs. Returns {url, title, h1, is_blog_post} or None."""
    kw_lower = kw.lower().strip()
    kw_words = [w for w in re.split(r"[\W_]+", kw_lower) if w and len(w) > 1 and w not in STOP_WORDS and w not in _BIZ_DESCRIPTORS]
    if not kw_words:
        kw_words = [w for w in re.split(r"[\W_]+", kw_lower) if w and len(w) > 1 and w not in STOP_WORDS]
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
        slug_words = set(re.split(r"[\W/_-]+", path))
        return sum(1 for w in kw_words if any(sw == w or sw.startswith(w) or w.startswith(sw) for sw in slug_words if len(sw) >= 3))

    async def _check(u: str) -> Optional[dict]:
        try:
            resp = await client.get(u, timeout=8.0)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, "html.parser")
            t = soup.find("title")
            h = soup.find("h1")
            title_text = t.get_text(strip=True) if t else ""
            h1_text = h.get_text(strip=True) if h else ""
            combined = set(re.split(r"[\W]+", f"{title_text} {h1_text}".lower()))
            if all(_kw_match_local(w, combined) for w in kw_words):
                return {"url": str(resp.url), "title": title_text or u, "h1": h1_text, "is_blog_post": _is_blog(u)}
        except Exception:
            pass
        return None

    scored = sorted(discovered_urls, key=_slug_score_local, reverse=True)[:20]
    results = await asyncio.gather(*[_check(u) for u in scored], return_exceptions=True)
    matches = [r for r in results if isinstance(r, dict) and r]
    matches.sort(key=lambda r: r.get("is_blog_post", False))  # non-blog first
    return matches[0] if matches else None


async def _discover_sitemap_urls(website: str, client: httpx.AsyncClient) -> List[str]:
    """Collect site URLs from sitemap.xml, falling back to a robots.txt Sitemap: directive."""
    base = website.strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"

    discovered: List[str] = []
    try:
        sm_resp = await client.get(f"{base}/sitemap.xml")
        if sm_resp.status_code == 200:
            soup_sm = BeautifulSoup(sm_resp.text, "xml")
            locs = [tag.get_text(strip=True) for tag in soup_sm.find_all("loc")]
            discovered = [u for u in locs if u.startswith("http")][:200]
    except Exception:
        pass

    if not discovered:
        try:
            robots_resp = await client.get(f"{base}/robots.txt")
            if robots_resp.status_code == 200:
                for line in robots_resp.text.splitlines():
                    if line.lower().startswith("sitemap:"):
                        sm_url = line.split(":", 1)[1].strip()
                        sm2 = await client.get(sm_url)
                        if sm2.status_code == 200:
                            soup2 = BeautifulSoup(sm2.text, "xml")
                            locs2 = [t.get_text(strip=True) for t in soup2.find_all("loc")]
                            discovered = [u for u in locs2 if u.startswith("http")][:200]
                            break
        except Exception:
            pass

    return discovered


# ── Orchestration ───────────────────────────────────────────────────────────────
async def run_related_pages(body: RelatedPagesRequest) -> RelatedPagesResponse:
    """Full content-planning pipeline. Framework-agnostic."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic

    haiku_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    # Step 1: derive related keywords
    related_kws, derive_tok = await _derive_related_keywords(body.keyword, body.location, haiku_client)
    all_keywords: List[tuple] = []
    for kw in related_kws.get("parents", []):
        all_keywords.append((kw, "parents"))
    for kw in related_kws.get("siblings", []):
        all_keywords.append((kw, "siblings"))
    for kw in related_kws.get("children", []):
        all_keywords.append((kw, "children"))

    # Step 2 + 3: discover URLs once, then match each keyword
    if body.website:
        async with httpx.AsyncClient(follow_redirects=True, headers=CRAWL_HEADERS, timeout=15.0) as http_client:
            discovered_urls = await _discover_sitemap_urls(body.website, http_client)

            async def _process_keyword(kw: str, group: str) -> RelatedPageItem:
                found = await _find_page_for_keyword_reuse(kw, discovered_urls, http_client)
                if found:
                    return RelatedPageItem(keyword=kw, group=group, status="found", url=found["url"], page_title=found.get("title"))
                return RelatedPageItem(keyword=kw, group=group, status="missing")

            results = await asyncio.gather(*[_process_keyword(kw, group) for kw, group in all_keywords], return_exceptions=True)
            items = [r for r in results if isinstance(r, RelatedPageItem)]
    else:
        items = [RelatedPageItem(keyword=kw, group=group, status="missing") for kw, group in all_keywords]

    token_rec = _token_record("related-pages", RELATED_MODEL, derive_tok.get("input_tokens", 0), derive_tok.get("output_tokens", 0))
    return RelatedPagesResponse(items=items, token_usage=token_rec)


# ── FastAPI router ──────────────────────────────────────────────────────────────
# Replace `_auth_dependency` with your app's auth (API key / JWT). No-op by default.
async def _auth_dependency() -> None:
    return None

router = APIRouter()


@router.post("/related-pages", response_model=RelatedPagesResponse, dependencies=[Depends(_auth_dependency)])
async def related_pages(request: Request, body: RelatedPagesRequest) -> RelatedPagesResponse:
    """
    Derive related keywords (parents/siblings/children) and check which pages the
    site already has — returning an exists/missing gap report.

    To add rate limiting, wrap with slowapi (the original capped at 5/minute).
    """
    return await run_related_pages(body)
