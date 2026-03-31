-- Add zone_targets column to keyword_analyses.
-- Shape: { title: {target: N}, h1: {target: N}, h2_h3: {target: N}, body: {target: N}, entities: {target: N} }
-- Each target is the highest term/entity count found across all competitor pages for that zone.

ALTER TABLE public.keyword_analyses
  ADD COLUMN IF NOT EXISTS zone_targets JSONB NOT NULL DEFAULT '{}';
