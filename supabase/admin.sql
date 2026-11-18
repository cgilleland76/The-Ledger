-- The Ledger — admin page and GOD view. Run once in the Supabase SQL Editor, after accounts.sql, soft-launch.sql,
-- minis.sql and loot.sql. Safe to re-run.
--
-- Everything here is for the server only (service_role, used by netlify/functions/admin.js after it has checked
-- ADMIN_SECRET). Browsers can't call any of these functions or read these tables.
--   admin_audit     one row per admin write: what, which row, the changed values before and after
--   admin_attempts  failed admin sign-ins per hashed IP, for the lock-out
--   rooms.watcher_at       last time the GOD view was open on this table (the "Watcher" badge reads it)
--   rooms.admin_paused_at  set while the admin has paused the table: the GM doesn't answer until resumed
-- Edits merge only the changed keys into the stored JSON (never replace the whole blob), and refuse when one of
-- those keys changed since the admin page loaded it (the reply carries the current values to compare).

-- ---------- tables ----------
create table if not exists admin_audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  action  text not null,
  target  text not null,
  before  jsonb,
  after   jsonb,
  ip_hash text
);
create index if not exists idx_admin_audit_at on admin_audit(at desc);
create index if not exists idx_admin_audit_target on admin_audit(target, at desc);
alter table admin_audit enable row level security; -- no policies: server only

