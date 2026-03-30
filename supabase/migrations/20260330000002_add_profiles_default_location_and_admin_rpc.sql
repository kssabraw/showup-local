-- Add default_location preference to profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS default_location TEXT;

-- RPC for admin to list all users (bypasses RLS, admin-only)
CREATE OR REPLACE FUNCTION public.get_all_users()
RETURNS TABLE(
  id UUID,
  email TEXT,
  created_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (auth.jwt() ->> 'user_role') != 'admin' THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::TEXT,
    u.created_at,
    u.last_sign_in_at,
    COALESCE(p.role, 'user')::TEXT AS role
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  ORDER BY u.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_users TO authenticated;
