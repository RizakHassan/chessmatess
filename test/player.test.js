import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

test('player stats: record, rating history, peak, streak, best win, head-to-head', () => {
  let t = Date.parse('2026-10-05T17:30:00Z');
  const { club } = memoryClub({ clock: () => new Date((t += 60e3)) });
  const a = club.addPlayer('Amara O'), b = club.addPlayer('Priya R'), c = club.addPlayer('Kenji M');
  club.logGame(c.id, b.id, 1);                     // Kenji up to 1016 (Amara not involved)
  club.logGame(a.id, b.id, 1);                     // Amara beats Priya (984)
  club.logGame(c.id, a.id, 0);                     // Amara (black) beats Kenji (1016) -> best win
  club.logGame(a.id, b.id, 0.5);                   // draw
  club.logGame(b.id, a.id, 1);                     // loss
  const s = club.playerStats(a.id);
  assert.strictEqual(s.player.name, 'Amara O');
  assert.deepStrictEqual([s.games, s.w, s.d, s.l, s.score_pct], [4, 2, 1, 1, 63]);
  assert.deepStrictEqual(s.history.map(h => [h.opponent, h.color, h.score]), [['Priya R', 'white', 1], ['Kenji M', 'black', 1], ['Priya R', 'white', 0.5], ['Priya R', 'black', 0]]);
  assert.strictEqual(s.history[0].elo_before, 1000);
  assert.strictEqual(s.history.at(-1).elo, s.player.elo);           // history ends at the current rating
  assert.ok(s.history.every((h, i) => i === 0 || h.elo_before === s.history[i - 1].elo));
  assert.deepStrictEqual(s.streak, { kind: 'L', count: 1 });
  assert.strictEqual(s.best_win.opponent, 'Kenji M');
  assert.strictEqual(s.best_win.opponent_elo, 1016);
  assert.strictEqual(s.peak.elo, Math.max(...s.history.map(h => h.elo)));
  assert.deepStrictEqual(s.head_to_head.map(h => [h.name, h.games, h.w, h.d, h.l]), [['Priya R', 3, 1, 1, 1], ['Kenji M', 1, 1, 0, 0]]);
  assert.strictEqual(s.rank, [...club.listPlayers()].sort((x, y) => y.elo - x.elo).findIndex(p => p.id === a.id) + 1);
  assert.throws(() => club.playerStats(999), /not found/);
});

test('a new player has an empty but valid page', () => {
  const { club } = memoryClub();
  const p = club.addPlayer('Dev M');
  const s = club.playerStats(p.id);
  assert.deepStrictEqual([s.games, s.score_pct, s.streak, s.best_win, s.history.length], [0, null, null, null, 0]);
  assert.strictEqual(s.peak.elo, 1000);
});
