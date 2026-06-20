"""
Score My Page — portable, self-contained module.

Ported (with the cross-app glue removed) from ShowUP Local's services/nlp/main.py.
Scores a page 0–100 against 8 local-SEO engines: 7 scored by an LLM against a
rubric, 1 (serp_signal_coverage) scored deterministically in Python.

Drop into a FastAPI app and mount the router:

    from score_page import router as score_router
    app.include_router(score_router)            # exposes POST /score-page

Or call directly:

    resp = await run_score_page(ScorePageRequest(
        keyword="emergency plumber anaheim",
        location="Anaheim, California, United States",
        page_content=html,                       # or page_url=...
        business_name="Example Plumbing", gbp_category="Plumber",
        serp_analysis=serp_dict,                 # optional but recommended
    ))

Environment variables:
    ANTHROPIC_API_KEY   — required for rubric scoring
    SCRAPEOWL_API_KEY   — optional; only used to fetch page_url on bot-protected sites
    SCORE_MODEL         — optional override (default: claude-sonnet-4-6)

Dependencies: fastapi, httpx, beautifulsoup4, anthropic, pydantic

Notes:
  * Use a Sonnet-class model, NOT Haiku — Haiku was unreliable on the rubric.
  * serp_analysis is optional: without it the deterministic engine returns a
    neutral 50 and the rubric context is empty. Provide it (from your SERP
    pipeline) for accurate scoring. To run SERP analysis inline when missing,
    set SERP_ANALYSIS_PROVIDER (see below).
  * The rubric prompt mentions "local SEO" / service-business signals — edit if
    your vertical differs.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
SCRAPEOWL_API_KEY = os.environ.get("SCRAPEOWL_API_KEY", "")
SCRAPEOWL_ENDPOINT = "https://api.scrapeowl.com/v1/scrape"
SCORE_MODEL = os.environ.get("SCORE_MODEL", "claude-sonnet-4-6")

# Optional: a coroutine (keyword, location, location_code) -> serp_analysis dict.
# Set this from your SERP pipeline if you want inline analysis when the caller
# omits serp_analysis. Leave None to score without competitor data.
SERP_ANALYSIS_PROVIDER: Optional[Callable[[str, str, Optional[int]], Awaitable[dict]]] = None

# Sonnet pricing (USD per 1M tokens) for the cost estimate. Override as needed.
_MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
}

_ENGINE_WEIGHTS = {
    "organic_ranking":      0.10,
    "gbp_maps":             0.20,
    "entity_establishment": 0.10,
    "icp_alignment":        0.05,
    "aeo_llm_retrieval":    0.20,
    "geographic_legitimacy": 0.10,
    "nearme_intent":        0.10,
    "serp_signal_coverage": 0.15,   # deterministic — scored in Python, not the LLM
}

_ENGINE_LABELS = {
    "organic_ranking":       "Organic Ranking Engine",
    "gbp_maps":              "GBP / Maps Relevance Engine",
    "entity_establishment":  "Entity Establishment Engine",
    "icp_alignment":         "ICP Alignment Engine",
    "aeo_llm_retrieval":     "AEO / LLM Retrieval Engine",
    "geographic_legitimacy": "Geographic Legitimacy Engine",
    "nearme_intent":         "Hyperlocal / Near-Me Engine",
    "serp_signal_coverage":  "SERP Signal Coverage",
}


# ── Request / Response models ──────────────────────────────────────────────────
class ScorePageRequest(BaseModel):
    keyword: str
    location: str
    location_code: Optional[int] = None
    page_url: Optional[str] = None
    page_content: Optional[str] = None  # if omitted, fetched from page_url
    business_name: str
    gbp_category: str
    address: Optional[str] = None
    serp_analysis: Optional[dict] = None


class ScorePageResponse(BaseModel):
    composite_score: float
    composite_status: str
    engine_scores: dict
    deficiencies: List[dict]
    token_usage: dict
    serp_analysis: Optional[dict] = None   # populated when analysis was run inline
    analysis_cost: Optional[dict] = None


# ── Rubric prompt (verbatim) ────────────────────────────────────────────────────
_SCORE_SYSTEM_PROMPT = """You are an expert local SEO analyst. Score the provided page against all 7 engines below.

