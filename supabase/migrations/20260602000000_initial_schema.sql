-- Profiles: one row per auth user.
-- username is nullable so OAuth users can be created before they choose one.
create table profiles (
  id          uuid references auth.users primary key,
  username    text unique,
  created_at  timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Hike segments
create table hike_segments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  trail_id    text not null,
  start_lat   float not null,
  start_lng   float not null,
  end_lat     float not null,
  end_lng     float not null,
  start_mile  float,
  end_mile    float,
  hiked_date  date,
  temp_f      integer,
  notes       text,
  flora_fauna text,
  created_at  timestamptz default now()
);

alter table hike_segments enable row level security;

create policy "Users can manage own hike segments"
  on hike_segments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Badges
create table badges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users not null,
  badge_key  text not null,
  earned_at  timestamptz default now(),
  unique (user_id, badge_key)
);

alter table badges enable row level security;

create policy "Users can view own badges"
  on badges for select
  using (auth.uid() = user_id);

create policy "Users can insert own badges"
  on badges for insert
  with check (auth.uid() = user_id);

-- Trigger: auto-create profile on every new signup.
-- For email/password signups, username comes from raw_user_meta_data.
-- For OAuth signups, username is null — the app prompts for it post-login.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, username)
  values (
    new.id,
    nullif(trim(new.raw_user_meta_data->>'username'), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- RPC: check username availability without requiring authentication.
-- Called client-side before sign-up to give immediate feedback.
create or replace function is_username_available(p_username text)
returns boolean
language sql
security definer set search_path = public
as $$
  select not exists (
    select 1 from profiles
    where lower(username) = lower(trim(p_username))
  );
$$;

grant execute on function is_username_available to anon, authenticated;

-- Grant table-level access to authenticated users.
-- RLS policies above control row-level access; these grants allow the role
-- to reach the table at all (not auto-applied when creating via SQL migration).
grant select, update                    on public.profiles       to authenticated;
grant select, insert, update, delete    on public.hike_segments  to authenticated;
grant select, insert                    on public.badges          to authenticated;
