// Browser net client / remote game adapter, run in Node: synthetic snapshots through a fake socket,
// plus one end-to-end run against the real server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { NET } from '../src/config.js';
import { createEventBus } from '../src/core/events.js';
import { createVirtualInput } from '../src/game/input.js';
import { createNetClient } from '../src/net/client.js';
import { encodeSnapshot } from '../src/net/snapshot.js';
import { startServer } from '../server/index.js';

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  serverClose() { this.readyState = 3; this.onclose && this.onclose(); }
  deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
}

/** A minimal fake game state shaped like src/game's, driven by a formula of sim time. */
function fakeState(t) {
  const v = (x, y, z) => new Vector3(x, y, z);
  return {
    phase: 'rally', difficulty: 'hard', time: t, score: [3, 5], servingTeam: 1, serverId: 2,
    touches: 1, possessionTeam: 0, controlledId: 0, lastPoint: { winnerTeam: 1, reason: 'out' },
    ball: { pos: v(5 * t, 2 + Math.sin(t), -1), vel: v(5, Math.cos(t), 0), spin: v(0, 10, 0), visible: true, landing: v(3, 0, -2), held: false, lastTeam: 0 },
    players: [0, 1, 2, 3].map((id) => ({
      id, team: id < 2 ? 0 : 1, index: id % 2,
      pos: v(id - 1.5 + t * 0.5, 0, id < 2 ? 4 : -4), vel: v(0.5, 0, 0), facing: id < 2 ? Math.PI : 0,
      grounded: true, action: id === 2 ? 'bump' : null, actionTime: id === 2 ? t % 1 : 0,
      meters: id === 2
        ? { pass: Math.min(1, (t % 2) / 2), spike: null, hitCharge: 0.25, serveCharge: null, serveRisk: null, aimTarget: v(1, 0, 5) }
        : { pass: null, spike: null, hitCharge: null, serveCharge: null, serveRisk: null, aimTarget: null },
    })),
  };
}

const ROOM = {
  code: 'ABCD', you: 'c2', owner: 'c1',
  clients: [{ id: 'c1', name: 'Ann', slot: 0, ping: 30 }, { id: 'c2', name: 'Bob', slot: 2, ping: 40 }],
  slots: ['c1', null, 'c2', null], phase: 'playing', difficulty: 'hard',
};

function setup() {
  let now = 100; // local clock (s); the server's sim clock starts at 0
  const events = createEventBus();
  const input = createVirtualInput();
  const net = createNetClient({ events, input, url: 'ws://test/ws', WebSocketImpl: FakeWS, now: () => now });
  const rooms = [];
  const statuses = [];
  net.onRoom((r) => rooms.push(r));
  net.onStatus((s) => statuses.push(s));
  net.connect();
  const sock = FakeWS.last;
  sock.open();
  sock.deliver({ t: 'room', room: ROOM });
  return { net, sock, events, input, rooms, statuses, clock: { get: () => now, set: (t) => { now = t; } } };
}

/**
 * Run the client for `secs` at 60 fps while the "server" produces snapshots at NET.snapshotHz
 * delivered with latency + jitter (in order, as TCP does). Returns per-frame samples.
 */
