// tests/soft-launch.test.js — offline tests for the soft-launch settings and the members-only checks. No network, no real database:
// every fetch is answered by the in-memory fake below (Supabase REST + RPCs, storage, Anthropic, OpenAI).
// The fake's RPCs follow the rules in supabase/soft-launch.sql. Run: node tests/soft-launch.test.js

const assert = require("assert");
const { SUPABASE_URL } = require("../netlify/functions/lib/shared");

// ---------- the fake world ----------
const DAY = 86400000;
const db = { rooms: [], characters: [], gm_usage: [], setup: {}, room_members: [], fallen_heroes: [], log_entries: [], tags: [] };
// Session tokens the fake auth server knows: the user id sits in the middle part, like a JWT's payload.
const tokenFor = (userId) => `eyJ.${Buffer.from(userId).toString("base64url")}.sig`;
const userOf = (token) => { try { return Buffer.from(String(token).split(".")[1], "base64url").toString(); } catch (e) { return ""; } };
const calls = { anthropic: 0, openaiImages: 0, moderation: 0, storage: 0, storageDeletes: [] };

function resetDb() {
  db.rooms = []; db.characters = []; db.gm_usage = []; db.setup = {}; db.room_members = []; db.fallen_heroes = []; db.log_entries = []; db.tags = [];
  for (const k of Object.keys(calls)) calls[k] = 0;
  calls.storageDeletes = [];
}
const json = (x, status = 200) => new Response(x === undefined ? null : JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const sum = (rows) => rows.reduce((n, r) => n + r.count, 0);
const filters = (qs) => {
  const out = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    if (v.startsWith("eq.")) out[k] = v.slice(3);
    else if (v.startsWith("gte.")) out[k] = { gte: v.slice(4) };
  }
  return out;
};
const match = (row, f) => Object.entries(f).every(([k, v]) => (typeof v === "object" ? String(row[k]) >= v.gte : String(row[k]) === v));

const RPC = {
  gm_use({ p_day, p_what, p_room, p_ip, p_user, p_room_max, p_ip_max, p_user_max, p_day_max }) {
    if (!/^[0-9a-f]{64}$/.test(p_ip) || !p_user || !["gm", "portrait", "scene", "memorial", "upload"].includes(p_what)) return { ok: false, reason: "bad_request" };
    const today = db.gm_usage.filter((r) => r.day === p_day && r.what === p_what);
    if (p_room_max > 0 && sum(today.filter((r) => r.room_code === p_room)) >= p_room_max) return { ok: false, reason: "room" };
    if (p_ip_max > 0 && sum(today.filter((r) => r.ip_hash === p_ip)) >= p_ip_max) return { ok: false, reason: "ip" };
    if (p_user_max > 0 && sum(today.filter((r) => r.user_id === p_user)) >= p_user_max) return { ok: false, reason: "user" };
    if (p_day_max > 0 && sum(today) >= p_day_max) return { ok: false, reason: "global" };
    const row = today.find((r) => r.room_code === p_room && r.ip_hash === p_ip && r.user_id === p_user);
    if (row) row.count++; else db.gm_usage.push({ day: p_day, what: p_what, room_code: p_room, ip_hash: p_ip, user_id: p_user, count: 1 });
    return { ok: true };
  },
  gm_unuse({ p_day, p_what, p_room, p_ip, p_user }) {
    const row = db.gm_usage.find((r) => r.day === p_day && r.what === p_what && r.room_code === p_room && r.ip_hash === p_ip && r.user_id === p_user && r.count > 0);
    if (row) row.count--;
    return undefined;
  },
  use_setup({ p_room, p_max }) {
    const n = db.setup[p_room] || 0;
    if (n >= p_max) return false;
    db.setup[p_room] = n + 1;
    return true;
  },
  tag_save({ p_tag, p_data, p_owner }) {
    const t = db.tags.find((x) => x.id === p_tag);
    if (!t) return { ok: false, code: "no_tag" };
    if (t.claimed_by && t.claimed_by !== p_owner) return { ok: false, code: "not_owner" };
    t.data = p_data; t.claimed_by = t.claimed_by || p_owner; t.updated_at = null; // the fake skips the 5-second gap
    return { ok: true };
  },
  cleanup_idle_rooms({ p_days }) {
    const cutoff = Date.now() - p_days * DAY;
    const gone = db.rooms.filter((r) => r.kind === "guest" && r.last_played < cutoff && (r.paused_at == null || r.paused_at < cutoff));
    db.rooms = db.rooms.filter((r) => !gone.includes(r));
    db.characters = db.characters.filter((c) => db.rooms.some((r) => r.code === c.room_code)); // cascade
    return gone.length;
  },
};

