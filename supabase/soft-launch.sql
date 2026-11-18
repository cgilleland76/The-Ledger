-- The Ledger — soft-launch limits. Run once in the Supabase SQL Editor, after accounts.sql. Safe to re-run.
--
-- 1. GM usage: every Claude call the GM function makes (story replies, opening scenes, AI character
--    building) is counted per day, per table, per hashed IP and per player, and refused past the limits the
--    function passes in (GM_MAX_* in Netlify). AI portraits and scenes are counted the same way.
--    The IP is never stored: the function sends a keyed hash of it.
-- 2. No more room cap: guest tables are no longer removed to make space. Instead, cleanup_idle_rooms()
--    deletes guest tables with no story activity for 30 days (their characters and log go with them),
--    except a solo story paused with its story code in the last 30 days. Netlify runs it daily
--    (netlify/functions/room-cleanup.js). Account (signed-in) tables are never deleted by it.

-- ---------- 1. GM usage ----------
-- what: 'gm' (every Claude call of the GM function), 'portrait' or 'scene' (AI images, while switched on),
-- 'memorial' (Hall of the Fallen entries) or 'upload' (uploaded portraits).
-- user_id: the signed-in or anonymous player who made the call.
create table if not exists gm_usage (
  day       date    not null,
  what      text    not null default 'gm' check (what in ('gm', 'portrait', 'scene', 'memorial', 'upload')),
  room_code text    not null,
  ip_hash   text    not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  user_id   uuid    not null,
  count     integer not null default 0 check (count >= 0),
  primary key (day, what, room_code, ip_hash, user_id)
);
create index if not exists idx_gm_usage_day_ip on gm_usage(day, what, ip_hash);
create index if not exists idx_gm_usage_day_user on gm_usage(day, what, user_id);
alter table gm_usage enable row level security; -- server only: no policies
revoke all on gm_usage from anon, authenticated;

-- Counts one call if it fits every limit. A null or non-positive limit means no limit of that kind.
-- Returns {ok: true} or {ok: false, reason: 'room' | 'ip' | 'user' | 'global'}. Calls are serialized per day,
-- so two players at once can't both slip past a limit.
drop function if exists gm_use(date, text, text, integer, integer, integer);
drop function if exists gm_unuse(date, text, text);
create or replace function gm_use(p_day date, p_what text, p_room text, p_ip text, p_user uuid,
                                  p_room_max integer, p_ip_max integer, p_user_max integer, p_day_max integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_day is null or p_room is null or p_user is null or p_ip !~ '^[0-9a-f]{64}$' or p_what not in ('gm', 'portrait', 'scene', 'memorial', 'upload') then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(7720, (p_day - date '2000-01-01'));
  if coalesce(p_room_max, 0) > 0 then
    select coalesce(sum(count), 0) into n from gm_usage where day = p_day and what = p_what and room_code = p_room;
    if n >= p_room_max then return jsonb_build_object('ok', false, 'reason', 'room'); end if;
  end if;
  if coalesce(p_ip_max, 0) > 0 then
    select coalesce(sum(count), 0) into n from gm_usage where day = p_day and what = p_what and ip_hash = p_ip;
    if n >= p_ip_max then return jsonb_build_object('ok', false, 'reason', 'ip'); end if;
  end if;
  if coalesce(p_user_max, 0) > 0 then
    select coalesce(sum(count), 0) into n from gm_usage where day = p_day and what = p_what and user_id = p_user;
    if n >= p_user_max then return jsonb_build_object('ok', false, 'reason', 'user'); end if;
  end if;
  if coalesce(p_day_max, 0) > 0 then
    select coalesce(sum(count), 0) into n from gm_usage where day = p_day and what = p_what;
    if n >= p_day_max then return jsonb_build_object('ok', false, 'reason', 'global'); end if;
  end if;
  insert into gm_usage(day, what, room_code, ip_hash, user_id, count) values (p_day, p_what, p_room, p_ip, p_user, 1)
    on conflict (day, what, room_code, ip_hash, user_id) do update set count = gm_usage.count + 1;
  return jsonb_build_object('ok', true);
end $$;

-- Gives a counted call back when it produced no reply (Claude was down, the setup allowance or the ink
-- ran out), so failures don't use up anyone's limit.
create or replace function gm_unuse(p_day date, p_what text, p_room text, p_ip text, p_user uuid) returns void
language sql security definer set search_path = public as $$
  update gm_usage set count = count - 1
   where day = p_day and what = p_what and room_code = p_room and ip_hash = p_ip and user_id = p_user and count > 0;
$$;

revoke all on function gm_use(date, text, text, text, uuid, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function gm_unuse(date, text, text, text, uuid) from public, anon, authenticated;
grant execute on function gm_use(date, text, text, text, uuid, integer, integer, integer, integer) to service_role;
grant execute on function gm_unuse(date, text, text, text, uuid) to service_role;

-- ---------- 2. Rooms: no cap, 30-day cleanup ----------
-- The cap is gone: make_room_space() stays but removes nothing, and browsers can no longer call it.
create or replace function make_room_space() returns integer language sql security definer set search_path = public as 'select 0';
revoke execute on function make_room_space() from public, anon, authenticated;

-- When a solo story was last paused with its story code. Only the server-side pause_room() sets it.
alter table rooms add column if not exists paused_at timestamptz;

create or replace function pause_room(p_room text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_room(p_room) then return false; end if;
  update rooms set paused_at = now() where code = p_room;
  return found;
end $$;
revoke all on function pause_room(text) from public;
grant execute on function pause_room(text) to authenticated, service_role;

-- Deletes guest tables idle for p_days (no story activity, and not paused in that time). Returns how many.
create or replace function cleanup_idle_rooms(p_days integer default 30) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_days is null or p_days < 1 then return 0; end if;
  delete from rooms
   where kind = 'guest'
     and last_played < now() - make_interval(days => p_days)
     and (paused_at is null or paused_at < now() - make_interval(days => p_days));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function cleanup_idle_rooms(integer) from public, anon, authenticated;
grant execute on function cleanup_idle_rooms(integer) to service_role;
