alter table public.generated_pages
  add column if not exists composite_score  integer,
  add column if not exists composite_status text,
  add column if not exists scored_at        timestamptz;
