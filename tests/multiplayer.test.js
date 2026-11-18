// Multi-human simulation (online server runs this code): any slot can be human, per-player meters,
// team-1 humans play mirrored, setInputs between/within points, no pause online, lag compensation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../src/core/events.js';
import { DIFFICULTY, NET, RULES } from '../src/config.js';
import { CPU_MODS, createGame } from '../src/game/game.js';
import { createVirtualInput } from '../src/game/input.js';
import { createLaggedInput, runMultiMatch } from './helpers/harness.js';

/** Every number reachable from game.state is finite (meters may be null). */
function assertNoNaN(s, label) {
  const bad = [];
  const scan = (v, path, depth) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(path); return; }
    if (!v || typeof v !== 'object' || depth > 4) return;
    for (const k of Object.keys(v)) scan(v[k], `${path}.${k}`, depth + 1);
  };
  scan(s, 'state', 0);
  assert.deepEqual(bad, [], `${label}: non-finite ${bad.join(', ')}`);
}

/** Full-match invariants shared by every slot layout. */
function checkMatch(label, game, log) {
  const s = game.state;
  assert.equal(s.phase, 'matchOver', `${label}: match finishes`);
  const [a, b] = s.score;
  assert.ok(Math.max(a, b) >= RULES.pointsToWin && Math.abs(a - b) >= RULES.winBy, `${label}: 15 win-by-2 (${a}-${b})`);
  assert.ok(!(Math.max(a, b) > RULES.pointsToWin && Math.abs(a - b) > RULES.winBy), `${label}: ended as soon as decided`);
  assert.equal(game.debug.stats.netViolations, 0, `${label}: ball never tunnels through the net`);
  let prev = [0, 0];
  for (const e of log) {
    if (e.name !== 'point') continue;
    const sc = e.p.score;
    assert.ok(sc[0] >= prev[0] && sc[1] >= prev[1] && sc[0] + sc[1] === prev[0] + prev[1] + 1, `${label}: score +1 per point`);
    prev = sc;
  }
  const rh = game.debug.stats.rallyHits;
  assert.ok(Math.max(...rh) >= 6, `${label}: long rallies happen (max ${Math.max(...rh)} hits)`);
}

function setup(inputs, opts = {}) {
  const events = createEventBus();
  const game = createGame({ events, inputs, seed: 7, ...opts });
  const log = [];
  for (const n of ['matchStart', 'serveReady', 'hit', 'point', 'pause', 'resume', 'passAttempt', 'swing']) {
    events.on(n, (p) => log.push({ name: n, p, t: game.state.time }));
  }
  const run = (sec, dt = 1 / 60) => { for (let t = 0; t < sec - 1e-9; t += dt) game.update(dt); };
  return { game, log, run };
}

test('4 humans: cue-following bots on every slot play a full match', () => {
  let nanChecks = 0;
  const { game, log } = runMultiMatch({
    humans: [0, 1, 2, 3], seed: 21,
    onStep(g) { if (++nanChecks % 7 === 0) assertNoNaN(g.state, '4 humans'); },
  });
  checkMatch('4 humans', game, log);
  assert.ok(game.state.players.every((p) => p.human), 'all four flagged human');
  for (let id = 0; id < 4; id++) {
    const graded = log.filter((e) => e.name === 'hit' && e.p.playerId === id && e.p.quality !== undefined);
    const passes = log.filter((e) => e.name === 'passAttempt' && e.p.playerId === id);
    assert.ok(graded.length >= 8, `player ${id} made graded touches (${graded.length})`);
    assert.ok(passes.length >= 5, `player ${id} pressed K (${passes.length})`);
    // Serve rotation reaches every human slot, and they serve with the J meter.
    assert.ok(log.some((e) => e.name === 'serveReady' && e.p.playerId === id && e.p.isHuman), `player ${id} serves`);
    assert.ok(log.some((e) => e.name === 'hit' && e.p.type === 'serve' && e.p.playerId === id && e.p.quality !== undefined),
      `player ${id} served with the J meter`);
  }
  const greenSpikes = log.filter((e) => e.name === 'swing' && (e.p.timing === 'perfect' || e.p.timing === 'good'));
  assert.ok(new Set(greenSpikes.map((e) => e.p.playerId)).size >= 3, 'humans on both teams land green spikes');
});

