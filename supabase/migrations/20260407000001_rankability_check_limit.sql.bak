-- Add rankability check tracking to user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS rankability_checks_used     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rankability_checks_per_month INTEGER     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS rankability_reset_at        TIMESTAMPTZ NOT NULL
    DEFAULT (date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month');

-- Atomic check-and-increment with auto-reset on new billing month.
-- Returns TRUE  → allowed (counter incremented)
-- Returns FALSE → monthly limit reached
CREATE OR REPLACE FUNCTION public.check_rankability_limit(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used    INTEGER;
  v_limit   INTEGER;
  v_reset   TIMESTAMPTZ;
  v_role    TEXT;
BEGIN
  -- Admins bypass the cap
  SELECT role INTO v_role FROM public.user_profiles WHERE user_id = p_user_id;
  IF v_role = 'admin' THEN
    RETURN TRUE;
  END IF;

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

  -- New billing month → reset counter
  IF NOW() >= v_reset THEN
    UPDATE public.user_profiles
    SET    rankability_checks_used = 1,
           rankability_reset_at    = date_trunc('month', NOW() AT TIME ZONE 'UTC')
                                     + INTERVAL '1 month'
    WHERE  user_id = p_user_id;
    RETURN TRUE;
  END IF;

  -- Hard cap reached
  IF v_used >= v_limit THEN
    RETURN FALSE;
  END IF;

  -- Increment and allow
  UPDATE public.user_profiles
  SET    rankability_checks_used = rankability_checks_used + 1
  WHERE  user_id = p_user_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_rankability_limit(UUID) TO service_role;

-- RPC for frontend to read current usage
CREATE OR REPLACE FUNCTION public.get_rankability_usage(p_user_id UUID)
RETURNS JSON
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
  WHERE  user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN json_build_object('used', 0, 'limit', 50, 'reset_at', NULL);
  END IF;

  -- Auto-reset if past date (read path — no lock needed, just accurate display)
  IF NOW() >= v_reset THEN
    v_used := 0;
  END IF;

  RETURN json_build_object('used', v_used, 'limit', v_limit, 'reset_at', v_reset);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_rankability_usage(UUID) TO authenticated, service_role;
