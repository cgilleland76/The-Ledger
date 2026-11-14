-- The Ledger — free story, paid extras. Run once in the Supabase SQL Editor, after billing.sql. Safe to re-run.
--
-- * Story turns (GM replies) are free up to a daily allowance (30 by default, FREE_STORY_TURNS_PER_DAY),
--   which refills at the player's own midnight. Past that, a story turn costs 1 bought ink.
-- * Extras (AI portraits, AI scene paintings) are paid with bought ink only, never the free turns.
-- wallets.free_period now holds the player's local date ('YYYY-MM-DD'); the day only ever moves forward,
-- so switching time zones can't hand out extra free turns. The old monthly functions stay, unused.

create or replace function spend_credits_daily(p_player text, p_cost integer, p_free_daily integer, p_today text, p_use_free boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w wallets;
  today text := case when p_today ~ '^\d{4}-\d{2}-\d{2}$' then p_today else to_char(now() at time zone 'utc', 'YYYY-MM-DD') end;
  period text;
  used integer;
  free_left integer;
  ff integer := 0;
  fp integer;
begin
  insert into wallets(player_id) values (p_player) on conflict do nothing;
  select * into w from wallets where player_id = p_player for update;
  if w.free_period ~ '^\d{4}-\d{2}-\d{2}$' and (w.free_period >= today or not p_use_free) then
    period := w.free_period; used := w.free_used;          -- same day (or an extra, which never moves the day)
  elsif not p_use_free then
    period := w.free_period; used := w.free_used;          -- old monthly row: leave it until the next story turn
  else
    period := today; used := 0;                            -- a new day
  end if;
  free_left := greatest(p_free_daily - used, 0);
  if p_use_free then ff := least(free_left, p_cost); end if;
  fp := p_cost - ff;
  if fp > w.paid_balance then
    return jsonb_build_object('ok', false, 'free_left', case when period ~ '^\d{4}-\d{2}-\d{2}$' and period >= today then free_left else p_free_daily end,
                              'paid', w.paid_balance, 'from_free', 0, 'from_paid', 0);
  end if;
  update wallets set free_period = period, free_used = used + ff, paid_balance = w.paid_balance - fp, updated_at = now()
   where player_id = p_player;
  return jsonb_build_object('ok', true, 'free_left', free_left - ff, 'paid', w.paid_balance - fp, 'from_free', ff, 'from_paid', fp);
end $$;

-- Gives back what a failed GM/portrait/scene request spent.
create or replace function refund_credits_daily(p_player text, p_from_free integer, p_from_paid integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update wallets
     set free_used = greatest(free_used - greatest(p_from_free, 0), 0),
         paid_balance = paid_balance + greatest(p_from_paid, 0),
         updated_at = now()
   where player_id = p_player;
end $$;

revoke all on function spend_credits_daily(text, integer, integer, text, boolean) from public, anon, authenticated;
revoke all on function refund_credits_daily(text, integer, integer) from public, anon, authenticated;
grant execute on function spend_credits_daily(text, integer, integer, text, boolean) to service_role;
grant execute on function refund_credits_daily(text, integer, integer) to service_role;