for (const [label, humans] of [['1 human on team 1 only', [2]], ['2 humans co-op', [0, 1]], ['1v1', [0, 2]], ['team-1 pair vs AI', [2, 3]]]) {
  test(`mixed slots: ${label}`, () => {
    let n = 0;
    const { game, log } = runMultiMatch({
      humans, seed: 5, difficulty: 'hard',
      onStep(g) { if (++n % 11 === 0) assertNoNaN(g.state, label); },
    });
    checkMatch(label, game, log);
    game.state.players.forEach((p) => assert.equal(p.human, humans.includes(p.id), `${label}: players[${p.id}].human`));
    for (const id of humans) {
      const graded = log.filter((e) => e.name === 'hit' && e.p.playerId === id && e.p.quality !== undefined);
      assert.ok(graded.length >= 5, `${label}: human ${id} plays graded touches (${graded.length})`);
    }
    for (let id = 0; id < 4; id++) {
      if (humans.includes(id)) continue;
      const aiHits = log.filter((e) => e.name === 'hit' && e.p.playerId === id && e.p.type !== 'serve');
      assert.ok(aiHits.length >= 5, `${label}: AI ${id} plays its touches (${aiHits.length})`);
      assert.ok(aiHits.every((e) => e.p.quality === undefined), `${label}: AI ${id} touches are not meter-graded`);
    }
  });
}

test('profiles: AI with a human teammate = partner profile; all-AI team = difficulty + CPU_MODS', () => {
  const vin = createVirtualInput();
  const { game } = setup([null, null, vin, null]);
  game.startMatch({ difficulty: 'hard' });
  const prof0 = game.debug.profileFor(0);
  const prof1 = game.debug.profileFor(1);
  assert.equal(prof0.reaction, DIFFICULTY.hard.reaction + CPU_MODS.hard.reactionAdd, 'all-AI team 0 is the hard opponent');
  assert.equal(prof0.spikePace, CPU_MODS.hard.spikePace);
  assert.equal(prof1.reaction, DIFFICULTY.normal.reaction, 'Bo partners the human Kiki at normal level');
  // Offline: the CPU is team 1, Pip partners Momo.
  const off = setup(undefined, { input: createVirtualInput() });
  off.game.startMatch({ difficulty: 'hard' });
  assert.equal(off.game.debug.profileFor(0).reaction, DIFFICULTY.normal.reaction);
  assert.equal(off.game.debug.profileFor(1).spikePace, CPU_MODS.hard.spikePace);
});

test('a team-1 human moves screen-relative from the -z side (up = toward the net, right = -x)', () => {
  const vin = createVirtualInput();
  const { game, run } = setup([null, null, vin, null]);
  game.startMatch({ difficulty: 'normal' });
  const kiki = game.state.players[2];
  assert.ok(kiki.human && kiki.team === 1);
  const z0 = kiki.pos.z;
  const x0 = kiki.pos.x;
  vin.set('up', true);
  run(0.4);
  vin.set('up', false);
  assert.ok(kiki.pos.z > z0 + 1, `up moves Kiki toward the net (+z): ${z0.toFixed(2)} -> ${kiki.pos.z.toFixed(2)}`);
  assert.ok(kiki.pos.z < 0, 'stays on her side');
  vin.set('right', true);
  run(0.4);
  vin.set('right', false);
  assert.ok(kiki.pos.x < x0 - 1, `right moves Kiki toward -x: ${x0.toFixed(2)} -> ${kiki.pos.x.toFixed(2)}`);
  // Team 0 for comparison: up = -z, right = +x.
  const v0 = createVirtualInput();
  const t0 = setup([v0, null, null, null]);
  t0.game.startMatch({ difficulty: 'normal' });
  const pip = t0.game.state.players[1];
  // Momo serves first; use the receiving-side check on Pip by making Pip human instead.
  t0.game.setInputs([null, v0, null, null]);
  const pz = pip.pos.z;
  const px = pip.pos.x;
  v0.set('up', true); v0.set('right', true);
  t0.run(0.4);
  assert.ok(pip.pos.z < pz - 1 && pip.pos.x > px + 1, 'team 0: up = -z, right = +x');
});