IMPORTANT: These 7 engines account for 85% of the composite score. The remaining 15% is
scored separately by a deterministic Python engine (SERP Signal Coverage) that checks
exact keyword/entity/quadgram presence per HTML zone. You do NOT score that engine —
focus only on the 7 below.

SCORING CRITERIA — score each engine 0–100:

1. organic_ranking (weight 10%): keyword in title + H1 + opening ¶; service/transactional tone (not blog); CTA + phone visible; clear service offering.

2. gbp_maps (weight 20%): exact city name present; service matches GBP category; brand+service+city entity triplet; NAP signals consistent; multiple service mentions.

3. entity_establishment (weight 10%): brand+service+city co-occurrence in ≥3 sections; sub-services mentioned; descriptive anchor text signals; topical depth.

4. icp_alignment (weight 5%): detect ICP from keyword modifier (emergency→urgent tone; commercial→B2B tone; general→professional/reliable); CTA tone matches ICP (e.g. emergency ICP requires urgency/fear-based CTA, not generic "call for a free estimate"); pain points addressed; emotional register of copy matches searcher intent.

5. aeo_llm_retrieval (weight 20%): answer-first formatting (direct claim before explanation); FAQ with 4–7 entries (penalise if fewer than 4 or more than 7), each opening with a direct yes/no or factual statement; question-format H3s where appropriate; each section ≤300 words; ≥1 bulleted list with outcome-first bullets; ≥1 numbered list for a process or steps; tables used where content is genuinely comparative (service tiers, response times, inclusions) — penalise only if comparative data is present but no table was used; specific operational facts (numbers, timeframes, named places) rather than generic filler.

6. geographic_legitimacy (weight 10%): city in title+H1+opening ¶; ≥2 neighborhood references in sentence context; ≥1 landmark reference; ≥3 zip codes in visible content; geo signals in ≥3 page sections.

7. nearme_intent (weight 10%): phone above fold; availability language in opening block ("available now", "same-day", "emergency response"); response time stated explicitly (e.g. "arrive within 2 hours", "respond in 15 minutes"); ≥2 neighborhood+service+availability blocks; ≥1 street reference; ≥2 proximity FAQs (availability/response/coverage/emergency).

Return ONLY valid JSON — no markdown, no explanation:
{
  "organic_ranking":       {"score": 0, "issues": [], "recommendations": []},
  "gbp_maps":              {"score": 0, "issues": [], "recommendations": []},
  "entity_establishment":  {"score": 0, "issues": [], "recommendations": []},
  "icp_alignment":         {"score": 0, "icp_detected": "", "issues": [], "recommendations": []},
  "aeo_llm_retrieval":     {"score": 0, "issues": [], "recommendations": []},
  "geographic_legitimacy": {"score": 0, "issues": [], "recommendations": []},
  "nearme_intent":         {"score": 0, "issues": [], "recommendations": []}
}

Be specific — reference actual content found (or missing) in the page."""


def _build_score_prompt(
    business_name: str, gbp_category: str, keyword: str, city: str,
    address: Optional[str], serp_ctx: str, page_text: str, html_structure: str = "",
) -> str:
    """Dynamic user-message portion of the scoring prompt."""
    structure_block = f"\n{html_structure}\n" if html_structure else ""
    return f"""CONTEXT
