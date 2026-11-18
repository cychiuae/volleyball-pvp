import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { BALL } from '../src/config.js';
import { apexOf, netClearance, solveByApex, solveByTime } from '../src/game/ballistics.js';
import { BALL_SUBSTEP, createStepResult, createTrajectory, predictTrajectory, stepBall } from '../src/game/physics.js';
import { driveTo, lobTo } from '../src/game/shots.js';

const R = BALL.radius;

/** Fly with the real physics until the first sand contact. */
function flyToSand(from, vel) {
  const p = from.clone();
  const v = vel.clone();
  const res = createStepResult();
  let netHit = false;
  for (let i = 0; i < 4000; i++) {
    stepBall(p, v, BALL_SUBSTEP, res);
    if (res.net || res.post) netHit = true;
    if (res.floor) return { pos: p, netHit };
  }
  throw new Error('ball never landed');
}

test('solveByTime reaches the target exactly in the simulation', () => {
  const from = new Vector3(1, 1, 6);
  const target = new Vector3(-2, R, 2);
  const v = solveByTime(from, target, 1.3, new Vector3());
  const { pos } = flyToSand(from, v);
  assert.ok(pos.distanceTo(target) < 0.03, `landed ${pos.toArray()} vs ${target.toArray()}`);
});

test('solveByApex peaks at the requested height', () => {
  const from = new Vector3(0, 1, 6);
  const target = new Vector3(1, 1.75, 1.6);
  const v = new Vector3();
  const T = solveByApex(from, target, 3.8, v);
  assert.ok(Math.abs(apexOf(from, v).y - 3.8) < 0.01);
  assert.ok(T > 1 && T < 2.5, `flight time ${T}`);
});

test('lobTo over the net clears the tape and lands on target', () => {
  const from = new Vector3(0, 1.0, 1.0);
  const target = new Vector3(2, R, -5);
  const v = new Vector3();
  lobTo(from, target, 2.4, v);
  assert.ok(netClearance(from, v) >= 0.12);
  const { pos, netHit } = flyToSand(from, v);
  assert.equal(netHit, false);
  assert.ok(pos.distanceTo(target) < 0.05);
});

test('driveTo spikes clear the net, even short cut shots', () => {
  for (const [tx, tz] of [[0, -6.5], [3, -2.4], [-3.5, -1.5], [2, -7.5]]) {
    const from = new Vector3(0.5, 2.8, 1.2);
    const target = new Vector3(tx, R, tz);
    const v = new Vector3();
    driveTo(from, target, 19, v);
    assert.ok(netClearance(from, v) >= 0.08, `clearance for ${tx},${tz}`);
    const { pos, netHit } = flyToSand(from, v);
    assert.equal(netHit, false);
    assert.ok(pos.distanceTo(target) < 0.05);
    assert.ok(v.y < 2, 'spikes are not lobs');
  }
});

test('predicted landing matches the simulated landing', () => {
  const from = new Vector3(-1, 2.2, 8.6);
  const v = new Vector3(0.5, 4, -11);
  const tr = predictTrajectory(from, v, 0, createTrajectory());
  const { pos } = flyToSand(from, v);
  assert.ok(tr.hasLanding);
  assert.ok(Math.hypot(tr.landing.x - pos.x, tr.landing.z - pos.z) < 1e-6);
});
