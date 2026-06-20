# ShowUP Local — portable ports

Self-contained ports of two ShowUP Local pipelines. See the matching PRDs for
full spec/behavior; this directory is the working code.

## Files
- `brand_voice.py` — Brand Voice engine (discovery, scraping, 3 LLM calls, render). PRD: [`../BRAND_VOICE_PRD.md`](../BRAND_VOICE_PRD.md)
- `icp_creator.py` — ICP Creator (page discovery + classification, 1 ICP LLM call, render). PRD: [`../ICP_CREATOR_PRD.md`](../ICP_CREATOR_PRD.md)
- `ClientDashboard.tsx` — React UI to view/edit Brand Voice + ICP per client. PRD: [`../CLIENT_DASHBOARD_PRD.md`](../CLIENT_DASHBOARD_PRD.md)
- `score_page.py` — Score My Page engine (7 LLM engines + 1 deterministic). PRD: [`../SCORE_MY_PAGE_PRD.md`](../SCORE_MY_PAGE_PRD.md)
- `PageScoreView.tsx` — React UI for the score breakdown + improve CTA. PRD: [`../SCORE_MY_PAGE_PRD.md`](../SCORE_MY_PAGE_PRD.md)
- `requirements.txt` — Python deps (shared by the backend modules).

## Score My Page quick start

```python
from fastapi import FastAPI
from score_page import router as score_router
app = FastAPI(); app.include_router(score_router)   # exposes POST /score-page
```
Or call it directly:
```python
from score_page import run_score_page, ScorePageRequest

resp = await run_score_page(ScorePageRequest(
    keyword="emergency plumber anaheim",
    location="Anaheim, California, United States",
    page_url="https://example.com/emergency-plumber",   # or page_content="<html>…"
    business_name="Example Plumbing", gbp_category="Plumber",
    serp_analysis=serp_dict,                              # optional but recommended
))
print(resp.composite_score, resp.composite_status, resp.deficiencies)
```

Frontend (`PageScoreView.tsx`) — inject an `api` adapter:
```tsx
import PageScoreView, { PageScoreApi } from "./PageScoreView";

const api: PageScoreApi = {
  scorePage: (input, signal) =>
    fetch(`${NLP}/score-page`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify(input), signal }).then((r) => r.json()),
  reoptimize: (deficiencies, signal) => runMyReoptimizer(deficiencies, signal),  // optional — omit to hide Improve CTA
};

<PageScoreView keyword={kw} location={loc} pageUrl={url} businessName={name} gbpCategory={cat} address={addr} serpAnalysis={serp} api={api} onBack={back} onCreateNew={createNew} />;
```

**Heads up (see PRD §1.4 / §2):** `serp_analysis` is optional — without it the
deterministic engine returns a neutral 50 and the rubric context is empty. Provide
it from your SERP pipeline (or set `SERP_ANALYSIS_PROVIDER` in `score_page.py` to
run it inline) for accurate scoring. Use a **Sonnet-class** model, not Haiku.

## Client Dashboard (frontend) quick start

`ClientDashboard.tsx` is a React + TypeScript component (deps: `react`,
`lucide-react`, Tailwind). It's backend-agnostic — you inject an `api` adapter
that wires its buttons to your analysis endpoints + persistence.

```tsx
import ClientDashboard, { ClientDashboardApi } from "./ClientDashboard";

const api: ClientDashboardApi = {
  runIcpAnalysis: (c) =>
    fetch(`${NLP}/analyze-business`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": KEY },
      body: JSON.stringify({
        website_url: c.website ?? undefined,
        business_name: c.business_name,
        gbp_category: c.gbp_category,
        gbp_categories: c.gbp_categories ?? [],
      }),
    }).then((r) => r.json()),

  scanBrandVoice: (c) =>
    fetch(`${NLP}/analyze-brand-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": KEY },
      body: JSON.stringify({
        website_url: c.website ?? undefined,
        business_name: c.business_name,
        gbp_category: c.gbp_category ?? "",
      }),
    }).then((r) => r.json()),

  saveClient: (id, patch) => db.update("clients", id, patch),   // your DB write
  refreshFromSource: (c) => fetchFromGBP(c.gbp_place_id),       // optional
};

