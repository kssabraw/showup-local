create table if not exists public.team_members (
  id          uuid        default gen_random_uuid() primary key,
  owner_user_id uuid      references auth.users(id) on delete cascade not null,
  email       text        not null,
  name        text        not null default '',
  created_at  timestamptz default now() not null,
  constraint unique_owner_email unique (owner_user_id, email)
);

alter table public.team_members enable row level security;

create policy "Users manage their own team members"
  on public.team_members for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);
