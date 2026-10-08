// Converts a database from the old laptop version (chessmates.db or a backups/*.db file)
// into a JSON export you can upload in Admin → Backups → "Restore from export".
//   npm run export-sqlite -- path/to/chessmates.db [out.json]
import fs from 'node:fs';
import Database from 'better-sqlite3';

const [input, output = 'chessmates-export.json'] = process.argv.slice(2);
if (!input || !fs.existsSync(input)) {
  console.error('Usage: npm run export-sqlite -- path/to/chessmates.db [out.json]');
  process.exit(1);
}
const db = new Database(input, { readonly: true, fileMustExist: true });
const data = {
  format: 'chessmates-export',
  version: 1,
  exported_at: new Date().toISOString(),
  players: db.prepare('SELECT * FROM players ORDER BY id').all(),
  sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
  games: db.prepare('SELECT id, p1_id, p2_id, result, session_id, created_at FROM games ORDER BY id').all(),
};
fs.writeFileSync(output, JSON.stringify(data, null, 2));
console.log(`Wrote ${output}: ${data.players.length} players, ${data.sessions.length} sessions, ${data.games.length} games.`);
