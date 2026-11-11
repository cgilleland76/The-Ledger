// netlify/functions/wallet.js
//
// POST /api/wallet  { playerId, action: "balance" | "redeem" }
//   balance -> { enforced, free_left, paid, free_per_month, costs }
//   redeem  -> checks RevenueCat for Google Play purchases not yet credited, adds them,
//              then returns the same shape plus { added }.
// The app calls "redeem" right after a purchase and on every launch (to catch any
// purchase whose confirmation was interrupted).

const { corsHeaders } = require("./lib/shared");
const billing = require("./lib/billing");

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  let playerId, action;
  try {
    const body = JSON.parse(event.body || "{}");
    playerId = body.playerId;
    action = body.action === "redeem" ? "redeem" : "balance";
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const base = { enforced: billing.enforced(), free_per_month: billing.freePerMonth(), costs: billing.COSTS };
  if (!billing.enforced()) return { statusCode: 200, headers, body: JSON.stringify({ ...base, added: 0 }) };
  if (!billing.validPlayer(playerId)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid player id." }) };

  try {
    const added = action === "redeem" ? await billing.redeem(playerId) : 0;
    const bal = await billing.balance(playerId);
    return { statusCode: 200, headers, body: JSON.stringify({ ...base, ...bal, added }) };
  } catch (e) {
    console.error("wallet error:", e.message);
    return { statusCode: 503, headers, body: JSON.stringify({ error: "The ink ledger is unavailable right now. Try again in a minute." }) };
  }
};
