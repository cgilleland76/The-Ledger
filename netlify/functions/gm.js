// netlify/functions/gm.js
//
// Server-side proxy to the Anthropic API. Keeps ANTHROPIC_API_KEY out of the
// browser entirely — the frontend calls /api/gm, this function calls Claude,
// and only the resulting text goes back to the client.
//
// Set ANTHROPIC_API_KEY in Netlify: Site configuration > Environment variables.

const { roomExists, corsHeaders } = require("./lib/shared");
const { PLAYBOOK, statBlocksFor } = require("./lib/gm-knowledge");
const billing = require("./lib/billing");
const SETUP_MAX = () => parseInt(process.env.SETUP_MAX_PER_ROOM, 10) || 12;

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

  let prompt, roomCode, kind, lore, playerId, tz;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = body.prompt;
    roomCode = body.roomCode;
    playerId = body.playerId;
    tz = body.tz;
    kind = body.kind === "story" ? "story" : body.kind === "setup" ? "setup" : "";
    lore = typeof body.lore === "string" ? body.lore.slice(-6000) : "";
    if (!prompt || typeof prompt !== "string") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
    }
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
  }

  if (!(await roomExists(roomCode))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "That table isn't in the ledger.", reason: "room" }) };
  }

  // Setup requests (story title/tone, Generate Character, filling a character's blanks) are free, but
  // each table gets SETUP_MAX_PER_ROOM of them (supabase/setup-cap.sql) and short answers only.
  if (kind === "setup") {
    if (prompt.length > 6000) return { statusCode: 400, headers, body: JSON.stringify({ error: "That request couldn't be read.", reason: "bad_request" }) };
    let allowed = true;
    try { allowed = (await billing.sbAdmin("rpc/use_setup", { method: "POST", body: { p_room: roomCode, p_max: SETUP_MAX() } })) === true; }
    catch (e) { console.warn("gm: setup cap unavailable, allowing:", e.message); } // setup-cap.sql not run yet
    if (!allowed) return { statusCode: 429, headers, body: JSON.stringify({ error: "The GM has done all the setup it can for this table. Fill in the rest yourself.", reason: "setup_limit" }) };
  }

  // Paywall: spend 1 ink before calling Claude (given back below if the call fails). Setup is free.
  let charge;
  try {
    charge = kind === "setup" ? { ok: true, skipped: true } : await billing.spend(playerId, "gm", tz);
  } catch (e) {
    console.error("billing spend failed:", e.message);
    return { statusCode: 503, headers, body: JSON.stringify({ error: "The ink ledger is unavailable right now. Try again in a minute." }) };
  }
  if (!charge.ok) {
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
      return { statusCode: 503, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" }) };
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) await billing.refund(playerId, charge);
    return { statusCode: 200, headers, body: JSON.stringify({ text, wallet }) };
  } catch (err) {
    console.error("gm: request failed:", err && err.message);
    await billing.refund(playerId, charge);
    return { statusCode: 503, headers, body: JSON.stringify({ error: "The Game Master is unavailable.", reason: "gm_down" }) };
  }
};
