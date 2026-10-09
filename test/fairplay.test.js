import test from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { createClub, DuplicateError } from '../src/core.js';
import { memoryClub } from './helpers.js';

const PHONE_A = 'aaaaaaaa1111', PHONE_B = 'bbbbbbbb2222';

function clubAt(start = '2026-10-12T19:00:00Z') {
  let t = Date.parse(start);
  const { club, db } = memoryClub({ clock: () => new Date(t) });
  return { club, db, advance: ms => { t += ms; } };
}

test('the same result from either side within 10 minutes is flagged as a duplicate', () => {
  const { club, advance } = clubAt();
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  club.logGame(a.id, b.id, 1, { deviceId: PHONE_A });
  advance(2 * 60e3);
  // Priya's phone logs it with colours swapped: Priya (white) lost = same game.
  assert.throws(() => club.logGame(b.id, a.id, 0, { deviceId: PHONE_B }), err => {
    assert.ok(err instanceof DuplicateError);
    assert.strictEqual(err.minutesAgo, 2);
    assert.strictEqual(err.samePhone, false);
    return true;
  });
  assert.throws(() => club.logGame(a.id, b.id, 1, { deviceId: PHONE_A }), err => err.samePhone === true);
  assert.strictEqual(club.recentGames().length, 1);
});

test('a different result, a confirmed rematch, or an old game is not a duplicate', () => {
  const { club, advance } = clubAt();
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  club.logGame(a.id, b.id, 1);
  club.logGame(a.id, b.id, 0.5);                          // different result
  club.logGame(a.id, b.id, 1, { allowDuplicate: true });  // players said it was a new game
  advance(11 * 60e3);
  club.logGame(a.id, b.id, 1);                            // outside the window
  assert.strictEqual(club.recentGames().length, 4);
});

test('the logging phone can undo its own game for a short time only', () => {
  const { club, advance } = clubAt();
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  const g1 = club.logGame(a.id, b.id, 1, { deviceId: PHONE_A });
  assert.throws(() => club.undoOwnGame(g1.id, PHONE_B), /Only the phone/);
  assert.throws(() => club.undoOwnGame(g1.id, null), /Only the phone/);
  advance(30e3);
  club.undoOwnGame(g1.id, PHONE_A);
  assert.strictEqual(club.recentGames().length, 0);
  assert.strictEqual(Math.round(club.listPlayers()[0].elo), 1000);

  const g2 = club.logGame(a.id, b.id, 1, { deviceId: PHONE_A });
  advance(2 * 60e3);
  assert.throws(() => club.undoOwnGame(g2.id, PHONE_A), /Too late/);
});

test('admin can delete everything one phone logged, and Elo is replayed', () => {
  const { club, advance } = clubAt();
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya'), c = club.addPlayer('Kenji');
  club.logGame(a.id, b.id, 1, { deviceId: PHONE_A });
  advance(60e3);
  club.logGame(c.id, b.id, 1, { deviceId: PHONE_B }); // the prank phone
  advance(60e3);
  club.logGame(c.id, a.id, 1, { deviceId: PHONE_B });
  assert.strictEqual(club.deleteGamesByDevice(PHONE_B), 2);
  const elo = Object.fromEntries(club.listPlayers().map(p => [p.name, Math.round(p.elo)]));
  assert.deepStrictEqual(elo, { Amara: 1016, Kenji: 1000, Priya: 984 });
  assert.throws(() => club.deleteGamesByDevice(PHONE_B), /No games/);
  assert.throws(() => club.deleteGamesByDevice('../x'), /Unknown phone/);
});

test('an existing database without device_id is upgraded in place', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, p1_id INTEGER NOT NULL, p2_id INTEGER NOT NULL,
           result REAL NOT NULL, p1_delta REAL NOT NULL DEFAULT 0, p2_delta REAL NOT NULL DEFAULT 0,
           session_id INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  db.exec(`INSERT INTO games (p1_id, p2_id, result, session_id, created_at) VALUES (1, 2, 1, 1, '2026-10-05T19:00:00Z')`);
  const sql = { all: (q, ...p) => { const s = db.prepare(q); if (s.reader) return s.all(...p); s.run(...p); return []; }, transaction: fn => db.transaction(fn)() };
  createClub(sql);
  const cols = db.prepare('PRAGMA table_info(games)').all().map(c => c.name);
  assert.ok(cols.includes('device_id'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1);
  createClub(sql); // running again is harmless
});

test('new names that look like an existing player need confirming; exact repeats are refused', () => {
  const { club } = memoryClub();
  club.addPlayer('Rizak Hassan');
  club.addPlayer('Lucía Ortega');
  const similar = name => { try { club.addPlayer(name); return null; } catch (e) { return e.code === 'similar' ? e.matches.map(m => m.name) : e.message; } };
  assert.deepStrictEqual(similar('rizak'), ['Rizak Hassan']);          // same first name
  assert.deepStrictEqual(similar('Rizak H'), ['Rizak Hassan']);
  assert.deepStrictEqual(similar('Rizk Hassan'), ['Rizak Hassan']);    // typo
  assert.deepStrictEqual(similar('lucia ortega'), ['Lucía Ortega']);   // accents
  assert.deepStrictEqual(similar('RIZAK HASSAN'), ['Rizak Hassan']);   // exact repeat
  assert.strictEqual(similar('Priya Raman'), null);                     // genuinely new
  assert.strictEqual(club.addPlayer('Rizak', { force: true }).name, 'Rizak');
  assert.throws(() => club.addPlayer('rizak hassan', { force: true }), e => e.exact === true); // exact is never forced
});

test('merging moves games onto the kept player and replays Elo', () => {
  const { club } = memoryClub();
  const real = club.addPlayer('Rizak Hassan');
  const dup = club.addPlayer('Rizak', { force: true });
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  club.logGame(real.id, a.id, 1);
  club.logGame(b.id, dup.id, 0); // dup (black) won
  const out = club.mergePlayers(real.id, dup.id);
  assert.deepStrictEqual(out, { moved: 1, kept: 'Rizak Hassan', removed: 'Rizak' });
  const rows = Object.fromEntries(club.listPlayers({ includeRemoved: true }).map(p => [p.name, Math.round(p.elo)]));
  assert.ok(!('Rizak' in rows));
  assert.ok(rows['Rizak Hassan'] > 1016); // two wins now count for one person
  assert.strictEqual(club.tonightStandings().rows.find(r => r.name === 'Rizak Hassan').w, 2);
});

test("players who have played each other can't be merged", () => {
  const { club } = memoryClub();
  const x = club.addPlayer('Sam Whitfield'), y = club.addPlayer('Sam Wood', { force: true });
  club.logGame(x.id, y.id, 1);
  assert.throws(() => club.mergePlayers(x.id, y.id), /played each other/);
  assert.throws(() => club.mergePlayers(x.id, x.id), /two different/);
});