create table if not exists admin_attempts (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index if not exists idx_admin_attempts on admin_attempts(ip_hash, at);
alter table admin_attempts enable row level security;

alter table rooms add column if not exists watcher_at timestamptz;
alter table rooms add column if not exists admin_paused_at timestamptz;

revoke all on admin_audit, admin_attempts from anon, authenticated;
revoke all on sequence admin_audit_id_seq from anon, authenticated;

-- ---------- helpers ----------
-- Keys in p_base whose stored value is no longer what the admin page loaded (absent and null count the same).
create or replace function admin_conflicts(p_cur jsonb, p_base jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(b.key order by b.key), '{}')
    from jsonb_each(coalesce(p_base, '{}'::jsonb)) b
   where coalesce(p_cur -> b.key, 'null'::jsonb) is distinct from coalesce(b.value, 'null'::jsonb);
$$;
-- Only the given keys of an object (for the audit's before/after).
create or replace function admin_pick(p_obj jsonb, p_keys text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, p_obj -> k), '{}'::jsonb) from unnest(p_keys) k where p_obj ? k;
$$;
create or replace function admin_keys(p_set jsonb, p_unset text[]) returns text[] language sql immutable as $$
  select array(select distinct k from (select jsonb_object_keys(coalesce(p_set, '{}'::jsonb)) k union all select unnest(coalesce(p_unset, '{}'))) x);
$$;
-- A whole number stored in JSON text, or null when it isn't one (players can write anything into a character).
create or replace function admin_int(p_v text) returns integer language sql immutable as $$
  select case when p_v ~ '^\s*-?[0-9]{1,9}(\.[0-9]+)?\s*$' then round(p_v::numeric)::int end;
$$;

-- ---------- sign-in lock-out ----------
-- Counts failures for one hashed IP in the last p_minutes. admin_fail records one and answers the new count.
create or replace function admin_fail_count(p_ip text, p_minutes integer) returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from admin_attempts where ip_hash = p_ip and at > now() - make_interval(mins => p_minutes);
$$;
create or replace function admin_fail(p_ip text, p_minutes integer) returns integer language plpgsql security definer set search_path = public as $$
begin
  delete from admin_attempts where at < now() - interval '1 day';
  insert into admin_attempts(ip_hash) values (p_ip);
  return admin_fail_count(p_ip, p_minutes);
end $$;

-- ---------- characters ----------
create or replace function admin_patch_character(p_id text, p_room text, p_set jsonb, p_unset text[], p_base jsonb, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c characters; conflicts text[]; keys text[] := admin_keys(p_set, p_unset); nd jsonb;
begin
  if jsonb_typeof(coalesce(p_set, '{}'::jsonb)) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into c from characters where id = p_id and room_code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  conflicts := admin_conflicts(c.data, p_base);
  if array_length(conflicts, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'keys', to_jsonb(conflicts), 'current', c.data);
  end if;
  nd := (coalesce(c.data, '{}'::jsonb) || coalesce(p_set, '{}'::jsonb)) - coalesce(p_unset, '{}');
  update characters set data = nd where id = p_id and room_code = p_room;
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('character.edit', p_room || '/' || p_id, admin_pick(c.data, keys), admin_pick(nd, keys), p_ip);
  return jsonb_build_object('ok', true, 'data', nd);
end $$;

-- HP / XP change with a line in the story log, so the table sees what changed.
create or replace function admin_adjust_character(p_id text, p_room text, p_hp integer, p_xp integer, p_note text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c characters; d jsonb; hp0 int; hp1 int; mx int; xp0 int; xp1 int; parts text[] := '{}'; line text;
begin
  select * into c from characters where id = p_id and room_code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  d := coalesce(c.data, '{}'::jsonb);
  mx := greatest(coalesce(admin_int(d ->> 'maxhp'), 1), 1);
  hp0 := least(greatest(coalesce(admin_int(d ->> 'hp'), mx), 0), mx);
  xp0 := greatest(coalesce(admin_int(d ->> 'xp'), 0), 0);
  hp1 := least(greatest(hp0 + coalesce(p_hp, 0), 0), mx);
  xp1 := least(greatest(xp0 + coalesce(p_xp, 0), 0), 400000);
  if coalesce(p_hp, 0) <> 0 then
    d := jsonb_set(d, '{hp}', to_jsonb(hp1));
    if hp1 > 0 then d := d - 'dying' - 'stable'; end if;
    parts := parts || format('HP %s → %s/%s (%s%s)', hp0, hp1, mx, case when p_hp > 0 then '+' else '' end, p_hp);
  end if;
  if coalesce(p_xp, 0) <> 0 then
    d := jsonb_set(d, '{xp}', to_jsonb(xp1));
    parts := parts || format('XP %s → %s (%s%s)', xp0, xp1, case when p_xp > 0 then '+' else '' end, p_xp);
  end if;
  if array_length(parts, 1) is null then return jsonb_build_object('ok', false, 'code', 'nothing'); end if;
  update characters set data = d where id = p_id and room_code = p_room;
  line := format('⚖ %s: %s%s', coalesce(nullif(d ->> 'name', ''), 'A hero'), array_to_string(parts, ', '),
                 case when coalesce(trim(p_note), '') <> '' then ' — ' || left(trim(p_note), 200) else '' end);
  insert into log_entries(id, room_code, author, type, text)
    values ('ad' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), p_room, 'The Ledger', 'system', line);
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('character.adjust', p_room || '/' || p_id, admin_pick(c.data, array['hp', 'xp']), admin_pick(d, array['hp', 'xp']), p_ip);
  return jsonb_build_object('ok', true, 'data', d, 'line', line);
end $$;

-- ---------- rooms ----------
create or replace function admin_patch_room_meta(p_room text, p_set jsonb, p_unset text[], p_base jsonb, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; conflicts text[]; keys text[] := admin_keys(p_set, p_unset); nm jsonb;
begin
  if jsonb_typeof(coalesce(p_set, '{}'::jsonb)) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into r from rooms where code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  conflicts := admin_conflicts(r.meta, p_base);
  if array_length(conflicts, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'keys', to_jsonb(conflicts), 'current', r.meta);
  end if;
  nm := (coalesce(r.meta, '{}'::jsonb) || coalesce(p_set, '{}'::jsonb)) - coalesce(p_unset, '{}');
  update rooms set meta = nm where code = p_room;
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('room.meta', p_room, admin_pick(r.meta, keys), admin_pick(nm, keys), p_ip);
  return jsonb_build_object('ok', true, 'meta', nm);
end $$;

-- One room setting: allow_guests (true/false), mode ('solo'/'group'), archived (true/false), paused (true/false).
-- Pausing and resuming also write a line in the story log.
create or replace function admin_set_room(p_room text, p_field text, p_value jsonb, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; v text := p_value #>> '{}'; b boolean;
begin
  select * into r from rooms where code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  if p_field in ('allow_guests', 'archived', 'paused') then
    if jsonb_typeof(p_value) is distinct from 'boolean' then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
    b := p_value::text::boolean;
  end if;
  if p_field = 'allow_guests' then
    update rooms set allow_guests = b where code = p_room;
  elsif p_field = 'mode' and v in ('solo', 'group') then
    update rooms set mode = v where code = p_room;
  elsif p_field = 'archived' then
    update rooms set archived_at = case when b then coalesce(archived_at, now()) end where code = p_room;
  elsif p_field = 'paused' then
    update rooms set admin_paused_at = case when b then coalesce(admin_paused_at, now()) end where code = p_room;
    if b is distinct from (r.admin_paused_at is not null) then
      insert into log_entries(id, room_code, author, type, text)
        values ('ad' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), p_room, 'The Ledger', 'system',
                case when b then '⏸ The game is paused. The GM will answer again when it resumes.' else '▶ The game has resumed.' end);
    end if;
  else
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('room.' || p_field, p_room,
            jsonb_build_object('allow_guests', r.allow_guests, 'mode', r.mode, 'archived', r.archived_at is not null, 'paused', r.admin_paused_at is not null) -> p_field,
            p_value, p_ip);
  return jsonb_build_object('ok', true);
end $$;

-- The GOD view is open on this table (called every minute or so while it is). Not audited.
create or replace function admin_watch(p_room text, p_on boolean) returns void language sql security definer set search_path = public as $$
  update rooms set watcher_at = case when p_on then now() end where code = p_room;
$$;

-- Deletes a table with its characters, story log and members. p_confirm must be the room code typed again.
create or replace function admin_delete_room(p_room text, p_confirm text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; n_chars int; n_log int;
begin
  if p_confirm is distinct from p_room then return jsonb_build_object('ok', false, 'code', 'confirm'); end if;
  select * into r from rooms where code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  select count(*) into n_chars from characters where room_code = p_room;
  select count(*) into n_log from log_entries where room_code = p_room;
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('room.delete', p_room, jsonb_build_object('room', to_jsonb(r), 'characters', n_chars, 'log_lines', n_log,
            'character_rows', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from characters c where c.room_code = p_room)), null, p_ip);
  delete from rooms where code = p_room;
  return jsonb_build_object('ok', true, 'characters', n_chars, 'log_lines', n_log);
end $$;

-- A line in a table's story log, written by the admin (as the GOD watcher, the narrator, a system note or the GM).
create or replace function admin_post(p_room text, p_author text, p_type text, p_text text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare id text := 'ad' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
begin
  if p_type not in ('gm', 'system', 'action', 'roll') or coalesce(trim(p_text), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not exists (select 1 from rooms where code = p_room) then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  insert into log_entries(id, room_code, author, type, text) values (id, p_room, left(p_author, 60), p_type, left(p_text, 8000));
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('log.post', p_room || '/' || id, null, jsonb_build_object('author', left(p_author, 60), 'type', p_type, 'text', left(p_text, 500)), p_ip);
  return jsonb_build_object('ok', true, 'id', id);
end $$;

-- ---------- minis, chests ----------
create or replace function admin_patch_tag(p_id text, p_status text, p_batch text, p_set jsonb, p_unset text[], p_base jsonb, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t tags; conflicts text[]; keys text[] := admin_keys(p_set, p_unset); nd jsonb;
begin
  select * into t from tags where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  conflicts := admin_conflicts(t.data, p_base);
  if array_length(conflicts, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'keys', to_jsonb(conflicts), 'current', t.data);
  end if;
  nd := (coalesce(t.data, '{}'::jsonb) || coalesce(p_set, '{}'::jsonb)) - coalesce(p_unset, '{}');
  begin
    update tags set data = nd, status = coalesce(p_status, status),
                    batch = case when p_batch is null then batch when p_batch = '' then null else p_batch end,
                    updated_at = now()
     where id = p_id;
  exception when check_violation or foreign_key_violation then
    return jsonb_build_object('ok', false, 'code', 'invalid', 'detail', sqlerrm);
  end;
  insert into tag_events(tag_id, event, key_hash, detail) values (p_id, 'admin_edit', null, left(array_to_string(keys, ','), 300));
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('tag.edit', p_id,
            admin_pick(t.data, keys) || jsonb_build_object('status', t.status, 'batch', t.batch),
            admin_pick(nd, keys) || jsonb_build_object('status', coalesce(p_status, t.status), 'batch', case when p_batch is null then t.batch when p_batch = '' then null else p_batch end),
            p_ip);
  return jsonb_build_object('ok', true, 'data', nd);
end $$;

-- A loot chest or coin opened by mistake: back to active, nobody has opened it.
create or replace function admin_reset_loot(p_id text, p_ip text) returns jsonb language plpgsql security definer set search_path = public as $$
declare t tags;
begin
  select * into t from tags where id = p_id and kind = 'item' for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  update tags set status = 'active', used_at = null, used_room = null, used_by = null, updated_at = now() where id = p_id;
  insert into tag_events(tag_id, event, key_hash, detail) values (p_id, 'admin_reset', null, null);
  insert into admin_audit(action, target, before, after, ip_hash)
    values ('loot.reset', p_id, jsonb_build_object('status', t.status, 'used_at', t.used_at, 'used_room', t.used_room, 'used_by', t.used_by),
            jsonb_build_object('status', 'active'), p_ip);
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_restore_snapshot(p_tag text, p_snapshot bigint, p_ip text) returns jsonb language plpgsql security definer set search_path = public as $$
declare t tags; s tag_snapshots;
begin
  select * into t from tags where id = p_tag for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  select * into s from tag_snapshots where id = p_snapshot and tag_id = p_tag;
  if not found then return jsonb_build_object('ok', false, 'code', 'no_snapshot'); end if;
  update tags set data = s.data, updated_at = now() where id = p_tag;
  insert into tag_events(tag_id, event, key_hash, detail) values (p_tag, 'admin_restore', null, 'snapshot ' || p_snapshot);
  insert into admin_audit(action, target, before, after, ip_hash) values ('tag.restore', p_tag, t.data, s.data, p_ip);
  return jsonb_build_object('ok', true, 'data', s.data);
end $$;

-- ---------- who may call what: the server only ----------
do $$ declare f text; begin
  foreach f in array array[
    'admin_conflicts(jsonb, jsonb)', 'admin_int(text)', 'admin_pick(jsonb, text[])', 'admin_keys(jsonb, text[])',
    'admin_fail_count(text, integer)', 'admin_fail(text, integer)',
    'admin_patch_character(text, text, jsonb, text[], jsonb, text)', 'admin_adjust_character(text, text, integer, integer, text, text)',
    'admin_patch_room_meta(text, jsonb, text[], jsonb, text)', 'admin_set_room(text, text, jsonb, text)', 'admin_watch(text, boolean)',
    'admin_delete_room(text, text, text)', 'admin_post(text, text, text, text, text)',
    'admin_patch_tag(text, text, text, jsonb, text[], jsonb, text)', 'admin_reset_loot(text, text)', 'admin_restore_snapshot(text, bigint, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
