-- The Ledger — one GM story turn at a time per table. Run once in the Supabase SQL Editor, after accounts.sql.
-- Safe to re-run.
--
-- When a player asks the GM to continue, the server (netlify/functions/gm.js) claims the table's turn before
-- anything is counted or spent. While it's held, other players' asks are refused and their screens show
-- "The GM is already answering". The turn is let go when:
--   * the asking player's app has logged the reply (or they cancelled): gm_turn_done(), from that browser
--   * the call produced no reply (Claude down, out of ink, a limit): gm_turn_end(), from the server
--   * 90 seconds have passed (a closed tab, a lost connection): the next claim simply takes it over
-- Browsers can read rooms.gm_turn_at (for the message) but can't set it; only these functions do.

alter table rooms add column if not exists gm_turn_at timestamptz;  -- when the current turn was claimed
alter table rooms add column if not exists gm_turn_by uuid;         -- who claimed it

-- Server: claim the turn. True if the table was free, the last turn is older than p_ttl seconds, or the same
-- player holds it (the app retries once after a dropped connection). One UPDATE, so two players asking at
-- the same moment can't both get it.
create or replace function gm_turn_start(p_room text, p_user uuid, p_ttl integer) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update rooms set gm_turn_at = now(), gm_turn_by = p_user
   where code = p_room
     and (gm_turn_at is null or gm_turn_at < now() - make_interval(secs => greatest(p_ttl, 1)) or gm_turn_by = p_user);
  return found;
end $$;

-- Server: give back a turn that produced no reply. Only the holder's turn is cleared.
create or replace function gm_turn_end(p_room text, p_user uuid) returns void
language sql security definer set search_path = public as $$
  update rooms set gm_turn_at = null, gm_turn_by = null where code = p_room and gm_turn_by = p_user;
$$;

-- Browser: the player whose turn it was has logged the reply (or cancelled). Only their own turn is cleared.
create or replace function gm_turn_done(p_room text) returns void
language sql security definer set search_path = public as $$
  update rooms set gm_turn_at = null, gm_turn_by = null where code = p_room and gm_turn_by = auth.uid();
$$;

revoke all on function gm_turn_start(text, uuid, integer) from public, anon, authenticated;
revoke all on function gm_turn_end(text, uuid) from public, anon, authenticated;
revoke all on function gm_turn_done(text) from public, anon;
grant execute on function gm_turn_start(text, uuid, integer) to service_role;
grant execute on function gm_turn_end(text, uuid) to service_role;
grant execute on function gm_turn_done(text) to authenticated, service_role;
