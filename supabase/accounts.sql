-- The Ledger — accounts, account (private) tables, and guest tables. Run once in the Supabase SQL Editor,
-- after schema.sql, billing.sql, tags.sql and minis.sql. Safe to re-run.
--
-- Two kinds of room (rooms.kind):
-- * guest   — as before: the code is the only key, anyone holding the public site key can read and write.
--             Capped site-wide (guest_room_cap); when full, the least recently played guest room is removed.
-- * account — made by a signed-in player. Only members (room_members) can read or write. Joined with a
--             separate join code (8 characters) that the host can rotate; the internal room code is not a
--             key. Never removed for space; each account keeps at most account_room_limit() active
--             tables and the least recently played is archived (not deleted) to make room.
-- Guests (no account) can still join an account table, as a 'guest' member, using Supabase's anonymous
-- sign-in, unless the host turned guests off.
-- Accounts (accounts) remember ONE ink key: ink, Google Play purchases, minis and hosting keep working by
-- ink key, so signing in hands the key back on any device. A device that already has ink or minis on a
-- different key is offered a one-time merge (account_link / account_merge).
-- Also: table hosts (rooms.meta.host) are stored as a hash of the ink key, not the key itself.

-- ---------- accounts ----------
create table if not exists accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ink_key    text not null unique check (ink_key ~ '^[a-z0-9]{16,40}$'),
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
alter table accounts enable row level security; -- server only: no policies

create or replace function ink_hash(p_key text) returns text language sql immutable set search_path = public as $$
  select encode(extensions.digest(p_key, 'sha256'), 'hex');
$$;
create or replace function is_anon_user() returns boolean language sql stable set search_path = public as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- ---------- rooms: kinds, join codes, last played, archive ----------
alter table rooms add column if not exists kind text not null default 'guest';
alter table rooms add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table rooms add column if not exists join_code text unique;
alter table rooms add column if not exists allow_guests boolean not null default true;
alter table rooms add column if not exists last_played timestamptz;
alter table rooms add column if not exists archived_at timestamptz;
do $$ begin
  alter table rooms add constraint rooms_kind_check check (kind in ('guest', 'account'));
exception when duplicate_object then null; end $$;
update rooms r set last_played = coalesce((select max(l.created_at) from log_entries l where l.room_code = r.code), r.created_at)
 where r.last_played is null;
alter table rooms alter column last_played set default now();
alter table rooms alter column last_played set not null;
create index if not exists idx_rooms_guest_played on rooms(last_played) where kind = 'guest';
create index if not exists idx_rooms_owner on rooms(owner_id) where kind = 'account';

-- Hosts: raw ink key -> hash.
update rooms set meta = jsonb_set(meta, '{host}', to_jsonb(ink_hash(meta->>'host')))
 where meta ? 'host' and length(meta->>'host') <> 64;

create table if not exists room_members (
  room_code    text not null references rooms(code) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('host', 'player', 'guest')),
  character_id text,
  joined_at    timestamptz not null default now(),
  primary key (room_code, user_id)
);
create index if not exists idx_room_members_user on room_members(user_id);
alter table room_members enable row level security; -- read through my_tables(); no direct access

create or replace function is_room_member(p_room text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_code = p_room and user_id = auth.uid());
$$;
create or replace function can_use_room(p_room text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from rooms where code = p_room and (kind = 'guest' or exists (
    select 1 from room_members m where m.room_code = p_room and m.user_id = auth.uid())));
$$;

-- ---------- the rules ----------
drop policy if exists "public read rooms" on rooms;
drop policy if exists "public insert rooms" on rooms;
drop policy if exists "public update rooms" on rooms;
drop policy if exists "public delete rooms" on rooms;
drop policy if exists "public read characters" on characters;
drop policy if exists "public insert characters" on characters;
drop policy if exists "public update characters" on characters;
drop policy if exists "public read log" on log_entries;
drop policy if exists "public insert log" on log_entries;
drop policy if exists "rooms: guest or member" on rooms;
drop policy if exists "rooms: new guest rooms" on rooms;
drop policy if exists "rooms: guest or member can play" on rooms;
drop policy if exists "characters: guest room or member" on characters;
drop policy if exists "characters: add in guest room or as member" on characters;
drop policy if exists "characters: edit in guest room or as member" on characters;
drop policy if exists "log: guest room or member" on log_entries;
drop policy if exists "log: write in guest room or as member" on log_entries;

