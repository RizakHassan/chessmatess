import test from 'node:test';
import assert from 'node:assert';
import { createClub, REPEAT_LIMIT } from '../src/core.js';
import { memoryClub, sqlAdapter } from './helpers.js';

// Default hours: Mondays 18:00–22:00 London (17:00–21:00 UTC in October)
function clubAt(iso) {
  let t = Date.parse(iso);
  const clock = () => new Date(t);
  const { club, db } = memoryClub({ clock });
  return { club, db, clock, set: x => { t = Date.parse(x); } };
}
const again = { allowDuplicate: true };

test('only the first 3 games between the same two players count toward the night', () => {
  const { club } = clubAt('2026-10-05T17:30:00Z');
  const a = club.addPlayer('Amara O'), b = club.addPlayer('Priya R');
  const games = Array.from({ length: 5 }, () => club.logGame(a.id, b.id, 1, again));
  assert.deepStrictEqual(games.map(g => [g.pair_games, g.counted]), [[1, true], [2, true], [3, true], [4, false], [5, false]]);
  assert.strictEqual(REPEAT_LIMIT, 3);

  const t = club.tonightStandings();
  const amara = t.rows.find(r => r.name === 'Amara O');
  assert.deepStrictEqual([amara.w, amara.games, amara.uncounted], [3, 3, 2]);
  assert.strictEqual(t.gameCount, 5);
  assert.strictEqual(t.uncounted, 2);
  // Elo still moves for every game
  assert.ok(club.listPlayers().find(p => p.name === 'Amara O').elo - 1000 > amara.delta);
  // Admin sees which games didn't count (newest first)
  assert.deepStrictEqual(club.recentGames().map(g => g.counted), [false, false, true, true, true]);
});

test('the night is ranked by rating gained, so one upset beats farming weaker players', () => {
  const { club, set } = clubAt('2026-09-28T17:30:00Z');
  const [hi, l1, l2, l3, mid] = ['Hugo B', 'Lena C', 'Liam D', 'Lola E', 'Maya F'].map(n => club.addPlayer(n));
  club.startSession();
  for (const l of [l1, l2, l3]) for (let i = 0; i < 3; i++) club.logGame(hi.id, l.id, 1, again); // Hugo gets strong

  set('2026-10-05T17:30:00Z');
  club.startSession();
  for (const l of [l1, l2, l3]) club.logGame(hi.id, l.id, 1);   // 3 easy wins: small gains each
  club.logGame(mid.id, l1.id, 1);
  club.logGame(mid.id, hi.id, 1);                                // one big upset
  club.logGame(mid.id, l2.id, 0.5);
  const t = club.tonightStandings();
  assert.strictEqual(t.rule, 'gain');
  assert.strictEqual(t.rows[0].name, 'Maya F');
  assert.ok(t.rows.find(r => r.name === 'Hugo B').w > t.rows[0].w); // Hugo has more wins but ranks lower
  assert.strictEqual(t.leader_id, mid.id);
});

test('winning the night needs 3 different opponents', () => {
  const { club, set } = clubAt('2026-10-05T17:30:00Z');
  const [a, b, c, d, e] = ['Amara O', 'Priya R', 'Kenji M', 'Dev P', 'Ezra Q'].map(n => club.addPlayer(n));
  club.startSession();
  club.logGame(a.id, b.id, 1); club.logGame(a.id, b.id, 1, again); club.logGame(a.id, c.id, 1); // Amara: 2 opponents
  club.logGame(d.id, b.id, 1); club.logGame(d.id, c.id, 0.5); club.logGame(d.id, e.id, 0.5);   // Dev: 3 opponents
  const t = club.tonightStandings();
  assert.strictEqual(t.rows[0].name, 'Amara O');               // top of the board…
  assert.strictEqual(t.rows[0].opponents, 2);
  assert.strictEqual(t.leader_id, d.id);                        // …but Dev is on course for the ♚
  set('2026-10-05T21:30:00Z');
  assert.deepStrictEqual(club.nightWinners().map(w => w.player_id), [d.id]);
});

test('nights from before the fair rules keep their old ranking and titles', () => {
  const { club, db, clock, set } = clubAt('2026-09-28T17:30:00Z');
  const [a, b, c] = ['Amara O', 'Priya R', 'Kenji M'].map(n => club.addPlayer(n));
  const old = club.startSession();
  club.logGame(a.id, b.id, 1); club.logGame(a.id, b.id, 1, again); club.logGame(a.id, b.id, 1, again); club.logGame(a.id, b.id, 1, again);
  club.logGame(c.id, a.id, 1);
  club.setSetting('fair_rules_from', old.id + 1);               // as if this night was played before the upgrade
  const upgraded = createClub(sqlAdapter(db), { clock });
  set('2026-09-28T21:30:00Z');
  const night = upgraded.sessionStandings(old.id);
  assert.strictEqual(night.rule, 'wins');
  assert.strictEqual(night.rows[0].name, 'Amara O');            // 4 wins against one opponent still counts
  assert.deepStrictEqual(upgraded.nightWinners().map(w => w.player_id), [a.id]);
  assert.ok(upgraded.recentGames().every(g => g.counted));
});

test('suggests people here tonight, closest rating first, new opponents before repeats', () => {
  const { club, set } = clubAt('2026-10-05T17:00:00Z');
  const [me, near, far, rematch] = ['Rizak H', 'Nia K', 'Fred T', 'Remi S'].map(n => club.addPlayer(n));
  club.addPlayer('Absent A');                                    // on the list but not at the club tonight
  set('2026-10-05T17:30:00Z');
  club.startSession();
  club.logGame(far.id, near.id, 0); club.logGame(far.id, near.id, 0, again);  // Fred drops to ~970, Nia up to ~1030
  club.logGame(me.id, rematch.id, 0.5); club.logGame(me.id, rematch.id, 0.5, again); club.logGame(me.id, rematch.id, 0.5, again);
  set('2026-10-05T18:00:00Z');
  club.addPlayer('Lola N');                                      // joined tonight, still 1000
  const picks = club.suggestOpponents(me.id, 10);
  // Remi is at the 3-game limit; Absent A hasn't been here tonight
  assert.deepStrictEqual(picks.map(s => s.name), ['Lola N', 'Fred T', 'Nia K']);
  assert.deepStrictEqual(picks[0], { id: picks[0].id, name: 'Lola N', elo: 1000, gap: 0, played: 0 });
  assert.strictEqual(club.suggestOpponents(me.id).length, 3);
  assert.deepStrictEqual(club.suggestOpponents(9999), []);
});
