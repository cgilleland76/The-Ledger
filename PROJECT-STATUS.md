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
- Pause and resume a solo story with its story code (the room code). Guest rooms are capped at 20; the least recently played guest room is removed for space (account rooms never are).
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
- Spellcasting (SRD 5.1, `public/srd-spells.js` + `casterOf` in app.js): slots by class/level (full, half from level 2, warlock pact), spells known/prepared and cantrips counts, spells chosen from the class list on Your Sheet only after a long rest, an Advance Session, or for a new hero; `[[cast: name | spell | level]]` spends slots or refuses. Also game-run death saves (Roll death save button, `[[stable]]`), ally HP (`[[foe: name | hp | ally]]`), and `[[remove]]` drops a foe from the list too.
- Class features (SRD 5.1, `featuresOf` in app.js): limited uses on the card (`c.featureUsed`), `[[feature: name | feature | amount | target]]` spends them (Second Wind and Lay on Hands heal, Divine Smite spends a slot and damages a foe, Arcane Recovery during a short rest), short/long rests refill. Roll menu: Sneak Attack, unarmed strike, Bardic Inspiration die.
- Gear: consumables are counted stacks ("Crossbow bolts (20)", "Gold pieces (5)", "Rations (2)"); non-consumable gear is never removed. Weapon attacks from Roll from sheet spend ammo; half is recovered at [[end-battle]] or the next rest. `[[use]]`/`[[give]]` take amounts; a failed payment blocks items given in the same message.
- Character creation: race and class pick-lists (9 SRD races, 12 classes, "Let the GM choose", "Something else…" for custom); the AI builder picks from the lists.
- Setup requests are free (`/api/gm` with kind "setup": story title/tone fill, Generate Character, filling a character's blanks): no ink, max 700 tokens, capped per table by `supabase/setup-cap.sql` (`use_setup`, `SETUP_MAX_PER_ROOM`, default 12). Allowed uncapped until that SQL is run.
- Upload your own portrait on the Sheet tab (cropped to 640px square in the browser, stored in the `portraits` bucket, no ink).
- Free to play: GM story turns come from a daily free allowance (`FREE_STORY_TURNS_PER_DAY`, default 30, refilled at the player's local midnight from the `tz` the app sends; the day only moves forward), then 1 bought ink each. Extras (portraits 8, AI scenes 10) use bought ink only. Needs `supabase/billing-daily.sql`; until then the old monthly rule applies.
- Ink paywall is deployed but OFF (`BILLING_ENFORCED` unset). `billing.sql` and `tags-phase2.sql` have been run; `SUPABASE_SERVICE_ROLE_KEY` is set in Netlify. Google Play / RevenueCat (steps 7–10 in `ANDROID-APP.md`) are on hold until the owner is ready.

## Rules to keep
- Use only SRD 5.1 (CC BY 4.0) and original content. Do not use text from non-SRD books. Avoid claiming D&D compatibility.
- API keys and Supabase or Netlify settings are set by the owner, never typed in by Claude.
- Ask before pushing and before changing production data.

## Open ideas
- Roadmap on the site (public/changelog-data.js, kept in sync with this list): voice narration (free browser version already designed), session recaps, an SRD lookup tab (spells, monsters, items), in-app feedback form, the Android app on Google Play, printed mini kits.
- Saving invented creatures and items so the GM reuses them consistently.
- Anonymous per-player count, to see real usage.
- A hard client-side roll gate.
- Custom SMTP (support@thirdaxiscustoms.com) in Supabase before real players sign in; captcha for anonymous sign-ins.
- Google Play and RevenueCat setup, then `BILLING_ENFORCED=true` (on hold).

## Not yet verified live
- GM compliance with the directives in real play: [[cast]], [[feature]], [[use]]/[[give]] amounts, ammo via weapon rolls, allies, death saves, [[stable]], [[remove]], rolled in error, stopping for rolls.
- Accounts with real emails (link and code), anonymous guests at a private table, and realtime at account tables (tested on a local Postgres with the real rules).
- Spells and class features in a real session (tested with a fake GM).
- Portrait upload on a real phone, and AI scene painting (switched off so far).
- Loot coins, level-up saving and blank minis (KIT1) with real stickers.
- The Android app is several releases behind until it's rebuilt. The TV display for a private table only works on a device signed in to it or that has joined it.
