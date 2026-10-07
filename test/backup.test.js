const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createBackups } = require('../src/backup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessmates-backup-'));
const db = new Database(path.join(dir, 'live.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE games (id INTEGER PRIMARY KEY);');

test('startup skips an empty database', async () => {
  const b = createBackups({ db, dir: path.join(dir, 'empty'), intervalMs: 1e9 });
  await b.start();
  assert.strictEqual(b.list().length, 0);
  await b.stop();
});

test('backup copies data, including uncheckpointed WAL writes', async () => {
  db.prepare("INSERT INTO players (name) VALUES ('Amara')").run();
  const b = createBackups({ db, dir: path.join(dir, 'b1'), intervalMs: 1e9 });
  const name = await b.backup('manual');
  assert.match(name, /^chessmates-.*-manual\.db$/);
  const copy = new Database(b.resolve(name), { readonly: true });
  assert.strictEqual(copy.prepare('SELECT name FROM players').get().name, 'Amara');
  copy.close();
});

test('keeps only the newest N', async () => {
  const b = createBackups({ db, dir: path.join(dir, 'b2'), keep: 3, intervalMs: 1e9 });
  for (let i = 0; i < 6; i++) await b.backup('auto');
  const files = b.list();
  assert.strictEqual(files.length, 3);
  const times = files.map(f => Date.parse(f.created_at));
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
});

test('stop() backs up only when there were changes', async () => {
  const b = createBackups({ db, dir: path.join(dir, 'b3'), intervalMs: 1e9 });
  await b.stop();
  assert.strictEqual(b.list().length, 0);
  b.markDirty();
  await b.stop();
  assert.match(b.list()[0].name, /-shutdown\.db$/);
});

test('resolve() rejects anything that is not a backup file name', () => {
  const b = createBackups({ db, dir: path.join(dir, 'b1') });
  assert.strictEqual(b.resolve('../live.db'), null);
  assert.strictEqual(b.resolve('chessmates-2026-01-01T00-00-00-manual.db/../../x'), null);
});
