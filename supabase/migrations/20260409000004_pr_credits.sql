-- ── Press release credits ──────────────────────────────────────────────────────
-- Separate from subscription credits — purchased via the $60/$159 pack system.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS pr_credits integer NOT NULL DEFAULT 0;

-- ── deduct_pr_credit() ────────────────────────────────────────────────────────
-- Called by the nlp-proxy (service_role) before forwarding /generate-press-release.
-- Uses SELECT FOR UPDATE to prevent race conditions.
-- Returns true if deduction succeeded, false if balance is 0.
CREATE OR REPLACE FUNCTION public.deduct_pr_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credits integer;
BEGIN
  SELECT pr_credits INTO v_credits
  FROM public.user_profiles
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_credits IS NULL OR v_credits < 1 THEN
    RETURN false;
  END IF;

  UPDATE public.user_profiles
  SET pr_credits = pr_credits - 1,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_pr_credit FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_pr_credit TO service_role;

-- ── fulfill_press_release_pack() ───────────────────────────────────────────────
-- Called by the Stripe webhook edge function after a successful payment.
-- Adds the purchased quantity to the user's pr_credits balance.
CREATE OR REPLACE FUNCTION public.fulfill_press_release_pack(
  p_user_id uuid,
  p_quantity integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.user_profiles
  SET pr_credits = pr_credits + p_quantity,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfill_press_release_pack FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fulfill_press_release_pack TO service_role;
