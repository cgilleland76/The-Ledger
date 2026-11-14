-- The Ledger — free "setup" GM requests (story title/tone, Generate Character, filling a character's
-- blanks) are capped per table so they can't be used as free story turns. Run once in the Supabase SQL
-- Editor, after accounts.sql. Safe to re-run. Browsers can't change setup_count (they may only write
-- rooms.meta); only the GM function, with the service-role key, counts it.
alter table rooms add column if not exists setup_count integer not null default 0;

-- Counts one setup request for a table; false when the table has used its allowance.
create or replace function use_setup(p_room text, p_max integer) returns boolean
language sql security definer set search_path = public as $$
  with u as (update rooms set setup_count = setup_count + 1 where code = p_room and setup_count < p_max returning 1)
  select exists (select 1 from u);
$$;
revoke all on function use_setup(text, integer) from public, anon, authenticated;
grant execute on function use_setup(text, integer) to service_role;
