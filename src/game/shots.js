// "Aim at a point" shot helpers built on the ballistic solvers. All shots that cross the
// net are verified for clearance and adjusted (higher apex / slower drive) when needed.
import { netClearance, solveByApex, solveByTime } from './ballistics.js';

// Touch geometry (meters). Tuning knobs.
export const SET_SPOT_Z = 1.6;          // pass target distance from the net
export const ATTACK_SPOT_Z = 1.2;       // set target distance from the net
export const BUMP_CONTACT_Y = 1.0;      // preferred contact height for bumps/digs
export const SET_CONTACT_Y = 1.75;      // preferred contact height for sets (hands above head)
export const ATTACK_CONTACT_Y = 2.75;   // height the set is aimed to fall through at the attack spot
export const PASS_APEX = 3.8;
export const SET_APEX = 4.0;
export const MAX_LOB_APEX = 6.0;

/** Lob to target with the given apex; raises the apex until the net is cleared (if crossing). */
export function lobTo(from, target, apex, out, margin = 0.12) {
  let a = apex;
  const maxApex = Math.max(apex, MAX_LOB_APEX);
  for (;;) {
    const T = solveByApex(from, target, a, out);
    if (netClearance(from, out) >= margin) return T;
    if (a >= maxApex) break;
    a = Math.min(maxApex, a + 0.2);
  }
  // Can't clear (e.g. played from right at the net): keep a sane arc; it will hit the net.
  return solveByApex(from, target, apex, out);
}

/**
 * Fast drive (spikes, block deflections): flight time from horizontal speed, slowed down
 * (loopier) until it clears the net.
 */
export function driveTo(from, target, speed, out, margin = 0.08) {
  const horiz = Math.hypot(target.x - from.x, target.z - from.z);
  let T = Math.max(0.22, horiz / Math.max(1, speed));
  for (let i = 0; i < 40; i++) {
    solveByTime(from, target, T, out);
    if (netClearance(from, out) >= margin) return T;
    T *= 1.07;
  }
  return T;
}

