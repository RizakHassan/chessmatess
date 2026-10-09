import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

function clubAt(iso) {
  let t = Date.parse(iso);
  const { club } = memoryClub({ clock: () => new Date(t) });
  return { club, set: x => { t = Date.parse(x); } };
}

test('nights won count the #1 of each finished club night', () => {
  // Default hours: Mondays 18:00–22:00 London (17:00–21:00 UTC in October)
  const { club, set } = clubAt('2026-09-28T17:30:00Z');
  const a = club.addPlayer('Amara O'), b = club.addPlayer('Priya R'), c = club.addPlayer('Kenji M');
  club.startSession();
  club.logGame(a.id, b.id, 1); club.logGame(a.id, c.id, 1);          // Amara wins night 1
  // Night 1 still open: no title yet
  assert.strictEqual(club.tonightStandings().rows.find(r => r.name === 'Amara O').titles, 0);
  set('2026-09-28T21:30:00Z');                                       // after 22:00: night over
  assert.strictEqual(club.tonightStandings().rows.find(r => r.name === 'Amara O').titles, 1);

  set('2026-10-05T17:30:00Z');
  club.startSession();
  club.logGame(c.id, a.id, 1); club.logGame(c.id, b.id, 1);          // Kenji wins night 2
  set('2026-10-12T17:30:00Z');
  const s3 = club.startSession();
  club.logGame(a.id, b.id, 0.5);                                     // night 3: only a draw -> no winner
  set('2026-10-12T21:30:00Z');
  const titles = Object.fromEntries(club.monthStandings().rows.map(r => [r.name, r.titles]));
  assert.deepStrictEqual(titles, { 'Kenji M': 1, 'Amara O': 1, 'Priya R': 0 }); // October board shows all-time counts
  assert.deepStrictEqual(club.nightWinners().map(w => w.player_id), [a.id, c.id]);
  // Past week shows counts as they stood then
  const list = club.listSessions();
  const night1 = list[list.length - 1].id;
  assert.strictEqual(club.sessionStandings(night1).rows.find(r => r.name === 'Amara O').titles, 1);
  assert.strictEqual(club.sessionStandings(night1).rows.find(r => r.name === 'Kenji M').titles, 0);
  // September (past month) only counts nights finished by then
  assert.strictEqual(club.monthStandingsFor('2026-09').rows.find(r => r.name === 'Amara O').titles, 1);
  // Deleting the games that won night 2 removes that title
  for (const g of club.recentGames().filter(g => g.p1_name === 'Kenji M')) club.deleteGame(g.id);
  assert.deepStrictEqual(club.nightWinners().map(w => w.player_id), [a.id]);
  assert.ok(s3);
});
