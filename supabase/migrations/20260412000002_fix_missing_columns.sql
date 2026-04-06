-- ── Add bonus_credits column to user_profiles ────────────────────────────────
-- Referenced by deduct_credits() and useCredits.ts but never added via migration.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS bonus_credits integer NOT NULL DEFAULT 0;

-- ── Unique constraint on generated_pages (business_id, keyword, location) ────
-- Prevents duplicate pages for the same business+keyword combo and enables
-- upsert patterns used in the frontend.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_pages_business_keyword_location
  ON public.generated_pages (business_id, keyword, location);
