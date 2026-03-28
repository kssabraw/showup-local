-- Add user_id to tie rows to authenticated users.
-- Nullable so existing rows are preserved and remain visible during transition.
ALTER TABLE public.business_profiles
  ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.keyword_analyses
  ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── business_profiles RLS ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow all access for now" ON public.business_profiles;

-- SELECT: own rows, or legacy rows (user_id IS NULL) for backward compat
CREATE POLICY "Users can read own business profiles"
  ON public.business_profiles FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

-- INSERT: must be the authenticated user
CREATE POLICY "Users can insert own business profiles"
  ON public.business_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- UPDATE: own rows, or legacy rows
CREATE POLICY "Users can update own business profiles"
  ON public.business_profiles FOR UPDATE
  USING (auth.uid() = user_id OR user_id IS NULL)
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- DELETE: own rows only
CREATE POLICY "Users can delete own business profiles"
  ON public.business_profiles FOR DELETE
  USING (auth.uid() = user_id);

-- ── keyword_analyses RLS ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow all access for now" ON public.keyword_analyses;

-- Access based on owning the parent business (inherited ownership)
CREATE POLICY "Users can access keyword analyses for own businesses"
  ON public.keyword_analyses FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.business_profiles bp
      WHERE bp.id = keyword_analyses.business_id
        AND (bp.user_id = auth.uid() OR bp.user_id IS NULL)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.business_profiles bp
      WHERE bp.id = keyword_analyses.business_id
        AND (bp.user_id = auth.uid() OR bp.user_id IS NULL)
    )
  );
