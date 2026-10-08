import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

test('export → import round-trips and replays Elo', () => {
  const { club } = memoryClub();
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya'), c = club.addPlayer('Kenji');
  club.logGame(a.id, b.id, 1);
  club.logGame(b.id, c.id, 0.5);
  club.removePlayer(c.id);
  const before = club.listPlayers({ includeRemoved: true });
  const data = JSON.parse(JSON.stringify(club.exportData()));

  const { club: fresh } = memoryClub();
  fresh.addPlayer('Someone else');
  assert.deepStrictEqual(fresh.importData(data), { players: 3, sessions: 1, games: 2 });
  const after = fresh.listPlayers({ includeRemoved: true });
  assert.deepStrictEqual(after.map(p => [p.name, Math.round(p.elo), p.active]), before.map(p => [p.name, Math.round(p.elo), p.active]));
  assert.strictEqual(fresh.recentGames().length, 2);
});

test('import rejects files that are not exports, leaving data alone', () => {
  const { club } = memoryClub();
  club.addPlayer('Amara');
  assert.throws(() => club.importData({ hello: 1 }), /not a Chessmates export/);
  assert.throws(() => club.importData({ format: 'chessmates-export', players: [], sessions: [], games: [{ id: 1, p1_id: 9, p2_id: 8, result: 1, session_id: 1, created_at: 'x' }] }));
  assert.strictEqual(club.listPlayers().length, 1); // failed import rolled back
});

test('settings persist', () => {
  const { club } = memoryClub();
  assert.strictEqual(club.getSetting('club_code'), null);
  club.setSetting('club_code', 'ABC');
  club.setSetting('club_code', 'XYZ');
  assert.strictEqual(club.getSetting('club_code'), 'XYZ');
});

test('"This month" uses the club timezone, not UTC', () => {
  const { club, db } = memoryClub({ timeZone: 'Europe/London' });
  const a = club.addPlayer('Amara'), b = club.addPlayer('Priya');
  club.logGame(a.id, b.id, 1);
  // 23:30 UTC on 30 Sept 2026 is 00:30 on 1 Oct in London (BST): it belongs to October.
  db.prepare("UPDATE games SET created_at = '2026-09-30T23:30:00.000Z'").run();
  const oct = club.monthStandings(new Date('2026-10-15T12:00:00Z'));
  assert.strictEqual(oct.label, 'October 2026');
  assert.strictEqual(oct.gameCount, 1);
  const sep = club.monthStandings(new Date('2026-09-15T12:00:00Z'));
  assert.strictEqual(sep.gameCount, 0);
  // In a UTC club the same game is still September.
  const { club: utcClub, db: db2 } = memoryClub({ timeZone: 'UTC' });
  const x = utcClub.addPlayer('A'), y = utcClub.addPlayer('B');
  utcClub.logGame(x.id, y.id, 1);
  db2.prepare("UPDATE games SET created_at = '2026-09-30T23:30:00.000Z'").run();
  assert.strictEqual(utcClub.monthStandings(new Date('2026-09-15T12:00:00Z')).gameCount, 1);
});
