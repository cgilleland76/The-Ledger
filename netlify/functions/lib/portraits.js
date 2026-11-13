// netlify/functions/lib/portraits.js
//
// One path for every portrait that gets stored, uploaded or AI-generated:
//   1. checkImage()   — OpenAI moderation (omni-moderation-latest, free) against a rating ceiling;
//   2. storePortrait() — saves to the "portraits" bucket with the SERVICE-ROLE key, so the public
//      key never needs (and, once the bucket policy is dropped, can't) upload anything itself.
// Fails closed: if the check can't run, nothing is stored.
//
// Env vars: OPENAI_API_KEY (already set for portraits), SUPABASE_SERVICE_ROLE_KEY (already set),
// optional PORTRAIT_MAX_RATING — JSON overriding the ceilings below without a code change, e.g.
//   {"android":{"max":{"sexual":0.3}}}

const { SUPABASE_URL } = require("./shared");

// Highest category score allowed per platform (0..1, as returned by the moderation API).
// The website allows up to NC-17; the Android app (Google Play) up to R. A missing or unknown
// platform is treated as android, the stricter one.
const PORTRAIT_MAX_RATING = {
  web: {
    label: "NC-17",
    max: { "sexual": 0.9, "violence/graphic": 0.95, "self-harm": 0.6, "harassment": 0.85 },
  },
  android: {
    label: "R",
    max: { "sexual": 0.35, "violence/graphic": 0.8, "self-harm": 0.3, "harassment": 0.5 },
  },
};
// Never allowed at any rating (illegal or always harmful). Rejected outright.
const ALWAYS_BLOCKED = { "sexual/minors": 0.05, "illicit/violent": 0.5, "self-harm/instructions": 0.5 };

function ceilings() {
  let out = JSON.parse(JSON.stringify(PORTRAIT_MAX_RATING));
  const raw = process.env.PORTRAIT_MAX_RATING;
  if (raw) {
    try {
      const o = JSON.parse(raw);
      for (const p of Object.keys(out)) {
        if (o[p] && o[p].max) Object.assign(out[p].max, o[p].max);
        if (o[p] && o[p].label) out[p].label = o[p].label;
      }
    } catch (e) {
      console.error("portraits: PORTRAIT_MAX_RATING is not valid JSON; using the built-in ceilings");
    }
  }
  return out;
}
const platformOf = (p) => (p === "web" ? "web" : "android");

// Checks an image (a data: URL or https URL). Resolves to { ok: true } or { ok: false, code }.
// Never throws; any failure is { ok: false, code: "moderation_failed" } (fail closed).
async function checkImage(imageUrl, platform) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, code: "moderation_failed:no_key" };
  let scores;
  try {
    const resp = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: imageUrl } }] }),
    });
    if (!resp.ok) return { ok: false, code: `moderation_failed:http_${resp.status}` };
    const data = await resp.json();
    const r = data && data.results && data.results[0];
    scores = r && r.category_scores;
    if (!scores || typeof scores !== "object") return { ok: false, code: "moderation_failed:no_scores" };
  } catch (e) {
    return { ok: false, code: "moderation_failed:network" };
  }
  for (const [cat, limit] of Object.entries(ALWAYS_BLOCKED)) {
    if ((scores[cat] || 0) >= limit) return { ok: false, code: `always_blocked:${cat}` };
  }
  const plat = platformOf(platform);
  const ceiling = ceilings()[plat];
  for (const [cat, limit] of Object.entries(ceiling.max)) {
    if ((scores[cat] || 0) > limit) return { ok: false, code: `over_${ceiling.label}:${cat}` };
  }
  return { ok: true };
}

// Saves image bytes to portraits/<room>/<character>-<tag>-<time>.<ext> with the service-role key.
// Returns the public URL, or throws.
async function storePortrait(roomCode, characterId, bytes, contentType, tag) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const ext = contentType === "image/webp" ? "webp" : contentType === "image/png" ? "png" : "jpg";
  const objectPath = `${roomCode}/${characterId}-${tag}-${Date.now()}.${ext}`;
  const url = `${SUPABASE_URL}/storage/v1/object/portraits/${objectPath}`;
  const send = (headers) => fetch(url, { method: "POST", headers: { ...headers, "Content-Type": contentType, "x-upsert": "false" }, body: bytes });
  let up = await send({ apikey: key });
  if (up.status === 400 || up.status === 401 || up.status === 403) up = await send({ apikey: key, Authorization: `Bearer ${key}` });
  if (!up.ok) throw new Error(`storage upload failed (${up.status})`);
  return `${SUPABASE_URL}/storage/v1/object/public/portraits/${objectPath}`;
}

const REJECTED_MESSAGE = "That picture can't be used. Try a different one.";

module.exports = { PORTRAIT_MAX_RATING, ALWAYS_BLOCKED, checkImage, storePortrait, platformOf, REJECTED_MESSAGE };
