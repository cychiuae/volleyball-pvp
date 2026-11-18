// Procedural action poses. Each pose fn receives `o` pre-filled with the current base
// (locomotion + air) pose and overwrites the channels it cares about, as a function of
// t = seconds since the action started. The character blends base -> action by weight.
import {
  RIG_Y, TILT_X, TILT_Z, SQ, CROUCH, TORSO_X, TORSO_Y, TORSO_Z, HEAD_X, HEAD_Y, HEAD_Z,
  LSX, LSZ, LEL, RSX, RSZ, REL, SHRUG, ARM_ST, HAND_S, LFZ, LFY, RFZ, RFY, LEG_SPREAD,
  seg, lerp, k3, easeOutCubic, easeInQuad, easeInOutSine, easeOutBack,
} from './pose.js';
import { FACE } from './textures.js';

const PI = Math.PI;

// ctx: { air: 0..1 airborne weight, seed: per-character phase offset }

function bump(o, t) {
  const a = easeOutCubic(seg(t, 0, 0.1));       // drop into platform
  const push = easeOutCubic(seg(t, 0.1, 0.24)); // legs drive up
  const rel = easeInOutSine(seg(t, 0.26, 0.45)); // settle
  o[CROUCH] = lerp(lerp(o[CROUCH], 0.16, a), 0.03, push);
  o[TORSO_X] = lerp(lerp(o[TORSO_X], 0.32, a), 0.16, push);
  o[TILT_X] = lerp(o[TILT_X], 0.05, a);
  o[TORSO_Y] = lerp(o[TORSO_Y], 0, a);
  o[HEAD_X] = lerp(o[HEAD_X], -0.18, a);
  const sx = lerp(lerp(o[LSX], 0.85, a), 1.2, push);
  o[LSX] = sx; o[RSX] = sx;
  o[LSZ] = lerp(o[LSZ], -0.42, a); o[RSZ] = lerp(o[RSZ], -0.42, a);
  o[LEL] = lerp(o[LEL], 0.02, a); o[REL] = lerp(o[REL], 0.02, a);
  o[SHRUG] = 0.02 * push;
  o[RIG_Y] = 0.025 * push * (1 - rel);
  o[SQ] = -0.07 * a * (1 - push) + 0.07 * push * (1 - rel);
  o[LFZ] = lerp(o[LFZ], 0.07, a); o[RFZ] = lerp(o[RFZ], -0.04, a);
  o[LFY] *= 1 - a; o[RFY] *= 1 - a;
  o[LEG_SPREAD] = lerp(o[LEG_SPREAD], 0.18, a);
}

function set(o, t) {
  const a = easeOutBack(seg(t, 0, 0.13));        // hands up to the forehead
  const push = easeOutCubic(seg(t, 0.13, 0.28)); // flick up
  const rel = easeInOutSine(seg(t, 0.3, 0.45));
  const sx = lerp(lerp(o[LSX], 2.35, a), 2.8, push);
  o[LSX] = sx; o[RSX] = sx;
  o[LSZ] = lerp(lerp(o[LSZ], 0.3, a), 0.22, push);
  o[RSZ] = o[LSZ];
  const el = lerp(lerp(o[LEL], 1.0, a), 0.15, push);
  o[LEL] = el; o[REL] = el;
  o[SHRUG] = 0.05 * a;
  o[ARM_ST] = lerp(1, 1.18, a) + 0.08 * push;
  o[HAND_S] = 1 + 0.12 * a;
  o[HEAD_X] = lerp(o[HEAD_X], -0.38, a);
  o[TORSO_X] = lerp(o[TORSO_X], -0.12, a);
  o[TORSO_Y] = lerp(o[TORSO_Y], 0, a);
  o[CROUCH] = lerp(lerp(o[CROUCH], 0.12, a), 0.0, push);
  o[RIG_Y] = 0.03 * push * (1 - rel);
  o[SQ] = -0.05 * a * (1 - push) + 0.08 * push * (1 - rel);
  o[LFY] *= 1 - a; o[RFY] *= 1 - a;
}

