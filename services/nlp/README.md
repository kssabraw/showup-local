# NLP Microservice

Python FastAPI service for keyword analysis. Runs on Railway.
Called by the `run-keyword-analysis` Supabase Edge Function.

## What it does

- **LSI Keywords** — TF-IDF across all 20 scraped pages. Finds terms important to the topic that appear consistently across pages. Returns unigrams, bigrams, and trigrams with TF-IDF scores.
- **Related Keywords** — KeyBERT semantic extraction. Finds keyphrases most similar to the seed keyword using sentence embeddings. More semantically aware than TF-IDF.
- **Top Quadgrams** — Most frequently used 4-word phrases across all pages. These are the exact multi-word patterns Google sees repeated in top-ranking content.

## Local development

```bash
cd services/nlp
pip install -r requirements.txt
uvicorn main:app --reload
```

API available at: http://localhost:8000
Docs available at: http://localhost:8000/docs

## Deploy to Railway

```bash
# From the services/nlp directory
railway login
railway init
railway up
```

Set the PORT environment variable in Railway dashboard (Railway sets this automatically).

## API

### POST /analyze

Request:
```json
{
  "keyword": "plumber in anaheim",
  "pages": [
    "full text of page 1...",
    "full text of page 2..."
  ]
}
```

Response:
```json
{
  "lsi_keywords": [
    { "term": "drain cleaning", "score": 0.0842, "type": "lsi" },
    { "term": "water heater repair", "score": 0.0731, "type": "lsi" }
  ],
  "related_keywords": [
    { "term": "emergency plumbing service", "score": 0.7821, "type": "related" },
    { "term": "licensed plumber anaheim", "score": 0.7654, "type": "related" }
  ],
  "top_quadgrams": [
    { "phrase": "licensed insured plumbing service", "count": 8, "type": "quadgram" },
    { "phrase": "emergency plumbing anaheim available", "count": 6, "type": "quadgram" }
  ]
}
```

### GET /health

Returns `{ "status": "ok" }`. Used by Railway for health checks.

## Cost

Railway Starter plan: ~$5/month for a small always-on service.
No per-request cost — flat monthly.
