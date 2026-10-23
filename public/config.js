// public/config.js
//
// Supabase project values for The Ledger — safe to commit.
// The publishable/anon key is designed to be public; Row Level Security
// policies (see supabase/schema.sql) control what it can actually do.

window.LEDGER_CONFIG = {
  SUPABASE_URL: "https://jmhgkbeqvbbxrztkvenb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_sLJhcEDWSBYAORmiL85VpA_PkNak436",
  // Where the Feedback button / footer / Help box send email. Leave blank to hide them.
  CONTACT_EMAIL: "cgilleland76@gmail.com",
  // Optional "support the project" link (e.g. Buy Me a Coffee). Leave blank to hide it.
  SUPPORT_URL: "https://buymeacoffee.com/cgilleland",
};
