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
  `CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    reason      TEXT NOT NULL,
    players     INTEGER NOT NULL,
    games       INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    data        TEXT NOT NULL
  )`,
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

// The UTC instant of a wall-clock time (minutes past midnight) on a local date in `timeZone`.
function localToUtc(year, month, day, minutes, timeZone) {
  const guess = Date.UTC(year, month, day, Math.floor(minutes / 60), minutes % 60);
  const first = guess - tzOffset(new Date(guess), timeZone);
  return new Date(guess - tzOffset(new Date(first), timeZone));
}

// FNV-1a: a cheap fingerprint to skip backups when nothing changed.
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

// The UTC instant of local midnight on the 1st of (year, month) in `timeZone`.
function monthStartUtc(year, month, timeZone) {
  const guess = new Date(Date.UTC(year, month, 1));
  const first = new Date(guess.getTime() - tzOffset(guess, timeZone));
  return new Date(guess.getTime() - tzOffset(first, timeZone)); // re-check across a DST change
}

export const DEFAULT_HOURS = { always: false, days: [1], start: '18:00', end: '22:00', autoSession: true }; // Mondays 6pm–10pm
export const KEEP_BACKUPS = 20;
const AUTO_SESSION_GRACE_MS = 12 * 60 * 60 * 1000; // a session started this recently counts as tonight's
const ALWAYS_OPEN_BACKUP_AT = '04:00';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMinutes = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