function spike(o, t, ctx) {
  const cock = easeOutCubic(seg(t, 0, 0.2));
  const sw = easeInQuad(seg(t, 0.2, 0.29)); // whip!
  const fol = easeOutCubic(seg(t, 0.29, 0.6));
  // hitting (right) arm: cocked behind the head -> fast swing through -> across the body
  o[RSX] = k3(o[RSX], 3.0, 0.55, 0.3, cock, sw, fol);
  o[REL] = k3(o[REL], 2.1, 0.1, 0.25, cock, sw, fol);
  o[RSZ] = k3(o[RSZ], 0.35, 0.05, -0.2, cock, sw, fol);
  // guide (left) arm points at the ball, then yanks down
  o[LSX] = k3(o[LSX], 2.6, 0.5, 0.45, cock, sw, fol);
  o[LEL] = k3(o[LEL], 0.25, 0.4, 0.6, cock, sw, fol);
  o[LSZ] = k3(o[LSZ], 0.35, 0.55, 0.4, cock, sw, fol);
  o[ARM_ST] = k3(1, 1.2, 1.25, 1, cock, sw, fol);
  o[SHRUG] = 0.05 * cock * (1 - fol);
  // body: arch back, crunch forward
  o[TORSO_X] = k3(o[TORSO_X], -0.38, 0.45, 0.18, cock, sw, fol);
  o[TORSO_Y] = k3(o[TORSO_Y], -0.5, 0.4, 0.15, cock, sw, fol);
  o[TORSO_Z] = k3(o[TORSO_Z], -0.1, 0.06, 0, cock, sw, fol);
  o[HEAD_X] = k3(o[HEAD_X], -0.18, 0.12, 0.05, cock, sw, fol);
  o[SQ] = k3(o[SQ], 0.07, -0.11, 0, cock, sw, fol);
  // legs bow back during the arch, then jackknife forward (only when airborne)
  const air = ctx.air;
  o[LFZ] = lerp(o[LFZ], k3(o[LFZ], -0.1, 0.08, 0.02, cock, sw, fol), air);
  o[RFZ] = lerp(o[RFZ], k3(o[RFZ], -0.06, 0.05, 0.0, cock, sw, fol), air);
  o[LFY] = lerp(o[LFY], k3(o[LFY], 0.13, 0.16, 0.06, cock, sw, fol), air);
  o[RFY] = lerp(o[RFY], k3(o[RFY], 0.09, 0.12, 0.04, cock, sw, fol), air);
}

function serveToss(o, t) {
  const dip = easeInOutSine(seg(t, 0, 0.15));
  const toss = easeOutCubic(seg(t, 0.15, 0.35));
  const cock = easeOutCubic(seg(t, 0.2, 0.45));
  o[LSX] = k3(o[LSX], 0.75, 3.0, 3.0, dip, toss, 0);
  o[LEL] = k3(o[LEL], 0.7, 0.05, 0.05, dip, toss, 0);
  o[LSZ] = k3(o[LSZ], 0.05, 0.18, 0.18, dip, toss, 0);
  o[RSX] = k3(o[RSX], 0.5, 2.8, 2.8, dip, cock, 0);
  o[REL] = k3(o[REL], 0.6, 1.9, 1.9, dip, cock, 0);
  o[RSZ] = lerp(o[RSZ], 0.35, cock);
  o[ARM_ST] = 1 + 0.15 * toss;
  o[SHRUG] = 0.04 * toss;
  o[CROUCH] = k3(o[CROUCH], 0.11, 0.0, 0.0, dip, toss, 0);
  o[SQ] = -0.05 * dip * (1 - toss) + 0.06 * toss;
  o[TORSO_Y] = lerp(o[TORSO_Y], -0.35, cock);
  o[TORSO_X] = lerp(lerp(o[TORSO_X], 0.12, dip), -0.16, toss);
  o[HEAD_X] = lerp(o[HEAD_X], -0.42, toss);
  o[LFZ] = lerp(o[LFZ], 0.08, dip); o[RFZ] = lerp(o[RFZ], -0.06, dip);
  o[LFY] *= 1 - dip; o[RFY] *= 1 - dip;
  // tiny rise onto the toes at the top of the toss
  o[RIG_Y] = 0.012 * toss;
}

