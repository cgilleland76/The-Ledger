# The Ledger — Remote Tabletop Hub

A small hosted app for playing tabletop RPGs with Claude as Game Master —
either solo (just you and your character) or as a group (share a room code,
everyone builds a character, one shared story log).

- **Frontend:** plain HTML/CSS/JS, no build step
- **Shared state & realtime:** Supabase (Postgres + realtime subscriptions)
- **AI Game Master:** Netlify serverless function that calls the Anthropic API,
  so your API key never touches the browser
- **Hosting:** Netlify, deployed straight from a GitHub repo

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. Once it's ready, open **SQL Editor** → **New query**, paste in the contents
   of [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates
   the `rooms`, `characters`, and `log_entries` tables, sets up permissive
   row-level-security policies (fine for a casual friend-group tool — don't
   put anything sensitive in it), and turns on realtime.
3. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key

## 2. Configure the frontend

In `public/`, copy `config.example.js` to `config.js` and fill in the two
values from step 1:

```js
window.LEDGER_CONFIG = {
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
};
```

`config.js` is safe to commit — the anon key is meant to be public; Row Level
Security is what actually controls access.

`netlify/functions/gm.js` also has its own copy of `SUPABASE_URL` and
`SUPABASE_ANON_KEY` (it uses them server-side to confirm a room code is real
before spending API budget on it) — if you ever point this app at a different
Supabase project, update both `config.js` and `gm.js`.

## 3. Get an Anthropic API key

Create one at [console.anthropic.com](https://console.anthropic.com) if you
don't have one already. You'll add this as a Netlify environment variable in
step 5 — **never** put it in any file inside `public/`.

For character portraits you also need an OpenAI API key (platform.openai.com;
image models can require organization verification). Set a monthly spending
limit on it — every portrait costs a few cents.

## 4. Push to GitHub

```bash
cd tabletop-hub
git init
git add .
git commit -m "Initial commit: The Ledger"
gh repo create the-ledger --private --source=. --push
# (or create a repo manually on github.com and follow its "push an existing repo" instructions)
```

## 5. Deploy on Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import
   an existing project**, and connect the GitHub repo you just pushed.
2. Build settings: leave the build command empty, publish directory `public`
   (already set in `netlify.toml`, so this should autofill).
3. Before the first deploy finishes, go to **Site configuration → Environment
   variables** and add:
   - `ANTHROPIC_API_KEY` = your key from step 3
   - `OPENAI_API_KEY` = your OpenAI key. It runs the content check on every uploaded portrait and scene (that check fails closed, so uploads stop working without it), and draws AI portraits when they're switched on.
   - optional: `PORTRAIT_GENERATION_ENABLED` = `true` turns on AI-generated portraits. Anything else, or unset, keeps them off: the Generate button is hidden (the app learns this from `/api/site-config`) and `portrait-background` refuses before any ink, Claude or OpenAI is spent. Uploading your own portrait, and its content check, work either way.
   - optional, GM daily limits (need `supabase/soft-launch.sql` run once). Every Claude call the GM makes (story replies, opening scenes, AI character building) is counted in the `gm_usage` table. A day is a calendar day in New York time (`LIMIT_TZ` in `netlify/functions/lib/gm-limits.js`). Past a limit, players see "The GM needs to rest. Come back tomorrow."; which limit was hit goes to the function log only. Each reply also logs a `gm usage` line with its input, output and cache tokens and an estimated cost.
     - `GM_MAX_PER_ROOM_PER_DAY` (default 60): calls per table per day.
     - `GM_MAX_PER_IP_PER_DAY` (default 100): calls per player IP per day. Only a keyed hash of the IP is stored, never the IP itself.
     - `GM_MAX_PER_USER_PER_DAY` (default 80): calls per player session per day.
     - `GM_MAX_PER_DAY` (unset by default = no site-wide cap): calls per day across the whole site.
     - `PORTRAIT_MAX_PER_USER_PER_DAY` and `SCENE_MAX_PER_USER_PER_DAY` (default 5 each): AI images per player per day, when those are switched on.
     - `MEMORIAL_MAX_PER_USER_PER_DAY` (default 3): Hall of the Fallen entries per player per day. `UPLOAD_MAX_PER_USER_PER_DAY` (default 20): uploaded portraits per player per day. Both need `supabase/beta-hardening.sql` run once; until then they are refused.
     - GM requests are only story turns and setup, with a length cap on each (`PROMPT_MAX` in `gm.js`).
   - Every server function that works on a table (GM, portraits, scenes, revive, Hall of the Fallen, saving to a mini) takes the player's Supabase session token and only answers players who have joined that table.
   - Security headers (content policy, no framing) are in `public/_headers`. The Supabase library is pinned to one version with an integrity hash in `index.html` and `display.html`; when updating it, change both tags and the hash.
   - optional: `OPENAI_IMAGE_MODEL` (default `gpt-image-2.5-flare`) and `PORTRAIT_MAX_PER_ROOM` (default 10)
   - optional: `ADMIN_SECRET`, a long random value (at least 32 characters), turns on the admin page at `/admin/` (needs `supabase/admin.sql` run once). Without it the admin function refuses everything. See PROJECT-STATUS.md.
   - optional: `PORTRAIT_MAX_RATING` (JSON) to change the portrait/scene content ceilings (website NC-17, Android R by default; see `netlify/functions/lib/portraits.js`)
   - optional: `SCENE_IMAGES_ENABLED` = `true` turns on AI-painted scene backgrounds (off by default, so they cost nothing until you opt in; hosts then switch them on per table in Field Notes). `SCENE_MAX_PER_ROOM` (default 3) limits painted scenes per table. Uploading your own background works either way. Needs `supabase/scenes.sql` run once.
4. Deploy. Netlify will build both the static site and the
   `netlify/functions/gm.js` function automatically.

Your site is now live at the `*.netlify.app` URL Netlify gives you (or a
custom domain if you add one).

## 6. Try it locally before deploying (optional)

```bash
npm install
npx netlify dev
```

This runs the static site and the serverless function together on
`localhost`, using a `.env` file for `ANTHROPIC_API_KEY` (see `.gitignore` —
this file is never committed).

---


## Feedback button

Every screen shows a floating **✉ Feedback** button, a footer line, and (in-game) a box in the Field Notes tab.
All of them open a pre-filled `mailto:` link that includes the current screen, plus room code and campaign
name when mid-game. The address comes from the `SUPPORT_EMAIL` Netlify environment variable (served by `netlify/functions/site-config.js`; a redeploy is needed after changing it), with `CONTACT_EMAIL` in `public/config.js` as the fallback (blank in both hides the feedback UI).
`mailto:` needs a mail client on the visitor's device; a Netlify Function or Supabase `feedback` table would be
the upgrade if you want a real form.

## Support link

The footer, the Field Notes feedback box, and `changelog.html` also show a "Buy me a coffee ☕" link when
`SUPPORT_URL` is set in `public/config.js`. Leave it blank to hide it everywhere it appears.

## How it works

- **Solo mode:** creates a room with `mode: 'solo'`, skips the invite-code
  flow, and hides the Party tab — it's just you, your character, and the GM.
- **Group mode:** creates a room with a shareable code (visible on the
  character-setup and in-game screens); anyone who enters that code builds
  their own character and joins the same shared log and roster. Supabase
  realtime pushes updates to everyone instantly — no polling. Capped at 6
  players per room; there's no cap on rooms. Every table is members-only:
  entering its code joins you (players without an account get an anonymous
  Supabase session), and rooms are created by the database
  (`create_guest_room`, a few per player per day). A guest room with no story
  activity for 30 days is deleted with its characters and log, unless it was
  paused with its story code in that time (`supabase/soft-launch.sql`, run
  daily by `netlify/functions/room-cleanup.js`). Rooms on an account are kept.
  Use "Leave Table" to exit and start another.
- **Character creation:** defaults to "Let the GM build it" — Claude fills in
  ability scores, HP/AC, skills, and class/tone-appropriate starting gear;
  flip to "I'll roll my own" for fully manual entry. Character tiles show all
  six ability scores plus derived Passive Perception and Initiative.
- **Roll from sheet:** a menu beside the message box lists the character's
  ability checks, skills, weapon attacks (ability mod + proficiency bonus from
  level), and initiative. The same list is sent to the GM as "Sheet
  modifiers", and the GM is told to request only those bonuses. Picking one fills in
  `/roll +N <label>`. A d20 roll whose bonus is higher than the sheet allows
  is tagged "⚠ unlisted modifier" in the log (visible to everyone, nothing is
  blocked — rolls are still computed client-side, so this deters rather than
  prevents cheating).
- **Dice popup:** every roll shows a short tumbling-dice animation (SVG + CSS,
  no libraries) that settles on the result; the log entry is held back until
  the dice land. It respects `prefers-reduced-motion`, can be dismissed with a
  click, and each player can switch it off in Field Notes (stored in
  `localStorage`). `/roll` is capped at 100 dice / d1000.
- **Dice:** typing `/roll` supports both a flat-modifier shorthand
  (`/roll +5` = d20+5) and full dice notation for anything else
  (`/roll 2d6+3` for damage, `/roll 1d4`); add `adv`/`dis` for advantage or
  disadvantage on a d20 roll. Anything else you type is narrated as your
  character's action. The GM is instructed to resolve one roll at a time —
  asking for an attack, waiting for it to land in the log, then asking for
  damage — and never to narrate an outcome ahead of the actual roll.
- **The GM:** the "Ask the GM to continue the story" button sends the recent
  log plus character/party status to `/api/gm`, which forwards it to Claude
  and appends the response back into the shared log. GM messages are rendered
  with a small safe markdown subset (headings, quotes, lists, bold/italic,
  inline code) — the text is HTML-escaped first, so only fixed tags can appear. The function requires a
  valid, existing room code before calling Claude, so the endpoint can't be
  used as a free relay by someone who just finds the URL.
- **Portraits:** each player can describe their character (the optional Appearance
  box, also filled in by the "Let the GM build it" option) and press Generate on
  their Sheet tab. `netlify/functions/portrait-background.js` (a background
  function, so it can run longer than a normal one) has Claude turn the details
  plus the campaign tone into an image prompt, asks OpenAI for the picture,
  stores it in the public `portraits` Supabase Storage bucket, and reports progress on the
  character row (`portrait_status`), which everyone's browser already watches
  through realtime (with a 5-second poll as backup). Limits: 10 per room, one per
  minute per character. Portrait URLs are only displayed if they point into our own bucket.
  Existing projects must run the "Character portraits" section at the end of
  `supabase/schema.sql` once.
- **GM knowledge:** story turns send `netlify/functions/lib/gm-knowledge.js` to Claude as a cached
  system prompt — a table-running playbook, combat and encounter-sizing rules, a creature/item creation
  guide with challenge-rating math, a conditions cheat sheet, and a bestiary index. The function also
  scans the last few log entries for monster names and appends the matching stat blocks from
  `lib/srd-monsters.json` (all 317 SRD 5.1 monsters, extracted from the SRD text). Monster attacks are
  rolled by the game: the GM writes a `[[foe-attack: name | attack | +bonus | dice | target]]` line, and the
  browser that asked the GM rolls it against the target's AC and logs the result.
  A hit on a party member comes off their HP automatically; an ally NPC's attack on an enemy adds the
  enemy's AC as a sixth field. Healing is a `[[heal: name | dice or amount | source]]` line the game rolls and
  applies (capped at max HP). Repeat rolls of the same check between two GM messages are shown as
  "rolled in error" and flagged to the GM as void.
- **Telling tests from real players:** open the site once with `?tester=1` (and `?tester=0` to turn it
  off) and every story that browser creates gets `"tester": true` in its `rooms.meta`. Count real stories with
  `select count(*) from rooms where coalesce(meta->>'tester','false') <> 'true'`. Rooms made before this
  was added carry no tag.
- **Pausing a solo story:** the story code is the room code. *Pause Story* returns to the landing page
  with the code shown; entering it under *Join or Resume with Code* (any device) reopens the story, and a
  solo story's single character is re-adopted automatically. Pausing records `rooms.paused_at`
  (`pause_room`), which keeps the story through the 30-day cleanup of idle guest rooms.
  The SRD 5.1 is licensed under CC BY 4.0; the credit is in `changelog.html#credits` and the site footer.
- **What's New:** a collapsible teaser on the landing page and a full
  `changelog.html` page track shipped fixes/features and what's planned next
  — see `public/changelog-data.js` to update it.

## Project structure

```
tabletop-hub/
├── netlify.toml              # Netlify build + redirect config
├── package.json
├── supabase/
│   └── schema.sql            # run once in Supabase's SQL editor
├── netlify/
│   └── functions/
│       ├── gm.js             # server-side Claude proxy
│       ├── portrait-background.js  # portrait generation (OpenAI images)
│       ├── site-config.js    # serves the SUPPORT_EMAIL env var to the page
│       └── lib/shared.js     # Supabase constants + helpers shared by the functions
└── public/
    ├── index.html
    ├── style.css
    ├── app.js                # all frontend logic
    ├── config.example.js     # copy to config.js and fill in
    └── config.js             # (you create this)
```

## Extending it later

- Tighter access control: swap the permissive RLS policies for ones scoped to
  Supabase Auth if you want real accounts instead of "anyone with the code."
- Character portraits: add an `image_url` field to a character's `data` and
  render it in the roster cards.
- Session recaps: have a scheduled Netlify Function summarize a room's log
  into a "previously, on..." blurb at the start of each new session.
