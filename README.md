# ♞ Chessmates — live club leaderboard

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

1. **Connect the repo.** In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages → Create → Import a repository**, then pick this GitHub repo. Keep the defaults: no build command, deploy command `npx wrangler deploy`, root `/`. The Worker name must be **`chessmates`** to match `wrangler.jsonc`. Click **Deploy**.
2. **Set the admin PIN.** Open the new Worker and go to **Settings → Variables and Secrets → Add**. Choose type **Secret**, name it `ADMIN_PIN`, and give it a value of at least 8 characters. Save it. Until this is set, admin is locked.
3. **Open the app** at `https://chessmates.<your-subdomain>.workers.dev/admin` and enter the PIN. Click **Print QR** and print the sheet for the club tables.

From now on, **every push to `main` deploys automatically.** The database lives in the Durable Object, so deploys never touch your data.

**Optional extras:**
- **Your own domain:** go to **Settings → Domains & Routes → Add → Custom domain**, for example `chess.yourclub.com`. Reprint the QR afterwards, because it encodes whatever address you open `/qr` from.
- **Timezone:** the club timezone (default `Europe/London`) decides where "This month" starts and ends and how sessions are named. Change `CLUB_TIMEZONE` in `wrangler.jsonc` and push.

### Moving data from the old laptop version

If you already have games in a `chessmates.db` from the laptop version, or in one of its `backups/*.db` files, convert it on that computer:

```bash
npm install
npm run export-sqlite -- path/to/chessmates.db
```

This writes `chessmates-export.json`. Upload it in **Admin → Backups → Restore from export…**.

## On club night

1. Open `/admin` and click **Start new session**. If you forget, the first logged game creates a session automatically. Players keep their Elo from week to week.
2. Put `/display` on the projector and press `F11` for full screen.
3. Put the printed QR sheets on the tables.

Phones just need mobile data or any Wi-Fi. Nothing has to be on the same network.

### Display tips

- `1` / `2` switches between the Tonight and This month tabs. `C` toggles clean mode, which hides the header for screenshots.
- `/display?tab=month&clean` opens straight to a clean monthly card, ready for Instagram.
- `/display?rotate=30` switches tabs automatically every 30 seconds.

## Security

- **Admin PIN** (`ADMIN_PIN` secret). It protects `/admin`, `/qr` and the admin API. Each device remembers the PIN after you first enter it.
- **Club code.** The QR link carries an 8-character code (`/log?c=…`), and each phone remembers it after one scan. People who only know the web address can see the leaderboard but can't log games or add names. If the code leaks, click **Change code** in admin and reprint the QR. Phones holding the old code are asked to scan again.
- **Guessing protection.** Repeated wrong PINs or codes from one IP address are locked out for 15 minutes. PIN and club-code failures are counted separately. Everyone at the venue shares one IP address, so phones can never lock the admin out.

## Backups

Cloudflare keeps 30 days of point-in-time history for the club database automatically. For a copy you control, click **Download export** in **Admin → Backups** now and then. **Restore from export…** replaces everything with a downloaded export and replays Elo.

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

You need Node.js 20 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_PIN for local use
npm run dev                      # local Cloudflare runtime on http://localhost:8787
npm test                         # Elo, replay, export/import and timezone tests
```

`npm run dev` also listens on your local network, so phones on the same Wi-Fi can test with your computer's IP. Open `/qr` from that IP address so the QR points at it. Local data is stored in `.wrangler/`, which git ignores.

## Project layout

```
src/core.js          Club logic: schema, Elo maths, replay, standings, export/import
src/worker.js        Cloudflare Worker routing + Club Durable Object (API, WebSockets, auth)
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
test/                Node tests against the same core using an in-memory SQLite
.agents/skills/      Design skills from Leonxlnx/taste-skill
```
