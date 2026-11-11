# The Ledger: Android app + ink paywall

The Android app is the same site, bundled with Capacitor. GM replies and portraits cost **ink**.
Everyone gets free ink each month; more is sold on Google Play in packs. RevenueCat confirms each purchase,
and the server keeps every balance, so nobody can get ink by editing the app.

| What | Ink | Where to change it |
|---|---|---|
| Free ink per month (refills on the 1st, UTC) | 40 | `FREE_INK_PER_MONTH` env var |
| GM reply (story turn or character generation) | 1 | `COSTS` in `netlify/functions/lib/billing.js` |
| Character portrait | 8 | same |
| Packs | 150 / 500 / 1200 | `PACKS` in `billing.js` (IDs must match Play Console) |

Suggested prices: 150 ink = $1.99, 500 = $4.99, 1200 = $9.99. One GM reply costs roughly $0.01–0.03 in Claude
usage and a portrait around $0.05, so this covers your API costs plus Google's 15% fee.

**Ink keys:** ink belongs to a random key stored on each device. If someone reinstalls the app or switches
phones, the key is the only way to keep their ink (Ink Pot → "Your ink key"). They can also enter the key on
the website to use ink they bought in the app.

---

## 1. Turn it on for the server (one time)

1. **Supabase → SQL Editor:** run `supabase/billing.sql`. It only adds new tables and functions.
2. **Netlify → Site configuration → Environment variables**, add:
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase → Project Settings → API keys → **secret** key. Never put it in `public/`.
   - `REVENUECAT_SECRET_KEY`: from step 3 below (`sk_...`).
   - `BILLING_ENFORCED` = `true`. **Set this last.** Until you do, everything stays free, exactly as it is now.
3. Deploy. The website then shows an ink badge in the game header. Web players get the free monthly ink,
   and the shop points them to the Android app.

## 2. Google Play Console

1. Create a developer account at play.google.com/console (one-time $25 fee, plus ID verification).
2. Create the app "The Ledger". The package name is `com.thedndledger.app` and **can never change after the first
   upload**. If you want a different one, change `appId` in `capacitor.config.json` *before* step 4, then delete
   the `android/` folder and run `npx cap add android` again.
3. Set up a payments profile so you can sell.
4. Upload a first build to **Internal testing** (Play only lets you create in-app products after an upload).
5. **Monetize → Products → In-app products:** create `ledger_ink_150`, `ledger_ink_500`, `ledger_ink_1200`
   with titles like "150 Ink" and your prices. Activate them.
6. **Setup → License testing:** add your Gmail so your test purchases are free.

## 3. RevenueCat

1. Sign up at revenuecat.com (free until $2.5K/month in revenue, then 1%). Create a project with a Google Play app
   for `com.thedndledger.app`.
2. Follow RevenueCat's guide to connect a Google Cloud **service account** to Play Console (this lets RevenueCat
   verify purchases).
3. **Products:** add the three product IDs and mark them as **consumable**. **Offerings:** add them as packages
   to the *current* offering. That's the list the app shows.
4. **API keys:** put the public Google key (`goog_...`) in `public/config.js` as `REVENUECAT_ANDROID_KEY`. Put the
   secret key (`sk_...`) only in Netlify as `REVENUECAT_SECRET_KEY`.

## 4. Build the app (on this PC)

1. Install **Android Studio** (developer.android.com/studio). It brings Java and the Android SDK.
2. In this folder:
   ```
   npm run app:sync
   npm run app:open
   ```
   `app:sync` copies `public/` to `app-www/`, adds the Capacitor bridge script, and copies it into `android/`.
   Run it again after every change to `public/`.
3. In Android Studio: plug in a phone (USB debugging on) or start an emulator with Google Play, then press Run.
4. For the Play Store: **Build → Generate Signed App Bundle**, create an upload key (**back it up**, along with its
   password), and upload the `.aab` to Internal testing.

## 5. Test before going public

On an internal-testing install (signed in as a license tester):
- [ ] Badge shows 40 ink. A GM reply drops it to 39.
- [ ] A portrait costs 8, and a failed portrait gives the ink back.
- [ ] Buying 150 ink shows "Added 150 ink" and the badge goes up. Cancelling shows "Purchase cancelled".
- [ ] Force-close the app mid-purchase and reopen: the ink still arrives.
- [ ] Spend down to 0: the GM says you're out of ink and the Ink Pot opens.
- [ ] Copy the ink key, enter it on the website: the same balance shows there.

Then set `ALLOW_SANDBOX_PURCHASES=false` in Netlify if you don't want test purchases to count any more.

## Known gaps

- **Refunds:** if Google refunds a purchase, the ink isn't taken back. A RevenueCat webhook for this can be added later.
- **Free-ink farming:** a determined person can clear app data to get a new key and new free ink. The free
  allowance is small to limit the cost of this. Play Integrity or sign-in would close it.
- **The app needs the live site:** GM, portraits and ink all go to `APP_API_BASE` (`https://thedndledger.com`), so that
  domain must be connected to Netlify before the app works.
