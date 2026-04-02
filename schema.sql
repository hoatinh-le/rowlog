-- RowLog Supabase Schema
-- Paste this entire file into the Supabase SQL Editor and run it.

-- ─────────────────────────────────────────────
-- PROFILES (extends auth.users)
-- ─────────────────────────────────────────────
create table if not exists profiles (
  id uuid references auth.users primary key,
  username text unique not null,
  full_name text,
  club text,
  boat_type text,
  seat text,
  weight_kg numeric,
  height_cm numeric,
  threshold_split_secs numeric,
  seed_ctl numeric,
  avatar_url text,
  is_public boolean default false,
  share_token uuid default gen_random_uuid(),
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- SESSIONS (one row per training session, not per day)
-- ─────────────────────────────────────────────
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  date date not null,
  session_number int not null,
  type text not null,
  piece_type text,
  distance_km numeric,
  split_text text,
  split_secs numeric,
  stroke_rate int,
  rpe int,
  notes text,
  tss numeric,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- EXERCISES (linked to a session)
-- ─────────────────────────────────────────────
create table if not exists exercises (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  user_id uuid references profiles(id),
  name text not null,
  sets int,
  reps int,
  weight_kg numeric,
  notes text
);

-- ─────────────────────────────────────────────
-- SLEEP LOGS
-- ─────────────────────────────────────────────
create table if not exists sleep_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  date date not null,
  bedtime time,
  wake_time time,
  hours_slept numeric,
  quality int,
  unique(user_id, date)
);

-- ─────────────────────────────────────────────
-- CHECKINS
-- ─────────────────────────────────────────────
create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  date date not null,
  fatigue int,
  mood int,
  soreness int,
  stress int,
  hrv numeric,
  readiness_score numeric,
  traffic_light text,
  unique(user_id, date)
);

-- ─────────────────────────────────────────────
-- RACES
-- ─────────────────────────────────────────────
create table if not exists races (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  name text not null,
  date date not null,
  event text,
  category text,
  notes text,
  result_split text,
  race_placing text,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- CONNECTIONS (social following)
-- ─────────────────────────────────────────────
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid references profiles(id) on delete cascade,
  following_id uuid references profiles(id) on delete cascade,
  status text default 'pending', -- pending, accepted, declined
  created_at timestamptz default now(),
  unique(follower_id, following_id)
);

-- ─────────────────────────────────────────────
-- FEED EVENTS
-- ─────────────────────────────────────────────
create table if not exists feed_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  event_type text not null, -- 'pb', 'race', 'session', 'streak'
  event_data jsonb,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- STORAGE BUCKET for avatars
-- ─────────────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

-- Storage policy: anyone can read avatars (public bucket)
create policy "Avatar images are publicly accessible"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Storage policy: users can upload their own avatar
create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- Storage policy: users can update their own avatar
create policy "Users can update their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- Storage policy: users can delete their own avatar
create policy "Users can delete their own avatar"
  on storage.objects for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ─────────────────────────────────────────────
-- SECURITY DEFINER RPC for coach view
-- ─────────────────────────────────────────────
create or replace function get_profile_by_share_token(token uuid)
returns setof profiles
language sql
security definer
set search_path = public
as $$
  select * from profiles where share_token = token limit 1;
$$;

-- Allow any authenticated or anonymous caller to invoke this RPC
grant execute on function get_profile_by_share_token(uuid) to anon, authenticated;

-- ─────────────────────────────────────────────
-- COACH VIEW DATA RPCs (security definer, accessible to anon via share token)
-- ─────────────────────────────────────────────
create or replace function get_sessions_for_coach(p_token uuid)
returns setof sessions
language sql
security definer
set search_path = public
as $$
  select s.* from sessions s
  join profiles p on p.id = s.user_id
  where p.share_token = p_token
  order by s.date desc;
$$;
grant execute on function get_sessions_for_coach(uuid) to anon, authenticated;

create or replace function get_checkins_for_coach(p_token uuid)
returns setof checkins
language sql
security definer
set search_path = public
as $$
  select c.* from checkins c
  join profiles p on p.id = c.user_id
  where p.share_token = p_token
  order by c.date desc;
