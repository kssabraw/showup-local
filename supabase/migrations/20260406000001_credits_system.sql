-- ── Credits system ────────────────────────────────────────────────────────────
-- user_profiles: one row per auth user, holds credit balance + plan info
-- credit_transactions: append-only log of every deduction
-- deduct_credits(): atomic check-and-deduct with advisory lock
-- on_auth_user_created: trigger that seeds 60 credits on signup

-- ── user_profiles ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credits_balance  integer NOT NULL DEFAULT 60,
  credits_per_month integer NOT NULL DEFAULT 60,
  plan             text NOT NULL DEFAULT 'starter',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own profile"
  ON public.user_profiles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users update own profile"
  ON public.user_profiles FOR UPDATE
  USING (user_id = auth.uid());

-- ── credit_transactions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credits_used integer NOT NULL,
  endpoint     text NOT NULL,
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own transactions"
  ON public.credit_transactions FOR SELECT
  USING (user_id = auth.uid());

-- ── deduct_credits() ──────────────────────────────────────────────────────────
-- Returns true if deduction succeeded, false if insufficient credits.
-- Uses SELECT FOR UPDATE to prevent race conditions.
CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id    uuid,
  p_amount     integer,
  p_endpoint   text,
  p_description text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  SELECT credits_balance INTO v_balance
  FROM public.user_profiles
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN false;
  END IF;

  UPDATE public.user_profiles
  SET credits_balance = credits_balance - p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions (user_id, credits_used, endpoint, description)
  VALUES (p_user_id, p_amount, p_endpoint, p_description);

  RETURN true;
END;
$$;

-- Only the service role (Edge Functions) may call deduct_credits
REVOKE ALL ON FUNCTION public.deduct_credits FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_credits TO service_role;

-- ── get_credits() ─────────────────────────────────────────────────────────────
-- Convenience RPC the frontend calls to read the current balance.
CREATE OR REPLACE FUNCTION public.get_credits()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT credits_balance FROM public.user_profiles WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_credits TO authenticated;

-- ── Auto-create profile on signup ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, credits_balance, credits_per_month, plan)
  VALUES (NEW.id, 60, 60, 'starter')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
