import test from 'node:test';
import assert from 'node:assert';
import { eloDelta } from '../src/core.js';
import { memoryClub } from './helpers.js';

const { club } = memoryClub();
const elo = name => Math.round(club.listPlayers({ includeRemoved: true }).find(p => p.name === name).elo);

test('equal players: win is +16/-16, draw is 0', () => {
  assert.strictEqual(eloDelta(1000, 1000, 1), 16);
  assert.strictEqual(eloDelta(1000, 1000, 0), -16);
  assert.strictEqual(eloDelta(1000, 1000, 0.5), 0);
});

test('logging games updates Elo and standings', () => {
  const a = club.addPlayer('Alice'), b = club.addPlayer('Bob'), c = club.addPlayer('Cara');
  club.logGame(a.id, b.id, 1);
  club.logGame(b.id, c.id, 0.5);
  club.logGame(c.id, a.id, 1);
  assert.strictEqual(elo('Alice') + elo('Bob') + elo('Cara'), 3000);
  const t = club.tonightStandings();
  assert.deepStrictEqual(t.rows.map(r => [r.name, r.w, r.d, r.l]),
    [['Cara', 1, 1, 0], ['Alice', 1, 0, 1], ['Bob', 0, 1, 1]]);
});

test('deleting a middle game replays history to match a clean log', () => {
  const middle = club.recentGames()[1]; // Bob vs Cara draw
  club.deleteGame(middle.id);
  const d1 = eloDelta(1000, 1000, 1);
  const d2 = eloDelta(1000, 1000 + d1, 1);
  assert.strictEqual(elo('Alice'), Math.round(1000 + d1 - d2));
  assert.strictEqual(elo('Bob'), Math.round(1000 - d1));
  assert.strictEqual(elo('Cara'), Math.round(1000 + d2));
});

test('undo removes the latest game and restores ratings', () => {
  club.undoLastGame();
  club.undoLastGame();
  assert.strictEqual(elo('Alice'), 1000);
  assert.strictEqual(elo('Bob'), 1000);
  assert.throws(() => club.undoLastGame(), /No games/);
});

test('removing a player with games keeps history; new session resets tonight', () => {
  const ids = Object.fromEntries(club.listPlayers().map(p => [p.name, p.id]));
  club.logGame(ids.Alice, ids.Bob, 0);
  club.removePlayer(ids.Bob);
  assert.ok(!club.listPlayers().some(p => p.name === 'Bob'));
  club.recalculate();
  assert.ok(elo('Alice') < 1000);
  club.startSession('Next Monday');
  assert.strictEqual(club.tonightStandings().rows.length, 0);
  assert.strictEqual(club.monthStandings().rows.length, 1); // Alice (Bob hidden)
});

test('validation', () => {
  const [p] = club.listPlayers();
  assert.throws(() => club.logGame(p.id, p.id, 1), /themselves/);
  assert.throws(() => club.addPlayer('alice'), /already/);
  assert.throws(() => club.logGame(p.id, 999, 2), /Invalid result/);
  assert.throws(() => club.logGame(p.id, 999, 1), /Player not found/);
});
