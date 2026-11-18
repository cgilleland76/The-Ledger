// netlify/functions/lib/gm-limits.js
//
// Daily limits on Claude calls made by the GM function (story replies, opening scenes, AI character
// building), counted in the gm_usage table (supabase/soft-launch.sql) with the service-role key.
//
// Env vars (Netlify > Site configuration > Environment variables; functions read them on a redeploy):
//   GM_MAX_PER_ROOM_PER_DAY  calls per table per day. Default 60.
//   GM_MAX_PER_IP_PER_DAY    calls per player IP per day. Default 100. The IP is never stored: only a
//                            keyed hash of it (HMAC with the server's service-role key).
//   GM_MAX_PER_USER_PER_DAY  calls per player (signed-in or anonymous session) per day. Default 80.
//   GM_MAX_PER_DAY           calls per day across the whole site. Unset (or 0): no site-wide cap.
// AI images are counted the same way when they're switched on, per player and per IP:
//   PORTRAIT_MAX_PER_USER_PER_DAY (default 5), SCENE_MAX_PER_USER_PER_DAY (default 5).
// Hall of the Fallen entries: MEMORIAL_MAX_PER_USER_PER_DAY (default 3). Uploaded portraits:
//   UPLOAD_MAX_PER_USER_PER_DAY (default 20). Both need supabase/beta-hardening.sql.
// A "day" is a calendar day in one fixed time zone, LIMIT_TZ below, the same for every player.

const crypto = require("crypto");

const LIMIT_TZ = "America/New_York";

const intEnv = (name, fallback) => {
  const raw = String(process.env[name] == null ? "" : process.env[name]).trim();
  if (raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
function limits(what = "gm") {
  // Hall of the Fallen entries (each one writes a memorial with Claude): a few per player a day.
  if (what === "memorial") {
    const n = intEnv("MEMORIAL_MAX_PER_USER_PER_DAY", 3);
    return { room: 0, ip: n * 2, user: n, global: 0 };
  }
  // Portraits uploaded by players (no AI, but each one is stored): per player and per IP.
  if (what === "upload") {
    const n = intEnv("UPLOAD_MAX_PER_USER_PER_DAY", 20);
    return { room: 0, ip: n * 2, user: n, global: 0 };
  }
  if (what === "portrait" || what === "scene") {
    const n = intEnv(what === "portrait" ? "PORTRAIT_MAX_PER_USER_PER_DAY" : "SCENE_MAX_PER_USER_PER_DAY", 5);
    return { room: 0, ip: n, user: n, global: 0 }; // per-table image caps live on the room row already
  }
  return {
    room: intEnv("GM_MAX_PER_ROOM_PER_DAY", 60),
    ip: intEnv("GM_MAX_PER_IP_PER_DAY", 100),
    user: intEnv("GM_MAX_PER_USER_PER_DAY", 80),
    global: intEnv("GM_MAX_PER_DAY", 0), // 0 = no site-wide cap
  };
}

// The clock is swappable so tests can move to the next day.
const clock = { now: () => new Date() };

// Today's date (YYYY-MM-DD) in LIMIT_TZ.
function usageDay(now = clock.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LIMIT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// The caller's IP as Netlify reports it.
function clientIp(event) {
  const h = (event && event.headers) || {};
  const get = (k) => h[k] || h[k.toLowerCase()] || "";
  const ip = get("x-nf-client-connection-ip") || String(get("x-forwarded-for")).split(",")[0] || get("client-ip");
  return String(ip).trim() || "unknown";
}
function hashIp(ip) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "the-ledger-gm-usage";
  return crypto.createHmac("sha256", secret).update(`gm-usage:${ip}`).digest("hex");
}

// Counts one call if it fits. Returns { ok: true, undo } or { ok: false, reason }.
// reason is 'room', 'ip', 'user' or 'global' (limit reached) or 'unavailable' (the table couldn't be
// reached: refused, so a database problem can never mean unlimited spending). undo() gives the call back.
// what: 'gm' (default), 'portrait', 'scene', 'memorial' or 'upload'. userId: the caller, from requireMember().
async function useGM(sbAdmin, { roomCode, event, userId, what = "gm", now }) {
  const day = usageDay(now);
  const ipHash = hashIp(clientIp(event));
  const l = limits(what);
  if (!userId) return { ok: false, reason: "unavailable", detail: "no user" };
  const key = { p_day: day, p_what: what, p_room: roomCode, p_ip: ipHash, p_user: userId };
  let r;
  try {
    r = await sbAdmin("rpc/gm_use", { method: "POST", body: { ...key, p_room_max: l.room, p_ip_max: l.ip, p_user_max: l.user, p_day_max: l.global } });
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e.message };
  }
  if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "unavailable" };
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    try { await sbAdmin("rpc/gm_unuse", { method: "POST", body: key }); }
    catch (e) { console.warn("gm-limits: couldn't give a call back:", e.message); }
  };
  return { ok: true, day, undo };
}

// Estimated cost of one reply, in US dollars, from the API's usage numbers.
// Prices per million tokens (claude-sonnet-4-6): input 3, output 15, cache read 0.30, cache write 3.75.
const PRICES = { "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
function estimateCost(model, usage) {
  const p = PRICES[model] || PRICES["claude-sonnet-4-6"];
  const u = usage || {};
  const n = (k) => Number(u[k]) || 0;
  return (n("input_tokens") * p.input + n("output_tokens") * p.output +
    n("cache_read_input_tokens") * p.cacheRead + n("cache_creation_input_tokens") * p.cacheWrite) / 1e6;
}
// One log line per reply, easy to search for ("gm usage") in the Netlify function log.
function usageLine(kind, roomCode, model, usage) {
  const u = usage || {};
  return `gm usage kind=${kind || "other"} room=${roomCode} model=${model} in=${u.input_tokens || 0} out=${u.output_tokens || 0} ` +
    `cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} est_usd=${estimateCost(model, u).toFixed(5)}`;
}

const REST_MESSAGE = "The GM needs to rest. Come back tomorrow.";

module.exports = { clock, LIMIT_TZ, limits, usageDay, clientIp, hashIp, useGM, estimateCost, usageLine, REST_MESSAGE };
