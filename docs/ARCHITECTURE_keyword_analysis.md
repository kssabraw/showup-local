# Keyword Analysis Pipeline
> Purpose: Step-by-step implementation guide for SERP scraping, page scraping, Google NLP entity analysis, and Python NLP microservice.
> Decision: POP API not used — entity salience via Google NLP + LSI/related/quadgrams via Python microservice on Railway.

---

## Overview

```
User enters keyword
→ Check Supabase cache (keyword_analysis table)
→ If cached: return immediately (no API calls)
→ If not cached:
    → Edge Function: fetch-serp-data (DataForSEO)
    → Edge Function: scrape-pages (ScrapeOwl)
    → Edge Function: analyze-entities (Google NLP)
    → Python microservice on Railway (LSI + related keywords + quadgrams)
    → Store all results in keyword_analysis table
→ Pass enriched data to LLM generation prompt
```

---

## Cost Per Keyword Lookup

| Step | Cost |
|---|---|
| DataForSEO (20 results, live) | ~$0.04 |
| ScrapeOwl (20 pages) | ~$0.04–0.10 |
| Google NLP (5,000 chars × 20 pages) | ~$0.13 |
| Python microservice (Railway) | ~$5/month flat — no per-request cost |
| **Total per unique keyword** | **~$0.21–0.27 + flat $5/mo** |

With caching, each keyword is only analyzed once. Subsequent generations for the same keyword cost $0.

---

## Step 1: Supabase Secrets

Add to Supabase Dashboard → Edge Functions → Secrets:

```
DATAFORSEO_LOGIN
DATAFORSEO_PASSWORD
SCRAPEOWL_API_KEY
GOOGLE_NLP_API_KEY
NLP_SERVICE_URL        ← your Railway deployment URL
NLP_SERVICE_SECRET     ← a secret token you set to protect the endpoint
```

---

## Step 2: Database Table

```sql
create table keyword_analysis (
  id uuid primary key default gen_random_uuid(),
  keyword text not null unique,
  urls jsonb,
  paa jsonb,
  related_searches jsonb,
  entities jsonb,
  lsi_keywords jsonb,
  related_keywords jsonb,
  top_quadgrams jsonb,
  created_at timestamp default now()
);

create index on keyword_analysis (keyword);
```

---

## Step 3: Edge Function — fetch-serp-data

Fetches top 20 organic URLs + People Also Ask + Related Searches from DataForSEO.

```typescript
// supabase/functions/fetch-serp-data/index.ts

Deno.serve(async (req) => {
  const { keyword, location } = await req.json()

  const credentials = btoa(
    `${Deno.env.get('DATAFORSEO_LOGIN')}:${Deno.env.get('DATAFORSEO_PASSWORD')}`
  )

  const response = await fetch(
    'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{
        keyword,
        location_name: location || 'United States',
        language_name: 'English',
        depth: 20
      }])
    }
  )

  const data = await response.json()
  const result = data.tasks[0].result[0]

  const organicUrls = result.items
    .filter(item => item.type === 'organic')
    .slice(0, 20)
    .map(item => ({
      url: item.url,
      title: item.title,
      description: item.description,
      rank: item.rank_absolute
    }))

  const paaQuestions = result.items
    .filter(item => item.type === 'people_also_ask')
    .map(item => item.title)

  const relatedSearches = result.items
    .filter(item => item.type === 'related_searches')
    .flatMap(item => item.items?.map(s => s.title) || [])

  return new Response(JSON.stringify({
    urls: organicUrls,
    paa: paaQuestions,
    related_searches: relatedSearches
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
})
```

---

## Step 4: Edge Function — scrape-pages

Scrapes text + HTML + headings from each URL via ScrapeOwl. Runs in batches of 5.

```typescript
// supabase/functions/scrape-pages/index.ts

Deno.serve(async (req) => {
  const { urls } = await req.json()
  const apiKey = Deno.env.get('SCRAPEOWL_API_KEY')
  const results = []

  const batchSize = 5
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize)

    const batchResults = await Promise.all(
      batch.map(async ({ url }) => {
        try {
          const response = await fetch('https://api.scrapeowl.com/v1/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              url,
              render_js: false
            })
          })

          const data = await response.json()
          return {
            url,
            html: data.html,
            text: data.text,
            h1: extractTags(data.html, 'h1'),
            h2: extractTags(data.html, 'h2'),
            h3: extractTags(data.html, 'h3'),
            title: extractTags(data.html, 'title')
          }
        } catch (e) {
          return { url, error: true }
        }
      })
    )
    results.push(...batchResults)
  }

  return new Response(JSON.stringify({ pages: results }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

function extractTags(html: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'gis')
  const matches = []
  let match
  while ((match = regex.exec(html)) !== null) {
    matches.push(match[1].replace(/<[^>]*>/g, '').trim())
  }
  return matches
}
```

