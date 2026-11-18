// Chibi volleyball player: procedural model + procedural animation.
//   const c = createCharacter(look, teamColor);   // look = TEAMS[t].players[i]
//   scene.add(c.root); c.update(dt, playerState) every frame.
// The update loop allocates nothing: poses are preallocated Float32Arrays (see pose.js).
import * as THREE from 'three';
import { PLAYER, TEAMS } from '../config.js';
import { buildModel, DIM } from './build.js';
import { ACTIONS, windupPose } from './actions.js';
import { FACE } from './textures.js';
import { geo, toonMat, addOutline, tint } from './materials.js';
import {
  RIG_Y, RIG_Z, TILT_X, TILT_Z, SQ, CROUCH, HIPS_X, TORSO_X, TORSO_Y, TORSO_Z,
  HEAD_X, HEAD_Y, HEAD_Z, LSX, LSZ, LEL, RSX, RSZ, REL, SHRUG, ARM_ST, HAND_S,
  LFZ, LFY, RFZ, RFY, LEG_SPREAD,
  createPose, blendPose, clamp, clamp01, seg, smoothstep, easeInOutSine, easeOutBack,
} from './pose.js';

const TAU = Math.PI * 2;
const SCALE = PLAYER.height / DIM.height;
const MAX_RUN_SPEED = 5.5;
const BLEND_OUT = 0.2;   // s, action -> locomotion after the action's duration
const XFADE = 0.12;      // s, crossfade whenever the action changes abruptly
const XFADE_SNAP = 0.05; // s, crossfade from a held wind-up into the spike swing
const SPIKE_SKIP = 0.18; // s, a spike released from a wind-up skips its own anticipation
const L1 = DIM.thigh;
const L2 = DIM.shin;
const LEG_REST = -DIM.hipJoint + DIM.hipY - DIM.ankleY; // hip joint -> ankle at rest (0.285)

