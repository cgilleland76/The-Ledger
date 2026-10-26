// netlify/functions/gm.js
//
// Server-side proxy to the Anthropic API. Keeps ANTHROPIC_API_KEY out of the
// browser entirely — the frontend calls /api/gm, this function calls Claude,
// and only the resulting text goes back to the client.
//
// Set ANTHROPIC_API_KEY in Netlify: Site configuration > Environment variables.

const { ALLOWED_ORIGINS, roomExists } = require("./lib/shared");
const { PLAYBOOK, statBlocksFor } = require("./lib/gm-knowledge");

exports.handler = async function (event) {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };

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
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set on the server." }),
    };
  }

  let prompt, roomCode, kind, lore;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = body.prompt;
    roomCode = body.roomCode;
    kind = body.kind === "story" ? "story" : "";
    lore = typeof body.lore === "string" ? body.lore.slice(-6000) : "";
    if (!prompt || typeof prompt !== "string") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing 'prompt' string in request body." }) };
    }
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  if (!(await roomExists(roomCode))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Unknown or missing room code." }) };
  }

  // Story turns get the GM playbook (cached between calls) and stat blocks for any SRD
  // monsters named in the recent log. Other uses of this endpoint (character generation) don't.
  const payload = { model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] };
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
      const errText = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: `Anthropic API error: ${errText}` }) };
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { statusCode: 200, headers, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
