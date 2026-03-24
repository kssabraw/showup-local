
CREATE TABLE public.business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gbp_place_id TEXT NOT NULL,
  business_name TEXT NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  phone TEXT,
  website TEXT,
  logo TEXT,
  photo TEXT,
  gbp_category TEXT NOT NULL DEFAULT '',
  gbp_categories JSONB NOT NULL DEFAULT '[]',
  gbp_rating FLOAT,
  gbp_review_count INTEGER,
  latitude FLOAT,
  longitude FLOAT,
  hours JSONB,
  google_maps_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint on place_id to avoid duplicates
CREATE UNIQUE INDEX idx_business_profiles_place_id ON public.business_profiles (gbp_place_id);

-- Enable RLS (permissive for now since no auth)
ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access for now"
  ON public.business_profiles
  FOR ALL
  USING (true)
  WITH CHECK (true);
