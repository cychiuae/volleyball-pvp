// AI for CPU players and the human's teammate: picks a move target each step and
// triggers jumps (attacks/blocks) and dives through the game context `g`.
//
// Perception: balls hit by the opponent are seen through g.trajFor(team), which returns the
// trajectory as it was `reaction` seconds ago (DIFFICULTY.reaction). Partner touches are known
// immediately.
import { Vector3 } from 'three';
import { COURT, PLAYER } from '../config.js';
import { clamp, isClearlyOut, side, teamOfZ } from './rules.js';
import { ATTACK_CONTACT_Y, BUMP_CONTACT_Y, SET_CONTACT_Y } from './shots.js';

const JUMP_TO_APEX = PLAYER.jumpVelocity / PLAYER.gravity;
const tmp = new Vector3();

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function aiThink(g, p) {
  const { state, sim } = g;
  const b = g.brains[p.id];
  const T = p.team;
  const s = side(T);

  if (sim.mode === 'serve') { b.target.copy(sim.formation[p.id]); return; }
  if (sim.mode !== 'rally') { b.target.set(p.pos.x, 0, p.pos.z); return; }

  const ball = state.ball;
  const tr = g.trajFor(T);
  if (!tr) return; // nothing perceived yet: keep the previous target

  const landTeam = tr.hasLanding ? teamOfZ(tr.landing.z) : teamOfZ(ball.pos.z);
  const ours = state.possessionTeam === T && ball.lastTeam === T;
  if (ours && state.touches >= 1 && state.touches <= 2 && !sim.serveUntouched && landTeam === T) {
    buildPlay(g, p, b, tr, s);
    return;
  }
  const spent = ours && state.touches >= 3;
  const servingSide = sim.serveUntouched && T === state.servingTeam;
  if (landTeam === T && !spent && !servingSide) {
    receive(g, p, b, tr, s);
    return;
  }
  defend(g, p, b, tr, s);
}

function receive(g, p, b, tr, s) {
  const { state, sim } = g;
  const T = p.team;
  const letGo = !sim.misjudge[T] && tr.hasLanding && state.ball.lastTeam !== T &&
    isClearlyOut(tr.landing.x, tr.landing.z);
  if (letGo) { basePosition(g, p, b, s); return; }
  if (sim.designated[T] === p.id) {
    if (g.intercept(tr, BUMP_CONTACT_Y, tmp) >= 0) b.target.set(tmp.x, 0, tmp.z);
    g.maybeDive(p, tr);
  } else if (g.isHuman(state.players[sim.designated[T]] || p) && g.humanOutOfPosition(tr)) {
    // Momo is nowhere near her ball: scramble for it.
    if (g.intercept(tr, 0.6, tmp) >= 0) b.target.set(tmp.x, 0, tmp.z);
    g.maybeDive(p, tr);
  } else {
    // Partner gets ready to set near the net.
    b.target.set(clamp(p.pos.x, -2.2, 2.2) * 0.6, 0, s * 2.0);
  }
}

function buildPlay(g, p, b, tr, s) {
  const { state, sim } = g;
  const next = sim.designated[p.team];
  const mate = state.players[p.id ^ 1];
  if (state.touches === 1) {
    if (p.id === next) {
      if (g.intercept(tr, SET_CONTACT_Y, tmp) >= 0) b.target.set(tmp.x, 0, tmp.z);
      g.maybeDive(p, tr);
    } else {
      // Passer swings out to an approach start, away from the setter.
      let x = clamp(p.pos.x, -2.6, 2.6);
      if (Math.abs(x - mate.pos.x) < 1.4) x = clamp(mate.pos.x + (x >= mate.pos.x ? 1.4 : -1.4), -3, 3);
      b.target.set(x, 0, s * 3.3);
    }
    return;
  }
  // touches === 2
  if (p.id === next) attack(g, p, b, tr, s);
  else b.target.set(clamp(p.pos.x, -2.5, 2.5), 0, s * 3.6); // setter covers the attacker
}

function attack(g, p, b, tr, s) {
  const { sim, rng } = g;
  const prof = g.profileFor(p.team);
  if (b.intentKey !== sim.touchSerial) {
    b.intentKey = sim.touchSerial;
    b.intent = rng.chance(prof.spikeChance) ? 'spike' : (rng.chance(0.5) ? 'dink' : 'free');
    b.jitter = rng.gauss() * (0.015 + prof.reaction * 0.1);
  }
  if (b.intent === 'free') {
    if (g.intercept(tr, BUMP_CONTACT_Y, tmp) >= 0) b.target.set(tmp.x, 0, tmp.z);
    return;
  }
  const tHit = g.intercept(tr, ATTACK_CONTACT_Y, tmp);
  if (tHit < 0) return;
  const az = Math.max(0.55, Math.abs(tmp.z) + 0.2);
  b.target.set(tmp.x, 0, s * az);
  if (p.grounded && sim.now >= tHit - JUMP_TO_APEX + b.jitter && sim.now < tHit + 0.12 &&
      hdist(p.pos, b.target) < 0.9) {
    g.jump(p, 'attack');
  }
}

function defend(g, p, b, tr, s) {
  const { state, sim, rng } = g;
  const T = p.team;
  const O = 1 - T;
  const ball = state.ball;
  const prof = g.profileFor(T);
  const oppSet = state.possessionTeam === O && ball.lastTeam === O && state.touches === 2 &&
    tr.t0 >= sim.lastTouchTime - 1e-6 && tr.hasLanding && teamOfZ(tr.landing.z) === O;
  if (oppSet) {
    const tHit = g.intercept(tr, ATTACK_CONTACT_Y, tmp);
    const plan = sim.blockPlan[T];
    if (plan.key !== sim.touchSerial) {
      plan.key = sim.touchSerial;
      plan.blockerId = -1;
      if (rng.chance(prof.blockChance)) {
        let best = -1;
        let bestD = Infinity;
        for (const q of state.players) {
          if (q.team !== T || g.isHuman(q)) continue;
          const d = Math.hypot(q.pos.x - tmp.x, q.pos.z - s * 0.5);
          if (d < bestD) { bestD = d; best = q.id; }
        }
        plan.blockerId = best;
      }
      plan.jitter = rng.gauss() * prof.reaction * 0.2;
      plan.xNoise = rng.gauss() * (0.25 + prof.aimNoise * 0.3);
    }
    if (p.id === plan.blockerId) {
      b.target.set(clamp(tmp.x + plan.xNoise, -COURT.halfWidth, COURT.halfWidth), 0, s * 0.45);
      if (p.grounded && tHit >= 0 && sim.now >= tHit - JUMP_TO_APEX + 0.07 + plan.jitter &&
          sim.now < tHit + 0.3 && hdist(p.pos, b.target) < 1.0) {
        g.jump(p, 'block');
      }
    } else if (plan.blockerId >= 0) {
      b.target.set(clamp(-tmp.x * 0.35, -2, 2), 0, s * 5.0); // cover behind the block
    } else {
      basePosition(g, p, b, s);
    }
    return;
  }
  basePosition(g, p, b, s);
}

/** Split left/right defensive bases; deep middle if the (human) partner is at the net. */
function basePosition(g, p, b, s) {
  const mate = g.state.players[p.id ^ 1];
  if (g.isHuman(mate) && Math.abs(mate.pos.z) < 1.8) {
    b.target.set(0, 0, s * 5.0);
    return;
  }
  const left = p.pos.x < mate.pos.x || (p.pos.x === mate.pos.x && p.index === 0);
  b.target.set(left ? -2.0 : 2.0, 0, s * 4.8);
}
