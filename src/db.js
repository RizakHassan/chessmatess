const path = require('path');
const Database = require('better-sqlite3');

const K = 32;
const START_ELO = 1000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'chessmates.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    elo        REAL NOT NULL DEFAULT ${START_ELO},
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS players_name_active
    ON players(name COLLATE NOCASE) WHERE active = 1;

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    p1_id      INTEGER NOT NULL REFERENCES players(id),
    p2_id      INTEGER NOT NULL REFERENCES players(id),
    result     REAL NOT NULL CHECK (result IN (0, 0.5, 1)), -- score for p1 (white)
    p1_delta   REAL NOT NULL DEFAULT 0,
    p2_delta   REAL NOT NULL DEFAULT 0,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_session ON games(session_id);
  CREATE INDEX IF NOT EXISTS games_created ON games(created_at);
`);

const now = () => new Date().toISOString();

function eloDelta(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return K * (scoreA - expectedA);
}

/* ---------- sessions ---------- */

function currentSession() {
  return db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get() || null;
}

function startSession(label) {
  const d = new Date();
  const fallback = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const info = db.prepare('INSERT INTO sessions (label, created_at) VALUES (?, ?)')
    .run((label || '').trim() || fallback, now());
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
}

function ensureSession() {
  return currentSession() || startSession();
}

/* ---------- players ---------- */

function listPlayers({ includeRemoved = false } = {}) {
  const where = includeRemoved ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT id, name, elo, active, created_at FROM players ${where} ORDER BY name COLLATE NOCASE`).all();
}

function addPlayer(name) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Name is required');
  if (name.length > 40) throw new Error('Name is too long');
  const existing = db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE AND active = 1').get(name);
  if (existing) throw new Error(`"${existing.name}" is already on the list`);
  const info = db.prepare('INSERT INTO players (name, elo, created_at) VALUES (?, ?, ?)').run(name, START_ELO, now());
  return db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
}

function renamePlayer(id, name) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Name is required');
  const clash = db.prepare('SELECT id FROM players WHERE name = ? COLLATE NOCASE AND active = 1 AND id != ?').get(name, id);
  if (clash) throw new Error('Another player already has that name');
  const info = db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
  if (!info.changes) throw new Error('Player not found');
}

// Players with game history are hidden (soft-deleted) so everyone else's Elo
// history stays intact; players with no games are deleted outright.
function removePlayer(id) {
  const used = db.prepare('SELECT 1 FROM games WHERE p1_id = ? OR p2_id = ? LIMIT 1').get(id, id);
  if (used) db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(id);
  else db.prepare('DELETE FROM players WHERE id = ?').run(id);
}

function restorePlayer(id) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) throw new Error('Player not found');
  const clash = db.prepare('SELECT id FROM players WHERE name = ? COLLATE NOCASE AND active = 1').get(p.name);
  if (clash) throw new Error('An active player already has that name — rename one first');
  db.prepare('UPDATE players SET active = 1 WHERE id = ?').run(id);
}

/* ---------- games ---------- */

