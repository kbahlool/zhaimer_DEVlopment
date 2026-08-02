# Zhaimer — The Ultimate Memory Card Game

A strategic memory card game: hold the lowest hidden hand, using memory, calculated
risk, and special powers to get there before your opponents. Play solo against AI,
or online with friends in real time.

## Project structure

```
Zhaimer/
├── index.html          # Main game page (loads style.css + game.js)
├── style.css            # All visual styling
├── game.js               # All game logic + UI + Firebase sync (see below)
├── leaderboard.html      # Local stats page (reads localStorage only)
├── about.html             # About page
├── manifest.json          # Makes the site installable as an app (PWA)
├── assets/
│   ├── icons/              # Favicon + app icons
│   ├── images/               # Open Graph / social share preview
│   └── sounds/                 # (reserved — sound is currently synthesized
│                                  in-code, no files needed; see below)
└── README.md              # This file
```

`game.js` has two clearly-commented sections:
1. **Game logic** — pure functions that take a `room` object and mutate it (deal,
   draw, swap, abilities, burn, scoring, elimination, AI opponents). No UI code.
2. **UI + networking** — Firebase sync, rendering, event handling, sound, local
   stats, i18n (English/Arabic).

Keeping it as one `game.js` (rather than many small files) was a deliberate choice:
this app has no build step (no bundler/webpack), so every extra file is another
`<script>` tag and another thing that can get out of sync. If it grows much larger,
splitting `game.js` into `engine.js` + `ui.js` + `network.js` would be the next move.

---

## How to test locally

You don't need a server for most of it — just open `index.html` directly in a
browser (double-click it, or drag it into a browser window). The "Play vs AI" mode
works completely offline this way.

**Online multiplayer** needs Firebase configured first (see the config block near
the top of `game.js` — same setup as before, described in your earlier SETUP.md).

**One catch:** opening via `file://` gives you a local-only link for invites —
online multiplayer with real friends needs actual hosting (next section).

---

## How to upload to GitHub Pages (free)

1. Create a free GitHub account at **github.com** if you don't have one
2. Click **"New repository"**, name it (e.g. `zhaimer-game`), make it **Public**
3. On the repo page, click **"uploading an existing file"** and drag in the whole
   `Zhaimer` folder contents (all files and the `assets` folder)
4. Commit the upload
5. Go to **Settings → Pages** (left sidebar)
6. Under "Branch," choose `main` and `/ (root)`, click **Save**
7. After a minute, GitHub shows you a live URL like `https://yourname.github.io/zhaimer-game/`

This is free forever and needs no credit card.

---

## How to publish using Netlify (also free, and what we used before)

1. Go to **app.netlify.com**, sign up free
2. Either drag the whole `Zhaimer` folder onto **app.netlify.com/drop** for a
   one-off deploy, or (better, for ongoing updates) connect your GitHub repo:
   **"Add new site" → "Import an existing project" → GitHub → pick your repo**
3. Netlify auto-detects it's a static site — just click **Deploy**
4. You get a live link immediately; every time you push changes to GitHub,
   Netlify redeploys automatically

---

## How to connect a domain name

1. Buy a domain — **Namecheap** (~$10-15/year) is a good, simple option
2. In Netlify: **Site settings → Domain management → Add a domain**
3. Netlify shows you either:
   - **Nameservers** to paste into Namecheap (Namecheap → Domain List → Manage →
     Nameservers → Custom DNS), or
   - A **CNAME/A record** to add instead, if you'd rather keep Namecheap's DNS
4. Takes anywhere from a few minutes to ~24 hours to go live
5. Once it's live, Netlify auto-provisions free HTTPS (the padlock) — no extra step

---

## How to add Google Analytics

1. Go to **analytics.google.com**, create an account and a "GA4" property for
   your domain
2. It gives you a **Measurement ID** (looks like `G-XXXXXXXXXX`) and a code snippet
3. Open `index.html`, find the comment that says `GOOGLE ANALYTICS PLACEHOLDER`
   near the top, and paste the snippet there — it looks like:
   ```html
   <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
   <script>
     window.dataLayer = window.dataLayer || [];
     function gtag(){dataLayer.push(arguments);}
     gtag('js', new Date());
     gtag('config', 'G-XXXXXXXXXX');
   </script>
   ```
4. Re-deploy (push to GitHub / re-drop on Netlify) and traffic starts showing up
   in the Analytics dashboard within a day

---

## How to add advertising later

**Website (Google AdSense):**
1. Your site needs to be live on a real domain with real content, plus the
   Privacy Policy page (already included) — apply at **google.com/adsense**
2. Review can take days to a couple weeks
3. Once approved, AdSense gives you a script snippet — paste it where
   `index.html` says `GOOGLE ADSENSE PLACEHOLDER`
4. The actual ad units go inside the `<div class="ad-slot">...</div>` blocks
   already placed on the landing page and results screen — AdSense's site
   tells you exactly what `<ins class="adsbygoogle">` code to drop in there

