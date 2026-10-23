// public/changelog-data.js
//
// Single source of truth for both the landing-page "What's New" teaser and
// the full public/changelog.html page. Edit this file to keep it current —
// add new CHANGELOG entries (newest first) after each round of fixes/features,
// and move ROADMAP items into CHANGELOG once they actually ship.

window.LEDGER_CHANGELOG = [
  {
    date: '2026-10-23',
    type: 'feature',
    title: "Dice-rolling popup",
    detail: "Rolling now pops up tumbling dice that settle on your result — shaped to the die (d20, d6, d4, d8, d12), with a gold glow for a natural 20, red for a natural 1, and the discarded die dimmed when you roll with advantage or disadvantage. The result appears in the story log as the dice land, so it never spoils the roll. Click the popup to dismiss it early, or turn it off in Field Notes. Also capped /roll at 100 dice so a typo like 999999999d6 can't freeze the page."
  },
  {
    date: '2026-10-23',
    type: 'feature',
    title: "Roll from your character sheet, and flagged rolls",
    detail: "A new \"Roll from sheet\" menu next to the message box lists your ability checks, skills, and initiative — pick one and the right modifier and label are filled in for you (add adv or dis to roll with advantage or disadvantage). If a d20 roll uses a bonus higher than your sheet allows (say, +100 on a +3 skill), the log now tags it \"unlisted modifier\" so the whole table can see it. Damage rolls are never flagged. Also fixed one more spot where a character name wasn't escaped in the story log."
  },
  {
    date: '2026-09-27',
    type: 'fix',
    title: "Security and reliability pass",
    detail: "Character names, campaign titles, notes, skills, and inventory items weren't escaped before being displayed, which could break the page or let a player's typed text run as code in other players' browsers — fixed everywhere. Also fixed the room-limit cleanup (it was silently failing to remove old rooms), a crash that could happen from leaving a table while a character was still being generated, and added a check so the GM can't be used by outsiders who don't have a real room code."
  },
  {
    date: '2026-09-27',
    type: 'fix',
    title: "Fixed the same field-wiping bug on character creation and in-game screens",
    detail: "The same issue as the campaign-creation fix below was also happening on Build Your Character (typing a name, race, class, ability score, or notes could get wiped by switching \"Let the GM build it\" / \"I'll roll my own\"), and in-game: your typed action, a new inventory item, or unsaved character notes could get silently cleared if the log updated while you were mid-typing — including from another player's turn. All of these now save as you type."
  },
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
