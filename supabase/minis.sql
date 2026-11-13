-- The Ledger — blank hero minis, claim codes, backups, moves, recovery and the tag register.
-- Run once in the Supabase SQL Editor, after tags.sql and tags-phase2.sql. Safe to re-run.
--
-- * Every mini in a kit is registered: tag_batches (a print run) and tag_claims (one row per blank
--   mini: batch, serial number, and the SHA-256 hash of its secret claim code; the code itself is never
--   stored). A code only works if it's registered, its batch is active, and it hasn't been used.
-- * tag_events logs every tap, forge, failed code, save, move and recovery (with a hashed player key,
--   never the raw ink key), so copied stickers and code guessing show up. See the tag_copy_watch view.
-- * tag_snapshots keeps the last 10 saved versions of each hero.
-- * Owners are stored as a hash of the ink key (tags are publicly readable; the raw key let anyone
--   spend that player's ink). Existing raw keys are converted below.
-- * All writes go through the functions below (service role only), each a single transaction.

-- ---------- tags: status, moves, timestamps ----------
alter table tags add column if not exists status text not null default 'active';
alter table tags add column if not exists moved_to text;
alter table tags add column if not exists last_played timestamptz;
alter table tags add column if not exists forged_at timestamptz;
do $$ begin
  alter table tags add constraint tags_status_check check (status in ('blank', 'active', 'moved', 'disabled'));
exception when duplicate_object then null; end $$;

-- Owners become hashes of the ink key (raw keys are 24 characters; hashes are 64 hex characters).
update tags set claimed_by = encode(extensions.digest(claimed_by, 'sha256'), 'hex')
 where claimed_by is not null and length(claimed_by) <> 64;

-- ---------- register of kits and claim codes ----------
create table if not exists tag_batches (
  batch      text primary key,
  kind       text not null default 'hero',
  size       integer not null default 0,
  active     boolean not null default true,     -- false: every code in this batch stops working
  notes      text,
  created_at timestamptz not null default now()
);
create table if not exists tag_claims (
  tag_id     text primary key references tags(id) on delete cascade,
  batch      text not null references tag_batches(batch),
  serial     integer not null,
  claim_hash text not null unique,              -- sha256 of the normalised claim code
  issued_at  timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,                              -- owner hash at first claim
  unique (batch, serial)
);
create table if not exists tag_events (
  id       bigserial primary key,
  tag_id   text,
  event    text not null,   -- tap | forge | claim_bad_code | save | restore | move_out | move_in | recover | recover_bad | limit
  key_hash text,
  detail   text,
  at       timestamptz not null default now()
);
create index if not exists idx_tag_events_tag on tag_events(tag_id, at);
create index if not exists idx_tag_events_key on tag_events(key_hash, at);
create table if not exists tag_snapshots (
  id       bigserial primary key,
  tag_id   text not null references tags(id) on delete cascade,
  data     jsonb not null,
  saved_at timestamptz not null default now()
);
create index if not exists idx_tag_snapshots_tag on tag_snapshots(tag_id, saved_at desc);

-- Server-only tables: RLS on, no policies.
alter table tag_batches enable row level security;
alter table tag_claims enable row level security;
alter table tag_events enable row level security;
alter table tag_snapshots enable row level security;

-- Possible copies: minis tapped by many different players in the last day.
create or replace view tag_copy_watch with (security_invoker = true) as
  select tag_id, count(distinct key_hash) as players_24h, count(*) as taps_24h, max(at) as last_tap
    from tag_events
   where event = 'tap' and at > now() - interval '24 hours'
   group by tag_id
  having count(distinct key_hash) >= 5
   order by players_24h desc;

-- ---------- helpers ----------
create or replace function tag_log(p_tag text, p_event text, p_key text, p_detail text default null)
returns void language sql security definer set search_path = public as $$
  insert into tag_events(tag_id, event, key_hash, detail) values (p_tag, p_event, p_key, left(p_detail, 300));
$$;

-- Saves new data onto an active hero tag: snapshot it, keep the latest 10. Claims an unowned tag.
create or replace function tag_save(p_tag text, p_data jsonb, p_owner text, p_event text default 'save')
returns jsonb language plpgsql security definer set search_path = public as $$
declare t tags;
begin
  select * into t from tags where id = p_tag for update;
  if not found or t.kind <> 'hero' then return jsonb_build_object('ok', false, 'code', 'no_tag'); end if;
  if t.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'not_active', 'status', t.status, 'moved_to', t.moved_to); end if;
  if t.claimed_by is not null and t.claimed_by <> p_owner then return jsonb_build_object('ok', false, 'code', 'not_owner'); end if;
  update tags set data = p_data, claimed_by = coalesce(claimed_by, p_owner), updated_at = now(), last_played = now() where id = p_tag;
  insert into tag_snapshots(tag_id, data) values (p_tag, p_data);
  delete from tag_snapshots where tag_id = p_tag and id not in (select id from tag_snapshots where tag_id = p_tag order by saved_at desc, id desc limit 10);
  perform tag_log(p_tag, p_event, p_owner, null);
  return jsonb_build_object('ok', true, 'claimed', t.claimed_by is null);
end $$;

-- Forges a hero onto a blank mini, identified by its claim code. Free (no ink). Limits per owner.
create or replace function tag_forge(p_claim_hash text, p_owner text, p_data jsonb, p_tag text default null,
                                     p_max_total integer default 25, p_max_day integer default 3)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c tag_claims; t tags; b tag_batches; n_total integer; n_day integer;