---

## Step 5: Edge Function — analyze-entities

Runs Google NLP entity analysis on each page. Aggregates salience scores and mention counts across all 20 pages. Returns top 30 entities ranked by importance (salience × frequency).

```typescript
// supabase/functions/analyze-entities/index.ts

Deno.serve(async (req) => {
  const { pages } = await req.json()
  const apiKey = Deno.env.get('GOOGLE_NLP_API_KEY')
  const entityMap = new Map()

  for (const page of pages) {
    if (page.error || !page.text) continue

    // Truncate to ~5000 chars to control cost (~$0.013 per page)
    const text = page.text.slice(0, 5000)

    const response = await fetch(
      `https://language.googleapis.com/v1/documents:analyzeEntities?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: { type: 'PLAIN_TEXT', content: text },
          encodingType: 'UTF8'
        })
      }
    )

    const data = await response.json()
    if (!data.entities) continue

    for (const entity of data.entities) {
      const name = entity.name.toLowerCase()
      if (!entityMap.has(name)) {
        entityMap.set(name, {
          name: entity.name,
          type: entity.type,
          salience_scores: [],
          mention_counts: [],
          wiki_url: entity.metadata?.wikipedia_url || null,
          page_count: 0
        })
      }

      const entry = entityMap.get(name)
      entry.salience_scores.push(entity.salience)
      entry.mention_counts.push(entity.mentions?.length || 1)
      entry.page_count++
    }
  }

  const totalPages = pages.filter(p => !p.error).length

  const entities = Array.from(entityMap.values())
    .map(e => ({
      name: e.name,
      type: e.type,
      avg_salience: average(e.salience_scores),
      avg_mentions: average(e.mention_counts),
      page_frequency_pct: Math.round((e.page_count / totalPages) * 100),
      wiki_url: e.wiki_url,
      importance: average(e.salience_scores) * (e.page_count / totalPages)
    }))
    .filter(e => e.page_frequency_pct >= 30)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 30)

  return new Response(JSON.stringify({ entities }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

function average(arr: number[]): number {
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000
}
```

---

## Step 6: Python Microservice (Railway)

See `services/nlp/` in this repo for the full code.

**What it returns:**

```json
{
  "lsi_keywords": [
    { "term": "drain cleaning", "score": 0.0842, "type": "lsi" },
    { "term": "water heater repair anaheim", "score": 0.0731, "type": "lsi" }
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

**Call it from your orchestrator Edge Function:**

```typescript
const nlpRes = await fetch(`${Deno.env.get('NLP_SERVICE_URL')}/analyze`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${Deno.env.get('NLP_SERVICE_SECRET')}`
  },
  body: JSON.stringify({
    keyword,
    pages: pageData.pages.map(p => p.text).filter(Boolean)
  })
})
const nlpData = await nlpRes.json()
```

**Deploy to Railway:**

```bash
cd services/nlp
railway login
railway init
railway up
```

Then copy the Railway URL into your Supabase secret as `NLP_SERVICE_URL`.

---

## Step 7: Orchestrator Edge Function — run-keyword-analysis

Calls all services in sequence, checks cache first, stores everything.

```typescript
// supabase/functions/run-keyword-analysis/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const { keyword, location } = await req.json()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Check cache
  const { data: cached } = await supabase
    .from('keyword_analysis')
    .select('*')
    .eq('keyword', keyword)
    .single()

  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const baseUrl = Deno.env.get('SUPABASE_URL') + '/functions/v1'
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
  }

  // 2. Fetch SERPs
  const serpRes = await fetch(`${baseUrl}/fetch-serp-data`, {
    method: 'POST', headers,
    body: JSON.stringify({ keyword, location })
  })
  const serpData = await serpRes.json()

  // 3. Scrape pages
  const scrapeRes = await fetch(`${baseUrl}/scrape-pages`, {
    method: 'POST', headers,
    body: JSON.stringify({ urls: serpData.urls })
  })
  const pageData = await scrapeRes.json()

  // 4. Analyze entities (Google NLP) + Python NLP — run in parallel
  const [entityRes, nlpRes] = await Promise.all([
    fetch(`${baseUrl}/analyze-entities`, {
      method: 'POST', headers,
      body: JSON.stringify({ pages: pageData.pages })
    }),
    fetch(`${Deno.env.get('NLP_SERVICE_URL')}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('NLP_SERVICE_SECRET')}`
      },
      body: JSON.stringify({
        keyword,
        pages: pageData.pages.map(p => p.text).filter(Boolean)
      })
    })
  ])

  const entityData = await entityRes.json()
  const nlpData = await nlpRes.json()

  // 5. Store everything in cache
  const result = {
    keyword,
    urls: serpData.urls,
    paa: serpData.paa,
    related_searches: serpData.related_searches,
    entities: entityData.entities,
    lsi_keywords: nlpData.lsi_keywords,
    related_keywords: nlpData.related_keywords,
    top_quadgrams: nlpData.top_quadgrams
  }

  await supabase.from('keyword_analysis').insert(result)

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  })
})
```

Note: entity analysis and Python NLP run in **parallel** (`Promise.all`) since they both only depend on the scraped pages — this saves several seconds of latency.

---

## Step 8: Using the Data in Your LLM Prompt

```typescript
const topEntities = analysisData.entities
  .slice(0, 10)
  .map(e => `${e.name} (salience: ${e.avg_salience}, ~${e.avg_mentions}x mentions)`)
  .join('\n')

