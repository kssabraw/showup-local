-- Enable RLS on generated_pages
ALTER TABLE public.generated_pages ENABLE ROW LEVEL SECURITY;

-- Users can only access generated pages for businesses they own
CREATE POLICY "Users manage own generated pages"
  ON public.generated_pages
  FOR ALL
  USING (
    business_id IN (
      SELECT id FROM public.business_profiles
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT id FROM public.business_profiles
      WHERE user_id = auth.uid()
    )
  );

-- Enable RLS on token_usage
ALTER TABLE public.token_usage ENABLE ROW LEVEL SECURITY;

-- Users can only access token usage for businesses they own
CREATE POLICY "Users manage own token usage"
  ON public.token_usage
  FOR ALL
  USING (
    business_id IN (
      SELECT id FROM public.business_profiles
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT id FROM public.business_profiles
      WHERE user_id = auth.uid()
    )
  );
