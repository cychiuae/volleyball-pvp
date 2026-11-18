import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createEventBus } from '../src/core/events.js';
import { METER, RULES } from '../src/config.js';
import { createGame } from '../src/game/game.js';
import { createVirtualInput } from '../src/game/input.js';
import { createScriptedHuman } from './helpers/harness.js';

function setup(opts = {}) {
  const events = createEventBus();
  const input = createVirtualInput();
  const game = createGame({ events, input, seed: 42, ...opts });
  const log = [];
  for (const n of ['matchStart', 'serveReady', 'hit', 'jump', 'land', 'bounce', 'point', 'controlSwitch', 'matchOver', 'pause', 'resume', 'menu', 'swing', 'passAttempt']) {
    events.on(n, (p) => log.push({ name: n, p }));
  }
  const run = (sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) game.update(dt); };
  return { game, input, log, run, events };
}

test('state matches the documented shape', () => {
  const { game } = setup();
  const s = game.state;
  assert.equal(s.phase, 'menu');
  for (const k of ['paused', 'difficulty', 'time', 'score', 'servingTeam', 'serverId', 'touches', 'possessionTeam',
    'controlledId', 'serveCharge', 'serveRisk', 'hitCharge', 'spikeMeter', 'passMeter', 'hitWindow', 'passWindow', 'aimTarget', 'lastPoint',
    'ball', 'players']) assert.ok(k in s, k);
  for (const k of ['pos', 'vel', 'spin']) assert.ok(s.ball[k] instanceof Vector3);
  for (const k of ['visible', 'landing', 'held', 'lastTeam']) assert.ok(k in s.ball, k);
  assert.equal(s.players.length, 4);
  s.players.forEach((p, i) => {
    assert.equal(p.id, i);
    assert.equal(p.team, i < 2 ? 0 : 1);
    assert.equal(p.index, i % 2);
    assert.ok(p.pos instanceof Vector3 && p.vel instanceof Vector3);
    for (const k of ['facing', 'grounded', 'action', 'actionTime', 'controlled']) assert.ok(k in p, k);
  });
});

test('menu runs a silent attract-mode rally', () => {
  const { game, log, run } = setup();
  const start = game.state.ball.pos.clone();
  let moved = false;
  for (let i = 0; i < 40 * 60; i++) {
    game.update(1 / 60);
    if (game.state.ball.pos.distanceTo(start) > 1) moved = true;
  }
  run(0);
  assert.equal(game.state.phase, 'menu');
  assert.deepEqual(game.state.score, [0, 0]);
  assert.equal(log.length, 0, 'no events in attract mode');
  assert.ok(moved, 'the attract rally moves the ball');
  assert.ok(game.state.players.every((p) => !p.controlled));
});

test('human serve: charge with Hit (J), aim, release', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  assert.equal(game.state.phase, 'serve');
  assert.deepEqual(log.map((e) => e.name).slice(0, 2), ['matchStart', 'serveReady']);
  assert.deepEqual(log[1].p, { team: 0, playerId: game.state.serverId, isHuman: true });
  assert.equal(game.state.serverId, 0, 'Momo serves first');
  assert.ok(game.state.ball.held);
  run(0.5);
  input.set('hit', true);
  input.set('right', true);
  run(0.3);
  const c1 = game.state.serveCharge;
  assert.ok(c1 > 0 && c1 < 1);
  assert.ok(game.state.aimTarget, 'serve target preview');
  const z1 = game.state.aimTarget.z;
  const x1 = game.state.aimTarget.x;
  run(0.4);
  assert.ok(game.state.serveCharge > c1);
  assert.ok(game.state.aimTarget.z < z1, 'more charge = deeper');
  assert.ok(game.state.aimTarget.x > x1, 'right shifts the target');
  input.set('hit', false);
  input.set('right', false);
  run(0.1);
  assert.equal(game.state.serveCharge, null);
  assert.equal(game.state.players[game.state.serverId].action, 'serveToss');
  run(0.6);
  const hit = log.find((e) => e.name === 'hit');
  assert.ok(hit);
  assert.equal(hit.p.type, 'serve');
  assert.equal(hit.p.team, 0);
  assert.ok(hit.p.position instanceof Vector3);
  assert.equal(game.state.phase, 'rally');
  assert.equal(game.state.ball.held, false);
  assert.ok(game.state.ball.landing && game.state.ball.landing.z < 0, 'serve heads to the CPU side');
});