function serveHit(o, t) {
  const hold = easeOutCubic(seg(t, 0, 0.06));
  const sw = easeInQuad(seg(t, 0.06, 0.16));
  const fol = easeOutCubic(seg(t, 0.16, 0.55));
  o[RSX] = k3(o[RSX], 2.8, 0.5, 0.25, hold, sw, fol);
  o[REL] = k3(o[REL], 1.9, 0.1, 0.3, hold, sw, fol);
  o[RSZ] = k3(o[RSZ], 0.35, 0.0, -0.18, hold, sw, fol);
  o[LSX] = k3(o[LSX], 2.4, 0.4, 0.35, hold, sw, fol);
  o[LEL] = k3(o[LEL], 0.2, 0.5, 0.6, hold, sw, fol);
  o[LSZ] = k3(o[LSZ], 0.2, 0.45, 0.3, hold, sw, fol);
  o[ARM_ST] = k3(1, 1.15, 1.2, 1, hold, sw, fol);
  o[TORSO_Y] = k3(o[TORSO_Y], -0.35, 0.45, 0.22, hold, sw, fol);
  o[TORSO_X] = k3(o[TORSO_X], -0.16, 0.36, 0.14, hold, sw, fol);
  o[HEAD_X] = k3(o[HEAD_X], -0.3, 0.06, 0.0, hold, sw, fol);
  o[SQ] = k3(o[SQ], 0.05, -0.09, 0, hold, sw, fol);
  // step through with the right foot
  o[RFZ] = k3(o[RFZ], -0.06, 0.02, 0.1, hold, sw, fol);
  o[RFY] = 0.06 * Math.sin(PI * seg(t, 0.12, 0.4));
  o[LFZ] = lerp(o[LFZ], 0.06, hold);
}

function block(o, t) {
  const up = easeOutBack(seg(t, 0, 0.12));
  const sx = lerp(o[LSX], 3.02, up);
  o[LSX] = sx; o[RSX] = sx;
  o[LSZ] = lerp(o[LSZ], 0.24, up); o[RSZ] = o[LSZ];
  o[LEL] = lerp(o[LEL], 0, up); o[REL] = o[LEL];
  o[ARM_ST] = lerp(1, 1.6, up);
  o[SHRUG] = 0.08 * up;
  o[HAND_S] = 1 + 0.38 * up + 0.04 * Math.sin(t * 30) * up; // "spread hands" wiggle
  o[TORSO_X] = lerp(o[TORSO_X], 0.12, up);
  o[TORSO_Y] = lerp(o[TORSO_Y], 0, up);
  o[HEAD_X] = lerp(o[HEAD_X], -0.08, up);
  o[SQ] = lerp(o[SQ], 0.08, up);
}