test('per-player meters are independent; top-level fields mirror players[controlledId]', () => {
  const a = createVirtualInput();
  const b = createVirtualInput();
  const { game, run } = setup([a, b, null, null]);
  game.startMatch({ difficulty: 'normal' });
  const [p0, p1] = game.state.players;
  // Momo serves: her serve meter only.
  run(0.5);
  a.set('hit', true);
  run(0.3);
  assert.ok(p0.meters.serveCharge > 0 && p1.meters.serveCharge === null, 'serve meter belongs to the server');
  assert.equal(game.state.serveCharge, p0.meters.serveCharge, 'mirror = controlled (0)');
  assert.ok(p0.meters.aimTarget && p1.meters.aimTarget === null);
  a.set('hit', false);
  run(0.7);
  assert.equal(game.state.phase, 'rally');
  // Both wind up J at different times: two live hitCharge meters at once.
  b.set('hit', true);
  run(0.1);
  a.set('hit', true);
  run(0.05);
  assert.ok(p0.meters.hitCharge > 0 && p1.meters.hitCharge > p0.meters.hitCharge, 'both wind-ups live and independent');
  assert.equal(game.state.hitCharge, p0.meters.hitCharge);
  game.state.controlledId = 1;
  run(1 / 60);
  assert.equal(game.state.hitCharge, p1.meters.hitCharge, 'mirror follows controlledId');
  assert.ok(p1.controlled && !p0.controlled);
  a.set('hit', false);
  b.set('hit', false);
  run(0.05);
  game.state.controlledId = 0;
  // Over a co-op match, each human's pass meter shows on its own (one at a time per ball).
  const only = [0, 0];
  const { game: g2 } = runMultiMatch({
    humans: [0, 1], seed: 9, maxSeconds: 120,
    onStep(g) {
      const [m0, m1] = [g.state.players[0].meters.pass, g.state.players[1].meters.pass];
      if (m0 !== null && m1 === null) only[0]++;
      if (m1 !== null && m0 === null) only[1]++;
      assert.equal(g.state.passMeter, m0, 'top-level passMeter mirrors player 0');
    },
  });
  assert.ok(g2.state.time > 0);
  assert.ok(only[0] > 30 && only[1] > 30, `each pass meter shows independently (${only})`);
});

test('a human server on team 1 auto-serves after RULES.serveTimeoutSec; serve rotation reaches human slots', () => {
  const idle = createVirtualInput(); // never presses anything
  const { game, log, run } = setup([null, null, idle, null]);
  game.startMatch({ difficulty: 'easy' });
  let t = 0;
  while (t < 600 && !log.some((e) => e.name === 'serveReady' && e.p.playerId === 2)) { run(0.5); t += 0.5; }
  const ready = log.find((e) => e.name === 'serveReady' && e.p.playerId === 2);
  assert.ok(ready, 'Kiki gets to serve');
  assert.equal(ready.p.isHuman, true);
  run(RULES.serveTimeoutSec + 0.8);
  const serve = log.find((e) => e.name === 'hit' && e.p.type === 'serve' && e.p.playerId === 2);
  assert.ok(serve, 'auto-serve happened');
  assert.ok(serve.t - ready.t > RULES.serveTimeoutSec - 0.1, 'not before the timeout');
  assert.equal(serve.p.quality, undefined, 'auto-serve is not meter-graded');
});

