'use strict';
/* Stack to the Stars: multiplayer server (1 vs 1 rooms + quick match).
   Plain Node.js + the "ws" package. Everything lives in memory: no database. */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // empty = allow any
const MAX_ROOMS = +process.env.MAX_ROOMS || 2000;
const MAX_PER_ROOM = 2;

const rooms = new Map();      // code -> { code, players:[ws], seq, dirty }
const queue = [];             // sockets waiting for a quick match
let nextId = 1;
let totalMatches = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, online: wss.clients.size, queued: queue.length, matches: totalMatches }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  verifyClient: (info, cb) => {
    if (!ALLOWED.length) return cb(true);
    cb(!!info.origin && ALLOWED.includes(info.origin), 403, 'Origin not allowed');
  }
});

/* ---- helpers ---- */
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const randCode = () => {
  const L = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
};
// Only known, size-limited fields are accepted from players.
function clean(st) {
  const o = {};
  if (!st || typeof st !== 'object') return o;
  if (typeof st.n === 'string') o.n = st.n.replace(/[^\w \-.]/g, '').trim().slice(0, 12) || 'Player';
  for (const k of ['ph', 'mt']) if (typeof st[k] === 'string') o[k] = st[k].replace(/[^a-z]/g, '').slice(0, 10);
  for (const k of ['go', 'lim', 'sc', 'fin', 't']) {
    if (typeof st[k] === 'number' && isFinite(st[k])) o[k] = Math.max(0, Math.min(1e9, Math.round(st[k])));
    else if (st[k] === null && k === 'fin') o[k] = null;
  }
  if (Array.isArray(st.tw)) o.tw = st.tw.slice(0, 10).map(v => Math.max(0, Math.min(300, Math.round(+v) || 0)));
  return o;
}
function flush(r) {
  r.dirty = false;
  for (const p of r.players) {
    send(p, { t: 'peers', list: r.players.map(q => ({ id: q.id, me: q === p, st: q.st })) });
  }
}
function touch(r) {            // coalesce bursts into one update every ~40 ms
  if (r.dirty) return;
  r.dirty = true;
  setTimeout(() => flush(r), 40);
}
function leave(ws) {
  const qi = queue.indexOf(ws); if (qi >= 0) queue.splice(qi, 1);
  const r = ws.room; if (!r) return;
  ws.room = null;
  r.players = r.players.filter(p => p !== ws);
  if (!r.players.length) { rooms.delete(r.code); return; }
  r.players[0].st.role = 'host';          // the player who stays becomes host
  touch(r);
}
function enter(ws, r, st) {
  ws.room = r;
  ws.st = Object.assign({}, clean(st), { jt: ++r.seq, role: r.players.length ? 'guest' : 'host' });
  r.players.push(ws);
  touch(r);
}
function join(ws, code, create, st) {
  leave(ws);
  code = String(code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return send(ws, { t: 'err', m: 'badcode' });
  let r = rooms.get(code);
  if (!r) {
    if (!create) return send(ws, { t: 'err', m: 'nohost' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', m: 'busy' });
    r = { code, players: [], seq: 0, dirty: false };
    rooms.set(code, r);
  } else if (create) return send(ws, { t: 'err', m: 'taken' });
  if (r.players.length >= MAX_PER_ROOM) return send(ws, { t: 'full' });
  enter(ws, r, st);
}
function quick(ws, st) {
  leave(ws);
  ws.pending = clean(st);
  while (queue.length) {
    const w = queue.shift();
    if (w === ws || w.readyState !== 1 || w.room) continue;
    const code = randCode(); if (!code) return send(ws, { t: 'err', m: 'busy' });
    const r = { code, players: [], seq: 0, dirty: false }; rooms.set(code, r);
    enter(w, r, w.pending); enter(ws, r, ws.pending);
    totalMatches++;
    send(w, { t: 'matched', code, host: true });
    send(ws, { t: 'matched', code, host: false });
    return;
  }
  queue.push(ws);
  send(ws, { t: 'queued' });
}

/* ---- connections ---- */
wss.on('connection', ws => {
  ws.id = 'p' + (nextId++);
  ws.room = null; ws.alive = true; ws.tokens = 60; ws.strikes = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', buf => {
    // simple rate limit: about 30 messages a second, with a burst allowance
    if (--ws.tokens < 0) { if (++ws.strikes > 100) ws.terminate(); return; }
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') join(ws, m.code, !!m.create, m.st);
    else if (m.t === 'quick') quick(ws, m.st);
    else if (m.t === 'set') { if (ws.room) { Object.assign(ws.st, clean(m.st)); touch(ws.room); } }
    else if (m.t === 'cancel') leave(ws);
    else if (m.t === 'ping') send(ws, { t: 'pong' });
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) ws.tokens = Math.min(60, ws.tokens + 30); }, 1000);
setInterval(() => {            // drop dead connections
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
}, 20000);

server.listen(PORT, () => console.log('Stack to the Stars multiplayer server on port ' + PORT));
process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
