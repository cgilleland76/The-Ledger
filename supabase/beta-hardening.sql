-- The Ledger — beta hardening. Run once in the Supabase SQL Editor, after soft-launch.sql. Safe to re-run.
-- The daily usage counter (gm_usage) also counts Hall of the Fallen entries ('memorial') and uploaded
-- portraits ('upload'), so the server functions can limit them per player and per IP a day.
-- Until this is run, those two are refused (the functions fail closed), so run it with the deploy.

alter table gm_usage drop constraint if exists gm_usage_what_check;
alter table gm_usage add constraint gm_usage_what_check check (what in ('gm', 'portrait', 'scene', 'memorial', 'upload'));

create or replace function gm_use(p_day date, p_what text, p_room text, p_ip text, p_user uuid,
                                  p_room_max integer, p_ip_max integer, p_user_max integer, p_day_max integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_day is null or p_room is null or p_user is null or p_ip !~ '^[0-9a-f]{64}$'
     or p_what not in ('gm', 'portrait', 'scene', 'memorial', 'upload') then
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

revoke all on function gm_use(date, text, text, text, uuid, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function gm_use(date, text, text, text, uuid, integer, integer, integer, integer) to service_role;
