// Closed-form ball flight under gravity + linear air drag, and "aim at a point" solvers.
//
// With linear drag k and gravity g, starting at p0 with velocity v0:
//   F(t) = (1 - e^{-kt}) / k
//   x(t) = x0 + vx0 F(t)                     (same for z)
//   y(t) = y0 + (vy0 + g/k) F(t) - (g/k) t
// The simulation integrates with exactly this formula per substep, so solved shots land
// precisely where intended (no integrator drift).
import { BALL, COURT } from '../config.js';

export const K = BALL.airDrag;
export const G = BALL.gravity;
const GK = G / K;

export function dragF(t) {
  return K > 1e-9 ? (1 - Math.exp(-K * t)) / K : t;
}

/** Exact free-flight advance of pos/vel by dt (mutates both). Works on any {x,y,z}. */
export function integrate(pos, vel, dt) {
  const e = Math.exp(-K * dt);
  const F = (1 - e) / K;
  pos.x += vel.x * F;
  pos.z += vel.z * F;
  pos.y += (vel.y + GK) * F - GK * dt;
  vel.x *= e;
  vel.z *= e;
  vel.y = (vel.y + GK) * e - GK;
}

export function positionAt(p0, v0, t, out) {
  const F = dragF(t);
  out.x = p0.x + v0.x * F;
  out.z = p0.z + v0.z * F;
  out.y = p0.y + (v0.y + GK) * F - GK * t;
  return out;
}

/** Velocity that takes the ball from p0 to target in exactly T seconds. */
export function solveByTime(p0, target, T, out) {
  const F = dragF(T);
  out.x = (target.x - p0.x) / F;
  out.z = (target.z - p0.z) / F;
  out.y = (target.y - p0.y + GK * T) / F - GK;
  return out;
}

/** Highest point of the flight starting at p0 with v0. */
export function apexOf(p0, v0) {
  if (v0.y <= 0) return { t: 0, y: p0.y };
  const t = Math.log((v0.y + GK) / GK) / K;
  return { t, y: p0.y + (v0.y + GK) * dragF(t) - GK * t };
}

/**
 * Velocity reaching `target` whose flight peaks at `apexY` (clamped to be above both ends).
 * Returns the flight time.
 */
export function solveByApex(p0, target, apexY, out) {
  const minApex = Math.max(p0.y, target.y) + 0.05;
  const want = Math.max(apexY, minApex);
  let lo = 0.05;
  let hi = 10;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    solveByTime(p0, target, mid, out);
    if (apexOf(p0, out).y < want) lo = mid; else hi = mid;
  }
  solveByTime(p0, target, hi, out);
  return hi;
}

/** Where/when the flight crosses the plane z = 0, or null if it never does. */
export function netCrossing(p0, v0) {
  if (Math.abs(v0.z) < 1e-6) return null;
  const F = -p0.z / v0.z;
  if (F <= 0 || F >= 1 / K) return null;
  const t = -Math.log(1 - K * F) / K;
  return { t, x: p0.x + v0.x * F, y: p0.y + (v0.y + GK) * F - GK * t };
}

/** Vertical gap between the ball's bottom and the net tape at the crossing (Infinity if no crossing). */
export function netClearance(p0, v0) {
  const c = netCrossing(p0, v0);
  if (!c) return Infinity;
  return c.y - (COURT.netHeight + BALL.radius);
}
