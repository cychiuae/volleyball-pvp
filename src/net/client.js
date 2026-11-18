// Browser client for online play (docs/NETWORK.md › Client).
//
//   const net = createNetClient({ events, input, url });
//   net.connect(); net.create(name); net.join(code, name); net.takeSlot(slot | null);
//   net.start(difficulty); net.toLobby(); net.leave();
//   net.onRoom(fn(room | null)); net.onStatus(fn({ status, ping, message, code }));
//   net.game  -> remote game adapter with the createGame() interface.
//
// The client never simulates. It renders snapshots ~NET.interpDelay behind the newest one
// (more if the network is jittery), re-emits server events on the page's bus when their sim
// time is rendered, and sends the local player's input with viewTime = the rendered state.time
// the player was looking at (the server grades timing against it: lag compensation).
import { Vector3 } from 'three';
import { NET } from '../config.js';
import { ACTIONS_ENUM, DIFFS, PHASES, REASONS, decEnum, isSnapshot } from './snapshot.js';

const SEND_ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'pass', 'hit'];
const SNAP_PERIOD = 1 / NET.snapshotHz;
const BUFFER_MAX = 64;
const OFFSET_WINDOW = 90;          // snapshots (~3 s) used for the clock / jitter estimate
const MAX_DELAY = 0.35;            // s; the jitter buffer never grows beyond this
const SNAP_CLOCK_ERR = 0.5;        // s; render clock further off than this jumps instead of drifting
const PING_EVERY = 2;              // s
const INPUT_PERIOD = 1 / 60;       // ≤ 60 input messages per second
const STALE_EVENT = 0.5;           // s; cosmetic events this far in the past are dropped (tab was hidden)
const KEEP_EVENTS = new Set(['matchStart', 'serveReady', 'point', 'matchOver', 'menu']);