create policy "rooms: guest or member" on rooms for select using (kind = 'guest' or is_room_member(code));
create policy "rooms: new guest rooms" on rooms for insert with check (kind = 'guest' and owner_id is null and join_code is null);
create policy "rooms: guest or member can play" on rooms for update
  using (kind = 'guest' or is_room_member(code)) with check (kind = 'guest' or is_room_member(code));
-- No delete policy: guest rooms are only removed by make_room_space(), account rooms only archived.
create policy "characters: guest room or member" on characters for select using (can_use_room(room_code));
create policy "characters: add in guest room or as member" on characters for insert with check (can_use_room(room_code));
create policy "characters: edit in guest room or as member" on characters for update using (can_use_room(room_code)) with check (can_use_room(room_code));
create policy "log: guest room or member" on log_entries for select using (can_use_room(room_code));
create policy "log: write in guest room or as member" on log_entries for insert with check (can_use_room(room_code));

-- Browsers may only write the game itself: never a room's kind, owner, join code or archive state, and
-- never a character's portrait columns (the server stores those after its content check).
revoke insert, update, delete on rooms from anon, authenticated;
grant insert (code, mode, meta) on rooms to anon, authenticated;
grant update (meta) on rooms to anon, authenticated;
revoke insert, update on characters from anon, authenticated;
grant insert (id, room_code, data) on characters to anon, authenticated;
grant update (id, room_code, data) on characters to anon, authenticated;

-- A table is "played" when its story moves (at most one bump every 5 minutes, to keep realtime quiet).
create or replace function touch_room() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update rooms set last_played = now() where code = new.room_code and last_played < now() - interval '5 minutes';
  return new;
end $$;
drop trigger if exists log_touches_room on log_entries;
create trigger log_touches_room after insert on log_entries for each row execute function touch_room();

-- ---------- limits ----------
create or replace function guest_room_cap() returns integer language sql immutable as 'select 20';
create or replace function account_room_limit() returns integer language sql immutable as 'select 5';

create or replace function new_room_code(n integer default 8) returns text language plpgsql volatile set search_path = public as $$
declare a text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; b bytea;
begin
  loop
    b := extensions.gen_random_bytes(n); c := '';
    for i in 0 .. n - 1 loop c := c || substr(a, (get_byte(b, i) % length(a)) + 1, 1); end loop;
    exit when not exists (select 1 from rooms where code = c or join_code = c);
  end loop;
  return c;
end $$;

-- Before a new guest room: remove least recently played guest rooms until there's space.
create or replace function make_room_space() returns integer language plpgsql security definer set search_path = public as $$
declare n integer; removed integer := 0;
begin
  perform pg_advisory_xact_lock(7710);
  select count(*) into n from rooms where kind = 'guest';
  while n >= guest_room_cap() loop
    delete from rooms where code = (select code from rooms where kind = 'guest' order by last_played asc, created_at asc limit 1);
    n := n - 1; removed := removed + 1;
  end loop;
  return removed;
end $$;

-- Archives an owner's least recently played active tables until one more fits. Returns their codes.
create or replace function archive_to_fit(p_owner uuid, p_keep text default null) returns text[] language plpgsql security definer set search_path = public as $$
declare out text[] := '{}'; n integer; c text;
begin
  select count(*) into n from rooms where owner_id = p_owner and kind = 'account' and archived_at is null and code is distinct from p_keep;
  while n >= account_room_limit() loop
    select code into c from rooms where owner_id = p_owner and kind = 'account' and archived_at is null and code is distinct from p_keep
     order by last_played asc limit 1;
    update rooms set archived_at = now() where code = c;
    out := out || c; n := n - 1;
  end loop;
  return out;
end $$;

-- ---------- account tables ----------
create or replace function room_reply(ok boolean, code text) returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', ok, 'code', code);
$$;

create or replace function create_account_room(p_mode text, p_meta jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); c text; j text; arch text[];
begin
  if uid is null or is_anon_user() then return room_reply(false, 'sign_in'); end if;
  arch := archive_to_fit(uid, null);
  c := new_room_code(8); j := new_room_code(8);
  insert into rooms(code, mode, meta, kind, owner_id, join_code, last_played)
  values (c, case when p_mode = 'solo' then 'solo' else 'group' end, coalesce(p_meta, '{}'::jsonb), 'account', uid, j, now());
  insert into room_members(room_code, user_id, role) values (c, uid, 'host');
  return jsonb_build_object('ok', true, 'room', c, 'join_code', j, 'archived', to_jsonb(arch));
