// Ball-synced spike meter (state.spikeMeter, METER.spike): cue-following, grading at J release,
// whiffs, and NaN-safety with J held/released at random.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../src/core/events.js';
import { METER } from '../src/config.js';
import { createGame } from '../src/game/game.js';
import { createVirtualInput } from '../src/game/input.js';
import { createScriptedHuman, runMatch } from './helpers/harness.js';

const [G0, G1] = METER.spike.green;
const DT = 1 / 120;
const EVENTS = ['matchStart', 'serveReady', 'hit', 'jump', 'land', 'bounce', 'point', 'matchOver', 'swing', 'passAttempt'];

function lcg(seed) {
  let r = seed >>> 0;
  return () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
}

/** A human match where the bot moves Momo but never presses J; returns once Pip sets to Momo. */
function untilSetToMomo(seed) {
  const events = createEventBus();
  const input = createVirtualInput();
  const game = createGame({ events, input, seed });
  const log = [];
  for (const n of EVENTS) events.on(n, (p) => log.push({ name: n, p, t: game.debug.sim.now }));
  const drive = createScriptedHuman(game, input, { hitButton: false, rng: lcg(seed) });
  game.startMatch({ difficulty: 'easy' });
  const sim = game.debug.sim;
  for (let i = 0; i < 600 / DT; i++) {
    drive(DT);
    game.update(DT);
    const sm = sim.sm;
    if (sm.active && sm.kind === 'set' && sm.epoch === sim.ballEpoch && game.state.spikeMeter !== null) {
      return { game, input, log, drive, sim };
    }
  }
  throw new Error('no set to Momo');
}

/** Step until the attack ball is played or the rally ends; `each(frame)` may set inputs. */
function playOut(ctx, each) {
  const { game, input, drive, sim, log } = ctx;
  const from = log.length;
  const epoch = sim.ballEpoch;
  for (let i = 0; i < 4 / DT && game.state.phase === 'rally' && sim.ballEpoch === epoch; i++) {
    drive(DT);
    input.set('hit', false);
    if (each) each(i);
    game.update(DT);
  }
  return log.slice(from);
}

test('spikeMeter appears on a set to Momo, rises monotonically, reaches green before contact; never with the K meter', () => {
  const v = { episodes: 0, lateStart: 0, backwards: 0, noGreen: 0, both: 0, attacked: 0 };
  for (const seed of [3, 4]) {
    const eps = new Map();
    runMatch({
      difficulty: 'normal', seed, human: true, dt: DT,
      onStep(g) {
        const s = g.state;
        const sim = g.debug.sim;
        if (s.spikeMeter !== null && s.passMeter !== null) v.both++;
        const sm = sim.sm;
        if (!(sm.active && sm.kind === 'set' && sm.epoch === sim.ballEpoch)) return;
        let e = eps.get(sm.epoch);
        if (!e) { e = { first: null, last: null, back: false, greenAt: -1, t: sm.t }; eps.set(sm.epoch, e); }
        const m = s.spikeMeter;
        if (m === null) return;
        if (e.first === null) e.first = m;
        if (e.last !== null && m < e.last - 1e-9) e.back = true;
        if (m >= G0 && e.greenAt < 0) e.greenAt = sim.now;
        e.last = m;
        e.t = sm.t;
      },
      onEvent(name, p, g) {
        if (name !== 'hit' || p.playerId !== 0 || (p.type !== 'spike' && p.type !== 'dink')) return;
        const e = eps.get(g.debug.sim.ballEpoch - 1);
        if (!e) return;
        e.contact = g.debug.sim.now;
      },
    });
    for (const e of eps.values()) {
      if (e.first === null) continue;
      v.episodes++;
      if (e.first > 0.3) v.lateStart++;
      if (e.back) v.backwards++;
      if (e.contact !== undefined) {
        v.attacked++;
        if (e.greenAt < 0 || e.greenAt > e.contact) v.noGreen++;
      }
    }
  }
  const info = JSON.stringify(v);
  assert.ok(v.episodes > 20 && v.attacked > 20, info);
  assert.equal(v.lateStart, 0, `needle starts low: ${info}`);
  assert.equal(v.backwards, 0, `needle never runs backwards: ${info}`);
  assert.equal(v.noGreen, 0, `green reached before contact: ${info}`);
  assert.equal(v.both, 0, `spike and pass meters never shown together: ${info}`);
});

test('a human following the cues (move under, Space at JUMP, release J mid-green) lands green spikes over the net', () => {
  const r = { sets: 0, green: 0, ok: 0, blocked: 0, timings: {} };
  for (const seed of [5, 6, 7, 8]) {
    let ep = -1;       // epoch of the current set-to-Momo episode
    let state = null;  // 'green' -> 'spiked' -> counted
    runMatch({
      difficulty: 'normal', seed, human: true, dt: DT,
      humanOpts: { latencySec: 0.1, jumpJitter: 0.1, releaseJitter: 0.1 },
      onStep(g) {
        const sim = g.debug.sim;
        const sm = sim.sm;
        if (sm.active && sm.kind === 'set' && sm.epoch === sim.ballEpoch && sm.epoch !== ep && g.state.spikeMeter !== null) {
          ep = sm.epoch;
          state = 'set';
          r.sets++;
        }
        if (state === 'spiked' && g.state.ball.pos.z < -0.3) { r.ok++; state = null; }
      },
      onEvent(name, p, g) {
        if (name === 'swing' && state === 'set') {
          r.timings[p.timing] = (r.timings[p.timing] || 0) + 1;
          if (p.timing === 'perfect' || p.timing === 'good') { r.green++; state = 'green'; }
        }
        if (name === 'hit') {
          if (state === 'green' && p.playerId === 0 && p.type === 'spike') state = 'spiked';
          else if (state === 'spiked' && p.type === 'block') { r.blocked++; state = null; }
          else if (state !== 'spiked') state = null;
        }
        if (name === 'point' && state !== 'spiked') state = null;
      },
    });
  }
  const rate = r.ok / r.sets;
  const info = JSON.stringify({ ...r, rate: +rate.toFixed(3) });
  assert.ok(r.sets >= 40, info);
  assert.ok(rate >= 0.9, `green spike over the net in >= 90% of sets to Momo: ${info}`);
  console.log(`cue-following bot: ${info}`);
});

