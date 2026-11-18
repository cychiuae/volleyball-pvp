// Ball physics: exact drag/gravity flight, net mesh + tape + posts, sand bounces,
// and forward prediction of the trajectory (landing marker, AI planning).
import { BALL, COURT } from '../config.js';
import { integrate } from './ballistics.js';

const R = BALL.radius;
const NH = COURT.netHeight;
const NB = COURT.netBottom;
const SPAN = COURT.netHalfSpan;
const NET_REST = BALL.netRestitution;
const SAND_REST = BALL.sandRestitution;

export const BALL_SUBSTEP = 1 / 240;   // 22 m/s ball moves < 0.1 m per substep (radius 0.24): no tunnelling
export const SAMPLE_DT = 1 / 120;      // trajectory sample spacing (= game fixed step)
export const POST_RADIUS = 0.06;
export const POST_TOP = NH + 0.2;
const MAX_SAMPLES = 1200;              // 10 s of flight

export function createStepResult() {
  return {
    net: false, post: false, impactSpeed: 0,
    floor: false, floorSpeed: 0,
    crossed: false, crossX: 0, crossY: 0, crossTo: 0,
  };
}

function reflect(vel, nx, ny, nz, restitution, keepTangent) {
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn >= 0) return 0;
  const tx = vel.x - vn * nx;
  const ty = vel.y - vn * ny;
  const tz = vel.z - vn * nz;
  vel.x = tx * keepTangent - vn * restitution * nx;
  vel.y = ty * keepTangent - vn * restitution * ny;
  vel.z = tz * keepTangent - vn * restitution * nz;
  return -vn;
}

// Net panel: rectangle in z = 0, |x| <= SPAN, NB <= y <= NH. The top edge is the tape.
function collideNet(pos, vel, prevSide, res) {
  const cx = pos.x < -SPAN ? -SPAN : pos.x > SPAN ? SPAN : pos.x;
  const cy = pos.y < NB ? NB : pos.y > NH ? NH : pos.y;
  const inFace = cx === pos.x && cy === pos.y;
  let nx, ny, nz;
  if (inFace) {
    const crossed = (pos.z > 0 ? 1 : pos.z < 0 ? -1 : 0) !== prevSide;
    if (!crossed && Math.abs(pos.z) >= R) return;
    // Face contact: always push back to the side the ball came from (never through the mesh).
    nx = 0; ny = 0; nz = prevSide;
    pos.z = prevSide * R;
    const speed = reflect(vel, nx, ny, nz, NET_REST, 0.55);
    if (speed > 0) { res.net = true; res.impactSpeed = Math.max(res.impactSpeed, speed); }
    return;
  }
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const dz = pos.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= R * R) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) { nx = 0; ny = 1; nz = 0; } else { nx = dx / d; ny = dy / d; nz = dz / d; }
  pos.x = cx + nx * R;
  pos.y = cy + ny * R;
  pos.z = nz * R;
  const tape = cy === NH && dy > 0;
  const speed = reflect(vel, nx, ny, nz, NET_REST, tape ? 0.85 : 0.6);
  if (speed > 0) {
    res.net = true;
    res.impactSpeed = Math.max(res.impactSpeed, speed);
    // A ball sitting on the tape always rolls off to one side (never balances forever).
    if (tape && Math.abs(vel.z) < 0.35) {
      const s = pos.z > 0 ? 1 : pos.z < 0 ? -1 : prevSide;
      vel.z += s * 0.4;
    }
  }
}

function collidePosts(pos, vel, res) {
  if (pos.y > POST_TOP + R) return;
  const minD = R + POST_RADIUS;
  for (let i = 0; i < 2; i++) {
    const px = i === 0 ? -SPAN : SPAN;
    const dx = pos.x - px;
    const dz = pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) continue;
    const d = Math.sqrt(d2) || 1e-6;
    const nx = dx / d;
    const nz = dz / d;
    pos.x = px + nx * minD;
    pos.z = nz * minD;
    const speed = reflect(vel, nx, 0, nz, 0.5, 0.8);
    if (speed > 0) { res.post = true; res.impactSpeed = Math.max(res.impactSpeed, speed); }
  }
}