// Day of week (0 = Sunday) and minutes past midnight at `date` in `timeZone`.
function localClock(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const cleanName = name => String(name ?? '').trim().replace(/\s+/g, ' ');
const cleanDevice = id => (/^[A-Za-z0-9-]{8,64}$/.test(String(id ?? '')) ? String(id) : null);

export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // same pairing + result this soon is probably logged twice
export const SELF_UNDO_MS = 75 * 1000;             // phone shows 60s; a little grace for slow networks

// Self-added players give a first name plus last-name initial: ("rizak", "h") -> "Rizak H".
// Up to three letters are allowed after the space so two "Sam W"s can become "Sam W" and "Sam Wh".
export function personName(first, initial) {
  first = String(first ?? '').trim().replace(/\s+/g, ' ');
  initial = String(initial ?? '').replace(/[\s.]/g, '');
  if (!first) throw new Error('Enter your first name');
  if (first.length > 30 || !/^\p{L}[\p{L}'’\- ]*$/u.test(first)) throw new Error('First name can only use letters, spaces, hyphens and apostrophes');
  if (!/^\p{L}{1,3}$/u.test(initial)) throw new Error('Enter the first letter of your last name');
  const cap = w => w.charAt(0).toLocaleUpperCase('en-GB') + w.slice(1);
  first = first.split(' ').map(w => w.split('-').map(cap).join('-')).join(' ');
  return `${first} ${cap(initial.toLocaleLowerCase('en-GB'))}`;
}

// Thrown when a new name looks like someone already on the list; the phone can pick them or confirm.
export class SimilarNameError extends Error {
  constructor(matches, exact = false) {
    super(exact ? `${matches[0].name} is already on the list.` : `That looks like ${matches.length === 1 ? 'someone' : 'people'} already on the list.`);
    this.code = 'similar';
    this.matches = matches;
    this.exact = exact;
  }
}

// Lowercase, accents and punctuation stripped: "Lucía O'Brien" -> "lucia obrien".
const normName = name => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Same first name ("Rizak" vs "Rizak Hassan"), or a likely typo of the whole name.
function looksLikeSamePerson(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const fx = x.split(' ')[0], fy = y.split(' ')[0];
  if (fx.length >= 3 && fx === fy) return true;
  const limit = Math.min(x.length, y.length) >= 8 ? 2 : Math.min(x.length, y.length) >= 4 ? 1 : 0;
  return editDistance(x, y) <= limit;
}

// Thrown when a result looks like one that was just logged; the phone can confirm and resend.
export class DuplicateError extends Error {
  constructor(minutesAgo, samePhone) {
    super(samePhone
      ? `You already logged this result ${minutesAgo < 1 ? 'just now' : `${minutesAgo} min ago`}.`
      : `Another phone logged this result ${minutesAgo < 1 ? 'just now' : `${minutesAgo} min ago`}.`);
    this.code = 'duplicate';
    this.minutesAgo = minutesAgo;
    this.samePhone = samePhone;
  }
}

export function createClub(sql, { timeZone = 'Europe/London', clock = () => new Date() } = {}) {
  for (const stmt of SCHEMA) sql.all(stmt);
  // v2: which phone logged each game. Older databases get the column added in place.
  try { sql.all('SELECT device_id FROM games LIMIT 0'); }
  catch { sql.all('ALTER TABLE games ADD COLUMN device_id TEXT'); }
  sql.all('CREATE INDEX IF NOT EXISTS games_device ON games(device_id)');

  const one = (q, ...p) => sql.all(q, ...p)[0] ?? null;
  const now = () => clock().toISOString();

  /* ---------- settings ---------- */

  const getSetting = key => one('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const setSetting = (key, value) =>
    sql.all('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

  /* ---------- logging hours ---------- */

  function getHours() {
    try { return { ...DEFAULT_HOURS, ...JSON.parse(getSetting('logging_hours') || '{}') }; } catch { return { ...DEFAULT_HOURS }; }
  }

  function setHours({ always, days, start, end, autoSession = true }) {
    const hours = {
      always: !!always,
      autoSession: !!autoSession,
      days: [...new Set((Array.isArray(days) ? days : []).map(Number))].filter(d => d >= 0 && d <= 6).sort(),
      start: String(start), end: String(end),
    };
    if (!validTime(hours.start) || !validTime(hours.end)) throw new Error('Times must look like 18:00');
    if (hours.start === hours.end) throw new Error('Start and end times must be different');
    if (!hours.always && !hours.days.length) throw new Error('Pick at least one day, or choose Always open');
    setSetting('logging_hours', JSON.stringify(hours));
    return hours;
  }

  // Open/closed right now, plus a human label for the next opening, in the club's timezone.
  // A window that ends before it starts (e.g. 20:00–01:00) runs past midnight.
  function loggingStatus(at = clock()) {
    const hours = getHours();
    if (hours.always) return { open: true, hours };
    const { day, minutes } = localClock(at, timeZone);
    const start = toMinutes(hours.start), end = toMinutes(hours.end);
    const overnight = end < start;
    const open = overnight
      ? (hours.days.includes(day) && minutes >= start) || (hours.days.includes((day + 6) % 7) && minutes < end)
      : hours.days.includes(day) && minutes >= start && minutes < end;
    let next = null;
    if (!open) {
      for (let offset = 0; offset <= 7; offset++) {
        const d = (day + offset) % 7;
        if (!hours.days.includes(d) || (offset === 0 && minutes >= start)) continue;
        next = `${offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : DAY_NAMES[d]} at ${hours.start}`;
        break;
      }
    }
    return { open, hours, next, closes: open ? hours.end : null };
  }

  // Next opening (start of club hours) and next closing after `after`, as UTC Dates.
  // With always-open there is no opening; "closing" becomes a daily 04:00 backup time.
  function nextEvents(after = clock()) {
    const hours = getHours();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(after).map(x => [x.type, x.value]));
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    const y = Number(p.year), m = Number(p.month) - 1, d = Number(p.day);
    const start = toMinutes(hours.always ? ALWAYS_OPEN_BACKUP_AT : hours.start), end = toMinutes(hours.end);
    let opening = null, closing = null;
    for (let offset = -1; offset <= 8; offset++) {
      const dayOfWeek = (today + offset + 7) % 7;
      if (hours.always) {
        const at = localToUtc(y, m, d + offset, start, timeZone);
        if (at > after && (!closing || at < closing)) closing = at;
        continue;
      }
      if (!hours.days.includes(dayOfWeek)) continue;
      const open = localToUtc(y, m, d + offset, start, timeZone);
      const close = localToUtc(y, m, d + offset + (end <= start ? 1 : 0), end, timeZone);
      if (open > after && (!opening || open < opening)) opening = open;
      if (close > after && (!closing || close < closing)) closing = close;
    }
    return { opening, closing, autoSession: !hours.always && hours.autoSession !== false };
  }

  // Called when club hours open: start tonight's session unless one was started recently.
  function autoStartSession() {
    const hours = getHours();
    if (hours.always || hours.autoSession === false) return null;
    const current = currentSession();
    if (current && clock().getTime() - Date.parse(current.created_at) < AUTO_SESSION_GRACE_MS) return null;
    return startSession();
  }

  function requireLoggingOpen() {
    const status = loggingStatus();
    if (!status.open) {
      throw Object.assign(new Error(`Logging is closed. It opens ${status.next || 'at the next club night'}.`), { code: 'closed', status });
    }
  }

  /* ---------- sessions ---------- */

  const currentSession = () => one('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');

  function startSession(label) {
    const fallback = clock().toLocaleDateString('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return one('INSERT INTO sessions (label, created_at) VALUES (?, ?) RETURNING *', cleanName(label) || fallback, now());
  }

  const ensureSession = () => currentSession() || startSession();

  /* ---------- players ---------- */

  function listPlayers({ includeRemoved = false } = {}) {
    const where = includeRemoved ? '' : 'WHERE active = 1';
    return sql.all(`SELECT id, name, elo, active, created_at FROM players ${where} ORDER BY name COLLATE NOCASE`);
  }

  function similarPlayers(name) {
    return sql.all('SELECT id, name FROM players WHERE active = 1')
      .filter(p => looksLikeSamePerson(p.name, name))
      .slice(0, 4);
  }

  function addPlayer(name, { force = false } = {}) {
    name = cleanName(name);
    if (!name) throw new Error('Name is required');
    if (name.length > 40) throw new Error('Name is too long');
    const existing = one('SELECT id, name FROM players WHERE name = ? COLLATE NOCASE AND active = 1', name);
    if (existing) throw new SimilarNameError([existing], true); // exact match: never add twice
    if (!force) {
      const similar = similarPlayers(name);
      if (similar.length) throw new SimilarNameError(similar);
    }
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

  // Two entries for one person: move every game from `dropId` to `keepId`, remove `dropId`, replay Elo.
  function mergePlayers(keepId, dropId) {
    keepId = Number(keepId); dropId = Number(dropId);
    if (!keepId || !dropId || keepId === dropId) throw new Error('Pick two different players');
    return sql.transaction(() => {
      const keep = one('SELECT * FROM players WHERE id = ?', keepId);
      const drop = one('SELECT * FROM players WHERE id = ?', dropId);
      if (!keep || !drop) throw new Error('Player not found');
      if (one('SELECT 1 AS x FROM games WHERE (p1_id = ? AND p2_id = ?) OR (p1_id = ? AND p2_id = ?) LIMIT 1', keepId, dropId, dropId, keepId)) {
        throw new Error(`${drop.name} and ${keep.name} have played each other, so they can't be the same person. Delete those games first if they're wrong.`);
      }
      const moved = sql.all('UPDATE games SET p1_id = ? WHERE p1_id = ? RETURNING id', keepId, dropId).length
                  + sql.all('UPDATE games SET p2_id = ? WHERE p2_id = ? RETURNING id', keepId, dropId).length;
      sql.all('DELETE FROM players WHERE id = ?', dropId);
      if (drop.active && !keep.active) sql.all('UPDATE players SET active = 1 WHERE id = ?', keepId);
      recalculate();
      return { moved, kept: keep.name, removed: drop.name };
    });
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

  function logGame(p1Id, p2Id, result, { deviceId = null, allowDuplicate = false } = {}) {
    p1Id = Number(p1Id); p2Id = Number(p2Id); result = Number(result);
    deviceId = cleanDevice(deviceId);
    if (!p1Id || !p2Id) throw new Error('Pick both players');
    if (p1Id === p2Id) throw new Error('A player cannot play themselves');
    if (![0, 0.5, 1].includes(result)) throw new Error('Invalid result');

    return sql.transaction(() => {
      const p1 = one('SELECT * FROM players WHERE id = ? AND active = 1', p1Id);
      const p2 = one('SELECT * FROM players WHERE id = ? AND active = 1', p2Id);
      if (!p1 || !p2) throw new Error('Player not found');
      if (!allowDuplicate) {
        // Same two players with the same outcome (either colour order) in the last few minutes.
        const since = new Date(clock().getTime() - DUPLICATE_WINDOW_MS).toISOString();
        const dup = one(`SELECT created_at, device_id FROM games
                         WHERE created_at >= ? AND ((p1_id = ? AND p2_id = ? AND result = ?) OR (p1_id = ? AND p2_id = ? AND result = ?))
                         ORDER BY created_at DESC LIMIT 1`, since, p1Id, p2Id, result, p2Id, p1Id, 1 - result);
        if (dup) {
          const minutesAgo = Math.floor((clock().getTime() - Date.parse(dup.created_at)) / 60000);
          throw new DuplicateError(minutesAgo, !!deviceId && dup.device_id === deviceId);
        }
      }
      const session = ensureSession();
      const d1 = eloDelta(p1.elo, p2.elo, result);
      const d2 = eloDelta(p2.elo, p1.elo, 1 - result);
      const game = one(`INSERT INTO games (p1_id, p2_id, result, p1_delta, p2_delta, session_id, created_at, device_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, p1Id, p2Id, result, d1, d2, session.id, now(), deviceId);
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

  // The phone that logged a game can take it back for a short while, without admin.
  function undoOwnGame(id, deviceId) {
    deviceId = cleanDevice(deviceId);
    const g = one('SELECT id, device_id, created_at FROM games WHERE id = ?', Number(id));
    if (!g) throw new Error('That game was already removed');
    if (!deviceId || g.device_id !== deviceId) throw new Error('Only the phone that logged this game can undo it');
    if (clock().getTime() - Date.parse(g.created_at) > SELF_UNDO_MS) {
      throw new Error('Too late to undo from your phone. Ask the organiser to delete it.');
    }
    deleteGame(g.id);
  }

  // Admin clean-up: remove every game one phone logged, then replay Elo once.
  function deleteGamesByDevice(deviceId) {
    deviceId = cleanDevice(deviceId);
    if (!deviceId) throw new Error('Unknown phone');
    return sql.transaction(() => {
      const removed = sql.all('DELETE FROM games WHERE device_id = ? RETURNING id', deviceId).length;
      if (!removed) throw new Error('No games from that phone');
      recalculate();
      return removed;
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
      logging: loggingStatus(),
    };
  }

  /* ---------- backups (stored in the club database) ---------- */

  function saveBackup(reason, { ifChanged = false } = {}) {
    const data = exportData();
    const body = JSON.stringify({ players: data.players, sessions: data.sessions, games: data.games });
    const fp = fingerprint(body);
    if (ifChanged) {
      const last = one('SELECT fingerprint FROM backups ORDER BY id DESC LIMIT 1');
      if (last && last.fingerprint === fp) return null;
      if (!last && !data.players.length) return null; // nothing to back up yet
    }
    const row = one(`INSERT INTO backups (created_at, reason, players, games, fingerprint, data)
                     VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at, reason, players, games`,
      now(), String(reason).slice(0, 80), data.players.length, data.games.length, fp, JSON.stringify(data));
    sql.all('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)', KEEP_BACKUPS);
    return row;
  }

  const listBackups = () => sql.all('SELECT id, created_at, reason, players, games FROM backups ORDER BY id DESC');

  function getBackup(id) {
    const row = one('SELECT data FROM backups WHERE id = ?', Number(id));
    if (!row) throw new Error('Backup not found');
    return JSON.parse(row.data);
  }

  // Restoring is itself undoable: the current state is saved first.
  function restoreBackup(id) {
    const data = getBackup(id);
    saveBackup('Before restore');
    return importData(data);
  }

  /* ---------- spreadsheet ---------- */

  // Sheets for the Excel download: readable names, real dates in club time, one row per thing.
  function spreadsheetSheets() {
    const localDate = iso => { const d = new Date(iso); return (d.getTime() + tzOffset(d, timeZone)) / 86400000 + 25569; };
    const players = sql.all('SELECT * FROM players');
    const byId = new Map(players.map(p => [p.id, p]));
    const games = sql.all(`SELECT g.*, s.label AS session_label FROM games g JOIN sessions s ON s.id = g.session_id ORDER BY g.created_at, g.id`);
    const stats = tally(games);
    const ranked = players.filter(p => p.active).sort((a, b) => b.elo - a.elo);
    const rankOf = new Map(ranked.map((p, i) => [p.id, i + 1]));
    const resultText = r => (r === 1 ? '1–0' : r === 0 ? '0–1' : '½–½');
    const sessionGames = new Map();
    for (const g of games) {
      const e = sessionGames.get(g.session_id) || { games: 0, players: new Set() };
      e.games++; e.players.add(g.p1_id); e.players.add(g.p2_id);
      sessionGames.set(g.session_id, e);
    }
    return [
      {
        name: 'Players',
        columns: [
          { header: 'Rank', width: 7, type: 'int' }, { header: 'Name', width: 24 }, { header: 'Elo', width: 8, type: 'int' },
          { header: 'Games', width: 8, type: 'int' }, { header: 'Wins', width: 7, type: 'int' }, { header: 'Draws', width: 7, type: 'int' },
          { header: 'Losses', width: 8, type: 'int' }, { header: 'Status', width: 10 }, { header: 'Joined', width: 17, type: 'date' },
        ],
        rows: [...players].sort((a, b) => b.active - a.active || b.elo - a.elo).map(p => {
          const t = stats.get(p.id) || { games: 0, w: 0, d: 0, l: 0 };
          return [rankOf.get(p.id) ?? null, p.name, Math.round(p.elo), t.games, t.w, t.d, t.l, p.active ? 'Active' : 'Removed', localDate(p.created_at)];
        }),
      },
      {
        name: 'Games',
        columns: [
          { header: 'Date', width: 17, type: 'date' }, { header: 'Session', width: 26 }, { header: 'White', width: 22 },
          { header: 'Black', width: 22 }, { header: 'Result', width: 8 }, { header: 'White Elo change', width: 16, type: 'int' },
          { header: 'Black Elo change', width: 16, type: 'int' }, { header: 'Logged by phone', width: 15 },
        ],
        rows: [...games].reverse().map(g => [
          localDate(g.created_at), g.session_label, byId.get(g.p1_id)?.name ?? '?', byId.get(g.p2_id)?.name ?? '?',
          resultText(g.result), Math.round(g.p1_delta), Math.round(g.p2_delta), g.device_id ? g.device_id.slice(0, 4).toUpperCase() : 'admin',
        ]),
      },
      {
        name: 'Sessions',
        columns: [
          { header: 'Started', width: 17, type: 'date' }, { header: 'Session', width: 28 },
          { header: 'Games', width: 8, type: 'int' }, { header: 'Players', width: 8, type: 'int' },
        ],
        rows: sql.all('SELECT * FROM sessions ORDER BY id DESC').map(sn => {
          const e = sessionGames.get(sn.id);
          return [localDate(sn.created_at), sn.label, e ? e.games : 0, e ? e.players.size : 0];
        }),
      },
    ];
  }

  /* ---------- export / import ---------- */

  function exportData() {
    return {
      format: 'chessmates-export',
      version: 1,
      exported_at: now(),
      players: sql.all('SELECT * FROM players ORDER BY id'),
      sessions: sql.all('SELECT * FROM sessions ORDER BY id'),
      games: sql.all('SELECT id, p1_id, p2_id, result, session_id, created_at, device_id FROM games ORDER BY id'),
    };
  }

  // Replaces all players, sessions and games with an export, then replays Elo.
  function importData(data) {
    if (!data || data.format !== 'chessmates-export') throw new Error('That file is not a Chessmatess export');
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
        sql.all('INSERT INTO games (id, p1_id, p2_id, result, session_id, created_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          Number(g.id), Number(g.p1_id), Number(g.p2_id), Number(g.result), Number(g.session_id), String(g.created_at), cleanDevice(g.device_id));
      }
      recalculate();
    });
    return { players: players.length, sessions: sessions.length, games: games.length };
  }

  return {
    getSetting, setSetting, getHours, setHours, loggingStatus, requireLoggingOpen, nextEvents, autoStartSession,
    saveBackup, listBackups, getBackup, restoreBackup,
    currentSession, startSession,
    listPlayers, addPlayer, similarPlayers, mergePlayers, renamePlayer, removePlayer, restorePlayer,
    logGame, deleteGame, undoLastGame, undoOwnGame, deleteGamesByDevice, recalculate, recentGames,
    tonightStandings, monthStandings, snapshot,
    exportData, importData, spreadsheetSheets,
  };
}
