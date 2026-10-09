import { DatabaseSync } from 'node:sqlite';
import { createClub } from '../src/core.js';

// Mirrors the Durable Object adapter: all() runs any statement, transaction() nests safely.
// Uses Node's built-in SQLite so tests need no native add-ons (they run in Cloudflare's build too).
export function sqlAdapter(db) {
  let depth = 0;
  return {
    all: (query, ...params) => db.prepare(query).all(...params).map(row => ({ ...row })),
    transaction(fn) {
      if (depth) return fn();
      depth++;
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
      finally { depth--; }
    },
  };
}

export function memoryClub(opts) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return { db, club: createClub(sqlAdapter(db), opts) };
}
