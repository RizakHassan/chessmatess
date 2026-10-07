# ♞ Chessmates — live club leaderboard

A small local web app for a weekly chess club. Players log results from their phones, and a projector shows a live leaderboard. Rows slide into their new positions and flash green or red when ratings change. The look follows the club logo: a light cream background with slate, sky blue and orange-red.

**Stack:** Node.js · Express · SQLite (better-sqlite3) · Socket.io · plain HTML/CSS/JS

The app doesn't need internet access on club night. Fonts (Geist and Geist Mono) are served from `node_modules`, and nothing loads from a CDN.

## Pages

| URL | What it's for |
| --- | --- |
| `/display` | Projector view. **Tonight** ranks players by wins this session, with Elo as the tiebreaker. **This Month** ranks by Elo with monthly W-D-L, laid out for an Instagram screenshot. |
| `/log` | Mobile page that people open from the QR code. Pick two players, then tap **P1 won / Draw / P2 won**. New people tap **I'm new** to add their name. No login. |
| `/admin` | Add, rename, remove or restore players (rename happens inline). Undo or delete a mis-logged game, which recalculates Elo. Start a new session. Destructive buttons ask for a second tap instead of a popup. |
| `/qr` | Printable A4 page with a QR code that points at `/log` on this machine's LAN IP. |

## Setup

You need **Node.js 18 or newer** (<https://nodejs.org>).

```bash
git clone <your-repo-url> chessmates
cd chessmates
npm install
npm start
```

The terminal prints the URLs:

```
  Display (projector): http://localhost:3000/display
  Log games (phones):  http://192.168.1.23:3000/log
  Admin:               http://localhost:3000/admin
  Printable QR:        http://localhost:3000/qr
```

### On club night

1. Connect the laptop to the venue Wi-Fi. Phones must be on the **same network**.
2. Run `npm start`.
3. Open `/admin` and click **Start new session**. If you forget, the first logged game creates a session automatically. Players keep their Elo from week to week.
4. Put `/display` on the projector. Press `F11` for full screen.
5. Print `/qr`, or show it on a second screen, so people can scan it.

> **Phones can't connect?** The laptop's firewall may be blocking port 3000. Allow Node.js through the firewall (Windows asks the first time you run it; choose **Private networks**). Some venue or guest Wi-Fi networks block devices from reaching each other. If yours does, use a phone hotspot instead.

### Display tips

- `1` / `2` switches between the Tonight and This Month tabs. `C` toggles clean mode, which hides the header for screenshots.
- `/display?tab=month&clean` opens straight to a clean monthly card, ready for Instagram.
- `/display?rotate=30` switches tabs automatically every 30 seconds.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST_IP` | auto-detected | IP address used in the QR code. Set this if the wrong network adapter is picked (for example, a VPN). |
| `ADMIN_PIN` | *(none)* | When set, `/admin` asks for this PIN before making changes |
| `DB_PATH` | `./chessmates.db` | Location of the SQLite database file |
| `BACKUP_DIR` | `backups/` next to the database | Where backups are written |
| `BACKUP_KEEP` | `20` | How many backups to keep |

Example: `ADMIN_PIN=1234 PORT=8080 npm start`. On Windows PowerShell, run `$env:ADMIN_PIN="1234"; npm start`.

## How ratings work

- Everyone starts at **1000**, with **K = 32**. A win scores 1, a draw ½ and a loss 0. Expected score = `1 / (1 + 10^((opp − you) / 400))`.
- Elo never resets. Sessions and months only filter which games count toward W-D-L.
- **Undo and delete replay history.** Deleting any game, including an old one, recalculates every rating by replaying all remaining games in order from 1000. Every rating after the deleted game ends up correct. **Recalculate Elo** in admin does the same replay on demand.
- **Removing a player hides them** from the lists and the leaderboard. Their past games stay in the history, so their opponents' ratings don't change. You can restore them from admin with **show removed**. A player who has never played is deleted outright.

## Data model

```
players  (id, name, elo DEFAULT 1000, active, created_at)
sessions (id, label, created_at)                       -- one per Monday night
games    (id, p1_id /*white*/, p2_id, result /*1 | 0.5 | 0 for p1*/,
          p1_delta, p2_delta, session_id, created_at)
```

All data lives in `chessmates.db`, which git ignores.

## Backups

The app backs up the database to a `backups/` folder next to it. Git ignores this folder too. A backup is made:

- when the app starts, if there's any data
- before **Start new session**, so every club night gets its own snapshot
- every 10 minutes, if anything changed
- when you stop the app with **Ctrl+C**

The newest 20 are kept; change that with `BACKUP_KEEP`. The **Backups** panel in `/admin` shows the latest ones and has **Back up now** and **Download** buttons. Download one now and then to a USB stick or cloud drive, because backups on the same laptop won't survive the laptop.

**To restore:** stop the app, then copy the backup you want over `chessmates.db`. Also delete any `chessmates.db-wal` and `chessmates.db-shm` files. Then start the app again. To keep a copy of the current state, rename `chessmates.db` first instead of overwriting it.

## Development

```bash
npm run dev    # restarts on file changes
npm test       # Elo + replay tests (uses a temp database)
```

## Project layout

```
src/server.js      Express routes, Socket.io broadcast, QR page
src/db.js          SQLite schema, Elo maths, replay, standings
src/backup.js      Automatic database backups
public/display.html  Projector leaderboard (FLIP slide animations, glow flashes)
public/log.html      Mobile result logger
public/admin.html    Admin tools
public/style.css     Shared design tokens from the logo palette (slate, sky, orange, cream, ink)
public/logo.png      Club logo (also favicon.png / apple-touch-icon.png)
test/               Elo, replay and backup tests
.agents/skills/      Design skills from Leonxlnx/taste-skill (installed via `npx skills add`)
```
