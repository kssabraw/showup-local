-- Remove admin role bypass from deduct_credits and check_rankability_limit.
-- Both functions were querying `role` from public.user_profiles which doesn't
-- have that column (it lives in public.profiles). Instead of fixing the lookup,
-- remove the bypass entirely — admin accounts are set to 9999 credits so they
-- never hit limits in practice.

CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id uuid, p_amount integer, p_endpoint text, p_description text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance      integer;
  v_bonus        integer;
  v_from_balance integer;
  v_from_bonus   integer;
BEGIN
  SELECT credits_balance, bonus_credits
  INTO   v_balance, v_bonus
  FROM   public.user_profiles
  WHERE  user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR (v_balance + v_bonus) < p_amount THEN
    RETURN false;
  END IF;

  v_from_balance := LEAST(v_balance, p_amount);
  v_from_bonus   := p_amount - v_from_balance;

  UPDATE public.user_profiles
  SET credits_balance = credits_balance - v_from_balance,
      bonus_credits   = bonus_credits   - v_from_bonus,
      updated_at      = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions (user_id, credits_used, endpoint, description)
  VALUES (p_user_id, p_amount, p_endpoint, p_description);

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_rankability_limit(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  INTEGER;
  v_limit INTEGER;
  v_reset TIMESTAMPTZ;
BEGIN
  SELECT rankability_checks_used,
         rankability_checks_per_month,
         rankability_reset_at
  INTO   v_used, v_limit, v_reset
  FROM   public.user_profiles
  WHERE  user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF NOW() >= v_reset THEN
    UPDATE public.user_profiles
    SET    rankability_checks_used = 1,
           rankability_reset_at    = date_trunc('month', NOW() AT TIME ZONE 'UTC')
                                     + INTERVAL '1 month'
    WHERE  user_id = p_user_id;
    RETURN TRUE;
  END IF;

  IF v_used >= v_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE public.user_profiles
  SET    rankability_checks_used = rankability_checks_used + 1
  WHERE  user_id = p_user_id;

  RETURN TRUE;
END;
$$;
