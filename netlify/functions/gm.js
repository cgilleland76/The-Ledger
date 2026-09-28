// netlify/functions/gm.js
//
// Server-side proxy to the Anthropic API. Keeps ANTHROPIC_API_KEY out of the
// browser entirely — the frontend calls /api/gm, this function calls Claude,
// and only the resulting text goes back to the client.
//
// Set ANTHROPIC_API_KEY in Netlify: Site configuration > Environment variables.

// Same public values as public/config.js — safe to duplicate here since the
// anon key is designed to be exposed and RLS controls actual access. This
// lets the function verify a request is tied to a real, existing room before
// spending API budget, so this endpoint can't be used as a free relay to the
// Anthropic API by someone who just found the URL and has no room code.
const SUPABASE_URL = "https://jmhgkbeqvbbxrztkvenb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_sLJhcEDWSBYAORmiL85VpA_PkNak436";

// Add any other domains this site is (or will be) served from.
const ALLOWED_ORIGINS = [
  "https://thedndledger.netlify.app",
  "https://thedndledger.com",
  "https://www.thedndledger.com",
  "http://localhost:8888", // `netlify dev` default port
];

async function roomExists(code) {
  if (!code || typeof code !== "string" || !/^[A-Z0-9]{3,10}$/i.test(code)) return false;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/rooms?code=eq.${encodeURIComponent(code)}&select=code`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!resp.ok) return false;
    const rows = await resp.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return false;
  }
}

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

  let prompt, roomCode;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = body.prompt;
    roomCode = body.roomCode;
    if (!prompt || typeof prompt !== "string") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing 'prompt' string in request body." }) };
    }
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  if (!(await roomExists(roomCode))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Unknown or missing room code." }) };
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
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