test('setInputs: slots switch between points and mid-rally; the serve restarts for a new owner', () => {
  const v0 = createVirtualInput();
  const v3 = createVirtualInput();
  const { game, log, run } = setup([v0, null, null, null]);
  game.startMatch({ difficulty: 'normal' });
  assert.equal(game.state.serverId, 0);
  // Momo's slot becomes AI before she serves: the AI serves instead.
  run(0.5);
  game.setInputs([null, null, null, v3]);
  assert.ok(!game.state.players[0].human && game.state.players[3].human);
  const lastReady = log.filter((e) => e.name === 'serveReady').at(-1);
  assert.deepEqual(lastReady.p, { team: 0, playerId: 0, isHuman: false }, 'serveReady re-emitted for the AI');
  run(2.5);
  assert.ok(log.some((e) => e.name === 'hit' && e.p.type === 'serve'), 'AI served');
  // Mid-rally: hand slot 0 back to a human, then everybody to AI.
  game.setInputs([v0, null, null, v3]);
  run(0.5);
  game.setInputs([null, null, null, null]);
  assert.ok(game.state.players.every((p) => !p.human && p.meters.pass === null && p.meters.hitCharge === null));
  let n = 0;
  for (let t = 0; t < 300 && game.state.phase !== 'matchOver'; t += 1 / 60) {
    game.update(1 / 60);
    if (++n % 13 === 0) assertNoNaN(game.state, 'after setInputs');
  }
  assert.ok(game.state.score[0] + game.state.score[1] >= 5, 'the all-AI game keeps playing');
});

test('allowPause: false ignores pause presses and pause(); default still pauses', () => {
  const vin = createVirtualInput();
  const { game, log, run } = setup([vin, null, null, null], { allowPause: false });
  game.startMatch({ difficulty: 'normal' });
  vin.set('pause', true);
  run(0.1);
  vin.set('pause', false);
  game.pause();
  run(0.1);
  assert.equal(game.state.paused, false);
  assert.ok(!log.some((e) => e.name === 'pause'));
  const t0 = game.state.time;
  run(0.5);
  assert.ok(game.state.time > t0 + 0.4, 'keeps simulating');
  const def = setup([createVirtualInput(), null, null, null]);
  def.game.startMatch({ difficulty: 'normal' });
  def.game.pause();
  assert.equal(def.game.state.paused, true);
});

/** Grade distributions of a scripted human on slot `id` over several matches. */
function gradeStats({ id, lagSec, lagComp = true, seeds }) {
  const pass = {};
  const spike = {};
  const serveQ = [];
  let retro = 0;
  let touches = 0;
  for (const seed of seeds) {
    let n = 0;
    const { game, log } = runMultiMatch({
      humans: [id], seed, lagSec, lagComp, maxSeconds: 900,
      onStep(g) { if (++n % 17 === 0) assertNoNaN(g.state, `lag ${lagSec}`); },
    });
    for (const e of log) {
      if (e.p?.playerId !== id) continue;
      if (e.name === 'passAttempt') pass[e.p.timing] = (pass[e.p.timing] || 0) + 1;
      if (e.name === 'swing' && e.p.timing !== 'none') spike[e.p.timing] = (spike[e.p.timing] || 0) + 1;
      if (e.name === 'hit' && e.p.type === 'serve' && e.p.quality !== undefined) serveQ.push(e.p.quality);
      if (e.name === 'hit' && e.p.type !== 'serve' && e.p.quality !== undefined) touches++;
    }
    retro += game.debug.stats.retroTouches;
  }
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const green = (o) => ((o.perfect || 0) + (o.good || 0)) / Math.max(1, total(o));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { pass, spike, passGreen: green(pass), spikeGreen: green(spike), serveQ: avg(serveQ), nServe: serveQ.length, retro, touches };
}

