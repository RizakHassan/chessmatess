const fs = require('fs');
const path = require('path');

// Snapshot files look like chessmates-2026-10-07T19-46-02-startup.db (newest first by file time).
const NAME_RE = /^chessmates-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?-[a-z-]+\.db$/;

function createBackups({ db, dir, keep = 20, intervalMs = 10 * 60 * 1000 }) {
  fs.mkdirSync(dir, { recursive: true });
  let dirty = false;
  let timer = null;
  let running = Promise.resolve();

  function list() {
    return fs.readdirSync(dir)
      .filter(f => NAME_RE.test(f))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size: stat.size, created_at: stat.mtime.toISOString(), t: stat.mtimeMs };
      })
      .sort((a, b) => b.t - a.t || b.name.localeCompare(a.name))
      .map(({ t, ...rest }) => rest);
  }

  function prune() {
    for (const old of list().slice(keep)) fs.unlinkSync(path.join(dir, old.name));
  }

  // Serialised so two backups never write at once. Uses SQLite's online backup API,
  // which produces a consistent copy even while the app keeps writing.
  function backup(reason = 'manual') {
    const run = running.then(async () => {
      let stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
      const tag = String(reason).toLowerCase().replace(/[^a-z-]/g, '') || 'manual';
      let name = `chessmates-${stamp.slice(0, 19)}-${tag}.db`;
      if (fs.existsSync(path.join(dir, name))) name = `chessmates-${stamp}-${tag}.db`; // same second: add ms
      dirty = false;
      await db.backup(path.join(dir, name));
      prune();
      return name;
    });
    running = run.catch(() => {});
    return run;
  }

  const hasData = () => db.prepare('SELECT (SELECT COUNT(*) FROM players) + (SELECT COUNT(*) FROM games) AS n').get().n > 0;

  return {
    dir,
    list,
    backup,
    markDirty() { dirty = true; },
    get dirty() { return dirty; },
    resolve(name) {
      if (!NAME_RE.test(name)) return null;
      const full = path.join(dir, name);
      return fs.existsSync(full) ? full : null;
    },
    async start() {
      if (hasData()) await backup('startup');
      timer = setInterval(() => { if (dirty) backup('auto').catch(err => console.error('Backup failed:', err.message)); }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      if (dirty) await backup('shutdown');
      await running;
    },
  };
}

module.exports = { createBackups };
