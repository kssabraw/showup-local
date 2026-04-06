-- ── refund_credits() — service_role (called from nlp-proxy on 5xx errors) ──────
CREATE OR REPLACE FUNCTION public.refund_credits(
  p_user_id    uuid,
  p_amount     integer,
  p_endpoint   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.user_profiles
  SET credits_balance = credits_balance + p_amount,
      updated_at      = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions (user_id, credits_used, endpoint, description)
  VALUES (p_user_id, -p_amount, p_endpoint, 'Refund — server error');
END;
$$;

REVOKE ALL ON FUNCTION public.refund_credits FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_credits TO service_role;


-- ── refund_failed_generation() — authenticated users ─────────────────────────
-- Called by the frontend when a generate-page or reoptimize-page stream ends
-- without a successful done event (e.g. edge function timeout).
-- Verifies there was a matching deduction in the last 10 minutes with no
-- corresponding generated_pages row saved for that business+endpoint combo.
CREATE OR REPLACE FUNCTION public.refund_failed_generation(
  p_amount      integer,
  p_endpoint    text,
  p_business_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      uuid := auth.uid();
  v_deduction_id bigint;
  v_page_count   integer;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Find a matching deduction in the last 10 minutes
  SELECT id INTO v_deduction_id
  FROM public.credit_transactions
  WHERE user_id    = v_user_id
    AND endpoint   = p_endpoint
    AND credits_used > 0
    AND created_at >= now() - interval '10 minutes'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_deduction_id IS NULL THEN
    RETURN false;  -- no recent deduction to refund
  END IF;

  -- Confirm no page was actually saved for this business after the deduction
  SELECT COUNT(*) INTO v_page_count
  FROM public.generated_pages
  WHERE business_id = p_business_id
    AND created_at  >= (SELECT created_at FROM public.credit_transactions WHERE id = v_deduction_id);

  IF v_page_count > 0 THEN
    RETURN false;  -- page was saved, no refund warranted
  END IF;

  -- Issue the refund
  UPDATE public.user_profiles
  SET credits_balance = credits_balance + p_amount,
      updated_at      = now()
  WHERE user_id = v_user_id;

  INSERT INTO public.credit_transactions (user_id, credits_used, endpoint, description)
  VALUES (v_user_id, -p_amount, p_endpoint, 'Refund — page failed to generate');

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refund_failed_generation TO authenticated;
