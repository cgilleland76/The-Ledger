// scripts/make-loot-coins.js
//
// Makes a pack of loot coins (i_ tags) for a print run.
//   node scripts/make-loot-coins.js LOOT1          the standard 12-coin pack below
//   node scripts/make-loot-coins.js LOOT2 my.json  your own list: [{ "name": "...", "description": "..." }, ...]
//   A chest (one tag, several items) adds "items", up to 10:
//     { "name": "Treasure Chest", "description": "...", "items": ["1 Potion of Healing", "10 silver", "1 gold"] }
//   node scripts/make-loot-coins.js CHEST1 scripts/loot-chests.json   the sample chests
// Writes, into kits/ (git-ignored):
//   kits/LOOT1.sql  run once in the Supabase SQL Editor (registers the batch and its coins)
//   kits/LOOT1.csv  serial, the link to write onto each NFC sticker, and the item it gives
// Loot minis are single-use: the first hero to open one gets its items and the tag is marked used
// (supabase/loot.sql). They are sold in kits; loot found in the story comes from the GM.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SITE = process.env.LEDGER_SITE || "https://thedndledger.com";
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i, l, o, 0, 1)

// The standard pack: one coin each.
const STANDARD = [
  { name: "Potion of Healing", description: "A red liquid that glimmers when shaken. Drinking it restores 2d4 + 2 hit points." },
  { name: "Potion of Greater Healing", description: "A deep crimson draught. Drinking it restores 4d4 + 4 hit points." },
  { name: "25 gold", description: "A heavy little purse of gold coins, found tucked where nobody thought to look." },
  { name: "10 silver", description: "A scatter of silver pieces, dull with age but good at any market." },
  { name: "Antitoxin", description: "A clear vial. For an hour after drinking it you have advantage on saving throws against poison." },
  { name: "Healer's Kit", description: "Bandages, salves and splints. Use it to stabilise a dying creature without a Medicine check." },
  { name: "Alchemist's Fire", description: "A flask of sticky liquid that ignites in the air. Thrown, it sets the target ablaze for 1d4 fire damage each turn." },
  { name: "Holy Water", description: "Blessed water in a stoppered flask. Splashed on a fiend or undead, it deals 2d6 radiant damage." },
  { name: "Potion of Climbing", description: "A brown, layered liquid. For an hour you gain a climbing speed and advantage on checks to climb." },
  { name: "Potion of Water Breathing", description: "A cloudy green liquid with a bubble of air in it. For an hour you can breathe underwater." },
  { name: "Spell Scroll of Cure Wounds", description: "A scroll holding one casting of Cure Wounds. Anyone who can cast it may read it once." },
  { name: "Driftglobe", description: "A small glass sphere. Speak its word and it glows like a lantern and floats beside you." },
];

const batch = String(process.argv[2] || "").toUpperCase();
if (!/^[A-Z0-9-]{2,20}$/.test(batch)) {
  console.error("Usage: node scripts/make-loot-coins.js <BATCH-NAME> [items.json]");
  process.exit(1);
}
let items = STANDARD;
if (process.argv[3]) {
  items = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (!Array.isArray(items) || !items.length || items.length > 500 || items.some((it) => !it || !String(it.name || "").trim())) {
    console.error("The item list must be a JSON array of { name, description } (1-500, every one named).");
    process.exit(1);
  }
}
const outDir = path.join(__dirname, "..", "kits");
fs.mkdirSync(outDir, { recursive: true });
const sqlPath = path.join(outDir, `${batch}.sql`), csvPath = path.join(outDir, `${batch}.csv`);
if (fs.existsSync(sqlPath) || fs.existsSync(csvPath)) { console.error(`kits/${batch}.* already exists. Use a new batch name.`); process.exit(1); }

const pick = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join("");
const esc = (s) => String(s).replace(/'/g, "''");
const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

const rows = items.map((it, i) => ({
  serial: i + 1,
  tagId: "i_" + pick(14),
  data: {
    name: String(it.name).trim().slice(0, 80), description: String(it.description || "").trim().slice(0, 300),
    ...(Array.isArray(it.items) && it.items.length ? { items: it.items.map((x) => String(x || "").trim().slice(0, 80)).filter(Boolean).slice(0, 10) } : {}),
  },
}));

const sql = [
  `-- Loot coins, batch ${batch} (${rows.length}), made ${new Date().toISOString()}. Run once in the Supabase SQL Editor.`,
  `begin;`,
  `insert into tag_batches (batch, kind, size, notes) values ('${esc(batch)}', 'item', ${rows.length}, 'loot coins');`,
  `insert into tags (id, kind, batch, data) values`,
  rows.map((r) => `  ('${r.tagId}', 'item', '${esc(batch)}', '${esc(JSON.stringify(r.data))}'::jsonb)`).join(",\n") + ";",
  `commit;`,
  "",
].join("\n");
const gives = (d) => (d.items ? `${d.name}: ${d.items.join("; ")}` : d.name);
const csv = ["serial,sticker_link,item", ...rows.map((r) => `${batch}-${String(r.serial).padStart(4, "0")},${SITE}/t/${r.tagId},${csvCell(gives(r.data))}`)].join("\n") + "\n";

fs.writeFileSync(sqlPath, sql);
fs.writeFileSync(csvPath, csv);
console.log(`Made ${rows.length} loot coins in batch ${batch}:`);
console.log(`  kits/${batch}.sql  run once in Supabase`);
console.log(`  kits/${batch}.csv  the link to write on each coin's sticker, and what it gives`);