test('lag compensation: presses delivered 150 ms late (edgeTime = press time) grade like zero latency', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const id of [0, 2]) {
    const base = gradeStats({ id, lagSec: 0, seeds });
    const lag = gradeStats({ id, lagSec: 0.15, seeds });
    const raw = gradeStats({ id, lagSec: 0.15, lagComp: false, seeds: seeds.slice(0, 3) });
    const fmt = (r) => JSON.stringify({ pass: r.pass, spike: r.spike, passGreen: +r.passGreen.toFixed(3), spikeGreen: +r.spikeGreen.toFixed(3), serveQ: +r.serveQ.toFixed(3), touches: r.touches, retro: r.retro });
    console.log(`slot ${id} zero-latency: ${fmt(base)}`);
    console.log(`slot ${id} 150 ms + edgeTime: ${fmt(lag)}`);
    console.log(`slot ${id} 150 ms, no edgeTime: ${fmt(raw)}`);
    assert.ok(Math.abs(lag.passGreen - base.passGreen) <= 0.05, `slot ${id}: pass green ${lag.passGreen} vs ${base.passGreen}`);
    assert.ok(Math.abs(lag.spikeGreen - base.spikeGreen) <= 0.05, `slot ${id}: spike green ${lag.spikeGreen} vs ${base.spikeGreen}`);
    for (const k of ['tooEarly', 'tooLate']) {
      const f = (r) => (r.pass[k] || 0) / Math.max(1, Object.values(r.pass).reduce((a, b) => a + b, 0));
      assert.ok(Math.abs(f(lag) - f(base)) <= 0.05, `slot ${id}: ${k} share`);
    }
    assert.ok(lag.touches >= base.touches * 0.85, `slot ${id}: late presses still touch the ball (${lag.touches} vs ${base.touches})`);
    assert.ok(lag.retro > 0, 'some touches were applied retroactively');
    assert.ok(raw.passGreen < base.passGreen - 0.3, 'without edgeTime the same lag ruins the timing (the test measures something)');
  }
});

test('lag compensation: a green K press arriving after the contact passed still plays the ball (retroactive touch)', () => {
  // Hand-built remote input: the press reaches the server after the ball is down, stamped with
  // the moment the player saw the needle in green.
  const events = createEventBus();
  let pressAt = null;   // view time of the press (state.time)
  let deliverAt = null; // state.time when it reaches the server
  let pressed = false;
  const remote = {
    poll() {}, held: () => false, released: () => false, axis: () => ({ x: 0, y: 0 }), dispose() {},
    pressed: (a) => {
      if (a !== 'pass' || pressed || deliverAt === null || game.state.time < deliverAt) return false;
      pressed = true;
      return true;
    },
    edgeTime: (a) => (a === 'pass' ? pressAt : undefined),
  };
  const game = createGame({ events, inputs: [null, null, remote, null], seed: 3, allowPause: false });
  const points = [];
  const hits = [];
  events.on('point', (p) => points.push(p));
  events.on('hit', (p) => hits.push({ ...p, t: game.state.time }));
  game.startMatch({ difficulty: 'normal' });
  const kiki = game.state.players[2];
  const h = game.debug.hs[2];
  const greenMidTc = 0.13; // s before contact (middle of METER.pass.green)
  let rescued = false;
  let pointsAtPress = 0;
  for (let t = 0; t < 120 && !rescued; t += 1 / 120) {
    game.update(1 / 120);
    if (pressAt === null && h.pm.active && kiki.meters.pass !== null && h.pm.t - game.debug.sim.now <= greenMidTc) {
      pressAt = game.state.time;                // what the player saw: green
      deliverAt = pressAt + NET.maxRewind - 0.02; // ...arrives just inside the rewind limit
      pointsAtPress = points.length;
    }
    if (pressed && hits.some((x) => x.playerId === 2 && x.t >= deliverAt - 1e-6)) rescued = true;
    if (pressAt !== null && !pressed && points.length > pointsAtPress) {
      // The ball came down before the press arrived: the point must be on hold, not awarded.
      assert.fail('point awarded while a remote press could still arrive');
    }
    if (pressed && !rescued && game.state.time > deliverAt + 0.1) break;
  }
  assert.ok(rescued, 'the late green press touched the ball retroactively');
  const touch = hits.find((x) => x.playerId === 2 && x.t >= deliverAt - 1e-6);
  assert.ok(touch.quality > 0.6, `graded as the player saw it (quality ${touch.quality})`);
  assert.ok(game.debug.stats.retroTouches >= 1);
  assertNoNaN(game.state, 'rescue');
});