end $$;

-- Joins by code. Guest rooms: just returns the room. Account rooms: only by their join code; adds the
-- caller as a member (signed in: 'player'; anonymous: 'guest', if the host allows guests). p_character
-- keeps a player who was already at the table on their hero (after the room was saved to an account).
create or replace function join_room(p_code text, p_character text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r rooms; m room_members; cc text := upper(trim(coalesce(p_code, ''))); ch text;
begin
  select * into r from rooms where join_code = cc;
  if not found then
    select * into r from rooms where code = cc and kind = 'guest';
    if not found then return room_reply(false, 'no_room'); end if;
    return jsonb_build_object('ok', true, 'room', r.code, 'kind', 'guest');
  end if;
  if uid is null then return room_reply(false, 'sign_in'); end if;
  select * into m from room_members where room_code = r.code and user_id = uid;
  ch := case when p_character is not null
              and exists (select 1 from characters where id = p_character and room_code = r.code)
              and not exists (select 1 from room_members where room_code = r.code and character_id = p_character and user_id <> uid)
             then p_character end;
  if m.user_id is not null then
    if m.character_id is null and ch is not null then update room_members set character_id = ch where room_code = r.code and user_id = uid; end if;
    return jsonb_build_object('ok', true, 'room', r.code, 'kind', 'account', 'role', m.role);
  end if;
  if is_anon_user() and not r.allow_guests then return room_reply(false, 'private'); end if;
  insert into room_members(room_code, user_id, role, character_id)
  values (r.code, uid, case when is_anon_user() then 'guest' else 'player' end, ch);
  return jsonb_build_object('ok', true, 'room', r.code, 'kind', 'account', 'role', case when is_anon_user() then 'guest' else 'player' end);
end $$;

-- A member says which hero is theirs (after making a character at an account table).
create or replace function claim_seat(p_room text, p_character text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from characters where id = p_character and room_code = p_room) then return room_reply(false, 'no_character'); end if;
  if exists (select 1 from room_members where room_code = p_room and character_id = p_character and user_id <> auth.uid()) then return room_reply(false, 'taken'); end if;
  update room_members set character_id = p_character where room_code = p_room and user_id = auth.uid();
  if not found then return room_reply(false, 'not_member'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- "Save this table to my account": the guest room's host (by ink key) turns it into an account room.
-- The code keeps working as its join code; players already there keep their heroes when they rejoin.
create or replace function upgrade_room(p_room text, p_character text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r rooms; k text; arch text[];
begin
  if uid is null or is_anon_user() then return room_reply(false, 'sign_in'); end if;
  select * into r from rooms where code = p_room for update;
  if not found then return room_reply(false, 'no_room'); end if;
  if r.kind <> 'guest' then return room_reply(false, 'already_account'); end if;
  select ink_key into k from accounts where user_id = uid;
  if r.meta ? 'host' and coalesce(r.meta->>'host', '') <> '' and (k is null or r.meta->>'host' not in (ink_hash(k), k)) then
    return room_reply(false, 'not_host');
  end if;
  arch := archive_to_fit(uid, null);
  update rooms set kind = 'account', owner_id = uid, join_code = r.code, allow_guests = true, last_played = now(),
         meta = case when k is null then meta else jsonb_set(meta, '{host}', to_jsonb(ink_hash(k))) end
   where code = r.code;
  insert into room_members(room_code, user_id, role, character_id)
  values (r.code, uid, 'host', case when exists (select 1 from characters where id = p_character and room_code = r.code) then p_character end)
  on conflict (room_code, user_id) do update set role = 'host';
  return jsonb_build_object('ok', true, 'room', r.code, 'join_code', r.code, 'archived', to_jsonb(arch));
end $$;

create or replace function is_room_host(p_room text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_code = p_room and user_id = auth.uid() and role = 'host');
$$;

-- New join code: the old one (and old invite links) stop working. Members stay members.
create or replace function rotate_room_code(p_room text) returns jsonb language plpgsql security definer set search_path = public as $$
declare j text;
begin
  if not is_room_host(p_room) then return room_reply(false, 'not_host'); end if;
  j := new_room_code(8);
  update rooms set join_code = j where code = p_room and kind = 'account';
  return jsonb_build_object('ok', true, 'join_code', j);
end $$;

create or replace function set_room_guests(p_room text, p_allow boolean) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_room_host(p_room) then return room_reply(false, 'not_host'); end if;
  update rooms set allow_guests = p_allow where code = p_room and kind = 'account';
  return jsonb_build_object('ok', true, 'allow_guests', p_allow);
end $$;

-- Archive or restore one of your tables. Restoring may archive your least recently played one.
create or replace function archive_room(p_room text, p_archive boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); arch text[] := '{}';
begin
  if not exists (select 1 from rooms where code = p_room and owner_id = uid and kind = 'account') then return room_reply(false, 'not_host'); end if;
  if p_archive then
    update rooms set archived_at = now() where code = p_room;
  else
    arch := archive_to_fit(uid, p_room);
    update rooms set archived_at = null, last_played = now() where code = p_room;
  end if;
  return jsonb_build_object('ok', true, 'archived', to_jsonb(arch));
end $$;

-- My tables: every account table the caller belongs to.
create or replace function my_tables() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'room', r.code, 'join_code', r.join_code, 'name', coalesce(r.meta->>'name', 'Untitled story'), 'mode', r.mode,
           'role', m.role, 'character_id', m.character_id, 'character', c.data->>'name',
           'last_played', r.last_played, 'archived', r.archived_at is not null, 'allow_guests', r.allow_guests,
           'owner', r.owner_id = auth.uid())
         order by r.archived_at is not null, r.last_played desc), '[]'::jsonb)
    from room_members m join rooms r on r.code = m.room_code
    left join characters c on c.id = m.character_id and c.room_code = m.room_code
   where m.user_id = auth.uid() and r.kind = 'account';
