-- The Ledger — loot minis are single-use. Run once in the Supabase SQL Editor (after minis.sql and
-- accounts.sql). Safe to re-run.
-- A loot coin or chest (an i_ tag) comes from a bought kit and can be opened ONCE, ever. Opening it puts
-- its items in one hero's pack and marks the tag 'used', in one transaction, so two phones tapping the
-- same coin can't both get it. A used tag shows "already opened" from then on.

alter table tags add column if not exists used_at   timestamptz;
alter table tags add column if not exists used_room text;
alter table tags add column if not exists used_by   text;   -- the hero's name, for "opened by ..."

alter table tags drop constraint if exists tags_status_check;
alter table tags add constraint tags_status_check check (status in ('blank', 'active', 'moved', 'disabled', 'used'));

-- p_inventory is the hero's whole pack with the loot added (the app does the stacking).
-- Anyone who can play at the table may call it, the same people who can already edit its heroes.
create or replace function loot_open(p_tag text, p_room text, p_character text, p_inventory jsonb, p_key_hash text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t tags%rowtype; ch characters%rowtype;
begin
  if not can_use_room(p_room) then return jsonb_build_object('ok', false, 'code', 'no_room'); end if;
  select * into t from tags where id = p_tag and kind = 'item' for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'missing'); end if;
  if t.status = 'used' then return jsonb_build_object('ok', false, 'code', 'used', 'used_at', t.used_at, 'used_by', t.used_by); end if;
  if t.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'not_active'); end if;
  select * into ch from characters where id = p_character and room_code = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'no_character'); end if;
  if jsonb_typeof(p_inventory) <> 'array' or jsonb_array_length(p_inventory) > 80 then
    return jsonb_build_object('ok', false, 'code', 'bad_inventory');
  end if;
  update characters set data = jsonb_set(coalesce(data, '{}'::jsonb), '{inventory}', p_inventory) where id = ch.id and room_code = p_room;
  update tags set status = 'used', used_at = now(), used_room = p_room, used_by = left(coalesce(ch.data ->> 'name', ''), 60), updated_at = now() where id = t.id;
  insert into tag_events (tag_id, event, key_hash, detail)
    values (t.id, 'loot_open', case when p_key_hash ~ '^[0-9a-f]{64}$' then p_key_hash end, p_room || ' ' || p_character);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function loot_open(text, text, text, jsonb, text) from public;
grant execute on function loot_open(text, text, text, jsonb, text) to anon, authenticated, service_role;