<ClientDashboard
  client={client}
  api={api}
  onBack={() => navigate(-1)}
  onChange={(updated) => setClient(updated)}
  onError={(title, msg) => toast({ title, description: msg })}
/>;
```

The component returns the same response shapes the two Python modules produce, so
they slot together. The Tailwind classes use shadcn-style tokens (`bg-card`,
`text-accent`, …) — remap to your design system if you don't use shadcn.

> Both files are standalone and **duplicate** the shared page-discovery /
> classification / SSRF helpers so each can be dropped in on its own. If you use
> both, factor those helpers into a shared module to dedupe.

## ICP Creator quick start

```python
from fastapi import FastAPI
from icp_creator import router as icp_router
app = FastAPI(); app.include_router(icp_router)   # exposes POST /analyze-business
```
Or call it directly:
```python
from icp_creator import run_business_analysis, BusinessAnalysisRequest, build_icp_text, build_differentiators_text

resp = await run_business_analysis(BusinessAnalysisRequest(
    website_url="https://example.com", business_name="Example Plumbing",
    gbp_category="Plumber", gbp_categories=["Plumber", "Drainage service"],
))
detected_icp = resp.detected_icp            # persist on your business record
differentiators = resp.differentiators
icp_block = build_icp_text(detected_icp)    # prepend to your generator's prompt
diff_block = build_differentiators_text(differentiators)
```
**Heads up (see PRD §1.3):** shipped behavior analyzes pages by **URL only**
(title/h1 are blank). For better differentiators, implement the `_ENRICH_PAGES`
hook in `icp_creator.py` to fetch real titles/H1s before the LLM call.

---

## Brand Voice — files

## Brand Voice quick start

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
export SCRAPEOWL_API_KEY=...          # optional — see "Scraping" below
```

Mount the router in your FastAPI app:

```python
from fastapi import FastAPI
from brand_voice import router as brand_voice_router

app = FastAPI()
app.include_router(brand_voice_router)
```

Then `POST /analyze-brand-voice`:

```json
{ "website_url": "https://example.com", "business_name": "Example Plumbing", "gbp_category": "Plumber" }
```

Or call it directly without HTTP:

```python
from brand_voice import run_brand_voice_analysis, BrandVoiceRequest, build_brand_voice_text

resp = await run_brand_voice_analysis(BrandVoiceRequest(
    website_url="https://example.com", business_name="Example Plumbing", gbp_category="Plumber",
))
brand_voice = resp.brand_voice          # persist this JSON on your business record

# Later, when generating content:
voice_block = build_brand_voice_text(brand_voice)   # prepend to your generator's system prompt
```

## Configuration (env vars)
| Var | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — | The 3 analysis calls. Without it, analysis returns `{}`. |
| `SCRAPEOWL_API_KEY` | recommended | — | Premium-proxy scraping. |
| `USE_SCRAPEOWL` | no | `true` | Set `false` to use a plain `httpx` GET instead of ScrapeOwl. |
| `BRAND_VOICE_MODEL` | no | `claude-haiku-4-5-20251001` | Override the analysis model. |

## Scraping
The pipeline defaults to **ScrapeOwl** (residential/premium proxies + optional JS
rendering), which is what reliably gets text from Cloudflare/WAF-protected and
SPA/builder (Wix/Squarespace/Webflow) sites. Two tiers run automatically:
no-JS first, then a JS-render retry of the top 5 pages if the first tier returns
nothing.

If you don't have ScrapeOwl, set `USE_SCRAPEOWL=false` to fall back to a plain
HTTP GET. This works for simple/static sites but will fail on bot-protected or
JS-rendered ones — in which case the pipeline falls back to category-based
inference (still produces a recommended voice + guide, just no "current voice").

## Adapting it
- **Auth:** replace `_auth_dependency` in `brand_voice.py` with your app's API-key/JWT check.
- **Rate limit:** the original capped this at 5/min (3 LLM calls + ~25 scrapes is expensive). See the note in the `analyze_brand_voice` docstring for wiring `slowapi`.
- **Vertical:** the system prompts say "local service businesses." Edit them if your customers differ.
- **Persistence:** store `resp.brand_voice` as JSON on your business record. Let users edit `current_voice` and set `recommended_accepted` to `true`/`false`.
