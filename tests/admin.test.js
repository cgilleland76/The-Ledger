// tests/admin.test.js — offline tests for the admin function (netlify/functions/admin.js) and its rules
// (lib/admin-rules.js): the token check and lock-out, and what an admin edit may write. No network: every fetch
// is answered by a small fake. The database side (merges, conflicts, audit) is covered by running
// supabase/admin.sql on a local Postgres. Run: node tests/admin.test.js

const assert = require("assert");
const { SUPABASE_URL } = require("../netlify/functions/lib/shared");

// ---------- fake database ----------
const calls = [];
const fails = {}; // ip hash -> count
const rpcReplies = {};
global.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ url, body });
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
  if (!url.startsWith(`${SUPABASE_URL}/rest/v1/`)) throw new Error("unexpected fetch " + url);
  const path = url.slice(`${SUPABASE_URL}/rest/v1/`.length);
  if (path === "rpc/admin_fail_count") return json(fails[body.p_ip] || 0);
  if (path === "rpc/admin_fail") { fails[body.p_ip] = (fails[body.p_ip] || 0) + 1; return json(fails[body.p_ip]); }
  if (path.startsWith("rpc/")) { const fn = path.slice(4); return json(rpcReplies[fn] ? rpcReplies[fn](body) : { ok: true }); }
  return json([]);
};

const SECRET = "s3cret-admin-token-0123456789abcdefXYZ"; // 38 characters
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
const admin = require("../netlify/functions/admin");
const rules = require("../netlify/functions/lib/admin-rules");
admin.timing.sleep = async () => {}; // no real waiting in tests

const ask = (body, token, ip = "198.51.100.1", headerName = "x-admin-token") => admin.handler({
  httpMethod: "POST",
  headers: { "x-nf-client-connection-ip": ip, ...(token === undefined ? {} : { [headerName]: token }) },
  body: JSON.stringify(body),
});
const parse = (r) => JSON.parse(r.body);
const rpcCalls = (fn) => calls.filter((c) => c.url.endsWith("/rpc/" + fn));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- the token ----------
test("tokenMatches: only the exact secret, and only a long one", () => {
  assert.strictEqual(rules.tokenMatches(SECRET, SECRET), true);
  assert.strictEqual(rules.tokenMatches(SECRET + "x", SECRET), false);
  assert.strictEqual(rules.tokenMatches(SECRET.slice(0, -1), SECRET), false);
  assert.strictEqual(rules.tokenMatches("", SECRET), false);
  assert.strictEqual(rules.tokenMatches(undefined, SECRET), false);
  assert.strictEqual(rules.tokenMatches("short", "short"), false, "a secret under 32 characters never matches");
  assert.strictEqual(rules.tokenMatches(SECRET, undefined), false);
});

test("no ADMIN_SECRET (or a short one) on the server: every request refused", async () => {
  delete process.env.ADMIN_SECRET;
  let r = await ask({ action: "ping" }, SECRET);
  assert.strictEqual(r.statusCode, 503); assert.strictEqual(parse(r).reason, "not_configured");
  process.env.ADMIN_SECRET = "tooshort";
  r = await ask({ action: "ping" }, "tooshort");
  assert.strictEqual(r.statusCode, 503);
  assert.strictEqual(calls.length, 0, "nothing reached the database");
});

test("the right token in the header works; a missing or wrong one gets 401 and is counted", async () => {
  process.env.ADMIN_SECRET = SECRET;
  assert.strictEqual((await ask({ action: "ping" }, SECRET)).statusCode, 200);
  assert.strictEqual((await ask({ action: "ping" }, SECRET, "198.51.100.1", "X-Admin-Token")).statusCode, 200, "either header casing");
  assert.strictEqual((await ask({ action: "ping" })).statusCode, 401, "no token");
  const r = await ask({ action: "ping" }, "wrong");
  assert.strictEqual(r.statusCode, 401); assert.strictEqual(parse(r).reason, "bad_token");
  assert.strictEqual(rpcCalls("admin_fail").length, 2);
  // a token in the body or the URL is ignored
  assert.strictEqual((await ask({ action: "ping", token: SECRET, adminToken: SECRET })).statusCode, 401);
});

test("10 wrong tokens from one IP lock it out, even with the right token; other IPs unaffected", async () => {
  process.env.ADMIN_SECRET = SECRET;
  for (let i = 0; i < 10; i++) assert.strictEqual((await ask({ action: "ping" }, "guess" + i, "203.0.113.5")).statusCode, 401);
  const locked = await ask({ action: "ping" }, SECRET, "203.0.113.5");
  assert.strictEqual(locked.statusCode, 429); assert.strictEqual(parse(locked).reason, "locked");
  assert.strictEqual((await ask({ action: "ping" }, SECRET, "203.0.113.6")).statusCode, 200);
  assert(!JSON.stringify(calls).includes("203.0.113.5"), "the IP itself is never sent to the database");
});

