// public/config.example.js
//
// Copy this file to public/config.js and fill in your own Supabase project values.
// Find these in your Supabase dashboard: Project Settings > API.
//
// The anon key is safe to expose in client-side code — it's designed for that.
// Row Level Security policies (see supabase/schema.sql) control what it can actually do.

window.LEDGER_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY-HERE",
};
