// tests/render-safety.test.js — players at a table can write any JSON into their character row and the room's
// meta, so every value the page draws from them must come out as plain text or a real number.
// Pulls the real helpers out of public/app.js and public/display.html and runs them. Run: node tests/render-safety.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8").replace(/\r\n/g, "\n");
const grab = (src, re, what) => { const m = src.match(re); if (!m) throw new Error(`couldn't find ${what}`); return m[0]; };

const app = read("app.js");
const appFns = new Function([
  grab(app, /function toNum[^\n]*\n/, "toNum"),
  grab(app, /const CHAR_NUMERIC_FIELDS[^\n]*\n/, "CHAR_NUMERIC_FIELDS"),
  grab(app, /function sanitizeChar[\s\S]*?\n}\n/, "sanitizeChar"),
  grab(app, /function rosterFromRows[\s\S]*?\n}\n/, "rosterFromRows"),
  grab(app, /function escapeHtml[^\n]*\n/, "escapeHtml"),
].join("\n") + "; return { rosterFromRows, escapeHtml, toNum };")();

const display = read("display.html");
const dispFns = new Function([
  grab(display, /const esc = [^\n]*\n/, "esc"),
  grab(display, /const num = [^\n]*\n/, "num"),
  grab(display, /function hpRow[\s\S]*?\n  }\n/, "hpRow"),
].join("\n") + "; return { hpRow };")();

const PAYLOAD = '1<i>markup</i>';
let failed = 0;
const test = (name, fn) => { try { fn(); console.info(`  ok    ${name}`); } catch (e) { failed++; console.info(`  FAIL  ${name}\n        ${e.message}`); } };

test("character numbers loaded from the table are always real numbers", () => {
  const c = appFns.rosterFromRows([{ id: "x1", data: { name: "T", hp: PAYLOAD, maxhp: "9", ac: PAYLOAD, level: PAYLOAD, xp: "300",
    str: PAYLOAD, dex: 14, con: "12", int: null, wis: "x", cha: 8, notes: "kept" } }]).x1;
  for (const k of ["hp", "maxhp", "ac", "level", "xp", "str", "dex", "con", "wis", "cha"]) assert.strictEqual(typeof c[k], "number", k);
  assert.deepStrictEqual([c.hp, c.maxhp, c.ac, c.level, c.xp, c.con], [0, 9, 0, 1, 300, 12]);
  assert.strictEqual(c.notes, "kept", "other fields untouched");
  assert.strictEqual(c.int, 0, "null becomes 0");
});

test("missing numbers stay missing", () => {
  const c = appFns.rosterFromRows([{ id: "x2", data: { name: "T" } }]).x2;
  assert.strictEqual("hp" in c, false);
});

test("escapeHtml handles quotes and non-strings", () => {
  assert.strictEqual(appFns.escapeHtml('a"b\'<c>&'), "a&quot;b&#39;&lt;c&gt;&amp;");
  assert.strictEqual(appFns.escapeHtml(0), "0");
  assert.strictEqual(appFns.escapeHtml(null), "");
  assert.strictEqual(appFns.escapeHtml(12), "12");
});

test("the TV display's HP rows only print numbers", () => {
  const html = dispFns.hpRow("<b>Goblin</b>", PAYLOAD, PAYLOAD, "foe", "");
  assert(!html.includes("<i>"), html);
  assert(!html.includes("<b>Goblin"), "name escaped");
  assert(html.includes("0/0"));
});

test("map size and token coordinates are forced to numbers before drawing", () => {
  assert(/function mapState\(\)[\s\S]*?g\.w = Math\.max\(0, Math\.min\(60, toNum\(g\.w\)\)\)/.test(app), "app.js mapState");
  assert(/const sq = \(x, y\) => `\$\{colName\(toNum\(x\)\)\}\$\{toNum\(y\) \+ 1\}`;/.test(app), "app.js sq()");
  assert(/g\.w = Math\.max\(0, Math\.min\(60, num\(g\.w\)\)\)/.test(display), "display.html grid");
});

console.info(`\n${failed ? "FAILED" : "all render-safety checks passed"}`);
process.exit(failed ? 1 : 0);
