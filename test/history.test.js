import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

function clubAt(iso) {
  let t = Date.parse(iso);
  const { club } = memoryClub({ clock: () => new Date(t) });
  return { club, set: x => { t = Date.parse(x); } };
}

test("past sessions show that night's results with ratings as they were then", () => {
  const { club, set } = clubAt('2026-09-28T18:00:00Z');        // Mon 28 Sep
  const a = club.addPlayer('Amara O'), b = club.addPlayer('Priya R'), c = club.addPlayer('Kenji M');
  const week1 = club.startSession();
  club.logGame(a.id, b.id, 1);                                  // Amara 1016, Priya 984
  set('2026-10-05T18:00:00Z');                                  // Mon 5 Oct
  const week2 = club.startSession();
  club.logGame(b.id, a.id, 1);                                  // Priya beats Amara
  club.logGame(c.id, b.id, 1);
  set('2026-10-12T18:00:00Z');                                  // Mon 12 Oct (tonight, no games yet)
  const tonight = club.startSession();

  const list = club.listSessions();
  assert.deepStrictEqual(list.map(s => [s.id, s.games, s.current]), [[tonight.id, 0, true], [week2.id, 2, false], [week1.id, 1, false]]);

  const w1 = club.sessionStandings(week1.id);
  assert.strictEqual(w1.current, false);
  assert.deepStrictEqual(w1.rows.map(r => [r.name, r.w, r.l, r.elo, r.delta]), [['Amara O', 1, 0, 1016, 16], ['Priya R', 0, 1, 984, -16]]);
  const w2 = club.sessionStandings(week2.id);
  assert.deepStrictEqual(w2.rows.map(r => r.name), ['Kenji M', 'Priya R', 'Amara O']); // wins, then Elo
  // Amara's rating that night was below 1016, not today's value from later games
  assert.ok(w2.rows.find(r => r.name === 'Amara O').elo < 1016);
  assert.strictEqual(club.sessionStandings(tonight.id).current, true);

  // Removing a player later doesn't erase them from old weeks
  club.removePlayer(c.id);
  assert.ok(club.sessionStandings(week2.id).rows.some(r => r.name === 'Kenji M'));
  assert.throws(() => club.sessionStandings(9999), /not found/);
});

test('past months rank by the rating at the end of that month', () => {
  const { club, set } = clubAt('2026-09-10T18:00:00Z');
  const a = club.addPlayer('Amara O'), b = club.addPlayer('Priya R');
  club.logGame(a.id, b.id, 1);                                  // September: Amara ahead
  set('2026-10-05T18:00:00Z');
  club.logGame(b.id, a.id, 1); club.logGame(b.id, a.id, 1, { allowDuplicate: true }); // October: Priya ahead
  const months = club.listMonths();
  assert.deepStrictEqual(months.map(m => [m.key, m.games, m.current]), [['2026-10', 2, true], ['2026-09', 1, false]]);
  const sep = club.monthStandingsFor('2026-09');
  assert.strictEqual(sep.label, 'September 2026');
  assert.deepStrictEqual(sep.rows.map(r => [r.name, r.elo]), [['Amara O', 1016], ['Priya R', 984]]);
  const oct = club.monthStandingsFor('2026-10');
  assert.strictEqual(oct.current, true);
  assert.strictEqual(oct.rows[0].name, 'Priya R');
  assert.strictEqual(club.monthStandingsFor('2026-08').rows.length, 0);
  assert.throws(() => club.monthStandingsFor('2026-13'), /Month must/);
});