global.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
  if (url === "https://api.anthropic.com/v1/messages") {
    calls.anthropic++;
    return json({ content: [{ type: "text", text: "The tavern door creaks open." }], usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } });
  }
  if (url === "https://api.openai.com/v1/moderations") {
    calls.moderation++;
    // Text containing FLAGME is scored as clearly not allowed.
    const bad = /FLAGME/.test(JSON.stringify(body && body.input));
    return json({ results: [{ category_scores: bad ? { sexual: 0.99, "sexual/minors": 0.99, "violence/graphic": 0.99 } : { sexual: 0.01, "violence/graphic": 0.01 } }] });
  }
  if (url === `${SUPABASE_URL}/auth/v1/user`) {
    const uid = userOf(String((opts.headers || {}).Authorization || "").replace(/^Bearer /, ""));
    return uid ? json({ id: uid, is_anonymous: true }) : json({ msg: "bad token" }, 401);
  }
  if (url === "https://api.openai.com/v1/images/generations") { calls.openaiImages++; return json({ data: [{ b64_json: "AAAA" }] }); }
  if (url.startsWith(`${SUPABASE_URL}/storage/v1/object/`)) {
    if (method === "DELETE") { calls.storageDeletes.push(url); return json({}); }
    calls.storage++; return json({ Key: "ok" });
  }
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    const [table, qs = ""] = url.slice(`${SUPABASE_URL}/rest/v1/`.length).split("?");
    if (table.startsWith("rpc/")) {
      const fn = RPC[table.slice(4)];
      if (!fn) return json({ message: "no such function" }, 404);
      return json(fn(body || {}));
    }
    const rows = db[table];
    if (!rows) return json({ message: "no such table" }, 404);
    const f = filters(qs);
    if (method === "GET") return json(rows.filter((r) => match(r, f)));
    if (method === "PATCH") { rows.filter((r) => match(r, f)).forEach((r) => Object.assign(r, body)); return json(undefined, 204); }
    if (method === "POST") { rows.push({ created_at: new Date().toISOString(), ...body }); return json(undefined, 201); }
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

// ---------- helpers ----------
process.env.ANTHROPIC_API_KEY = "test-anthropic";
process.env.OPENAI_API_KEY = "test-openai";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
delete process.env.BILLING_ENFORCED;
const ENV_KEYS = ["GM_MAX_PER_ROOM_PER_DAY", "GM_MAX_PER_IP_PER_DAY", "GM_MAX_PER_DAY", "PORTRAIT_GENERATION_ENABLED"];
const setEnv = (o) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); };

const gm = require("../netlify/functions/gm");
const gmLimits = require("../netlify/functions/lib/gm-limits");
const siteConfig = require("../netlify/functions/site-config");
const portraitBg = require("../netlify/functions/portrait-background");
const portraitUpload = require("../netlify/functions/portrait-upload");
const roomCleanup = require("../netlify/functions/room-cleanup");

const NOON = new Date("2026-11-16T17:00:00Z"); // noon in New York
let now = NOON;
gmLimits.clock.now = () => now;

const logs = [];
for (const level of ["log", "warn", "error"]) {
  const orig = console[level];
  console[level] = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) orig(...a); };
}

