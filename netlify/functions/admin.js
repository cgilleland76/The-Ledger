// netlify/functions/admin.js
//
// POST /api/admin  { action, ... }  with the admin token in the X-Admin-Token header.
// The only way the admin page (public/admin/) reads or changes anything. Every request must carry ADMIN_SECRET
// (Netlify environment variable, 32+ random characters); it is compared in constant time, and after 10 wrong tokens
// in 15 minutes from one IP that IP is refused for a while (supabase/admin.sql, admin_attempts). Wrong tokens wait a
// second before the answer. With no ADMIN_SECRET set, every request is refused.
// Reads and writes use the server-only service-role key. Writes go through database functions that merge only the
// changed keys, refuse if those keys changed since the page loaded them, and log every change in admin_audit.
// No CORS headers: only pages on this site can read the answers.
//
// Actions
//   read:  ping, rooms, room, characters, tags, tag, audit, god
//   write: patch_character, adjust_character, patch_room_meta, set_room, delete_room, post, roll, watch,
//          patch_tag, reset_loot, restore_snapshot

const { ROOM_CODE_RE } = require("./lib/shared");
const { sbAdmin } = require("./lib/billing");
const { clientIp, hashIp } = require("./lib/gm-limits");
const rules = require("./lib/admin-rules");

const LOCK_MINUTES = 15;
const LOCK_AFTER = 10;
const FAIL_DELAY_MS = 1000;
const CHAR_ID_RE = /^[a-z0-9]{4,20}$/i;
const TAG_ID_RE = /^[hmik]_[a-z0-9]{10,40}$/;
const TAG_STATUSES = ["blank", "active", "moved", "disabled", "used"];
const POST_AS = {
  god: { author: "GOD", type: "system" },
  narrator: { author: "Narrator", type: "system" },
  system: { author: "The Ledger", type: "system" },
  gm: { author: "Game Master", type: "gm" },
};