// ---- controlled-player indicator geometry (shared) ----
function ringGeometry() {
  return geo('controlRing', () => {
    const inner = 0.3;
    const outer = 0.62;
    const g = new THREE.RingGeometry(inner, outer, 40, 3);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      const u = (r - inner) / (outer - inner); // 0, 1/3, 2/3, 1
      const a = u < 0.15 ? 0.05 : u < 0.5 ? 1.0 : u < 0.85 ? 0.75 : 0.0;
      col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = a; // tint = material color
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

function arrowGeometry() {
  return geo('controlArrow', () => {
    const g = new THREE.ConeGeometry(0.11, 0.2, 8);
    g.rotateX(Math.PI); // point down
    return g;
  });
}

function jerseyNumber(look) {
  for (let t = 0; t < TEAMS.length; t++) {
    const idx = TEAMS[t].players.indexOf(look);
    if (idx >= 0) return idx + 1;
  }
  for (let t = 0; t < TEAMS.length; t++) {
    const idx = TEAMS[t].players.findIndex((p) => p.name === look.name);
    if (idx >= 0) return idx + 1;
  }
  return 1;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const fin = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

export function createCharacter(look, teamColor) {
  look = look || {};
  const color = teamColor ?? look.shirt ?? '#ff8fab';
  const number = jerseyNumber(look);
  const m = buildModel(look, color, number);
  const { root, rig, hips, torso, neck, face, faceMats, armL, armR, legL, legR, pigtails, bun } = m;

  // ---- indicator: soft ring on the sand + bobbing arrow over the head ----
  const ringMat = new THREE.MeshBasicMaterial({
    color: tint(color, '#ffffff', 0.12),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeometry(), ringMat);
  ring.name = 'controlRing';
  ring.renderOrder = 2;
  ring.visible = false;
  root.add(ring);

  const marker = new THREE.Group();
  marker.name = 'controlMarker';
  marker.visible = false;
  const arrow = new THREE.Mesh(arrowGeometry(), toonMat(tint(color, '#ffffff', 0.15)));
  addOutline(arrow, 1.18);
  marker.add(arrow);
  root.add(marker);

  // ---- animation state (all preallocated) ----
  const idle = createPose();
  const run = createPose();
  const air = createPose();
  const base = createPose();
  const act = createPose();
  const blended = createPose();
  const xfrom = createPose();
  const fin_ = createPose();
  const ctx = { air: 0, seed: 0 };

  const seedHash = hashString(String(look.name || 'player'));
  const seed = (seedHash % 1000) / 1000 * TAU;
  ctx.seed = seed;
  let rng = seedHash || 1;
  const rand = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };

  let time = 0;
  let speedSm = 0;
  let fwdSm = 0;
  let sideSm = 0;
  let runPhase = seed;
  let airW = 0;
  let wasAirborne = false;
  let airVy = 0;
  let landT = 99;
  let landS = 0;
  let curAction = null;
  let lastAt = 0;
  let xfT = XFADE;
  let xfDur = XFADE;
  let actOffset = 0;
  let windW = 0;
  let windC = 0;
  let blinkTimer = 1 + rand() * 2;
  let blinkLeft = 0;
  let curExpr = FACE.NORMAL;
  let jig = 0;
  let jigV = 0;
  let indW = 0;
  let markerSpin = 0;

  // ---------- locomotion poses ----------
  function idlePose(o, t) {
    const br = Math.sin(t * 2.4);
    const bounce = 0.5 + 0.5 * Math.sin(t * 4.2);
    o[RIG_Y] = 0; o[RIG_Z] = 0;
    o[TILT_X] = 0.02;
    o[TILT_Z] = 0.025 * Math.sin(t * 1.1);
    o[SQ] = 0.02 * br - 0.012 * bounce;
    o[CROUCH] = 0.055 + 0.022 * bounce;           // knees bent, bouncing on the balls of the feet
    o[HIPS_X] = 0.008 * Math.sin(t * 1.1);
    o[TORSO_X] = 0.12 + 0.015 * br;
    o[TORSO_Y] = 0.04 * Math.sin(t * 0.8);
    o[TORSO_Z] = 0;
    o[HEAD_X] = -0.1 + 0.02 * br;
    o[HEAD_Y] = 0.1 * Math.sin(t * 0.37);
    o[HEAD_Z] = 0.06 * Math.sin(t * 1.1 + 0.6);
    o[LSX] = 0.45 + 0.04 * br; o[RSX] = 0.45 + 0.04 * Math.sin(t * 2.4 + 0.4);
    o[LSZ] = 0.22; o[RSZ] = 0.22;
    o[LEL] = 1.0; o[REL] = 1.0;
    o[SHRUG] = 0.006 * br;
    o[ARM_ST] = 1; o[HAND_S] = 1;
    o[LFZ] = 0.035; o[LFY] = 0; o[RFZ] = -0.02; o[RFY] = 0;
    o[LEG_SPREAD] = 0.14;
  }

  function runPose(o, phase, sn, fwdN, sideN) {
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const c2 = Math.cos(2 * phase);
    const stride = 0.08 + 0.08 * sn;
    const lift = 0.05 + 0.06 * sn;
    o[LFZ] = s * stride; o[LFY] = Math.max(0, c) * lift;
    o[RFZ] = -s * stride; o[RFY] = Math.max(0, -c) * lift;
    o[CROUCH] = 0.05 + 0.045 * (0.5 - 0.5 * c2) * (0.4 + sn);  // dip at full stride
    o[RIG_Y] = 0.018 * sn * Math.max(0, c2);                 // tiny flight phase
    o[RIG_Z] = 0;
    o[SQ] = 0.04 * (0.3 + sn) * c2;
    o[TILT_X] = 0.24 * fwdN + 0.03;
    o[TILT_Z] = -0.16 * sideN;
    o[HIPS_X] = 0.012 * s;
    o[TORSO_X] = 0.06 + 0.06 * sn;
    o[TORSO_Y] = 0.2 * (0.3 + sn) * s;
    o[TORSO_Z] = 0;
    o[HEAD_X] = -0.65 * (0.24 * fwdN + 0.06 * sn);
    o[HEAD_Y] = -0.1 * (0.3 + sn) * s;
    o[HEAD_Z] = 0.04 * c;
    const amp = 0.45 + 0.75 * sn;
    o[LSX] = 0.25 - s * amp; o[RSX] = 0.25 + s * amp;
    o[LSZ] = 0.18; o[RSZ] = 0.18;
    o[LEL] = 1.25; o[REL] = 1.25;
    o[SHRUG] = 0.01 * c2;
    o[ARM_ST] = 1; o[HAND_S] = 1;
    o[LEG_SPREAD] = 0.05;
  }

  function airPose(o, vy) {
    const r = clamp(vy / PLAYER.jumpVelocity, -1, 1);
    const u = clamp01((1 - r) * 0.5); // 0 = rising fast, 1 = falling fast
    o[SQ] = 0.1 * (1 - u) - 0.02 * u;
    o[CROUCH] = 0;
    o[RIG_Y] = 0;
    o[LFY] = 0.03 + 0.11 * u; o[RFY] = 0.06 + 0.09 * u;
    o[LFZ] = -0.03 + 0.08 * u; o[RFZ] = 0.04 + 0.03 * u;
    o[LEG_SPREAD] = 0.1;
    const sx = 0.5 + 0.9 * (1 - u);
    o[LSX] = sx; o[RSX] = sx;
    o[LSZ] = 0.45; o[RSZ] = 0.45;
    o[LEL] = 0.45; o[REL] = 0.45;
    o[TILT_X] *= 0.5;
    o[TORSO_X] = 0.04;
    o[HEAD_X] = -0.15 * (1 - u);
  }

  // ---------- apply pose to the rig ----------
  function solveLeg(leg, footZ, footY, crouch, spread) {
    const ty = DIM.ankleY + footY - (DIM.hipY + DIM.hipJoint - crouch);
    const tz = footZ;
    let d = Math.sqrt(ty * ty + tz * tz);
    if (d > L1 + L2 - 1e-4) d = L1 + L2 - 1e-4;
    if (d < 0.06) d = 0.06;
    const baseA = Math.atan2(tz, -ty);
    const a1 = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const kneeIn = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const knee = Math.PI - kneeIn;
    const thighFwd = baseA + a1;
    leg.hip.rotation.set(-thighFwd, 0, leg.side * spread);
    leg.knee.rotation.x = knee;
    leg.ankle.rotation.x = thighFwd - knee;
  }

  function applyArm(arm, sx, sz, el, st, hs, shrug) {
    arm.shoulder.position.y = DIM.shoulderY + shrug;
    arm.shoulder.rotation.set(-sx, 0, arm.side * sz);
    arm.upper.scale.y = st;
    arm.upper.position.y = -DIM.upperArm * 0.5 * st;
    arm.elbow.position.y = -DIM.upperArm * st;
    arm.elbow.rotation.x = -el;
    arm.fore.scale.y = st;
    arm.fore.position.y = -DIM.forearmCenter * st;
    arm.hand.position.y = -DIM.handY * st;
    arm.hand.scale.setScalar(0.058 * hs);
  }

  function applyPose(o) {
    rig.position.set(0, o[RIG_Y], o[RIG_Z]);
    rig.rotation.set(o[TILT_X], 0, o[TILT_Z]);
    const sy = 1 + clamp(o[SQ], -0.45, 0.45);
    const sxz = 1 / Math.sqrt(sy);
    rig.scale.set(SCALE * sxz, SCALE * sy, SCALE * sxz);
    hips.position.set(o[HIPS_X], DIM.hipY - o[CROUCH], 0);
    torso.rotation.set(o[TORSO_X], o[TORSO_Y], o[TORSO_Z]);
    neck.rotation.set(o[HEAD_X], o[HEAD_Y], o[HEAD_Z]);
    const st = clamp(o[ARM_ST], 0.6, 1.8);
    applyArm(armL, o[LSX], o[LSZ], o[LEL], st, o[HAND_S], o[SHRUG]);
    applyArm(armR, o[RSX], o[RSZ], o[REL], st, o[HAND_S], o[SHRUG]);
    solveLeg(legL, o[LFZ], o[LFY], o[CROUCH], o[LEG_SPREAD]);
    solveLeg(legR, o[RFZ], o[RFY], o[CROUCH], o[LEG_SPREAD]);
  }

  // ---------- per-frame ----------
  function update(dt, p) {
    dt = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
    if (!p) return;
    time += dt;

    const pos = p.pos;
    const px = pos ? fin(pos.x, 0) : 0;
    const py = pos ? fin(pos.y, 0) : 0;
    const pz = pos ? fin(pos.z, 0) : 0;
    root.position.set(px, py, pz);
    const facing = fin(p.facing, 0);
    root.rotation.set(0, facing, 0);

    const vel = p.vel;
    const vx = vel ? fin(vel.x, 0) : 0;
    const vy = vel ? fin(vel.y, 0) : 0;
    const vz = vel ? fin(vel.z, 0) : 0;

    // --- locomotion ---
    const speed = Math.sqrt(vx * vx + vz * vz);
    const sinF = Math.sin(facing);
    const cosF = Math.cos(facing);
    const fwd = vx * sinF + vz * cosF;
    const side = vx * cosF - vz * sinF;
    const kv = 1 - Math.exp(-dt * 12);
    speedSm += (speed - speedSm) * kv;
    fwdSm += (fwd - fwdSm) * kv;
    sideSm += (side - sideSm) * kv;
    const sn = clamp01(speedSm / MAX_RUN_SPEED);
    const dir = fwdSm < -0.35 * speedSm ? -1 : 1;
    if (speedSm > 0.05) runPhase += dt * TAU * (1.5 + 1.7 * sn) * dir;
    if (runPhase > 1000 || runPhase < -1000) runPhase %= TAU;

    idlePose(idle, time + seed);
    runPose(run, runPhase, sn, clamp(fwdSm / MAX_RUN_SPEED, -1, 1), clamp(sideSm / MAX_RUN_SPEED, -1, 1));
    blendPose(base, idle, run, smoothstep(0.1, 1.4, speedSm));

    // --- airborne ---
    const airborne = p.grounded === false || py > 0.03;
    airW += ((airborne ? 1 : 0) - airW) * (1 - Math.exp(-dt * (airborne ? 20 : 30)));
    if (airborne) airVy = vy;
    if (wasAirborne && !airborne) {
      landT = 0;
      landS = clamp(-airVy / 7, 0.35, 1);
      jigV += 3 * landS;
    }
    wasAirborne = airborne;
    landT += dt;
    if (airW > 0.001) {
      air.set(base);
      airPose(air, vy);
      blendPose(base, base, air, airW);
    }
    ctx.air = airW;

    // --- action ---
    const action = typeof p.action === 'string' ? p.action : null;
    const at = Math.max(0, fin(p.actionTime, 0));
    if (action !== curAction || at + 1e-4 < lastAt) {
      xfrom.set(blended);
      xfT = 0;
      // released from a held wind-up: jump straight into the swing, with a short crossfade
      const fromWindup = action === 'spike' && windW > 0.3;
      actOffset = fromWindup ? SPIKE_SKIP : 0;
      xfDur = fromWindup ? XFADE_SNAP : XFADE;
      if (fromWindup) windW = 0;
      curAction = action;
    }
    lastAt = at;
    const info = action !== null ? ACTIONS[action] : undefined;
    const ta = at + actOffset;
    let w = 0;
    if (info) w = ta < info.dur ? 1 : 1 - easeInOutSine(seg(ta, info.dur, info.dur + BLEND_OUT));
    blended.set(base);
    if (w > 0) {
      act.set(base);
      info.pose(act, ta, ctx);
      blendPose(blended, base, act, w);
    }

    // --- spike wind-up (p.windup 0..1 while the attack button is held; null/missing = none) ---
    const wu = p.windup;
    const winding = typeof wu === 'number' && Number.isFinite(wu) && action !== 'spike';
    if (winding) windC = clamp01(wu);
    windW += ((winding ? 1 : 0) - windW) * (1 - Math.exp(-dt * (winding ? 18 : 12)));
    if (windW > 0.002) {
      act.set(blended);
      windupPose(act, windC, time, ctx);
      blendPose(blended, blended, act, windW);
    }

    if (xfT < xfDur) blendPose(blended, xfrom, blended, easeInOutSine(xfT / xfDur));
    xfT += dt;

    // --- additive secondary motion ---
    fin_.set(blended);
    if (landT < 1) {
      const env = Math.exp(-landT * 9);
      const osc = Math.cos(landT * 17);
      fin_[SQ] += -0.2 * landS * env * osc;
      fin_[CROUCH] += 0.09 * landS * env;
      fin_[HEAD_X] += 0.12 * landS * env * osc;
      fin_[LSZ] += 0.2 * landS * env;
      fin_[RSZ] += 0.2 * landS * env;
    }
    // hair jiggle spring (pigtails / bun)
    const target = clamp(-vy * 0.06, -0.25, 0.45) - fin_[SQ] * 1.5;
    if (dt > 0) {
      jigV += (150 * (target - jig) - 9 * jigV) * dt;
      jig += jigV * dt;
      jig = clamp(jig, -0.8, 0.8);
    }

    applyPose(fin_);

    for (let i = 0; i < pigtails.length; i++) {
      const pt = pigtails[i];
      pt.group.rotation.set(0.1 + jig * 0.35, 0, pt.side * (0.25 + jig * 0.8));
    }
    if (bun) {
      const b = 0.37 * (1 + jig * 0.12);
      bun.scale.set(0.37 * (1 - jig * 0.05), b, 0.37 * (1 - jig * 0.05));
    }

    // --- face ---
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
      blinkLeft = 0.12;
      blinkTimer = rand() < 0.15 ? 0.22 : 1.6 + rand() * 3.2;
    }
    blinkLeft -= dt;
    let expr = blinkLeft > 0 ? FACE.BLINK : FACE.NORMAL;
    if (windW > 0.5) expr = FACE.DETERMINED;
    if (info && w > 0.5 && info.face >= 0) expr = info.face;
    if (face && expr !== curExpr) {
      face.material = faceMats[expr];
      curExpr = expr;
    }

    // --- controlled indicator ---
    const want = p.controlled ? 1 : 0;
    indW += (want - indW) * (1 - Math.exp(-dt * 10));
    const show = indW > 0.002;
    ring.visible = show;
    marker.visible = show;
    if (show) {
      const pulse = Math.sin(time * 5);
      ringMat.opacity = indW * (0.82 + 0.18 * pulse);
      const rs = (0.75 + 0.25 * easeOutBack(clamp01(indW))) * (1 + 0.05 * pulse) * SCALE;
      ring.scale.set(rs, 1, rs);
      ring.position.set(0, 0.02 - py, 0); // stays on the sand while the body jumps
      markerSpin += dt * 2.2;
      if (markerSpin > TAU) markerSpin -= TAU;
      marker.rotation.set(0, markerSpin, 0);
      marker.position.set(0, (1.62 + 0.06 * Math.sin(time * 5) + fin_[RIG_Y]) * SCALE, 0);
      marker.scale.setScalar(Math.max(0.001, easeOutBack(clamp01(indW))));
    }
  }

  return { root, update };
}