$$;

-- What the room row looks like to a member (join code and guest switch; only members can see it).
create or replace function room_info(p_room text) returns jsonb language sql stable security definer set search_path = public as $$
  select case when is_room_member(p_room) then (
    select jsonb_build_object('kind', r.kind, 'join_code', r.join_code, 'allow_guests', r.allow_guests,
             'archived', r.archived_at is not null, 'role', m.role, 'character_id', m.character_id)
      from rooms r join room_members m on m.room_code = r.code and m.user_id = auth.uid() where r.code = p_room)
  else (select jsonb_build_object('kind', kind) from rooms where code = p_room and kind = 'guest') end;
$$;

-- ---------- ink key <-> account (called by /api/account with the service role) ----------
-- What would move from one key to another.
create or replace function key_assets(p_key text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ink', coalesce((select paid_balance from wallets where player_id = p_key), 0),
    'minis', (select count(*) from tags where claimed_by = ink_hash(p_key) and kind = 'hero' and status in ('active', 'moved')),
    'tables', (select count(*) from rooms where meta->>'host' in (ink_hash(p_key), p_key)));
$$;

-- Moves paid ink, purchases, minis and hosted tables from p_from to p_to. The free monthly allowance is not
-- moved (new keys would otherwise farm free ink).
create or replace function account_merge(p_from text, p_to text) returns jsonb language plpgsql security definer set search_path = public as $$
declare hf text := ink_hash(p_from); ht text := ink_hash(p_to); ink integer; n_minis integer := 0; n_tables integer := 0;
begin
  if p_from = p_to then return jsonb_build_object('ink', 0, 'minis', 0, 'tables', 0); end if;
  insert into wallets(player_id) values (p_to) on conflict do nothing;
  select paid_balance into ink from wallets where player_id = p_from for update;
  ink := coalesce(ink, 0);
  if ink > 0 then
    update wallets set paid_balance = 0, updated_at = now() where player_id = p_from;
    update wallets set paid_balance = paid_balance + ink, updated_at = now() where player_id = p_to;
  end if;
  update credit_grants set player_id = p_to where player_id = p_from;
  update tags set claimed_by = ht, updated_at = now() where claimed_by = hf;
  get diagnostics n_minis = row_count;
  update tag_claims set claimed_by = ht where claimed_by = hf;
  update rooms set meta = jsonb_set(meta, '{host}', to_jsonb(ht)) where meta->>'host' in (hf, p_from);
  get diagnostics n_tables = row_count;
  if n_minis > 0 then perform tag_log(null, 'merge', ht, format('%s minis from another key', n_minis)); end if;
  return jsonb_build_object('ink', ink, 'minis', n_minis, 'tables', n_tables);