$$;
grant execute on function get_checkins_for_coach(uuid) to anon, authenticated;

create or replace function get_races_for_coach(p_token uuid)
returns setof races
language sql
security definer
set search_path = public
as $$
  select r.* from races r
  join profiles p on p.id = r.user_id
  where p.share_token = p_token
  order by r.date desc;
$$;
grant execute on function get_races_for_coach(uuid) to anon, authenticated;

-- ─────────────────────────────────────────────
-- AUTO-CREATE PROFILE ON SIGNUP
-- Runs as SECURITY DEFINER so it bypasses RLS.
-- Username/name/club are passed as user metadata during signUp.
-- ─────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, full_name, club)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'club'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────
alter table profiles enable row level security;
alter table sessions enable row level security;
alter table exercises enable row level security;
alter table sleep_logs enable row level security;
alter table checkins enable row level security;
alter table races enable row level security;
alter table connections enable row level security;
alter table feed_events enable row level security;

-- ── profiles ──────────────────────────────────
-- Users can CRUD their own profile
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

create policy "Users can delete own profile"
  on profiles for delete using (auth.uid() = id);

-- Any authenticated user can read any profile (needed for search/follow to work).
-- is_public controls visibility of training data, not profile discoverability.
create policy "Authenticated users can search all profiles"
  on profiles for select
  using (auth.role() = 'authenticated');

-- ── sessions ──────────────────────────────────
create policy "Users can CRUD own sessions"
  on sessions for all using (auth.uid() = user_id);

-- Sessions readable by accepted connections
create policy "Sessions readable by accepted connections"
  on sessions for select
  using (
    exists (
      select 1 from connections
      where connections.following_id = sessions.user_id
        and connections.follower_id = auth.uid()
        and connections.status = 'accepted'
    )
  );

-- ── exercises ──────────────────────────────────
create policy "Users can CRUD own exercises"
  on exercises for all using (auth.uid() = user_id);

-- ── sleep_logs ──────────────────────────────────
create policy "Users can CRUD own sleep_logs"
  on sleep_logs for all using (auth.uid() = user_id);

-- Sleep readable by accepted connections
create policy "Sleep readable by accepted connections"
  on sleep_logs for select
  using (
    exists (
      select 1 from connections
      where connections.following_id = sleep_logs.user_id
        and connections.follower_id = auth.uid()
        and connections.status = 'accepted'
    )
  );

-- ── checkins ──────────────────────────────────
create policy "Users can CRUD own checkins"
  on checkins for all using (auth.uid() = user_id);

-- Checkins readable by accepted connections
create policy "Checkins readable by accepted connections"
  on checkins for select
  using (
    exists (
      select 1 from connections
      where connections.following_id = checkins.user_id
        and connections.follower_id = auth.uid()
        and connections.status = 'accepted'
    )
  );

-- ── races ──────────────────────────────────
create policy "Users can CRUD own races"
  on races for all using (auth.uid() = user_id);

-- ── connections ──────────────────────────────────
-- Users can see connections they are part of
create policy "Users can view own connections"
  on connections for select
  using (auth.uid() = follower_id or auth.uid() = following_id);

-- Users can insert (send) connection requests
create policy "Users can send connection requests"
  on connections for insert with check (auth.uid() = follower_id);

-- Users can update connections they received (accept/decline)
create policy "Users can update connections they received"
  on connections for update
  using (auth.uid() = following_id or auth.uid() = follower_id);

-- Users can delete their own connections
create policy "Users can delete own connections"
  on connections for delete
  using (auth.uid() = follower_id or auth.uid() = following_id);

-- ── feed_events ──────────────────────────────────
create policy "Users can CRUD own feed events"
  on feed_events for all using (auth.uid() = user_id);

-- Feed events readable by accepted connections
create policy "Feed events readable by accepted connections"
  on feed_events for select
  using (
    exists (
      select 1 from connections
      where connections.following_id = feed_events.user_id
        and connections.follower_id = auth.uid()
        and connections.status = 'accepted'
    )
  );