test('human who never serves gets a soft auto-serve', () => {
  const { game, log, run } = setup();
  game.startMatch({ difficulty: 'easy' });
  run(RULES.serveTimeoutSec - 0.5);
  assert.equal(log.filter((e) => e.name === 'hit').length, 0);
  run(1.5);
  assert.equal(log.filter((e) => e.name === 'hit')[0]?.p.type, 'serve');
});

test('pause/resume via input and API freeze the simulation', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  run(0.5);
  input.set('pause', true);
  run(1 / 60);
  input.set('pause', false);
  assert.equal(game.state.paused, true);
  assert.equal(log.at(-1).name, 'pause');
  const t = game.state.time;
  run(2);
  assert.equal(game.state.time, t);
  input.set('pause', true);
  run(1 / 60);
  input.set('pause', false);
  assert.equal(game.state.paused, false);
  assert.equal(log.at(-1).name, 'resume');
  game.pause();
  assert.equal(game.state.paused, true);
  game.resume();
  assert.equal(game.state.paused, false);
  game.toMenu();
  assert.equal(game.state.phase, 'menu');
  assert.equal(log.at(-1).name, 'menu');
  input.set('pause', true);
  run(1 / 60);
  assert.equal(game.state.paused, false, 'Esc does nothing in the menu');
});

test('Space alone never serves: it only waits for the auto-serve', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  for (let i = 0; i < 6; i++) {
    input.set('jump', true); run(0.5);
    input.set('jump', false); run(0.5);
    assert.equal(game.state.serveCharge, null);
  }
  assert.equal(log.filter((e) => e.name === 'hit').length, 0, 'no serve from Space');
  run(RULES.serveTimeoutSec);
  const serve = log.find((e) => e.name === 'hit');
  assert.equal(serve?.p.type, 'serve', 'timeout auto-serve');
  assert.equal(serve.p.power, 0.4, 'soft auto-serve');
});

test('the human always controls Momo (players[0]); no control switching', () => {
  const { game, log, run } = setup({ seed: 3 });
  game.startMatch({ difficulty: 'normal' });
  for (let i = 0; i < 60; i++) {
    run(1);
    const s = game.state;
    assert.equal(s.controlledId, 0);
    assert.deepEqual(s.players.map((p) => p.controlled), [true, false, false, false]);
  }
  assert.equal(log.filter((e) => e.name === 'controlSwitch').length, 0);
  game.toMenu();
  run(0.1);
  assert.ok(game.state.players.every((p) => !p.controlled), 'nobody is controlled in the menu');
});

/** Start a match and get to a rally with the ball on the CPU side (Momo soft auto-serve). */
function toRally(seed = 5) {
  const ctx = setup({ seed });
  ctx.game.startMatch({ difficulty: 'normal' });
  ctx.run(RULES.serveTimeoutSec + 1);
  assert.equal(ctx.game.state.phase, 'rally');
  return ctx;
}

test('J wind-up: holding fills hitCharge (pose only); a release with no attack ball is a whiff', () => {
  const { game, input, log, run } = toRally();
  const momo = game.state.players[0];
  assert.equal(game.state.hitCharge, null);
  assert.equal(game.state.spikeMeter, null, 'ball is heading to the CPU: no attack ball');
  input.set('hit', true);
  run(0.35 / 2);
  const half = game.state.hitCharge;
  assert.ok(half > 0.35 && half < 0.65, `half way (${half})`);
  assert.equal(log.filter((e) => e.name === 'swing').length, 0, 'winding up alone does not swing');
  assert.equal(game.state.hitWindow, 0);
  run(1);
  assert.equal(game.state.hitCharge, 1, 'over-held stays at 1');
  input.set('hit', false);
  run(1 / 60);
  assert.equal(game.state.hitCharge, null);
  assert.equal(momo.action, 'spike', 'arm swings on release');
  assert.ok(game.state.hitWindow > 0 && game.state.hitWindow <= 0.22);
  const swing = log.filter((e) => e.name === 'swing');
  assert.equal(swing.length, 1);
  assert.equal(swing[0].p.playerId, 0);
  assert.equal(swing[0].p.timing, 'none', 'no attack ball');
  assert.equal(swing[0].p.meter, null);
  assert.equal(typeof swing[0].p.airborne, 'boolean');
  run(0.3);
  assert.equal(game.state.hitWindow, 0, 'window closed');
  assert.equal(log.filter((e) => e.name === 'hit' && e.p.playerId === 0 && e.p.type !== 'serve').length, 0, 'whiff');
  // A tap (press + release in one frame) is a release too.
  input.set('hit', true); game.update(1 / 60); input.set('hit', false); game.update(1 / 60);
  assert.equal(log.filter((e) => e.name === 'swing').length, 2);
});