end $$;

-- Sign-in. p_device: this device's key now. p_fresh: a new random key, used only if the device's key
-- already belongs to a different account.
--   new          no account yet: the device's key (or p_fresh) becomes the account's key
--   same         nothing to do
--   switched     the device takes the account's key; its own key had nothing on it (or isn't its to give)
--   needs_merge  the device's key has ink, minis or tables: ask the player (then account_merge)
create or replace function account_link(p_user uuid, p_device text, p_fresh text) returns jsonb language plpgsql security definer set search_path = public as $$
declare a accounts; other uuid; assets jsonb;
begin
  select * into a from accounts where user_id = p_user for update;
  select user_id into other from accounts where ink_key = p_device and user_id <> p_user;
  if a.user_id is null then
    insert into accounts(user_id, ink_key) values (p_user, case when other is null then p_device else p_fresh end) returning * into a;
    return jsonb_build_object('status', 'new', 'ink_key', a.ink_key);
  end if;
  update accounts set last_seen = now() where user_id = p_user;
  if a.ink_key = p_device then return jsonb_build_object('status', 'same', 'ink_key', a.ink_key); end if;
  if other is not null then return jsonb_build_object('status', 'switched', 'ink_key', a.ink_key); end if;
  assets := key_assets(p_device);
  if (assets->>'ink')::int > 0 or (assets->>'minis')::int > 0 or (assets->>'tables')::int > 0 then
    return jsonb_build_object('status', 'needs_merge', 'ink_key', a.ink_key, 'device', assets);
  end if;
  return jsonb_build_object('status', 'switched', 'ink_key', a.ink_key);
end $$;

-- Merge after the player said yes. Refuses a device key that belongs to another account.
create or replace function account_merge_device(p_user uuid, p_device text) returns jsonb language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  select * into a from accounts where user_id = p_user for update;
  if a.user_id is null then return room_reply(false, 'no_account'); end if;
  if exists (select 1 from accounts where ink_key = p_device and user_id <> p_user) then return room_reply(false, 'other_account'); end if;
  return jsonb_build_object('ok', true, 'ink_key', a.ink_key, 'moved', account_merge(p_device, a.ink_key));
end $$;

create or replace function account_email(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select email::text from auth.users where id = p_user;
$$;

-- ---------- who may call what ----------
do $$ declare f text; begin
  foreach f in array array[
    'ink_hash(text)', 'is_anon_user()', 'is_room_member(text)', 'can_use_room(text)', 'touch_room()', 'new_room_code(integer)',
    'make_room_space()', 'archive_to_fit(uuid, text)', 'create_account_room(text, jsonb)', 'join_room(text, text)',
    'claim_seat(text, text)', 'upgrade_room(text, text)', 'is_room_host(text)', 'rotate_room_code(text)',
    'set_room_guests(text, boolean)', 'archive_room(text, boolean)', 'my_tables()', 'room_info(text)',
    'key_assets(text)', 'account_merge(text, text)', 'account_link(uuid, text, text)', 'account_merge_device(uuid, text)',
    'account_email(uuid)', 'room_reply(boolean, text)']
  loop execute format('revoke all on function %s from public, anon, authenticated', f); end loop;
end $$;
-- the rules call these as the signed-in (or anonymous) player
grant execute on function is_room_member(text), can_use_room(text), is_anon_user(), room_reply(boolean, text) to anon, authenticated;
-- the site, for anyone
grant execute on function make_room_space(), join_room(text, text), room_info(text) to anon, authenticated;
-- signed-in players (anonymous guests included; each function checks what it needs)
grant execute on function create_account_room(text, jsonb), claim_seat(text, text), upgrade_room(text, text),
  rotate_room_code(text), set_room_guests(text, boolean), archive_room(text, boolean), my_tables() to authenticated;
-- the server only
grant execute on function ink_hash(text), key_assets(text), account_merge(text, text), account_link(uuid, text, text),
  account_merge_device(uuid, text), account_email(uuid), archive_to_fit(uuid, text), new_room_code(integer) to service_role;