function dive(o, t) {
  const ant = easeOutCubic(seg(t, 0, 0.1));
  const launch = easeOutCubic(seg(t, 0.08, 0.32));
  const rec = easeInOutSine(seg(t, 0.6, 0.85));
  o[TILT_X] = lerp(lerp(lerp(o[TILT_X], 0.35, ant), 1.32, launch), 0.12, rec);
  o[TILT_Z] = lerp(o[TILT_Z], 0, ant);
  const arc = Math.sin(PI * seg(t, 0.08, 0.38));
  o[RIG_Y] = (0.15 * launch + 0.12 * arc) * (1 - rec);
  o[CROUCH] = k3(o[CROUCH], 0.14, -0.05, 0.1, ant, launch, rec);
  // arms swing back then reach far forward
  const sx = k3(o[LSX], -0.5, 2.9, 0.4, ant, launch, rec);
  o[LSX] = sx; o[RSX] = sx;
  o[LSZ] = k3(o[LSZ], 0.2, 0.32, 0.2, ant, launch, rec); o[RSZ] = o[LSZ];
  o[LEL] = k3(o[LEL], 0.4, 0.05, 0.6, ant, launch, rec); o[REL] = o[LEL];
  o[ARM_ST] = lerp(1, 1.2, launch * (1 - rec));
  o[HAND_S] = 1 + 0.12 * launch * (1 - rec);
  o[TORSO_X] = k3(o[TORSO_X], 0.2, -0.05, 0.15, ant, launch, rec);
  o[TORSO_Y] = lerp(o[TORSO_Y], 0, ant);
  o[HEAD_X] = k3(o[HEAD_X], 0.1, -0.8, -0.05, ant, launch, rec);
  // legs kick back behind the body
  o[LFZ] = k3(o[LFZ], 0.0, -0.12, 0.04, ant, launch, rec);
  o[RFZ] = k3(o[RFZ], -0.05, -0.08, -0.03, ant, launch, rec);
  o[LFY] = k3(o[LFY], 0.0, 0.08, 0.0, ant, launch, rec);
  o[RFY] = k3(o[RFY], 0.0, 0.15, 0.0, ant, launch, rec);
  // stretch in flight, belly-flop squash on impact
  let sq = 0.09 * launch * (1 - seg(t, 0.3, 0.34));
  if (t > 0.34) {
    const u = t - 0.34;
    sq -= 0.13 * Math.exp(-u * 9) * Math.cos(u * 24);
  }
  o[SQ] = lerp(sq, o[SQ], rec);
}

function celebrate(o, t, ctx) {
  const ph = (t / 0.55) % 1;
  const hop = Math.sin(PI * ph);
  const land = 1 - hop;
  o[RIG_Y] = 0.16 * hop;
  o[SQ] = 0.09 * hop - 0.13 * land * land * land * land * land * land;
  o[CROUCH] = 0.09 * land * land * land;
  o[LFY] = 0.08 * hop; o[RFY] = 0.08 * hop;
  o[LFZ] = 0.02; o[RFZ] = -0.02;
  o[TILT_X] = 0; o[TILT_Z] = 0;
  const w = t * 14 + ctx.seed;
  o[LSX] = 2.75 + 0.28 * Math.sin(w);
  o[RSX] = 2.75 + 0.28 * Math.sin(w + PI);
  o[LSZ] = 0.55 + 0.22 * Math.sin(w * 0.5);
  o[RSZ] = 0.55 + 0.22 * Math.sin(w * 0.5 + PI);
  o[LEL] = 0.3; o[REL] = 0.3;
  o[ARM_ST] = 1.12;
  o[SHRUG] = 0.04;
  o[HAND_S] = 1.12;
  o[TORSO_X] = -0.08;
  o[TORSO_Y] = 0;
  o[TORSO_Z] = 0.08 * Math.sin(t * 7 + 1);
  o[HEAD_X] = -0.18;
  o[HEAD_Z] = 0.16 * Math.sin(t * 7);
  o[HEAD_Y] = 0;
}

function sad(o, t) {
  const br = Math.sin(t * 1.6);
  o[TORSO_X] = 0.32 + 0.03 * br;
  o[TORSO_Y] = 0;
  o[TORSO_Z] = 0;
  o[HEAD_X] = 0.42;
  o[HEAD_Y] = 0;
  o[HEAD_Z] = 0.1 * Math.sin(t * 0.7);
  o[LSX] = 0.05; o[RSX] = 0.05;
  o[LSZ] = 0.04; o[RSZ] = 0.04;
  o[LEL] = 0.12; o[REL] = 0.12;
  o[SHRUG] = -0.035;
  o[SQ] = -0.05 + 0.025 * br;
  o[CROUCH] = 0.03;
  o[TILT_X] = 0.05; o[TILT_Z] = 0;
  o[RIG_Y] = 0;
  // scuff the sand with one foot
  const k = t * 2.2;
  o[LFZ] = 0.0; o[LFY] = 0;
  o[RFZ] = 0.05 + 0.045 * Math.sin(k);
  o[RFY] = 0.018 * Math.max(0, Math.sin(k));
}