test('lag compensation: landings wait at most NET.maxRewind for a remote press; some are rescued', () => {
  let held = 0;
  let rescued = 0;
  for (const seed of [1, 2, 3]) {
    const log = [];
    const { game } = runMultiMatch({
      humans: [0, 2], seed, lagSec: 0.25, maxSeconds: 900,
      onEvent(name, p, g) { log.push({ name, p, t: g.state.time }); },
    });
    held += game.debug.stats.heldLandings;
    rescued += game.debug.stats.heldRescued;
    // Every rally-ending landing is decided within maxRewind of the ball touching the sand.
    let lastSand = null;
    for (const e of log) {
      if (e.name === 'hit' || e.name === 'serveReady') lastSand = null;
      else if (e.name === 'bounce' && e.p.surface === 'sand' && lastSand === null) lastSand = e.t;
      else if (e.name === 'point' && lastSand !== null && e.p.reason !== 'out') {
        assert.ok(e.t - lastSand <= NET.maxRewind + 0.02, `point decided ${(e.t - lastSand).toFixed(3)} s after landing`);
      }
    }
  }
  console.log(`held landings ${held}, rescued by a late press ${rescued}`);
  assert.ok(held > 0 && rescued > 0, 'landings are held and some are rescued');
  assert.ok(rescued < held, 'the rest still score');
});

test('lag compensation: a remote serve is charged from the press to the release the player made', () => {
  const served = (lagSec) => {
    const events = createEventBus();
    let game = null;
    const li = createLaggedInput({ get state() { return game.state; } }, lagSec);
    game = createGame({ events, inputs: [li.input, null, null, null], seed: 4, allowPause: false });
    let power = null;
    events.on('hit', (p) => { if (p.type === 'serve') power = p.power; });
    game.startMatch({ difficulty: 'normal' });
    const dt = 1 / 60;
    for (let t = 0; t < 3 && power === null; t += dt) {
      if (Math.abs(t - 0.6) < dt / 2) li.front.set('hit', true);
      if (Math.abs(t - 1.3) < dt / 2) li.front.set('hit', false);
      game.update(dt);
    }
    return power;
  };
  const p0 = served(0);
  const p150 = served(0.15);
  const p250 = served(NET.maxRewind);
  assert.ok(p0 > 0.5 && p0 < 0.75, `zero-latency charge ${p0}`);
  assert.ok(Math.abs(p150 - p0) < 0.03, `150 ms: ${p150} vs ${p0}`);
  assert.ok(Math.abs(p250 - p0) < 0.03, `250 ms: ${p250} vs ${p0}`);
});

test('lag compensation: a late press seen on an earlier ball does not use up the press for the current ball', () => {
  const events = createEventBus();
  let deliver = false;
  let viewTime = 0;
  const remote = {
    poll() {}, held: () => false, released: () => false, axis: () => ({ x: 0, y: 0 }), dispose() {},
    pressed: (a) => { if (a === 'pass' && deliver) { deliver = false; return true; } return false; },
    edgeTime: (a) => (a === 'pass' ? viewTime : undefined),
  };
  const game = createGame({ events, inputs: [null, null, remote, null], seed: 2, allowPause: false });
  const attempts = [];
  events.on('passAttempt', (p) => attempts.push(p));
  game.startMatch({ difficulty: 'normal' });
  let served = false;
  events.on('hit', (p) => { if (p.type === 'serve') served = true; });
  for (let t = 0; t < 5 && !served; t += 1 / 120) game.update(1 / 120);
  assert.ok(served);
  for (let i = 0; i < 6; i++) game.update(1 / 120);
  viewTime = game.state.time - 0.1; // pressed before the serve was struck (the held ball)
  deliver = true;
  game.update(1 / 120);
  assert.equal(attempts.length, 1, 'still reported (passAttempt)');
  const h = game.debug.hs[2];
  assert.notEqual(h.pass.lockEpoch, game.debug.sim.ballEpoch, 'the served ball can still be passed');
  assert.equal(h.pass.armed, 0);
  assert.equal(h.pass.cooldown, 0);
});
