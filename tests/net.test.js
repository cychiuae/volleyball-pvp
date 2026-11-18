// Online server integration tests: real HTTP+WS server on a random port, several `ws` bot clients.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { NET } from '../src/config.js';
import { startServer } from '../server/index.js';
import { PHASES, decEnum } from '../src/net/snapshot.js';
import { parseMessage, sanitizeName } from '../server/protocol.js';
import { createRemoteInput } from '../server/remoteInput.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A scripted protocol client. */
class Bot {
  constructor(port, { latencyMs = 0 } = {}) {
    this.msgs = [];
    this.snaps = [];
    this.events = [];
    this.errors = [];
    this.room = undefined;
    this.bytes = { snap: 0, ev: 0, room: 0, other: 0 };
    this.latencyMs = latencyMs;
    this.seq = 0;
    this.waiters = new Set();
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${NET.wsPath}`);
    this.closed = new Promise((r) => this.ws.on('close', r));
    this.ws.on('message', (data, isBinary) => {
      const text = data.toString();
      const handle = () => {
        const m = JSON.parse(text);
        const kind = m.t === 'snap' || m.t === 'ev' || m.t === 'room' ? m.t : 'other';
        this.bytes[kind] += text.length;
        this.msgs.push(m);
        if (m.t === 'snap') { m.at = performance.now(); this.snaps.push(m); }
        else if (m.t === 'ev') this.events.push(m);
        else if (m.t === 'room') this.room = m.room;
        else if (m.t === 'error') this.errors.push(m);
        for (const w of [...this.waiters]) w();
      };
      if (this.latencyMs) setTimeout(handle, this.latencyMs / 2); else handle();
    });
  }
  open() { return new Promise((res, rej) => { if (this.ws.readyState === 1) res(); else { this.ws.once('open', res); this.ws.once('error', rej); } }); }
  send(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.latencyMs) setTimeout(() => this.ws.readyState === 1 && this.ws.send(s), this.latencyMs / 2);
    else this.ws.send(s);
  }
  async waitFor(pred, timeout = 4000, what = 'condition') {
    if (pred()) return;
    await new Promise((resolve, reject) => {
      const w = () => { if (pred()) { clearTimeout(timer); this.waiters.delete(w); resolve(); } };
      const timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`timeout waiting for ${what}; last room: ${JSON.stringify(this.room)}; errors: ${JSON.stringify(this.errors.slice(-3))}`)); }, timeout);
      this.waiters.add(w);
    });
  }
  waitRoom(pred, what = 'room') { return this.waitFor(() => this.room !== undefined && pred(this.room), 4000, what); }
  async waitError(code) {
    this.errSeen ||= new Set();
    const find = () => this.errors.find((e) => e.code === code && !this.errSeen.has(e));
    await this.waitFor(() => !!find(), 4000, `error ${code}`);
    const e = find();
    this.errSeen.add(e);
    return e;
  }
  get lastSnap() { return this.snaps[this.snaps.length - 1]; }
  get phase() { const s = this.lastSnap; return s ? decEnum(PHASES, s.s.g[0]) : null; }
  get simTime() { const s = this.lastSnap; return s ? s.s.t / 1000 : 0; }
  input(held = [], edges = [], axis = { x: 0, y: 0 }) {
    this.send({ t: 'input', seq: this.seq++, axis, held, edges });
  }
  close() { this.ws.close(); return this.closed; }
}

async function bots(port, n, opts) {
  const list = Array.from({ length: n }, () => new Bot(port, opts));
  await Promise.all(list.map((b) => b.open()));
  return list;
}

/** Create a room with `owner` and have `others` join it. Returns the code. */
async function makeRoom(owner, others = [], name = 'Owner') {
  owner.send({ t: 'create', name });
  await owner.waitRoom((r) => r && r.code, 'room created');
  const code = owner.room.code;
  for (const [i, b] of others.entries()) {
    b.send({ t: 'join', code, name: `Bot${i + 1}` });
    await b.waitRoom((r) => r && r.code === code, 'joined');
  }
  return code;
}

describe('net server', () => {
  let srv;
  let fast;
  before(async () => {
    srv = await startServer({ port: 0 });
    fast = await startServer({ port: 0, timeScale: 8 });
  });
  after(async () => { await srv.close(); await fast.close(); });

  test('create / join / slots / start rules', async () => {
    const [a, b, c, d, e] = await bots(srv.port, 5);
    a.send({ t: 'create', name: '  Momo\u0007‮<script>  the great and long ' });
    await a.waitRoom((r) => r && r.code);
    const r = a.room;
    assert.match(r.code, /^[A-HJ-NP-Z]{4}$/);
    assert.equal(r.owner, r.you);
    assert.deepEqual(r.slots, [r.you, null, null, null]);
    assert.equal(r.phase, 'lobby');
    const me = r.clients.find((x) => x.id === r.you);
    assert.ok(me.name.length <= 12 && !/[\u0007‮<>]/.test(me.name), `sanitised name: ${me.name}`);

    b.send({ t: 'join', code: r.code.toLowerCase(), name: '' });
    await b.waitRoom((x) => x && x.code === r.code);
    assert.equal(b.room.slots[1], b.room.you, 'joiner in lobby takes the lowest free slot');
    assert.match(b.room.clients.find((x) => x.id === b.room.you).name, /^Player \d+$/);

    c.send({ t: 'join', code: 'ZZZZ', name: 'x' });
    assert.equal((await c.waitError('noRoom')).code, 'noRoom');
    c.send({ t: 'join', code: r.code, name: 'Cee' });
    await c.waitRoom((x) => x && x.code === r.code);
    d.send({ t: 'join', code: r.code, name: 'Dee' });
    await d.waitRoom((x) => x && x.code === r.code);
    e.send({ t: 'join', code: r.code, name: 'Eee' });
    await e.waitError('full');
    assert.equal(e.room, undefined);

    // slot taken / move / leave slot
    c.send({ t: 'slot', slot: 0 });
    await c.waitError('slotTaken');
    b.send({ t: 'slot', slot: null });
    await a.waitRoom((x) => x.slots[1] === null);
    assert.deepEqual(a.room.slots.map((id) => id && a.room.clients.find((x) => x.id === id).name), [a.room.clients[0].name, null, 'Cee', 'Dee']);
    d.send({ t: 'slot', slot: null });
    await a.waitRoom((x) => x.slots[3] === null);
    b.send({ t: 'slot', slot: 3 });
    await a.waitRoom((x) => x.slots[3] === b.room.you);
    b.send({ t: 'slot', slot: 7 });
    await b.waitError('badMsg');

    // owner-only commands
    b.send({ t: 'start', difficulty: 'easy' });
    await b.waitError('notOwner');
    a.send({ t: 'start', difficulty: 'nightmare' });
    await a.waitError('badMsg');
    a.send({ t: 'start', difficulty: 'easy' });
    await a.waitRoom((x) => x.phase === 'playing' && x.difficulty === 'easy');
    await a.waitFor(() => a.events.some((ev) => ev.name === 'matchStart'), 2000, 'matchStart event');
    b.send({ t: 'toLobby' });
    await b.waitError('notOwner');
    a.send({ t: 'toLobby' });
    await a.waitRoom((x) => x.phase === 'lobby');
    await a.waitFor(() => a.events.some((ev) => ev.name === 'menu'), 2000, 'menu event');
    await Promise.all([a, b, c, d, e].map((x) => x.close()));
  });

  test('room with no humans in slots cannot start', async () => {
    const [a] = await bots(srv.port, 1);
    await makeRoom(a);
    a.send({ t: 'slot', slot: null });
    await a.waitRoom((x) => x.slots.every((s) => s === null));
    a.send({ t: 'start', difficulty: 'normal' });
    const err = await a.waitError('noPlayers');
    assert.ok(err);
    assert.equal(a.room.phase, 'lobby');
    await a.close();
  });

  test('snapshots arrive at ~NET.snapshotHz with sim time; events are forwarded; bandwidth', async () => {
    const [a, b] = await bots(srv.port, 2);
    await makeRoom(a, [b]);
    a.send({ t: 'start', difficulty: 'normal' });
    await a.waitFor(() => a.snaps.length > 3, 2000, 'first snapshots');
    const n0 = a.snaps.length, t0 = performance.now(), sim0 = a.simTime;
    const b0 = { ...a.bytes };
    // keep sending inputs like a real client (60/s) while measuring
    const iv = setInterval(() => { a.input(); b.input(); }, 1000 / 60);
    await sleep(2000);
    clearInterval(iv);
    const secs = (performance.now() - t0) / 1000;
    const rate = (a.snaps.length - n0) / secs;
    assert.ok(Math.abs(rate - NET.snapshotHz) < NET.snapshotHz * 0.15, `snapshot rate ${rate.toFixed(1)} Hz`);
    const simAdvance = a.simTime - sim0;
    assert.ok(Math.abs(simAdvance - secs) < 0.25, `sim time advances in real time (${simAdvance.toFixed(2)} vs ${secs.toFixed(2)})`);
    // monotonic sim time, same match serial
    for (let i = 1; i < a.snaps.length; i++) assert.ok(a.snaps[i].s.t > a.snaps[i - 1].s.t);
    const s = a.lastSnap.s;
    assert.equal(s.p.length, 4);
    assert.equal(s.p[0][7] & 2, 2, 'slot 0 is human');
    assert.equal(s.p[2][7] & 2, 0, 'slot 2 is AI');
    assert.ok(a.snaps.some((x) => Array.isArray(x.s.n) && x.s.n[0] === 'Owner'), 'names are sent');
    const names = a.events.map((e) => e.name);
    assert.ok(names.includes('matchStart') && names.includes('serveReady'), `events: ${[...new Set(names)]}`);
    const ms = a.events.find((e) => e.name === 'matchStart');
    assert.equal(ms.st, 0);
    assert.equal(ms.m, a.lastSnap.s.m);
    const hit = a.events.find((e) => e.name === 'hit' || e.name === 'jump' || e.name === 'bounce');
    if (hit && hit.v) for (const k of hit.v) assert.equal(hit.p[k].length, 3, 'Vector3 sent as [x,y,z]');
    const snapBps = (a.bytes.snap - b0.snap) / secs;
    const evBps = (a.bytes.ev - b0.ev) / secs;
    const avg = (a.bytes.snap - b0.snap) / (a.snaps.length - n0);
    console.log(`# bandwidth per client: snapshots ${(snapBps / 1024).toFixed(2)} KiB/s (avg ${avg.toFixed(0)} B/snap), events ${(evBps / 1024).toFixed(2)} KiB/s`);
    assert.ok(snapBps < 20 * 1024, `snapshot bandwidth ${snapBps.toFixed(0)} B/s`);
    await Promise.all([a.close(), b.close()]);
  });

  test('mid-match join waits in the lobby list; slot request mid-rally is applied at the next break', { timeout: 30000 }, async () => {
    const [a, d] = await bots(srv.port, 2);
    const code = await makeRoom(a);
    a.send({ t: 'slot', slot: 2 }); // human on team 1: team 0 (AI) serves first, so a rally starts by itself
    await a.waitRoom((x) => x.slots[2] === x.you);
    a.send({ t: 'start', difficulty: 'easy' });
    const game = () => srv.lobby.rooms.get(code)?.game;
    await a.waitFor(() => game()?.state.phase === 'rally', 8000, 'rally');
    d.send({ t: 'join', code, name: 'Late' });
    await d.waitRoom((x) => x && x.code === code);
    assert.equal(d.room.phase, 'playing');
    assert.equal(d.room.clients.find((x) => x.id === d.room.you).slot, null, 'mid-match joiner has no slot');
    await d.waitFor(() => d.snaps.length > 0, 2000, 'late joiner gets snapshots');
    assert.ok(Array.isArray(d.snaps[0].s.n), 'late joiner gets names with its first snapshot');
    // request a slot while the rally is live: queued, then granted at the next point break
    await a.waitFor(() => game()?.state.phase === 'rally', 15000, 'rally again');
    d.send({ t: 'slot', slot: 0 });
    await d.waitRoom((x) => x.clients.some((c) => c.id === x.you && c.pending === 0), 'pending request');
    assert.equal(d.room.slots[0], null);
    let grantPhase = null;
    await d.waitFor(() => {
      if (d.room.slots[0] === d.room.you) { grantPhase ??= game().state.phase; return true; }
      return false;
    }, 20000, 'slot granted');
    assert.ok(['serve', 'point', 'matchOver'].includes(grantPhase), `granted during ${grantPhase}`);
    await d.waitFor(() => (d.lastSnap.s.p[0][7] & 2) === 2, 3000, 'slot 0 human in snapshots');
    await Promise.all([a.close(), d.close()]);
  });

  test('disconnect: slot becomes AI immediately, match continues; owner hand-off; last leaver deletes room', async () => {
    const [a, b, c] = await bots(fast.port, 3);
    const code = await makeRoom(a, [b, c]);
    const ids = { a: a.room.you, b: b.room.you, c: c.room.you };
    a.send({ t: 'start', difficulty: 'normal' });
    await b.waitFor(() => b.snaps.length > 5, 3000, 'snapshots');
    assert.equal(b.lastSnap.s.p[0][7] & 2, 2);
    a.ws.terminate(); // owner vanishes
    await b.waitRoom((x) => !x.clients.some((cl) => cl.id === ids.a), 'owner gone');
    assert.equal(b.room.owner, ids.b, 'ownership passes to the oldest client');
    assert.equal(b.room.slots[0], null);
    assert.equal(b.room.phase, 'playing');
    const t0 = b.simTime;
    await b.waitFor(() => b.lastSnap.s.p[0][7] === (b.lastSnap.s.p[0][7] & 1), 2000, 'slot 0 AI in snapshots');
    await b.waitFor(() => b.simTime > t0 + 1, 3000, 'match continues');
    // new owner can control the match
    b.send({ t: 'toLobby' });
    await c.waitRoom((x) => x.phase === 'lobby');
    b.send({ t: 'leave' });
    await b.waitFor(() => b.room === null, 2000, 'left');
    await c.waitRoom((x) => x.owner === ids.c);
    await c.close();
    await sleep(50);
    const [z] = await bots(fast.port, 1);
    z.send({ t: 'join', code, name: 'z' });
    await z.waitError('noRoom');
    await Promise.all([b.close(), z.close()]);
  });

  test('bad, oversized and flooding messages are rejected without crashing', async () => {
    const [a, b] = await bots(srv.port, 2);
    await makeRoom(a, [b]);
    const n = a.errors.length;
    a.send('this is not json');
    a.send('[1,2,3]');
    a.send(JSON.stringify({ t: 'nope' }));
    a.send(JSON.stringify({ t: 'input', seq: 'x' }));
    a.send(JSON.stringify({ t: 'input', seq: 1, axis: { x: 'a', y: 0 } }));
    a.send(JSON.stringify({ t: 'input', seq: 2, edges: [['jump', 'sideways', 1]] }));
    a.send(JSON.stringify({ t: 'input', seq: 3, edges: [['__proto__', 'down', 1]] }));
    a.send(JSON.stringify({ t: 'input', seq: 4, held: Array(100).fill('jump') }));
    a.send(JSON.stringify({ t: 'ping', c: 'x' }));
    a.send(JSON.stringify({ t: 'create', name: 'x'.repeat(5000) }));   // > 4 KB
    a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await a.waitFor(() => a.errors.length - n >= 11, 3000, 'badMsg replies');
    assert.ok(a.errors.slice(n).every((e) => e.code === 'badMsg'), JSON.stringify(a.errors.slice(n).map((e) => e.code)));
    assert.ok(a.errors.slice(n).every((e) => !String(e.msg).includes('xxxx')), 'raw input never echoed');
    // still connected and in the room
    a.send({ t: 'ping', c: 42 });
    await a.waitFor(() => a.msgs.some((m) => m.t === 'pong' && m.c === 42), 2000, 'pong');
    assert.ok(a.room && a.room.code);

    // Flood: 600 messages at once -> rateLimit, server alive, other clients unaffected.
    for (let i = 0; i < 600; i++) b.send({ t: 'ping', c: i });
    await b.waitError('rateLimit');
    const pongs = b.msgs.filter((m) => m.t === 'pong').length;
    assert.ok(pongs <= 125, `at most ~120 processed in the burst (${pongs})`);
    a.send({ t: 'ping', c: 43 });
    await a.waitFor(() => a.msgs.some((m) => m.t === 'pong' && m.c === 43), 2000, 'other client still served');

    // > hard frame cap: the socket is closed (server survives)
    const [c] = await bots(srv.port, 1);
    c.ws.send('x'.repeat(70 * 1024));
    await c.closed;
    const [d] = await bots(srv.port, 1);
    d.send({ t: 'ping', c: 1 });
    await d.waitFor(() => d.msgs.some((m) => m.t === 'pong'), 2000, 'server alive');
    await Promise.all([a.close(), b.close(), d.close()]);
  });

  test('lag compensation: a 150 ms-RTT bot pressing Pass on the green meter it SAW is graded fairly', { timeout: 90000 }, async () => {
    const [a] = await bots(srv.port, 1, { latencyMs: 150 });
    await makeRoom(a);
    const tStart = performance.now();
    a.send({ t: 'start', difficulty: 'easy' });
    let ep = 0, prev = null, pressed = -1, serving = false, holdT = 0;
    const iv = setInterval(() => {
      // What a real client shows: the picture interpDelay behind the newest snapshot.
      const newest = a.lastSnap;
      if (!newest) return;
      let view = null;
      for (let i = a.snaps.length - 1; i >= 0; i--) {
        if (a.snaps[i].s.m === newest.s.m && a.snaps[i].s.t <= newest.s.t - NET.interpDelay * 1000) { view = a.snaps[i]; break; }
      }
      if (!view) return;
      const s = view.s;
      const vt = s.t / 1000;
      const me = s.p[0], b = s.b, pass = me[10] ? me[10][0] : -1;
      const edges = [];
      let held = [];
      if (s.g[0] === 1 && s.g[5] === 0) {
        if (!serving) { serving = true; holdT = vt; edges.push(['hit', 'down', vt]); }
        if (vt - holdT < 0.9) held = ['hit']; else if (serving === true) { serving = 'done'; edges.push(['hit', 'up', vt]); }
      } else serving = false;
      let x = 0, y = 0;
      if (b.length >= 14 && b[13] > 0) {
        const dx = b[11] - me[0], dz = b[13] - me[2];
        if (Math.hypot(dx, dz) > 300) { x = Math.sign(dx); y = -Math.sign(dz); }
      }
      if (pass >= 0 && prev !== null && pass < prev - 200) ep++;
      if (pass >= 0) prev = pass;
      if (pass >= 840 && pressed !== ep) { pressed = ep; edges.push(['pass', 'down', vt], ['pass', 'up', vt]); }
      a.input(held, edges, { x, y });
    }, 1000 / 60);
    const graded = () => a.events.filter((e) => e.name === 'passAttempt' && e.p.playerId === 0 && e.p.meter !== null);
    try {
      await a.waitFor(() => graded().length >= 4, 70000, '4 graded passes');
    } finally { clearInterval(iv); }
    const timings = graded().map((e) => `${e.p.timing}@${e.p.meter}`);
    const fair = timings.filter((t) => t.startsWith('perfect') || t.startsWith('good')).length;
    const secs = (performance.now() - tStart) / 1000;
    console.log(`# bandwidth in live rallies: snapshots ${(a.bytes.snap / secs / 1024).toFixed(2)} KiB/s (${(a.bytes.snap / a.snaps.length).toFixed(0)} B/snap), events ${(a.bytes.ev / secs / 1024).toFixed(2)} KiB/s, room ${(a.bytes.room / secs).toFixed(0)} B/s`);
    console.log(`# lag comp @150 ms RTT + ${NET.interpDelay * 1000} ms interp: ${timings.join(', ')}`);
    assert.ok(fair >= timings.length - 1, `presses on green graded fairly: ${timings}`);
    await a.close();
  });

  test('a full match between bots completes (bots serve with the real controls)', { timeout: 120000 }, async () => {
    const [a, b] = await bots(fast.port, 2, { latencyMs: 60 });
    await makeRoom(a, [b]);
    b.send({ t: 'slot', slot: 2 });
    await a.waitRoom((x) => x.slots[2] === b.room.you);
    a.send({ t: 'start', difficulty: 'easy' });
    const slots = new Map([[a, 0], [b, 2]]);
    const holding = new Map();
    const iv = setInterval(() => {
      for (const [bot, slot] of slots) {
        const s = bot.lastSnap && bot.lastSnap.s;
        if (!s) { bot.input(); continue; }
        const vt = s.t / 1000;
        const serving = decEnum(PHASES, s.g[0]) === 'serve' && s.g[5] === slot;
        if (serving && !holding.get(bot)) { holding.set(bot, vt); bot.input(['hit'], [['hit', 'down', vt]]); }
        else if (holding.get(bot) !== undefined && holding.get(bot) !== false && vt - holding.get(bot) > 0.5) {
          holding.set(bot, false); bot.input([], [['hit', 'up', vt]]);
        } else if (!serving && holding.get(bot) === false) { holding.delete(bot); bot.input(); }
        else bot.input(holding.get(bot) ? ['hit'] : [], [], { x: Math.sin(vt), y: 0 });
      }
    }, 1000 / 60);
    try {
      await a.waitFor(() => a.events.some((e) => e.name === 'matchOver'), 110000, 'matchOver');
    } finally { clearInterval(iv); }
    const over = a.events.find((e) => e.name === 'matchOver');
    const [s0, s1] = over.p.score;
    assert.ok(Math.max(s0, s1) >= 15 && Math.abs(s0 - s1) >= 2, `final score ${s0}-${s1}`);
    const points = a.events.filter((e) => e.name === 'point').length;
    assert.equal(points, s0 + s1);
    const humanServes = a.events.filter((e) => e.name === 'hit' && e.p.type === 'serve' && (e.p.playerId === 0 || e.p.playerId === 2)).length;
    assert.ok(humanServes > 0, 'remote humans served');
    // events and snapshots agree, both clients saw the same stream
    await b.waitFor(() => b.events.some((e) => e.name === 'matchOver'), 3000, 'b matchOver');
    assert.deepEqual(b.events.find((e) => e.name === 'matchOver').p.score, over.p.score);
    console.log(`# full match ${s0}-${s1}, ${points} points, ${humanServes} remote-human serves`);
    await Promise.all([a.close(), b.close()]);
  });
});

