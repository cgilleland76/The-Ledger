-- The Ledger — Hall of the Fallen. Run once in the Supabase SQL Editor. Safe to re-run.
-- Every hero's death is recorded by the server (/api/fallen) with a one-line best achievement written
-- from the story. The home page shows the last 35 who stayed dead; each player's Account page shows
-- their own heroes' deaths, including any who were brought back ("returned").

create table if not exists fallen_heroes (
  id           bigserial primary key,
  room_code    text not null,
  character_id text not null,
  died_at      timestamptz not null,
  name         text not null,
  race         text,
  klass        text,
  level        integer,
  story        text,
  cause        text,
  achievement  text,
  epitaph      text,
  owner_hash   text,                       -- sha256 of the hero's player's ink key
  returned     boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (room_code, character_id, died_at)
);
create index if not exists idx_fallen_recent on fallen_heroes(died_at desc) where not returned;
create index if not exists idx_fallen_owner on fallen_heroes(owner_hash, died_at desc);
alter table fallen_heroes enable row level security; -- written by the server only; read through the functions below

-- The Hall: the most recent heroes who stayed dead (no owner details).
create or replace function hall_of_fallen(p_limit integer default 35) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'race', race, 'klass', klass, 'level', level, 'story', story,
           'cause', cause, 'achievement', achievement, 'epitaph', epitaph, 'died_at', died_at) order by died_at desc), '[]'::jsonb)
    from (select * from fallen_heroes where not returned order by died_at desc limit least(greatest(p_limit, 1), 35)) f;
$$;

-- One player's own log (all of their heroes' deaths, returned ones included).
create or replace function my_fallen(p_owner text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'race', race, 'klass', klass, 'level', level, 'story', story,
           'cause', cause, 'achievement', achievement, 'epitaph', epitaph, 'died_at', died_at, 'returned', returned) order by died_at desc), '[]'::jsonb)
    from (select * from fallen_heroes where owner_hash = p_owner and p_owner ~ '^[0-9a-f]{64}$' order by died_at desc limit 100) f;
$$;

revoke all on function hall_of_fallen(integer) from public;
revoke all on function my_fallen(text) from public;
grant execute on function hall_of_fallen(integer) to anon, authenticated, service_role;
grant execute on function my_fallen(text) to anon, authenticated, service_role;
