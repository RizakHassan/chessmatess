const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessmates-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const store = require('../src/db');

const elo = name => Math.round(store.listPlayers({ includeRemoved: true }).find(p => p.name === name).elo);

test('equal players: win is +16/-16, draw is 0', () => {
  assert.strictEqual(store.eloDelta(1000, 1000, 1), 16);
  assert.strictEqual(store.eloDelta(1000, 1000, 0), -16);
  assert.strictEqual(store.eloDelta(1000, 1000, 0.5), 0);
});

test('logging games updates Elo and standings', () => {
  const a = store.addPlayer('Alice'), b = store.addPlayer('Bob'), c = store.addPlayer('Cara');
  store.logGame(a.id, b.id, 1);
  store.logGame(b.id, c.id, 0.5);
  store.logGame(c.id, a.id, 1);
  assert.strictEqual(elo('Alice') + elo('Bob') + elo('Cara'), 3000);
  const t = store.tonightStandings();
  assert.strictEqual(t.rows.length, 3);
  assert.deepStrictEqual(t.rows.map(r => [r.name, r.w, r.d, r.l]),
    [['Cara', 1, 1, 0], ['Alice', 1, 0, 1], ['Bob', 0, 1, 1]]);
});

test('deleting a middle game replays history to match a clean log', () => {
  const before = store.recentGames();
  const middle = before[1]; // Bob vs Cara draw
  store.deleteGame(middle.id);

  // Expected: Alice beats Bob, then Cara beats Alice — computed by hand
  const d1 = store.eloDelta(1000, 1000, 1);              // Alice +16
  const d2 = store.eloDelta(1000, 1000 + d1, 1);         // Cara vs Alice(1016)
  assert.strictEqual(elo('Alice'), Math.round(1000 + d1 - d2));
  assert.strictEqual(elo('Bob'), Math.round(1000 - d1));
  assert.strictEqual(elo('Cara'), Math.round(1000 + d2));
});

test('undo removes the latest game and restores ratings', () => {
  store.undoLastGame();
  store.undoLastGame();
  assert.strictEqual(elo('Alice'), 1000);
  assert.strictEqual(elo('Bob'), 1000);
  assert.throws(() => store.undoLastGame(), /No games/);
});

test('removing a player with games keeps history; new session resets tonight', () => {
  const ids = Object.fromEntries(store.listPlayers().map(p => [p.name, p.id]));
  store.logGame(ids.Alice, ids.Bob, 0);
  store.removePlayer(ids.Bob);
  assert.ok(!store.listPlayers().some(p => p.name === 'Bob'));
  store.recalculate();
  assert.ok(elo('Alice') < 1000);
  store.startSession('Next Monday');
  assert.strictEqual(store.tonightStandings().rows.length, 0);
  assert.strictEqual(store.monthStandings().rows.length, 1); // Alice (Bob hidden)
});

test('validation', () => {
  const [p] = store.listPlayers();
  assert.throws(() => store.logGame(p.id, p.id, 1), /themselves/);
  assert.throws(() => store.addPlayer('alice'), /already/);
  assert.throws(() => store.logGame(p.id, 999, 2), /Invalid result/);
});
