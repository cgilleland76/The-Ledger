-- The Ledger — NFC tap-to-play minis (see NFC-MINIS.md).
-- Run this once in the Supabase SQL Editor, after schema.sql. Safe to re-run.
--
-- Each NFC sticker in a mini's base holds one link: https://<site>/t/<tag id>.
-- The id's prefix says what it is: h_ hero, m_ monster (i_ item and k_ keystone come later).
-- Anyone holding a mini can read its link, so tags are publicly readable, but there are
-- NO insert/update/delete policies: only the service-role key (SQL editor, Netlify
-- functions, scripts) can create or change tags.

create table if not exists tags (
  id         text primary key check (id ~ '^[hmik]_[a-z0-9]{10,40}$'),
  kind       text not null check (kind in ('hero', 'monster', 'item', 'keystone')),
  data       jsonb not null default '{}'::jsonb,  -- hero: a character sheet; monster: { name, cr }
  batch      text,                                -- which kit / print run it came from
  created_at timestamptz not null default now()
);

alter table tags enable row level security;
drop policy if exists "tags are readable" on tags;
create policy "tags are readable" on tags for select using (true);

-- ---- Test tags for the phase 1 proof of concept ----
-- Write these links onto NFC stickers (e.g. with the free "NFC Tools" app → Write → Add a record → URL):
--   https://thedndledger.com/t/h_dcvj6p3fcua6   Brannoc Ironvein (hero)
--   https://thedndledger.com/t/h_fw93a8x7apf9   Sera Quickfingers (hero)
--   https://thedndledger.com/t/m_9tmwv2jqd2u3   Goblin (monster)
--   https://thedndledger.com/t/m_ackqeq4x8mrg   Owlbear (monster)
insert into tags (id, kind, batch, data) values
('h_dcvj6p3fcua6', 'hero', 'test-1', '{
  "name": "Brannoc Ironvein", "race": "Dwarf", "klass": "Fighter", "level": 1,
  "hp": 12, "maxhp": 12, "ac": 16,
  "str": 16, "dex": 12, "con": 15, "int": 10, "wis": 13, "cha": 8,
  "skills": [{"name": "Athletics", "mod": 5}, {"name": "Perception", "mod": 3}, {"name": "Intimidation", "mod": 1}],
  "inventory": ["Battleaxe", "Handaxe (2)", "Chain mail", "Explorer''s pack", "Tinderbox"],
  "spells": [],
  "notes": "Former mine foreman. Never leaves a miner behind.",
  "appearance": "Stocky dwarf with a braided copper beard, soot-dark chain mail and a dented iron helm",
  "gender": "male", "age": "87"
}'::jsonb),
('h_fw93a8x7apf9', 'hero', 'test-1', '{
  "name": "Sera Quickfingers", "race": "Halfling", "klass": "Rogue", "level": 1,
  "hp": 9, "maxhp": 9, "ac": 14,
  "str": 8, "dex": 17, "con": 12, "int": 13, "wis": 12, "cha": 14,
  "skills": [{"name": "Stealth", "mod": 7}, {"name": "Sleight of Hand", "mod": 5}, {"name": "Acrobatics", "mod": 5}, {"name": "Perception", "mod": 3}, {"name": "Deception", "mod": 4}],
  "inventory": ["Shortsword", "Shortbow and 20 arrows", "Leather armor", "Thieves'' tools", "Burglar''s pack"],
  "spells": [],
  "notes": "Owes a favour to a fence in every port town.",
  "appearance": "Small halfling with quick green eyes, a patched hooded cloak and a grin that hides something",
  "gender": "female", "age": "26"
}'::jsonb),
('m_9tmwv2jqd2u3', 'monster', 'test-1', '{"name": "Goblin", "cr": "1/4"}'::jsonb),
('m_ackqeq4x8mrg', 'monster', 'test-1', '{"name": "Owlbear", "cr": "3"}'::jsonb)
on conflict (id) do nothing;