const topLsi = analysisData.lsi_keywords
  .slice(0, 15)
  .map(k => k.term)
  .join(', ')

const topRelated = analysisData.related_keywords
  .slice(0, 10)
  .map(k => k.term)
  .join(', ')

const topQuadgrams = analysisData.top_quadgrams
  .slice(0, 10)
  .map(q => `"${q.phrase}" (used ${q.count}x)`)
  .join('\n')

const prompt = `
You are writing a local SEO page for: "${keyword}".

ENTITY PROMINENCE — mirror these salience levels in your content:
${topEntities}

LSI TERMS — weave these naturally into the content:
${topLsi}

RELATED KEYPHRASES — use these where contextually appropriate:
${topRelated}

HIGH-FREQUENCY PHRASES — these exact 4-word patterns appear repeatedly
across top-ranking pages. Use them naturally where relevant:
${topQuadgrams}

PEOPLE ALSO ASK — address every one of these in your FAQ:
${analysisData.paa.join('\n')}

[rest of generation prompt from SPEC.md]
`
```

---

## Deployment Checklist

```bash
# 1. Deploy Python microservice to Railway
cd services/nlp
railway login && railway init && railway up

# 2. Add Railway URL to Supabase secrets
supabase secrets set NLP_SERVICE_URL=https://your-service.railway.app
supabase secrets set NLP_SERVICE_SECRET=your_secret_token
supabase secrets set DATAFORSEO_LOGIN=your_login
supabase secrets set DATAFORSEO_PASSWORD=your_password
supabase secrets set SCRAPEOWL_API_KEY=your_key
supabase secrets set GOOGLE_NLP_API_KEY=your_key

# 3. Run the DB migration
# (paste Step 2 SQL into Supabase SQL editor)

# 4. Deploy Edge Functions
supabase functions deploy fetch-serp-data
supabase functions deploy scrape-pages
supabase functions deploy analyze-entities
supabase functions deploy run-keyword-analysis
```

---

## Key Decisions

- **No POP API** — Python TF-IDF + KeyBERT covers the same ground
- **Python on Railway** — can't run Python on Supabase; Railway is $5/month flat, no per-request cost
- **Entity analysis + Python NLP run in parallel** — saves latency since both only need scraped page text
- **5,000 char truncation** per page for Google NLP — controls cost, enough for entity detection
- **30% frequency filter** on entities — only include entities appearing in 30%+ of pages
- **render_js: false** in ScrapeOwl — faster and cheaper for text extraction
- **Cache by keyword** — each unique keyword analyzed once, results reused indefinitely