const enc = encodeURIComponent;
const rpc = (fn, args) => sbAdmin(`rpc/${fn}`, { method: "POST", body: args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timing = { sleep }; // swappable so tests don't wait

// Checks the request's admin token. Returns null when it's good, or the reply to send.
async function checkToken(event, reply) {
  const secret = process.env.ADMIN_SECRET || "";
  if (secret.length < rules.MIN_SECRET_LENGTH || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply(503, { error: "The admin page isn't set up on this server.", reason: "not_configured" });
  }
  const h = event.headers || {};
  const token = h["x-admin-token"] || h["X-Admin-Token"] || "";
  const ip = hashIp("admin:" + clientIp(event));
  let fails;
  try { fails = await rpc("admin_fail_count", { p_ip: ip, p_minutes: LOCK_MINUTES }); }
  catch (e) { return reply(503, { error: "The admin tables aren't reachable (has supabase/admin.sql been run?).", reason: "unavailable" }); }
  if (Number(fails) >= LOCK_AFTER) {
    await timing.sleep(FAIL_DELAY_MS);
    return reply(429, { error: "Too many wrong tokens. Try again later.", reason: "locked" });
  }
  if (rules.tokenMatches(token, secret)) return null;
  try { await rpc("admin_fail", { p_ip: ip, p_minutes: LOCK_MINUTES }); } catch (e) { /* still refused below */ }
  console.warn("admin: wrong token");
  await timing.sleep(FAIL_DELAY_MS);
  return reply(401, { error: "That admin token isn't right.", reason: "bad_token" });
}

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });

  const refused = await checkToken(event, reply);
  if (refused) return refused;

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "That request couldn't be read." }); }
  const action = String(b.action || "");
  const ip = hashIp("admin:" + clientIp(event));
  const room = typeof b.room === "string" ? b.room.toUpperCase() : "";
  const roomOk = ROOM_CODE_RE.test(room);
  const charOk = typeof b.id === "string" && CHAR_ID_RE.test(b.id);
  const tagOk = typeof b.id === "string" && TAG_ID_RE.test(b.id);
  const bad = (msg) => reply(400, { error: msg || "Missing or invalid details." });
  const fromRpc = (r) => (r && r.ok ? reply(200, r) : reply(r && r.code === "conflict" ? 409 : r && r.code === "missing" ? 404 : 422,
    { error: r && r.code === "conflict" ? "Someone changed this since you loaded it." : (r && (r.detail || r.code)) || "That didn't work.", ...(r || {}) }));
  const rejected = (c) => reply(422, { error: c.problems.join(" "), problems: c.problems });

  try {
    switch (action) {
      // ---------- reads ----------
      case "ping":
        return reply(200, { ok: true });

      case "rooms": {
        const rows = await sbAdmin("rooms?select=code,mode,kind,meta,owner_id,join_code,allow_guests,created_at,last_played,archived_at,paused_at,admin_paused_at,watcher_at,characters(count),room_members(count)&order=last_played.desc.nullslast&limit=500");
        return reply(200, { rooms: rows || [] });
      }
      case "room": {
        if (!roomOk) return bad();
        const [rooms, chars, members, log] = await Promise.all([
          sbAdmin(`rooms?code=eq.${enc(room)}&select=*`),
          sbAdmin(`characters?room_code=eq.${enc(room)}&select=id,room_code,data,portrait_url,created_at&order=created_at`),
          sbAdmin(`room_members?room_code=eq.${enc(room)}&select=user_id,role,character_id,joined_at&order=joined_at`),
          sbAdmin(`log_entries?room_code=eq.${enc(room)}&select=id,author,type,text,created_at&order=created_at.desc&limit=${b.god ? 150 : 30}`),
        ]);
        if (!rooms || !rooms.length) return reply(404, { error: "No such table." });
        if (b.god && b.watch) await rpc("admin_watch", { p_room: room, p_on: true }).catch(() => {});
        return reply(200, { room: rooms[0], characters: chars || [], members: members || [], log: (log || []).reverse() });
      }
      case "god": // same as room, with the longer story log and the watcher heartbeat
        return exports.handler({ ...event, body: JSON.stringify({ ...b, action: "room", god: true }) });
      case "characters": {
        const rows = await sbAdmin("characters?select=id,room_code,data,portrait_url,created_at&order=room_code,created_at&limit=2000");
        return reply(200, { characters: rows || [] });
      }
      case "tags": {
        const f = [];
        if (["hero", "monster", "item", "keystone"].includes(b.kind)) f.push(`kind=eq.${b.kind}`);
        if (TAG_STATUSES.includes(b.status)) f.push(`status=eq.${b.status}`);
        if (typeof b.batch === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b.batch)) f.push(`batch=eq.${enc(b.batch)}`);
        const [rows, batches] = await Promise.all([
          sbAdmin(`tags?select=id,kind,status,batch,data,claimed_by,last_played,forged_at,moved_to,updated_at,used_at,used_room,used_by${f.length ? "&" + f.join("&") : ""}&order=updated_at.desc.nullslast&limit=2000`),
          sbAdmin("tag_batches?select=batch,kind,size,active&order=batch"),
        ]);
        return reply(200, { tags: rows || [], batches: batches || [] });
      }
      case "tag": {
        if (!tagOk) return bad();
        const [t, events, snaps, claim] = await Promise.all([
          sbAdmin(`tags?id=eq.${enc(b.id)}&select=*`),
          sbAdmin(`tag_events?tag_id=eq.${enc(b.id)}&select=id,event,key_hash,detail,at&order=at.desc&limit=40`),
          sbAdmin(`tag_snapshots?tag_id=eq.${enc(b.id)}&select=id,data,saved_at&order=saved_at.desc,id.desc&limit=10`),
          sbAdmin(`tag_claims?tag_id=eq.${enc(b.id)}&select=batch,serial,issued_at,claimed_at,claimed_by`), // never the claim code's hash
        ]);
        if (!t || !t.length) return reply(404, { error: "No such mini." });
        return reply(200, { tag: t[0], events: events || [], snapshots: snaps || [], claim: (claim && claim[0]) || null });
      }
      case "audit": {
        const rows = await sbAdmin(`admin_audit?select=id,at,action,target,before,after&order=id.desc&limit=${Math.min(Math.max(parseInt(b.limit, 10) || 100, 1), 500)}`);
        return reply(200, { audit: rows || [] });
      }

      // ---------- characters ----------
      case "patch_character": {
        if (!roomOk || !charOk) return bad();
        const c = rules.checkPatch("character", b.set, b.unset);
        if (!c.ok) return rejected(c);
        return fromRpc(await rpc("admin_patch_character", { p_id: b.id, p_room: room, p_set: c.set, p_unset: c.unset, p_base: rules.baseFor(b.base, c.set, c.unset), p_ip: ip }));
      }
      case "adjust_character": {
        if (!roomOk || !charOk) return bad();
        const hp = parseInt(b.hp, 10) || 0, xp = parseInt(b.xp, 10) || 0;
        if (Math.abs(hp) > 999 || Math.abs(xp) > 400000 || (!hp && !xp)) return bad("Give an HP or XP change.");
        return fromRpc(await rpc("admin_adjust_character", { p_id: b.id, p_room: room, p_hp: hp, p_xp: xp, p_note: String(b.note || "").slice(0, 200), p_ip: ip }));
      }

      // ---------- rooms ----------
      case "patch_room_meta": {
        if (!roomOk) return bad();
        const c = rules.checkPatch("meta", b.set, b.unset);
        if (!c.ok) return rejected(c);
        return fromRpc(await rpc("admin_patch_room_meta", { p_room: room, p_set: c.set, p_unset: c.unset, p_base: rules.baseFor(b.base, c.set, c.unset), p_ip: ip }));
      }
      case "set_room": {
        if (!roomOk || !["allow_guests", "mode", "archived", "paused"].includes(b.field)) return bad();
        return fromRpc(await rpc("admin_set_room", { p_room: room, p_field: b.field, p_value: b.value, p_ip: ip }));
      }
      case "delete_room": {
        if (!roomOk) return bad();
        return fromRpc(await rpc("admin_delete_room", { p_room: room, p_confirm: String(b.confirm || ""), p_ip: ip }));
      }
      case "watch": {
        if (!roomOk) return bad();
        await rpc("admin_watch", { p_room: room, p_on: b.on === true });
        return reply(200, { ok: true });
      }
      case "post": {
        const who = POST_AS[b.as];
        const text = String(b.text || "").trim();
        if (!roomOk || !who || !text || text.length > 4000) return bad("Pick who it's from and write the message (up to 4000 characters).");
        return fromRpc(await rpc("admin_post", { p_room: room, p_author: who.author, p_type: who.type, p_text: text, p_ip: ip }));
      }
      case "roll": {
        const r = rules.rollDice(b.expr);
        if (!roomOk || !r) return bad('Write a roll like "d20+3", "2d6" or "d20 adv".');
        const label = String(b.label || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const res = await rpc("admin_post", { p_room: room, p_author: "GOD", p_type: "roll", p_text: r.text + (label ? ` (${label})` : ""), p_ip: ip });
        return res && res.ok ? reply(200, { ...res, total: r.total, text: r.text }) : fromRpc(res);
      }

      // ---------- minis, chests ----------
      case "patch_tag": {
        if (!tagOk) return bad();
        if (b.status != null && !TAG_STATUSES.includes(b.status)) return bad("Unknown status.");
        if (b.batch != null && !(typeof b.batch === "string" && /^[A-Za-z0-9_-]{0,40}$/.test(b.batch))) return bad("A batch is up to 40 letters, numbers, - or _.");
        const kind = b.id.startsWith("h_") ? "character" : b.id.startsWith("m_") ? "monster" : b.id.startsWith("i_") ? "item" : "raw";
        const hasData = (b.set && Object.keys(b.set).length) || (Array.isArray(b.unset) && b.unset.length);
        const c = hasData ? rules.checkPatch(kind, b.set, b.unset) : { ok: true, set: {}, unset: [] };
        if (!c.ok) return rejected(c);
        if (!hasData && b.status == null && b.batch == null) return bad("Nothing changed.");
        return fromRpc(await rpc("admin_patch_tag", { p_id: b.id, p_status: b.status == null ? null : b.status, p_batch: b.batch == null ? null : b.batch,
          p_set: c.set, p_unset: c.unset, p_base: rules.baseFor(b.base, c.set, c.unset), p_ip: ip }));
      }
      case "reset_loot": {
        if (!tagOk || !b.id.startsWith("i_")) return bad();
        return fromRpc(await rpc("admin_reset_loot", { p_id: b.id, p_ip: ip }));
      }
      case "restore_snapshot": {
        if (!tagOk || !Number.isInteger(b.snapshot)) return bad();
        return fromRpc(await rpc("admin_restore_snapshot", { p_tag: b.id, p_snapshot: b.snapshot, p_ip: ip }));
      }
      default:
        return bad("Unknown action.");
    }
  } catch (e) {
    console.error(`admin ${action} failed:`, e && e.message);
    return reply(503, { error: "The database didn't answer. Try again.", reason: "unavailable" });
  }
};
exports.timing = timing;
