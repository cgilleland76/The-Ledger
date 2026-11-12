-- The Ledger — NFC minis, phase 2 (see NFC-MINIS.md). Run after tags.sql. Safe to re-run.
--
-- Heroes level up on the mini: the hero-save Netlify function (service-role key) writes a
-- hero's progress back onto its tag. The first player to save claims the mini (claimed_by =
-- their ink key); only they can save to it again. Anyone can still play it.
alter table tags add column if not exists claimed_by text;
alter table tags add column if not exists updated_at timestamptz;

-- Loot coins (i_ tags): tapping one adds the item to your character at your table.
-- data: { name, description }
--   https://thedndledger.com/t/i_5jeq5e28sk2v   Potion of Healing
--   https://thedndledger.com/t/i_j9eanbu9tx84   Bag of Holding
--   https://thedndledger.com/t/i_hnbutm572y33   Cloak of Elvenkind
insert into tags (id, kind, batch, data) values
('i_5jeq5e28sk2v', 'item', 'test-2', '{"name": "Potion of Healing", "description": "A red liquid that glimmers when shaken. Drinking it restores 2d4 + 2 hit points."}'::jsonb),
('i_j9eanbu9tx84', 'item', 'test-2', '{"name": "Bag of Holding", "description": "A cloth sack whose inside is far larger than its outside. Holds up to 500 pounds and never weighs more than 15."}'::jsonb),
('i_hnbutm572y33', 'item', 'test-2', '{"name": "Cloak of Elvenkind", "description": "A grey-green hooded cloak. With the hood up, the wearer is hard to spot and moves almost without a sound."}'::jsonb)
on conflict (id) do nothing;