function run(ctx, { secs, startSim = 0, latency = 0.06, jitter = 0.03, m = 1, onFrame, extra = [] }) {
  const { net, sock, clock } = ctx;
  const t0 = clock.get();
  const queue = [];
  let lastArrival = 0;
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; ; k++) {
    const st = startSim + k / NET.snapshotHz;
    if (st > startSim + secs + 0.5) break;
    const arrive = Math.max(lastArrival, t0 + (st - startSim) + latency + rand() * jitter);
    lastArrival = arrive;
    const s = JSON.parse(JSON.stringify(encodeSnapshot(fakeState(st), { m, humans: [true, false, true, false], names: k % 30 === 0 ? ['Ann', null, 'Bob', null] : null })));
    queue.push({ at: arrive, msg: { t: 'snap', s } });
  }
  for (const e of extra) queue.push(e);
  queue.sort((a, b) => a.at - b.at);
  const samples = [];
  const frames = Math.round(secs * 60);
  for (let f = 0; f < frames; f++) {
    clock.set(t0 + (f + 1) / 60);
    while (queue.length && queue[0].at <= clock.get()) sock.deliver(queue.shift().msg);
    if (onFrame) onFrame(f);
    net.game.update(1 / 60);
    const s = net.game.state;
    samples.push({ time: s.time, bx: s.ball.pos.x, by: s.ball.pos.y, p2x: s.players[2].pos.x, ballRef: s.ball.pos, aimRef: s.players[2].meters.aimTarget, delay: net.debug.delay });
  }
  return samples;
}