function addRoom(code, extra = {}) { db.rooms.push({ code, kind: "guest", meta: {}, image_count: 0, last_played: Date.now(), paused_at: null, ...extra }); }
// Seats a player (user id) at a table.
function seat(code, user) { if (!db.room_members.some((m) => m.room_code === code && m.user_id === user)) db.room_members.push({ room_code: code, user_id: user }); }
// By default every IP is its own player, seated at the table; opts { user, token, seat: false } change that.
function askGM(room, ip = "203.0.113.7", kind = "story", opts = {}) {
  const user = opts.user || `user-${Buffer.from(ip).toString("hex")}`;
  if (opts.seat !== false) seat(room, user);
  const accessToken = "token" in opts ? opts.token : tokenFor(user);
  return gm.handler({
    httpMethod: "POST",
    headers: { origin: "https://thedndledger.com", "x-nf-client-connection-ip": ip },
    body: JSON.stringify({ prompt: "What happens next?", roomCode: room, kind, playerId: "player0000000000001", accessToken }),
  });
}
const parse = (r) => JSON.parse(r.body);
async function callTimes(n, fn) { const out = []; for (let i = 0; i < n; i++) out.push(await fn(i)); return out; }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 3. GM limits ----------
test("per-room limit: the 61st call of the day at one table gets the rest message", async () => {
  setEnv({}); addRoom("ROOMA");
  const ok = await callTimes(60, (i) => askGM("ROOMA", `198.51.100.${i % 50}`));
  assert(ok.every((r) => r.statusCode === 200), "first 60 succeed");
  const r = await askGM("ROOMA", "198.51.100.99");
  assert.strictEqual(r.statusCode, 429);
  assert.deepStrictEqual(parse(r), { error: "The GM needs to rest. Come back tomorrow.", reason: "gm_rest" });
  assert.strictEqual(calls.anthropic, 60, "no Claude call past the limit");
  assert(logs.some((l) => l.includes("daily limit reached (room) room=ROOMA")), "reason logged");
  assert(!JSON.stringify(parse(r)).includes("room)"), "reason not sent to the player");
});

test("per-IP limit: one IP across many tables stops at 100", async () => {
  setEnv({});
  for (let i = 0; i < 3; i++) addRoom(`IPRM${i}`);
  const ok = await callTimes(100, (i) => askGM(`IPRM${i % 3}`, "192.0.2.50", "story", { user: `u${i % 4}` }));
  assert(ok.every((r) => r.statusCode === 200));
  const r = await askGM("IPRM0", "192.0.2.50", "story", { user: "u9" });
  assert.strictEqual(r.statusCode, 429);
  assert.strictEqual(parse(r).reason, "gm_rest");
  assert(logs.some((l) => l.includes("daily limit reached (ip)")));
  assert.strictEqual((await askGM("IPRM1", "192.0.2.51")).statusCode, 200, "another IP still plays");
});

test("IPs are stored only as a 64-character hash", async () => {
  setEnv({}); addRoom("HASH1");
  await askGM("HASH1", "192.0.2.77");
  const stored = JSON.stringify(db.gm_usage);
  assert(!stored.includes("192.0.2.77"));
  assert(db.gm_usage.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash)));
});

test("site-wide limit: GM_MAX_PER_DAY=250 stops call 251", async () => {
  setEnv({ GM_MAX_PER_DAY: "250" });
  for (let i = 0; i < 10; i++) addRoom(`GLOB${i}`);
  const ok = await callTimes(250, (i) => askGM(`GLOB${i % 10}`, `10.0.${Math.floor(i / 25)}.${i % 25}`));
  assert(ok.every((r) => r.statusCode === 200));
  const r = await askGM("GLOB0", "10.9.9.9");
  assert.strictEqual(r.statusCode, 429);
  assert(logs.some((l) => l.includes("daily limit reached (global)")));
});

test("no site-wide cap when GM_MAX_PER_DAY is unset", async () => {
  setEnv({});
  for (let i = 0; i < 10; i++) addRoom(`FREE${i}`);
  const all = await callTimes(400, (i) => askGM(`FREE${i % 10}`, `10.1.${Math.floor(i / 20)}.${i % 20}`));
  assert(all.every((r) => r.statusCode === 200), "400 calls across 10 tables and 20 IPs all succeed");
});

test("the next day (New York calendar) resets every limit", async () => {
  setEnv({ GM_MAX_PER_ROOM_PER_DAY: "2" }); addRoom("DAYS1");
  now = new Date("2026-11-17T04:30:00Z"); // 11:30 pm in New York, still the 16th there
  assert.strictEqual(gmLimits.usageDay(), "2026-11-16");
  await askGM("DAYS1"); await askGM("DAYS1");
  assert.strictEqual((await askGM("DAYS1")).statusCode, 429);
  now = new Date("2026-11-17T05:05:00Z"); // 12:05 am in New York, the 17th
  assert.strictEqual(gmLimits.usageDay(), "2026-11-17");
  assert.strictEqual((await askGM("DAYS1")).statusCode, 200);
  now = NOON;
});

