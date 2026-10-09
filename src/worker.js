import { DurableObject } from 'cloudflare:workers';
import { createClub } from './core.js';

/*
  Routing: the Worker serves static pages from /public and forwards /api/* and /ws
  to a single Durable Object ("the club"), which owns the SQLite database and every
  live WebSocket, so all writes and broadcasts happen in one place.
*/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return Response.redirect(new URL('/display', url), 302);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      return env.CLUB.get(env.CLUB.idFromName('club')).fetch(request);
    }
    const res = await env.ASSETS.fetch(request);
    return res.status === 404 ? notFound() : res;
  },
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
// Wrong guesses allowed per IP before a 15-minute lockout. Club-code and PIN failures are
// counted separately: everyone at the venue shares one public IP, and phones must never
// be able to lock the admin out.
const LIMITS = { pin: 8, code: 20 };
const LOCKOUT_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

function randomCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export class Club extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    let depth = 0;
    const sql = {
      all: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray(),
      transaction(fn) {
        if (depth) return fn();
        depth++;
        try { return ctx.storage.transactionSync(fn); } finally { depth--; }
      },
    };
    this.club = createClub(sql, { timeZone: env.CLUB_TIMEZONE || 'Europe/London' });
    if (!this.club.getSetting('club_code')) this.club.setSetting('club_code', randomCode());
    this.fails = new Map(); // `${kind}:${ip}` -> { count, until } for PIN / club-code guessing
    // Answer client heartbeats without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ---------- live updates ---------- */

  broadcast() {
    const msg = JSON.stringify({ type: 'state', state: this.club.snapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* socket already closing */ }
    }
  }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }
  webSocketError() {}

  /* ---------- guards ---------- */

  ipOf(request) { return request.headers.get('cf-connecting-ip') || 'local'; }

  checkLockout(kind, ip) {
    const f = this.fails.get(`${kind}:${ip}`);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
  }

  recordFail(kind, ip) {
    const key = `${kind}:${ip}`;
    const f = this.fails.get(key) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= LIMITS[kind]) { f.until = Date.now() + LOCKOUT_MS; f.count = 0; }
    this.fails.set(key, f);
  }

  requireAdmin(request) {
    const pin = this.env.ADMIN_PIN;
    if (!pin) throw new HttpError(503, 'Admin is locked: set the ADMIN_PIN secret in Cloudflare first.');
    const ip = this.ipOf(request);
    this.checkLockout('pin', ip);
    if (!safeEqual(request.headers.get('x-admin-pin') || '', pin)) {
      this.recordFail('pin', ip);
      throw new HttpError(401, 'Admin PIN required');
    }
    this.fails.delete(`pin:${ip}`);
  }

  requireClubCode(request) {
    const ip = this.ipOf(request);
    const given = (request.headers.get('x-club-code') || '').trim().toUpperCase();
    if (given && safeEqual(given, this.club.getSetting('club_code'))) return;
    // A phone remembering a recently replaced code is not a guess: don't count it.
    if (!given || this.retiredCodes().includes(given)) {
      throw new HttpError(403, 'The club QR code has changed. Scan the new one at the club to log games.');
    }
    this.checkLockout('code', ip);
    this.recordFail('code', ip);
    throw new HttpError(403, 'This link has expired. Scan the QR code at the club to log games.');
  }

  retiredCodes() {
    try { return JSON.parse(this.club.getSetting('retired_codes') || '[]'); } catch { return []; }
  }

  /* ---------- routes ---------- */

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body = async () => { try { return await request.json(); } catch { return {}; } };
    const club = this.club;

    if (path === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'state', state: club.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Mutating calls broadcast fresh state to every screen afterwards.
    const mutate = (fn) => { const out = fn() ?? {}; this.broadcast(); return json({ ok: true, ...out }); };

    try {
      /* public */
      if (path === '/api/state' && method === 'GET') return json(club.snapshot());
      if (path === '/api/code/check' && method === 'POST') {
        this.requireClubCode(request);
        return json({ ok: true });
      }
      if (path === '/api/players' && method === 'POST') {
        this.requireClubCode(request);
        const { name, force } = await body();
        return mutate(() => ({ player: club.addPlayer(name, { force: force === true }) }));
      }
      if (path === '/api/games' && method === 'POST') {
        this.requireClubCode(request);
        const { p1, p2, result, allowDuplicate } = await body();
        const deviceId = request.headers.get('x-device-id');
        return mutate(() => ({ game: club.logGame(p1, p2, result, { deviceId, allowDuplicate: allowDuplicate === true }) }));
      }
      const ownUndo = path.match(/^\/api\/games\/(\d+)\/undo$/);
      if (ownUndo && method === 'POST') {
        this.requireClubCode(request);
        return mutate(() => club.undoOwnGame(Number(ownUndo[1]), request.headers.get('x-device-id')));
      }

      /* admin */
      if (path.startsWith('/api/admin/')) {
        this.requireAdmin(request);
        const sub = path.slice('/api/admin'.length);
        const idMatch = sub.match(/^\/(players|games)\/(\d+)(\/restore)?$/);
        const id = idMatch ? Number(idMatch[2]) : null;

        if (sub === '/check' && method === 'POST') return json({ ok: true });
        if (sub === '/players' && method === 'GET') return json(club.listPlayers({ includeRemoved: true }));
        if (sub === '/players' && method === 'POST') { const { name, force } = await body(); return mutate(() => ({ player: club.addPlayer(name, { force: force === true }) })); }
        if (sub === '/players/merge' && method === 'POST') { const { keep, drop } = await body(); return mutate(() => club.mergePlayers(keep, drop)); }
        if (sub === '/games' && method === 'GET') return json(club.recentGames(Math.min(Number(url.searchParams.get('limit')) || 100, 1000)));
        if (sub === '/session' && method === 'GET') return json(club.currentSession());
        if (sub === '/sessions' && method === 'POST') { const { label } = await body(); return mutate(() => ({ session: club.startSession(label) })); }
        if (sub === '/undo' && method === 'POST') return mutate(() => ({ undone: club.undoLastGame() }));
        if (sub === '/recalculate' && method === 'POST') return mutate(() => club.recalculate());
        if (idMatch?.[1] === 'players' && !idMatch[3] && method === 'PATCH') { const { name } = await body(); return mutate(() => club.renamePlayer(id, name)); }
        if (idMatch?.[1] === 'players' && !idMatch[3] && method === 'DELETE') return mutate(() => club.removePlayer(id));
        if (idMatch?.[1] === 'players' && idMatch[3] && method === 'POST') return mutate(() => club.restorePlayer(id));
        if (idMatch?.[1] === 'games' && !idMatch[3] && method === 'DELETE') return mutate(() => club.deleteGame(id));

        const deviceMatch = sub.match(/^\/devices\/([A-Za-z0-9-]{8,64})\/games$/);
        if (deviceMatch && method === 'DELETE') return mutate(() => ({ removed: club.deleteGamesByDevice(deviceMatch[1]) }));

        if (sub === '/club-code' && method === 'GET') return json({ code: club.getSetting('club_code') });
        if (sub === '/club-code' && method === 'POST') {
          const code = randomCode();
          club.setSetting('retired_codes', JSON.stringify([club.getSetting('club_code'), ...this.retiredCodes()].slice(0, 5)));
          club.setSetting('club_code', code);
          return json({ ok: true, code });
        }
        if (sub === '/export' && method === 'GET') {
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          return json(club.exportData(), 200, { 'content-disposition': `attachment; filename="chessmatess-export-${stamp}.json"` });
        }
        if (sub === '/import' && method === 'POST') {
          const data = await request.json().catch(() => null);
          return mutate(() => ({ imported: club.importData(data) }));
        }
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message }, err.status);
      if (err.code === 'similar') {
        return json({ ok: false, similar: err.matches.map(p => ({ id: p.id, name: p.name })), exact: err.exact, error: err.message }, 409);
      }
      if (err.code === 'duplicate') {
        return json({ ok: false, duplicate: true, error: err.message, minutes_ago: err.minutesAgo, same_phone: err.samePhone }, 409);
      }
      return json({ ok: false, error: err.message || 'Something went wrong' }, 400);
    }
  }
}

function notFound() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title>
<link rel="icon" href="/favicon.png" type="image/png"><link rel="stylesheet" href="/style.css">
<style>main{max-width:520px;margin:0 auto;padding:16vh 20px 40px}h1{font-size:40px;letter-spacing:-.04em;margin:0 0 8px}
p{color:var(--muted);margin:0 0 24px}nav{display:flex;gap:8px;flex-wrap:wrap}</style></head>
<body><main><h1>Page not found</h1><p>There is nothing at this address. Try one of these instead.</p>
<nav><a class="btn primary" href="/display">Leaderboard</a><a class="btn ghost" href="/admin">Admin</a></nav>
</main></body></html>`, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
