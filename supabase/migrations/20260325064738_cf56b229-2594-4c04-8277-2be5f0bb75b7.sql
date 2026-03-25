CREATE TABLE public.keyword_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  location text NOT NULL,
  serp_urls jsonb DEFAULT '[]'::jsonb,
  related_keywords jsonb DEFAULT '{}'::jsonb,
  top_quadgrams jsonb DEFAULT '[]'::jsonb,
  google_entities jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, keyword, location)
);

ALTER TABLE public.keyword_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access for now" ON public.keyword_analyses
  FOR ALL TO public USING (true) WITH CHECK (true);