test('K with no ball incoming: animation + passAttempt(tooEarly, meter null), no touch, 0.5 s cooldown', () => {
  const { game, input, log, run } = toRally();
  const momo = game.state.players[0];
  assert.equal(game.state.passMeter, null, 'ball is heading to the CPU');
  input.set('pass', true); run(1 / 60); input.set('pass', false);
  assert.ok(momo.action === 'bump' || momo.action === 'set');
  let pa = log.filter((e) => e.name === 'passAttempt');
  assert.equal(pa.length, 1);
  assert.equal(pa[0].p.playerId, 0);
  assert.equal(pa[0].p.timing, 'tooEarly');
  assert.equal(pa[0].p.meter, null);
  input.set('pass', true); run(1 / 60); input.set('pass', false);
  pa = log.filter((e) => e.name === 'passAttempt');
  assert.equal(pa.length, 1, 'cooldown swallows the second press');
  run(0.6);
  input.set('pass', true); run(1 / 60); input.set('pass', false);
  assert.equal(log.filter((e) => e.name === 'passAttempt').length, 2, 'cooldown over');
  assert.equal(log.filter((e) => e.name === 'hit' && e.p.playerId === 0 && e.p.type !== 'serve').length, 0);
});

/** Run a human match (bot moves Momo but never presses K) until a ball is incoming to Momo. */
function untilIncoming(seed = 9) {
  const events = createEventBus();
  const input = createVirtualInput();
  const game = createGame({ events, input, seed });
  const log = [];
  events.on('passAttempt', (p) => log.push({ name: 'passAttempt', p }));
  events.on('hit', (p) => log.push({ name: 'hit', p }));
  const drive = createScriptedHuman(game, input, { passButton: false, rng: () => 0.5 });
  game.startMatch({ difficulty: 'easy' });
  for (let i = 0; i < 120 * 60; i++) {
    drive(1 / 60);
    game.update(1 / 60);
    const m = game.state.passMeter;
    if (m !== null && m > 0.5 && m < 0.7) break;
  }
  assert.ok(game.state.passMeter !== null, 'found an incoming ball');
  input.setAxis(0, 0);
  return { game, input, log };
}

test('passMeter fills smoothly toward contact; one K press per ball (mashing is ignored)', () => {
  const { game, input, log } = untilIncoming();
  const m0 = game.state.passMeter;
  game.update(1 / 60);
  const m1 = game.state.passMeter;
  assert.ok(m1 > m0 && m1 - m0 < 0.05, `fills ${m0} -> ${m1}`);
  for (let i = 0; i < 6; i++) {
    input.set('pass', true); game.update(1 / 60);
    input.set('pass', false); game.update(1 / 60);
  }
  const pa = log.filter((e) => e.name === 'passAttempt');
  assert.equal(pa.length, 1, 'only the first press counts');
  assert.ok(['perfect', 'good', 'early', 'late', 'tooEarly', 'tooLate'].includes(pa[0].p.timing));
  assert.ok(pa[0].p.meter > 0.5 && pa[0].p.meter < 0.8);
  assert.equal(pa[0].p.timing, 'tooEarly', 'pressed ~0.3 s before contact: way too early');
});

test('K never serves or charges a serve; J never opens the pass window', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  run(0.5);
  input.set('pass', true);
  run(1.5);
  assert.equal(game.state.serveCharge, null);
  assert.equal(log.filter((e) => e.name === 'hit').length, 0);
  input.set('pass', false);
  const r = toRally();
  r.input.set('hit', true); r.run(0.2); r.input.set('hit', false); r.run(1 / 60);
  assert.equal(r.game.state.passWindow, 0);
  assert.equal(r.log.filter((e) => e.name === 'passAttempt').length, 0);
});

test('CPU serves after a short delay', () => {
  const { game, log, run } = setup({ seed: 3 });
  game.startMatch({ difficulty: 'normal' });
  let guard = 0;
  while (game.state.servingTeam !== 1 && guard++ < 200) run(1);
  assert.equal(game.state.servingTeam, 1);
  const ready = log.filter((e) => e.name === 'serveReady').at(-1);
  assert.equal(ready.p.isHuman, false);
  const before = log.length;
  run(1.0);
  assert.equal(log.slice(before).filter((e) => e.name === 'hit').length, 0, 'CPU waits ~1.2s');
  run(1.0);
  const serve = log.slice(before).find((e) => e.name === 'hit');
  assert.equal(serve?.p.type, 'serve');
  assert.equal(serve.p.team, 1);
});