**Mobile app later (Google AdMob):** see the Android section below.

---

## Sound

Sound effects are **synthesized in code** (Web Audio API oscillators) rather than
sound files — this keeps the game lightweight with zero asset downloads. There's a
mute/unmute button in the header (saves your preference). If you want richer,
higher-quality sound later, drop `.mp3`/`.ogg` files into `assets/sounds/` and
swap the `playTone()` calls for an `<audio>` element per effect.

---

## Local stats & leaderboard

Player stats (games played, wins, best score, recent history) are saved with
`localStorage` — no account, no backend, no database. This means stats are
**per-browser, per-device** — they won't follow a player between devices. That's
intentional for now (Phase 4 below covers what a real account system would need).

---

## Phase 4 groundwork: what a real account/leaderboard system needs later

The current code is already structured to make this addition straightforward:
- `myUid` (a per-browser identifier) already exists — swapping it for a real
  Firebase Auth UID is a small change, not a rewrite
- Game state already lives in Firebase — a **global leaderboard** just means
  writing `recordGameResult()`'s data to a shared `leaderboard/` path in Firebase
  instead of (or in addition to) `localStorage`
- **Friend challenges** can reuse the existing room-code system — a "challenge
  link" is just a pre-filled room code sent directly to one person
- Adding real accounts means enabling **Firebase Authentication** (email/password
  or Google sign-in) — a Firebase console toggle, plus a login screen in the UI

None of this is implemented yet (per your instructions, keeping the backend
simple for now) — but nothing in the current structure blocks adding it later.

---

## Phase 8: Turning this into an Android app (Capacitor)

**What Capacitor does:** wraps this exact website in a native Android (and iOS)
app shell, so the same `game.js`/`style.css`/`index.html` becomes a real
installable app — no rewrite needed.

### Steps to convert

1. Install [Node.js](https://nodejs.org) if you haven't already
2. Open a terminal in the `Zhaimer` folder and run:
   ```
   npm init -y
   npm install @capacitor/core @capacitor/cli
   npx cap init "Zhaimer" "com.yourname.zhaimer" --web-dir="."
   npm install @capacitor/android
   npx cap add android
   ```
3. This creates an `android/` folder — a full native Android Studio project
   wrapping your game
4. Install **Android Studio** (free, from developer.android.com/studio)
5. Run `npx cap open android` — opens the project in Android Studio
6. Build and test on an emulator or your own phone (USB debugging)

### Publishing to Google Play Store

1. Create a [Google Play Console](https://play.google.com/console) account
   (one-time **$25** registration fee)
2. In Android Studio: **Build → Generate Signed Bundle/APK**, create a signing
   key (keep it safe — you need the same one for every future update)
3. Build an `.aab` (Android App Bundle) — this is what Play Store wants
4. In Play Console: create a new app, fill in the store listing (screenshots,
   description, privacy policy link — you already have one), upload the `.aab`
5. Submit for review — usually a few hours to a couple of days for a new app

### Adding AdMob (mobile ads)

1. Create an [AdMob](https://admob.google.com) account (free), add your app
2. Install the Capacitor AdMob plugin:
   ```
   npm install @capacitor-community/admob
   npx cap sync
   ```
3. AdMob gives you an App ID and Ad Unit IDs — these go in your Capacitor config
   and wherever you call the plugin to show a banner/interstitial ad
4. This replaces the AdSense `<div class="ad-slot">` placeholders with native
   mobile ad calls for the app version specifically (the website version keeps
   using AdSense as above)

---

## How many people have played (global play counter)

Every time a game starts (vs AI or online), the code writes a counter to your
Firebase project at `meta/gamesStarted` (and a per-mode breakdown at
`meta/gamesStartedByMode/ai` and `meta/gamesStartedByMode/online`). This is
separate from Google Analytics — Analytics counts site *visits*, this counts
actual *games started*.

**To view the count:** open `admin-stats.html` in your browser (it's not
linked from anywhere in the game, so regular players won't stumble onto it).

**Important — update your Firebase security rules**, or this will silently
fail. Your rules currently only allow access to `rooms/`. Go to **Firebase
console → Realtime Database → Rules** and use this instead:

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true
      }
    },
    "meta": {
      ".read": true,
      ".write": true
    }
  }
}
```

Click **Publish** after pasting this in.

---

## Notes on what's a template vs. production-ready

- The **Privacy Policy** and **Terms of Service** pages (linked from the landing
  page) are solid starting templates, not a substitute for a lawyer — especially
  once real money/ads/user data are involved at any scale, get them reviewed.
- The online multiplayer's Firebase security rules are intentionally simple
  (anyone with a room code can read/write that room) — fine for friends playing
  casually, not appropriate if you ever add real accounts or stakes.
- The global play counter (`meta/gamesStarted`) is likewise open read/write —
  someone technically curious could inflate it by calling the increment
  function repeatedly. Fine for a casual "how many plays so far" number, not
  a rigorous analytics source.
