const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const store = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';

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

const broadcast = () => io.emit('state', store.snapshot());

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
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/geist/index.css">
<link rel="stylesheet" href="/fonts/geist-mono/index.css">
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Geist Variable", system-ui, sans-serif; margin: 0; color: #0e1117; background: #fff;
         display: grid; justify-items: center; padding: 40px 16px; -webkit-font-smoothing: antialiased; }
  .sheet { width: min(100%, 150mm); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 18px; color: #4a5162; }
  .brand span { font-family: "Segoe UI Symbol", "Apple Symbols", "DejaVu Sans", sans-serif; font-size: 22px; color: #0e1117; }
  h1 { font-size: 52px; line-height: 1; letter-spacing: -0.045em; margin: 18px 0 10px; text-wrap: balance; }
  p.sub { font-size: 20px; margin: 0 0 30px; color: #4a5162; max-width: 34ch; }
  .qr { border: 1.5px solid #0e1117; border-radius: 20px; padding: 18px; }
  .qr svg { width: 100%; height: auto; display: block; }
  .url { font: 500 17px "Geist Mono Variable", ui-monospace, monospace; margin-top: 14px; word-break: break-all; color: #4a5162; }
  ol { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0; margin: 30px 0 0; list-style: none; counter-reset: s; }
  li { counter-increment: s; font-size: 16px; line-height: 1.35; padding-top: 12px; border-top: 2px solid #0e1117; }
  li::before { content: counter(s); display: block; font: 600 14px "Geist Mono Variable", monospace; color: #8a90a0; margin-bottom: 4px; }
  .print { margin-top: 32px; font: inherit; font-weight: 600; padding: 12px 22px; border-radius: 10px; border: 0; background: #0e1117; color: #fff; cursor: pointer; }
  .print:hover { background: #2a303c; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head>
<body><main class="sheet">
  <div class="brand"><span>&#9822;&#65038;</span>Chessmates</div>
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
admin.post('/sessions', action(req => ({ session: store.startSession(req.body.label) })));
admin.post('/recalculate', action(() => store.recalculate()));
app.use('/api/admin', admin);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found' });
  res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css">
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
});
