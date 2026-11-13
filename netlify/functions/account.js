// netlify/functions/account.js
//
// POST /api/account  { action, accessToken, playerId }  — ties a signed-in account to an ink key.
//   link    after signing in: returns the account's ink key. status is one of
//             new | same | switched       the device should now use inkKey
//             needs_merge                 this device's own key has ink, minis or tables; device = counts.
//                                         Ask the player, then call merge (or just switch to inkKey).
//   merge   moves everything on this device's key into the account (after the player said yes)
//   delete  deletes the account. The device keeps its ink key (and the ink on it).
// Sign-in itself (the emailed link or code) is Supabase Auth in the browser; accessToken is that session.
// Ink, minis and hosting keep working by ink key exactly as before. See supabase/accounts.sql.

const crypto = require("crypto");
const { SUPABASE_URL, SUPABASE_ANON_KEY, corsHeaders } = require("./lib/shared");
const { validPlayer, sbAdmin } = require("./lib/billing");

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const freshKey = () => Array.from(crypto.randomBytes(24), (b) => ALPHABET[b % ALPHABET.length]).join("");
const rpc = (fn, args) => sbAdmin(`rpc/${fn}`, { method: "POST", body: args });

// The signed-in Supabase user for an access token, or null. Anonymous (guest) sessions don't count.
async function userFor(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4000) return null;
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const u = await resp.json().catch(() => null);
  return u && u.id && !u.is_anonymous ? u : null;
}
async function deleteUser(id) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { apikey: key, ...(String(key).startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
  });
  if (!resp.ok) throw new Error(`auth delete failed (${resp.status})`);
}

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "That request couldn't be read.", reason: "bad_request" }); }
  const action = String(b.action || "");
  if (!["link", "merge", "delete"].includes(action)) return reply(400, { error: "Unknown request.", reason: "bad_request" });
  if (!validPlayer(b.playerId)) return reply(400, { error: "This device's ink key is missing.", reason: "bad_request" });

  try {
    const user = await userFor(b.accessToken);
    if (!user) return reply(401, { error: "Your sign-in has expired. Sign in again.", reason: "signed_out" });

    if (action === "link") {
      const r = await rpc("account_link", { p_user: user.id, p_device: b.playerId, p_fresh: freshKey() });
      if (!r || !validPlayer(r.ink_key)) throw new Error("account_link returned nothing");
      return reply(200, { ok: true, status: r.status, inkKey: r.ink_key, device: r.device || null });
    }
    if (action === "merge") {
      const r = await rpc("account_merge_device", { p_user: user.id, p_device: b.playerId });
      if (!r || !r.ok) return reply(409, { error: "Those can't be moved: this device's key belongs to another account.", reason: (r && r.code) || "failed" });
      return reply(200, { ok: true, inkKey: r.ink_key, moved: r.moved });
    }
    // delete: the account row and memberships go with the auth user (on delete cascade); tables it owned
    // stay playable by their other members.
    await deleteUser(user.id);
    return reply(200, { ok: true });
  } catch (e) {
    console.error("account error:", e && e.message);
    return reply(503, { error: "Accounts are unavailable right now. Try again in a minute.", reason: "unavailable" });
  }
};
