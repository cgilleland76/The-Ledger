// public/config.js
//
// Supabase project values for The Ledger — safe to commit.
// The publishable/anon key is designed to be public; Row Level Security
// policies (see supabase/schema.sql) control what it can actually do.

window.LEDGER_CONFIG = {
  SUPABASE_URL: "https://jmhgkbeqvbbxrztkvenb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_sLJhcEDWSBYAORmiL85VpA_PkNak436",
  // Where the Feedback button / footer / Help box send email. Leave blank to hide them.
  CONTACT_EMAIL: "support@thirdaxiscustoms.com",
  // Optional "support the project" link (e.g. Buy Me a Coffee). Leave blank to hide it.
  SUPPORT_URL: "https://buymeacoffee.com/cgilleland", // hidden inside the Android app (Play policy)

  // ---- Android app (Capacitor) ----
  // Where the app sends GM / portrait / ink requests. Must be the live Netlify site.
  APP_API_BASE: "https://thedndledger.com",
  // RevenueCat > Project settings > API keys > the PUBLIC Google Play key (starts with goog_).
  // Public by design; the secret sk_ key goes only in Netlify env vars.
  REVENUECAT_ANDROID_KEY: "",
  // Your Play Store listing, once it exists. The website's ink shop links to it.
  PLAY_STORE_URL: "",
};