describe('net static http', () => {
  let srv, root;
  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'cbv-dist-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>cbv</title>');
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(path.join(root, 'assets', 'app.css'), 'body{}');
    srv = await startServer({ port: 0, root });
  });
  after(() => srv.close());

  const rawGet = (port, p) => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });

  test('serves files with MIME types, SPA fallback, no traversal', async () => {
    const base = `http://127.0.0.1:${srv.port}`;
    let r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await fetch(`${base}/assets/app.js`);
    assert.match(r.headers.get('content-type'), /javascript/);
    r = await fetch(`${base}/assets/app.css`);
    assert.match(r.headers.get('content-type'), /text\/css/);
    r = await fetch(`${base}/lobby/ABCD`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /cbv/);
    r = await fetch(`${base}/assets/missing.js`);
    assert.equal(r.status, 404);
    r = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(r.status, 405);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json', '/%00', '/%E0%A4%A']) {
      const res = await rawGet(srv.port, p);
      assert.ok(!res.includes('"name"'), `traversal blocked for ${p}`);
      assert.match(res, /^HTTP\/1\.1 (200|400|404)/, p);
    }
    // non-WS upgrade path refused
    const res = await rawGet(srv.port, '/healthz');
    assert.match(res, /200/);
  });
});

describe('net units', () => {
  test('lobby: idle rooms are removed after 30 min; room cap', async () => {
    const { createLobby, LIMITS } = await import('../server/rooms.js');
    let t = 1e6;
    const lobby = createLobby({ now: () => t });
    const out = [];
    const c1 = lobby.connect((s) => out.push(JSON.parse(s)));
    lobby.handle(c1, parseMessage(JSON.stringify({ t: 'create', name: 'a' })));
    assert.equal(lobby.rooms.size, 1);
    t += 29 * 60 * 1000; lobby.tick(0.016);
    assert.equal(lobby.rooms.size, 1);
    t += 2 * 60 * 1000; lobby.tick(0.016);
    assert.equal(lobby.rooms.size, 0, 'idle room removed');
    assert.equal(out.at(-1).t, 'room');
    assert.equal(out.at(-1).room, null);
    const cap = LIMITS.maxRooms;
    LIMITS.maxRooms = 2;
    try {
      const cs = [0, 1, 2].map(() => lobby.connect((s) => out.push(JSON.parse(s))));
      for (const c of cs) lobby.handle(c, parseMessage('{"t":"create","name":"x"}'));
      assert.equal(lobby.rooms.size, 2);
      assert.ok(out.some((m) => m.t === 'error' && m.code === 'full'));
    } finally { LIMITS.maxRooms = cap; lobby.close(); }
  });

  test('sanitizeName / parseMessage', () => {
    assert.equal(sanitizeName('  hi   there  '), 'hi there');
    assert.equal(sanitizeName('\u0000\u001b[31mred'), '[31mred');
    assert.equal(Array.from(sanitizeName('🍑'.repeat(20))).length, 12);
    assert.equal(sanitizeName(42), '');
    assert.equal(parseMessage('{"t":"join","code":"abcd","name":"x"}').code, 'ABCD');
    assert.equal(parseMessage('{"t":"join","code":"AB1D"}').error, 'noRoom');
    assert.equal(parseMessage('{"t":"input","seq":1,"axis":{"x":5,"y":0}}').axis.x, 1);
    assert.equal(parseMessage(Buffer.from('{"t":"leave"}')).t, 'leave');
  });

  test('remote input never loses edges between ticks and keeps each viewTime', () => {
    const inp = createRemoteInput();
    let now = 10;
    inp.setClock(() => now, 0.25);
    // tap + second tap of 'pass' and a 'hit' press, all arriving before one server tick
    inp.feed({ seq: 1, axis: { x: 0, y: 0 }, held: [], edges: [['pass', 'down', 9.90], ['pass', 'up', 9.92]] });
    inp.feed({ seq: 2, axis: { x: 0, y: 0 }, held: ['hit'], edges: [['pass', 'down', 9.95], ['pass', 'up', 9.96], ['hit', 'down', 9.97]] });
    inp.poll();
    assert.ok(inp.pressed('pass') && inp.released('pass'));
    assert.ok(Math.abs(inp.edgeTime('pass') - 9.92) < 1e-9);
    assert.ok(inp.pressed('hit') && inp.held('hit'));
    assert.ok(Math.abs(inp.edgeTime('hit') - 9.97) < 1e-9);
    now = 10.01;
    inp.poll();
    assert.ok(inp.pressed('pass') && inp.released('pass'), 'second tap delivered on the next tick');
    assert.ok(Math.abs(inp.edgeTime('pass') - 9.96) < 1e-9);
    assert.ok(!inp.pressed('hit') && inp.held('hit'));
    inp.poll();
    assert.ok(!inp.pressed('pass'));
    // viewTime clamped to maxRewind; stale seq ignored; held reconciliation
    inp.feed({ seq: 3, axis: { x: 0, y: 1 }, held: ['hit', 'jump'], edges: [['jump', 'down', 1.0]] });
    assert.equal(inp.feed({ seq: 3, axis: { x: 0, y: 0 }, held: [], edges: [] }), false);
    inp.poll();
    assert.ok(inp.pressed('jump'));
    assert.ok(Math.abs(inp.edgeTime('jump') - (now - 0.25)) < 1e-9);
    assert.deepEqual(inp.axis(), { x: 0, y: 1 });
    inp.feed({ seq: 4, axis: { x: 0, y: 0 }, held: [], edges: [] }); // missing 'up' edges
    inp.poll();
    assert.ok(inp.released('jump') && inp.released('hit') && !inp.held('jump'));
    assert.equal(inp.edgeTime('jump'), undefined, 'synthetic edge = now');
  });
});