describe('net client adapter', () => {
  test('interpolates snapshots smoothly ~interpDelay behind, reusing vectors, with local-slot mirrors', () => {
    const ctx = setup();
    const { net } = ctx;
    assert.equal(net.mySlot, 2);
    const samples = run(ctx, { secs: 4 });
    const s = net.game.state;
    const warm = samples.slice(60);
    // interpolation is exact for linear motion: ball.x = 5 * time
    for (const x of warm) assert.ok(Math.abs(x.bx - 5 * x.time) < 2e-3, `ball.x ${x.bx} vs ${5 * x.time}`);
    // smooth, monotonic clock: per-frame advance close to the frame time
    let worst = 0;
    for (let i = 1; i < warm.length; i++) {
      const d = warm[i].time - warm[i - 1].time;
      assert.ok(d >= 0, 'time never runs backwards');
      worst = Math.max(worst, Math.abs(d - 1 / 60));
    }
    assert.ok(worst < 0.25 / 60, `frame-to-frame time step deviates at most ${(worst * 60 * 100).toFixed(1)}% of a frame`);
    // rendered ~interpDelay (+ jitter allowance) behind the newest snapshot
    const serverNow = ctx.clock.get() - 100;
    const behind = serverNow - s.time;
    assert.ok(behind > NET.interpDelay && behind < NET.interpDelay + 0.06 + 0.12, `render lag ${behind.toFixed(3)} s`);
    assert.ok(net.debug.delay >= NET.interpDelay && net.debug.delay <= 0.35);
    // vectors reused
    assert.ok(warm.every((x) => x.ballRef === s.ball.pos));
    assert.ok(warm.every((x) => x.aimRef === warm[0].aimRef) && warm[0].aimRef instanceof Vector3);
    // discrete fields and mirrors
    assert.equal(s.phase, 'rally');
    assert.equal(s.difficulty, 'hard');
    assert.deepEqual(s.score, [3, 5]);
    assert.deepEqual(s.lastPoint, { winnerTeam: 1, reason: 'out' });
    assert.equal(s.controlledId, 2);
    assert.deepEqual(s.players.map((p) => p.controlled), [false, false, true, false]);
    assert.deepEqual(s.players.map((p) => p.human), [true, false, true, false]);
    assert.deepEqual(s.players.map((p) => p.name), ['Ann', null, 'Bob', null]);
    assert.equal(s.passMeter, s.players[2].meters.pass);
    assert.ok(Math.abs(s.passMeter - Math.min(1, (s.time % 2) / 2)) < 0.02);
    assert.equal(s.hitCharge, 0.25);
    assert.equal(s.players[2].windup, 0.25);
    assert.equal(s.aimTarget, s.players[2].meters.aimTarget);
    assert.equal(s.spikeMeter, null);
    assert.equal(s.players[2].action, 'bump');
    assert.ok(s.ball.landing instanceof Vector3 && Math.abs(s.ball.landing.x - 3) < 1e-9);
    assert.equal(s.players[0].meters.pass, null);
  });

  test('events are re-emitted when their sim time is rendered, Vector3s restored', () => {
    const ctx = setup();
    const got = [];
    ctx.events.on('hit', (p) => got.push({ p, at: ctx.net.game.state.time }));
    // the event arrives immediately (t=1.0 server) but must be emitted when render time reaches 1.5
    run(ctx, {
      secs: 3,
      extra: [{ at: 101.0, msg: { t: 'ev', name: 'hit', m: 1, st: 1500, p: { playerId: 2, type: 'bump', position: [1, 2, 3], power: 0.5, touches: 1 }, v: ['position'] } }],
    });
    assert.equal(got.length, 1);
    assert.ok(got[0].at >= 1.5 && got[0].at < 1.5 + 1 / 30, `emitted at render time ${got[0].at}`);
    assert.ok(got[0].p.position instanceof Vector3);
    assert.deepEqual(got[0].p.position.toArray(), [1, 2, 3]);
  });

  test('input edges carry viewTime = the rendered state.time; ≤ 60 msgs/s; pause keeps play going', () => {
    const ctx = setup();
    const { net, sock, input } = ctx;
    let pressedAt = null;
    run(ctx, {
      secs: 2,
      onFrame(f) {
        if (f === 90) { input.set('pass', true); pressedAt = net.game.state.time; }
        if (f === 95) input.set('pass', false);
        if (f === 100) input.set('hit', true);
      },
    });
    const inputs = sock.sent.filter((m) => m.t === 'input');
    assert.ok(inputs.length >= 100 && inputs.length <= 121, `${inputs.length} input msgs in 2 s`);
    const edges = inputs.flatMap((m) => m.edges);
    const down = edges.find((e) => e[0] === 'pass' && e[1] === 'down');
    assert.ok(down, 'pass down edge sent');
    assert.ok(Math.abs(down[2] - pressedAt) < 1e-3, `viewTime ${down[2]} == rendered time ${pressedAt}`);
    assert.ok(edges.some((e) => e[0] === 'pass' && e[1] === 'up'));
    assert.ok(inputs.at(-1).held.includes('hit'));
    for (let i = 1; i < inputs.length; i++) assert.ok(inputs[i].seq > inputs[i - 1].seq);

    // pause: overlay only (state.paused), inputs go neutral, snapshots keep rendering
    const paused = [];
    ctx.events.on('pause', () => paused.push(1));
    const tBefore = net.game.state.time;
    run(ctx, { secs: 1, startSim: 2.5, onFrame(f) { if (f === 1) input.set('pause', true); if (f === 2) input.set('pause', false); } });
    assert.equal(net.game.state.paused, true);
    assert.equal(paused.length, 1);
    assert.ok(net.game.state.time > tBefore + 0.5, 'match keeps running while the overlay is open');
    const last = sock.sent.filter((m) => m.t === 'input').at(-1);
    assert.deepEqual(last.held, []);
    assert.ok(sock.sent.some((m) => m.t === 'input' && m.edges.some((e) => e[0] === 'hit' && e[1] === 'up')), 'held keys released on pause');
    net.game.resume();
    assert.equal(net.game.state.paused, false);
  });

  test('match restart resets the clock; lobby / disconnect go back to menu', () => {
    const ctx = setup();
    const { net, sock } = ctx;
    run(ctx, { secs: 2, startSim: 30 });
    assert.ok(net.game.state.time > 30);
    const menus = [];
    ctx.events.on('menu', () => menus.push(1));
    run(ctx, { secs: 1.5, startSim: 0, m: 2 });
    assert.ok(net.game.state.time < 1.5, `new match renders from its own clock (${net.game.state.time})`);
    // back to lobby: pending events flushed, phase menu
    sock.deliver({ t: 'ev', name: 'menu', m: 2, st: 99999, p: {} });
    sock.deliver({ t: 'room', room: { ...ROOM, phase: 'lobby' } });
    net.game.update(1 / 60);
    assert.equal(net.game.state.phase, 'menu');
    assert.equal(menus.length, 1);
    // disconnect
    sock.serverClose();
    assert.equal(ctx.rooms.at(-1), null);
    assert.equal(ctx.statuses.at(-1).status, 'offline');
    assert.equal(net.room, null);
  });

  test('toMenu() mid-match leaves the room and emits one menu; disconnect mid-match also says menu', () => {
    const ctx = setup();
    const menus = [];
    ctx.events.on('menu', () => menus.push(1));
    run(ctx, { secs: 1 });
    assert.equal(ctx.net.game.state.phase, 'rally');
    ctx.net.game.toMenu();
    assert.equal(ctx.net.game.state.phase, 'menu');
    assert.ok(ctx.sock.sent.some((m) => m.t === 'leave'));
    run(ctx, { secs: 0.3, startSim: 1 }); // late snapshots before the server processed 'leave'
    assert.equal(ctx.net.game.state.phase, 'menu', 'stays in the menu');
    ctx.sock.deliver({ t: 'room', room: null });
    assert.equal(menus.length, 1);

    const ctx2 = setup();
    const menus2 = [];
    ctx2.events.on('menu', () => menus2.push(1));
    run(ctx2, { secs: 1 });
    ctx2.sock.serverClose();
    assert.equal(ctx2.net.game.state.phase, 'menu');
    assert.equal(menus2.length, 1);
  });

  test('server errors reach onStatus / onError', () => {
    const ctx = setup();
    const errs = [];
    ctx.net.onError((e) => errs.push(e));
    ctx.sock.deliver({ t: 'error', code: 'noRoom', msg: 'no room with that code' });
    assert.deepEqual(errs, [{ code: 'noRoom', msg: 'no room with that code' }]);
    assert.equal(ctx.statuses.at(-1).status, 'error');
    assert.equal(ctx.statuses.at(-1).code, 'noRoom');
  });
});

