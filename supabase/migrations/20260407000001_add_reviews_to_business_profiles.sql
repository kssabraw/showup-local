ALTER TABLE public.business_profiles ADD COLUMN IF NOT EXISTS reviews jsonb DEFAULT '[]'::jsonb;
