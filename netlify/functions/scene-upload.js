// netlify/functions/scene-upload.js
//
// POST /api/scene-upload  { roomCode, playerId, platform, image: "data:image/webp;base64,..." }
// The host's own background for the table: free, not limited, and available even when AI scene
// painting is switched off. The browser has already cropped it to 16:9. Same content check as
// portraits (fail closed); only then is it stored, replacing the room's previous background.

const { corsHeaders } = require("./lib/shared");
const { checkImage, REJECTED_MESSAGE } = require("./lib/portraits");
const scenes = require("./lib/scenes");

const MAX_BYTES = 3 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/;

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let roomCode, playerId, platform, image;
  try {
    ({ roomCode, playerId, platform, image } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return reply(400, { error: "That picture couldn't be read.", reason: "bad_request" });
  }
  roomCode = String(roomCode || "").toUpperCase();
  const m = DATA_URL_RE.exec(String(image || ""));
  if (!/^[A-Z0-9]{3,10}$/.test(roomCode) || !m) return reply(400, { error: "That picture couldn't be read.", reason: "bad_request" });
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) return reply(400, { error: "That picture is too large.", reason: "too_large" });

  let room;
  try { room = await scenes.loadRoom(roomCode); } catch (e) { return reply(503, { error: "Try again in a moment.", reason: "unavailable" }); }
  if (!room) return reply(404, { error: "That table isn't in the ledger.", reason: "room" });
  if (!scenes.isHost(room, playerId)) return reply(403, { error: "Only the table's host can set the background.", reason: "not_host" });

  const verdict = await checkImage(image, platform);
  if (!verdict.ok) {
    console.warn(`scene-upload: rejected (${verdict.code}) room=${roomCode} platform=${platform || "?"}`);
    if (String(verdict.code).startsWith("moderation_failed")) return reply(503, { error: "Try again in a moment.", reason: "unavailable" });
    return reply(422, { error: REJECTED_MESSAGE, reason: "rejected" });
  }
  try {
    const url = await scenes.replaceScene(room, bytes, m[1]);
    return reply(200, { url });
  } catch (e) {
    console.error("scene-upload: store failed:", e.message);
    return reply(503, { error: "Try again in a moment.", reason: "unavailable" });
  }
};
