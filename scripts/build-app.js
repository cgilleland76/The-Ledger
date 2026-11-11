// scripts/build-app.js
//
// Builds the web files the Android app bundles: copies public/ into app-www/ and adds
// Capacitor's browser script, which lets app.js talk to the Google Play store module.
// The website (public/) itself is not changed. Run with: npm run app:build
// (npm run app:sync also copies the result into the Android project.)

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "public");
const out = path.join(root, "app-www");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

// The Android app has no use for the changelog page's extra assets, but they're small; keep everything.
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
fs.copyFileSync(
  path.join(root, "node_modules", "@capacitor", "core", "dist", "capacitor.js"),
  path.join(out, "vendor", "capacitor.js"),
);

const indexPath = path.join(out, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const marker = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
if (!html.includes(marker)) throw new Error("index.html changed: couldn't find the Supabase script tag to insert Capacitor before.");
html = html.replace(marker, `<script src="vendor/capacitor.js"></script>\n${marker}`);
fs.writeFileSync(indexPath, html);

const cfg = fs.readFileSync(path.join(out, "config.js"), "utf8");
if (/REVENUECAT_ANDROID_KEY:\s*""/.test(cfg)) {
  console.warn("WARNING: REVENUECAT_ANDROID_KEY is empty in public/config.js. The app will run, but its ink shop won't open.");
}
console.log("Built app-www/ from public/.");
