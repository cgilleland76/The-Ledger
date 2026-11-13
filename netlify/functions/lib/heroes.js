// netlify/functions/lib/heroes.js
//
// Rules every hero must pass before it's written onto a mini, whether it's forged from a character,
// imported from a backup file, or saved after play. Nothing from the browser or a file is trusted:
// numbers are checked against 5e limits and the text is content-checked.

const crypto = require("crypto");

const XP_FOR_LEVEL = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
const HIT_DIE = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, sorcerer: 6, wizard: 6 }; // others d8
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// Owners are stored as a hash of their ink key, never the key itself (tags are publicly readable).
const ownerHash = (playerId) => sha256(String(playerId || ""));
// Claim codes are compared as hashes. "ldgr 7k2m-9qxp" and "LDGR-7K2M-9QXP" are the same code.
const normaliseClaim = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const claimHash = (code) => sha256("claim:" + normaliseClaim(code));

const hitDie = (klass) => { const k = String(klass || "").toLowerCase(); for (const [n, d] of Object.entries(HIT_DIE)) if (k.includes(n)) return d; return 8; };
const mod = (score) => Math.floor((score - 10) / 2);
const prof = (level) => 2 + Math.floor((level - 1) / 4);
const asiCount = (level) => [4, 8, 12, 16, 19].filter((l) => level >= l).length;
const levelForXp = (xp) => { let l = 1; while (l < 20 && xp >= XP_FOR_LEVEL[l + 1]) l++; return l; };
const isInt = (v) => Number.isInteger(typeof v === "string" && v.trim() !== "" ? Number(v) : v);
const str = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

// Returns { ok, hero, problems }. hero is a clean copy with only known fields; problems lists every
// rule that failed (in plain words). A hero with problems must not be saved.
function validateHero(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  const problems = [];
  const num = (k) => (isInt(h[k]) ? Number(h[k]) : NaN);

  const name = str(h.name, 40);
  if (!name) problems.push("It needs a name.");
  const level = num("level");
  if (!(level >= 1 && level <= 20)) problems.push("Level must be 1 to 20.");
  const L = level >= 1 && level <= 20 ? level : 1;

  const scores = {};
  for (const a of ABILITIES) {
    const v = num(a);
    if (!(v >= 3 && v <= 20)) problems.push(`${a.toUpperCase()} must be 3 to 20.`);
    scores[a] = Number.isFinite(v) ? v : 10;
  }
  // Standard array / point buy total 72; racial bonuses add up to 6 (a human's +1 to everything);
  // each ability score improvement adds 2.
  const total = ABILITIES.reduce((s, a) => s + scores[a], 0);
  const maxTotal = 78 + 2 * asiCount(L);
  if (total > maxTotal) problems.push(`Ability scores add up to ${total}; at level ${L} the most allowed is ${maxTotal}.`);

  const die = hitDie(h.klass);
  const maxhp = num("maxhp");
  const hpCap = die + mod(scores.con) + (L - 1) * Math.max(1, die + mod(scores.con));
  if (!(maxhp >= 1 && maxhp <= Math.max(1, hpCap))) problems.push(`Max HP must be 1 to ${Math.max(1, hpCap)} for a level ${L} ${str(h.klass, 40) || "adventurer"}.`);

  const ac = num("ac");
  const acCap = 20 + Math.floor(L / 5);
  if (!(ac >= 5 && ac <= acCap)) problems.push(`AC must be 5 to ${acCap} at level ${L}.`);

  const best = Math.max(...ABILITIES.map((a) => mod(scores[a])));
  const skillCap = best + 2 * prof(L); // expertise doubles proficiency
  const skills = Array.isArray(h.skills) ? h.skills : [];
  if (skills.length > 30) problems.push("Too many skills (30 at most).");
  const cleanSkills = skills.slice(0, 30).map((s) => ({ name: str(s && s.name, 40), mod: isInt(s && s.mod) ? Number(s.mod) : 0 })).filter((s) => s.name);
  for (const s of cleanSkills) if (s.mod > skillCap || s.mod < -5) problems.push(`${s.name} ${s.mod >= 0 ? "+" : ""}${s.mod} is outside what a level ${L} hero can have (up to +${skillCap}).`);

  const xp = isInt(h.xp) ? Number(h.xp) : XP_FOR_LEVEL[L];
  if (xp < 0 || xp > 400000) problems.push("XP is out of range.");
  else if (levelForXp(xp) < L) problems.push(`Level ${L} needs at least ${XP_FOR_LEVEL[L]} XP.`);

  const inv = Array.isArray(h.inventory) ? h.inventory : [];
  if (inv.length > 40) problems.push("Too many items (40 at most).");
  const inventory = inv.slice(0, 40).map((i) => str(i, 80)).filter(Boolean);
  const spells = (Array.isArray(h.spells) ? h.spells : []).slice(0, 40).map((s) => str(s, 60)).filter(Boolean);

  const hero = {
    name, race: str(h.race, 40), klass: str(h.klass, 40), level: L, xp: Math.max(0, Math.min(xp || 0, 400000)),
    ...scores, maxhp: Number.isFinite(maxhp) ? maxhp : 1, hp: Number.isFinite(maxhp) ? maxhp : 1, ac: Number.isFinite(ac) ? ac : 10,
    skills: cleanSkills, inventory, spells,
    notes: str(h.notes, 2000), appearance: str(h.appearance, 500), gender: str(h.gender, 30), age: str(h.age, 20),
  };
  return { ok: problems.length === 0, hero, problems };
}

// The text a content check should read for a hero.
const heroText = (hero) => [hero.name, hero.race, hero.klass, hero.appearance, hero.notes, ...(hero.inventory || []), ...(hero.spells || [])].filter(Boolean).join("\n");

// A game character (characters.data) shaped as a hero, without game-only fields.
function heroFromCharacter(c) {
  const d = c || {};
  const typed = Array.isArray(d.handItems) ? [...d.handItems] : [];
  const inventory = (Array.isArray(d.inventory) ? d.inventory : []).slice().reverse()
    .filter((i) => { const k = typed.indexOf(i); if (k >= 0) { typed.splice(k, 1); return false; } return true; }).reverse();
  return { ...d, inventory, xp: Number.isFinite(d.xp) ? d.xp : XP_FOR_LEVEL[parseInt(d.level, 10) || 1] };
}

module.exports = { XP_FOR_LEVEL, sha256, ownerHash, claimHash, normaliseClaim, validateHero, heroText, heroFromCharacter, levelForXp };
