import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

function clubAt(iso) {
  let t = Date.parse(iso);
  const { club } = memoryClub({ clock: () => new Date(t) });
  return { club, set: x => { t = Date.parse(x); }, advance: ms => { t += ms; } };
}
const iso = d => d && d.toISOString();

test('next opening and closing follow club hours in London time, across the clock change', () => {
  const { club } = clubAt('2026-10-09T12:00:00Z'); // Friday
  let e = club.nextEvents(new Date('2026-10-09T12:00:00Z'));
  assert.strictEqual(iso(e.opening), '2026-10-12T17:00:00.000Z'); // Mon 18:00 BST
  assert.strictEqual(iso(e.closing), '2026-10-12T21:00:00.000Z'); // Mon 22:00 BST
  e = club.nextEvents(new Date('2026-10-12T19:00:00Z'));           // during club night
  assert.strictEqual(iso(e.closing), '2026-10-12T21:00:00.000Z');
  assert.strictEqual(iso(e.opening), '2026-10-19T17:00:00.000Z');
  e = club.nextEvents(new Date('2026-10-27T12:00:00Z'));           // after clocks go back
  assert.strictEqual(iso(e.opening), '2026-11-02T18:00:00.000Z'); // Mon 18:00 GMT
});

test('overnight hours close the next day; always-open backs up daily at 04:00', () => {
  const { club } = clubAt('2026-10-09T12:00:00Z');
  club.setHours({ days: [4], start: '20:00', end: '01:00' });       // Thursday night
  const e = club.nextEvents(new Date('2026-10-09T12:00:00Z'));
  assert.strictEqual(iso(e.opening), '2026-10-15T19:00:00.000Z');
  assert.strictEqual(iso(e.closing), '2026-10-16T00:00:00.000Z');  // Fri 01:00 BST
  club.setHours({ always: true, days: [], start: '18:00', end: '22:00' });
  const a = club.nextEvents(new Date('2026-10-09T12:00:00Z'));
  assert.strictEqual(a.opening, null);
  assert.strictEqual(a.autoSession, false);
  assert.strictEqual(iso(a.closing), '2026-10-10T03:00:00.000Z');  // Sat 04:00 BST
});

test('auto-start makes one session per club night and respects the switch', () => {
  const { club, set } = clubAt('2026-10-12T17:00:00Z');
  const s1 = club.autoStartSession();
  assert.strictEqual(s1.label, 'Monday, 12 October 2026');
  set('2026-10-12T17:00:30Z');
  assert.strictEqual(club.autoStartSession(), null);                // already started tonight
  set('2026-10-19T17:00:00Z');
  assert.ok(club.autoStartSession());                               // next week
  club.setHours({ days: [1], start: '18:00', end: '22:00', autoSession: false });
  set('2026-10-26T17:00:00Z');
  assert.strictEqual(club.autoStartSession(), null);
});

test('backups skip when unchanged, keep the newest 20, and restore is undoable', () => {
  const { club, advance } = clubAt('2026-10-12T17:00:00Z');
  assert.strictEqual(club.saveBackup('After club night', { ifChanged: true }), null); // empty club
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  club.logGame(a.id, b.id, 1);
  const first = club.saveBackup('After club night', { ifChanged: true });
  assert.deepStrictEqual([first.players, first.games], [2, 1]);
  assert.strictEqual(club.saveBackup('After club night', { ifChanged: true }), null); // nothing new
  advance(60e3);
  club.logGame(b.id, a.id, 1);
  club.deleteGame(club.recentGames()[1].id);                        // a mistake...
  assert.strictEqual(club.recentGames().length, 1);
  club.restoreBackup(first.id);                                     // ...undone
  assert.strictEqual(club.recentGames().length, 1);
  assert.strictEqual(club.recentGames()[0].p1_name, 'Amara');
  const list = club.listBackups();
  assert.strictEqual(list[0].reason, 'Before restore');             // the restore itself can be undone
  for (let i = 0; i < 25; i++) club.saveBackup(`Manual ${i}`);
  assert.strictEqual(club.listBackups().length, 20);
  assert.throws(() => club.getBackup(99999), /not found/);
});
