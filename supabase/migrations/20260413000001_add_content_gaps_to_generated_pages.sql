-- Add content_gaps JSONB column to generated_pages
-- Stores an array of content gap objects produced by the generation pipeline,
-- listing facts that couldn't be included due to unverified business data.
ALTER TABLE public.generated_pages
  ADD COLUMN IF NOT EXISTS content_gaps jsonb DEFAULT '[]'::jsonb;
