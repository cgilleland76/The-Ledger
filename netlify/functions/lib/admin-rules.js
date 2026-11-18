// netlify/functions/lib/admin-rules.js
//
// Rules for the admin function (netlify/functions/admin.js), kept apart so the tests can run them directly:
//   tokenMatches(token, secret)   constant-time comparison of the admin token with ADMIN_SECRET
//   checkPatch(kind, set, unset)  what an admin edit may write: the same limits the app uses for a character,
//                                 a mini's data, a chest's contents or a room's meta. Returns { ok, set, unset, problems }
//   rollDice(expr)                a roll for the GOD view, written like the app's own roll lines
// Every edit is a merge of changed keys (supabase/admin.sql), so the rules only look at the keys being changed.

const crypto = require("crypto");

const MIN_SECRET_LENGTH = 32;

// Compares hashes of both values, so the time taken doesn't depend on where they differ or on their lengths.
function tokenMatches(token, secret) {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || !token) return false;
  const a = crypto.createHash("sha256").update(token).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const KEY_RE = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_]{1,40}$/;
const PATCH_MAX_BYTES = 64 * 1024;
const META_MAX_BYTES = 200 * 1024;

// Character (and hero mini) fields with fixed rules. Numbers: [min, max]. Text: max length.
const CHAR_NUMBERS = { hp: [0, 999], maxhp: [1, 999], ac: [0, 40], level: [1, 20], xp: [0, 400000],
  str: [1, 30], dex: [1, 30], con: [1, 30], int: [1, 30], wis: [1, 30], cha: [1, 30],
  markOfReturn: [0, 20], gravewardenDebt: [0, 99], revivals: [0, 99] };
const CHAR_TEXT = { name: 40, race: 40, klass: 40, player: 40, gender: 30, age: 20, appearance: 500, notes: 2000, heroTag: 60, deathCause: 20 };
const CHAR_BOOLS = ["dead", "stable"];
const INVENTORY_MAX = 80;
const ITEM_TEXT_MAX = 80;
const SKILLS_MAX = 30;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v === undefined ? null : v));

function checkCharacterField(k, v, problems) {
  if (k in CHAR_NUMBERS) {
    const [lo, hi] = CHAR_NUMBERS[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) problems.push(`${k} must be a whole number from ${lo} to ${hi}.`);
    return;
  }
  if (k in CHAR_TEXT) {
    if (typeof v !== "string") problems.push(`${k} must be text.`);
    else if (v.length > CHAR_TEXT[k]) problems.push(`${k} is longer than ${CHAR_TEXT[k]} characters.`);
    else if (k === "name" && !v.trim()) problems.push("name can't be empty.");
    return;
  }
  if (CHAR_BOOLS.includes(k)) { if (typeof v !== "boolean") problems.push(`${k} must be true or false.`); return; }
  if (k === "inventory" || k === "handItems") {
    if (!Array.isArray(v) || v.length > INVENTORY_MAX) problems.push(`${k} must be a list of at most ${INVENTORY_MAX} items.`);
    else if (v.some((i) => typeof i !== "string" || !i.trim() || i.length > ITEM_TEXT_MAX)) problems.push(`Each ${k === "inventory" ? "item" : "typed-in item"} must be text of 1 to ${ITEM_TEXT_MAX} characters.`);
    return;
  }
  if (k === "skills") {
    if (!Array.isArray(v) || v.length > SKILLS_MAX) problems.push(`skills must be a list of at most ${SKILLS_MAX}.`);
    else if (v.some((s) => !isObj(s) || typeof s.name !== "string" || !s.name.trim() || s.name.length > 40 || !Number.isInteger(s.mod) || s.mod < -10 || s.mod > 20)) {
      problems.push("Each skill needs a name (up to 40 characters) and a whole-number mod from -10 to 20.");
    }
    return;
  }
  if (k === "diedAt") { if (v !== null && (!Number.isInteger(v) || v < 0)) problems.push("diedAt must be a time in milliseconds."); return; }
  // Anything else (spells, slots, features, conditions...): any JSON, within the size limit below.
}

