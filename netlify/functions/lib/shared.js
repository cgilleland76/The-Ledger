// netlify/functions/lib/shared.js
//
// Helpers shared by the Netlify functions. (A subfolder with no index file isn't
// deployed as a function itself — it's just bundled into the ones that require it.)

// Same public values as public/config.js — safe to duplicate here since the
// anon key is designed to be exposed and RLS controls actual access. The
// functions use them to verify a request is tied to a real, existing room
// before spending API budget, so the endpoints can't be used as a free relay
// by someone who just found the URL and has no room code.
const SUPABASE_URL = "https://jmhgkbeqvbbxrztkvenb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_sLJhcEDWSBYAORmiL85VpA_PkNak436";

// Add any other domains this site is (or will be) served from.
const ALLOWED_ORIGINS = [
  "https://thedndledger.netlify.app",
  "https://thedndledger.com",
  "https://www.thedndledger.com",
  "http://localhost:8888", // `netlify dev` default port
];

const ROOM_CODE_RE = /^[A-Z0-9]{3,10}$/i;

// Minimal PostgREST helper. `path` is e.g. "rooms?code=eq.ABC12&select=code".
async function sbRest(path, { method = "GET", body, headers = {} } = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { Prefer: "return=minimal" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${resp.status})`);
  if (method !== "GET") return null;
  return resp.json();
}

async function roomExists(code) {
  if (!code || typeof code !== "string" || !ROOM_CODE_RE.test(code)) return false;
  try {
    const rows = await sbRest(`rooms?code=eq.${encodeURIComponent(code)}&select=code`);
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return false;
  }
}

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGINS, ROOM_CODE_RE, sbRest, roomExists };
