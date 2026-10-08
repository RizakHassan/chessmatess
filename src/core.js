// Club logic shared by the Cloudflare Durable Object and the Node tests.
// `sql` is a tiny adapter: { all(query, ...params) -> rows[], transaction(fn) -> fn() }.

export const K = 32;
export const START_ELO = 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    elo        REAL NOT NULL DEFAULT ${START_ELO},
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_name_active ON players(name COLLATE NOCASE) WHERE active = 1`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    p1_id      INTEGER NOT NULL REFERENCES players(id),
    p2_id      INTEGER NOT NULL REFERENCES players(id),
    result     REAL NOT NULL CHECK (result IN (0, 0.5, 1)), -- score for p1 (white)
    p1_delta   REAL NOT NULL DEFAULT 0,
    p2_delta   REAL NOT NULL DEFAULT 0,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS games_session ON games(session_id)`,
  `CREATE INDEX IF NOT EXISTS games_created ON games(created_at)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export function eloDelta(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return K * (scoreA - expectedA);
}

// Milliseconds to add to UTC to get wall-clock time in `timeZone` at `date`.
function tzOffset(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant of local midnight on the 1st of (year, month) in `timeZone`.
function monthStartUtc(year, month, timeZone) {
  const guess = new Date(Date.UTC(year, month, 1));
  const first = new Date(guess.getTime() - tzOffset(guess, timeZone));
  return new Date(guess.getTime() - tzOffset(first, timeZone)); // re-check across a DST change
}

const cleanName = name => String(name ?? '').trim().replace(/\s+/g, ' ');

export function createClub(sql, { timeZone = 'Europe/London' } = {}) {
  for (const stmt of SCHEMA) sql.all(stmt);

  const one = (q, ...p) => sql.all(q, ...p)[0] ?? null;
  const now = () => new Date().toISOString();

  /* ---------- settings ---------- */

  const getSetting = key => one('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const setSetting = (key, value) =>
    sql.all('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

  /* ---------- sessions ---------- */

  const currentSession = () => one('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');

  function startSession(label) {
    const fallback = new Date().toLocaleDateString('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return one('INSERT INTO sessions (label, created_at) VALUES (?, ?) RETURNING *', cleanName(label) || fallback, now());
  }

  const ensureSession = () => currentSession() || startSession();

  /* ---------- players ---------- */

  function listPlayers({ includeRemoved = false } = {}) {
    const where = includeRemoved ? '' : 'WHERE active = 1';
    return sql.all(`SELECT id, name, elo, active, created_at FROM players ${where} ORDER BY name COLLATE NOCASE`);
  }

  function addPlayer(name) {
    name = cleanName(name);
    if (!name) throw new Error('Name is required');
    if (name.length > 40) throw new Error('Name is too long');
    const existing = one('SELECT name FROM players WHERE name = ? COLLATE NOCASE AND active = 1', name);
    if (existing) throw new Error(`"${existing.name}" is already on the list`);
    return one('INSERT INTO players (name, elo, created_at) VALUES (?, ?, ?) RETURNING *', name, START_ELO, now());
  }

  function renamePlayer(id, name) {
    name = cleanName(name);
    if (!name) throw new Error('Name is required');
    if (name.length > 40) throw new Error('Name is too long');
    if (one('SELECT id FROM players WHERE name = ? COLLATE NOCASE AND active = 1 AND id != ?', name, id)) {
      throw new Error('Another player already has that name');
    }
    if (!one('UPDATE players SET name = ? WHERE id = ? RETURNING id', name, id)) throw new Error('Player not found');
  }

  // Players with game history are hidden (soft-deleted) so everyone else's Elo
  // history stays intact; players with no games are deleted outright.
  function removePlayer(id) {
    if (one('SELECT 1 AS x FROM games WHERE p1_id = ? OR p2_id = ? LIMIT 1', id, id)) {
      sql.all('UPDATE players SET active = 0 WHERE id = ?', id);
    } else {
      sql.all('DELETE FROM players WHERE id = ?', id);
    }
  }

  function restorePlayer(id) {
    const p = one('SELECT * FROM players WHERE id = ?', id);
    if (!p) throw new Error('Player not found');
    if (one('SELECT id FROM players WHERE name = ? COLLATE NOCASE AND active = 1', p.name)) {
      throw new Error('An active player already has that name — rename one first');
    }
    sql.all('UPDATE players SET active = 1 WHERE id = ?', id);
  }

  /* ---------- games ---------- */

  function logGame(p1Id, p2Id, result) {
    p1Id = Number(p1Id); p2Id = Number(p2Id); result = Number(result);
    if (!p1Id || !p2Id) throw new Error('Pick both players');
    if (p1Id === p2Id) throw new Error('A player cannot play themselves');
    if (![0, 0.5, 1].includes(result)) throw new Error('Invalid result');

    return sql.transaction(() => {
      const p1 = one('SELECT * FROM players WHERE id = ? AND active = 1', p1Id);
      const p2 = one('SELECT * FROM players WHERE id = ? AND active = 1', p2Id);
      if (!p1 || !p2) throw new Error('Player not found');
      const session = ensureSession();
      const d1 = eloDelta(p1.elo, p2.elo, result);
      const d2 = eloDelta(p2.elo, p1.elo, 1 - result);
      const game = one(`INSERT INTO games (p1_id, p2_id, result, p1_delta, p2_delta, session_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, p1Id, p2Id, result, d1, d2, session.id, now());
      sql.all('UPDATE players SET elo = elo + ? WHERE id = ?', d1, p1Id);
      sql.all('UPDATE players SET elo = elo + ? WHERE id = ?', d2, p2Id);
      return {
        id: game.id, p1: p1.name, p2: p2.name, result, p1_delta: d1, p2_delta: d2,
        p1_elo: Math.round(p1.elo + d1), p2_elo: Math.round(p2.elo + d2),
      };
    });
  }

  // Replays every game in order from START_ELO, rewriting stored deltas and
  // player ratings. Used after any edit to history so ratings stay correct.
  function recalculate() {
    sql.transaction(() => {
      const ratings = new Map(sql.all('SELECT id FROM players').map(p => [p.id, START_ELO]));
      for (const g of sql.all('SELECT * FROM games ORDER BY created_at, id')) {
        const r1 = ratings.get(g.p1_id) ?? START_ELO;
        const r2 = ratings.get(g.p2_id) ?? START_ELO;
        const d1 = eloDelta(r1, r2, g.result);
        const d2 = eloDelta(r2, r1, 1 - g.result);
        ratings.set(g.p1_id, r1 + d1);
        ratings.set(g.p2_id, r2 + d2);
        sql.all('UPDATE games SET p1_delta = ?, p2_delta = ? WHERE id = ?', d1, d2, g.id);
      }
      for (const [id, elo] of ratings) sql.all('UPDATE players SET elo = ? WHERE id = ?', elo, id);
    });
  }

  function deleteGame(id) {
    sql.transaction(() => {
      if (!one('DELETE FROM games WHERE id = ? RETURNING id', id)) throw new Error('Game not found');
      recalculate();
    });
  }

  function undoLastGame() {
    const last = one('SELECT id FROM games ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!last) throw new Error('No games to undo');
    deleteGame(last.id);
    return last.id;
  }

  function recentGames(limit = 50) {
    return sql.all(`
      SELECT g.*, a.name AS p1_name, b.name AS p2_name, s.label AS session_label
      FROM games g
      JOIN players a ON a.id = g.p1_id
      JOIN players b ON b.id = g.p2_id
      JOIN sessions s ON s.id = g.session_id
      ORDER BY g.created_at DESC, g.id DESC LIMIT ?`, limit);
  }

  /* ---------- standings ---------- */

  function tally(games) {
    const rows = new Map();
    const row = id => {
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
    const byId = new Map(sql.all('SELECT id, name, elo FROM players WHERE active = 1').map(p => [p.id, p]));
    const out = [];
    for (const r of rows.values()) {
      const p = byId.get(r.id);
      if (p) out.push({ ...r, name: p.name, elo: Math.round(p.elo), delta: Math.round(r.delta) });
    }
    return out;
  }

  function tonightStandings() {
    const session = currentSession();
    if (!session) return { session: null, rows: [], gameCount: 0 };
    const games = sql.all('SELECT * FROM games WHERE session_id = ?', session.id);
    const rows = withPlayers(tally(games)).sort((x, y) => y.w - x.w || y.elo - x.elo || x.name.localeCompare(y.name));
    return { session, rows, gameCount: games.length };
  }

  function monthStandings(ref = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' })
      .formatToParts(ref).map(x => [x.type, x.value]));
    const year = Number(parts.year), month = Number(parts.month) - 1;
    const start = monthStartUtc(year, month, timeZone);
    const end = monthStartUtc(month === 11 ? year + 1 : year, (month + 1) % 12, timeZone);
    const games = sql.all('SELECT * FROM games WHERE created_at >= ? AND created_at < ?', start.toISOString(), end.toISOString());
    const rows = withPlayers(tally(games)).sort((x, y) => y.elo - x.elo || x.name.localeCompare(y.name));
    const label = new Date(Date.UTC(year, month, 15)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
    return { label, rows, gameCount: games.length };
  }

  function snapshot() {
    return {
      tonight: tonightStandings(),
      month: monthStandings(),
      players: listPlayers().map(p => ({ id: p.id, name: p.name, elo: Math.round(p.elo) })),
      latest: recentGames(1)[0] ?? null,
    };
  }

  /* ---------- export / import ---------- */

  function exportData() {
    return {
      format: 'chessmates-export',
      version: 1,
      exported_at: now(),
      players: sql.all('SELECT * FROM players ORDER BY id'),
      sessions: sql.all('SELECT * FROM sessions ORDER BY id'),
      games: sql.all('SELECT id, p1_id, p2_id, result, session_id, created_at FROM games ORDER BY id'),
    };
  }

  // Replaces all players, sessions and games with an export, then replays Elo.
  function importData(data) {
    if (!data || data.format !== 'chessmates-export') throw new Error('That file is not a Chessmates export');
    const players = Array.isArray(data.players) ? data.players : [];
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const games = Array.isArray(data.games) ? data.games : [];
    sql.transaction(() => {
      sql.all('DELETE FROM games');
      sql.all('DELETE FROM sessions');
      sql.all('DELETE FROM players');
      for (const p of players) {
        sql.all('INSERT INTO players (id, name, elo, active, created_at) VALUES (?, ?, ?, ?, ?)',
          Number(p.id), cleanName(p.name), START_ELO, p.active ? 1 : 0, String(p.created_at || now()));
      }
      for (const s of sessions) {
        sql.all('INSERT INTO sessions (id, label, created_at) VALUES (?, ?, ?)', Number(s.id), String(s.label), String(s.created_at || now()));
      }
      for (const g of games) {
        sql.all('INSERT INTO games (id, p1_id, p2_id, result, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          Number(g.id), Number(g.p1_id), Number(g.p2_id), Number(g.result), Number(g.session_id), String(g.created_at));
      }
      recalculate();
    });
    return { players: players.length, sessions: sessions.length, games: games.length };
  }

  return {
    getSetting, setSetting,
    currentSession, startSession,
    listPlayers, addPlayer, renamePlayer, removePlayer, restorePlayer,
    logGame, deleteGame, undoLastGame, recalculate, recentGames,
    tonightStandings, monthStandings, snapshot,
    exportData, importData,
  };
}
