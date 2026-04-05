alter table public.generated_pages
  add column if not exists page_title text;
