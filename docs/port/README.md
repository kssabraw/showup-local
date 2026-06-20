# Brand Voice Engine — portable port

A self-contained port of ShowUP Local's brand voice pipeline. See
[`../BRAND_VOICE_PRD.md`](../BRAND_VOICE_PRD.md) for the full spec/behavior;
this directory is the working code.

## Files
- `brand_voice.py` — the entire engine (discovery, scraping, 3 LLM calls, render).
- `requirements.txt` — Python deps.

## Quick start

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