test("setup calls (AI character building) count too; a failed call gives its count back", async () => {
  setEnv({ GM_MAX_PER_ROOM_PER_DAY: "3" }); addRoom("SETUP");
  assert.strictEqual((await askGM("SETUP", undefined, "setup")).statusCode, 200);
  assert.strictEqual(sum(db.gm_usage.filter((r) => r.room_code === "SETUP")), 1);
  db.setup.SETUP = 999; // the table's setup allowance is used up: refused, and not counted
  assert.strictEqual(parse(await askGM("SETUP", undefined, "setup")).reason, "setup_limit");
  assert.strictEqual(sum(db.gm_usage.filter((r) => r.room_code === "SETUP")), 1);
});

test("if the usage table can't be reached, the GM refuses (no unlimited spending)", async () => {
  setEnv({}); addRoom("NODB1");
  const saved = RPC.gm_use; delete RPC.gm_use;
  try {
    const r = await askGM("NODB1");
    assert.strictEqual(r.statusCode, 503);
    assert.strictEqual(calls.anthropic, 0);
  } finally { RPC.gm_use = saved; }
});

test("each reply logs its token usage and estimated cost", async () => {
  setEnv({}); addRoom("COST1");
  await askGM("COST1");
  const line = logs.find((l) => l.startsWith("gm usage") && l.includes("room=COST1"));
  assert(line, "usage line logged");
  // 2000*3 + 300*15 + 9000*0.30 per million = 0.0132
  assert(line.includes("in=2000 out=300 cache_read=9000 cache_write=0 est_usd=0.01320"), line);
});

test("per-player limit: one session stops at 80 a day, even from many IPs", async () => {
  setEnv({});
  for (let i = 0; i < 2; i++) addRoom(`USER${i}`);
  const ok = await callTimes(80, (i) => askGM(`USER${i % 2}`, `172.16.0.${i}`, "story", { user: "solo-player" }));
  assert(ok.every((r) => r.statusCode === 200));
  const r = await askGM("USER0", "172.16.1.1", "story", { user: "solo-player" });
  assert.strictEqual(r.statusCode, 429);
  assert(logs.some((l) => l.includes("daily limit reached (user)")));
});

test("no session token: 401, and Claude is never called", async () => {
  setEnv({}); addRoom("TOKN1");
  const r = await askGM("TOKN1", "203.0.113.9", "story", { token: "" });
  assert.strictEqual(r.statusCode, 401);
  const bad = await askGM("TOKN1", "203.0.113.9", "story", { token: "not-a-token" });
  assert.strictEqual(bad.statusCode, 401);
  assert.strictEqual(calls.anthropic, 0);
});

test("a valid session that isn't at the table: 403, not counted", async () => {
  setEnv({}); addRoom("MEMB1"); addRoom("MEMB2");
  seat("MEMB2", "stranger");
  const r = await askGM("MEMB1", "203.0.113.10", "story", { user: "stranger", seat: false });
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(parse(r).reason, "not_member");
  assert.strictEqual(calls.anthropic, 0);
  assert.strictEqual(db.gm_usage.length, 0);
});

test("revive, fallen and portrait upload refuse a non-member", async () => {
  setEnv({}); addRoom("PRIV1");
  db.characters.push({ id: "hero9", room_code: "PRIV1", data: { name: "Ash", dead: true } });
  const tok = tokenFor("outsider");
  const revive = require("../netlify/functions/revive");
  const fallen = require("../netlify/functions/fallen");
  const r1 = await revive.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ roomCode: "PRIV1", characterId: "hero9", playerId: "player0000000000001", accessToken: tok }) });
  const r2 = await fallen.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "record", roomCode: "PRIV1", characterId: "hero9", accessToken: tok }) });
  const r3 = await portraitUpload.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ roomCode: "PRIV1", characterId: "hero9", platform: "web", image: "data:image/webp;base64,UklGRgAAAABXRUJQ", accessToken: tok }) });
  assert.deepStrictEqual([r1.statusCode, r2.statusCode, r3.statusCode], [403, 403, 403]);
  assert.strictEqual(calls.moderation + calls.storage + calls.anthropic, 0);
});