// kind: 'character' (a character row or a hero mini's sheet), 'monster', 'item' (a loot chest or coin),
// 'meta' (a room's meta), 'raw' (a tag's data with no fixed shape, e.g. a keystone).
function checkPatch(kind, set, unset) {
  const problems = [];
  const s = set === undefined || set === null ? {} : set;
  const u = unset === undefined || unset === null ? [] : unset;
  if (!isObj(s)) return { ok: false, problems: ["The change must be an object of fields."] };
  if (!Array.isArray(u) || u.some((k) => typeof k !== "string" || !KEY_RE.test(k))) return { ok: false, problems: ["Fields to remove must be field names."] };
  const keys = Object.keys(s);
  if (!keys.length && !u.length) return { ok: false, problems: ["Nothing changed."] };
  for (const k of keys) if (!KEY_RE.test(k)) problems.push(`"${String(k).slice(0, 40)}" isn't a valid field name (letters, numbers and _ only).`);
  for (const k of u) if (k in s) problems.push(`${k} is both changed and removed.`);
  if (bytes(s) > (kind === "meta" ? META_MAX_BYTES : PATCH_MAX_BYTES)) problems.push("That change is too large.");

  if (kind === "character") {
    for (const k of keys) checkCharacterField(k, s[k], problems);
    if (u.includes("name")) problems.push("A character must keep a name.");
    if ("hp" in s && "maxhp" in s && s.hp > s.maxhp) problems.push("hp can't be more than maxhp.");
  } else if (kind === "monster") {
    if ("name" in s && (typeof s.name !== "string" || !s.name.trim() || s.name.length > 40)) problems.push("name must be 1 to 40 characters.");
    if ("cr" in s && (typeof s.cr !== "string" || !/^(\d{1,2}|1\/[248])$/.test(s.cr))) problems.push('cr must be like "3" or "1/2".');
  } else if (kind === "item") {
    if ("name" in s && (typeof s.name !== "string" || !s.name.trim() || s.name.length > 60)) problems.push("name must be 1 to 60 characters.");
    if ("description" in s && (typeof s.description !== "string" || s.description.length > 500)) problems.push("description is longer than 500 characters.");
    if ("items" in s && (!Array.isArray(s.items) || s.items.length > 40 || s.items.some((i) => typeof i !== "string" || !i.trim() || i.length > ITEM_TEXT_MAX))) {
      problems.push(`items must be a list of at most 40 entries, each 1 to ${ITEM_TEXT_MAX} characters.`);
    }
  } else if (kind === "meta") {
    if ("name" in s && (typeof s.name !== "string" || s.name.length > 80)) problems.push("name is longer than 80 characters.");
    if ("host" in s && !(typeof s.host === "string" && /^[0-9a-f]{64}$/.test(s.host))) problems.push("host must stay a 64-character hash.");
    if ("grid" in s && s.grid !== null && !isObj(s.grid)) problems.push("grid must be an object or null.");
    if ("foes" in s && !isObj(s.foes)) problems.push("foes must be an object.");
  } else if (kind !== "raw") {
    problems.push("Unknown kind of edit.");
  }
  return problems.length ? { ok: false, problems } : { ok: true, set: s, unset: u };
}

// The old values of the changed keys, as the admin page loaded them (for the conflict check).
function baseFor(base, set, unset) {
  const b = isObj(base) ? base : {};
  const out = {};
  for (const k of [...Object.keys(set || {}), ...(unset || [])]) out[k] = k in b ? b[k] : null;
  return out;
}

// "2d6+3", "d20", "1d20-1 adv": one roll line in the app's format ("rolls 2d6(3+4) +3 = 10").
const DICE_RE = /^\s*(\d{0,2})d(\d{1,4})\s*([+-]\s*\d{1,3})?\s*(adv|dis)?\s*$/i;
function rollDice(expr, rand = Math.random) {
  const m = DICE_RE.exec(String(expr || ""));
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  const mode = (m[4] || "").toLowerCase();
  if (count < 1 || count > 50 || sides < 2 || sides > 1000) return null;
  const d = () => Math.floor(rand() * sides) + 1;
  let detail, roll;
  if (count === 1 && sides === 20 && mode) {
    const r1 = d(), r2 = d();
    roll = mode === "adv" ? Math.max(r1, r2) : Math.min(r1, r2);
    detail = `d20(${r1},${r2} ${mode})`;
  } else {
    const rolls = Array.from({ length: count }, d);
    roll = rolls.reduce((a, b) => a + b, 0);
    detail = count === 1 && sides === 20 ? `d20(${rolls[0]})` : `${count}d${sides}(${rolls.join("+")})`;
  }
  const total = roll + mod;
  return { total, text: `rolls ${detail}${mod ? " " + (mod > 0 ? "+" : "") + mod : ""} = ${total}` };
}

module.exports = { MIN_SECRET_LENGTH, tokenMatches, checkPatch, baseFor, rollDice, CHAR_NUMBERS, CHAR_TEXT, INVENTORY_MAX };
