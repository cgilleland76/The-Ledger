// netlify/functions/gm.js
//
// Server-side proxy to the Anthropic API. Keeps ANTHROPIC_API_KEY out of the
// browser entirely — the frontend calls /api/gm, this function calls Claude,
// and only the resulting text goes back to the client.
//
// Set ANTHROPIC_API_KEY in Netlify: Site configuration > Environment variables.
// Daily limits on these calls (per table, per IP, site-wide): lib/gm-limits.js and supabase/soft-launch.sql.

const { requireMember, corsHeaders } = require("./lib/shared");
const { PLAYBOOK, statBlocksFor } = require("./lib/gm-knowledge");
const billing = require("./lib/billing");
const gmLimits = require("./lib/gm-limits");
const SETUP_MAX = () => parseInt(process.env.SETUP_MAX_PER_ROOM, 10) || 12;
// Longest prompt accepted, in characters. A story turn carries the last 30 log lines, the party, notes and
// the map, which stays well under this; the cap keeps any one call's cost bounded.
const PROMPT_MAX = { story: 120000, setup: 6000 };

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: (console.error("gm: ANTHROPIC_API_KEY is not set"), JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" })),
    };
  }

  let prompt, roomCode, kind, lore, playerId, tz, accessToken;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = body.prompt;
    roomCode = body.roomCode;
    playerId = body.playerId;
    tz = body.tz;
    accessToken = body.accessToken;
    kind = body.kind === "story" ? "story" : body.kind === "setup" ? "setup" : "";
    lore = typeof body.lore === "string" ? body.lore.slice(-6000) : "";
    if (!prompt || typeof prompt !== "string") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
    }
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
  }

  // Only the two kinds of request the app makes: story turns and setup. Anything else, or a prompt
  // longer than that kind allows, is refused before any limit or money is touched.
  if (!kind || prompt.length > PROMPT_MAX[kind]) {
    console.warn(`gm: refused request (kind=${kind || "none"} length=${prompt.length})`);
    return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
  }

  // Only a player sitting at this table (their session token, and a membership row) can ask its GM.
  const member = await requireMember(accessToken, roomCode);
  if (!member.ok) {
    console.warn(`gm: refused (${member.reason}) room=${roomCode}`);
    return { statusCode: member.status, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: member.reason === "unavailable" ? "gm_down" : member.reason }) };
  }

  // Paused from the admin page (supabase/admin.sql, rooms.admin_paused_at): the GM waits until it's resumed.
  // Before admin.sql has been run the column doesn't exist; that lookup fails and the table plays as usual.
  try {
    const rows = await billing.sbAdmin(`rooms?code=eq.${encodeURIComponent(roomCode)}&select=admin_paused_at`);
    if (rows && rows[0] && rows[0].admin_paused_at) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: "The game is paused. The GM will answer again when it resumes.", reason: "paused" }) };
    }
  } catch (e) { /* not set up yet: not paused */ }

  // Daily limits, counted before anything is spent. Which limit was hit goes to the function log only;
  // players get one in-world message. Every way out below that produces no reply gives the call back.
  const use = await gmLimits.useGM(billing.sbAdmin, { roomCode, event, userId: member.userId });
  if (!use.ok) {
    if (use.reason === "unavailable") {
      console.error(`gm: usage limits unavailable, refusing (has supabase/soft-launch.sql been run?): ${use.detail || ""}`);
      return { statusCode: 503, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" }) };
    }
    console.warn(`gm: daily limit reached (${use.reason}) room=${roomCode} kind=${kind || "other"}`);
    return { statusCode: 429, headers, body: JSON.stringify({ error: gmLimits.REST_MESSAGE, reason: "gm_rest" }) };
  }

  // Setup requests (story title/tone, Generate Character, filling a character's blanks) are free, but
  // each table gets SETUP_MAX_PER_ROOM of them (supabase/setup-cap.sql) and short answers only.
  if (kind === "setup") {
    let allowed = true;
    try { allowed = (await billing.sbAdmin("rpc/use_setup", { method: "POST", body: { p_room: roomCode, p_max: SETUP_MAX() } })) === true; }
    catch (e) { console.warn("gm: setup cap unavailable, allowing:", e.message); } // setup-cap.sql not run yet
    if (!allowed) {
      await use.undo();
      return { statusCode: 429, headers, body: JSON.stringify({ error: "The GM has done all the setup it can for this table. Fill in the rest yourself.", reason: "setup_limit" }) };
    }
  }

  // Paywall: spend 1 ink before calling Claude (given back below if the call fails). Setup is free.
  let charge;
  try {
    charge = kind === "setup" ? { ok: true, skipped: true } : await billing.spend(playerId, "gm", tz);
  } catch (e) {
    console.error("billing spend failed:", e.message);
    await use.undo();
    return { statusCode: 503, headers, body: JSON.stringify({ error: "The ink ledger is unavailable right now. Try again in a minute." }) };
  }
  if (!charge.ok) {
    await use.undo();
    return {
      statusCode: 402,
      headers,
      body: JSON.stringify({ error: billing.outOfInkMessage("gm"), outOfInk: true, wallet: { free_left: charge.free_left, paid: charge.paid } }),
    };
  }
  const wallet = charge.skipped ? undefined : { free_left: charge.free_left, paid: charge.paid };

  // Story turns get the GM playbook (cached between calls) and stat blocks for any SRD
  // monsters named in the recent log. Other uses of this endpoint (character generation) don't.
  const payload = { model: "claude-sonnet-4-6", max_tokens: kind === "setup" ? 700 : 1000, messages: [{ role: "user", content: prompt }] };
  if (kind === "story") {
    payload.max_tokens = 1200;
    payload.system = [{ type: "text", text: PLAYBOOK, cache_control: { type: "ephemeral" } }];
    const blocks = statBlocksFor(lore);
    if (blocks) {
      payload.messages = [{
        role: "user",
        content: `${prompt}\n\nReference stat blocks for creatures in the current scene (SRD 5.1) — use these numbers exactly, and keep them private:\n${blocks}`,
      }];
    }
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      // Details (out of credit, overloaded, rate limited...) go to the Netlify function log only;
      // players get a short reason code and the app shows them an in-world message.
      const errText = await resp.text();
      console.error(`gm: Anthropic API error ${resp.status}: ${errText.slice(0, 800)}`);
      await billing.refund(playerId, charge);
      await use.undo();
      return { statusCode: 503, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" }) };
    }

    const data = await resp.json();
    // Real cost per reply, readable in the function log after a few days ("gm usage").
    console.log(gmLimits.usageLine(kind, roomCode, payload.model, data.usage));
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) { await billing.refund(playerId, charge); await use.undo(); }
    return { statusCode: 200, headers, body: JSON.stringify({ text, wallet }) };
  } catch (err) {
    console.error("gm: request failed:", err && err.message);
    await billing.refund(playerId, charge);
    await use.undo();
    return { statusCode: 503, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" }) };
  }
};
