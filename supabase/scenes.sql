-- The Ledger — scene backgrounds. Run once in the Supabase SQL Editor. Safe to re-run.
--
-- A room shows one background at a time (the latest). The Netlify functions store it with the
-- service-role key after a content check; the public key can only view it, never upload.
--
-- The scene lives in its own columns, not in rooms.meta: the app rewrites the whole meta object
-- whenever a player moves on the map or advances a session, which could wipe a scene the server
-- had just saved.

alter table rooms add column if not exists scene_url text;            -- public URL of the current background
alter table rooms add column if not exists scene_status text;         -- 'pending' | 'ready' | 'error:<message>'
alter table rooms add column if not exists scene_updated_at timestamptz;
alter table rooms add column if not exists scene_count integer not null default 0;  -- AI backgrounds made for this room

-- Public bucket for the backgrounds: images only, up to 5 MB. No insert/update/delete policies,
-- so only the service role (the Netlify functions) can write to it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scenes', 'scenes', true, 5242880, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;
