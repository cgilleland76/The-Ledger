// scripts/make-blank-minis.js
//
// Makes a batch of blank hero minis for a kit print run.
//   node scripts/make-blank-minis.js KIT1 20
// Writes, into kits/ (git-ignored: the claim codes are secret):
//   kits/KIT1.sql  — run once in the Supabase SQL Editor. Registers the batch, the blank tags, and each
//                    mini's serial number with the HASH of its claim code (the codes themselves are never
//                    stored in the database).
//   kits/KIT1.csv  — serial, the link to write onto the NFC sticker, and the claim code to print on the
//                    card that goes in the box. Keep this file private; it's the only copy of the codes.
// Run it again with a new batch name for the next print run. Re-running the same name is refused.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { claimHash } = require("../netlify/functions/lib/heroes");

const SITE = process.env.LEDGER_SITE || "https://thedndledger.com";
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i, l, o, 0, 1)
const CODE_ALPHABET = ALPHABET.toUpperCase();

const batch = String(process.argv[2] || "").toUpperCase();
const count = parseInt(process.argv[3], 10);
if (!/^[A-Z0-9-]{2,20}$/.test(batch) || !(count >= 1 && count <= 1000)) {
  console.error("Usage: node scripts/make-blank-minis.js <BATCH-NAME> <how many, 1-1000>");
  process.exit(1);
}
const outDir = path.join(__dirname, "..", "kits");
fs.mkdirSync(outDir, { recursive: true });
const sqlPath = path.join(outDir, `${batch}.sql`), csvPath = path.join(outDir, `${batch}.csv`);
if (fs.existsSync(sqlPath) || fs.existsSync(csvPath)) { console.error(`kits/${batch}.* already exists. Use a new batch name.`); process.exit(1); }

const pick = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const esc = (s) => String(s).replace(/'/g, "''");

const rows = [];
for (let serial = 1; serial <= count; serial++) {
  const tagId = "h_" + pick(ALPHABET, 14);
  const code = `LDGR-${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}`;
  rows.push({ serial, tagId, code, hash: claimHash(code) });
}

const sql = [
  `-- Blank hero minis, batch ${batch} (${count}), made ${new Date().toISOString()}. Run once in the Supabase SQL Editor.`,
  `-- Holds only HASHES of the claim codes; the codes are in kits/${batch}.csv.`,
  `begin;`,
  `insert into tag_batches (batch, kind, size) values ('${esc(batch)}', 'hero', ${count});`,
  `insert into tags (id, kind, batch, status, data) values`,
  rows.map((r) => `  ('${r.tagId}', 'hero', '${esc(batch)}', 'blank', '{}'::jsonb)`).join(",\n") + ";",
  `insert into tag_claims (tag_id, batch, serial, claim_hash) values`,
  rows.map((r) => `  ('${r.tagId}', '${esc(batch)}', ${r.serial}, '${r.hash}')`).join(",\n") + ";",
  `commit;`,
  "",
].join("\n");
const csv = ["serial,sticker_link,claim_code", ...rows.map((r) => `${batch}-${String(r.serial).padStart(4, "0")},${SITE}/t/${r.tagId},${r.code}`)].join("\n") + "\n";

fs.writeFileSync(sqlPath, sql);
fs.writeFileSync(csvPath, csv);
console.log(`Made ${count} blank minis in batch ${batch}:`);
console.log(`  kits/${batch}.sql  run once in Supabase (registers the minis; no codes inside)`);
console.log(`  kits/${batch}.csv  links for the stickers + claim codes for the cards (keep private)`);
