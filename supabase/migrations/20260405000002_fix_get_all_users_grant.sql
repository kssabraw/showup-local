-- Revoke the existing broad grant and re-grant to admins only via a wrapper approach
-- The function already checks for admin role inside, but we improve error handling

CREATE OR REPLACE FUNCTION public.get_all_users()
RETURNS TABLE (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check admin role from JWT claims
  IF (auth.jwt() ->> 'user_role') IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Admin role required';
  END IF;

  RETURN QUERY
    SELECT
      u.id,
      u.email::text,
      u.created_at,
      u.last_sign_in_at,
      COALESCE(p.role, 'user') AS role
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    ORDER BY u.created_at DESC;
END;
$$;
