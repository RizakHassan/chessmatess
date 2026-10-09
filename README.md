# ♞ Chessmatess — live club leaderboard

A web app for a weekly chess club. Players log results from their phones by scanning a QR code, and a projector shows a live leaderboard. Rows slide into their new positions and flash green or red when ratings change. The look follows the club logo: a light cream background with slate, sky blue and orange-red.

It runs on **Cloudflare** with nothing to keep switched on. A Worker serves the pages, and a single Durable Object holds the SQLite database and every live screen's WebSocket connection. It fits in Cloudflare's free plan.

## Pages

| URL | What it's for |
| --- | --- |
| `/display` | Projector view. **Tonight** ranks players by wins this session, with Elo as the tiebreaker. **This month** ranks by Elo with monthly W-D-L, laid out for an Instagram screenshot. Anyone can view it. |
| `/log` | Mobile page opened from the club QR code. Pick two players and tap who won, or **Draw**. New people tap **Add your name**. Logging only works with the club code that the QR carries. |
| `/admin` | Needs the admin PIN. Add, rename, remove or restore players. Undo or delete a mis-logged game, which recalculates Elo. Start a new session. Change the club code. Download or restore an export. |
| `/qr` | Printable A4 sheet with the QR code. It needs the admin PIN, because the QR contains the club code. |

## Deploy to Cloudflare (one-time setup)

You need a free Cloudflare account and this repo on GitHub.

1. **Connect the repo.** In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages → Create → Import a repository**, then pick this GitHub repo. Use build command `npm test`, deploy command `npx wrangler deploy`, root `/`. With `npm test` as the build command, a push with failing tests stops instead of going live. The Worker name must match `name` in `wrangler.jsonc` (**`chessmatess`**). Click **Deploy**.
2. **Set the admin PIN.** Open the new Worker and go to **Settings → Variables and Secrets → Add**. Choose type **Secret**, name it `ADMIN_PIN`, and give it a value of at least 8 characters. Save it. Until this is set, admin is locked.
3. **Open the app** at `https://chessmatess.com/admin` on the laptop that drives the projector, and enter the PIN. That browser remembers the PIN, so `/display` on it shows the join QR code.

From now on, **every push to `main` deploys automatically.** The database lives in the Durable Object, so deploys never touch your data.

**Optional extras:**
- **Your own domain:** the app runs at **https://chessmatess.com**. The domain is registered at GoDaddy, with its nameservers pointing at Cloudflare. It's attached under **Worker → Settings → Domains & Routes → Custom domain** for both `chessmatess.com` and `www.chessmatess.com`. `www` and the old `workers.dev` address redirect to `chessmatess.com` (`CANONICAL_HOST` in `wrangler.jsonc`), so every phone uses one address.
- **Timezone:** the club timezone (default `Europe/London`) decides where "This month" starts and ends and how sessions are named. Change `CLUB_TIMEZONE` in `wrangler.jsonc` and push.

### Moving data from the old laptop version

If you already have games in a `chessmates.db` from the laptop version, or in one of its `backups/*.db` files, convert it on that computer:

```bash
npm install
npm run export-sqlite -- path/to/chessmates.db
```

This writes `chessmatess-export.json`. Upload it in **Admin → Backups → Restore from export…**.

## On club night

1. Open `/admin` and click **Start new session**. This resets the Tonight board and **creates a new club code**, so last week's QR stops working. If you forget, the first logged game creates a session automatically, but the code stays the same.
2. Put `/display` on the projector and press `F11` for full screen. The current QR code shows on the right of the **Tonight** tab. It only appears on a browser that has the admin PIN saved, and never on the **This month** tab or in clean mode, so Instagram screenshots don't leak it.
3. Players scan the QR with their phone camera. Phones just need mobile data or any Wi-Fi.

**Automatic sessions.** When logging opens, a new session starts by itself, with a new QR code, so you no longer have to click **Start new session**. It's skipped if a session was already started in the last 12 hours. Turn it off in **Admin → Logging hours**.

**Logging hours.** Phones can only log games and add names during club hours. The default is Mondays 18:00–22:00 in the club's timezone. Change the days and times, or tick **Always open**, in **Admin → Logging hours**. Outside the hours, the phone page says when logging opens next, and the server refuses results too. Undo still works for its 60 seconds after closing.

If you prefer paper, `/qr` prints the current QR on an A4 sheet. It only works until the next **Start new session**.

### Display tips

- `1` / `2` switches between the Tonight and This month tabs. `C` toggles clean mode, which hides the header for screenshots.
- `/display?tab=month&clean` opens straight to a clean monthly card, ready for Instagram.
- `/display?rotate=30` switches tabs automatically every 30 seconds.

## Security

