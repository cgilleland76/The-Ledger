// public/changelog-data.js
//
// Single source of truth for both the landing-page "What's New" teaser and
// the full public/changelog.html page. Edit this file to keep it current —
// add new CHANGELOG entries (newest first) after each round of fixes/features,
// and move ROADMAP items into CHANGELOG once they actually ship.

window.LEDGER_CHANGELOG = [
  {
    date: "2026-11-14",
    type: "feature",
    title: "Pick your race and class from a list",
    detail: "Character creation now lists every SRD race (Dragonborn, Dwarf, Elf, Gnome, Half-Elf, Half-Orc, Halfling, Human, Tiefling) and class (Barbarian through Wizard). Let the GM choose, or pick Something else for any other genre."
  },
  {
    date: "2026-11-14",
    type: "feature",
    title: "Class features: Rage, Second Wind, Ki and more",
    detail: "Each class's limited-use features are now counted by the game and shown on your card: Rage, Bardic Inspiration, Channel Divinity, Wild Shape, Second Wind, Action Surge, Ki points, Lay on Hands, Divine Smite, Sorcery points and Arcane Recovery. Using one spends it, and short or long rests bring them back. Sneak Attack, unarmed strikes and Bardic Inspiration dice are in the Roll from sheet menu."
  },
  {
    date: "2026-11-14",
    type: "feature",
    title: "Ammunition and supplies are counted",
    detail: "Bolts, arrows, potions, torches, rations and coins are now counted. Firing a bow or crossbow from the Roll from sheet menu spends the ammunition, and you recover half of it after the fight. Weapons, armour and other gear always come back with you. Shops take your coins first; if you can't pay, you don't get the item."
  },
  {
    date: "2026-11-13",
    type: "feature",
    title: "Spellcasting: slots and spells",
    detail: "Casters now have spell slots and a spell list run by the game, using the SRD rules for their class and level. Choose your spells on the Your Sheet tab from your class's list; you can change them after a long rest or when a new session begins. Your card shows your save DC, slots left and spells (tap one to cast it). Casting spends a slot, and a long rest brings them back."
  },
  {
    date: "2026-11-13",
    type: "fix",
    title: "Fleeing foes leave the Foes list too",
    detail: "A foe that runs away, surrenders or otherwise leaves the fight is now taken off the Foes list and the table display as well as the battle map."
  },
  {
    date: "2026-11-13",
    type: "fix",
    title: "Death saves are rolled and counted by the game",
    detail: "A hero at 0 HP now gets a Roll death save button, one per turn, and the game keeps the count: three successes and you're stable, three failures and you die, a natural 20 brings you back with 1 HP. Damage while you're down counts as a failure. The GM no longer offers a downed hero actions; it asks for the death save instead."
  },
  {
    date: "2026-11-13",
    type: "fix",
    title: "Allies have hit points",
    detail: "Friendly characters who fight beside you now have hit points the game tracks, shown in a new Allies list on the table display. Their attacks are rolled by the game like everyone else's, damage and healing reach them, and an ally who drops is down, not defeated."
  },
  {
    date: "2026-11-13",
    type: "feature",
    title: "Sign in, private tables and My tables",
    detail: "Signing in is optional: we email you a link and a code, no password. Your ink, hero minis and tables then follow you to any device, even after clearing your browser. Tables you start while signed in are private: only players with the table's code can join, the host can make a new code at any time, and they're listed under My tables. Friends can still join without an account. Guest tables work as before, but are open to anyone with the code and can be removed when space is needed; the host can save one to their account to keep it."
  },
  {
    date: "2026-11-13",
    type: "feature",
    title: "Blank hero minis, backups and moving",
    detail: "Forge your own hero onto a blank mini for free with the claim code from its card. My minis lists your heroes and keeps the last 10 versions of each so you can roll back, download a backup, or move a hero to a new mini if the old one is lost or broken. Lost your ink key? The mini's claim code gets it back."
  },
  {
    date: "2026-11-13",
    type: "feature",
    title: "Field Notes: your party's journal",
    detail: "A new Field Notes tab keeps everything your party has learned: quests, people, places, clues, encounters and loot. The GM writes notes as the story unfolds, anyone at the table can add their own, and it's all searchable. The GM also reads the journal every turn, so it remembers what happened sessions ago. The old guide is now the How to Play tab."
  },
  {
    date: "2026-11-13",
    type: "feature",
    title: "Scene backgrounds",
    detail: "A table's host can set a background for the current scene. It shows under the battle map and on the table display. Upload your own picture for free, or, where it's switched on, have the scene painted from the GM's latest description (a few per table). Every background is checked before it's saved."
  },
  {
    date: "2026-11-12",
    type: "feature",
    title: "Table display for a TV or second screen",
    detail: "Open the Table display from the Battle Map tab on a TV, laptop or second monitor. It shows the battle map full screen, with every hero and foe in place and everyone's HP, and it updates live as the fight moves."
  },
  {
    date: "2026-11-12",
    type: "feature",
    title: "Portraits are checked before they're saved",
    detail: "Every character portrait, uploaded or painted by the AI, is now checked before it's stored. Pictures that aren't allowed are turned away and never saved; just pick a different one."
  },
  {
    date: "2026-11-12",
    type: "feature",
    title: "Foe HP is tracked by the game",
    detail: "The game now keeps each monster's hit points. Damage to a foe only comes from your own damage roll, allies' attacks are rolled by the game, and a foe is defeated when it reaches 0."
  },
  {
    date: "2026-11-11",
    type: "feature",
    title: "Battle map",
    detail: "A new Battle Map tab shows the fight on a grid. Tap a square to move your hero within your speed each turn (walls are checked), and the GM sees the squares and distances. Without a map, the GM states how far away each foe is."
  },
  {
    date: "2026-11-11",
    type: "feature",
    title: "HP only changes through the game",
    detail: "The manual HP buttons are gone. Hits, traps, falls, area effects (with half damage on a save), potions, spells and rests all change your HP through the game, and healing adds to your current HP, capped at your maximum."
  },
  {
    date: "2026-11-11",
    type: "feature",
    title: "XP, rests and leveling up",
    detail: "Defeating foes and succeeding at real skill checks earns XP. A short rest spends hit dice, a long rest restores your HP, and you level up only with enough XP plus a long rest."
  },
  {
    date: "2026-11-11",
    type: "feature",
    title: "Loot and items go into your pack",
    detail: "When the story gives you something, the game adds it to your inventory, and a used potion or other consumable counts down. Items you typed in yourself are marked and don't count as owned, so the GM won't let you use them."
  },
  {
    date: "2026-11-11",
    type: "feature",
    title: "Upload your own portrait",
    detail: "On the Sheet tab you can upload a picture for your character instead of generating one. It is cropped to a square in your browser and costs no ink."
  },
  {
    date: "2026-11-11",
    type: "fix",
    title: "Stabilising a dying character no longer \"heals\"",
    detail: "Stabilising someone at 0 HP only ends their death saves. The GM now asks for a Medicine check, and if a player's own character is healing, that player rolls it."
  },
  {
    date: "2026-10-28",
    type: "feature",
    title: "Pause a solo story and pick it up later",
    detail: "Every solo story now shows its story code, and Pause Story saves your place. Choose Join or Resume with Code and enter the code, on this device or another, to carry on right where you left off."
  },
  {
    date: "2026-10-28",
    type: "feature",
    title: "Your HP updates itself",
    detail: "When a monster's attack hits you, the damage now comes off your HP automatically, and the GM can heal you (potions, spells, rests) with the game rolling the amount and raising your HP up to your maximum. The result shows your HP before and after in the log."
  },
  {
    date: "2026-10-28",
    type: "fix",
    title: "Re-rolling a check no longer helps",
    detail: "You could roll the same check over and over and the GM would use the best-looking result. The game now marks every repeat roll of the same kind as “rolled in error” in the log, and the GM ignores it and resolves the check with your first roll. Also fixed: an ally's attack on an enemy (like your scout's longbow) was being rolled against your own character. The game now rolls it against the enemy's armor instead."
  },
  {
    date: "2026-10-27",
    type: "feature",
    title: "Click the GM's options and rolls",
    detail: "In the GM's newest message, the emoji beside each option is now a button that chooses that action for you, and every /roll command is a button that makes the roll. Each works once, and older messages go back to plain text, so you can't roll twice or by accident from the past."
  },
  {
    date: "2026-10-27",
    type: "fix",
    title: "Monsters roll in the app, and the GM waits for your roll",
    detail: "Players were being asked to roll monster attacks and damage against themselves; the game now rolls those for the monsters and posts the result in the log. The GM could also skip a roll you were meant to make and carry on with the story anyway. It now has to see your roll in the log before narrating the result of any risky action, and it no longer puts roll commands inside the options it offers."
  },
  {
    date: "2026-10-26",
    type: "feature",
    title: "The GM runs real fights",
    detail: "The Game Master now has a playbook for running the table: fair difficulty, telegraphed danger, smarter monsters, and encounters sized to your level. It also gets the real stat block for any monster in the scene (all 317 creatures from the open SRD 5.1), so armor, hit points, attacks and special abilities are the real numbers instead of guesses. Fights end each GM message with a Foes line tracking monster hit points, and the game itself rolls each monster attack and its damage against your armor class, posting the result in the log. The GM can also invent original creatures and treasure, built to the same challenge-rating math. See the credits at the bottom of the changelog page."
  },
  {
    date: "2026-10-25",
    type: "feature",
    title: "A new look: an old tome on an oak desk",
    detail: "The Ledger has been redesigned from top to bottom. Every screen is now a page in an aged book — parchment pages with ink text, gold-leaf trim, wax-red buttons and a lit-by-candle desk behind them — with new fonts, a book emblem, framed character portraits, and dice that match. Nothing about how the game plays has changed, and it works on phones too."
  },
  {
    date: "2026-10-25",
    type: "feature",
    title: "Character portraits",
    detail: "Describe how your character looks (there are new optional Gender, Age and Appearance boxes, and \"Let the GM build it\" fills them in for you) and press Generate on your Sheet tab. A painted portrait appears on your sheet and on your tile in the story and party views, in a style matched to your campaign's tone. Each player generates only their own, you can regenerate once a minute, and each table gets 10 portraits in total."
  },
  {
    date: '2026-10-24',
    type: 'fix',
    title: "GM messages are formatted, and the GM uses your real modifiers",
    detail: "GM messages used to show raw formatting symbols (**stars**, backticks, > quote marks); they now render properly with headings, quotes, lists, bold, and italics. The GM was also guessing at your bonuses — it once asked for +5 when your sheet said +3 — because it never saw your ability scores or skills. It now gets every modifier from your sheet and is told to ask only for those. Weapon attacks (ability modifier + proficiency bonus) were added to the Roll from sheet menu, so legitimate attack rolls aren't flagged."
  },
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
    title: "Track spell slots, ammo, rations and gold",
    detail: "Potions and other consumables already count down when used. Next is the rest of the limited resources a story spends: spell slots, ammo, rations, torches and gold, so your sheet reflects what the story has actually cost you."
  },
  {
    title: "Voice narration for the GM",
    detail: "Have the GM's messages read aloud, with a distinct voice for each NPC's dialogue. A no-cost, browser-based first version is already designed and ready to build."
  },
  {
    title: "Optional real accounts for private tables",
    detail: "Right now anyone with a room code can read/write that room. An opt-in account system would let a table lock things down further."
  },
  {
    title: "Session recaps",
    detail: 'Auto-generate a "previously, on..." summary at the start of a new session.'
  },
  {
    title: "In-app feedback form",
    detail: "Replace the current email-based feedback button with a form that saves directly into the app."
  },
  {
    title: "The Ledger on Android",
    detail: "A phone app version of The Ledger is built and being tested. It plays the same stories as the website."
  },
  {
    title: "Tap-to-play minis",
    detail: "Tap a 3D-printed mini with an NFC tag to a phone to bring that hero into your game, with loot and level-ups saved to the mini."
  },
];