Business: {business_name}
Category: {gbp_category}
Keyword: {keyword}
City: {city}
Address: {address or "Not provided"}
{serp_ctx}{structure_block}
PAGE CONTENT (first 8,000 chars):
{page_text[:8000]}"""


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = _MODEL_PRICING.get(model, {"input": 3.00, "output": 15.00})
    return (input_tokens * p["input"] / 1_000_000) + (output_tokens * p["output"] / 1_000_000)


def _token_record(endpoint: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    cost = _calc_cost(model, input_tokens, output_tokens)
    logger.info(f"[tokens] {endpoint} model={model} in={input_tokens} out={output_tokens} cost=${cost:.5f}")
    return {
        "endpoint": endpoint, "model": model,
        "input_tokens": input_tokens, "output_tokens": output_tokens,
        "cost_usd": round(cost, 6),
    }


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
        logger.warning(f"_parse_claude_json: failed to parse JSON. Raw: {text[:300]}")
        return {}


def _detect_html_structure(page_html: str) -> str:
    """Plain-English summary of HTML structural elements present/missing (deterministic)."""
    soup = BeautifulSoup(page_html, "html.parser")
    uls = len(soup.find_all("ul"))
    ols = len(soup.find_all("ol"))
    tables = len(soup.find_all("table"))
    lines = ["HTML STRUCTURE FACTS (deterministic — do NOT override):"]
    lines.append(f"  • <ul> (bulleted lists): {uls} found" + (" ✓" if uls >= 1 else " ✗ MISSING"))
    lines.append(f"  • <ol> (numbered lists): {ols} found" + (" ✓" if ols >= 1 else " ✗ MISSING"))
    lines.append(f"  • <table> elements: {tables} found" + (" ✓" if tables >= 1 else " — not required unless content is comparative"))
    return "\n".join(lines)


def _serp_context(serp_analysis: Optional[dict]) -> str:
    """Render competitor signal data into the rubric prompt. Empty when no SERP data."""
    if not serp_analysis:
        return ""

    rk = serp_analysis.get("related_keywords", {})
    zt = serp_analysis.get("zone_targets", {})
    entities = serp_analysis.get("google_entities", [])
    quadgrams = serp_analysis.get("top_quadgrams", [])
    total_pages = len(serp_analysis.get("serp_urls", [])) or 10

    zone_labels = [
        ("title", "PAGE TITLE (<title> tag)"),
        ("h1", "H1 HEADING"),
        ("h2_h3", "H2/H3 SUBHEADINGS"),
        ("paragraphs", "PARAGRAPHS (<p> tags)"),
    ]
    top_entities = sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:15] if entities else []

    parts = ["""COMPETITOR SIGNAL DATA — match or exceed these targets in the corresponding zones:

