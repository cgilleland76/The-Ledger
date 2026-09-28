// public/changelog-data.js
//
// Single source of truth for both the landing-page "What's New" teaser and
// the full public/changelog.html page. Edit this file to keep it current —
// add new CHANGELOG entries (newest first) after each round of fixes/features,
// and move ROADMAP items into CHANGELOG once they actually ship.

window.LEDGER_CHANGELOG = [
  {
    date: '2026-09-27',
    type: 'fix',
    title: "Story details no longer disappear while creating a campaign",
    detail: "Typing a title or genre/tone and then picking a Length, Ruleset, or Story Seed option used to wipe out whatever you'd already typed. All fields now save as you type, so nothing gets lost."
  },
  {
    date: '2026-09-25',
    type: 'feature',
    title: "Feedback button",
    detail: 'Added a floating "Feedback" button, a footer link, and a box in Field Notes — all open a pre-filled email so you can report a bug or suggestion in one click, including which screen and room you were on.'
  },
  {
    date: '2026-09-25',
    type: 'fix',
    title: "Dice rolls now understand real dice notation",
    detail: '/roll now works with things like "2d6+3" or "1d4" for damage, not just a flat d20 modifier. The GM also now waits for your actual roll to land before narrating what happens, instead of describing a hit or a kill before the dice were rolled.'
  },
  {
    date: '2026-07-16',
    type: 'feature',
    title: "AI-built characters, full ability scores, and table limits",
    detail: "Character creation can now generate your ability scores, HP, AC, skills, and starting gear for you (or you can still roll your own). Character sheets show your full ability scores and derived stats. Added a way to leave a table and start over, made room codes easier to see, added a loading indicator while the GM is thinking (with a Cancel option), and capped tables at 6 players / 20 rooms total."
  },
  {
    date: '2026-07-15',
    type: 'fix',
    title: "Fixed a blank-page bug affecting some players",
    detail: "A couple of code issues — including one triggered by certain browser extensions — could make the entire app fail to load with a blank screen. Both are fixed; the site now loads reliably everywhere."
  },
  {
    date: '2026-07-15',
    type: 'feature',
    title: "The Ledger goes live",
    detail: "Initial launch: solo and group play, an AI Game Master, dice rolling, character sheets, and a party roster."
  },
];

window.LEDGER_ROADMAP = [
  {
    title: "Voice narration for the GM",
    detail: "Have the GM's messages read aloud, with a distinct voice for each NPC's dialogue. A no-cost, browser-based first version is already designed and ready to build."
  },
  {
    title: "Optional real accounts for private tables",
    detail: "Right now anyone with a room code can read/write that room. An opt-in account system would let a table lock things down further."
  },
  {
    title: "Character portraits",
    detail: "Add an image to your character sheet."
  },
  {
    title: "Session recaps",
    detail: 'Auto-generate a "previously, on..." summary at the start of a new session.'
  },
  {
    title: "In-app feedback form",
    detail: "Replace the current email-based feedback button with a form that saves directly into the app."
  },
];
