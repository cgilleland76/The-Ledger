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
- Upload your own portrait on the Sheet tab (cropped to 640px square in the browser, stored in the `portraits` bucket, no ink).
- Ink paywall is deployed but OFF (`BILLING_ENFORCED` unset). `billing.sql` and `tags-phase2.sql` have been run; `SUPABASE_SERVICE_ROLE_KEY` is set in Netlify. Google Play / RevenueCat (steps 7–10 in `ANDROID-APP.md`) are on hold until the owner is ready.

## Rules to keep
- Use only SRD 5.1 (CC BY 4.0) and original content. Do not use text from non-SRD books. Avoid claiming D&D compatibility.
- API keys and Supabase or Netlify settings are set by the owner, never typed in by Claude.
- Ask before pushing and before changing production data.

## Open ideas
- Safer room eviction: evict the least recently played room, not the oldest, since paused stories now live in rooms.
- Per-browser anonymous ID to count distinct players.
- Enemy HP tracking; consumed items leave the inventory; traps, falls and saves apply to HP.
- Saving invented creatures and items; an SRD lookup tab; a hard client-side roll gate.
- Roadmap: resource tracking, loot to inventory, scene images, voice narration, optional accounts, session recaps, an in-app feedback form.

## Not yet verified live
- GM compliance with the newer prompt rules (rolled in error, heal directive, ally AC field, stabilising, stopping for rolls).
- Real portrait generation and the click chips on the live site.
- Portrait upload on a real phone (Android camera/gallery picker) and against the real storage bucket.
- Loot coins and level-up saving with real stickers (tested only against a fake database).
- Uploaded pictures are not content-checked; add a check before the app goes public.
