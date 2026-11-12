// netlify/functions/hero-save.js
//
// POST /api/hero-save  { tagId, roomCode, characterId, playerId }
// Saves a mini's hero progress (level, max HP, skills, gear, notes) back onto its NFC tag,
// so the next tap brings the hero back as they are now.
//
// Tags can only be written with the service-role key, so this is the one way in. Checks:
//  - the character really exists in that room and was made from this tag (data.heroTag);
//  - ownership: the first player (ink key) to save claims the mini; only they can save again.
//    Anyone can still PLAY a mini; it's a physical object you can lend.
//  - progress limits: at most +1 level per save, max HP can only grow by the class hit die +
//    CON per level gained, and ability scores and AC stay as the tag has them. Skills are
//    recomputed from the tag (+1 each time the proficiency bonus goes up).
//  - one save per 5 seconds per mini.

const { ROOM_CODE_RE, sbRest, corsHeaders } = require("./lib/shared");
const { validPlayer, sbAdmin } = require("./lib/billing");

const TAG_ID_RE = /^h_[a-z0-9]{10,40}$/;
const CHAR_ID_RE = /^[a-z0-9]{4,20}$/i;
const HIT_DIE = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, sorcerer: 6, wizard: 6 }; // everything else d8
const MIN_SAVE_GAP_MS = 5 * 1000;

const int = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const hitDie = (klass) => {
  const k = String(klass || "").toLowerCase();
  for (const [name, die] of Object.entries(HIT_DIE)) if (k.includes(name)) return die;
  return 8;
};
const prof = (level) => 2 + Math.floor((level - 1) / 4);
const XP_FOR_LEVEL = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
const levelForXp = (xp) => { let l = 1; while (l < 20 && xp >= XP_FOR_LEVEL[l + 1]) l++; return l; };
const mod = (score) => Math.floor((int(score, 1, 30, 10) - 10) / 2);

// Works out what may be saved, given the tag as stored and the character as played.
function progressFrom(tagData, ch) {
  const t = tagData || {};
  const oldLevel = int(t.level, 1, 20, 1);
  // XP never goes down, and can't run more than two levels ahead of the mini.
  const oldXp = int(t.xp, 0, 400000, XP_FOR_LEVEL[oldLevel]);
  const xp = Math.min(Math.max(oldXp, int(ch.xp, 0, 400000, oldXp)), XP_FOR_LEVEL[Math.min(20, oldLevel + 2)] || 355000);
  // Never lower the mini's level; raise it by at most one per save, and only if the XP supports it.
  const level = Math.max(oldLevel, Math.min(int(ch.level, 1, 20, oldLevel), oldLevel + 1, levelForXp(xp), 20));
  const gained = Math.max(level - oldLevel, 0);
  const oldMax = int(t.maxhp, 1, 999, 10);
  const perLevelMax = Math.max(hitDie(t.klass) + mod(t.con), 1);
  const maxhp = Math.min(Math.max(int(ch.maxhp, 1, 999, oldMax), oldMax), oldMax + gained * perLevelMax);
  const bump = Math.max(prof(Math.max(level, oldLevel)) - prof(oldLevel), 0);
  const skills = (Array.isArray(t.skills) ? t.skills : []).slice(0, 30).map((s) => ({
    name: String((s && s.name) || "").slice(0, 40),
    mod: int(s && s.mod, -10, 20, 0) + bump,
  })).filter((s) => s.name);
  // Items the player typed in themselves (handItems) are not earned, so they never go onto the mini.
  const typed = Array.isArray(ch.handItems) ? [...ch.handItems] : [];
  const inventory = (Array.isArray(ch.inventory) ? ch.inventory : []).slice().reverse()
    .filter((i) => { const k = typed.indexOf(i); if (k >= 0) { typed.splice(k, 1); return false; } return true; })
    .reverse().slice(0, 40).map((i) => String(i).slice(0, 80)).filter((i) => i.trim());
  const notes = String(ch.notes || "").slice(0, 2000);
  return { ...t, level, xp, maxhp, hp: maxhp, skills, inventory, notes };
}

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let tagId, roomCode, characterId, playerId;
  try {
    ({ tagId, roomCode, characterId, playerId } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return reply(400, { error: "Invalid JSON body." });
  }
  if (!TAG_ID_RE.test(String(tagId)) || !ROOM_CODE_RE.test(String(roomCode)) || !CHAR_ID_RE.test(String(characterId)) || !validPlayer(playerId)) {
    return reply(400, { error: "Missing or invalid details." });
  }

  try {
    const enc = encodeURIComponent;
    const tags = await sbAdmin(`tags?id=eq.${enc(tagId)}&kind=eq.hero&select=data,claimed_by,updated_at`);
    if (!tags || !tags.length) return reply(404, { error: "That mini isn't a hero The Ledger knows." });
    const tag = tags[0];
    if (tag.claimed_by && tag.claimed_by !== playerId) {
      return reply(403, { error: "This mini is bound to another player, so its progress can only be saved from their device. You can still play it." });
    }
    if (tag.updated_at && Date.now() - Date.parse(tag.updated_at) < MIN_SAVE_GAP_MS) {
      return reply(429, { error: "Saved a moment ago. Try again in a few seconds." });
    }

    const rows = await sbRest(`characters?id=eq.${enc(characterId)}&room_code=eq.${enc(String(roomCode).toUpperCase())}&select=data`);
    const ch = rows && rows[0] && rows[0].data;
    if (!ch || ch.heroTag !== tagId) return reply(404, { error: "That character didn't come from this mini." });

    const data = progressFrom(tag.data, ch);
    await sbAdmin(`tags?id=eq.${enc(tagId)}`, {
      method: "PATCH",
      body: { data, claimed_by: tag.claimed_by || playerId, updated_at: new Date().toISOString() },
    });
    return reply(200, { saved: { level: data.level, maxhp: data.maxhp, items: data.inventory.length }, claimed: !tag.claimed_by });
  } catch (e) {
    console.error("hero-save error:", e.message);
    return reply(503, { error: "Couldn't reach the mini's record right now. Try again in a minute." });
  }
};

module.exports.progressFrom = progressFrom;
