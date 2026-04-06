-- ── Fix 11: Replace permissive notif_update policy with narrow functions ────────
-- The old UPDATE policy let users change any column (title, body, related_pr_id…).
-- Replace it with SECURITY DEFINER functions that only touch the `read` column.

DROP POLICY IF EXISTS "notif_update" ON public.notifications;

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.notifications
  SET read = true
  WHERE id = p_id
    AND user_id = auth.uid();  -- users can only mark their own
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.notifications
  SET read = true
  WHERE user_id = auth.uid()
    AND read = false;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notification_read    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_read    TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read TO authenticated;


-- ── Fix 13: Tighten get_all_users — table lookup + explicit grants ─────────────
-- The previous version used JWT claim for admin check (requires Supabase hook).
-- Standardise on table lookup (consistent with Fix 9) and make grants explicit.

CREATE OR REPLACE FUNCTION public.get_all_users()
RETURNS TABLE(
  id              uuid,
  email           text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  role            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Use table lookup, not JWT claim (consistent with all other admin checks)
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Access denied: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    COALESCE(p.role, 'user')::text AS role
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  ORDER BY u.created_at DESC;
END;
$$;

-- Explicitly revoke from PUBLIC and anon; keep authenticated (internal check enforces admin)
REVOKE ALL  ON FUNCTION public.get_all_users FROM PUBLIC;
REVOKE ALL  ON FUNCTION public.get_all_users FROM anon;
GRANT EXECUTE ON FUNCTION public.get_all_users TO authenticated;
