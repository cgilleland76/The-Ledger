// netlify/functions/lib/scenes.js
//
// Scene backgrounds: one image per room, shown under the battle map on the table and on the
// second-screen display. Shared by scene-background.js (AI, opt-in, limited, costs ink) and
// scene-upload.js (the host's own picture, free, unlimited). Both run every image through the same
// content check as portraits (lib/portraits.js) and keep only the latest file per room.
//
// Env vars:
//   SCENE_IMAGES_ENABLED   "true" turns AI backgrounds on. Anything else: generation is off and the
//                          button is hidden (site-config tells the app). Uploads work either way.
//   SCENE_MAX_PER_ROOM     optional, AI backgrounds per room, default 3.

const { sbRest } = require("./shared");
const { storeImage, deleteImageByUrl, extFor } = require("./portraits");

const SCENE_COOLDOWN_MS = 60 * 1000;
const SCENE_STALE_PENDING_MS = 4 * 60 * 1000;

const sceneImagesEnabled = () => String(process.env.SCENE_IMAGES_ENABLED || "").trim().toLowerCase() === "true";
const sceneMaxPerRoom = () => { const n = parseInt(process.env.SCENE_MAX_PER_ROOM, 10); return Number.isFinite(n) && n >= 0 ? n : 3; };

async function loadRoom(code) {
  const rows = await sbRest(`rooms?code=eq.${encodeURIComponent(code)}&select=code,meta,scene_url,scene_status,scene_updated_at,scene_count`);
  return rows && rows[0] ? rows[0] : null;
}
// The room's host is the ink key that created it (meta.host); rooms from before hosts existed accept anyone.
function isHost(room, playerId) {
  const host = room && room.meta && room.meta.host;
  return !host || host === playerId;
}
function setScene(code, patch) {
  return sbRest(`rooms?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", body: patch });
}
// Stores the new background, points the room at it, then deletes the one it replaced.
async function replaceScene(room, bytes, contentType) {
  const url = await storeImage("scenes", `${room.code}/scene-${Date.now()}.${extFor(contentType)}`, bytes, contentType);
  await setScene(room.code, { scene_url: url, scene_status: "ready" });
  if (room.scene_url && room.scene_url !== url) await deleteImageByUrl("scenes", room.scene_url);
  return url;
}

module.exports = { SCENE_COOLDOWN_MS, SCENE_STALE_PENDING_MS, sceneImagesEnabled, sceneMaxPerRoom, loadRoom, isHost, setScene, replaceScene };
