ALTER TABLE public.keyword_analyses
ADD COLUMN IF NOT EXISTS serp_bold_keywords jsonb DEFAULT '[]'::jsonb;
