// netlify/functions/revive.js
//
// POST /api/revive  { roomCode, characterId, playerId, tz, accessToken }  (caller must be at the table)
// The Gravewarden: a paid way back from death. Anyone at the table may pay for a fallen hero.
//   * only while the hero is dead and within REVIVE_DAYS (default 3) real days of dying
//   * not at a table the host set to permanent death (rooms.meta.permadeath)
//   * price rises with each return: REVIVE_INK (default "30,60,120"; the last price repeats)
//   * the hero returns at 1 HP with the Mark of Return (-4 to attacks, saves and checks, easing by 1 per
//     long rest) and a debt to the Gravewarden the GM will call in
// Ink is spent from bought ink only (an extra). With billing off, the return is free.

const { ROOM_CODE_RE, sbRest, corsHeaders, requireMember } = require("./lib/shared");
const billing = require("./lib/billing");

const REVIVE_DAYS = () => { const n = parseFloat(process.env.REVIVE_DAYS); return Number.isFinite(n) && n > 0 ? n : 3; };
const reviveCosts = () => String(process.env.REVIVE_INK || "30,60,120").split(",").map((x) => parseInt(x, 10)).filter((n) => n > 0);
const reviveCost = (times) => { const c = reviveCosts(); return c.length ? c[Math.min(times, c.length - 1)] : 30; };
const MARK = 4;

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "That request couldn't be read." }); }
  const roomCode = String(b.roomCode || "").toUpperCase(), characterId = String(b.characterId || "");
  if (!ROOM_CODE_RE.test(roomCode) || !/^[a-z0-9]{4,20}$/i.test(characterId)) return reply(400, { error: "That request couldn't be read." });
  if (!billing.validPlayer(b.playerId)) return reply(400, { error: "Your ink key is missing." });
  const member = await requireMember(b.accessToken, roomCode);
  if (!member.ok) return reply(member.status, { error: member.status === 503 ? "Try again in a moment." : "You aren't at this table. Join it again with its code.", reason: member.reason });

  try {
    const rooms = await sbRest(`rooms?code=eq.${encodeURIComponent(roomCode)}&select=meta`);
    const room = rooms && rooms[0];
    if (!room) return reply(404, { error: "That table isn't in the ledger." });
    if (room.meta && room.meta.permadeath === true) return reply(409, { error: "This table plays with permanent death. The Gravewarden doesn't answer here.", reason: "permadeath" });
    const rows = await sbRest(`characters?id=eq.${encodeURIComponent(characterId)}&room_code=eq.${encodeURIComponent(roomCode)}&select=data`);
    const c = rows && rows[0] && rows[0].data;
    if (!c) return reply(404, { error: "That hero isn't at this table." });
    if (!c.dead) return reply(409, { error: `${c.name} isn't dead.`, reason: "alive" });
    const diedAt = parseInt(c.diedAt, 10) || 0;
    if (!diedAt || Date.now() - diedAt > REVIVE_DAYS() * 86400000) return reply(410, { error: "The Gravewarden's lantern has gone out for this hero. Their death is final.", reason: "too_late" });

    const times = parseInt(c.revivals, 10) || 0;
    const cost = reviveCost(times);
    const charge = await billing.spend(b.playerId, "revive", b.tz, cost);
    if (!charge.ok) return reply(402, { error: `The Gravewarden asks ${cost} ink, and there isn't enough bought ink to pay.`, outOfInk: true, cost, wallet: { free_left: charge.free_left, paid: charge.paid } });

    const back = { ...c, hp: 1, dead: false, revivals: times + 1, markOfReturn: MARK, gravewardenDebt: (parseInt(c.gravewardenDebt, 10) || 0) + 1 };
    delete back.dying; delete back.stable; delete back.diedAt;
    try {
      await sbRest(`characters?id=eq.${encodeURIComponent(characterId)}&room_code=eq.${encodeURIComponent(roomCode)}`, { method: "PATCH", body: { data: back } });
    } catch (e) {
      await billing.refund(b.playerId, charge);
      throw e;
    }
    await sbRest(`fallen_heroes?room_code=eq.${encodeURIComponent(roomCode)}&character_id=eq.${encodeURIComponent(characterId)}&returned=eq.false`, { method: "PATCH", body: { returned: true } }).catch(() => {});
    const text = `🕯 A hooded figure with a pale lantern steps out of the dark where ${c.name} fell. "Not yet," says the Gravewarden, and breath returns. ${c.name} is back at 1 HP, bearing the Mark of Return (-${MARK} to attacks, saves and checks, easing with each long rest), and now owes the Gravewarden a debt.`;
    await sbRest("log_entries", { method: "POST", body: { id: "gw" + Date.now().toString(36), room_code: roomCode, author: "The Gravewarden", type: "system", text } }).catch(() => {});
    return reply(200, { ok: true, cost: charge.skipped ? 0 : cost, nextCost: reviveCost(times + 1), wallet: charge.skipped ? undefined : { free_left: charge.free_left, paid: charge.paid } });
  } catch (e) {
    console.error("revive error:", e && e.message);
    return reply(503, { error: "The Gravewarden can't be reached right now. Try again in a minute." });
  }
};
// Exposed for the app's price display (site-config) and tests.
exports.reviveCost = reviveCost;
exports.REVIVE_DAYS = REVIVE_DAYS;
