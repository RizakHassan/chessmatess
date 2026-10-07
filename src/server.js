const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const store = require('./db');
const { createBackups } = require('./backup');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const backups = createBackups({
  db: store.db,
  dir: process.env.BACKUP_DIR || path.join(path.dirname(store.DB_PATH), 'backups'),
  keep: Number(process.env.BACKUP_KEEP) || 20,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// Fonts are self-hosted so the app works on venue Wi-Fi without internet access.
const fontDir = name => path.dirname(require.resolve(`@fontsource-variable/${name}/package.json`));
app.use('/fonts/geist', express.static(fontDir('geist'), { maxAge: '30d' }));
app.use('/fonts/geist-mono', express.static(fontDir('geist-mono'), { maxAge: '30d' }));

function lanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  // Prefer typical home/club Wi-Fi ranges over VPN / docker bridges.
  const pick = candidates.find(c => /^192\.168\./.test(c.address))
    || candidates.find(c => /^10\./.test(c.address))
    || candidates.find(c => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address))
    || candidates[0];
  return pick ? pick.address : 'localhost';
}

const broadcast = () => { backups.markDirty(); io.emit('state', store.snapshot()); };

// Wraps a mutating handler: returns JSON, maps thrown errors to 400, then pushes fresh state.
const action = (fn) => (req, res) => {
  try {
    const result = fn(req) ?? {};
    res.json({ ok: true, ...result });
    broadcast();
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
};

const requireAdmin = (req, res, next) => {
  if (!ADMIN_PIN || req.get('x-admin-pin') === ADMIN_PIN) return next();
  res.status(401).json({ ok: false, error: 'Admin PIN required' });
};

/* ---------- pages ---------- */

app.get('/', (req, res) => res.redirect('/display'));

app.get('/qr', async (req, res) => {
  const url = `http://${lanIp()}:${PORT}/log`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log your game</title>
<link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/fonts/geist/index.css">
<link rel="stylesheet" href="/fonts/geist-mono/index.css">
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Geist Variable", system-ui, sans-serif; margin: 0; color: #22271e; background: #fffcf0;
         display: grid; justify-items: center; padding: 40px 16px; -webkit-font-smoothing: antialiased; }
  .sheet { width: min(100%, 150mm); }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { width: 64px; height: 64px; border-radius: 10px; }
  .brand span { font: 800 22px "Geist Mono Variable", ui-monospace, monospace; text-transform: uppercase; letter-spacing: -0.03em; color: #fe502d; }
  h1 { font-size: 52px; line-height: 1; letter-spacing: -0.045em; margin: 18px 0 10px; text-wrap: balance; }
  p.sub { font-size: 20px; margin: 0 0 30px; color: #416072; max-width: 34ch; }
  .qr { background: #fff; border: 3px solid #416072; border-radius: 20px; padding: 18px; box-shadow: 10px 10px 0 #a7dcfa; }
  .qr svg { width: 100%; height: auto; display: block; }
  .url { font: 500 17px "Geist Mono Variable", ui-monospace, monospace; margin-top: 14px; word-break: break-all; color: #416072; }
  ol { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0; margin: 30px 0 0; list-style: none; counter-reset: s; }
  li { counter-increment: s; font-size: 16px; line-height: 1.35; padding-top: 12px; border-top: 3px solid #fe502d; }
  li::before { content: counter(s); display: block; font: 600 14px "Geist Mono Variable", monospace; color: #416072; margin-bottom: 4px; }
  .print { margin-top: 32px; font: inherit; font-weight: 600; padding: 12px 22px; border-radius: 10px; border: 0; background: #416072; color: #fffcf0; cursor: pointer; }
  .print:hover { background: #33505f; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head>
<body><main class="sheet">
  <div class="brand"><img src="/logo.png" alt="Chessmates logo"><span>Chessmates</span></div>
  <h1>Finished a game?</h1>
  <p class="sub">Scan with your phone camera to log the result on the live leaderboard.</p>
  <div class="qr">${svg}</div>
  <div class="url">${url}</div>
  <ol><li>Pick white and black</li><li>Tap who won, or draw</li><li>Watch the board update</li></ol>
  <button class="print" onclick="window.print()">Print this page</button>
</main></body></html>`);
});

/* ---------- read API ---------- */

app.get('/api/state', (req, res) => res.json(store.snapshot()));
app.get('/api/info', (req, res) => res.json({ logUrl: `http://${lanIp()}:${PORT}/log`, adminPin: !!ADMIN_PIN }));

/* ---------- public write API (used by /log) ---------- */

app.post('/api/players', action(req => ({ player: store.addPlayer(req.body.name) })));
app.post('/api/games', action(req => ({ game: store.logGame(req.body.p1, req.body.p2, req.body.result) })));

/* ---------- admin API ---------- */

const admin = express.Router();
admin.use(requireAdmin);
admin.get('/players', (req, res) => res.json(store.listPlayers({ includeRemoved: true })));
admin.get('/games', (req, res) => res.json(store.recentGames(Number(req.query.limit) || 100)));
admin.get('/session', (req, res) => res.json(store.currentSession()));
admin.post('/players', action(req => ({ player: store.addPlayer(req.body.name) })));
admin.patch('/players/:id', action(req => store.renamePlayer(Number(req.params.id), req.body.name)));
admin.delete('/players/:id', action(req => store.removePlayer(Number(req.params.id))));
admin.post('/players/:id/restore', action(req => store.restorePlayer(Number(req.params.id))));
admin.delete('/games/:id', action(req => store.deleteGame(Number(req.params.id))));
admin.post('/undo', action(() => ({ undone: store.undoLastGame() })));
// Snapshot the finished night before the Tonight board resets.
admin.post('/sessions', async (req, res) => {
  try { if (backups.dirty) await backups.backup('session-end'); }
  catch (err) { return res.status(500).json({ ok: false, error: `Backup failed, session not started: ${err.message}` }); }
  action(r => ({ session: store.startSession(r.body.label) }))(req, res);
});
admin.post('/recalculate', action(() => store.recalculate()));
admin.get('/backups', (req, res) => res.json({ dir: backups.dir, backups: backups.list() }));
admin.post('/backups', async (req, res) => {
  try { res.json({ ok: true, name: await backups.backup('manual') }); }
  catch (err) { res.status(500).json({ ok: false, error: `Backup failed: ${err.message}` }); }
});
admin.get('/backups/:name', (req, res) => {
  const file = backups.resolve(req.params.name);
  if (!file) return res.status(404).json({ ok: false, error: 'Backup not found' });
  res.download(file);
});
app.use('/api/admin', admin);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found' });
  res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title>
<link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/style.css">
<style>main{max-width:520px;margin:0 auto;padding:18vh 20px 40px}h1{font-size:40px;letter-spacing:-.04em;margin:0 0 8px}
p{color:var(--muted);margin:0 0 24px}nav{display:flex;gap:8px;flex-wrap:wrap}</style></head>
<body><main><h1>Page not found</h1><p>There is nothing at this address. Try one of these instead.</p>
<nav><a class="btn primary" href="/log">Log a game</a><a class="btn" href="/display">Leaderboard</a><a class="btn ghost" href="/admin">Admin</a></nav>
</main></body></html>`);
});

io.on('connection', socket => socket.emit('state', store.snapshot()));

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log(`\n  ♞ Chessmates leaderboard running\n`);
  console.log(`  Display (projector): http://localhost:${PORT}/display`);
  console.log(`  Log games (phones):  http://${ip}:${PORT}/log`);
  console.log(`  Admin:               http://localhost:${PORT}/admin${ADMIN_PIN ? '  (PIN protected)' : ''}`);
  console.log(`  Printable QR:        http://localhost:${PORT}/qr\n`);
  console.log(`  Backups folder:      ${backups.dir}\n`);
  backups.start().catch(err => console.error('  Startup backup failed:', err.message));
});

// Ctrl+C: take a final backup if anything changed since the last one.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    try {
      if (backups.dirty) console.log('\n  Saving a backup before exit…');
      await backups.stop();
    } catch (err) { console.error('  Backup on exit failed:', err.message); }
    process.exit(0);
  });
}
