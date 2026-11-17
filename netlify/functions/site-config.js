// netlify/functions/site-config.js
//
// Hands the browser the support/feedback email address from a Netlify
// environment variable, so it can be changed without editing or redeploying code
// files. (Set SUPPORT_EMAIL in Site configuration > Environment variables.
// The address ends up in a public mailto: link anyway, so this is not a secret.)

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

const { corsHeaders } = require("./lib/shared");
const { sceneImagesEnabled, sceneMaxPerRoom } = require("./lib/scenes");
const { COSTS, enforced } = require("./lib/billing");
const { portraitGenerationEnabled } = require("./lib/portraits");
const { reviveCost, REVIVE_DAYS } = require("./revive");

exports.handler = async function (event) {
  // Env var names are case-sensitive, so accept the casing it was likely entered with.
  const raw = (process.env.SUPPORT_EMAIL || process.env.Support_email || "").trim();
  const supportEmail = raw.length <= 120 && EMAIL_RE.test(raw) ? raw : "";
  return {
    statusCode: 200,
    headers: { ...corsHeaders(event, "GET, OPTIONS"), "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    // sceneImages: whether AI scene backgrounds are switched on (SCENE_IMAGES_ENABLED); the app hides
    // the button when they aren't. The generation function checks the switch again itself.
    // portraitGeneration: whether AI portraits are on (PORTRAIT_GENERATION_ENABLED); off hides Generate.
    body: JSON.stringify({ supportEmail, portraitGeneration: portraitGenerationEnabled(), sceneImages: sceneImagesEnabled(), sceneMaxPerRoom: sceneMaxPerRoom(), sceneInk: enforced() ? COSTS.scene : 0,
      // The Gravewarden's terms: price for a hero's 1st, 2nd, 3rd+ return (0 = free while billing is off), and days to decide.
      revive: { ink: enforced() ? [0, 1, 2].map(reviveCost) : [0, 0, 0], days: REVIVE_DAYS() } }),
  };
};