NOTE: Related keywords and Google entities are two separate lists derived independently.
Related keywords come from TF-IDF analysis of competitor page text (topical relevance signal).
Google entities come from Google's Natural Language API (entity establishment signal).
There may be overlap — a term like "Anaheim" can appear on both lists. If it does,
using it once counts toward both the keyword target and the entity target for that zone."""]

    if top_entities:
        ent_items = [f"{e['name']} (×{e.get('recommended_mentions', 1)})" for e in top_entities]
        parts.append("\nGOOGLE ENTITIES — use these across the zones per the targets below:")
        parts.append(f"  {', '.join(ent_items)}")

    zone_display = {"title": "title tag", "h1": "H1", "h2_h3": "H2 and H3 headings", "paragraphs": "paragraphs"}

    for zone_key, zone_label in zone_labels:
        terms = rk.get(zone_key, [])[:20]
        zone_data = zt.get(zone_key, {})
        term_target = zone_data.get("target", 0)
        entity_target = zone_data.get("entity_target", 0)
        if not terms and not entity_target:
            continue
        parts.append(f"\n{zone_label}:")
        if term_target and terms:
            parts.append(f"  Use {term_target} of these keywords in the {zone_display[zone_key]}: {', '.join(t['term'] for t in terms)}")
        elif terms:
            parts.append(f"  Keywords (ranked by relevance): {', '.join(t['term'] for t in terms)}")
        if entity_target and top_entities:
            parts.append(f"  Use {entity_target} of the above entities in the {zone_display[zone_key]}")

    if quadgrams:
        parts.append("\nTOP COMPETITOR PHRASES (4-word phrases — use naturally in body):")
        parts.append(f"  {', '.join(q['phrase'] for q in quadgrams[:15])}")

    bold_kws = serp_analysis.get("serp_bold_keywords", [])
    if bold_kws:
        parts.append(
            "\nGOOGLE-BOLDED KEYWORDS — these are the exact terms Google highlights in SERP "
            "snippets for this query. Use each term at least as many times as the top competitor:"
        )
        for bk in bold_kws[:20]:
            parts.append(
                f"  \"{bk['term']}\" — use ≥{bk['recommended_mentions']}× "
                f"(top competitor: {bk['max_competitor_uses']}×, "
                f"appears on {bk['page_spread']}/{total_pages} pages)"
            )

    headings = serp_analysis.get("competitor_headings", [])
    if headings:
        h2s = [h for h in headings if h["type"] == "h2"]
        h3s = [h for h in headings if h["type"] == "h3"]
        parts.append("\nCOMPETITOR H2/H3 HEADINGS (scraped from top-ranking pages):")
        if h2s:
            parts.append("  H2s by frequency:")
            for h in h2s[:12]:
                parts.append(f"    \"{h['text']}\" ({h['page_count']} pages)")
        if h3s:
            parts.append("  H3s by frequency:")
            for h in h3s[:20]:
                parts.append(f"    \"{h['text']}\" ({h['page_count']} pages)")

    return "\n".join(parts)


def _compute_serp_signal_coverage(page_html: str, serp_analysis: Optional[dict]) -> dict:
    """Deterministically score keyword/entity/quadgram coverage per HTML zone (no LLM)."""
    if not serp_analysis:
        return {
            "score": 50,
            "issues": ["No SERP analysis available — signal coverage could not be measured."],
            "recommendations": ["Run a keyword analysis first to enable SERP signal coverage scoring."],
        }

    soup = BeautifulSoup(page_html, "html.parser")
    page_text_lower = soup.get_text(" ", strip=True).lower()

    title_el = soup.find("title")
    h1_el = soup.find("h1")
    p_text = " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all("p"))
    zones = {
        "title": title_el.get_text(" ", strip=True).lower() if title_el else page_text_lower[:300],
        "h1": h1_el.get_text(" ", strip=True).lower() if h1_el else "",
        "h2_h3": " ".join(el.get_text(" ", strip=True).lower() for el in soup.find_all(["h2", "h3"])),
        "paragraphs": p_text or page_text_lower,
    }

    rk = serp_analysis.get("related_keywords", {})
    zt = serp_analysis.get("zone_targets", {})
    entities = serp_analysis.get("google_entities", [])
    quadgrams = serp_analysis.get("top_quadgrams", [])

    issues: List[str] = []
    recommendations: List[str] = []
    zone_label_map = {"title": "title tag", "h1": "H1", "h2_h3": "H2/H3 headings", "paragraphs": "paragraphs"}

    # 1. Related keyword coverage per zone (30%)
    zone_scores: List[float] = []
    for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
        terms = rk.get(zone_key, [])[:12]
        target = zt.get(zone_key, {}).get("target", 0)
        if not terms or not target:
            continue
        zone_text = zones[zone_key]
        found = [t["term"] for t in terms if t["term"].lower() in zone_text]
        missing = [t["term"] for t in terms if t["term"].lower() not in zone_text]
        zone_scores.append(min(len(found) / max(target, 1), 1.0))
        gap = max(0, target - len(found))
        if gap > 0 and missing:
            zlabel = zone_label_map[zone_key]
            issues.append(f"{zlabel.capitalize()}: {len(found)}/{target} keyword targets met — missing: {', '.join(missing[:5])}")
            recommendations.append(f"Add {gap} more keyword{'s' if gap > 1 else ''} to {zlabel}: {', '.join(missing[:5])}")
    kw_score = (sum(zone_scores) / len(zone_scores) * 100) if zone_scores else 50.0

    # 2. Google NLP entity coverage per zone (50%)
    top_entities = sorted(entities, key=lambda e: e.get("page_spread", 0), reverse=True)[:15]
    ent_zone_scores: List[float] = []
    if top_entities:
        for zone_key in ("title", "h1", "h2_h3", "paragraphs"):
            entity_target = zt.get(zone_key, {}).get("entity_target", 0)
            if not entity_target:
                continue
            zone_text = zones[zone_key]
            found_ents = [e["name"] for e in top_entities if e["name"].lower() in zone_text]
            missing_ents = [e["name"] for e in top_entities if e["name"].lower() not in zone_text]
            ent_zone_scores.append(min(len(found_ents) / max(entity_target, 1), 1.0))
            gap = max(0, entity_target - len(found_ents))
            if gap > 0 and missing_ents:
                zlabel = zone_label_map[zone_key]
                issues.append(f"{zlabel.capitalize()}: {len(found_ents)}/{entity_target} entity targets met — missing: {', '.join(missing_ents[:5])}")
                recommendations.append(f"Add {gap} more {'entity' if gap == 1 else 'entities'} to {zlabel}: {', '.join(missing_ents[:5])}")
        ent_score = (sum(ent_zone_scores) / len(ent_zone_scores) * 100) if ent_zone_scores else 75.0
    else:
        ent_score = 75.0

    # 3. Quadgram coverage (20%)
    top_qg = quadgrams[:10]
    if top_qg:
        found_qg = [q["phrase"] for q in top_qg if q["phrase"].lower() in page_text_lower]
        missing_qg = [q["phrase"] for q in top_qg if q["phrase"].lower() not in page_text_lower]
        qg_score = (len(found_qg) / len(top_qg)) * 100
        if missing_qg:
            issues.append(f"Missing {len(missing_qg)}/{len(top_qg)} competitor phrases: {', '.join(missing_qg[:4])}")
            recommendations.append(f"Weave these competitor phrases into paragraph text: {', '.join(missing_qg[:4])}")
    else:
        qg_score = 75.0

    composite = round(kw_score * 0.30 + ent_score * 0.50 + qg_score * 0.20, 1)
    return {
        "score": composite,
        "issues": issues,
        "recommendations": recommendations,
        "keyword_coverage": round(kw_score, 1),
        "entity_coverage": round(ent_score, 1),
        "quadgram_coverage": round(qg_score, 1),
    }


def _composite_from_scores(scores: dict) -> tuple:
    composite = sum(scores[k]["score"] * w for k, w in _ENGINE_WEIGHTS.items() if k in scores)
    if composite >= 90:   status = "excellent"
    elif composite >= 80: status = "good"
    elif composite >= 70: status = "needs_improvement"
    elif composite >= 60: status = "below_standard"
    else:                 status = "fail"
    return round(composite, 1), status


def _build_deficiencies(scores: dict) -> List[dict]:
    out = []
    for key, label in _ENGINE_LABELS.items():
        eng = scores.get(key, {})
        if eng.get("score", 100) < 80:
            out.append({
                "engine": label,
                "engine_key": key,
                "score": eng.get("score", 0),
                "issues": eng.get("issues", []),
                "recommendations": eng.get("recommendations", []),
            })
    return out


# ── Page fetching ───────────────────────────────────────────────────────────────
async def _scrape_one(url: str, client: httpx.AsyncClient, render_js: bool = False) -> Optional[str]:
    """Fetch a page's HTML. Uses ScrapeOwl when SCRAPEOWL_API_KEY is set, else a plain GET."""
    if not SCRAPEOWL_API_KEY:
        try:
            resp = await client.get(url, timeout=20.0, follow_redirects=True)
            if resp.status_code != 200:
                return None
            html = resp.text or ""
            return html if len(html.strip()) >= 200 else None
        except Exception as e:
            logger.warning(f"Plain fetch error for {url}: {type(e).__name__}: {e}")
            return None
    try:
        payload: dict = {"api_key": SCRAPEOWL_API_KEY, "url": url, "premium_proxies": True, "country": "us", "json_response": True}
        if render_js:
            payload["render_js"] = True
            payload["wait_for_selector"] = "body"
        response = await client.post(SCRAPEOWL_ENDPOINT, content=json.dumps(payload), headers={"Content-Type": "application/json"}, timeout=45.0)
        if response.status_code != 200:
            return None
        html = response.json().get("html") or ""
        return html if len(html.strip()) >= 200 else None
    except Exception as e:
        logger.warning(f"Scrape error for {url} (render_js={render_js}): {type(e).__name__}: {e}")
        return None


