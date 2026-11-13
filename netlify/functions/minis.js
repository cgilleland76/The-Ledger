// netlify/functions/minis.js
//
// POST /api/minis  { action, playerId, platform, ... }   — everything about owned hero minis.
//   tap      { tagId }                                   log a tap (for the copy watch); anyone
//   list     {}                                          the caller's heroes: level, last played, status
//   forge    { claimCode, roomCode, characterId, tagId? } put a played character onto a blank mini (free)
//   snapshots{ tagId }                                   the last 10 saved versions (owner only)
//   restore  { tagId, snapshotId }                       roll back to one of them (owner only)
//   export   { tagId }                                   signed JSON backup (owner only)
//   import   { file, claimCode? }                        signed backup -> restore its mini; anything else
//                                                        -> a new level-1 hero on a blank mini (claim code)
//   move     { tagId, claimCode }                        copy the hero onto a new blank mini; old one 'moved'
//   recover  { tagId, claimCode }                        lost ink key: the original claim code transfers ownership
// Owners are hashes of the ink key. Every write is one database function (supabase/minis.sql), so a
// failure can't leave a half-done move. Nothing from a file or the browser is trusted: heroes go through
// lib/heroes.js (5e limits) and the text content check (lib/portraits.js) before they're stored.

const crypto = require("crypto");
const { ROOM_CODE_RE, sbRest, corsHeaders } = require("./lib/shared");
const { validPlayer, sbAdmin } = require("./lib/billing");
const { checkText } = require("./lib/portraits");
const { ownerHash, claimHash, validateHero, heroText, heroFromCharacter } = require("./lib/heroes");

const TAG_RE = /^h_[a-z0-9]{10,40}$/;
const MAX_TOTAL = () => parseInt(process.env.MINIS_MAX_PER_KEY, 10) || 25;
const MAX_DAY = () => parseInt(process.env.MINIS_MAX_PER_DAY, 10) || 3;

const MESSAGES = {
  bad_code: "That claim code doesn't match a blank mini. Check the card and try again.",
  batch_inactive: "That code's kit has been switched off. Contact support if you think that's a mistake.",
  already_claimed: "That mini already has a hero on it.",
  limit: "You've forged as many minis as allowed for now. Try again tomorrow.",
  not_owner: "That mini belongs to another player.",
  not_active: "That mini isn't active (it may have moved to a new mini).",
  no_tag: "That mini isn't one The Ledger knows.",
  no_snapshot: "That backup isn't available any more.",
  rate_limited: "Too many wrong codes for that mini. Try again in an hour.",
};

const secret = () => process.env.HERO_BACKUP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const sign = (obj) => crypto.createHmac("sha256", secret()).update(JSON.stringify(obj)).digest("hex");
function verify(file) {
  if (!file || typeof file !== "object" || typeof file.signature !== "string" || !secret()) return false;
  const { signature, ...rest } = file;
  const want = sign(rest);
  return want.length === signature.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(signature));
}
const rpc = (fn, args) => sbAdmin(`rpc/${fn}`, { method: "POST", body: args });

