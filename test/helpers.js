import Database from 'better-sqlite3';
import { createClub } from '../src/core.js';

// Mirrors the Durable Object adapter: all() runs any statement, transaction() nests safely.
export function memoryClub(opts) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let depth = 0;
  const sql = {
    all(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params);
      stmt.run(...params);
      return [];
    },
    transaction(fn) {
      if (depth) return fn();
      depth++;
      try { return db.transaction(fn)(); } finally { depth--; }
    },
  };
  return { db, club: createClub(sql, opts) };
}