test("scene host check: the stored host hash doesn't pass as the ink key", async () => {
  setEnv({});
  const { ownerHash } = require("../netlify/functions/lib/heroes");
  const key = "inkkey0000000000000001";
  addRoom("HOST1", { meta: { host: ownerHash(key) } });
  seat("HOST1", "member-1");
  const sceneUpload = require("../netlify/functions/scene-upload");
  const send = (playerId) => sceneUpload.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ roomCode: "HOST1", playerId, platform: "web", image: "data:image/webp;base64,UklGRgAAAABXRUJQ", accessToken: tokenFor("member-1") }) });
  const withHash = await send(ownerHash(key));
  assert.strictEqual(withHash.statusCode, 403);
  assert.strictEqual(parse(withHash).reason, "not_host");
  const { isHost } = require("../netlify/functions/lib/scenes");
  assert.strictEqual(isHost({ meta: { host: ownerHash(key) } }, key), true, "the real ink key is the host");
  assert.strictEqual(isHost({ meta: { host: ownerHash(key) } }, "short"), false);
});

// ---------- 2. Portraits ----------
test("portrait generation is off by default: site-config says so and the function refuses", async () => {
  setEnv({}); addRoom("PORT1");
  db.characters.push({ id: "hero1", room_code: "PORT1", data: { name: "Brannoc" }, portrait_status: null, portrait_updated_at: null });
  const conf = parse(await siteConfig.handler({ headers: {} }));
  assert.strictEqual(conf.portraitGeneration, false);
  assert.strictEqual(conf.sceneImages, false, "scene images stay off too");
  seat("PORT1", "painter");
  await portraitBg.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ roomCode: "PORT1", characterId: "hero1", playerId: "player0000000000001", accessToken: tokenFor("painter") }) });
  const ch = db.characters.find((c) => c.id === "hero1");
  assert(/^error:AI portraits are switched off/.test(ch.portrait_status), ch.portrait_status);
  assert.strictEqual(calls.anthropic + calls.openaiImages, 0, "nothing spent");
});

test("anything but \"true\" keeps generation off; \"true\" turns it on", async () => {
  for (const v of ["", "yes", "1", "TRUE ", "false"]) {
    setEnv({ PORTRAIT_GENERATION_ENABLED: v });
    assert.strictEqual(parse(await siteConfig.handler({ headers: {} })).portraitGeneration, v.trim().toLowerCase() === "true", `value ${JSON.stringify(v)}`);
  }
  setEnv({ PORTRAIT_GENERATION_ENABLED: "true" });
  assert.strictEqual(parse(await siteConfig.handler({ headers: {} })).portraitGeneration, true);
});

test("portrait upload still works (and is still moderated) with generation off", async () => {
  setEnv({}); addRoom("PORT2");
  db.characters.push({ id: "hero2", room_code: "PORT2", data: { name: "Sera" } });
  seat("PORT2", "uploader");
  const r = await portraitUpload.handler({
    httpMethod: "POST", headers: {},
    body: JSON.stringify({ roomCode: "PORT2", characterId: "hero2", platform: "web", image: "data:image/webp;base64,UklGRgAAAABXRUJQ", accessToken: tokenFor("uploader") }),
  });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(calls.moderation, 1, "moderation check ran");
  assert.strictEqual(calls.storage, 1, "picture stored");
  assert.strictEqual(db.characters.find((c) => c.id === "hero2").portrait_status, "ready");
});

// ---------- 1. Room cleanup ----------
test("cleanup deletes idle guest tables, keeps recently paused, active and account tables", async () => {
  const old = Date.now() - 45 * DAY;
  addRoom("IDLE1", { last_played: old });
  addRoom("PAUSE", { last_played: old, paused_at: Date.now() - 10 * DAY });
  addRoom("OLDPS", { last_played: old, paused_at: Date.now() - 40 * DAY });
  addRoom("RECNT", { last_played: Date.now() - 5 * DAY });
  addRoom("ACCT1", { last_played: old, kind: "account" });
  db.characters.push({ id: "c1", room_code: "IDLE1", data: {} }, { id: "c2", room_code: "PAUSE", data: {} });
  const removed = await roomCleanup.cleanup();
  assert.strictEqual(removed, 2);
  assert.deepStrictEqual(db.rooms.map((r) => r.code).sort(), ["ACCT1", "PAUSE", "RECNT"]);
  assert.deepStrictEqual(db.characters.map((c) => c.id), ["c2"], "the deleted table's characters went with it");
  assert.strictEqual(roomCleanup.IDLE_DAYS, 30);
});

