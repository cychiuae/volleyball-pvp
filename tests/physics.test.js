import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { BALL, COURT } from '../src/config.js';
import { BALL_SUBSTEP, createStepResult, createTrajectory, predictTrajectory, stepBall } from '../src/game/physics.js';

const R = BALL.radius;
const NH = COURT.netHeight;
const NB = COURT.netBottom;

function run(pos, vel, steps = 1200) {
  const res = createStepResult();
  const events = { net: 0, post: 0, crossings: [], floor: null };
  for (let i = 0; i < steps; i++) {
    stepBall(pos, vel, BALL_SUBSTEP, res);
    if (res.net) events.net++;
    if (res.post) events.post++;
    if (res.crossed) events.crossings.push({ x: res.crossX, y: res.crossY });
    if (res.floor && !events.floor) { events.floor = pos.clone(); break; }
  }
  return events;
}

test('fast balls into the net mesh never tunnel through', () => {
  for (const speed of [5, 12, 20, 30, 40]) {
    for (const y of [1.1, 1.5, 1.9]) {
      for (const dir of [1, -1]) {
        const pos = new Vector3(0.3, y, dir * 1.0);
        const vel = new Vector3(0.5, 0, -dir * speed);
        const ev = run(pos, vel);
        assert.ok(ev.net >= 1, `net hit at speed ${speed}`);
        for (const c of ev.crossings) {
          assert.ok(!(Math.abs(c.x) < COURT.netHalfSpan && c.y > NB && c.y < NH), `tunnelled at ${speed}`);
        }
        assert.ok(Math.sign(ev.floor.z) === dir, 'ball drops back on the side it came from');
      }
    }
  }
});

test('net bounce keeps about netRestitution of the normal speed', () => {
  const pos = new Vector3(0, 1.5, 0.6);
  const vel = new Vector3(0, 0, -10);
  const res = createStepResult();
  for (let i = 0; i < 100 && !res.net; i++) stepBall(pos, vel, BALL_SUBSTEP, res);
  assert.ok(res.net);
  assert.ok(vel.z > 0 && vel.z < 10 * BALL.netRestitution + 0.5);
});

test('clipping the tape slows the ball and can trickle over', () => {
  let trickled = 0;
  let touched = 0;
  for (let i = 0; i < 20; i++) {
    // Start right before the net so the height at contact is what we set.
    const pos = new Vector3(0, NH + R * (0.1 + i * 0.045), 0.45);
    const vel = new Vector3(0, 0.6, -5);
    const ev = run(pos, vel);
    if (ev.net) touched++;
    if (ev.net && ev.floor && ev.floor.z < 0) trickled++;
  }
  assert.ok(touched > 0, 'some balls touch the tape');
  assert.ok(trickled > 0, 'some tape balls trickle over');
});

test('posts deflect the ball', () => {
  const pos = new Vector3(COURT.netHalfSpan, 1.0, 1.5);
  const vel = new Vector3(0, 2, -8);
  const ev = run(pos, vel);
  assert.ok(ev.post >= 1);
});

test('a ball resting on the tape rolls off', () => {
  const pos = new Vector3(0, NH + R + 0.3, 0);
  const vel = new Vector3(0, 0, 0);
  const ev = run(pos, vel, 4000);
  assert.ok(ev.floor, 'ball reached the sand');
});

test('trajectory prediction accounts for the net', () => {
  const tr = predictTrajectory(new Vector3(0, 1.5, 3), new Vector3(0, 1, -9), 0, createTrajectory());
  assert.ok(tr.netHit);
  assert.ok(tr.hasLanding && tr.landing.z > 0);
});
