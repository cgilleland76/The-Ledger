// netlify/functions/lib/billing.js
//
// Credits ("ink") for the paywall. Prices, the free allowance and the Google Play
// products all live here, so they're easy to change in one place.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   BILLING_ENFORCED            "true" turns charging on. Unset/anything else = everything free (old behaviour).
//   SUPABASE_SERVICE_ROLE_KEY   secret key from Supabase > Project Settings > API keys. Server only, never in public/.
//   REVENUECAT_SECRET_KEY       RevenueCat > Project settings > API keys > secret key (sk_...). Server only.
//   FREE_INK_PER_MONTH          optional, default below.
//   ALLOW_SANDBOX_PURCHASES     optional, "false" ignores Google Play test purchases (default: they count,
//                               so your license testers can try the shop; only accounts you list can make them).

const { SUPABASE_URL } = require("./shared");

const COSTS = { gm: 1, portrait: 8, scene: 10 }; // ink per GM reply / portrait / AI scene background
const DEFAULT_FREE_PER_MONTH = 40;

// Must match the in-app product IDs created in Google Play Console (and attached in RevenueCat).
const PACKS = {
  ledger_ink_150: 150,
  ledger_ink_500: 500,
  ledger_ink_1200: 1200,
};

const PLAYER_ID_RE = /^[a-z0-9]{16,40}$/;

const enforced = () => String(process.env.BILLING_ENFORCED || "").trim().toLowerCase() === "true";
const freePerMonth = () => {
  const n = parseInt(process.env.FREE_INK_PER_MONTH, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FREE_PER_MONTH;
};
const validPlayer = (id) => typeof id === "string" && PLAYER_ID_RE.test(id);

// PostgREST call with the service-role (secret) key.
async function sbAdmin(path, { method = "GET", body } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set on the server.");
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy JWT-style key
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${resp.status})`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (fn, args) => sbAdmin(`rpc/${fn}`, { method: "POST", body: args });

// Spends ink for an action. Returns { ok, free_left, paid, from_free, from_paid }.
// When billing is off it always succeeds without touching the database.
async function spend(playerId, kind) {
  if (!enforced()) return { ok: true, skipped: true };
  if (!validPlayer(playerId)) return { ok: false, free_left: 0, paid: 0, invalid: true };
  return rpc("spend_credits", { p_player: playerId, p_cost: COSTS[kind], p_free_monthly: freePerMonth() });
}

async function refund(playerId, charge) {
  if (!charge || charge.skipped || !charge.ok) return;
  if (!charge.from_free && !charge.from_paid) return;
  try {
    await rpc("refund_credits", { p_player: playerId, p_from_free: charge.from_free || 0, p_from_paid: charge.from_paid || 0 });
  } catch (e) { /* best effort */ }
}

async function balance(playerId) {
  const free = freePerMonth();
  if (!validPlayer(playerId)) return { free_left: free, paid: 0 };
  const rows = await sbAdmin(`wallets?player_id=eq.${encodeURIComponent(playerId)}&select=free_period,free_used,paid_balance`);
  const w = rows && rows[0];
  if (!w) return { free_left: free, paid: 0 };
  const cur = new Date().toISOString().slice(0, 7);
  const used = w.free_period === cur ? w.free_used : 0;
  return { free_left: Math.max(free - used, 0), paid: w.paid_balance };
}

// Asks RevenueCat which one-time purchases this player has made, and credits any
// that haven't been credited yet. Returns how much ink was added.
async function redeem(playerId) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) throw new Error("REVENUECAT_SECRET_KEY is not set on the server.");
  if (!validPlayer(playerId)) throw new Error("Invalid player id.");
  const resp = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(playerId)}`, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`RevenueCat lookup failed (${resp.status})`);
  const data = await resp.json();
  const purchases = (data && data.subscriber && data.subscriber.non_subscriptions) || {};
  const allowSandbox = String(process.env.ALLOW_SANDBOX_PURCHASES || "true").trim().toLowerCase() !== "false";
  let added = 0;
  for (const [productId, list] of Object.entries(purchases)) {
    const credits = PACKS[productId];
    if (!credits || !Array.isArray(list)) continue;
    for (const p of list) {
      if (p.is_sandbox && !allowSandbox) continue;
      const tx = p.store_transaction_id || p.id;
      if (!tx) continue;
      const fresh = await rpc("grant_credits", {
        p_tx: `rc:${tx}`, p_player: playerId, p_product: productId, p_credits: credits, p_sandbox: !!p.is_sandbox,
      });
      if (fresh === true) added += credits;
    }
  }
  return added;
}

const outOfInkMessage = (kind) =>
  kind === "portrait"
    ? `Not enough ink for a portrait (it costs ${COSTS.portrait}).`
    : "You're out of ink for this month.";

module.exports = { COSTS, PACKS, enforced, freePerMonth, validPlayer, spend, refund, balance, redeem, outOfInkMessage, sbAdmin };
