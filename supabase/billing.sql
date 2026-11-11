-- The Ledger — credits ("ink") for the paywall.
-- Run this once in the Supabase SQL Editor, after schema.sql. Safe to re-run.
--
-- Each device/app install has a random player id. Its wallet holds a free monthly
-- allowance (reset on the 1st, UTC) plus paid ink bought through Google Play
-- (verified by RevenueCat). Spending is done only by the Netlify functions using the
-- service-role key: these tables have Row Level Security on and NO policies, so the
-- public anon key in the browser can't read or change anyone's balance.

create table if not exists wallets (
  player_id    text primary key check (player_id ~ '^[a-z0-9]{16,40}$'),
  free_period  text not null default '',          -- 'YYYY-MM' the free_used count belongs to
  free_used    integer not null default 0,
  paid_balance integer not null default 0 check (paid_balance >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per store purchase that has been turned into ink, so the same purchase
-- can never be credited twice.
create table if not exists credit_grants (
  transaction_id text primary key,
  player_id      text not null,
  product_id     text not null,
  credits        integer not null check (credits > 0),
  sandbox        boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists idx_credit_grants_player on credit_grants(player_id);

alter table wallets enable row level security;
alter table credit_grants enable row level security;

-- Atomically spends p_cost ink: free allowance first, then paid ink.
-- Returns {ok, free_left, paid, from_free, from_paid}.
create or replace function spend_credits(p_player text, p_cost integer, p_free_monthly integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w wallets;
  cur text := to_char(now() at time zone 'utc', 'YYYY-MM');
  used integer;
  free_left integer;
  ff integer;
  fp integer;
begin
  insert into wallets(player_id) values (p_player) on conflict do nothing;
  select * into w from wallets where player_id = p_player for update;
  used := case when w.free_period = cur then w.free_used else 0 end;
  free_left := greatest(p_free_monthly - used, 0);
  if free_left + w.paid_balance < p_cost then
    return jsonb_build_object('ok', false, 'free_left', free_left, 'paid', w.paid_balance, 'from_free', 0, 'from_paid', 0);
  end if;
  ff := least(free_left, p_cost);
  fp := p_cost - ff;
  update wallets
     set free_period = cur, free_used = used + ff, paid_balance = w.paid_balance - fp, updated_at = now()
   where player_id = p_player;
  return jsonb_build_object('ok', true, 'free_left', free_left - ff, 'paid', w.paid_balance - fp, 'from_free', ff, 'from_paid', fp);
end $$;

-- Gives back ink when the GM or portrait service failed after it was spent.
create or replace function refund_credits(p_player text, p_from_free integer, p_from_paid integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update wallets
     set free_used = case when free_period = to_char(now() at time zone 'utc', 'YYYY-MM')
                          then greatest(free_used - greatest(p_from_free, 0), 0) else free_used end,
         paid_balance = paid_balance + greatest(p_from_paid, 0),
         updated_at = now()
   where player_id = p_player;
end $$;

-- Credits one verified purchase. Returns true if it was new, false if already credited.
create or replace function grant_credits(p_tx text, p_player text, p_product text, p_credits integer, p_sandbox boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare inserted integer;
begin
  insert into credit_grants(transaction_id, player_id, product_id, credits, sandbox)
  values (p_tx, p_player, p_product, p_credits, p_sandbox)
  on conflict (transaction_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return false; end if;
  insert into wallets(player_id) values (p_player) on conflict do nothing;
  update wallets set paid_balance = paid_balance + p_credits, updated_at = now() where player_id = p_player;
  return true;
end $$;

-- Only the server (service role) may call these.
revoke all on function spend_credits(text, integer, integer) from public, anon, authenticated;
revoke all on function refund_credits(text, integer, integer) from public, anon, authenticated;
revoke all on function grant_credits(text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function spend_credits(text, integer, integer) to service_role;
grant execute on function refund_credits(text, integer, integer) to service_role;
grant execute on function grant_credits(text, text, text, integer, boolean) to service_role;