/**
 * Advance the ball one substep with collisions. `floorY` is the height of the ball centre
 * when resting on the sand (R normally, a bit less once it has "sunk" after a point).
 */
export function stepBall(pos, vel, dt, res, floorY = R) {
  res.net = false; res.post = false; res.floor = false; res.crossed = false; res.impactSpeed = 0;
  const pz = pos.z;
  const px = pos.x;
  const py = pos.y;
  const prevSide = pz > 0 ? 1 : pz < 0 ? -1 : (vel.z > 0 ? -1 : 1);
  integrate(pos, vel, dt);
  collideNet(pos, vel, prevSide, res);
  collidePosts(pos, vel, res);
  const newSide = pos.z > 0 ? 1 : pos.z < 0 ? -1 : prevSide;
  if (newSide !== prevSide) {
    const f = pz !== pos.z ? pz / (pz - pos.z) : 0;
    res.crossed = true;
    res.crossX = px + (pos.x - px) * f;
    res.crossY = py + (pos.y - py) * f;
    res.crossTo = newSide;
  }
  if (pos.y < floorY) {
    pos.y = floorY;
    if (vel.y < 0) {
      const impact = -vel.y;
      if (impact > 0.3) { res.floor = true; res.floorSpeed = Math.hypot(vel.x, vel.y, vel.z); }
      vel.y = impact > 0.9 ? impact * SAND_REST : 0;
      if (impact > 0.3) { vel.x *= 0.6; vel.z *= 0.6; }
    }
  }
  if (pos.y <= floorY + 1e-4 && vel.y === 0) {
    const fr = Math.exp(-4 * dt);
    vel.x *= fr;
    vel.z *= fr;
  }
  return res;
}

export function createTrajectory() {
  return {
    t0: 0,
    n: 0,
    t: new Float64Array(MAX_SAMPLES),
    x: new Float64Array(MAX_SAMPLES),
    y: new Float64Array(MAX_SAMPLES),
    z: new Float64Array(MAX_SAMPLES),
    hasLanding: false,
    landing: { x: 0, z: 0 },
    landT: Infinity,
    netHit: false,
  };
}

const pp = { x: 0, y: 0, z: 0 };
const pv = { x: 0, y: 0, z: 0 };
const pres = createStepResult();

/**
 * Simulate forward (physics only, no players) until the ball first touches the sand.
 * Samples every SAMPLE_DT; `t` values are relative to t0.
 */
export function predictTrajectory(pos, vel, t0, tr) {
  pp.x = pos.x; pp.y = pos.y; pp.z = pos.z;
  pv.x = vel.x; pv.y = vel.y; pv.z = vel.z;
  tr.t0 = t0;
  tr.hasLanding = false;
  tr.landT = Infinity;
  tr.netHit = false;
  tr.t[0] = 0; tr.x[0] = pp.x; tr.y[0] = pp.y; tr.z[0] = pp.z;
  let n = 1;
  const sub = Math.max(1, Math.round(SAMPLE_DT / BALL_SUBSTEP));
  let t = 0;
  outer:
  while (n < MAX_SAMPLES) {
    for (let k = 0; k < sub; k++) {
      stepBall(pp, pv, BALL_SUBSTEP, pres);
      t += BALL_SUBSTEP;
      if (pres.net || pres.post) tr.netHit = true;
      if (pres.floor || (pp.y <= R + 1e-6 && pv.y === 0)) {
        tr.t[n] = t; tr.x[n] = pp.x; tr.y[n] = pp.y; tr.z[n] = pp.z; n++;
        tr.hasLanding = true;
        tr.landing.x = pp.x;
        tr.landing.z = pp.z;
        tr.landT = t;
        break outer;
      }
    }
    tr.t[n] = t; tr.x[n] = pp.x; tr.y[n] = pp.y; tr.z[n] = pp.z; n++;
  }
  tr.n = n;
  return tr;
}
