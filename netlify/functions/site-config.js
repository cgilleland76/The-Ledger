// netlify/functions/site-config.js
//
// Hands the browser the support/feedback email address from a Netlify
// environment variable, so it can be changed without editing or redeploying code
// files. (Set SUPPORT_EMAIL in Site configuration > Environment variables.
// The address ends up in a public mailto: link anyway, so this is not a secret.)

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

exports.handler = async function () {
  // Env var names are case-sensitive, so accept the casing it was likely entered with.
  const raw = (process.env.SUPPORT_EMAIL || process.env.Support_email || "").trim();
  const supportEmail = raw.length <= 120 && EMAIL_RE.test(raw) ? raw : "";
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    body: JSON.stringify({ supportEmail }),
  };
};
