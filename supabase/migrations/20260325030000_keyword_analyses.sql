-- Stores the full NLP analysis result for a keyword + location + business.
-- Keyed on (business_id, keyword, location) so re-running the same keyword
-- upserts rather than creating duplicates, avoiding unnecessary API spend.

CREATE TABLE public.keyword_analyses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID        NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  keyword           TEXT        NOT NULL,
  location          TEXT        NOT NULL,

  -- The URLs that were actually scraped and analysed
  serp_urls         JSONB       NOT NULL DEFAULT '[]',

  -- Related keywords broken out by HTML zone
  -- Shape: { title: [...], h1: [...], h2_h3: [...], body: [...] }
  related_keywords  JSONB       NOT NULL DEFAULT '{}',

  -- 4-word phrases from <p> content, filtered by page spread + keyword similarity
  top_quadgrams     JSONB       NOT NULL DEFAULT '[]',

  -- Google NLP entities: salience >= 0.40, page spread >= 49%
  google_entities   JSONB       NOT NULL DEFAULT '[]',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upsert key: one analysis record per business + keyword + location
CREATE UNIQUE INDEX idx_keyword_analyses_business_keyword_location
  ON public.keyword_analyses (business_id, keyword, location);

-- Fast lookups by business
CREATE INDEX idx_keyword_analyses_business_id
  ON public.keyword_analyses (business_id);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_keyword_analyses_updated_at
  BEFORE UPDATE ON public.keyword_analyses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (permissive for now, matching business_profiles policy)
ALTER TABLE public.keyword_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access for now"
  ON public.keyword_analyses
  FOR ALL
  USING (true)
  WITH CHECK (true);