# ── Orchestration ───────────────────────────────────────────────────────────────
async def run_score_page(body: ScorePageRequest) -> ScorePageResponse:
    """Full scoring pipeline. Framework-agnostic."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

    # 1. SERP analysis — provided, run inline via hook, or skipped
    inline_ran = False
    serp_analysis_dict: Optional[dict] = body.serp_analysis
    if not serp_analysis_dict and SERP_ANALYSIS_PROVIDER is not None:
        try:
            serp_analysis_dict = await SERP_ANALYSIS_PROVIDER(body.keyword, body.location, body.location_code)
            inline_ran = True
        except Exception as e:
            logger.warning(f"score-page: inline SERP analysis failed ({e})")
            raise HTTPException(status_code=503, detail="Could not fetch competitor data. Please try again in a moment.")

    # 2. Page HTML
    page_html = body.page_content
    if not page_html and body.page_url:
        async with httpx.AsyncClient() as fc:
            page_html = await _scrape_one(body.page_url, fc, render_js=False)
            if not page_html:
                page_html = await _scrape_one(body.page_url, fc, render_js=True)
        if not page_html:
            raise HTTPException(status_code=422, detail="Could not fetch the provided page URL. Check that it is correct and publicly accessible.")
    if not page_html:
        raise HTTPException(status_code=422, detail="Either page_content or page_url is required")

    # 3. Prompt context
    html_structure = _detect_html_structure(page_html)
    page_text = BeautifulSoup(page_html, "html.parser").get_text(separator="\n", strip=True)
    city = body.location.split(",")[0].strip()
    serp_ctx = _serp_context(serp_analysis_dict)
    user_prompt = _build_score_prompt(body.business_name, body.gbp_category, body.keyword, city, body.address, serp_ctx, page_text, html_structure)

    # 4. LLM scoring (retry once on bad JSON)
    scores = None
    token_rec = None
    for attempt in range(2):
        try:
            msg = await client.messages.create(
                model=SCORE_MODEL,
                max_tokens=8192,
                system=[{"type": "text", "text": _SCORE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_prompt}],
            )
            token_rec = _token_record("score-page", SCORE_MODEL, msg.usage.input_tokens, msg.usage.output_tokens)
            parsed = _parse_claude_json(msg.content[0].text)
            if parsed:
                scores = parsed
                break
            logger.warning(f"score-page: invalid JSON on attempt {attempt + 1}")
        except Exception:
            logger.exception(f"Scoring error on attempt {attempt + 1}")
            if attempt == 1:
                raise HTTPException(status_code=502, detail="Scoring service temporarily unavailable. Please try again.")
    if not scores:
        raise HTTPException(status_code=502, detail="Scoring service returned an invalid response. Please try again.")

    # 5. Deterministic engine + composite
    scores["serp_signal_coverage"] = _compute_serp_signal_coverage(page_html, serp_analysis_dict)
    composite, status = _composite_from_scores(scores)

    return ScorePageResponse(
        composite_score=composite,
        composite_status=status,
        engine_scores=scores,
        deficiencies=_build_deficiencies(scores),
        token_usage=token_rec or {},
        serp_analysis=serp_analysis_dict if inline_ran else None,
        analysis_cost=None,
    )


# ── FastAPI router ──────────────────────────────────────────────────────────────
# Replace `_auth_dependency` with your app's auth (API key / JWT / credit check).
async def _auth_dependency() -> None:
    return None

router = APIRouter()


@router.post("/score-page", response_model=ScorePageResponse, dependencies=[Depends(_auth_dependency)])
async def score_page(request: Request, body: ScorePageRequest) -> ScorePageResponse:
    """
    Score a page against 8 local-SEO engines (7 LLM + 1 deterministic).

    To add rate limiting, wrap with slowapi (the original capped at 10/minute).
    """
    return await run_score_page(body)