test("if the lock-out table can't be reached, admin is refused (not waved through)", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const real = global.fetch;
  global.fetch = async () => new Response("{}", { status: 404 });
  try { assert.strictEqual((await ask({ action: "ping" }, SECRET)).statusCode, 503); } finally { global.fetch = real; }
});

test("no CORS headers on admin answers", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const r = await admin.handler({ httpMethod: "POST", headers: { origin: "https://evil.example", "x-admin-token": SECRET }, body: '{"action":"ping"}' });
  assert.strictEqual(r.statusCode, 200);
  assert(!Object.keys(r.headers).some((k) => k.toLowerCase().startsWith("access-control")));
  assert.strictEqual(r.headers["Cache-Control"], "no-store");
});

// ---------- what an edit may write ----------
test("character patch: numbers, text, inventory and skills within the app's limits", () => {
  assert.strictEqual(rules.checkPatch("character", { hp: 12, maxhp: 20, ac: 16, level: 3, xp: 900, str: 16 }).ok, true);
  for (const bad of [{ hp: "12" }, { hp: 1.5 }, { level: 21 }, { level: 0 }, { xp: -1 }, { str: 31 }, { ac: "<i>x</i>" }]) {
    assert.strictEqual(rules.checkPatch("character", bad).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(rules.checkPatch("character", { hp: 30, maxhp: 20 }).ok, false, "hp over maxhp");
  assert.strictEqual(rules.checkPatch("character", { name: "x".repeat(41) }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { name: "   " }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { notes: "x".repeat(2000) }).ok, true);
  assert.strictEqual(rules.checkPatch("character", { notes: "x".repeat(2001) }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { inventory: Array(80).fill("Rope") }).ok, true);
  assert.strictEqual(rules.checkPatch("character", { inventory: Array(81).fill("Rope") }).ok, false, "81 items");
  assert.strictEqual(rules.checkPatch("character", { inventory: ["Rope", ""] }).ok, false, "empty item");
  assert.strictEqual(rules.checkPatch("character", { inventory: ["x".repeat(81)] }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { inventory: "Rope" }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { skills: [{ name: "Athletics", mod: 5 }] }).ok, true);
  assert.strictEqual(rules.checkPatch("character", { skills: [{ name: "Athletics", mod: "5" }] }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { dead: "yes" }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { spellSlots: { 1: 2 }, conditions: ["poisoned"] }).ok, true, "other keys: any JSON");
});

test("patch shape: field names, removals, size and empty changes", () => {
  assert.strictEqual(rules.checkPatch("character", { "bad key": 1 }).ok, false);
  assert.strictEqual(rules.checkPatch("character", { __proto__x: 1 }).ok, true, "a normal key that merely looks odd is fine");
  assert.strictEqual(rules.checkPatch("character", {}, ["conditions"]).ok, true);
  assert.strictEqual(rules.checkPatch("character", {}, ["name"]).ok, false, "name can't be removed");
  assert.strictEqual(rules.checkPatch("character", { notes: "a" }, ["notes"]).ok, false, "changed and removed at once");
  assert.strictEqual(rules.checkPatch("character", {}, ["a.b"]).ok, false);
  assert.strictEqual(rules.checkPatch("raw", JSON.parse('{"__proto__":{"x":1}}')).ok, false, "__proto__ refused");
  assert.strictEqual(rules.checkPatch("raw", { constructor: 1 }).ok, false);
  assert.strictEqual(rules.checkPatch("character", {}, []).ok, false, "nothing changed");
  assert.strictEqual(rules.checkPatch("character", [1, 2]).ok, false, "an array isn't a change");
  assert.strictEqual(rules.checkPatch("raw", { blob: "x".repeat(70000) }).ok, false, "too large");
  assert.strictEqual(rules.checkPatch("nonsense", { a: 1 }).ok, false);
});

test("chest, monster and room meta rules", () => {
  assert.strictEqual(rules.checkPatch("item", { items: ["2 gold", "1 Potion of Healing"] }).ok, true);
  assert.strictEqual(rules.checkPatch("item", { items: Array(41).fill("1 gold") }).ok, false);
  assert.strictEqual(rules.checkPatch("item", { description: "x".repeat(501) }).ok, false);
  assert.strictEqual(rules.checkPatch("monster", { name: "Owlbear", cr: "3" }).ok, true);
  assert.strictEqual(rules.checkPatch("monster", { cr: "1/4" }).ok, true);
  assert.strictEqual(rules.checkPatch("monster", { cr: "lots" }).ok, false);
  assert.strictEqual(rules.checkPatch("meta", { tone: "grim", session: 3 }).ok, true);
  assert.strictEqual(rules.checkPatch("meta", { host: "raw-ink-key" }).ok, false, "host stays a hash");
  assert.strictEqual(rules.checkPatch("meta", { grid: "x" }).ok, false);
});

test("baseFor: the loaded values of exactly the changed keys (absent = null)", () => {
  assert.deepStrictEqual(rules.baseFor({ hp: 7, notes: "old", name: "Mira" }, { hp: 9, ac: 15 }, ["notes"]), { hp: 7, ac: null, notes: "old" });
  assert.deepStrictEqual(rules.baseFor(null, { hp: 9 }, []), { hp: null });
});

test("patch_character: refused edits never reach the database; good ones send only the changed keys", async () => {
  process.env.ADMIN_SECRET = SECRET;
  const bad = await ask({ action: "patch_character", room: "ROOM0001", id: "mira1", set: { hp: "<i>x</i>" }, base: { hp: 7 } }, SECRET);
  assert.strictEqual(bad.statusCode, 422);
  assert.strictEqual(rpcCalls("admin_patch_character").length, 0);
  rpcReplies.admin_patch_character = () => ({ ok: true, data: { name: "Mira", hp: 9 } });
  const ok = await ask({ action: "patch_character", room: "room0001", id: "mira1", set: { hp: 9 }, base: { hp: 7, name: "Mira", notes: "x" } }, SECRET);
  assert.strictEqual(ok.statusCode, 200, ok.body);
  const sent = rpcCalls("admin_patch_character")[0].body;
  assert.deepStrictEqual([sent.p_room, sent.p_id, sent.p_set, sent.p_unset, sent.p_base], ["ROOM0001", "mira1", { hp: 9 }, [], { hp: 7 }]);
  assert.match(sent.p_ip, /^[0-9a-f]{64}$/, "the admin's IP is stored only as a hash");
});

test("a conflict from the database comes back as 409 with the current values", async () => {
  process.env.ADMIN_SECRET = SECRET;
  rpcReplies.admin_patch_character = () => ({ ok: false, code: "conflict", keys: ["hp"], current: { hp: 3 } });
  const r = await ask({ action: "patch_character", room: "ROOM0001", id: "mira1", set: { hp: 9 }, base: { hp: 7 } }, SECRET);
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(parse(r).current, { hp: 3 });
});

test("posts and rolls: only the four voices, and dice in the app's roll format", async () => {
  process.env.ADMIN_SECRET = SECRET;
  assert.strictEqual((await ask({ action: "post", room: "ROOM0001", as: "player", text: "hi" }, SECRET)).statusCode, 400);
  assert.strictEqual((await ask({ action: "post", room: "ROOM0001", as: "god", text: "A bell tolls." }, SECRET)).statusCode, 200);
  const post = rpcCalls("admin_post").pop().body;
  assert.deepStrictEqual([post.p_author, post.p_type], ["GOD", "system"]);
  const seq = [0.5, 0.95];
  const r = rules.rollDice("2d6+3", () => seq.shift());
  assert.deepStrictEqual(r, { total: 13, text: "rolls 2d6(4+6) +3 = 13" });
  assert.strictEqual(rules.rollDice("d20", () => 0.0).text, "rolls d20(1) = 1");
  assert.strictEqual(rules.rollDice("d20 adv", () => 0.99).text, "rolls d20(20,20 adv) = 20");
  assert.strictEqual(rules.rollDice("100d6"), null);
  assert.strictEqual(rules.rollDice("rm -rf"), null);
});

test("tag edits: unknown status and bad batch refused; hero minis use the character rules", async () => {
  process.env.ADMIN_SECRET = SECRET;
  assert.strictEqual((await ask({ action: "patch_tag", id: "h_abcdefghij01", status: "stolen" }, SECRET)).statusCode, 400);
  assert.strictEqual((await ask({ action: "patch_tag", id: "h_abcdefghij01", batch: "a b" }, SECRET)).statusCode, 400);
  assert.strictEqual((await ask({ action: "patch_tag", id: "h_abcdefghij01", set: { level: 99 } }, SECRET)).statusCode, 422);
  assert.strictEqual((await ask({ action: "patch_tag", id: "h_abcdefghij01", status: "disabled" }, SECRET)).statusCode, 200);
  assert.strictEqual((await ask({ action: "reset_loot", id: "h_abcdefghij01" }, SECRET)).statusCode, 400, "only loot tags reset");
});

// ---------- run ----------
(async () => {
  let failed = 0;
  for (const t of tests) {
    calls.length = 0; for (const k of Object.keys(fails)) delete fails[k]; for (const k of Object.keys(rpcReplies)) delete rpcReplies[k];
    try { await t.fn(); console.info(`  ok    ${t.name}`); }
    catch (e) { failed++; console.info(`  FAIL  ${t.name}\n        ${e.message}`); }
  }
  console.info(`\n${tests.length - failed} of ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
