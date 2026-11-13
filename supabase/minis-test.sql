-- The Ledger — self-check for minis.sql. Paste into the Supabase SQL Editor and Run.
-- It makes three test minis (batch ZZTEST), runs every case, then deliberately raises an error so
-- EVERYTHING is rolled back. The "error" message IS the test report; nothing is left in the database.
do $$
declare r jsonb; out text := ''; snap bigint; i int;
  hA text := encode(extensions.digest('claim:ZZA','sha256'),'hex');
  hB text := encode(extensions.digest('claim:ZZB','sha256'),'hex');
  hC text := encode(extensions.digest('claim:ZZC','sha256'),'hex');
  me text := repeat('a',64); them text := repeat('b',64);
begin
  insert into tag_batches(batch, kind, size) values ('ZZTEST','hero',3);
  insert into tags(id, kind, batch, status, data) values ('h_zztest00000a','hero','ZZTEST','blank','{}'),('h_zztest00000b','hero','ZZTEST','blank','{}'),('h_zztest00000c','hero','ZZTEST','blank','{}');
  insert into tag_claims(tag_id,batch,serial,claim_hash) values ('h_zztest00000a','ZZTEST',1,hA),('h_zztest00000b','ZZTEST',2,hB),('h_zztest00000c','ZZTEST',3,hC);

  r := tag_forge(encode(extensions.digest('claim:WRONG','sha256'),'hex'), me, '{"name":"X"}');
  out := out || 'wrong code (expect bad_code): ' || (r->>'code') || E'\n';
  r := tag_forge(hA, me, '{"name":"Testa","level":1}');
  out := out || 'forge (expect true): ' || (r->>'ok') || ' serial ' || (r->>'serial') || E'\n';
  r := tag_forge(hA, them, '{"name":"Y"}');
  out := out || 'reuse code (expect already_claimed): ' || (r->>'code') || E'\n';
  r := tag_save('h_zztest00000a', '{"name":"Testa","level":2}', me);
  out := out || 'save (expect true): ' || (r->>'ok') || E'\n';
  r := tag_save('h_zztest00000a', '{"name":"Hacked"}', them);
  out := out || 'save by other key (expect not_owner): ' || (r->>'code') || E'\n';

  select id into snap from tag_snapshots where tag_id='h_zztest00000a' and data->>'level'='1';
  r := tag_restore('h_zztest00000a', snap, me);
  out := out || 'restore (expect true, level 1): ' || (r->>'ok') || ', level ' || (select data->>'level' from tags where id='h_zztest00000a') || E'\n';

  -- failure halfway through a move: a temporary trigger breaks the snapshot step
  create function pg_temp.boom() returns trigger language plpgsql as 'begin raise exception ''boom''; end';
  create trigger zz_boom before insert on tag_snapshots for each row execute function pg_temp.boom();
  begin
    r := tag_move('h_zztest00000a', hB, me);
  exception when others then out := out || 'halfway failure raised: ' || sqlerrm || E'\n';
  end;
  drop trigger zz_boom on tag_snapshots;
  out := out || '  after failure (expect old=active, new=blank, code used=no): old=' || (select status from tags where id='h_zztest00000a')
        || ', new=' || (select status from tags where id='h_zztest00000b')
        || ', code used=' || coalesce((select claimed_at::text from tag_claims where tag_id='h_zztest00000b'),'no') || E'\n';

  perform tag_forge(hC, them, '{"name":"Other"}');
  r := tag_move('h_zztest00000a', hC, me);
  out := out || 'move onto claimed mini (expect already_claimed): ' || (r->>'code') || E'\n';

  r := tag_move('h_zztest00000a', hB, me);
  out := out || 'good move (expect true; old moved, new active Testa): ' || (r->>'ok') || '; old=' || (select status||'->'||moved_to from tags where id='h_zztest00000a')
        || ', new=' || (select status||' '||(data->>'name') from tags where id='h_zztest00000b') || E'\n';
  r := tag_save('h_zztest00000a', '{"name":"Ghost"}', me);
  out := out || 'save to moved mini (expect not_active): ' || (r->>'code') || E'\n';

  r := tag_recover('h_zztest00000b', hB, them);
  out := out || 'recover with right code (expect true): ' || (r->>'ok') || E'\n';
  for i in 1..5 loop perform tag_recover('h_zztest00000c', hA, me); end loop;
  r := tag_recover('h_zztest00000c', hC, me);
  out := out || 'recover after 5 wrong codes (expect rate_limited): ' || (r->>'code') || E'\n';

  for i in 1..6 loop perform tag_log('h_zztest00000b','tap', md5(i::text), null); end loop;
  out := out || 'copy watch (expect 6 players): ' || coalesce((select players_24h::text from tag_copy_watch where tag_id='h_zztest00000b'),'none') || E'\n';

  raise exception E'TEST RESULTS (all rolled back)\n%', out;
end $$;
