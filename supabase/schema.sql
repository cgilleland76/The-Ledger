-- The Ledger — schema
-- Run this once in your Supabase project's SQL Editor (Database > SQL Editor > New Query)

create table if not exists rooms (
  code text primary key,
  mode text not null default 'group',       -- 'solo' or 'group'
  meta jsonb not null default '{}'::jsonb,  -- campaign name, length, ruleset, tone, seed, session, etc.
  created_at timestamptz not null default now()
);

create table if not exists characters (
  id text primary key,
  room_code text not null references rooms(code) on delete cascade,
  data jsonb not null default '{}'::jsonb,  -- name, race, class, hp, ac, skills, inventory, notes...
  created_at timestamptz not null default now()
);

create table if not exists log_entries (
  id text primary key,
  room_code text not null references rooms(code) on delete cascade,
  author text,
  type text,   -- 'action' | 'roll' | 'gm' | 'system'
  text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_characters_room on characters(room_code);
create index if not exists idx_log_room on log_entries(room_code, created_at);

-- Row Level Security
-- This app is designed for a casual friend-group tool: anyone with a room code
-- can read/write that room's data via the public anon key. Don't store anything
-- sensitive in it. If you want tighter access control later, replace these
-- permissive policies with ones scoped to an authenticated user.

alter table rooms enable row level security;
alter table characters enable row level security;
alter table log_entries enable row level security;

create policy "public read rooms" on rooms for select using (true);
create policy "public insert rooms" on rooms for insert with check (true);
create policy "public update rooms" on rooms for update using (true);
create policy "public delete rooms" on rooms for delete using (true);

create policy "public read characters" on characters for select using (true);
create policy "public insert characters" on characters for insert with check (true);
create policy "public update characters" on characters for update using (true);

create policy "public read log" on log_entries for select using (true);
create policy "public insert log" on log_entries for insert with check (true);

-- Enable realtime so players see updates live instead of polling
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table characters;
alter publication supabase_realtime add table log_entries;

-- ---------------------------------------------------------------------------
-- Character portraits (added after the original schema)
-- Existing projects: run just this section once in the SQL editor.
-- ---------------------------------------------------------------------------

-- The portrait function reports progress on the character row, which the app
-- already watches through realtime.
alter table characters add column if not exists portrait_url text;
alter table characters add column if not exists portrait_status text;        -- 'pending' | 'ready' | 'error:<message>'
alter table characters add column if not exists portrait_updated_at timestamptz;

-- Counts generated portraits per room (the function caps it).
alter table rooms add column if not exists image_count integer not null default 0;

-- Public bucket for the generated images, limited to small image files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portraits', 'portraits', true, 2097152, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- The function uploads with the public anon key, in keeping with the rest of this
-- app's open design; the bucket's size and type limits are the guard rails.
create policy "public upload portraits" on storage.objects
  for insert with check (bucket_id = 'portraits');
