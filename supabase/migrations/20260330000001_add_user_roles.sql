-- Add user roles system for SaaS multi-tenancy
-- Roles: 'user' (default) | 'admin'

-- 1. Profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 3. Custom JWT hook — injects user_role into token claims
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  claims JSONB;
  user_role TEXT;
BEGIN
  SELECT role INTO user_role
  FROM public.profiles
  WHERE id = (event ->> 'user_id')::UUID;

  claims := event -> 'claims';
  claims := jsonb_set(claims, '{user_role}', to_jsonb(COALESCE(user_role, 'user')));

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles TO supabase_auth_admin;

-- 4. RLS on profiles
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING ((auth.jwt() ->> 'user_role') = 'admin');

CREATE POLICY "Admins can update all profiles"
  ON public.profiles FOR UPDATE
  USING ((auth.jwt() ->> 'user_role') = 'admin');

-- 5. Update business_profiles RLS to allow admin full access
DROP POLICY IF EXISTS "Users can manage own business profiles" ON public.business_profiles;
CREATE POLICY "Users can manage own business profiles"
  ON public.business_profiles FOR ALL
  USING (
    auth.uid() = user_id
    OR user_id IS NULL
    OR (auth.jwt() ->> 'user_role') = 'admin'
  );

-- 6. Update keyword_analyses RLS to allow admin full access
DROP POLICY IF EXISTS "Users can manage own keyword analyses" ON public.keyword_analyses;
CREATE POLICY "Users can manage own keyword analyses"
  ON public.keyword_analyses FOR ALL
  USING (
    (auth.jwt() ->> 'user_role') = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.business_profiles bp
      WHERE bp.id = keyword_analyses.business_id
        AND (bp.user_id = auth.uid() OR bp.user_id IS NULL)
    )
  );