test('release at fill 0.4 = early/weak; release after contact = late', () => {
  // Early: tap J at 0.4 but jump on the JUMP mark: the swing still connects, weakly.
  {
    const ctx = untilSetToMomo(11);
    const { game, input } = ctx;
    let tapped = false;
    let jumped = false;
    const log = playOut(ctx, () => {
      const m = game.state.spikeMeter;
      if (!tapped && m !== null && m >= 0.4) { input.set('hit', true); tapped = true; }
      if (!jumped && m !== null && m >= METER.spike.jumpMark) { input.set('jump', true); jumped = true; }
    });
    const sw = log.filter((e) => e.name === 'swing');
    assert.equal(sw.length, 1);
    assert.equal(sw[0].p.timing, 'early');
    assert.ok(Math.abs(sw[0].p.meter - 0.4) < 0.05, `meter at release ${sw[0].p.meter}`);
    const hit = log.find((e) => e.name === 'hit' && e.p.playerId === 0);
    assert.ok(hit, 'an early release still connects when the ball is in reach');
    assert.equal(hit.p.type, 'spike');
    assert.ok(hit.p.quality < 0.5 && hit.p.power < 0.6, `weak: q ${hit.p.quality} power ${hit.p.power}`);
  }
  // Late: wind up from mid-meter (keeps the ball a J ball), release just after contact.
  {
    const ctx = untilSetToMomo(12);
    const { input, sim } = ctx;
    let released = false;
    const log = playOut(ctx, () => {
      if (released) return;
      if (sim.now < sim.sm.t + 0.03) input.set('hit', true);
      else released = true;
    });
    const sw = log.filter((e) => e.name === 'swing');
    assert.equal(sw.length, 1);
    assert.equal(sw[0].p.timing, 'late');
    assert.equal(sw[0].p.meter, 1);
    const hit = log.find((e) => e.name === 'hit' && e.p.playerId === 0);
    if (hit) assert.ok(hit.p.quality < 0.6, `late quality ${hit.p.quality}`);
  }
  // Green on the ground (no jump) = graded standing shot over the net.
  {
    const ctx = untilSetToMomo(13);
    const { game, input } = ctx;
    let state = 0;
    const log = playOut(ctx, () => {
      const m = game.state.spikeMeter;
      if (state === 0 && m !== null && m >= 0.6) state = 1;
      if (state === 1 && m !== null && m < (G0 + G1) / 2) input.set('hit', true);
      else if (state === 1) state = 2;
    });
    const sw = log.filter((e) => e.name === 'swing');
    assert.equal(sw.length, 1);
    assert.ok(sw[0].p.timing === 'perfect' || sw[0].p.timing === 'good', sw[0].p.timing);
    assert.equal(sw[0].p.airborne, false);
    const hit = log.find((e) => e.name === 'hit' && e.p.playerId === 0);
    assert.equal(hit?.p.type, 'dink');
    assert.ok(hit.p.quality >= 0.6);
  }
});

test('one graded release per attack ball: mashing J is swallowed', () => {
  const ctx = untilSetToMomo(14);
  const { game, input } = ctx;
  let n = 0;
  const log = playOut(ctx, (i) => {
    if (game.state.spikeMeter !== null && game.state.spikeMeter > 0.3 && i % 2 === 0 && n < 10) { input.set('hit', true); n++; }
  });
  assert.ok(n >= 5);
  assert.equal(log.filter((e) => e.name === 'swing').length, 1);
});

test('J held/released at random never produces NaN (state meters finite or null)', () => {
  const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  const okNum = (x) => x === null || (Number.isFinite(x) && x >= 0 && x <= 1);
  for (const seed of [1, 2]) {
    const events = createEventBus();
    const input = createVirtualInput();
    const game = createGame({ events, input, seed });
    const rnd = lcg(seed * 7);
    let bad = 0;
    events.on('swing', (p) => {
      if (!(p.meter === null || Number.isFinite(p.meter))) bad++;
      if (!['perfect', 'good', 'early', 'late', 'none'].includes(p.timing)) bad++;
    });
    events.on('hit', (p) => { if (!Number.isFinite(p.power) || (p.quality !== undefined && !Number.isFinite(p.quality))) bad++; });
    const drive = createScriptedHuman(game, input, { rng: rnd });
    game.startMatch({ difficulty: 'normal' });
    let chaos = false;
    for (let i = 0; i < 240 / DT && game.state.phase !== 'matchOver'; i++) {
      drive(DT);
      if (rnd() < 0.02) chaos = !chaos;
      if (chaos) input.set('hit', rnd() < 0.7);
      game.update(DT);
      const s = game.state;
      if (!finite(s.ball.pos) || !finite(s.ball.vel)) bad++;
      for (const p of s.players) if (!finite(p.pos) || !finite(p.vel)) bad++;
      if (!okNum(s.hitCharge) || !okNum(s.spikeMeter) || !okNum(s.passMeter)) bad++;
      if (!Number.isFinite(s.hitWindow) || !Number.isFinite(s.passWindow)) bad++;
    }
    assert.equal(bad, 0, `seed ${seed}`);
  }
});
