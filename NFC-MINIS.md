# The Ledger: NFC Tap-to-Play Minis

> Idea reference: [IDEAS.md](IDEAS.md) · Android/ink setup: [ANDROID-APP.md](ANDROID-APP.md)

**Status:** Phase 1 code written and tested offline, with hero sheets locked after a tap. The `tags` table and 4 test tags are live in Supabase (2026-11-11). The app code still needs to be deployed.

**One-liner:** 3D-printed minis and tokens with an NFC sticker in the base. Tap one to a phone and The Ledger brings that hero, monster or item into your game.

## Why this is worth doing
- **No one else combines this.** AI game master apps (Friends & Fables, AI Dungeon) are software only. Doungim pairs an AI game master with physical minis, but uses a camera on a dedicated console (see Competitors). Older mini + app Kickstarters had no AI game master and are long gone. NFC on minis today mostly means "tap to see a stat card".
- **It earns twice.** You make money on the physical kit (thirdaxiscustoms) *and* on the ink players then spend in the app.
- **It uses what you already have:** a printer, a store, The Ledger, SRD monsters, and character generation.

## Competitors (checked 2026-11-11)
| Product | What it is | Overlap with us | How we differ |
|---|---|---|---|
| **Doungim** (Realm Kinetics Ltd, London), [doungim.com](https://www.doungim.com/) | A **hardware console** in three sizes. It has an AI game master (optional paid subscription), solo play and campaign memory, and is multi-system with 5e as the main one. A **camera** tracks minis and reads dice. Kickstarter ran 22 Sep – 22 Oct 2026 ("Project We Love"); no price or ship date yet. Footer says **"Patent Pending Technology"** with no detail. | AI game master at a real, in-person table; no player accounts | No hardware: your phone is the table. NFC links, not a camera. A $35 kit plus pay-as-you-go ink instead of a console plus subscription. |
| **Friends & Fables**, [fables.gg](https://fables.gg) | Software AI game master for 5e, solo or up to 6 players. A competitor's review says $20–40/month (not independently checked). | AI game master, solo and group, 5e | Pay-as-you-go ink instead of a subscription; real dice rolled in the app; Android and web; physical minis |
| **MiniTap Base** ([Thangs](https://app.thangs.com/designer/Terracronus/3d-model/MiniTap%20Base-1554328)) | A 3D-printable base that holds an NFC tag under a standard mini. A print file only, with no app. Its license restricts use. | NFC sticker in a mini base | **Don't use their file in kits.** Design our own base pocket. |
| Golem Arcana (2013), Prodigy (2014) | Older Kickstarters combining minis with an app (stylus tap, NFC). Both are gone. | Physical + digital | AI game master, and minis that still work if the service changes |

**Positioning:** *No $300 console. Your phone is the table. Tap a mini, and your hero joins the game.*

**Precautions:**
- Don't reuse Doungim's wording or look ("console", "the table is the interface").
- **Before a Kickstarter or bulk kit run,** pay a patent attorney for a search. By then Doungim's application may be published (claims are usually public about 18 months after filing). Their selling point is camera tracking on a dedicated console, which we don't do.
- Recheck this table before launch.

## How the tag works (version 1 needs no app code for NFC)
Each sticker stores **one web link**, nothing else:

```
https://<ledger-site>/t/<TAG_ID>      e.g. /t/h_7Kq2mX9pLw
```

- Phones read link tags natively. Android opens the link with no app needed, and so do iPhones (XS and newer). So version 1 needs **no NFC plugin**.
- `TAG_ID` is a long random ID (12+ characters) so tags can't be guessed. The prefix tells the app the type: `h_` hero, `m_` monster, `i_` item, `k_` campaign keystone.
- `netlify.toml` gets a redirect, `/t/*` → `/?tag=:splat`, and `app.js` handles `?tag=` on load (it already reads `?tester=` the same way).
- Later, Android App Links (an `assetlinks.json` file) can make the link open the installed app instead of the browser.

### Important: tags must never point at a room
Rooms are capped at **20 total, and the oldest is evicted** (`MAX_TOTAL_ROOMS` in `app.js`). A mini linked to a room would stop working when its room is evicted. So tags point at **lasting records** (a hero, a monster, an item) and get *added into* whatever room you're in. This is the Golem Arcana lesson: a mini should never become useless.

## Tag types
| Prefix | Tap it and… | Data |
|---|---|---|
| `h_` **Hero** | If you're at a table, join as this hero. If not, the app offers to start a solo story or join a code with them. | Name, race, class, level, stats, gear, appearance, portrait. Like an amiibo, the hero moves between campaigns. |
| `m_` **Monster** | The game master's device adds that SRD monster to the scene and tells the AI it has appeared. | SRD monster name (already in `lib/srd-monsters.json`) |
| `i_` **Item / loot** | Adds the item to the tapping player's inventory and logs it. | Item name + description |
| `k_` **Campaign keystone** (later) | Opens a long-running campaign that is **never evicted**. A premium item. | Pointer to a protected room |

## Player-made heroes (custom minis), with guardrails
Players will want to turn **their own character** into a mini. Allow it **only through the game**, so every custom tag is created, checked and owned by the server. Players never write a tag link by hand.

### The in-game flow
1. On the **Your Sheet** tab, a character that has played at least one session gets a **"Forge into a mini"** button.
2. The game runs the **guardrail checks** below. If anything fails, it says exactly what to fix.
3. A Netlify function (`netlify/functions/tags.js`, service-role key) creates the tag. It **charges ink** (e.g. 20) or uses a **blank-mini code** from a kit, then returns the tag link.
4. To put the link on a mini, the player can:
   - **Android app:** tap a blank sticker to the phone. The app writes the link, **locks the tag** so it can't be overwritten, and reads it back to confirm.
   - **iPhone / web:** see the link and a QR code, plus instructions for writing it with *NFC Tools*.
   - **Order it printed:** buy a custom mini of that hero from thirdaxiscustoms with the tag already written and locked ($14.99–24.99). This is the upsell.

### Guardrails
| Risk | Guardrail |
|---|---|
| **Inflated stats** | The server checks the sheet against the rules: ability scores 3–20 (point-buy/standard-array totals at level 1), level 1–20, max HP within the class hit-die formula for that level, AC within a sane range for the gear, skill bonuses ≤ ability mod + proficiency (×2 for expertise), and capped list lengths. Anything that fails is rejected with a reason. |
| **Editing stats after a tap** *(fixed)* | A hero from a tag gets a **read-only setup screen**: only the player's name is typed. On join, the sheet is rebuilt from the tag exactly as it was read, with numbers clamped to sane ranges, so edits made through the page are ignored. Players can still choose "Build a different character instead". (Rolls and HP are still client-side app-wide, so this deters cheating rather than proving fairness, the same as the rest of the app.) |
| **Spam / mass creation** | Costs ink or a kit code. Limit of ~3 new tags per ink key per day and ~25 total, all counted server-side. |
| **Offensive names or descriptions** | Length caps, plus a quick content check by Claude on the name, appearance and notes before the tag is created. |
| **Ownership** | Each custom tag stores `owner` (the creator's ink key). Only the owner can update or retire it. Anyone holding the mini can *play* it, because it's a physical object, like a figure you lend a friend. |
| **Takedowns** | A `status` column (`active` / `disabled`). Disabled tags show "This mini has been retired" and you can turn them off from Supabase. Players can report a mini from its card. |
| **Copies and forgery** | The tag holds only a link. All data and the checks live on the server, so a copied sticker can't change the stats or grant ink. NTAG 424 DNA chips (proof of authenticity) are an upgrade for official kits later. |
| **Group table control (optional)** | A host setting, *"Approve custom heroes"*, puts a mini-hero joining that table into a pending state until the host accepts it. |

Columns to add when building this: `owner text`, `status text default 'active'`, `source jsonb` (room code and character it was forged from), and `checked_at timestamptz`.

## Data model (new table)
```sql
create table tags (
  id text primary key,            -- the TAG_ID in the link
  kind text not null,             -- 'hero' | 'monster' | 'item' | 'keystone'
  data jsonb not null default '{}'::jsonb,
  batch text,                     -- which kit/print run it came from
  claimed_by text,                -- player key that first claimed a hero (optional)
  created_at timestamptz default now()
);
```
- Reads are public (anyone holding the mini can read its link). **Writes only happen server-side** through a Netlify function using the service-role key that `billing.js` already uses.
- Hero progress (level, HP, gear) is saved back onto the hero tag when a session ends, so a mini levels up with you.

## Ink cards: never put ink on the tag
Anyone can read and copy an NFC tag in seconds. Each kit therefore includes a **printed card with a one-time code** (e.g. `LEDG-8XQ4-2KMP`) that is redeemed through `wallet.js` into the player's ink key. The tag gives access to content; the card is what pays.

## Kits and pricing (draft)
| Product | Contents | Price |
|---|---|---|
| **Starter Table Kit** | 4 hero minis + 4 monster minis + 6 loot tokens + 300-ink card | $34.99 |
| Monster pack | 6 themed monsters (undead, goblins, dragons…) | $12.99 |
| Loot coins | 12 item tokens | $9.99 |
| **Custom hero token** | Their character's name and class symbol on a 2-color token, tag pre-written to their hero | $14.99 |
| Ink card only | 500 ink | $4.99 (sold on the web, so no Google 15% cut) |

**Unit cost:** NTAG213 stickers cost about $0.10–0.30 in bulk, plus filament, so roughly $3–6 for a starter kit.

## Making them
- **Tag:** an NTAG213 sticker (25 mm round for bases, 12 mm for coins). Keep it away from metal (magnets, metal paint).
- **Embedding:** add a pause at the layer just above a 25 mm × 0.6 mm pocket in the base, drop in the sticker, and resume. The tag is sealed inside the print.
- **Writing tags:** for version 1, use the free *NFC Tools* app: write a URL record and lock it so it can't be overwritten. Later, add a "Write tags" admin screen in the Android app using a Capacitor NFC plugin, which writes and logs a whole batch.
- **Generating IDs:** a script creates N rows in `tags`, outputs a CSV of links to write, and prints a label sheet.

## Build phases
1. **Proof of concept (about 1 weekend).** `tags` table, a `/t/*` redirect, a `?tag=` handler for **hero** and **monster**, and 3 hand-written test minis. *Done when tapping a hero mini on two phones puts that hero into the same room.*
2. **Kit-ready (about 1 week).** Item tags, ink-card redemption, hero progress saved back to the tag, an ID/CSV generator script, and a product page on thirdaxiscustoms.
3. **In-person table mode.** One shared device acts as game master in the middle of the table, players roll physical dice and type results, and monster minis tapped to the table device appear in the scene. Kits become much more useful with this.
4. **Polish.** Android App Links, an in-app tag writer, campaign keystones (rooms that are never evicted), and a Kickstarter for a bigger kit run once sales prove demand.

## Risks / open questions
- **Room cap:** 20 rooms total is fine for testing but too low once kits sell. It needs raising, or rooms need per-player limits, before launch.
- **Copied tags:** low risk, since a copied hero or monster tag costs you nothing. Ink is protected by the one-time cards.
- **Trademarks:** never say "D&D" or "Dungeons & Dragons" on minis or packaging. Use "compatible with 5e SRD" and credit CC BY 4.0, as the app already does.
- **iPhone:** reading link tags works without an app, but writing tags in-app is Android-only. That's fine, because only you write them.