/**
 * Spike wind-up while the attack button is held (c = charge 0..1). Arm cocks early, the body
 * keeps arching as the charge fills; past ~0.82 a tiny strained wobble. Ends in (roughly) the
 * spike's own cocked pose so the released spike can start straight at the swing.
 */
export function windupPose(o, c, t, ctx) {
  const cock = easeOutCubic(seg(c, 0, 0.35));
  const arch = easeInOutSine(c);
  o[RSX] = lerp(o[RSX], 3.0, cock);
  o[REL] = lerp(o[REL], 2.0 + 0.25 * arch, cock);
  o[RSZ] = lerp(o[RSZ], 0.35, cock);
  o[LSX] = lerp(o[LSX], 2.45, cock);
  o[LEL] = lerp(o[LEL], 0.3, cock);
  o[LSZ] = lerp(o[LSZ], 0.38, cock);
  o[ARM_ST] = lerp(1, 1.15 + 0.08 * arch, cock);
  o[SHRUG] = 0.04 * cock + 0.03 * arch;
  o[TORSO_X] = lerp(o[TORSO_X], -0.2 - 0.3 * arch, cock);
  o[TORSO_Y] = lerp(o[TORSO_Y], -0.35 - 0.25 * arch, cock);
  o[TORSO_Z] = lerp(o[TORSO_Z], -0.1, cock);
  o[HEAD_X] = lerp(o[HEAD_X], -0.15 - 0.06 * arch, cock);
  o[SQ] = lerp(o[SQ], 0.03 + 0.05 * arch, cock);
  // legs bow back with the arch (only in the air)
  const air = ctx.air * cock;
  o[LFZ] = lerp(o[LFZ], -0.05 - 0.06 * arch, air);
  o[RFZ] = lerp(o[RFZ], -0.03 - 0.04 * arch, air);
  o[LFY] = lerp(o[LFY], 0.09 + 0.05 * arch, air);
  o[RFY] = lerp(o[RFY], 0.06 + 0.04 * arch, air);
  if (c > 0.82) {
    const s = (c - 0.82) / 0.18;
    const wob = (Math.sin(t * 47) * 0.03 + Math.sin(t * 31) * 0.02) * s;
    o[RSX] += wob;
    o[TORSO_Z] += wob * 0.6;
    o[HEAD_Z] += wob * 0.8;
    o[HAND_S] += 0.05 * s * Math.sin(t * 53);
    o[SQ] += 0.012 * s * Math.sin(t * 41);
  }
}

const L = Infinity;
// dur: seconds the pose is held at full weight (then blends out). face: expression or -1.
export const ACTIONS = {
  __proto__: null,
  bump:      { dur: 0.45, face: -1, pose: bump },
  set:       { dur: 0.45, face: -1, pose: set },
  spike:     { dur: 0.6, face: FACE.DETERMINED, pose: spike },
  serveToss: { dur: 0.9, face: FACE.DETERMINED, pose: serveToss },
  serveHit:  { dur: 0.55, face: FACE.DETERMINED, pose: serveHit },
  block:     { dur: 0.6, face: FACE.EFFORT, pose: block },
  dive:      { dur: 0.85, face: FACE.EFFORT, pose: dive },
  celebrate: { dur: L, face: FACE.HAPPY, pose: celebrate },
  sad:       { dur: L, face: FACE.SAD, pose: sad },
};

export const ACTION_NAMES = Object.keys(ACTIONS);