// ---------- beta hardening ----------
test("the GM only takes story and setup requests, and refuses oversized prompts before anything is spent", async () => {
  setEnv({}); addRoom("SIZE1"); seat("SIZE1", "sizer");
  const send = (kind, prompt) => gm.handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "203.0.113.40" },
    body: JSON.stringify({ prompt, roomCode: "SIZE1", kind, playerId: "player0000000000001", accessToken: tokenFor("sizer") }) });
  assert.strictEqual((await send("", "Write me an essay")).statusCode, 400, "no kind");
  assert.strictEqual((await send("anything", "Write me an essay")).statusCode, 400, "unknown kind");
  assert.strictEqual((await send("story", "x".repeat(120001))).statusCode, 400, "story too long");
  assert.strictEqual((await send("setup", "x".repeat(6001))).statusCode, 400, "setup too long");
  assert.strictEqual(calls.anthropic, 0);
  assert.strictEqual(db.gm_usage.length, 0, "refused requests aren't counted");
  assert.strictEqual((await send("story", "x".repeat(120000))).statusCode, 200, "a long story turn within the cap still works");
});

const fallenFn = () => require("../netlify/functions/fallen");
const recordDeath = (room, id, user, ip = "203.0.113.60") => fallenFn().handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip },
  body: JSON.stringify({ action: "record", roomCode: room, characterId: id, accessToken: tokenFor(user) }) });
const deadHero = (room, id, name, diedAt = Date.now() - 1000) => db.characters.push({ id, room_code: room, data: { name, level: 3, race: "Elf", klass: "Wizard", dead: true, diedAt } });

test("Hall of the Fallen: one entry per hero per day, even if they die again", async () => {
  setEnv({}); addRoom("HALL1"); seat("HALL1", "mourner");
  deadHero("HALL1", "hero1", "Ilsa");
  assert.strictEqual((await recordDeath("HALL1", "hero1", "mourner")).statusCode, 200);
  assert.strictEqual(db.fallen_heroes.length, 1);
  assert.strictEqual(calls.anthropic, 1, "memorial written once");
  db.characters[0].data.diedAt = Date.now(); // dies again with a new time
  const again = await recordDeath("HALL1", "hero1", "mourner");
  assert.strictEqual(parse(again).already, true);
  assert.strictEqual(db.fallen_heroes.length, 1, "no second entry");
  assert.strictEqual(calls.anthropic, 1, "no second Claude call");
});

test("Hall of the Fallen: a few entries per player a day, then refused", async () => {
  setEnv({}); addRoom("HALL2"); seat("HALL2", "reaper");
  for (let i = 1; i <= 4; i++) deadHero("HALL2", `hero${i}`, `Hero ${i}`);
  const r = await callTimes(4, (i) => recordDeath("HALL2", `hero${i + 1}`, "reaper"));
  assert.deepStrictEqual(r.map((x) => x.statusCode), [200, 200, 200, 429]);
  assert.strictEqual(db.fallen_heroes.length, 3);
  assert.strictEqual(calls.anthropic, 3);
});

test("Hall of the Fallen: names that fail the text check never reach the public list", async () => {
  setEnv({}); addRoom("HALL3"); seat("HALL3", "troll");
  deadHero("HALL3", "hero1", "FLAGME the hero");
  const r = await recordDeath("HALL3", "hero1", "troll");
  assert.strictEqual(r.statusCode, 422);
  assert.strictEqual(db.fallen_heroes.length, 0);
  assert.strictEqual(calls.anthropic, 0, "no memorial written for it");
  assert.strictEqual(sum(db.gm_usage), 0, "not counted");
});

test("Hall of the Fallen: refused (not waved through) until beta-hardening.sql has been run", async () => {
  setEnv({}); addRoom("HALL4"); seat("HALL4", "early");
  deadHero("HALL4", "hero1", "Pell");
  const saved = RPC.gm_use;
  RPC.gm_use = (a) => (a.p_what === "memorial" ? { ok: false, reason: "bad_request" } : saved(a));
  try {
    assert.strictEqual((await recordDeath("HALL4", "hero1", "early")).statusCode, 503);
    assert.strictEqual(db.fallen_heroes.length, 0);
  } finally { RPC.gm_use = saved; }
});