function logGame(p1Id, p2Id, result) {
  p1Id = Number(p1Id); p2Id = Number(p2Id); result = Number(result);
  if (!p1Id || !p2Id) throw new Error('Pick both players');
  if (p1Id === p2Id) throw new Error('A player cannot play themselves');
  if (![0, 0.5, 1].includes(result)) throw new Error('Invalid result');

  return db.transaction(() => {
    const p1 = db.prepare('SELECT * FROM players WHERE id = ? AND active = 1').get(p1Id);
    const p2 = db.prepare('SELECT * FROM players WHERE id = ? AND active = 1').get(p2Id);
    if (!p1 || !p2) throw new Error('Player not found');
    const session = ensureSession();
    const d1 = eloDelta(p1.elo, p2.elo, result);
    const d2 = eloDelta(p2.elo, p1.elo, 1 - result);
    const info = db.prepare(`INSERT INTO games (p1_id, p2_id, result, p1_delta, p2_delta, session_id, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p1Id, p2Id, result, d1, d2, session.id, now());
    db.prepare('UPDATE players SET elo = elo + ? WHERE id = ?').run(d1, p1Id);
    db.prepare('UPDATE players SET elo = elo + ? WHERE id = ?').run(d2, p2Id);
    return { id: info.lastInsertRowid, p1: p1.name, p2: p2.name, result, p1_delta: d1, p2_delta: d2 };
  })();
}

// Replays every game in order from START_ELO, rewriting stored deltas and
// player ratings. Used after any edit to history so ratings stay correct.
const recalculate = db.transaction(() => {
  const ratings = new Map();
  for (const p of db.prepare('SELECT id FROM players').all()) ratings.set(p.id, START_ELO);
  const update = db.prepare('UPDATE games SET p1_delta = ?, p2_delta = ? WHERE id = ?');
  for (const g of db.prepare('SELECT * FROM games ORDER BY created_at, id').all()) {
    const r1 = ratings.get(g.p1_id) ?? START_ELO;
    const r2 = ratings.get(g.p2_id) ?? START_ELO;
    const d1 = eloDelta(r1, r2, g.result);
    const d2 = eloDelta(r2, r1, 1 - g.result);
    ratings.set(g.p1_id, r1 + d1);
    ratings.set(g.p2_id, r2 + d2);
    update.run(d1, d2, g.id);
  }
  const setElo = db.prepare('UPDATE players SET elo = ? WHERE id = ?');
  for (const [id, elo] of ratings) setElo.run(elo, id);
});

function deleteGame(id) {
  const info = db.prepare('DELETE FROM games WHERE id = ?').run(id);
  if (!info.changes) throw new Error('Game not found');
  recalculate();
}

function undoLastGame() {
  const last = db.prepare('SELECT id FROM games ORDER BY created_at DESC, id DESC LIMIT 1').get();
  if (!last) throw new Error('No games to undo');
  deleteGame(last.id);
  return last.id;
}

function recentGames(limit = 50) {
  return db.prepare(`
    SELECT g.*, a.name AS p1_name, b.name AS p2_name, s.label AS session_label
    FROM games g
    JOIN players a ON a.id = g.p1_id
    JOIN players b ON b.id = g.p2_id
    JOIN sessions s ON s.id = g.session_id
    ORDER BY g.created_at DESC, g.id DESC LIMIT ?`).all(limit);
}

/* ---------- standings ---------- */

function tally(games) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { id, w: 0, d: 0, l: 0, games: 0, delta: 0 });
    return rows.get(id);
  };
  for (const g of games) {
    const a = row(g.p1_id), b = row(g.p2_id);
    a.games++; b.games++;
    a.delta += g.p1_delta; b.delta += g.p2_delta;
    if (g.result === 1) { a.w++; b.l++; }
    else if (g.result === 0) { a.l++; b.w++; }
    else { a.d++; b.d++; }
  }
  return rows;
}

function withPlayers(rows) {
  const byId = new Map(db.prepare('SELECT id, name, elo FROM players WHERE active = 1').all().map(p => [p.id, p]));
  const out = [];
  for (const r of rows.values()) {
    const p = byId.get(r.id);
    if (!p) continue;
    out.push({ ...r, name: p.name, elo: Math.round(p.elo), delta: Math.round(r.delta) });
  }
  return out;
}

function tonightStandings() {
  const session = currentSession();
  if (!session) return { session: null, rows: [] };
  const games = db.prepare('SELECT * FROM games WHERE session_id = ?').all(session.id);
  const rows = withPlayers(tally(games))
    .sort((x, y) => y.w - x.w || y.elo - x.elo || x.name.localeCompare(y.name));
  return { session, rows, gameCount: games.length };
}

function monthStandings(ref = new Date()) {
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  const games = db.prepare('SELECT * FROM games WHERE created_at >= ? AND created_at < ?')
    .all(start.toISOString(), end.toISOString());
  const rows = withPlayers(tally(games))
    .sort((x, y) => y.elo - x.elo || x.name.localeCompare(y.name));
  const label = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return { label, rows, gameCount: games.length };
}

function snapshot() {
  return {
    tonight: tonightStandings(),
    month: monthStandings(),
    players: listPlayers().map(p => ({ id: p.id, name: p.name, elo: Math.round(p.elo) })),
    latest: recentGames(1)[0] || null,
  };
}

module.exports = {
  db, K, START_ELO, eloDelta,
  currentSession, startSession,
  listPlayers, addPlayer, renamePlayer, removePlayer, restorePlayer,
  logGame, deleteGame, undoLastGame, recalculate, recentGames,
  tonightStandings, monthStandings, snapshot,
};
