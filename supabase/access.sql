-- The Ledger — tighter access. Run once in the Supabase SQL Editor, after accounts.sql, soft-launch.sql and
-- loot.sql. Safe to re-run.
-- 1. Tags (minis, loot) can't be listed. The tap screen looks up one tag by its ID (tag_public), and the ID
--    is only known from the sticker.
-- 2. Browsers keep only the table rights the site uses; server-only tables are closed to them entirely.

-- ---------- 1. tags ----------
drop policy if exists "tags are readable" on tags;
revoke all on tags from anon, authenticated;

-- What the tap screen shows for one tag: only the fields it uses for that kind of tag (a hero's sheet,
-- a monster's name and CR, a loot item's name, description and contents). Null when there's no such tag.
create or replace function tag_public(p_id text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', t.id, 'kind', t.kind, 'status', t.status, 'moved_to', t.moved_to,
                            'used_at', t.used_at, 'used_by', t.used_by,
           'data', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(t.data) e
                     where e.key = any (case t.kind
                       when 'hero' then array['name', 'race', 'klass', 'level', 'ac', 'hp', 'maxhp', 'xp', 'str', 'dex', 'con',
                                              'int', 'wis', 'cha', 'skills', 'inventory', 'spells', 'notes', 'appearance', 'gender', 'age']
                       when 'monster' then array['name', 'cr']
                       when 'item' then array['name', 'description', 'items']
                       else array[]::text[] end)))
    from tags t where t.id = p_id;
$$;
revoke all on function tag_public(text) from public;
grant execute on function tag_public(text) to anon, authenticated, service_role;

-- ---------- 2. table rights ----------
-- The tap log's copy-watch view is for the owner only (it reads the log as its caller, so it was already
-- empty to browsers; now they can't query it at all).
do $$ begin
  if to_regclass('public.tag_copy_watch') is not null then
    execute 'revoke all on tag_copy_watch from public, anon, authenticated';
  end if;
end $$;
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['wallets', 'credit_grants', 'accounts', 'fallen_heroes', 'tag_batches', 'tag_claims',
                           'tag_events', 'tag_snapshots', 'room_members', 'gm_usage'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on %I from anon, authenticated', t);
    end if;
  end loop;
end $$;
-- Browsers: rooms are read and their meta changed (rows limited to members by the room rules); heroes and
-- the story log are read and added to. Nothing is deleted from a browser.
revoke all on rooms, characters, log_entries from anon;
revoke delete on rooms, characters, log_entries from authenticated;
