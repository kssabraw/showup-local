-- ── Fix 1: user_profiles UPDATE policy allows self-crediting ──────────────────
-- Drop the permissive policy that lets users update credits_balance, plan, etc.
-- All legitimate credit mutations go through deduct_credits() (service_role only).
DROP POLICY IF EXISTS "Users update own profile" ON public.user_profiles;

-- Users should never directly mutate user_profiles via the client.
-- If a future feature needs it (e.g., display preferences), add a
-- SECURITY DEFINER function that updates only the safe columns.


-- ── Fix 5: Storage read policy — scope to press release owner ─────────────────
-- Old policy allowed ANY authenticated user to read ANY file in the bucket.
-- New policy restricts reads to: the owner of the press release OR an admin.
-- The storage path format is {press_release_id}/{timestamp}-{filename},
-- so we can match on the press_release_id prefix.
DROP POLICY IF EXISTS "storage_pr_read" ON storage.objects;

CREATE POLICY "storage_pr_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'press-release-reports'
    AND (
      -- Admins can read all reports
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
      )
      -- Users can read reports for their own press releases
      OR EXISTS (
        SELECT 1 FROM public.press_releases pr
        WHERE pr.user_id = auth.uid()
          AND storage.objects.name LIKE (pr.id::text || '/%')
      )
    )
  );