describe('net client end-to-end', () => {
  test('two clients against the real server: room, snapshots into net.game.state, events on the bus', { timeout: 20000 }, async () => {
    const srv = await startServer({ port: 0 });
    const url = `ws://127.0.0.1:${srv.port}${NET.wsPath}`;
    const mk = () => {
      const events = createEventBus();
      const input = createVirtualInput();
      const net = createNetClient({ events, input, url });
      const seen = [];
      for (const n of ['matchStart', 'serveReady', 'hit', 'menu']) events.on(n, () => seen.push(n));
      return { net, input, seen };
    };
    const A = mk();
    const B = mk();
    try {
      const roomA = new Promise((r) => A.net.onRoom((room) => room && r(room)));
      A.net.create('Alice');
      const ra = await roomA;
      assert.equal(ra.slots[0], ra.you);
      const roomB = new Promise((r) => B.net.onRoom((room) => room && room.slots.includes(room.you) && r(room)));
      B.net.join(ra.code, 'Bob');
      await roomB;
      assert.equal(B.net.mySlot, 1);
      A.net.start('easy');
      const t0 = Date.now();
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          A.net.game.update(1 / 60);
          B.net.game.update(1 / 60);
          if (Date.now() - t0 > 2500) { clearInterval(iv); resolve(); }
        }, 1000 / 60);
      });
      const s = B.net.game.state;
      assert.notEqual(s.phase, 'menu');
      assert.ok(s.time > 1.5 && s.time < 2.6, `rendered sim time ${s.time}`);
      assert.equal(s.controlledId, 1);
      assert.ok(s.players[1].controlled && s.players[1].human && s.players[1].name === 'Bob');
      assert.ok(B.seen.includes('matchStart') && B.seen.includes('serveReady'), B.seen.join());
      assert.ok(B.net.ping >= 0);
      A.net.toLobby();
      await new Promise((r) => setTimeout(r, 200));
      B.net.game.update(1 / 60);
      assert.equal(B.net.game.state.phase, 'menu');
      assert.ok(B.seen.includes('menu'));
    } finally {
      A.net.disconnect();
      B.net.disconnect();
      await srv.close();
    }
  });
});