begin
  select * into c from tag_claims where claim_hash = p_claim_hash for update;
  if not found or (p_tag is not null and c.tag_id <> p_tag) then
    perform tag_log(p_tag, 'claim_bad_code', p_owner, 'forge');
    return jsonb_build_object('ok', false, 'code', 'bad_code');
  end if;
  select * into b from tag_batches where batch = c.batch;
  if not b.active then perform tag_log(c.tag_id, 'claim_bad_code', p_owner, 'batch inactive'); return jsonb_build_object('ok', false, 'code', 'batch_inactive'); end if;
  select * into t from tags where id = c.tag_id for update;
  if c.claimed_at is not null or t.status <> 'blank' then return jsonb_build_object('ok', false, 'code', 'already_claimed'); end if;
  select count(*) into n_total from tags where claimed_by = p_owner and status = 'active' and kind = 'hero';
  select count(*) into n_day from tags where claimed_by = p_owner and forged_at > now() - interval '24 hours';
  if n_total >= p_max_total or n_day >= p_max_day then
    perform tag_log(c.tag_id, 'limit', p_owner, format('total %s, today %s', n_total, n_day));
    return jsonb_build_object('ok', false, 'code', 'limit');
  end if;
  update tags set data = p_data, status = 'active', claimed_by = p_owner, forged_at = now(), updated_at = now(), last_played = now() where id = c.tag_id;
  update tag_claims set claimed_at = now(), claimed_by = p_owner where tag_id = c.tag_id;
  insert into tag_snapshots(tag_id, data) values (c.tag_id, p_data);
  perform tag_log(c.tag_id, 'forge', p_owner, format('batch %s serial %s', c.batch, c.serial));
  return jsonb_build_object('ok', true, 'tag_id', c.tag_id, 'batch', c.batch, 'serial', c.serial);
end $$;

-- Moves a hero to a new blank mini (by its claim code). One transaction: the new tag becomes active
-- and the old one becomes 'moved' together, or nothing changes.
create or replace function tag_move(p_from text, p_claim_hash text, p_owner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f tags; c tag_claims; t tags; b tag_batches;
begin
  select * into f from tags where id = p_from for update;
  if not found or f.kind <> 'hero' or f.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'not_active'); end if;
  if f.claimed_by is distinct from p_owner then return jsonb_build_object('ok', false, 'code', 'not_owner'); end if;
  select * into c from tag_claims where claim_hash = p_claim_hash for update;
  if not found then perform tag_log(p_from, 'claim_bad_code', p_owner, 'move'); return jsonb_build_object('ok', false, 'code', 'bad_code'); end if;
  select * into b from tag_batches where batch = c.batch;
  if not b.active then return jsonb_build_object('ok', false, 'code', 'batch_inactive'); end if;
  select * into t from tags where id = c.tag_id for update;
  if c.claimed_at is not null or t.status <> 'blank' then return jsonb_build_object('ok', false, 'code', 'already_claimed'); end if;
  update tags set data = f.data, status = 'active', claimed_by = p_owner, forged_at = now(), updated_at = now(), last_played = f.last_played where id = t.id;
  update tag_claims set claimed_at = now(), claimed_by = p_owner where tag_id = t.id;
  update tags set status = 'moved', moved_to = t.id, updated_at = now() where id = f.id;
  insert into tag_snapshots(tag_id, data) values (t.id, f.data);
  perform tag_log(f.id, 'move_out', p_owner, t.id);
  perform tag_log(t.id, 'move_in', p_owner, f.id);
  return jsonb_build_object('ok', true, 'from', f.id, 'to', t.id);
end $$;

-- Restores one of a hero's last 10 snapshots (the restore is itself saved as a new snapshot).
create or replace function tag_restore(p_tag text, p_snapshot bigint, p_owner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s tag_snapshots;
begin
  select * into s from tag_snapshots where id = p_snapshot and tag_id = p_tag;
  if not found then return jsonb_build_object('ok', false, 'code', 'no_snapshot'); end if;
  return tag_save(p_tag, s.data, p_owner, 'restore');
end $$;

-- Lost ink key: the mini's original claim code moves ownership to the caller's key.
-- At most 5 wrong codes per mini per hour.
create or replace function tag_recover(p_tag text, p_claim_hash text, p_new_owner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c tag_claims; bad integer;
begin
  select count(*) into bad from tag_events where tag_id = p_tag and event = 'recover_bad' and at > now() - interval '1 hour';
  if bad >= 5 then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;
  select * into c from tag_claims where tag_id = p_tag;
  if not found or c.claim_hash <> p_claim_hash then
    perform tag_log(p_tag, 'recover_bad', p_new_owner, null);
    return jsonb_build_object('ok', false, 'code', 'bad_code');
  end if;
  update tags set claimed_by = p_new_owner, updated_at = now() where id = p_tag and status in ('active', 'moved');
  if not found then return jsonb_build_object('ok', false, 'code', 'not_active'); end if;
  perform tag_log(p_tag, 'recover', p_new_owner, null);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function tag_log(text, text, text, text) from public, anon, authenticated;
revoke all on function tag_save(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function tag_forge(text, text, jsonb, text, integer, integer) from public, anon, authenticated;
revoke all on function tag_move(text, text, text) from public, anon, authenticated;
revoke all on function tag_restore(text, bigint, text) from public, anon, authenticated;
revoke all on function tag_recover(text, text, text) from public, anon, authenticated;
grant execute on function tag_log(text, text, text, text) to service_role;
grant execute on function tag_save(text, jsonb, text, text) to service_role;
grant execute on function tag_forge(text, text, jsonb, text, integer, integer) to service_role;
grant execute on function tag_move(text, text, text) to service_role;
grant execute on function tag_restore(text, bigint, text) to service_role;
grant execute on function tag_recover(text, text, text) to service_role;
