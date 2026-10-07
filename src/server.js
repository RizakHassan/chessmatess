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
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; color: #111; background: #fff;
         display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px 16px; }
  h1 { font-size: 44px; margin: 0 0 6px; letter-spacing: -0.02em; }
  p.sub { font-size: 22px; margin: 0 0 28px; color: #444; }
  .qr { width: min(80vw, 125mm); }
  .qr svg { width: 100%; height: auto; display: block; }
  .url { font: 600 20px ui-monospace, Menlo, monospace; margin-top: 18px; word-break: break-all; }
  ol { text-align: left; font-size: 18px; line-height: 1.6; margin-top: 24px; }
  .print { margin-top: 24px; font-size: 16px; padding: 10px 20px; border-radius: 8px; border: 1px solid #999; background: #f4f4f4; cursor: pointer; }
  @media print { .print { display: none; } }
</style></head>
<body>
  <h1>♞ Chessmates</h1>
  <p class="sub">Finished a game? Scan to log the result.</p>
  <div class="qr">${svg}</div>
  <div class="url">${url}</div>
  <ol><li>Pick both players</li><li>Tap who won (or Draw)</li><li>Watch the leaderboard move</li></ol>
  <button class="print" onclick="window.print()">Print</button>
</body></html>`);
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

io.on('connection', socket => socket.emit('state', store.snapshot()));

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log(`\n  ♞ Chessmates leaderboard running\n`);
  console.log(`  Display (projector): http://localhost:${PORT}/display`);
  console.log(`  Log games (phones):  http://${ip}:${PORT}/log`);
  console.log(`  Admin:               http://localhost:${PORT}/admin${ADMIN_PIN ? '  (PIN protected)' : ''}`);
  console.log(`  Printable QR:        http://localhost:${PORT}/qr\n`);
});
