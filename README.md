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
name when mid-game. Change the address with `CONTACT_EMAIL` in `public/config.js` (blank hides the feedback UI).
`mailto:` needs a mail client on the visitor's device; a Netlify Function or Supabase `feedback` table would be
the upgrade if you want a real form.

## How it works

- **Solo mode:** creates a room with `mode: 'solo'`, skips the invite-code
  flow, and hides the Party tab — it's just you, your character, and the GM.
- **Group mode:** creates a room with a shareable code (visible on the
  character-setup and in-game screens); anyone who enters that code builds
  their own character and joins the same shared log and roster. Supabase
  realtime pushes updates to everyone instantly — no polling. Capped at 6
  players per room and 20 rooms total; creating a room past the cap evicts
  the oldest one. Use "Leave Table" to exit and start another.
- **Character creation:** defaults to "Let the GM build it" — Claude fills in
  ability scores, HP/AC, skills, and class/tone-appropriate starting gear;
  flip to "I'll roll my own" for fully manual entry. Character tiles show all
  six ability scores plus derived Passive Perception and Initiative.
- **Dice:** typing `/roll` supports both a flat-modifier shorthand
  (`/roll +5` = d20+5) and full dice notation for anything else
  (`/roll 2d6+3` for damage, `/roll 1d4`); add `adv`/`dis` for advantage or
  disadvantage on a d20 roll. Anything else you type is narrated as your
  character's action. The GM is instructed to resolve one roll at a time —
  asking for an attack, waiting for it to land in the log, then asking for
  damage — and never to narrate an outcome ahead of the actual roll.
- **The GM:** the "Ask the GM to continue the story" button sends the recent
  log plus character/party status to `/api/gm`, which forwards it to Claude
  and appends the response back into the shared log. The function requires a
  valid, existing room code before calling Claude, so the endpoint can't be
  used as a free relay by someone who just finds the URL.
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
│       └── gm.js             # server-side Claude proxy
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