const upload = (room, id, user, ip = "203.0.113.70") => portraitUpload.handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip },
  body: JSON.stringify({ roomCode: room, characterId: id, platform: "web", image: "data:image/webp;base64,UklGRgAAAABXRUJQ", accessToken: tokenFor(user) }) });

test("portrait uploads: a new picture replaces the old file, and a player gets 20 a day", async () => {
  setEnv({}); addRoom("UPLD1"); seat("UPLD1", "artist");
  db.characters.push({ id: "hero1", room_code: "UPLD1", data: { name: "Vale" } });
  const realNow = Date.now;
  let t = 1_800_000_000_000;
  Date.now = () => t++; // each upload gets its own file name
  try {
    const first = parse(await upload("UPLD1", "hero1", "artist"));
    const second = parse(await upload("UPLD1", "hero1", "artist"));
    assert.notStrictEqual(first.url, second.url);
    assert.deepStrictEqual(calls.storageDeletes, [first.url.replace("/object/public/", "/object/")], "the old picture was deleted");
    await callTimes(18, () => upload("UPLD1", "hero1", "artist"));
    const r = await upload("UPLD1", "hero1", "artist");
    assert.strictEqual(r.statusCode, 429);
    assert.strictEqual(parse(r).reason, "limit");
    assert.strictEqual(calls.storage, 20, "the 21st was never stored");
  } finally { Date.now = realNow; }
});

test("portrait uploads: another character's file is never deleted", async () => {
  setEnv({}); addRoom("UPLD2"); seat("UPLD2", "artist");
  db.characters.push({ id: "hero1", room_code: "UPLD2", data: { name: "Vale" }, portrait_url: `${SUPABASE_URL}/storage/v1/object/public/portraits/OTHER/heroX-upload-1.webp` });
  assert.strictEqual((await upload("UPLD2", "hero1", "artist")).statusCode, 200);
  assert.deepStrictEqual(calls.storageDeletes, []);
});

const heroSave = require("../netlify/functions/hero-save");
const saveMini = (body) => heroSave.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });

test("saving to a mini needs a session at that table", async () => {
  setEnv({}); addRoom("MINI1");
  db.tags.push({ id: "h_abcdefghij01", kind: "hero", status: "active", data: { name: "Brannoc", level: 1, klass: "Fighter", con: 14, maxhp: 12 } });
  db.characters.push({ id: "hero1", room_code: "MINI1", data: { name: "Brannoc", level: 2, xp: 300, maxhp: 20, heroTag: "h_abcdefghij01" } });
  const base = { tagId: "h_abcdefghij01", roomCode: "MINI1", characterId: "hero1", playerId: "player0000000000001" };
  assert.strictEqual((await saveMini(base)).statusCode, 401, "no token");
  assert.strictEqual((await saveMini({ ...base, accessToken: tokenFor("stranger") })).statusCode, 403, "not at the table");
  assert.strictEqual(db.tags[0].data.level, 1, "nothing saved");
  seat("MINI1", "owner");
  const ok = await saveMini({ ...base, accessToken: tokenFor("owner") });
  assert.strictEqual(ok.statusCode, 200, ok.body);
  assert.strictEqual(db.tags[0].data.level, 2);
});

test("a mini gains at most two levels a day, however often it's saved", async () => {
  const { progressFrom } = heroSave;
  const ch = { name: "Brannoc", level: 20, xp: 355000, maxhp: 999 };
  let t = { name: "Brannoc", level: 1, xp: 0, klass: "Fighter", con: 14, maxhp: 12 };
  for (let i = 0; i < 10; i++) t = progressFrom(t, ch, "2026-11-16");
  assert.strictEqual(t.level, 3, "two levels on the first day");
  for (let i = 0; i < 10; i++) t = progressFrom(t, ch, "2026-11-17");
  assert.strictEqual(t.level, 5, "two more the next day");
  assert(t.maxhp <= 12 + 4 * 12, "max HP still grows only by the hit die + CON per level");
});


// ---------- run ----------
(async () => {
  let failed = 0;
  for (const t of tests) {
    resetDb(); logs.length = 0; now = NOON;
    try { await t.fn(); console.info(`  ok    ${t.name}`); }
    catch (e) { failed++; console.info(`  FAIL  ${t.name}\n        ${e.message}`); }
  }
  console.info(`\n${tests.length - failed} of ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