// ---- QA regressions -------------------------------------------------------------------------

test('regression: a serve press during the lockout is not swallowed', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  run(0.1);
  input.set('hit', true); // pressed during the 0.35 s lockout and held
  run(0.6);
  assert.ok(game.state.serveCharge > 0, 'charging started after the lockout');
  input.set('hit', false);
  run(0.8);
  const serve = log.find((e) => e.name === 'hit');
  assert.equal(serve?.p.type, 'serve');
  assert.ok(serve.p.power > 0.1 && serve.p.power !== 0.4, `player serve, power ${serve?.p.power}`);
  assert.ok(game.state.time < 3, 'well before the auto-serve timeout');
});

test('regression: a quick tap during the lockout still serves (buffered)', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  run(0.1);
  input.set('hit', true); run(1 / 60); input.set('hit', false);
  run(1.5);
  assert.equal(log.find((e) => e.name === 'hit')?.p.type, 'serve');
});

test('regression: serveRisk is null/0 until the grace period, then ramps to 1', () => {
  const { game, input, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  assert.equal(game.state.serveRisk, null);
  run(0.5);
  input.set('hit', true);
  run(0.6);
  assert.equal(game.state.serveRisk, 0, 'charging, not yet full');
  run(0.6); // full charge reached at 1.1 s, now ~0.1 s past
  assert.equal(game.state.serveCharge, 1);
  assert.equal(game.state.serveRisk, 0, 'within grace');
  run(0.6);
  const mid = game.state.serveRisk;
  assert.ok(mid > 0 && mid < 1, `ramping (${mid})`);
  run(1.0);
  assert.equal(game.state.serveRisk, 1);
  input.set('hit', false);
  run(0.1);
  assert.equal(game.state.serveRisk, null);
});

test('regression: overcharged serves go long more often, and full charge in time stays in', () => {
  const countLong = (holdAfterFull) => {
    let long = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { game, input, run } = setup({ seed });
      game.startMatch({ difficulty: 'normal' });
      run(0.5);
      input.set('hit', true);
      run(1.15 + holdAfterFull);
      input.set('hit', false);
      run(0.55);
      const l = game.state.ball.landing;
      if (l && Math.abs(l.z) > 8.24) long++;
    }
    return long;
  };
  assert.equal(countLong(0.1), 0);
  assert.ok(countLong(1.4) >= 5);
});

test('regression: releasing Hit while paused cancels the charge instead of serving', () => {
  const { game, input, log, run } = setup();
  game.startMatch({ difficulty: 'normal' });
  run(0.5);
  input.set('hit', true);
  run(0.5);
  assert.ok(game.state.serveCharge > 0);
  game.pause();
  input.set('hit', false);
  run(0.5);
  game.resume();
  run(0.8);
  assert.equal(log.filter((e) => e.name === 'hit').length, 0, 'no weak serve on resume');
  assert.equal(game.state.serveCharge, null);
  assert.equal(game.state.phase, 'serve');
  input.set('hit', true); run(0.5); input.set('hit', false); run(0.8);
  assert.equal(log.filter((e) => e.name === 'hit')[0]?.p.type, 'serve', 'can serve normally afterwards');
});

test('regression: matchStart is emitted with phase "serve", before serveReady', () => {
  const { game, events, log, run } = setup();
  run(6); // attract rally is mid-flight
  let phaseAtStart = null;
  events.on('matchStart', () => { phaseAtStart = game.state.phase; });
  game.startMatch({ difficulty: 'hard' });
  assert.equal(phaseAtStart, 'serve');
  assert.deepEqual(log.map((e) => e.name), ['matchStart', 'serveReady']);
});

test('regression: startMatch / toMenu while paused emit resume', () => {
  const { game, log } = setup();
  game.startMatch({ difficulty: 'normal' });
  game.pause();
  game.startMatch({ difficulty: 'normal' });
  assert.equal(game.state.paused, false);
  assert.ok(log.some((e) => e.name === 'resume'));
  game.pause();
  const n = log.filter((e) => e.name === 'resume').length;
  game.toMenu();
  assert.equal(log.filter((e) => e.name === 'resume').length, n + 1);
  assert.equal(game.state.paused, false);
});