async function ownedTag(tagId, owner) {
  const rows = await sbAdmin(`tags?id=eq.${encodeURIComponent(tagId)}&claimed_by=eq.${owner}&select=id,status,data,moved_to`);
  return rows && rows[0];
}
// Validates and content-checks a hero; returns { hero } or a reply.
async function checkHero(raw, platform, reply) {
  const v = validateHero(raw);
  if (!v.ok) return { fail: reply(422, { error: "That hero doesn't follow the rules: " + v.problems.join(" "), reason: "invalid", problems: v.problems }) };
  const verdict = await checkText(heroText(v.hero), platform);
  if (!verdict.ok) {
    console.warn(`minis: hero text rejected (${verdict.code})`);
    if (String(verdict.code).startsWith("moderation_failed")) return { fail: reply(503, { error: "Try again in a moment.", reason: "unavailable" }) };
    return { fail: reply(422, { error: "That hero's name or description can't be used. Change it and try again.", reason: "rejected" }) };
  }
  return { hero: v.hero };
}

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
  const fromRpc = (r, extra) => (r && r.ok ? reply(200, { ok: true, ...r, ...(extra || {}) }) : reply(r && r.code === "rate_limited" ? 429 : 409, { error: MESSAGES[r && r.code] || "That didn't work. Try again.", reason: (r && r.code) || "failed" }));

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "That request couldn't be read.", reason: "bad_request" }); }
  const action = String(b.action || "");
  const owner = validPlayer(b.playerId) ? ownerHash(b.playerId) : null;
  const tagId = b.tagId ? String(b.tagId) : null;
  if (tagId && !/^[hmik]_[a-z0-9]{10,40}$/.test(tagId)) return reply(400, { error: "That mini link isn't valid.", reason: "bad_request" });

  try {
    if (action === "tap") {
      if (tagId) await rpc("tag_log", { p_tag: tagId, p_event: "tap", p_key: owner, p_detail: null }).catch(() => {});
      return reply(200, { ok: true });
    }
    if (!owner) return reply(400, { error: "Your ink key is missing.", reason: "bad_request" });

    if (action === "list") {
      const rows = await sbAdmin(`tags?claimed_by=eq.${owner}&kind=eq.hero&select=id,status,moved_to,data,last_played,forged_at,updated_at&order=updated_at.desc`);
      return reply(200, { minis: (rows || []).map((t) => ({ id: t.id, status: t.status, moved_to: t.moved_to, name: (t.data && t.data.name) || "Unnamed hero", level: (t.data && t.data.level) || 1, klass: (t.data && t.data.klass) || "", race: (t.data && t.data.race) || "", last_played: t.last_played || t.updated_at })) });
    }

    if (action === "forge") {
      const roomCode = String(b.roomCode || "").toUpperCase();
      if (!b.claimCode || !ROOM_CODE_RE.test(roomCode) || !/^[a-z0-9]{4,20}$/i.test(String(b.characterId || ""))) return reply(400, { error: "Enter the claim code from your mini's card.", reason: "bad_request" });
      const rows = await sbRest(`characters?id=eq.${encodeURIComponent(b.characterId)}&room_code=eq.${encodeURIComponent(roomCode)}&select=data`);
      const ch = rows && rows[0] && rows[0].data;
      if (!ch) return reply(404, { error: "That hero isn't at this table.", reason: "no_character" });
      if (ch.heroTag) return reply(409, { error: "This hero already lives on a mini. Use My minis to move it.", reason: "already_on_mini" });
      const c = await checkHero(heroFromCharacter(ch), b.platform, reply);
      if (c.fail) return c.fail;
      const r = await rpc("tag_forge", { p_claim_hash: claimHash(b.claimCode), p_owner: owner, p_data: c.hero, p_tag: tagId, p_max_total: MAX_TOTAL(), p_max_day: MAX_DAY() });
      if (r && r.ok) {
        // The character now plays from (and saves back to) that mini.
        await sbRest(`characters?id=eq.${encodeURIComponent(b.characterId)}&room_code=eq.${encodeURIComponent(roomCode)}`, { method: "PATCH", body: { data: { ...ch, heroTag: r.tag_id } } }).catch(() => {});
      }
      return fromRpc(r);
    }

    if (action === "snapshots") {
      if (!tagId || !(await ownedTag(tagId, owner))) return reply(403, { error: MESSAGES.not_owner, reason: "not_owner" });
      const rows = await sbAdmin(`tag_snapshots?tag_id=eq.${tagId}&select=id,saved_at,data&order=saved_at.desc,id.desc&limit=10`);
      return reply(200, { snapshots: (rows || []).map((s) => ({ id: s.id, saved_at: s.saved_at, level: s.data && s.data.level, maxhp: s.data && s.data.maxhp, items: ((s.data && s.data.inventory) || []).length })) });
    }
    if (action === "restore") {
      if (!tagId || !Number.isInteger(Number(b.snapshotId))) return reply(400, { error: "Pick a backup to restore.", reason: "bad_request" });
      return fromRpc(await rpc("tag_restore", { p_tag: tagId, p_snapshot: Number(b.snapshotId), p_owner: owner }));
    }

    if (action === "export") {
      const t = tagId && (await ownedTag(tagId, owner));
      if (!t) return reply(403, { error: MESSAGES.not_owner, reason: "not_owner" });
      const body = { format: "the-ledger-hero", version: 1, tag_id: t.id, exported_at: new Date().toISOString(), hero: t.data };
      return reply(200, { file: { ...body, signature: sign(body) } });
    }

    if (action === "import") {
      const file = b.file;
      if (!file || typeof file !== "object" || file.format !== "the-ledger-hero" || !file.hero) return reply(400, { error: "That isn't a Ledger hero backup.", reason: "bad_file" });
      const signed = verify(file);
      // An edited or unsigned file can only make a new level-1 hero; a signed backup keeps its progress.
      if (!signed && (parseInt(file.hero.level, 10) || 1) > 1) {
        return reply(422, { error: "This backup was changed after it was saved (or isn't from The Ledger), so it can only make a new level 1 hero.", reason: "unsigned_level" });
      }
      const c = await checkHero(file.hero, b.platform, reply);
      if (c.fail) return c.fail;
      if (b.claimCode) {
        return fromRpc(await rpc("tag_forge", { p_claim_hash: claimHash(b.claimCode), p_owner: owner, p_data: c.hero, p_tag: null, p_max_total: MAX_TOTAL(), p_max_day: MAX_DAY() }));
      }
      if (signed && TAG_RE.test(String(file.tag_id || ""))) {
        return fromRpc(await rpc("tag_save", { p_tag: file.tag_id, p_data: c.hero, p_owner: owner, p_event: "import" }), { tag_id: file.tag_id });
      }
      return reply(400, { error: "To put this hero on a mini, enter a blank mini's claim code.", reason: "need_code" });
    }

    if (action === "move") {
      if (!tagId || !b.claimCode) return reply(400, { error: "Enter the new mini's claim code.", reason: "bad_request" });
      return fromRpc(await rpc("tag_move", { p_from: tagId, p_claim_hash: claimHash(b.claimCode), p_owner: owner }));
    }

    if (action === "recover") {
      if (!tagId || !b.claimCode) return reply(400, { error: "Enter the mini and its original claim code.", reason: "bad_request" });
      return fromRpc(await rpc("tag_recover", { p_tag: tagId, p_claim_hash: claimHash(b.claimCode), p_new_owner: owner }));
    }

    return reply(400, { error: "Unknown action.", reason: "bad_request" });
  } catch (e) {
    console.error(`minis ${action} failed:`, e.message);
    return reply(503, { error: "The mini records are out of reach right now. Try again in a moment.", reason: "unavailable" });
  }
};