function envUrl() {
  try {
    const env = import.meta.env;
    if (env && env.VITE_SERVER_URL) return env.VITE_SERVER_URL;
  } catch { /* not under Vite */ }
  return null;
}
function defaultUrl() {
  const fromEnv = envUrl();
  if (fromEnv) return fromEnv;
  const loc = globalThis.location;
  if (!loc) return `ws://localhost:${NET.defaultPort}${NET.wsPath}`;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${NET.wsPath}`;
}

function createMeters() {
  return { pass: null, spike: null, hitCharge: null, serveCharge: null, serveRisk: null, aimTarget: null, passWindow: 0, hitWindow: 0 };
}

function createRemoteState() {
  return {
    phase: 'menu',
    paused: false,
    difficulty: 'normal',
    time: 0,
    score: [0, 0],
    servingTeam: 0,
    serverId: 0,
    touches: 0,
    possessionTeam: null,
    controlledId: 0,
    serveCharge: null,
    serveRisk: null,
    aimTarget: null,
    lastPoint: null,
    passMeter: null,
    passWindow: 0,
    hitWindow: 0,
    spikeMeter: null,
    hitCharge: null,
    ball: {
      pos: new Vector3(0, 0.24, 0), vel: new Vector3(), spin: new Vector3(),
      visible: false, landing: null, held: false, lastTeam: null,
    },
    players: [0, 1, 2, 3].map((id) => ({
      id, team: id < 2 ? 0 : 1, index: id % 2,
      pos: new Vector3((id % 2 ? 1.5 : -1.5), 0, id < 2 ? 4 : -4),
      vel: new Vector3(), facing: id < 2 ? Math.PI : 0,
      grounded: true, action: null, actionTime: 0,
      controlled: false, human: false, name: null,
      meters: createMeters(),
      windup: null,
    })),
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
/** Quantised meter (1e-3, -1 = null) interpolation. */
function meterAt(a, b, t) {
  if (a < 0) return null;
  if (b < 0) return a / 1000;
  return lerp(a, b, t) / 1000;
}

/**
 * @param {{ events: {emit:Function}, input: object, url?: string,
 *           WebSocketImpl?: typeof WebSocket, now?: () => number }} opts
 *   now(): seconds, monotonic (defaults to performance.now()/1000). Tests inject both.
 */
export function createNetClient({ events, input, url, WebSocketImpl, now } = {}) {
  const bus = events && typeof events.emit === 'function' ? events : { emit() {} };
  const clock = now || (() => (globalThis.performance ? performance.now() : Date.now()) / 1000);
  const WS = WebSocketImpl || globalThis.WebSocket;
  const wsUrl = url || defaultUrl();

  let ws = null;
  let status = 'offline';
  let ping = 0;
  let room = null;
  let mySlot = null;
  const outbox = [];                // messages queued while connecting
  const roomFns = new Set();
  const statusFns = new Set();
  const errorFns = new Set();
  let pingTimer = null;

  // ---- snapshot buffer / clock
  const buf = [];                   // decoded snapshots of the current match, ascending t (seconds in ._t)
  let curM = -1;
  const offsets = new Float64Array(OFFSET_WINDOW); // snapshot sim time - local arrival time
  const sorted = new Float64Array(OFFSET_WINDOW);
  let offCount = 0, offIdx = 0;
  let offset = null;                // estimated (server sim time - local time) for the least-delayed path
  let delay = NET.interpDelay;      // current jitter-buffer delay
  let renderT = null;               // render clock (server sim time), unclamped
  let sampleT = 0;                  // what is actually displayed (clamped to the buffer, monotonic)
  let lastClock = null;
  const names = [null, null, null, null];

  // ---- events
  const evq = [];                   // { m, t, name, p }

  // ---- input
  const lastHeld = Object.create(null);
  const pendingEdges = [];
  let seq = 0;
  let lastSend = -Infinity;
  let leaving = false;              // toMenu() sent 'leave': stop rendering the match right away

  const state = createRemoteState();
  const lp = { winnerTeam: 0, reason: 'in' };
  const ballLanding = new Vector3();
  const aims = state.players.map(() => new Vector3());

  // ------------------------------------------------------------ status / transport
  function setStatus(s, message, code) {
    status = s;
    const info = { status: s, ping: Math.round(ping), message, code };
    for (const fn of [...statusFns]) { try { fn(info); } catch (err) { console.error('[net] onStatus handler threw', err); } }
  }
  function setRoom(r) {
    leaving = false;
    if (!r || !room || r.code !== room.code) {
      // Different room (or none): its match serials start over.
      flushEvents(() => true);
      curM = -1;
      resetClock();
    }
    room = r;
    const slot = r && Array.isArray(r.slots) ? r.slots.indexOf(r.you) : -1;
    const prevSlot = mySlot;
    mySlot = slot >= 0 ? slot : null;
    if (mySlot !== prevSlot) releaseAllHeld();
    if (!r || r.phase !== 'playing') endMatchView();
    for (const fn of [...roomFns]) { try { fn(r); } catch (err) { console.error('[net] onRoom handler threw', err); } }
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    if (ws && ws.readyState === 0 && outbox.length < 16 && obj.t !== 'input' && obj.t !== 'ping') outbox.push(obj);
    return false;
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    if (!WS) { setStatus('error', 'WebSocket is not available'); return; }
    setStatus('connecting');
    let sock;
    try { sock = new WS(wsUrl); } catch (err) { setStatus('error', String(err && err.message || err)); setStatus('offline'); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      setStatus('online');
      while (outbox.length) send(outbox.shift());
      sendPing();
      clearInterval(pingTimer);
      pingTimer = setInterval(sendPing, PING_EVERY * 1000);
      if (pingTimer && typeof pingTimer.unref === 'function') pingTimer.unref(); // Node (tests): don't hold the process
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      receive(msg);
    };
    sock.onerror = () => { if (ws === sock) setStatus('error', 'connection error'); };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(pingTimer);
      pingTimer = null;
      outbox.length = 0;
      if (room) setRoom(null); else endMatchView();
      setStatus('offline');
    };
  }
  function disconnect() {
    const sock = ws;
    if (!sock) return;
    try { sock.close(); } catch { /* ignore */ }
    // Browsers fire onclose asynchronously; reflect the state right away.
    ws = null;
    clearInterval(pingTimer);
    pingTimer = null;
    if (room) setRoom(null); else endMatchView();
    setStatus('offline');
  }
  function sendPing() { send({ t: 'ping', c: Math.round(clock() * 1000) }); }

  // ------------------------------------------------------------ incoming
  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'snap': if (isSnapshot(msg.s)) onSnapshot(msg.s); break;
      case 'ev': onEvent(msg); break;
      case 'room': setRoom(msg.room && typeof msg.room === 'object' ? msg.room : null); break;
      case 'pong': {
        if (!Number.isFinite(msg.c)) break;
        const t = clock();
        const rtt = Math.max(0, t - msg.c / 1000);
        ping = ping ? ping * 0.7 + rtt * 1000 * 0.3 : rtt * 1000;
        // Seed the clock from the pong before any snapshot of this match arrived.
        if (offset === null && Number.isFinite(msg.st) && msg.m === curM) offset = msg.st + rtt / 2 - t;
        if (status === 'online' || status === 'error') setStatus('online');
        break;
      }
      case 'error': {
        const info = { code: String(msg.code || 'error'), msg: String(msg.msg || '') };
        for (const fn of [...errorFns]) { try { fn(info); } catch (err) { console.error('[net] onError handler threw', err); } }
        setStatus('error', info.msg, info.code);
        break;
      }
      default: break;
    }
  }

  function resetClock() {
    buf.length = 0;
    offCount = 0; offIdx = 0;
    offset = null;
    renderT = null;
    sampleT = 0;
    delay = NET.interpDelay;
  }

  function onSnapshot(s) {
    if (s.m !== curM) {
      if (s.m < curM && curM >= 0) return; // late snapshot from a previous match
      flushEvents((e) => e.m < s.m);
      curM = s.m;
      resetClock();
    }
    s._t = s.t / 1000;
    if (buf.length && s._t <= buf[buf.length - 1]._t) return; // duplicate / out of order
    if (s.n) for (let i = 0; i < 4; i++) names[i] = typeof s.n[i] === 'string' ? s.n[i] : null;
    buf.push(s);
    if (buf.length > BUFFER_MAX) buf.splice(0, buf.length - BUFFER_MAX);

    // Clock / jitter estimate: offsets of the least-delayed snapshots approximate the true offset;
    // their spread is the jitter the buffer must absorb.
    const o = s._t - clock();
    offsets[offIdx] = o;
    offIdx = (offIdx + 1) % OFFSET_WINDOW;
    if (offCount < OFFSET_WINDOW) offCount++;
    let max = -Infinity;
    for (let i = 0; i < offCount; i++) { sorted[i] = offsets[i]; if (offsets[i] > max) max = offsets[i]; }
    const view = sorted.subarray(0, offCount).sort();
    const p10 = view[Math.floor((offCount - 1) * 0.1)];
    const jitter = Math.max(0, max - p10);
    const target = Math.min(MAX_DELAY, Math.max(NET.interpDelay, SNAP_PERIOD * 1.25 + jitter));
    delay += (target - delay) * (target > delay ? 0.2 : 0.02); // grow quickly, shrink slowly
    if (offset === null) offset = max;
    else offset += (max - offset) * 0.1;
  }

  function onEvent(msg) {
    if (typeof msg.name !== 'string' || !Number.isFinite(msg.st) || !Number.isFinite(msg.m)) return;
    const p = msg.p && typeof msg.p === 'object' ? msg.p : {};
    if (Array.isArray(msg.v)) {
      for (const k of msg.v) {
        const a = p[k];
        if (Array.isArray(a) && a.length === 3) p[k] = new Vector3(+a[0] || 0, +a[1] || 0, +a[2] || 0);
      }
    }
    evq.push({ m: msg.m, t: msg.st / 1000, name: msg.name, p });
    if (evq.length > 512) evq.splice(0, evq.length - 512);
  }

  function emitEvent(e) { bus.emit(e.name, e.p); }
  /** Emit (in order) queued events matching pred, keep the rest. Returns true if a 'menu' went out. */
  function flushEvents(pred) {
    let w = 0;
    let menu = false;
    for (let i = 0; i < evq.length; i++) {
      const e = evq[i];
      if (pred(e)) { emitEvent(e); if (e.name === 'menu') menu = true; } else evq[w++] = e;
    }
    evq.length = w;
    return menu;
  }
  function releaseEvents(t) {
    let n = 0;
    while (n < evq.length) {
      const e = evq[n];
      if (e.m > curM || (e.m === curM && e.t > t)) break;
      n++;
      if (e.m === curM && e.t < t - STALE_EVENT && !KEEP_EVENTS.has(e.name)) continue;
      emitEvent(e);
    }
    if (n) evq.splice(0, n);
  }

  /** Room left / back in the lobby / disconnected: show the menu state, deliver pending events. */
  function endMatchView() {
    const wasInMatch = state.phase !== 'menu';
    const menuSent = flushEvents(() => true);
    resetClock();
    state.phase = 'menu';
    if (state.paused) { state.paused = false; bus.emit('resume', {}); }
    releaseAllHeld();
    // Left / disconnected mid-match: the server won't say 'menu', so the page hears it from us.
    if (wasInMatch && !menuSent) bus.emit('menu', {});
  }

  // ------------------------------------------------------------ interpolation
  function writeState(T) {
    const n = buf.length;
    let a = buf[0], b = buf[0];
    if (T >= buf[n - 1]._t) { a = b = buf[n - 1]; }
    else {
      for (let i = n - 1; i >= 0; i--) {
        if (buf[i]._t <= T) { a = buf[i]; b = buf[i + 1]; break; }
      }
    }
    const span = b._t - a._t;
    const k = span > 1e-6 ? Math.min(1, Math.max(0, (T - a._t) / span)) : 0;
    const dtA = Math.max(0, T - a._t);

    state.time = T;
    const g = a.g;
    state.phase = decEnum(PHASES, g[0]);
    state.difficulty = decEnum(DIFFS, g[1]);
    state.score[0] = g[2]; state.score[1] = g[3];
    state.servingTeam = g[4] < 0 ? 0 : g[4];
    state.serverId = g[5] < 0 ? 0 : g[5];
    state.touches = g[6] < 0 ? 0 : g[6];
    state.possessionTeam = g[7] < 0 ? null : g[7];
    if (g[8] >= 0) { lp.winnerTeam = g[8]; lp.reason = decEnum(REASONS, g[9]); state.lastPoint = lp; } else state.lastPoint = null;

    // Ball
    const ba = a.b, bb = b.b, ball = state.ball;
    // Teleport (serve setup, reset): don't sweep through the court.
    const ex = ba[0] + ba[3] * 10 * span, ey = ba[1] + ba[4] * 10 * span, ez = ba[2] + ba[5] * 10 * span;
    const jump = Math.hypot(bb[0] - ex, bb[1] - ey, bb[2] - ez) > 1500;
    const kb = jump ? 0 : k;
    ball.pos.set(lerp(ba[0], bb[0], kb) / 1000, lerp(ba[1], bb[1], kb) / 1000, lerp(ba[2], bb[2], kb) / 1000);
    ball.vel.set(lerp(ba[3], bb[3], kb) / 100, lerp(ba[4], bb[4], kb) / 100, lerp(ba[5], bb[5], kb) / 100);
    ball.spin.set(lerp(ba[6], bb[6], kb) / 100, lerp(ba[7], bb[7], kb) / 100, lerp(ba[8], bb[8], kb) / 100);
    ball.visible = !!(ba[9] & 1);
    ball.held = !!(ba[9] & 2);
    ball.lastTeam = ba[10] < 0 ? null : ba[10];
    if (ba.length >= 14) {
      if (bb.length >= 14 && !jump) ballLanding.set(lerp(ba[11], bb[11], k) / 1000, lerp(ba[12], bb[12], k) / 1000, lerp(ba[13], bb[13], k) / 1000);
      else ballLanding.set(ba[11] / 1000, ba[12] / 1000, ba[13] / 1000);
      ball.landing = ballLanding;
    } else ball.landing = null;

    // Players
    for (let i = 0; i < 4; i++) {
      const pa = a.p[i], pb = b.p[i], pl = state.players[i];
      const d = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
      const kp = d > 2000 ? 0 : k; // > 2 m in one snapshot = repositioned
      pl.pos.set(lerp(pa[0], pb[0], kp) / 1000, lerp(pa[1], pb[1], kp) / 1000, lerp(pa[2], pb[2], kp) / 1000);
      pl.vel.set(lerp(pa[3], pb[3], kp) / 100, lerp(pa[4], pb[4], kp) / 100, lerp(pa[5], pb[5], kp) / 100);
      pl.facing = kp ? lerpAngle(pa[6] / 1000, pb[6] / 1000, kp) : pa[6] / 1000;
      pl.grounded = !!(pa[7] & 1);
      pl.human = !!(pa[7] & 2);
      pl.name = pl.human ? names[i] : null;
      pl.action = decEnum(ACTIONS_ENUM, pa[8]);
      pl.actionTime = (pb[8] === pa[8] && pb[9] >= pa[9]) ? lerp(pa[9], pb[9], k) / 1000 : pa[9] / 1000 + dtA;
      const ma = pa[10], mb = pb[10], m = pl.meters;
      if (ma && ma.length >= 7) {
        const mbOk = mb && mb.length >= 7;
        const q = mbOk ? k : 0;
        const mbb = mbOk ? mb : ma;
        m.pass = meterAt(ma[0], mbb[0], q);
        m.spike = meterAt(ma[1], mbb[1], q);
        m.hitCharge = meterAt(ma[2], mbb[2], q);
        m.serveCharge = meterAt(ma[3], mbb[3], q);
        m.serveRisk = meterAt(ma[4], mbb[4], q);
        m.passWindow = lerp(ma[5], mbb[5], q) / 1000;
        m.hitWindow = lerp(ma[6], mbb[6], q) / 1000;
        if (ma.length >= 10) {
          const v = aims[i];
          if (mbb.length >= 10) v.set(lerp(ma[7], mbb[7], q) / 1000, lerp(ma[8], mbb[8], q) / 1000, lerp(ma[9], mbb[9], q) / 1000);
          else v.set(ma[7] / 1000, ma[8] / 1000, ma[9] / 1000);
          m.aimTarget = v;
        } else m.aimTarget = null;
      } else {
        m.pass = m.spike = m.hitCharge = m.serveCharge = m.serveRisk = m.aimTarget = null;
        m.passWindow = 0; m.hitWindow = 0;
      }
      pl.windup = m.hitCharge;
    }
  }

  /** controlledId / controlled / top-level meter mirrors for this screen's slot. */
  function writeMirrors() {
    const slot = mySlot;
    state.controlledId = slot === null ? 0 : slot;
    for (let i = 0; i < 4; i++) state.players[i].controlled = i === slot;
    const m = slot === null ? null : state.players[slot].meters;
    state.passMeter = m ? m.pass : null;
    state.spikeMeter = m ? m.spike : null;
    state.hitCharge = m ? m.hitCharge : null;
    state.serveCharge = m ? m.serveCharge : null;
    state.serveRisk = m ? m.serveRisk : null;
    state.aimTarget = m ? m.aimTarget : null;
    state.passWindow = m ? m.passWindow : 0;
    state.hitWindow = m ? m.hitWindow : 0;
  }

  function advanceClock() {
    const t = clock();
    const elapsed = lastClock === null ? 0 : Math.min(1, Math.max(0, t - lastClock));
    lastClock = t;
    if (!buf.length || offset === null) return false;
    const target = t + offset - delay;
    if (renderT === null || Math.abs(target - renderT) > SNAP_CLOCK_ERR) renderT = target;
    else {
      // Gentle adaptation: play up to ±8 % fast/slow until the clock is back on target.
      const rate = Math.min(1.08, Math.max(0.92, 1 + (target - renderT)));
      renderT += elapsed * rate;
    }
    let T = renderT;
    const newest = buf[buf.length - 1]._t;
    if (T > newest) T = newest;           // starved: hold the newest picture, never extrapolate
    if (T < buf[0]._t) T = buf[0]._t;
    if (T < sampleT) T = sampleT;         // never show time running backwards within a match
    sampleT = T;
    // Drop snapshots that can no longer be needed (keep one before T).
    while (buf.length > 1 && buf[1]._t <= T) buf.shift();
    return true;
  }

  // ------------------------------------------------------------ input
  function releaseAllHeld() {
    for (const a of SEND_ACTIONS) {
      if (lastHeld[a]) { lastHeld[a] = false; pendingEdges.push([a, 'up', state.time]); }
    }
  }
  const inMatch = () => !!room && room.phase === 'playing' && !leaving && state.phase !== 'menu';

  function collectInput() {
    const vt = state.time; // the frame the player was looking at when these edges happened
    if (!input || typeof input.poll !== 'function') return;
    input.poll();
    if (input.pressed('pause') && inMatch() && state.phase !== 'matchOver') {
      if (state.paused) adapter.resume(); else adapter.pause();
    }
    if (state.paused || mySlot === null) { releaseAllHeld(); return; }
    for (const a of SEND_ACTIONS) {
      const h = !!input.held(a);
      const p = !!input.pressed(a);
      const r = !!input.released(a);
      const was = !!lastHeld[a];
      if (h) {
        if (was && (p || r)) { pendingEdges.push([a, 'up', vt], [a, 'down', vt]); } // released and re-pressed
        else if (!was) pendingEdges.push([a, 'down', vt]);
      } else if (was) pendingEdges.push([a, 'up', vt]);
      else if (p) pendingEdges.push([a, 'down', vt], [a, 'up', vt]); // tap shorter than a frame
      lastHeld[a] = h;
    }
  }

  function flushInput() {
    if (mySlot === null || !inMatch() || !ws || ws.readyState !== 1) { pendingEdges.length = 0; return; }
    const t = clock();
    if (t - lastSend < INPUT_PERIOD - 0.002) return;
    lastSend = t;
    const held = [];
    for (const a of SEND_ACTIONS) if (lastHeld[a]) held.push(a);
    let x = 0, y = 0;
    if (!state.paused && input && typeof input.axis === 'function') {
      const ax = input.axis();
      x = Number.isFinite(ax.x) ? Math.round(ax.x * 1000) / 1000 : 0;
      y = Number.isFinite(ax.y) ? Math.round(ax.y * 1000) / 1000 : 0;
    }
    const edges = pendingEdges.length > 32 ? pendingEdges.splice(0, 32) : pendingEdges.splice(0);
    for (const e of edges) e[2] = Math.round(e[2] * 10000) / 10000;
    send({ t: 'input', seq: seq++, axis: { x, y }, held, edges });
  }

  // ------------------------------------------------------------ remote game adapter
  const adapter = {
    state,
    update(dt) { // eslint-disable-line no-unused-vars
      collectInput();
      flushInput();
      if (room && room.phase === 'playing' && !leaving && advanceClock()) {
        writeState(sampleT);
        releaseEvents(sampleT);
      } else if (!room) {
        lastClock = clock();
      }
      writeMirrors();
    },
    startMatch({ difficulty } = {}) { api.start(difficulty || state.difficulty); },
    /** Online the match never pauses: only this screen's overlay opens (inputs go neutral). */
    pause() {
      if (state.paused || state.phase === 'menu') return;
      state.paused = true;
      releaseAllHeld();
      bus.emit('pause', {});
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      bus.emit('resume', {});
    },
    /** Quit to menu = leave the room. */
    toMenu() {
      api.leave();
      if (room) leaving = true;
      endMatchView();
    },
  };

  const api = {
    game: adapter,
    connect,
    disconnect,
    create(name) { connect(); send({ t: 'create', name: String(name ?? '') }); },
    join(code, name) { connect(); send({ t: 'join', code: String(code ?? '').trim().toUpperCase(), name: String(name ?? '') }); },
    takeSlot(slot) { send({ t: 'slot', slot: slot === null || slot === undefined ? null : slot | 0 }); },
    start(difficulty) { send({ t: 'start', difficulty: DIFFS.includes(difficulty) ? difficulty : 'normal' }); },
    toLobby() { send({ t: 'toLobby' }); },
    leave() { if (!send({ t: 'leave' })) { outbox.length = 0; if (room) setRoom(null); } },
    onRoom(fn) { roomFns.add(fn); return () => roomFns.delete(fn); },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    onError(fn) { errorFns.add(fn); return () => errorFns.delete(fn); },
    get room() { return room; },
    get status() { return status; },
    get ping() { return Math.round(ping); },
    get mySlot() { return mySlot; },
    /** Test / QA hooks (not part of the contract). */
    debug: {
      receive,
      get delay() { return delay; },
      get renderTime() { return sampleT; },
      get buffered() { return buf.length; },
      get pendingEvents() { return evq.length; },
    },
  };
  return api;
}
