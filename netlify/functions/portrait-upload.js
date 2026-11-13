// netlify/functions/portrait-upload.js
//
// POST /api/portrait-upload  { roomCode, characterId, platform: "web" | "android", image: "data:image/webp;base64,..." }
// A player's own picture for their character. The browser has already cropped it to a small square;
// here it is content-checked (lib/portraits.js) and only then stored and linked on the character.
// Rejected or unchecked pictures are never stored. The reason goes to the function log only.

const { ROOM_CODE_RE, sbRest, corsHeaders } = require("./lib/shared");
const { checkImage, storePortrait, REJECTED_MESSAGE } = require("./lib/portraits");

const MAX_BYTES = 1.5 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/;

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let roomCode, characterId, platform, image;
  try {
    ({ roomCode, characterId, platform, image } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return reply(400, { error: "That picture couldn't be read.", reason: "bad_request" });
  }
  roomCode = String(roomCode || "").toUpperCase();
  const m = DATA_URL_RE.exec(String(image || ""));
  if (!ROOM_CODE_RE.test(roomCode) || !/^[a-z0-9]{4,20}$/i.test(String(characterId || "")) || !m) {
    return reply(400, { error: "That picture couldn't be read.", reason: "bad_request" });
  }
  const contentType = m[1];
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) return reply(400, { error: "That picture is too large.", reason: "too_large" });

  const enc = encodeURIComponent;
  const charPath = `characters?id=eq.${enc(characterId)}&room_code=eq.${enc(roomCode)}`;
  try {
    const rows = await sbRest(`${charPath}&select=id`);
    if (!rows.length) return reply(404, { error: "That character isn't at this table.", reason: "no_character" });
  } catch (e) {
    console.error("portrait-upload: character lookup failed:", e.message);
    return reply(503, { error: "Try again in a moment.", reason: "unavailable" });
  }

  const verdict = await checkImage(image, platform);
  if (!verdict.ok) {
    console.warn(`portrait-upload: rejected (${verdict.code}) room=${roomCode} char=${characterId} platform=${platform || "?"}`);
    // A failed check is retryable; a rejected picture is not.
    if (String(verdict.code).startsWith("moderation_failed")) return reply(503, { error: "Try again in a moment.", reason: "unavailable" });
    return reply(422, { error: REJECTED_MESSAGE, reason: "rejected" });
  }

  try {
    const url = await storePortrait(roomCode, characterId, bytes, contentType, "upload");
    const at = new Date().toISOString();
    await sbRest(charPath, { method: "PATCH", body: { portrait_url: url, portrait_status: "ready", portrait_updated_at: at } });
    return reply(200, { url, at });
  } catch (e) {
    console.error("portrait-upload: store failed:", e.message);
    return reply(503, { error: "Try again in a moment.", reason: "unavailable" });
  }
};