- **Admin PIN** (`ADMIN_PIN` secret). It protects `/admin`, `/qr` and the admin API. Each device remembers the PIN after you first enter it.
- **Club code.** The QR link carries an 8-character code (`/log?c=…`), and each phone remembers it until the code changes. A new code is created every time you start a new session, and you can click **Change code** in admin at any time. Phones holding an old code are asked to scan the new QR. People who only know the web address can see the leaderboard but can't log games or add names.
- **Logging hours.** Results are only accepted during the hours set in admin. This is checked on the server, not just in the page.
- **Guessing protection.** Repeated wrong PINs or codes from one IP address are locked out for 15 minutes. PIN and club-code failures are counted separately. Everyone at the venue shares one IP address, so phones can never lock the admin out.

## Fair play

- **Double-logged games.** If the same two players and the same result come in within 10 minutes, from either side of the board, the second phone sees "Another phone logged this result 2 min ago". Players can tap **Yes, log it again** for a genuine quick rematch.
- **Undo on the phone.** For 60 seconds after logging, that phone sees **Wrong result? Undo**. It removes the game and goes back to the form with the same players picked. Only the phone that logged the game can undo it.
- **Phone tags.** Each game records a random ID for the phone that logged it. In **Admin → Recent games**, tap a phone tag to see everything that phone logged, then **Delete all from this phone** if it was pranking.
- **One person, one player.** New players add a **first name and last initial**, for example "Rizak H". Capitals are tidied automatically. After someone adds or picks their name, their phone remembers it ("You're Rizak H on this phone"). Adding a name that looks like an existing player shows "Is one of these you?". That covers the same first name, small typos and accents. Exact repeats are never allowed. A second "Sam W" is asked to add another letter ("Sam Wh").
- **Merge.** If a duplicate still slips in, open **Admin → Players → Merge…** on the extra entry and choose who to keep. Their games move across, the extra name is removed, and Elo is replayed. Two players who have played each other can't be merged.

## Backups & downloads

Everything is in **Admin → Backups & downloads**:

- **Automatic backups.** A backup is saved inside the club database when logging closes after each club night, but only if anything changed. One is also saved before any restore, player merge or "delete all from this phone", so those can be undone. If logging is set to always open, the backup runs daily at 04:00 instead. The newest 20 are kept, and each has **Download** and **Restore** buttons. Restoring saves the current state first, so a restore can be undone too.
- **Download Excel.** A spreadsheet with **Players** (rank, Elo, W/D/L, status), **Games** (date, session, white, black, result, Elo changes, phone tag) and **Sessions**. Dates are in club time, and the sheets have filters and frozen headers.
- **Download backup file / Restore from file.** A JSON copy of everything. It's best kept somewhere outside Cloudflare (Drive, email, USB) in case the account itself is ever lost.

Cloudflare also keeps 30 days of point-in-time history for the database, but restoring from that needs a developer.

## How ratings work

- Everyone starts at **1000**, with **K = 32**. A win scores 1, a draw ½ and a loss 0. Expected score = `1 / (1 + 10^((opp − you) / 400))`.
- Elo never resets. Sessions and months only filter which games count toward W-D-L.
- **Undo and delete replay history.** Deleting any game, including an old one, recalculates every rating by replaying all remaining games in order from 1000. **Recalculate Elo** in admin does the same replay on demand.
- **Removing a player hides them** from the lists and the leaderboard. Their past games stay in the history, so their opponents' ratings don't change. You can restore them from admin with **Show removed**. A player who has never played is deleted outright.

## Data model

```
players  (id, name, elo DEFAULT 1000, active, created_at)
sessions (id, label, created_at)                       -- one per Monday night
games    (id, p1_id /*white*/, p2_id, result /*1 | 0.5 | 0 for p1*/,
          p1_delta, p2_delta, session_id, created_at)
settings (key, value)                                  -- club code, retired codes
```

## Development

You need Node.js 22.13 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_PIN for local use
npm run dev                      # local Cloudflare runtime on http://localhost:8787
npm test                         # all tests (Node's built-in SQLite, no native add-ons)
```

`npm run dev` also listens on your local network, so phones on the same Wi-Fi can test with your computer's IP. Open `/qr` from that IP address so the QR points at it. Local data is stored in `.wrangler/`, which git ignores.

## Project layout

```
src/core.js          Club logic: schema, Elo maths, replay, standings, export/import
src/worker.js        Cloudflare Worker routing + Club Durable Object (API, WebSockets, auth, alarms)
src/xlsx.js          Minimal Excel (.xlsx) writer
wrangler.jsonc       Cloudflare config (Durable Object, static assets, timezone)
public/live.js       WebSocket client with reconnect + heartbeat
public/display.html  Projector leaderboard (FLIP slide animations, glow flashes)
public/log.html      Mobile result logger
public/admin.html    Admin tools
public/qr.html       Printable QR sheet
public/style.css     Shared design tokens from the logo palette
public/fonts/        Self-hosted Geist + Geist Mono (OFL)
public/vendor/       qrcode-generator (MIT)
scripts/             export-sqlite: convert a laptop-version database to an export
test/                Node tests against the same core using Node's built-in SQLite
.agents/skills/      Design skills from Leonxlnx/taste-skill
```
