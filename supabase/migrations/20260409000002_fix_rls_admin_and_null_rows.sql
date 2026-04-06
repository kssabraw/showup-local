-- ── Fix 7: Assign legacy user_id IS NULL rows to the admin ───────────────────
-- Rows created before auth was added have user_id IS NULL and are currently
-- readable by any authenticated user. Assign them to the first admin so the
-- data isn't lost, then we tighten the policies below.
UPDATE public.business_profiles
SET user_id = (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE user_id IS NULL
  AND (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1) IS NOT NULL;

UPDATE public.keyword_analyses
SET user_id = (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE user_id IS NULL
  AND (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1) IS NOT NULL;


-- ── Fix 7 + 9: Consolidate business_profiles RLS ──────────────────────────────
-- Drop all existing overlapping policies (from migrations 20260328 and 20260330)
-- and replace with clean, definitive policies that:
--   a) remove the user_id IS NULL exception for regular users (Fix 7)
--   b) use table lookup instead of JWT claim for admin checks (Fix 9)

DROP POLICY IF EXISTS "Users can read own business profiles"      ON public.business_profiles;
DROP POLICY IF EXISTS "Users can insert own business profiles"    ON public.business_profiles;
DROP POLICY IF EXISTS "Users can update own business profiles"    ON public.business_profiles;
DROP POLICY IF EXISTS "Users can delete own business profiles"    ON public.business_profiles;
DROP POLICY IF EXISTS "Users can manage own business profiles"    ON public.business_profiles;

CREATE POLICY "bp_select"
  ON public.business_profiles FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "bp_insert"
  ON public.business_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bp_update"
  ON public.business_profiles FOR UPDATE
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "bp_delete"
  ON public.business_profiles FOR DELETE
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );


-- ── Fix 7 + 9: Consolidate keyword_analyses RLS ───────────────────────────────
DROP POLICY IF EXISTS "Users can access keyword analyses for own businesses" ON public.keyword_analyses;
DROP POLICY IF EXISTS "Users can manage own keyword analyses"                ON public.keyword_analyses;

CREATE POLICY "ka_all"
  ON public.keyword_analyses FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.business_profiles bp
      WHERE bp.id = keyword_analyses.business_id
        AND bp.user_id = auth.uid()
    )
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.business_profiles bp
      WHERE bp.id = keyword_analyses.business_id
        AND bp.user_id = auth.uid()
    )
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );


-- ── Fix 9: Consolidate profiles RLS — replace JWT claim with table lookup ──────
DROP POLICY IF EXISTS "Users can view own profile"   ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON public.profiles;

-- Users can see their own row; admins can see all rows
CREATE POLICY "profiles_select"
  ON public.profiles FOR SELECT
  USING (
    auth.uid() = id
    OR EXISTS (SELECT 1 FROM public.profiles p2 WHERE p2.id = auth.uid() AND p2.role = 'admin')
  );

-- Only admins can update profiles (e.g. to promote a user to admin)
CREATE POLICY "profiles_update"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.profiles p2 WHERE p2.id = auth.uid() AND p2.role = 'admin')
  );
