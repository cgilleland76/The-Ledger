# The Ledger: project status and handoff

One repo (`cgilleland76/The-Ledger`, branch `main`) holds the website, the Netlify functions and the Android app.
Work from either Claude session starts here.

## Layout (single source of truth)
- `public/` is the web app and the only place the client is edited. `app-www/` is generated from it by `npm run app:build` and is gitignored.
- `netlify/functions/` (GM, portraits, billing, hero-save) serves the website and the Android app alike. A fix there reaches both at once.
- `android/` is the Capacitor wrapper. A phone keeps the `app.js` it was built with, so client fixes reach it only after `npm run app:sync` and a new build. Do that from a clean, committed `main`.
- `ANDROID-APP.md` (build and Play Store notes) and `NFC-MINIS.md` (NFC minis) cover the mobile side.
- Layer Line Tycoon is a separate project and lives in `C:\Users\chase\Documents\LayerLineTycoon`, not in this repo.

## Recently shipped
- Re-rolls of the same check between GM messages are void ("rolled in error"); the GM uses the first roll.
- Ally NPC attacks on enemies roll against an AC the GM supplies.
- Foe hits subtract HP automatically; `[[heal: name | dice | source]]` raises it (capped at max).
- Pause and resume a solo story with its story code (the room code). Rooms are capped at 20, oldest evicted first.
- `?tester=1` tags test rooms (`rooms.meta.tester`); count real stories with `coalesce(meta->>'tester','false') <> 'true'`.
- Stabilising is not healing: the GM asks for a Medicine check and never uses `[[heal]]` for it; heal lines worded as stabilising are ignored by the game; a player's own healing is rolled by that player.
- Android app (Capacitor), ink credits paywall, NFC minis and NFC phase 2 (loot coins, level up, heroes save to their mini).
- HP only changes through the game: no manual HP buttons. GM directives `[[damage]]` (traps, falls, saves; `| half`), `[[heal]]`, area effects with several targets or `party` rolled once, `[[give]]`/`[[use]]` items; typed-in items are marked and not owned.
- XP from SRD kills (`[[defeat]]`, capped at party level) and verified skill rolls (`[[success]]`); `[[short-rest]]` (hit dice) and `[[long-rest]]` (full HP, unlocks Level Up). Level-ups need XP plus a long rest.
- Battle map (Battle Map tab, `rooms.meta.grid`): GM uses `[[map]]`, `[[place]]`, `[[wall]]`, `[[remove]]`, `[[end-battle]]`; players tap to move within their speed per GM turn; the GM prompt gets squares and distances. With no map, the Foes line gives distances.
- Foe HP is tracked by the game (`rooms.meta.foes`): `[[foe: name | hp]]` (SRD HP from `srd-xp.js` when no number), `[[hit: foe(s) | hero]]` applies the hero's own unused damage roll (half per foe for saves), NPC ally attacks are game-rolled, foes defeat at 0 with XP. `[[place: name | sq | ally]]` marks friendly NPCs.
- GM and other failures show in-world messages to players; details go to the Netlify function log only.
- Portrait content check: every portrait (uploaded or AI-generated) goes through `lib/portraits.js` — OpenAI `omni-moderation-latest` against `PORTRAIT_MAX_RATING` (website NC-17, Android R; missing/unknown platform = Android; env var `PORTRAIT_MAX_RATING` overrides), `sexual/minors` and illegal categories always blocked, fail closed, reason codes in the Netlify function log only. Stored with the service-role key via `/api/portrait-upload` and `portrait-background`.
- Scene backgrounds (`scenes` bucket, `rooms.scene_url/scene_status/scene_updated_at/scene_count`): host uploads its own background for free (`/api/scene-upload`); AI painting (`scene-background`) needs `SCENE_IMAGES_ENABLED=true` plus the room's opt-in in Field Notes, limit `SCENE_MAX_PER_ROOM` (3), 60 s cooldown, 10 ink when billing is on. Same content check as portraits; one file per room, old one deleted. Shown under the battle map and on `/display`. AI painting not yet tried live (switch is off).
- Blank hero minis (`supabase/minis.sql`, `/api/minis`, `lib/heroes.js`, `scripts/make-blank-minis.js`): claim codes registered by batch and serial (hashes only), free first forge with server stat and content checks, tap/claim log with `tag_copy_watch`, last 10 snapshots, My minis screen, one-transaction move, signed backups (edited files forge level 1 only), recovery by claim code. Owners stored as sha256 of the ink key. See `NFC-MINIS.md`.
- Accounts and My tables (`supabase/accounts.sql`, `/api/account`): optional sign-in by emailed link or code (Supabase Auth; the code also works in the Android app). An account remembers one ink key, so ink, minis and hosted tables come back on any device; a device with its own ink/minis/tables gets a one-time merge screen. Rooms have `kind`: **guest** (open to anyone with the code, capped at 20 site-wide, least recently played removed by `make_room_space`) or **account** (members only via `room_members`, joined with a rotatable 8-character join code, friends without accounts join as guests through anonymous sign-in unless the host turns it off, 5 active per account and the least recently played archived). "Save to my account" upgrades a guest table; players rejoin with their hero. Hosts stored as sha256 of the ink key; browsers can only write `meta` on rooms and `data` on characters. Server functions read rooms with the service-role key. Supabase settings: anonymous sign-ins on, `{{ .Token }}` in the Magic Link and Confirm signup emails, Site URL thedndledger.com. Custom SMTP still needed before real players (the built-in sender is limited to a few emails an hour).
- Upload your own portrait on the Sheet tab (cropped to 640px square in the browser, stored in the `portraits` bucket, no ink).
- Ink paywall is deployed but OFF (`BILLING_ENFORCED` unset). `billing.sql` and `tags-phase2.sql` have been run; `SUPABASE_SERVICE_ROLE_KEY` is set in Netlify. Google Play / RevenueCat (steps 7–10 in `ANDROID-APP.md`) are on hold until the owner is ready.

## Rules to keep
- Use only SRD 5.1 (CC BY 4.0) and original content. Do not use text from non-SRD books. Avoid claiming D&D compatibility.
- API keys and Supabase or Netlify settings are set by the owner, never typed in by Claude.
- Ask before pushing and before changing production data.

## Open ideas
- Roadmap on the site (public/changelog-data.js, kept in sync with this list): track spell slots, ammo, rations and gold; scene images; a second-screen table display (a shareable link or cast to a TV or remote monitor showing the scene background with the battle map grid overlaid, live; builds on scene images and the battle map); voice narration (free browser version already designed); optional accounts for private tables; session recaps; in-app feedback form; Android app; tap-to-play NFC minis.
- Safer room eviction: evict the least recently played room, not the oldest, since paused stories now live in rooms.
- Per-browser anonymous ID to count distinct players.
- Saving invented creatures and items; an SRD lookup tab; a hard client-side roll gate.
- Content check on uploaded portraits before the app goes public.
- Google Play and RevenueCat setup, and turning the ink paywall on (on hold).

## Not yet verified live
- GM compliance with the newer prompt rules (rolled in error, heal directive, ally AC field, stabilising, stopping for rolls).
- Real portrait generation and the click chips on the live site.
- Portrait upload on a real phone (Android camera/gallery picker) and against the real storage bucket.
- Loot coins and level-up saving with real stickers (tested only against a fake database).
- Blank minis with a real printed batch and real stickers (forge, move, recover).
- Accounts with real emails, anonymous guests at a private table, and realtime at account tables (tested against a local Postgres with the real rules, not the live site).
- The TV display for a private table only works on a device signed in to it or that has joined it. The Android app needs a rebuild to see its host role at tables.
