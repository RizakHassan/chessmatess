import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { buildXlsx } from '../src/xlsx.js';
import { memoryClub } from './helpers.js';

function sampleClub() {
  let t = Date.parse('2026-10-12T18:05:00Z'); // 19:05 in London
  const { club } = memoryClub({ clock: () => new Date(t) });
  const a = club.addPlayer('Amara Okafor'), b = club.addPlayer('Priya <Raman> & Co');
  const c = club.addPlayer('Kenji Mori');
  club.logGame(a.id, b.id, 1, { deviceId: 'abcd1234ef' });
  t += 30 * 60e3;
  club.logGame(b.id, c.id, 0.5);
  club.removePlayer(c.id);
  return club;
}

test('spreadsheet sheets have readable rows with club-time dates', () => {
  const [players, games, sessions] = sampleClub().spreadsheetSheets();
  assert.deepStrictEqual(players.rows.map(r => [...r.slice(1, 7), r[8]]), [
    ['Amara Okafor', 1016, 1, 1, 0, 0, 'Active'],
    ['Priya <Raman> & Co', 985, 2, 0, 1, 1, 'Active'],
    ['Kenji Mori', 999, 1, 0, 1, 0, 'Removed'],
  ]);
  assert.strictEqual(players.rows[2][0], null); // removed players have no rank
  assert.deepStrictEqual(games.rows.map(r => r.slice(2, 8)), [
    ['Priya <Raman> & Co', 'Kenji Mori', '½–½', 1, -1, 'admin'],
    ['Amara Okafor', 'Priya <Raman> & Co', '1–0', 16, -16, 'ABCD'],
  ]);
  // 19:05 London on 12 Oct 2026 as an Excel serial date
  const serial = games.rows[1][0];
  const back = new Date(Math.round((serial - 25569) * 86400000));
  assert.strictEqual(back.toISOString().slice(0, 16), '2026-10-12T19:05');
  assert.deepStrictEqual(sessions.rows.map(r => r.slice(1)), [['Monday, 12 October 2026', 2, 3]]);
});

test('xlsx is a valid zip with escaped XML', () => {
  const bytes = buildXlsx(sampleClub().spreadsheetSheets());
  const files = unzipSync(bytes);
  for (const name of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']) {
    assert.ok(files[name], name);
  }
  const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.ok(sheet1.includes('Priya &lt;Raman&gt; &amp; Co'));
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, bytes);
});
