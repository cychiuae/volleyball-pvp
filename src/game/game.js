// Cute Beach Volley simulation. Owns `game.state` (see docs/ARCHITECTURE.md) and emits all
// gameplay events. Runs headless in Node: only `three` math is imported.
//
// Structure: fixed 1/120 s steps (ball sub-stepped at 1/240 s). Each step: serve/point flow ->
// who-plays-next bookkeeping -> players (human input or AI) -> ball physics + rules ->
// blocks/touches -> aim reticle.
//
// Humans: any of the 4 players can be human (`inputs[id]`, null = AI). Every human has its own
// timing-meter state (`hs[id]`: pass/spike meter episodes, serve charge, J hold, swing window,
// pass press, aim, dive). Offline `createGame({ input })` = input on player 0, others AI.
// Lag compensation (docs/NETWORK.md): inputs with the optional `edgeTime(action)` method are
// graded at the time the player SAW (rewind <= NET.maxRewind); a good press that arrives after
// the predicted contact touches the ball retroactively on the stored trajectory.
import { Vector3 } from 'three';
import { BALL, COURT, DIFFICULTY, METER, NET, PLAYER, RULES } from '../config.js';
import { solveByApex } from './ballistics.js';
import {
  BALL_SUBSTEP, SAMPLE_DT, createStepResult, createTrajectory, predictTrajectory, stepBall,
} from './physics.js';
import { clamp, isClearlyOut, isInBounds, judgeLanding, matchWinner, side, teamOfZ } from './rules.js';
import { createRng } from './rng.js';
import {
  ATTACK_CONTACT_Y, ATTACK_SPOT_Z, BUMP_CONTACT_Y, PASS_APEX, SET_APEX, SET_CONTACT_Y, SET_SPOT_Z,
  driveTo, lobTo,
} from './shots.js';
import { aiThink } from './ai.js';
import { createNullInput } from './input.js';

const DT = 1 / 120;
const SUBSTEPS = Math.max(1, Math.round(DT / BALL_SUBSTEP));
const R = BALL.radius;
const NH = COURT.netHeight;
const TRAJ_POOL = 12;
const HISTORY = 6;

// Tuning knobs.
export const TUNING = {
  humanReachMul: 1.2,       // reach assist for the human-controlled player
  diveReachBonus: 0.5,      // extra reach while diving (on top of the lunge itself)
  overchargeGraceSec: 0.4,  // holding at full charge longer than this risks a long serve
  overchargeRampSec: 0.8,   // ...and the risk is at its maximum this long after the grace period
  serveLockoutSec: 0.35,    // ignore the serve button this long after the serve phase starts (buffered)
  cpuServeDelay: 1.2,
  spikeSpeedMin: 12,        // horizontal-ish speed of a spike at power 0 / 1 (m/s)
  spikeSpeedMax: 19.5,
  humanSpikeSpeedMin: 8,    // Momo's spike speed at power 0 (meter decides power)
  diveSpeed: 5.5,           // lunge speed (m/s), decays quickly
  blockWindow: 0.55,        // |dx| between ball and blocker at the net for a block
  blockSuccessHuman: 0.75,
  touchCooldown: 0.12,
  turnRate: 12,             // rad/s facing turn speed
  swingWindow: 0.22,        // seconds a J release with no attack ball (or past contact) stays live
  windupSec: 0.35,          // J held this long = full wind-up pose (state.hitCharge); not the grade
  spikeLiveAfter: 0.12,     // a graded J release stays live until predicted contact + this (s)
  spikeJumpTolerance: 0.15, // jump within this (s) of the JUMP mark = full power; beyond it power/aim fade
  spikeReachAssist: 0.25,   // extra horizontal reach (m) for Momo's graded attack swing
  spikeReachUp: 0.25,       // extra vertical reach (m) above her hands for that swing
  spikeHandoffTc: 0.16,     // grounded, J untouched this close to contact: the ball becomes a K ball
  spikeOverpassMaxZ: 1.8,   // an opponent ball descending through attack height this close to the net is attackable
  passSloppyMargin: 0.10,   // presses up to this far (s) outside METER.pass.green are 'early'/'late' (sloppy)
  passCooldown: 0.5,        // K is ignored this long after a press with no ball incoming
  passMinLead: 0.25,        // episodes with less warning than this (below reaction time) keep grading but hide the needle
  diveRange: 0.8,           // Pass on a low ball up to reach + this far away = dive
  humanPriority: 1.0,       // Pip leaves the 1st ball to Momo unless Pip is this much closer
  retroReachSlack: 0.15,    // lag compensation: extra reach (m) when a late press is applied retroactively
};
// Pip (the human's AI partner) always plays at roughly 'normal' level, whatever the difficulty.
const TEAMMATE_PROFILE = { ...DIFFICULTY.normal };

/**
 * Extra per-difficulty knobs for the CPU opponent (team 1) on top of config DIFFICULTY.
 * Pip and CPU-vs-CPU team 0 use the defaults (DEFAULT_CPU_MODS).
 *   reactionAdd  extra perception delay (s) for opponent shots
 *   spikePace    multiplier on CPU spike speed
 *   aimRandom    randomness in choosing the open spot to attack (bigger = less clinical)
 *   digShank     chance a dig of a fast spike goes wild
 *   blockSuccess chance a well-placed block gets hands on the ball
 */
export const DEFAULT_CPU_MODS = { reactionAdd: 0, spikePace: 1, aimRandom: 1.5, digShank: 0.4, blockSuccess: 0.45 };
// Any DIFFICULTY field can also be overridden here for the opponent only (normal's errorRate is,
// because DIFFICULTY.normal is also Pip's profile).
// Tuned against the scripted human in tests/helpers/harness.js (100 ms latency, default aim):
// easy ~98% wins, normal ~45%, hard ~12% with ~11 points per match.
export const CPU_MODS = {
  easy: { ...DEFAULT_CPU_MODS, spikePace: 0.85, aimRandom: 3, digShank: 0.5, blockSuccess: 0.3 },
  normal: { ...DEFAULT_CPU_MODS, reactionAdd: 0.1, spikePace: 0.78, aimRandom: 3.5, digShank: 0.68, blockSuccess: 0.25, errorRate: 0.12 },
  hard: {
    ...DEFAULT_CPU_MODS, reactionAdd: 0.17, spikePace: 0.82, aimRandom: 3.2, digShank: 0.6, blockSuccess: 0.28,
  },
};
export const HUMAN_ID = 0; // offline the human controls players[0] (Momo)
const POS_HISTORY = 48;    // per-human position history (steps) for retroactive touches (0.4 s)
const JUMP_TO_APEX = PLAYER.jumpVelocity / PLAYER.gravity;
const ACTION_DURATION = { bump: 0.5, set: 0.55, spike: 0.6, serveHit: 0.55, block: 0.6 };

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function createState() {
  return {
    phase: 'menu',
    paused: false,
    difficulty: 'normal',
    time: 0,
    score: [0, 0],
    servingTeam: 0,
    serverId: 0,
    touches: 0,
    possessionTeam: null,
    controlledId: 0,
    serveCharge: null,
    serveRisk: null,             // 0..1 long-serve risk from over-holding at full charge; null unless charging
    aimTarget: null,
    lastPoint: null,
    passMeter: null,             // 0..1 pass timing meter while a ball is incoming to Momo, else null
    passWindow: 0,               // seconds Momo's pass press stays live (0 = none)
    hitWindow: 0,                // seconds left in Momo's swing window after releasing Hit (0 = closed)
    spikeMeter: null,            // 0..1 ball-synced spike meter while an attack ball is coming to Momo, else null
    hitCharge: null,             // 0..1 wind-up while Momo holds Hit in a rally (pose only), else null
    ball: {
      pos: new Vector3(0, R, 0),
      vel: new Vector3(),
      spin: new Vector3(),
      visible: true,
      landing: null,
      held: false,
      lastTeam: null,
    },
    players: [0, 1, 2, 3].map((id) => ({
      id,
      team: id < 2 ? 0 : 1,
      index: id % 2,
      pos: new Vector3(),
      vel: new Vector3(),
      facing: id < 2 ? Math.PI : 0,
      grounded: true,
      action: null,
      actionTime: 0,
      controlled: false,
      human: false,
      // Per-player timing meters (top-level state fields mirror players[controlledId]).
      // passWindow / hitWindow (s) are extras beyond the contract's six fields (0 = closed).
      meters: {
        pass: null, spike: null, hitCharge: null, serveCharge: null, serveRisk: null, aimTarget: null,
        passWindow: 0, hitWindow: 0,
      },
    })),
  };
}

/** Per-player human control state (meter episodes, presses, swing). One per player slot. */
function createHumanState(id) {
  return {
    id,
    inp: null,
    lag: false,         // input implements edgeTime (remote): lag compensation on
    jumpPressed: false,
    hitPressed: false,
    hitReleased: false,
    passPressed: false,
    jumpT: null,        // view time (state.time) of the latest edge, null = now
    hitPressT: null,
    hitReleaseT: null,
    passT: null,
    swing: 0,
    swingV: 0,          // spike meter value at release (unclamped: >1 = after contact)
    hitHeld: -1,        // seconds J has been held during the rally (-1 = not held)
    // Pass/set press: armed = seconds the press stays live; grade decided at press time.
    pass: {
      armed: 0, grade: null, timing: null, dive: false, diveAt: 0, divePoint: new Vector3(),
      lockEpoch: -1, armEpoch: -1, cooldown: 0,
    },
    // Smoothed prediction of the next contact (drives meters.pass). One "episode" per ball.
    pm: {
      active: false, t: 0, epoch: -1, kind: null, point: new Vector3(),
      tc0: 0, shown: 0, lastSeen: -1, gapUntil: -1,
    },
    lastPm: { epoch: -1, t: 0, kind: null, point: new Vector3(), endedAt: -1 }, // the last ended pass episode
    // Last J release: graded against the ball-synced spike meter (sm) or a whiff.
    spikeSwing: { graded: false, epoch: -1, zone: 'early', timing: 'none', x: 0, over: 0, quality: 0 },
    // Ball-synced spike meter episode (drives meters.spike). One episode per attack ball.
    sm: {
      active: false, epoch: -1, kind: null, t: 0, tStand: 0, tc0: 0, shown: 0, value: 0,
      point: new Vector3(), gapUntil: -1, handedOff: false, lockEpoch: -1, jumpAt: -1,
    },
    defaultAim: { x: 0, d: 5.6 },
    aimVec: new Vector3(),
    // Ring buffer of recent end-of-step positions (sim time), for retroactive touches.
    hist: {
      n: 0, i: 0,
      t: new Float64Array(POS_HISTORY), x: new Float64Array(POS_HISTORY), y: new Float64Array(POS_HISTORY),
      z: new Float64Array(POS_HISTORY), vy: new Float64Array(POS_HISTORY), g: new Uint8Array(POS_HISTORY),
    },
  };
}

/**
 * @param {{ events?: {emit:Function}, input?: object, inputs?: Array<object|null>, seed?: number,
 *   autoplay?: boolean, allowPause?: boolean, controlledId?: number }} opts
 *   input: offline, drives player 0 (others AI). inputs: one per player slot, null = AI (server).
 *   autoplay: every player is CPU-controlled (demo / headless tests). Not used by main.js.
 *   allowPause: false = 'pause' presses from inputs are ignored and pause() is a no-op (online).
 *   controlledId: which player the top-level meter mirrors follow (default 0).
 */
export function createGame({
  events, input, inputs, seed, autoplay = false, allowPause = true, controlledId = 0,
} = {}) {
  const bus = events && typeof events.emit === 'function' ? events : { emit() {} };
  const rng = createRng(seed);
  const state = createState();
  const players = state.players;
  const ball = state.ball;
  const defaultControlled = Number.isInteger(controlledId) && controlledId >= 0 && controlledId < 4 ? controlledId : 0;
  state.controlledId = defaultControlled;
  const hs = players.map((p) => createHumanState(p.id));
  const NULL_INPUT = createNullInput();

  const sim = {
    mode: 'serve',
    attract: true,
    acc: 0,
    now: 0,
    lastToucherId: -1,
    lastTouchTime: -1,
    touchSerial: 0,
    ballEpoch: 0,     // bumps on every touch, block and net/post contact (a "new ball" for Momo's K)
    epochStart: 0,    // sim time the current ballEpoch began
    touchCooldown: 0,
    netSinceTouch: false,
    serveUntouched: false,
    pointTimer: 0,
    pointWinner: 0,
    landed: false,
    stillTime: 0,
    rallyTime: 0,
    lastBounceEmit: -1,
    serve: {
      stage: 'ready', timer: 0, charge: 0, over: 0, aimX: 0, tossT: 0, power: 0.5,
      human: false, netFault: false, nextAt: 1.2, buffered: false,
      target: new Vector3(), tossFrom: new Vector3(),
    },
    lastServerIdx: [0, -1],
    pool: Array.from({ length: TRAJ_POOL }, createTrajectory),
    poolIdx: 0,
    traj: null,
    history: [],
    misjudge: [false, false],
    designated: [-1, -1],
    designatedRecv: [false, false],
    spikeLive: null,
    blockPlan: [{ key: -1, blockerId: -1, jitter: 0, xNoise: 0 }, { key: -1, blockerId: -1, jitter: 0, xNoise: 0 }],
    formation: players.map(() => new Vector3()),
    trajEpoch: -1,    // ballEpoch the latest predicted trajectory belongs to
    epochTraj: null,  // that trajectory (kept after landing, for retroactive touches)
    heldLanding: null, // lag compensation: a landing whose point is on hold (see lagHold)
    hs,
    stats: createStats(),
  };
  // Back-compat views (tests/QA): the controlled player's human state.
  const ctl = () => hs[state.controlledId] || hs[0];
  for (const k of ['pass', 'pm', 'sm', 'spikeSwing', 'defaultAim']) {
    Object.defineProperty(sim, k, { get: () => ctl()[k], enumerable: true });
  }
  for (const k of ['swing', 'swingV', 'hitHeld']) {
    Object.defineProperty(sim, k, { get: () => ctl()[k], set: (v) => { ctl()[k] = v; }, enumerable: true });
  }

  const brains = players.map(() => ({
    target: new Vector3(),
    dvx: 0,
    dvz: 0,
    diveT: -1,
    intent: null,
    intentKey: -1,
    jitter: 0,
  }));

  const res = createStepResult();
  const landingVec = new Vector3();
  const aimVec = new Vector3();
  const tmpA = new Vector3();
  const tmpB = new Vector3();
  const tmpNext = new Vector3();

  // ---------------------------------------------------------------- helpers
  function emit(name, payload) {
    if (sim.attract) return;
    if (name === 'hit') sim.stats.onHit(payload);
    bus.emit(name, payload);
  }
  function syncPhase() { state.phase = sim.attract ? 'menu' : sim.mode; }
  const NORMAL_PROFILE = { ...DIFFICULTY.normal, ...DEFAULT_CPU_MODS };
  const PIP_PROFILE = { ...TEAMMATE_PROFILE, ...DEFAULT_CPU_MODS };
  let cpuProfile = NORMAL_PROFILE;
  function buildCpuProfile() {
    const base = DIFFICULTY[state.difficulty] || DIFFICULTY.normal;
    const mods = { ...DEFAULT_CPU_MODS, ...(CPU_MODS[state.difficulty] || {}) };
    cpuProfile = { ...base, ...mods, reaction: base.reaction + mods.reactionAdd };
  }
  /**
   * AI profile for a team: an AI with a human teammate plays as the partner (Pip) profile; an
   * all-AI team uses the room difficulty (opponent profile + CPU_MODS). Autoplay keeps the
   * historical CPU-vs-CPU split (team 0 normal, team 1 difficulty).
   */
  function profileFor(team) {
    if (sim.attract) return NORMAL_PROFILE;
    if (autoplay) return team === 1 ? cpuProfile : NORMAL_PROFILE;
    return teamHasHuman(team) ? PIP_PROFILE : cpuProfile;
  }
  function isHuman(p) {
    return !sim.attract && hs[p.id].inp !== null;
  }
  function teamHasHuman(T) {
    return isHuman(players[T * 2]) || isHuman(players[T * 2 + 1]);
  }
  /** Seconds to rewind for an edge seen at view time `t` (state.time units); 0 = now / unknown. */
  function edgeBack(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return 0;
    return clamp(state.time - t, 0, NET.maxRewind);
  }
  function setAction(p, a) { p.action = a; p.actionTime = 0; }
  function bumpEpoch() { sim.ballEpoch++; sim.epochStart = sim.now; }
  function diving(p) { const d = brains[p.id].diveT; return d >= 0 && d < 0.6; }
  function reachRadius(p) {
    return PLAYER.reachRadius * (isHuman(p) ? TUNING.humanReachMul : 1) + (diving(p) ? TUNING.diveReachBonus : 0);
  }
  function inReach(p, pt) {
    const r = reachRadius(p);
    const dx = pt.x - p.pos.x;
    const dz = pt.z - p.pos.z;
    if (dx * dx + dz * dz > r * r) return false;
    return pt.y >= p.pos.y + PLAYER.reachBelow && pt.y <= p.pos.y + PLAYER.standingReach + 0.3;
  }
  /** A human's graded attack swing on the current ball is live (J released on an attack ball). */
  function humanAttackSwing(p) {
    const h = hs[p.id];
    return h.swing > 0 && h.spikeSwing.graded && h.spikeSwing.epoch === sim.ballEpoch;
  }
  /** A bit more generous reach for that swing (horizontal and above the hands). */
  function inAttackReach(p, pt) {
    const r = reachRadius(p) + TUNING.spikeReachAssist;
    const dx = pt.x - p.pos.x;
    const dz = pt.z - p.pos.z;
    if (dx * dx + dz * dz > r * r) return false;
    return pt.y >= p.pos.y + PLAYER.reachBelow && pt.y <= p.pos.y + PLAYER.standingReach + 0.3 + TUNING.spikeReachUp;
  }

  // ---------------------------------------------------------------- trajectories
  function pushHistory(tr) {
    sim.history.push({ time: sim.now, traj: tr });
    if (sim.history.length > HISTORY) sim.history.shift();
  }
  function onTrajectoryChanged() {
    sim.poolIdx = (sim.poolIdx + 1) % TRAJ_POOL;
    const tr = predictTrajectory(ball.pos, ball.vel, sim.now, sim.pool[sim.poolIdx]);
    sim.traj = tr;
    sim.epochTraj = tr;
    sim.trajEpoch = sim.ballEpoch;
    pushHistory(tr);
    if (tr.hasLanding) { landingVec.set(tr.landing.x, 0, tr.landing.z); ball.landing = landingVec; }
    else ball.landing = null;
    for (let t = 0; t < 2; t++) sim.misjudge[t] = rng.chance(profileFor(t).errorRate * 0.5);
  }
  function clearTrajectory() {
    sim.traj = null;
    ball.landing = null;
    pushHistory(null);
  }
  /** What `team` currently believes the ball will do (reaction-delayed for opponent touches). */
  function trajFor(team) {
    if (ball.lastTeam === team) return sim.traj;
    const delay = profileFor(team).reaction;
    const h = sim.history;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].time <= sim.now - delay + 1e-9) return h[i].traj;
    return h.length ? h[0].traj : null;
  }
  /**
   * First future point where the (descending) ball reaches height h, else the final sample.
   * Writes into `out`; returns absolute time or -1.
   */
  function intercept(tr, h, out) {
    if (!tr || tr.n === 0) return -1;
    const i0 = Math.max(1, Math.ceil((sim.now - tr.t0) / SAMPLE_DT - 1e-6));
    for (let i = i0; i < tr.n; i++) {
      if (tr.y[i] <= h && tr.y[i] < tr.y[i - 1]) {
        out.set(tr.x[i], tr.y[i], tr.z[i]);
        return tr.t0 + tr.t[i];
      }
    }
    const i = tr.n - 1;
    out.set(tr.x[i], tr.y[i], tr.z[i]);
    return tr.t0 + tr.t[i];
  }

  // ---------------------------------------------------------------- player actions
  /** `back` (s, lag compensation): the jump started that long ago (the player's view time). */
  function jump(p, kind, back = 0) {
    if (!p.grounded || brains[p.id].diveT >= 0) return;
    p.grounded = false;
    p.vel.y = PLAYER.jumpVelocity;
    p.vel.x *= 0.5;
    p.vel.z *= 0.5;
    if (back > 0) {
      // Already `back` seconds into the jump (the step's integration adds the current step).
      p.pos.y = PLAYER.jumpVelocity * back - 0.5 * PLAYER.gravity * back * back;
      p.vel.y = PLAYER.jumpVelocity - PLAYER.gravity * back;
      rewriteJumpHistory(p, sim.now - back);
    }
    if (kind === 'block') setAction(p, 'block');
    const h = hs[p.id];
    if (isHuman(p) && h.sm.active && h.sm.epoch === sim.ballEpoch) h.sm.jumpAt = sim.now - back;
    emit('jump', { playerId: p.id, position: p.pos.clone() });
  }
  function startDive(p, pt) {
    const dx = pt.x - p.pos.x;
    const dz = pt.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.vel.x = (dx / d) * TUNING.diveSpeed;
    p.vel.z = (dz / d) * TUNING.diveSpeed;
    brains[p.id].diveT = 0;
    setAction(p, 'dive');
  }
  /** Lunge for a ball about to land just out of reach. */
  function maybeDive(p, tr) {
    const b = brains[p.id];
    if (!tr || !p.grounded || b.diveT >= 0 || !tr.hasLanding) return;
    const T = p.team;
    const ours = state.possessionTeam === T && ball.lastTeam === T;
    if (ours && (state.touches >= 3 || sim.lastToucherId === p.id)) return;
    if (teamOfZ(tr.landing.z) !== T || !isInBounds(tr.landing.x, tr.landing.z)) return;
    const t = intercept(tr, 0.5, tmpA);
    const remain = t - sim.now;
    if (t < 0 || remain <= 0.02 || remain > 0.4) return;
    const reach = PLAYER.reachRadius * (isHuman(p) ? TUNING.humanReachMul : 1);
    const d = hdist(p.pos, tmpA);
    if (d < reach * 0.9 || d > reach + 0.8) return;
    if (d - reach * 0.8 < PLAYER.moveSpeed * remain * 0.6) return; // can just run there
    startDive(p, tmpA);
  }

  /** Human `m` owns the ball but is clearly not going to get there in time (the AI mate may scramble). */
  function humanOutOfPosition(tr, m) {
    if (!tr || !m || !isHuman(m)) return false;
    const t = intercept(tr, 0.8, tmpB);
    if (t < 0 || t - sim.now > 0.7) return false;
    return hdist(m.pos, tmpB) > reachRadius(m) + 0.6;
  }

  const g = {
    state, sim, brains, rng,
    profileFor, trajFor, intercept, isHuman, jump, maybeDive, reachRadius, humanOutOfPosition,
  };

  // ---------------------------------------------------------------- serve flow
  function placeHeldBall(server) {
    const s = side(server.team);
    ball.pos.set(server.pos.x + 0.25, server.pos.y + 1.0, server.pos.z - s * 0.3);
    ball.vel.set(0, 0, 0);
  }

  function setupServe(emitReady = true) {
    sim.mode = 'serve';
    syncPhase();
    const T = state.servingTeam;
    const s = side(T);
    const server = players[state.serverId];
    const sx = (server.index === 0 ? -1.3 : 1.3) * s;
    for (const p of players) {
      const f = sim.formation[p.id];
      if (p.id === server.id) f.set(sx, 0, s * (COURT.halfLength + 0.8));
      else if (p.team === T) f.set(-sx * 1.1, 0, s * 3.6);
      else f.set((p.index === 0 ? -2.0 : 2.0), 0, side(p.team) * 5.6);
      p.pos.copy(f);
      p.vel.set(0, 0, 0);
      p.grounded = true;
      p.facing = side(p.team) > 0 ? Math.PI : 0;
      setAction(p, null);
      const b = brains[p.id];
      b.target.copy(f); b.dvx = 0; b.dvz = 0; b.diveT = -1; b.intent = null; b.intentKey = -1;
    }
    state.touches = 0;
    state.possessionTeam = T;
    clearServeMeters();
    for (const p of players) p.meters.aimTarget = null;
    ball.lastTeam = null;
    ball.held = true;
    ball.visible = true;
    ball.spin.set(0, 0, 0);
    placeHeldBall(server);
    sim.lastToucherId = -1;
    sim.serveUntouched = false;
    sim.netSinceTouch = false;
    sim.landed = false;
    sim.spikeLive = null;
    sim.heldLanding = null;
    for (const h of hs) {
      h.sm.active = false;
      h.sm.lockEpoch = -1;
      h.spikeSwing.graded = false;
      players[h.id].meters.spike = null;
    }
    sim.stillTime = 0;
    sim.rallyTime = 0;
    sim.designated[0] = sim.designated[1] = -1;
    sim.history.length = 0;
    clearTrajectory();
    const sv = sim.serve;
    sv.stage = 'ready';
    sv.timer = 0;
    sv.charge = 0;
    sv.over = 0;
    sv.aimX = 0;
    sv.netFault = false;
    sv.buffered = false;
    sv.graded = false;
    sv.human = isHuman(server);
    sv.nextAt = TUNING.cpuServeDelay + rng.range(0, 0.4);
    sim.stats.rallies++;
    syncMirrors();
    if (emitReady) emitServeReady();
  }

  function clearServeMeters() {
    for (const p of players) { p.meters.serveCharge = null; p.meters.serveRisk = null; }
  }

  function emitServeReady() {
    emit('serveReady', { team: state.servingTeam, playerId: state.serverId, isHuman: sim.serve.human });
  }

  /** Long-serve risk shown to the player: 0 within the grace period, ramps to 1. */
  function overchargeRisk(over) {
    return clamp((over - TUNING.overchargeGraceSec) / TUNING.overchargeRampSec, 0, 1);
  }

  function humanServeTarget(charge, over, preview) {
    const s = side(state.servingTeam);
    let depth = 2.8 + charge * 4.7;
    if (!preview && over > TUNING.overchargeGraceSec) {
      // Up to +2 m extra depth: at full risk ~60% of serves sail long.
      depth += rng.range(0, 1) * 2.0 * overchargeRisk(over);
    }
    sim.serve.target.set(sim.serve.aimX, R, -s * depth);
  }

  function cpuServeTarget() {
    const T = state.servingTeam;
    const s = side(T);
    const prof = profileFor(T);
    const sv = sim.serve;
    const wide = state.difficulty === 'hard' && !sim.attract ? 3.2 : 3.0;
    let x = rng.range(-wide, wide) + rng.gauss() * prof.aimNoise * 0.2;
    let depth = rng.range(3.4, 7.2) + rng.gauss() * prof.aimNoise * 0.15;
    x = clamp(x, -3.7, 3.7);
    depth = clamp(depth, 2.5, 7.7);
    sv.power = rng.range(0.4, 0.95);
    if (rng.chance(prof.errorRate * 0.3)) {
      if (rng.chance(0.5)) depth = rng.range(8.7, 9.8);
      else sv.netFault = true;
    }
    sv.target.set(x, R, -s * depth);
  }

  function startToss() {
    const sv = sim.serve;
    sv.stage = 'toss';
    sv.tossT = 0;
    sv.tossFrom.copy(ball.pos);
    clearServeMeters();
    setAction(players[state.serverId], 'serveToss');
  }

  function serveHit() {
    const sv = sim.serve;
    const server = players[state.serverId];
    const T = server.team;
    const from = ball.pos.clone();
    if (sv.netFault) solveByApex(from, sv.target, Math.max(from.y + 0.06, NH - 0.1), ball.vel);
    else lobTo(from, sv.target, 2.85 + (1 - sv.power) * 1.4, ball.vel, 0.15);
    ball.held = false;
    ball.lastTeam = T;
    setTopspin(18);
    sim.lastToucherId = server.id;
    sim.lastTouchTime = sim.now;
    sim.touchSerial++;
    bumpEpoch();
    sim.serveUntouched = true;
    sim.netSinceTouch = false;
    sim.touchCooldown = 0.2;
    state.possessionTeam = T;
    state.touches = 0;
    setAction(server, 'serveHit');
    sim.mode = 'rally';
    syncPhase();
    const payload = { playerId: server.id, team: T, type: 'serve', position: from, power: sv.power, touches: 0 };
    if (sv.human && sv.graded) {
      // Full charge (METER.serve.green) is best; over-holding past the grace period costs quality.
      payload.quality = meterGrade(sv.power, METER.serve).quality * (1 - 0.5 * overchargeRisk(sv.over));
    }
    emit('hit', payload);
    onTrajectoryChanged();
  }

  function stepServe(dt) {
    const sv = sim.serve;
    const server = players[state.serverId];
    const h = hs[server.id];
    const inp = h.inp || NULL_INPUT;
    sv.timer += dt;
    if (sv.stage === 'ready' || sv.stage === 'charging') placeHeldBall(server);
    if (sv.stage === 'ready') {
      if (sv.human) {
        // Presses during the short lockout are buffered; after it, holding Hit starts charging.
        if (h.hitPressed) sv.buffered = true;
        if (sv.timer > TUNING.serveLockoutSec && (sv.buffered || inp.held('hit'))) {
          sv.buffered = false;
          sv.stage = 'charging';
          // Lag compensation: the charge started when the player pressed (not before the lockout).
          const back = h.lag ? Math.min(edgeBack(h.hitPressT), Math.max(0, sv.timer - TUNING.serveLockoutSec)) : 0;
          sv.charge = Math.min(1, back / METER.serve.fillSec);
          sv.over = 0;
          server.meters.serveCharge = sv.charge;
          server.meters.serveRisk = 0;
        } else if (sv.timer > RULES.serveTimeoutSec) {
          sv.aimX = 0;
          sv.power = 0.4;
          humanServeTarget(0.4, 0, false);
          startToss();
        }
      } else if (sv.timer >= sv.nextAt) {
        cpuServeTarget();
        startToss();
      }
    } else if (sv.stage === 'charging') {
      if (sv.charge < 1) sv.charge = Math.min(1, sv.charge + dt / METER.serve.fillSec);
      else sv.over += dt;
      // Screen-relative aim: a team-1 server sees the court mirrored (from -z).
      sv.aimX = clamp(sv.aimX + inp.axis().x * side(server.team) * 3.2 * dt, -3.4, 3.4);
      server.meters.serveCharge = sv.charge;
      server.meters.serveRisk = overchargeRisk(sv.over);
      humanServeTarget(sv.charge, sv.over, true);
      const forced = sv.timer > RULES.serveTimeoutSec + 4;
      if (h.hitReleased || !inp.held('hit') || forced) {
        if (h.lag && h.hitReleased) {
          // Graded at the moment the player released (what they saw), not on arrival.
          const total = Math.max(0, sv.charge * METER.serve.fillSec + sv.over - edgeBack(h.hitReleaseT));
          sv.charge = Math.min(1, total / METER.serve.fillSec);
          sv.over = Math.max(0, total - METER.serve.fillSec);
        }
        sv.power = sv.charge;
        sv.graded = true;
        humanServeTarget(sv.charge, sv.over, false);
        startToss();
      }
    } else if (sv.stage === 'toss') {
      sv.tossT += dt;
      const t = sv.tossT;
      ball.pos.set(sv.tossFrom.x, sv.tossFrom.y + 4.4 * t - 0.5 * BALL.gravity * t * t, sv.tossFrom.z);
      if (sv.tossT >= 0.5) serveHit();
    }
  }

  // ---------------------------------------------------------------- points & match flow
  function awardPoint(winner, reason, pos) {
    if (!sim.attract) state.score[winner]++;
    state.lastPoint = { winnerTeam: winner, reason };
    sim.mode = 'point';
    syncPhase();
    sim.pointTimer = RULES.pointPauseSec;
    sim.pointWinner = winner;
    sim.spikeLive = null;
    sim.heldLanding = null;
    for (const p of players) p.meters.aimTarget = null;
    clearServeMeters();
    syncMirrors();
    for (const p of players) setAction(p, p.team === winner ? 'celebrate' : 'sad');
    sim.stats.onPoint(winner, reason);
    emit('point', { winnerTeam: winner, reason, score: [state.score[0], state.score[1]], position: pos.clone() });
  }

  function fault(loser, reason) {
    let r = reason;
    if (sim.serveUntouched && loser === state.servingTeam) r = 'serveFault';
    awardPoint(1 - loser, r, ball.pos);
  }

  function afterPoint() {
    if (!sim.attract) {
      const w = matchWinner(state.score);
      if (w >= 0) {
        sim.mode = 'matchOver';
        syncPhase();
        emit('matchOver', { winnerTeam: w, score: [state.score[0], state.score[1]] });
        return;
      }
    }
    const winner = sim.pointWinner;
    if (winner !== state.servingTeam) {
      state.servingTeam = winner;
      sim.lastServerIdx[winner] = sim.lastServerIdx[winner] === 0 ? 1 : 0;
    }
    state.serverId = winner * 2 + Math.max(0, sim.lastServerIdx[winner]);
    setupServe();
  }

  // ---------------------------------------------------------------- ball
  function setTopspin(amount) {
    const h = Math.hypot(ball.vel.x, ball.vel.z) || 1;
    // Rolling forward along d means angular velocity along up x d.
    ball.spin.set(ball.vel.z / h * amount, 0, -ball.vel.x / h * amount);
  }

  function stepBallPhysics(dt, subs = SUBSTEPS) {
    let changed = false;
    for (let k = 0; k < subs; k++) {
      const floorY = sim.landed ? R * 0.62 : R;
      stepBall(ball.pos, ball.vel, BALL_SUBSTEP, res, floorY);
      if (res.crossed) onCross();
      if (res.net || res.post) {
        changed = true;
        bumpEpoch();
        if (sim.mode === 'rally') sim.netSinceTouch = true;
        if (res.impactSpeed > 0.4 && sim.now - sim.lastBounceEmit > 0.06) {
          sim.lastBounceEmit = sim.now;
          emit('bounce', { position: ball.pos.clone(), surface: res.post ? 'post' : 'net', speed: res.impactSpeed });
        }
        ball.spin.multiplyScalar(0.5);
      }
      if (res.floor) {
        if (sim.mode === 'rally' || (sim.now - sim.lastBounceEmit > 0.15 && res.floorSpeed > 1.5)) {
          sim.lastBounceEmit = sim.now;
          emit('bounce', { position: ball.pos.clone(), surface: 'sand', speed: res.floorSpeed });
        }
        ball.spin.multiplyScalar(0.6);
        if (sim.mode === 'rally' && !sim.heldLanding) {
          const verdict = judgeLanding({
            x: ball.pos.x, z: ball.pos.z, lastTeam: ball.lastTeam, netSinceTouch: sim.netSinceTouch,
            serveUntouched: sim.serveUntouched, servingTeam: state.servingTeam,
          });
          // Lag compensation: a remote human may still have a press in flight for this ball.
          if (lagHold()) {
            sim.heldLanding = { at: sim.now, verdict, pos: ball.pos.clone() };
            sim.stats.heldLandings++;
          }
          else awardPoint(verdict.winnerTeam, verdict.reason, ball.pos);
        }
        if (!sim.landed) { sim.landed = true; clearTrajectory(); }
        changed = false;
      }
    }
    if (sim.landed) {
      // Rolling in the sand: spin follows the ground speed.
      const h = Math.hypot(ball.vel.x, ball.vel.z);
      if (h > 0.05 && ball.pos.y < R + 0.01) ball.spin.set(ball.vel.z / R, 0, -ball.vel.x / R);
      else ball.spin.multiplyScalar(Math.exp(-3 * dt));
    } else {
      ball.spin.multiplyScalar(Math.exp(-0.3 * dt));
    }
    if (changed && !sim.landed && (sim.mode === 'rally' || sim.mode === 'point')) onTrajectoryChanged();
  }

  function onCross() {
    const panel = Math.abs(res.crossX) < COURT.netHalfSpan - 0.01 &&
      res.crossY > COURT.netBottom + 0.01 && res.crossY < NH - 0.01;
    if (panel) sim.stats.netViolations++;
    if (sim.mode !== 'rally') return;
    const toTeam = res.crossTo > 0 ? 0 : 1;
    if (Math.abs(res.crossX) > COURT.halfWidth || res.crossY < COURT.netBottom) {
      fault(ball.lastTeam ?? (1 - toTeam), 'out');
      return;
    }
    state.possessionTeam = toTeam;
    state.touches = 0;
    sim.lastToucherId = -1;
    sim.stats.crossings++;
  }

  // ---------------------------------------------------------------- touches
  function checkTouches() {
    if (sim.touchCooldown > 0 || ball.held || sim.heldLanding) return;
    const T = teamOfZ(ball.pos.z);
    if (sim.serveUntouched && T === state.servingTeam) return;
    const ours = state.possessionTeam === T && ball.lastTeam === T;
    const done = ours ? state.touches : 0;
    if (done >= RULES.maxTouches) return;
    const first = sim.designated[T] >= 0 ? sim.designated[T] : T * 2;
    for (const id of [first, first ^ 1]) {
      const p = players[id];
      if (ours && id === sim.lastToucherId) continue;
      const kind = wantsTouch(p, done + 1);
      if (kind) { performTouch(p, kind, done + 1); return; }
    }
  }

  function wantsTouch(p, n) {
    const T = p.team;
    const human = isHuman(p);
    if (human) {
      const near = inReach(p, ball.pos);
      if (!near && !(humanAttackSwing(p) && inAttackReach(p, ball.pos))) return null;
      return humanWantsTouch(p, n, near);
    }
    if (!inReach(p, ball.pos)) return null;
    const mate = players[p.id ^ 1];
    if (isHuman(mate)) {
      // An AI partner never steals a first ball its human teammate has priority on — unless the
      // human has clearly missed it (no pass window open, ball low and out of reach): then scramble.
      if (n === 1 && sim.designated[T] === mate.id && !humanMissed(mate)) return null;
      // ...and never plays a ball the human has a live K press or attack swing on.
      if (humanPressLive(mate) || humanAttackSwing(mate)) return null;
    }
    if (n === 1 && ball.lastTeam !== T && !sim.misjudge[T] && sim.traj && sim.traj.hasLanding &&
        isClearlyOut(sim.traj.landing.x, sim.traj.landing.z)) {
      return null; // AI leaves balls that are clearly going out
    }
    if (!p.grounded) {
      const atNet = Math.abs(p.pos.z) < 1.6;
      if (n === 3 || (n === 2 && atNet && brains[p.id].intent === 'dump')) {
        const high = ball.pos.y > NH + 0.1 && Math.abs(ball.pos.z) < 3.5;
        if (!high || brains[p.id].intent === 'dink') return 'dink';
        return 'spike';
      }
      return n === 1 ? 'bump' : 'set';
    }
    return groundedTouch(p, n);
  }

  /** Grounded auto-touch: wait for a comfortable contact height unless the ball is leaving reach. */
  function groundedTouch(p, n) {
    const pref = n === 2 ? SET_CONTACT_Y : BUMP_CONTACT_Y;
    let go = ball.pos.y <= pref || ball.vel.y > 0.5;
    if (!go) {
      tmpNext.copy(ball.pos).addScaledVector(ball.vel, DT);
      if (!inReach(p, tmpNext)) go = true;
    }
    if (!go) return null;
    if (n === 3) return 'free';
    if (n === 2) return 'set';
    return diving(p) || ball.vel.length() > 11 ? 'dig' : 'bump';
  }

  /**
   * Momo: passes and sets are automatic; attacks need the Hit button. While the swing window is
   * open an airborne Momo spikes (dink if the ball is low); a grounded Momo with the 3rd touch
   * plays a standing shot over. Without Hit, an airborne Momo never attacks, and a grounded Momo
   * on the 3rd touch soft-bumps it over so the rally doesn't die.
   */
  function humanWantsTouch(p, n, near = true) {
    const h = hs[p.id];
    if (!p.grounded && h.swing > 0 && Math.abs(ball.pos.z) < 3.5) {
      return ball.pos.y > NH + 0.1 ? 'spike' : 'dink';
    }
    // Grounded J on the 3rd touch or on a graded attack ball = standing shot over.
    if (p.grounded && h.swing > 0 && (n === 3 || humanAttackSwing(p))) return 'dink';
    if (!near) return null; // the extra attack reach is only for the swing
    if (h.pass.armed <= 0) return null; // nothing is automatic for a human
    // A live press: play at a comfortable height (or now if the ball is leaving reach / the press
    // is about to lapse). How well it goes was decided by WHEN K was pressed.
    let kind = p.grounded ? groundedTouch(p, n) : null;
    if (!kind && (!p.grounded || h.pass.armed <= DT * 1.5)) kind = n === 3 ? 'free' : n === 2 ? 'set' : 'bump';
    if (kind === 'bump' && (diving(p) || ball.vel.length() > 11)) kind = 'dig';
    return kind;
  }

  /** Human `p` has pressed K for the current ball and the press is still live. */
  function humanPressLive(p) {
    const pa = hs[p.id].pass;
    return pa.armed > 0 && pa.armEpoch === sim.ballEpoch;
  }

  /** Human `m` was the receiver but is nowhere near a ball that is about to land. */
  function humanMissed(m) {
    if (lagEpisodeLive(m)) return false; // a remote press may still arrive (lag compensation)
    return hs[m.id].pass.armed <= 0 && ball.pos.y < 0.8 && hdist(m.pos, ball.pos) > reachRadius(m) + 0.2;
  }

  /**
   * Grade a meter release against its green zone (config METER).
   * v is the unclamped meter fill at release (serve: charge; spike: ball-synced, >1 = after contact). quality: 0.6..1 inside green (1 = centred),
   * below 0.5 outside. x: 0..1 how far toward green an early release got; over: how far past green.
   */
  function meterGrade(v, meter) {
    const [g0, g1] = meter.green;
    const mid = (g0 + g1) / 2;
    const half = Math.max(1e-6, (g1 - g0) / 2);
    if (v < g0) return { zone: 'early', quality: 0.5 * clamp(v / g0, 0, 1), x: clamp(v / g0, 0, 1), over: 0 };
    if (v <= g1) return { zone: 'green', quality: 0.6 + 0.4 * (1 - Math.abs(v - mid) / half), x: 1, over: 0 };
    const over = v - g1;
    return { zone: 'late', quality: 0.5 * clamp(1 - over / 0.4, 0, 1), x: 1, over };
  }

  /**
   * Outcome of Momo's pass/set/bump-over. The grade comes from WHEN K was pressed (see
   * classifyPassTiming); position in reach still nudges accuracy. Shanks deflect randomly.
   */
  function humanPassError(p, kind) {
    const grade = hs[p.id].pass.grade || 'shank';
    const e = hdist(p.pos, ball.pos) / reachRadius(p);
    const pErr = kind === 'dig' ? clamp((e - 0.6) / 0.6, 0, 1) : clamp((e - 0.45) / 0.55, 0, 1);
    let r;
    let apexDrop = 0;
    let quality;
    let shank = false;
    if (grade === 'perfect') { r = 0.12 + pErr * 0.5; quality = 0.97 - pErr * 0.1; }
    else if (grade === 'good') { r = 0.35 + pErr * 0.6; apexDrop = 0.15; quality = 0.75 - pErr * 0.12; }
    else if (grade === 'sloppy') { r = 1.0 + pErr * 0.8 + rng.range(0, 0.4); apexDrop = 0.6; quality = 0.42 - pErr * 0.1; }
    else { shank = true; r = 0; quality = 0.1; }
    if (!shank && kind === 'dig') r += 0.3;
    if (!shank && diving(p)) r += 0.2;
    const st = sim.stats.humanPass;
    st[grade] = (st[grade] || 0) + 1;
    return { r, bad: shank, apexDrop, quality, shank };
  }

  /** A shanked pass: random low deflection off the arms, often unplayable. */
  function shankDeflection(p, from, out) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(1.5, 4.5);
    tmpA.set(p.pos.x + Math.cos(a) * d, R, p.pos.z + Math.sin(a) * d);
    lobTo(from, tmpA, from.y + rng.range(0.3, 1.4), out);
  }

  function scatter(v, r) {
    if (r <= 0) return;
    const a = rng.range(0, Math.PI * 2);
    const d = r * Math.sqrt(rng.next());
    v.x += Math.cos(a) * d;
    v.z += Math.sin(a) * d;
  }

  function touchError(p, human, prof, kind) {
    if (human) return humanPassError(p, kind);
    let r;
    let bad = false;
    {
      bad = rng.chance(prof.errorRate);
      r = bad ? rng.range(1.5, 3.0) : 0.3;
    }
    if (kind === 'dig') {
      r += 0.5;
      const fast = ball.vel.length() > 14;
      if (fast && rng.chance(prof.digShank)) { bad = true; r = rng.range(2.0, 3.5); }
    }
    if (diving(p)) r += 0.4;
    return { r, bad, apexDrop: 0 };
  }

  function performTouch(p, kind, n) {
    const T = p.team;
    const s = side(T);
    const prof = profileFor(T);
    const human = isHuman(p);
    const mate = players[p.id ^ 1];
    const from = ball.pos.clone();
    const target = tmpB;
    let type = kind;
    let quality; // only reported for Momo's touches
    let power = 0.4;
    let action = 'bump';
    let spin = 4;
    switch (kind) {
      case 'bump':
      case 'dig': {
        const err = touchError(p, human, prof, kind);
        target.set(clamp(mate.pos.x, -2.2, 2.2), SET_CONTACT_Y, s * SET_SPOT_Z);
        scatter(target, err.r);
        let apex = (kind === 'dig' ? rng.range(3.2, 4.3) : PASS_APEX + rng.range(-0.15, 0.15)) - err.apexDrop;
        if (err.bad && !human) sim.stats.shanks++;
        quality = err.quality;
        if (err.bad) apex = rng.range(2.7, 5.2);
        if (err.shank) shankDeflection(p, from, ball.vel);
        else lobTo(from, target, apex, ball.vel);
        power = kind === 'dig' ? 0.65 : 0.35;
        break;
      }
      case 'set': {
        const err = touchError(p, human, prof, kind);
        target.set(clamp(mate.pos.x, -2.8, 2.8), ATTACK_CONTACT_Y, s * ATTACK_SPOT_Z);
        scatter(target, err.r * 0.8);
        quality = err.quality;
        let apex = SET_APEX + rng.range(-0.15, 0.2) - err.apexDrop;
        if (err.bad) apex = rng.range(3.0, 5.0);
        if (err.shank) shankDeflection(p, from, ball.vel);
        else lobTo(from, target, apex, ball.vel);
        action = 'set';
        power = 0.3;
        spin = 1;
        break;
      }
      case 'free': {
        type = 'bump';
        target.set(rng.range(-2.5, 2.5), R, -s * rng.range(4, 6.5));
        if (human) {
          const err = humanPassError(p, kind);
          quality = err.quality;
          scatter(target, err.r * 0.8);
          if (err.shank) { shankDeflection(p, from, ball.vel); power = 0.2; break; }
        } else if (rng.chance(prof.errorRate * 0.5)) target.z = -s * rng.range(8.6, 9.5);
        lobTo(from, target, Math.max(from.y + 1.2, 4.0), ball.vel, 0.25);
        power = 0.4;
        break;
      }
      case 'spike': {
        // Power: contact near the top of the jump (AI); for Momo the spike meter dominates.
        const off = clamp(Math.abs(p.vel.y) / PLAYER.jumpVelocity, 0, 1);
        power = (human ? 1 - off * off : 1 - off) * (from.y > NH + 0.5 ? 1 : 0.75);
        let netShot = false;
        let speed = TUNING.spikeSpeedMin + (TUNING.spikeSpeedMax - TUNING.spikeSpeedMin) * power;
        if (human) {
          const gr = humanSpikeGrade(p);
          const apexF = power;
          quality = gr.quality;
          humanAimTarget(p, false, target);
          let noise = 0.12;
          // Jumping well off the JUMP mark costs power and accuracy (not the contact itself).
          const jk = jumpPenalty(p);
          if (gr.zone === 'green') {
            power = (0.9 + 0.1 * apexF) * (1 - 0.3 * jk);
            noise += 0.6 * jk;
            quality *= 1 - 0.3 * jk;
          }
          else if (gr.zone === 'early') { power = (0.15 + 0.55 * gr.x * gr.x) * (0.85 + 0.15 * apexF); noise = 0.3; }
          else {
            power = 1;
            noise = 0.45 + gr.over * 6;           // wild: lines and beyond
            target.z -= side(T) * gr.over * 4;    // and long
            if (rng.chance(Math.min(0.6, gr.over * 2.2))) netShot = true;
          }
          target.x += rng.gauss() * noise;
          target.z += rng.gauss() * noise;
          speed = TUNING.humanSpikeSpeedMin + (TUNING.spikeSpeedMax - TUNING.humanSpikeSpeedMin) * power;
          const st = sim.stats.humanSpike;
          st[gr.zone] = (st[gr.zone] || 0) + 1;
        } else {
          aiAttackTarget(p, prof, target);
          if (rng.chance(prof.errorRate)) {
            if (rng.chance(0.5)) {
              if (rng.chance(0.5)) target.x = rng.sign() * (COURT.halfWidth + rng.range(0.5, 1.6));
              else target.z = -s * (COURT.halfLength + rng.range(0.5, 1.6));
            } else netShot = true;
          }
        }
        if (!human) speed *= prof.spikePace;
        if (netShot) {
          target.set(target.x, R, -s * 1.2);
          driveTo(from, target, speed, ball.vel, -10);
        } else {
          driveTo(from, target, speed, ball.vel);
        }
        sim.spikeLive = { team: T, playerId: p.id };
        action = 'spike';
        spin = 30;
        sim.stats.spikes[T]++;
        break;
      }
      case 'dink': {
        if (human) {
          // Standing shot / soft shot over, graded by the spike meter.
          const gr = humanSpikeGrade(p);
          quality = gr.quality;
          humanAimTarget(p, false, target);
          const depth = gr.zone === 'green' ? Math.abs(target.z) : gr.zone === 'early' ? 1.2 + 2 * gr.x : Math.abs(target.z) + gr.over * 5;
          target.set(clamp(target.x * 0.8, -3.5, 3.5), R, -s * depth);
          scatter(target, gr.zone === 'green' ? 0.3 : gr.zone === 'early' ? 0.8 : 0.8 + gr.over * 6);
        } else {
          target.set(clamp(from.x + rng.range(-1.6, 1.6), -3.2, 3.2), R, -s * rng.range(1.4, 2.8));
        }
        lobTo(from, target, Math.max(from.y + 0.35, NH + 0.9), ball.vel, 0.15);
        action = 'spike';
        power = 0.2;
        spin = 3;
        break;
      }
      default: break;
    }
    ball.lastTeam = T;
    sim.lastToucherId = p.id;
    sim.lastTouchTime = sim.now;
    sim.touchSerial++;
    bumpEpoch();
    sim.touchCooldown = TUNING.touchCooldown;
    sim.netSinceTouch = false;
    sim.serveUntouched = false;
    state.possessionTeam = T;
    state.touches = n;
    if (spin > 5) setTopspin(spin);
    else ball.spin.set(rng.range(-spin, spin), rng.range(-spin, spin), rng.range(-spin, spin));
    if (p.action !== 'dive') setAction(p, action);
    if (human) { const h = hs[p.id]; h.swing = 0; h.pass.armed = 0; h.pass.dive = false; }
    const payload = { playerId: p.id, team: T, type, position: from, power, touches: n };
    if (human && quality !== undefined) payload.quality = quality;
    emit('hit', payload);
    onTrajectoryChanged();
  }

  /** Grade of a human's J release for the ball being struck (a whiff swing grades as early/weak). */
  function humanSpikeGrade(p) {
    const sw = hs[p.id].spikeSwing;
    if (!sw.graded) return meterGrade(0, METER.spike);
    return { zone: sw.zone, quality: sw.quality, x: sw.x, over: sw.over };
  }
  /** 0 = jumped within TUNING.spikeJumpTolerance of the JUMP mark, 1 = way off. */
  function jumpPenalty(p) {
    const h = hs[p.id];
    const sm = h.sm;
    if (!h.spikeSwing.graded || sm.epoch !== h.spikeSwing.epoch) return 0;
    if (sm.jumpAt < 0) return 1; // jumped before the attack ball was even set
    const err = Math.abs(sm.jumpAt - (sm.t - JUMP_TO_APEX));
    return clamp((err - TUNING.spikeJumpTolerance) / 0.2, 0, 1);
  }

  function aiAttackTarget(p, prof, out) {
    const o = -side(p.team);
    let bestScore = -Infinity;
    let bx = 0;
    let bz = o * 5;
    for (const x of [-3, -1.5, 0, 1.5, 3]) {
      for (const d of [2.8, 4.6, 6.6]) {
        const cz = o * d;
        let m = Infinity;
        for (const q of players) {
          if (q.team === p.team) continue;
          m = Math.min(m, Math.hypot(x - q.pos.x, cz - q.pos.z));
        }
        const score = Math.min(m, 3.5) + rng.next() * prof.aimRandom;
        if (score > bestScore) { bestScore = score; bx = x; bz = cz; }
      }
    }
    out.set(bx + rng.gauss() * prof.aimNoise * 0.45, R, bz + rng.gauss() * prof.aimNoise * 0.45);
    return out;
  }

  /** Spike target from the human's held direction (default: deep, away from defenders). */
  function humanAimTarget(p, preview, out) {
    const h = hs[p.id];
    const a = (h.inp || NULL_INPUT).axis();
    const o = -side(p.team);
    const opp = players.filter((q) => q.team !== p.team);
    // Default: the deep-ish spot farthest from the defenders (with hysteresis so the reticle
    // doesn't flicker), away from the attacker's own line so it also tends to beat the block.
    const scoreAt = (x, d) => Math.min(...opp.map((q) => Math.hypot(x - q.pos.x, o * d - q.pos.z))) +
      Math.min(1.5, Math.abs(x - p.pos.x)) * 0.3;
    let bx = h.defaultAim.x;
    let bd = h.defaultAim.d;
    let bestScore = scoreAt(bx, bd);
    for (const x of [-3, -1.5, 0, 1.5, 3]) {
      for (const d of [4.8, 6.4]) {
        const sc = scoreAt(x, d);
        if (sc > bestScore + 0.6) { bx = x; bd = d; bestScore = sc; }
      }
    }
    h.defaultAim.x = bx;
    h.defaultAim.d = bd;
    let x = bx;
    let depth = bd;
    // Screen-relative: a team-1 human sees the court mirrored (from -z), so right = -x.
    if (Math.abs(a.x) > 0.25) x = clamp(a.x, -1, 1) * 2.9 * side(p.team);
    if (a.y > 0.25) depth = 6.9;
    else if (a.y < -0.25) depth = 2.5;
    out.set(x, R, o * depth);
    return out;
  }

  // ---------------------------------------------------------------- blocks
  function checkBlock() {
    const live = sim.spikeLive;
    if (!live || ball.held || sim.heldLanding) return;
    const D = 1 - live.team;
    const ds = side(D);
    if (Math.sign(ball.vel.z) !== ds || ball.pos.z * ds > 1.2) {
      if (ball.pos.z * ds > 1.2) sim.spikeLive = null;
      return;
    }
    if (Math.abs(ball.pos.z) > 0.75) return;
    for (const d of players) {
      if (d.team !== D || d.grounded || Math.abs(d.pos.z) > 1.0) continue;
      const handTop = d.pos.y + PLAYER.standingReach + 0.25;
      if (handTop < NH + 0.1) continue;
      if (ball.pos.y < NH - 0.05 || ball.pos.y > handTop + 0.15) continue;
      if (Math.abs(ball.pos.x - d.pos.x) > TUNING.blockWindow) continue;
      // One chance per spike: hands either get there or the ball goes past.
      sim.spikeLive = null;
      if (rng.chance(isHuman(d) ? TUNING.blockSuccessHuman : profileFor(d.team).blockSuccess)) doBlock(d, live.team);
      return;
    }
  }

  function doBlock(d, atkTeam) {
    const as = side(atkTeam);
    const ds = -as;
    const from = ball.pos.clone();
    const target = tmpB;
    const r = rng.next();
    if (r < 0.45) {
      // Stuff: straight back down into the attacker's court.
      target.set(clamp(from.x + rng.range(-1.2, 1.2), -3.8, 3.8), R, as * rng.range(0.9, 3.2));
      driveTo(from, target, 9, ball.vel, 0.05);
    } else if (r < 0.78) {
      // Soft block: pops up on the blocker's side, playable.
      target.set(clamp(from.x + rng.range(-1.5, 1.5), -3.5, 3.5), 1.0, ds * rng.range(2, 4.5));
      lobTo(from, target, from.y + 1.0, ball.vel);
    } else {
      // Tooled: deflects wide/deep off the hands, usually out.
      target.set((from.x >= 0 ? 1 : -1) * rng.range(COURT.halfWidth + 0.8, COURT.halfWidth + 3), R, ds * rng.range(4, 9.5));
      driveTo(from, target, 12, ball.vel, 0.05);
    }
    ball.lastTeam = d.team;
    sim.lastToucherId = -1;
    sim.lastTouchTime = sim.now;
    sim.touchSerial++;
    bumpEpoch();
    sim.touchCooldown = 0.15;
    sim.netSinceTouch = false;
    sim.spikeLive = null;
    state.possessionTeam = teamOfZ(target.z);
    state.touches = 0;
    setAction(d, 'block');
    ball.spin.set(rng.range(-8, 8), rng.range(-8, 8), rng.range(-8, 8));
    sim.stats.blocks[d.team]++;
    emit('hit', { playerId: d.id, team: d.team, type: 'block', position: from, power: 0.7, touches: 0 });
    onTrajectoryChanged();
  }

  // ---------------------------------------------------------------- who plays next / control
  function updateDesignated() {
    for (let T = 0; T < 2; T++) {
      let next = -1;
      let recv = false;
      if (sim.mode === 'serve') {
        next = T === state.servingTeam ? state.serverId : -1;
      } else if (sim.mode === 'rally' && sim.traj && sim.traj.hasLanding) {
        const landTeam = teamOfZ(sim.traj.landing.z);
        const ours = state.possessionTeam === T && ball.lastTeam === T;
        const servingSide = sim.serveUntouched && T === state.servingTeam;
        if (ours && state.touches >= 1 && state.touches < 3 && sim.lastToucherId >= 0 && landTeam === T) {
          next = sim.lastToucherId ^ 1;
        } else if (landTeam === T && !servingSide && !(ours && state.touches >= 3)) {
          recv = true;
          intercept(sim.traj, BUMP_CONTACT_Y, tmpA);
          const a = T * 2;
          const dA = hdist(players[a].pos, tmpA);
          const dB = hdist(players[a + 1].pos, tmpA);
          const cur = sim.designated[T];
          const hA = isHuman(players[a]);
          const hB = isHuman(players[a + 1]);
          // A live K press / spike episode freezes the ball to that human.
          const lockA = hA && (humanPressLive(players[a]) || spikeOwnsBall(players[a]));
          const lockB = hB && (humanPressLive(players[a + 1]) || spikeOwnsBall(players[a + 1]));
          if (lockA || lockB) {
            next = lockA ? a : a + 1;
          } else if (hA !== hB) {
            // Human priority: the human keeps the ball unless the AI partner is clearly better
            // placed; once the partner has it, the human takes it back only by getting clearly under it.
            const M = hA ? a : a + 1;
            const P = M ^ 1;
            const dM = hA ? dA : dB;
            const dP = hA ? dB : dA;
            if (sim.designatedRecv[T] && cur === P) next = dM + 0.3 < dP ? M : P;
            else if (sim.designatedRecv[T] && cur === M) next = dM > dP + TUNING.humanPriority + 0.8 ? P : M;
            else next = dM <= dP + TUNING.humanPriority ? M : P;
          } else if (sim.designatedRecv[T] && (cur === a || cur === a + 1)) {
            const dCur = cur === a ? dA : dB;
            const dOther = cur === a ? dB : dA;
            next = dOther + 1.0 < dCur ? cur ^ 1 : cur;
          } else {
            next = dA <= dB ? a : a + 1;
          }
          if (ours && sim.lastToucherId === next) next ^= 1; // never the player who just touched
        }
      }
      sim.designated[T] = next;
      sim.designatedRecv[T] = recv;
    }
  }

  /** `controlled` marks players[controlledId] (this screen's player); nobody in menu/autoplay. */
  function updateControl() {
    const c = state.controlledId;
    if (!(Number.isInteger(c) && c >= 0 && c < 4)) state.controlledId = defaultControlled;
    const on = !sim.attract && !autoplay;
    for (const p of players) {
      p.controlled = on && p.id === state.controlledId;
      p.human = isHuman(p);
    }
  }

  // ---------------------------------------------------------------- players
  function humanControl(p, b) {
    const h = hs[p.id];
    const inp = h.inp || NULL_INPUT;
    const a = inp.axis();
    // Screen-relative from the player's own side: up = toward the net (-z for team 0, +z for
    // team 1); a team-1 human's camera looks from -z, so their right is -x.
    const s = side(p.team);
    let ax = a.x * s;
    let az = -a.y * s;
    const len = Math.hypot(ax, az);
    if (len > 1) { ax /= len; az /= len; }
    b.dvx = ax * PLAYER.moveSpeed;
    b.dvz = az * PLAYER.moveSpeed;
    if (sim.mode === 'serve' && p.id === state.serverId) { b.dvx = 0; b.dvz = 0; }
    if (sim.mode === 'point' || sim.mode === 'matchOver') { b.dvx = 0; b.dvz = 0; }
    if (sim.mode === 'rally') {
      if (h.jumpPressed && p.grounded && b.diveT < 0) {
        const O = 1 - p.team;
        const oppBall = ball.lastTeam === O || teamOfZ(ball.pos.z) === O;
        jump(p, Math.abs(p.pos.z) < 1.3 && oppBall ? 'block' : 'attack', h.lag ? edgeBack(h.jumpT) : 0);
      }
      // Hit button: hold to wind up (pose only), RELEASE to swing. The release is graded right
      // now against the ball-synced spike meter (a tap = a release at that moment).
      const held = inp.held('hit');
      if (held) h.hitHeld = h.hitHeld < 0 ? 0 : h.hitHeld + DT;
      const released = h.hitHeld >= 0 && !held;
      const tapped = h.hitHeld < 0 && h.hitPressed && !held; // press+release within a frame
      if ((released || tapped) && b.diveT < 0) handleSpikeRelease(p, h.lag ? edgeBack(h.hitReleaseT) : 0);
      if (!held) h.hitHeld = -1;
      if (h.passPressed && b.diveT < 0) handlePassPress(p, h.lag ? edgeBack(h.passT) : 0);
      // A graded dive press: lunge so that the player arrives as the ball does (also if a live
      // press's ball has turned into a dive ball since).
      const pa = h.pass;
      if (!pa.dive && humanPressLive(p) && h.pm.active && h.pm.kind === 'dive' && !inReach(p, ball.pos)) {
        pa.dive = true;
        pa.diveAt = h.pm.t - 0.35;
        pa.divePoint.copy(h.pm.point);
      }
      if (pa.dive && sim.now >= pa.diveAt && p.grounded && b.diveT < 0) {
        pa.dive = false;
        startDive(p, pa.divePoint);
      }
    }
  }

  /** An attack ball is coming to this human and its meter was running at time `tv`. */
  function spikeEpisodeLive(h, tv = sim.now) {
    const sm = h.sm;
    return sm.active && sm.epoch === sim.ballEpoch && tv >= sm.gapUntil &&
      sm.t - tv <= METER.spike.leadSec + 1e-9;
  }

  /** Spike meter fill at absolute sim time `tv` (unclamped; see updateSpikeMeter). */
  function spikeValueAt(sm, tv) {
    const { leadSec, jumpMark } = METER.spike;
    const tc = sm.t - tv;
    const tcJump = (1 - jumpMark) * leadSec;
    if (tc <= tcJump || sm.tc0 <= tcJump + 0.05) return 1 - tc / leadSec;
    const span = Math.min(Math.max(sm.tc0, tcJump + 0.05), leadSec);
    return jumpMark * clamp((span - tc) / (span - tcJump), 0, 1);
  }

  /**
   * J released: grade it NOW from the spike meter (METER.spike.green), keep the swing live until
   * the ball arrives (predicted contact + spikeLiveAfter; for a grounded release, until the ball
   * drops to standing-shot height). One graded release per attack ball (mashing is swallowed).
   * With no attack ball it is a plain whiff swing (timing 'none').
   * `back` > 0 (lag compensation): graded at the player's view time; if the contact has already
   * passed on the server, the spike is applied retroactively (retroSpike).
   */
  function handleSpikeRelease(p, back = 0) {
    const h = hs[p.id];
    const sm = h.sm;
    const sw = h.spikeSwing;
    const tv = sim.now - back;
    const attack = spikeEpisodeLive(h, tv);
    if (attack && sm.lockEpoch === sim.ballEpoch) return;
    setAction(p, 'spike');
    if (!attack) {
      sw.graded = false;
      sw.timing = 'none';
      h.swingV = 0;
      h.swing = TUNING.swingWindow;
      emit('swing', { playerId: p.id, position: p.pos.clone(), airborne: !p.grounded, timing: 'none', meter: null });
      return;
    }
    const v = back > 0 ? spikeValueAt(sm, tv) : sm.value;
    const gr = meterGrade(v, METER.spike);
    const [g0, g1] = METER.spike.green;
    let timing = gr.zone;
    if (gr.zone === 'green') timing = Math.abs(v - (g0 + g1) / 2) <= (g1 - g0) / 4 ? 'perfect' : 'good';
    sm.lockEpoch = sim.ballEpoch;
    sw.graded = true;
    sw.epoch = sim.ballEpoch;
    sw.zone = gr.zone;
    sw.timing = timing;
    sw.x = gr.x;
    sw.over = gr.over;
    sw.quality = gr.quality;
    h.swingV = v;
    const until = (p.grounded ? Math.max(sm.t, sm.tStand) : sm.t) + TUNING.spikeLiveAfter;
    h.swing = Math.max(TUNING.swingWindow, until - sim.now);
    const st = sim.stats.spikeTiming;
    st[timing] = (st[timing] || 0) + 1;
    emit('swing', {
      playerId: p.id, position: p.pos.clone(), airborne: !p.grounded, timing, meter: clamp(v, 0, 1),
    });
    if (back > 0) retroSpike(p, h, tv);
  }

  /** Classify a press by the predicted time to contact (s) against METER.pass.green. */
  function classifyPassTiming(tc) {
    const { leadSec, green } = METER.pass;
    const lo = (1 - green[1]) * leadSec; // latest green moment (closest to contact)
    const hi = (1 - green[0]) * leadSec; // earliest green moment
    const m = TUNING.passSloppyMargin;
    if (tc > hi + m) return 'tooEarly';
    if (tc > hi) return 'early';
    if (tc >= lo) return Math.abs(tc - (lo + hi) / 2) <= (hi - lo) / 4 ? 'perfect' : 'good';
    if (tc >= lo - m) return 'late';
    return 'tooLate';
  }
  const GRADE_OF = { perfect: 'perfect', good: 'good', early: 'sloppy', late: 'sloppy', tooEarly: 'shank', tooLate: 'shank' };

  /**
   * K pressed: grade it now from the meter, arm it, emit passAttempt. One press per ball.
   * `back` > 0 (lag compensation): graded at the player's view time (also against a pass episode
   * that ended since); a playable press whose contact already passed is applied retroactively.
   */
  function handlePassPress(p, back = 0) {
    const h = hs[p.id];
    const pa = h.pass;
    if (pa.cooldown > 0) return;
    if (pa.lockEpoch === sim.ballEpoch) return; // already pressed for this ball
    const tv = sim.now - back;
    const pm = h.pm;
    if (back > 0 && tv < sim.epochStart - 1e-9) {
      // Seen on a previous ball that has since been touched/deflected: judge it against that
      // ball's episode (too late to play it), but don't spend the press on the current ball.
      const lp = h.lastPm;
      const old = lp.epoch >= 0 && lp.epoch !== sim.ballEpoch && tv <= lp.endedAt + 1e-9;
      const tcOld = old ? lp.t - tv : null;
      const timing = tcOld === null ? 'tooEarly' : classifyPassTiming(tcOld);
      setAction(p, 'bump');
      const st = sim.stats.passTiming;
      st[timing] = (st[timing] || 0) + 1;
      emit('passAttempt', {
        playerId: p.id, position: p.pos.clone(), timing,
        meter: tcOld === null ? null : clamp(1 - tcOld / METER.pass.leadSec, 0, 1),
      });
      return;
    }
    const inReachNow = inReach(p, ball.pos);
    let ep = pm.active ? pm : null;
    let tc = ep ? ep.t - tv : null;
    if (back > 0) {
      // Judged at the player's view time tv against the best estimate of this ball's contact
      // (the episode may have ended since tv; pm keeps its last estimate).
      ep = pm.epoch === sim.ballEpoch && (pm.active || tv <= h.lastPm.endedAt + 1e-9) ? pm : null;
      tc = ep ? ep.t - tv : null;
    }
    let timing;
    if (tc === null) timing = inReachNow ? 'tooLate' : 'tooEarly';
    else timing = classifyPassTiming(tc);
    pa.timing = timing;
    pa.grade = GRADE_OF[timing];
    pa.dive = false;
    pa.armEpoch = sim.ballEpoch;
    if (tc !== null) {
      pa.lockEpoch = sim.ballEpoch;
      pa.armed = clamp(ep.t - sim.now + 0.25, 0.15, 2.5);
      if (timing === 'tooLate' && !inReachNow && tc < -0.05) pa.armed = 0; // it's gone: drops
      if (ep.kind === 'dive' && pa.armed > 0) {
        pa.dive = true;
        pa.diveAt = ep.t - 0.35;
        pa.divePoint.copy(ep.point);
      }
    } else {
      pa.cooldown = TUNING.passCooldown;
      pa.armed = inReachNow ? 0.1 : 0;
    }
    const T = p.team;
    const ours = state.possessionTeam === T && ball.lastTeam === T && teamOfZ(ball.pos.z) === T;
    const n = (ours ? state.touches : 0) + 1;
    if (!pa.dive) setAction(p, n === 2 || ball.pos.y > p.pos.y + 2.2 ? 'set' : 'bump');
    const st = sim.stats.passTiming;
    st[timing] = (st[timing] || 0) + 1;
    const meter = back > 0 && tc !== null ? clamp(1 - tc / METER.pass.leadSec, 0, 1) : p.meters.pass;
    emit('passAttempt', { playerId: p.id, position: p.pos.clone(), timing, meter });
    if (back > 0 && tc !== null && pa.grade !== 'shank') retroPass(p, h, ep, tv);
  }

  // ---------------------------------------------------------------- lag compensation
  const snap = { x: 0, y: 0, z: 0, vy: 0, grounded: true };
  const retroP = new Vector3();
  const retroV = new Vector3();
  const savePos = new Vector3();

  function recordHistory() {
    for (const h of hs) {
      if (!h.lag || !isHuman(players[h.id])) continue;
      const p = players[h.id];
      const H = h.hist;
      H.t[H.i] = sim.now;
      H.x[H.i] = p.pos.x; H.y[H.i] = p.pos.y; H.z[H.i] = p.pos.z;
      H.vy[H.i] = p.vel.y; H.g[H.i] = p.grounded ? 1 : 0;
      H.i = (H.i + 1) % POS_HISTORY;
      H.n = Math.min(POS_HISTORY, H.n + 1);
    }
  }

  /** A jump applied late (rewound): rewrite the recorded heights since it virtually started. */
  function rewriteJumpHistory(p, t0) {
    const H = hs[p.id].hist;
    for (let k = 1; k <= H.n; k++) {
      const j = (H.i - k + POS_HISTORY) % POS_HISTORY;
      if (H.t[j] < t0) break;
      const u = H.t[j] - t0;
      H.y[j] = PLAYER.jumpVelocity * u - 0.5 * PLAYER.gravity * u * u;
      H.vy[j] = PLAYER.jumpVelocity - PLAYER.gravity * u;
      H.g[j] = 0;
    }
  }

  /** Where a (lag-compensated) human was at sim time t -> `snap`. */
  function playerAt(h, t) {
    const H = h.hist;
    if (H.n === 0) return false;
    let j = -1;
    for (let k = 1; k <= H.n; k++) {
      j = (H.i - k + POS_HISTORY) % POS_HISTORY;
      if (H.t[j] <= t + 1e-9) break;
    }
    snap.x = H.x[j]; snap.y = H.y[j]; snap.z = H.z[j]; snap.vy = H.vy[j]; snap.grounded = H.g[j] === 1;
    return true;
  }

  /** Ball position/velocity at absolute time t on the stored trajectory of the current ball. */
  function sampleTraj(t) {
    const tr = sim.epochTraj;
    if (!tr || sim.trajEpoch !== sim.ballEpoch || tr.n < 2) return false;
    const rel = t - tr.t0;
    if (!(rel >= 0) || rel > tr.t[tr.n - 1]) return false;
    let i = Math.min(tr.n - 2, Math.floor(rel / SAMPLE_DT));
    while (i > 0 && tr.t[i] > rel) i--;
    const span = tr.t[i + 1] - tr.t[i] || SAMPLE_DT;
    const f = clamp((rel - tr.t[i]) / span, 0, 1);
    retroP.set(
      tr.x[i] + (tr.x[i + 1] - tr.x[i]) * f,
      tr.y[i] + (tr.y[i + 1] - tr.y[i]) * f,
      tr.z[i] + (tr.z[i + 1] - tr.z[i]) * f,
    );
    retroV.set((tr.x[i + 1] - tr.x[i]) / span, (tr.y[i + 1] - tr.y[i]) / span, (tr.z[i + 1] - tr.z[i]) / span);
    return Number.isFinite(retroP.x + retroP.y + retroP.z + retroV.x + retroV.y + retroV.z);
  }

  /** Touch number for `p`'s team if it played the ball now, or 0 if it may not touch it. */
  function retroTouchNumber(p) {
    if (sim.mode !== 'rally' || ball.held) return 0;
    const T = p.team;
    if (teamOfZ(ball.pos.z) !== T && !sim.heldLanding) return 0;
    if (sim.serveUntouched && T === state.servingTeam) return 0;
    const ours = state.possessionTeam === T && ball.lastTeam === T;
    if (ours && (state.touches >= RULES.maxTouches || sim.lastToucherId === p.id)) return 0;
    return (ours ? state.touches : 0) + 1;
  }

  /**
   * Apply a touch that (from the player's point of view) happened at `tContact`: put the ball back
   * at that point of its flight, play the touch with the player where they were, then fast-forward
   * the new flight to now. retroP/retroV/snap must be filled in.
   */
  function applyRetroTouch(p, kind, n, tContact) {
    savePos.copy(p.pos);
    const vy = p.vel.y;
    const grounded = p.grounded;
    p.pos.set(snap.x, snap.y, snap.z);
    p.vel.y = snap.vy;
    p.grounded = snap.grounded;
    ball.pos.copy(retroP);
    ball.vel.copy(retroV);
    ball.visible = true;
    sim.landed = false;
    if (sim.heldLanding) sim.stats.heldRescued++;
    sim.heldLanding = null;
    performTouch(p, kind, n);
    p.pos.copy(savePos);
    p.vel.y = vy;
    p.grounded = grounded;
    const subs = Math.round((sim.now - tContact) / BALL_SUBSTEP);
    if (subs > 0) stepBallPhysics(subs * BALL_SUBSTEP, subs);
    if (sim.mode === 'rally' && !sim.landed) onTrajectoryChanged();
    sim.stats.retroTouches++;
  }

  /** A late, playable K press: touch at the contact the player saw, if they were there. */
  function retroPass(p, h, ep, tv) {
    const tContact = Math.max(ep.t, tv);
    if (tContact >= sim.now - 1e-6) return false; // contact still ahead: the armed press plays it
    const n = retroTouchNumber(p);
    if (!n || !sampleTraj(tContact) || !playerAt(h, tContact)) return false;
    const dive = ep.kind === 'dive';
    const r = reachRadius(p) + TUNING.retroReachSlack + (dive ? TUNING.diveRange + TUNING.diveReachBonus : 0);
    if (Math.hypot(retroP.x - snap.x, retroP.z - snap.z) > r) return false;
    if (retroP.y < snap.y + PLAYER.reachBelow - 0.1 || retroP.y > snap.y + PLAYER.standingReach + 0.4) return false;
    let kind = n === 3 ? 'free' : n === 2 ? 'set' : 'bump';
    if (kind === 'bump' && (dive || retroV.length() > 11)) kind = 'dig';
    if (dive && brains[p.id].diveT < 0 && p.grounded) startDive(p, retroP);
    applyRetroTouch(p, kind, n, tContact);
    return true;
  }

  /** A late graded J release: spike at the contact the player saw, if they were up there. */
  function retroSpike(p, h, tv) {
    const sm = h.sm;
    let tContact = Math.max(sm.t, tv);
    if (tContact >= sim.now - 1e-6 || !playerAt(h, tContact)) return false;
    if (snap.grounded) {
      tContact = Math.max(sm.tStand, tv);
      if (tContact >= sim.now - 1e-6 || !playerAt(h, tContact)) return false;
    }
    const n = retroTouchNumber(p);
    if (!n || !sampleTraj(tContact)) return false;
    const r = reachRadius(p) + TUNING.spikeReachAssist + TUNING.retroReachSlack;
    if (Math.hypot(retroP.x - snap.x, retroP.z - snap.z) > r) return false;
    if (retroP.y < snap.y + PLAYER.reachBelow ||
        retroP.y > snap.y + PLAYER.standingReach + 0.3 + TUNING.spikeReachUp + 0.1) return false;
    let kind;
    if (!snap.grounded) {
      if (Math.abs(retroP.z) >= 3.5) return false;
      kind = retroP.y > NH + 0.1 ? 'spike' : 'dink';
    } else kind = 'dink'; // standing shot over
    applyRetroTouch(p, kind, n, tContact);
    return true;
  }

  /**
   * A remote (lag-compensated) human saw a meter for the current ball recently and has not
   * pressed for it yet: their press may still be on its way.
   */
  function lagEpisodeLive(p) {
    const h = hs[p.id];
    if (!h.lag || !isHuman(p) || sim.mode !== 'rally') return false;
    const e = sim.ballEpoch;
    if (h.pass.lockEpoch === e || h.sm.lockEpoch === e) return false;
    if (h.pm.active && h.pm.epoch === e) return true;
    if (h.lastPm.epoch === e && sim.now - h.lastPm.endedAt <= NET.maxRewind) return true;
    return h.sm.active && h.sm.epoch === e && !h.sm.handedOff && sim.now - h.sm.t <= NET.maxRewind;
  }
  function lagHold() {
    for (const p of players) if (lagEpisodeLive(p)) return true;
    return false;
  }

  /**
   * Predict human `p`'s next contact from the ball trajectory and their current position: the
   * first moment the ball is inside reach at a comfortable height (or about to leave reach); else
   * a dive contact (low ball within reach + diveRange); else, for their own ball, when it reaches
   * contact height at the intercept point. Returns false if no ball is coming to them.
   */
  function predictHumanContact(p, out) {
    out.reason = 'ineligible'; // why there's no contact: 'ineligible' (not their ball) or 'none'
    const tr = sim.traj;
    if (sim.mode !== 'rally' || ball.held || sim.landed || !tr || !isHuman(p)) return false;
    const T = p.team;
    const s = side(T);
    const h = hs[p.id];
    if (sim.serveUntouched && state.servingTeam === T) return false;
    const ours = state.possessionTeam === T && ball.lastTeam === T;
    if (ours && (sim.lastToucherId === p.id || state.touches >= 3)) return false;
    const n = (ours ? state.touches : 0) + 1;
    // An attack ball (the partner's set, an overpass at the net) belongs to J's spike meter until
    // it is handed off (grounded, J untouched, past the jump cue: see updateSpikeMeter).
    if (spikeOwnsBall(p)) return false;
    if (ours && n === 3 && sim.lastToucherId !== p.id && (h.hitHeld >= 0 || !p.grounded)) return false;
    const pref = n === 2 ? SET_CONTACT_Y : BUMP_CONTACT_Y;
    out.reason = 'none';
    // Slightly conservative reach so a ball only skimming the edge isn't promised as a contact.
    const reach = PLAYER.reachRadius * TUNING.humanReachMul - 0.06;
    const lo = PLAYER.reachBelow;
    const hi = PLAYER.standingReach + 0.3;
    const i0 = Math.max(1, Math.ceil((sim.now - tr.t0) / SAMPLE_DT - 1e-6));
    const iMax = Math.min(tr.n, i0 + Math.ceil(2.5 / SAMPLE_DT));
    const inR = (i) => tr.z[i] * s > 0 && tr.y[i] >= lo && tr.y[i] <= hi &&
      Math.hypot(tr.x[i] - p.pos.x, tr.z[i] - p.pos.z) < reach;
    let diveI = -1;
    // A ball still rising toward an apex above reach (e.g. the partner's pass going up past them)
    // comes back down: it is not a contact on the way up.
    let peakI = i0;
    for (let i = i0; i < iMax; i++) if (tr.y[i] > tr.y[peakI]) peakI = i;
    const highApex = tr.y[peakI] > hi;
    for (let i = i0; i < iMax; i++) {
      if (tr.z[i] * s <= 0) continue;
      if (highApex && i < peakI) continue;
      if (inR(i)) {
        const rising = tr.y[i] > tr.y[i - 1] + 0.5 * SAMPLE_DT;
        if (tr.y[i] <= pref || rising || i + 1 >= tr.n || !inR(i + 1)) {
          out.t = tr.t0 + tr.t[i]; out.kind = 'pass'; out.point.set(tr.x[i], tr.y[i], tr.z[i]);
          return true;
        }
      } else if (diveI < 0 && tr.y[i] <= 0.6 && Math.hypot(tr.x[i] - p.pos.x, tr.z[i] - p.pos.z) < reach + TUNING.diveRange) {
        diveI = i;
      }
    }
    if (diveI >= 0) {
      out.t = tr.t0 + tr.t[diveI]; out.kind = 'dive'; out.point.set(tr.x[diveI], tr.y[diveI], tr.z[diveI]);
      return true;
    }
    if (sim.designated[T] === p.id && tr.hasLanding && tr.landing.z * s > 0) {
      const t = intercept(tr, pref, out.point);
      // Only if they can actually get there in time (a bit looser once the needle is showing).
      const gap = hdist(p.pos, out.point) - reach;
      const slack = h.pm.active && h.pm.kind === 'owned' ? 0.3 : 0.15;
      if (t >= 0 && gap <= PLAYER.moveSpeed * Math.max(0, t - sim.now - 0.1) + slack) {
        out.t = t; out.kind = 'owned'; return true;
      }
    }
    return false;
  }

  /** The spike meter owns the current ball for human `p` (their K meter must stay hidden). */
  function spikeOwnsBall(p) {
    const sm = hs[p.id].sm;
    return sm.active && sm.epoch === sim.ballEpoch && !sm.handedOff;
  }

  /**
   * Exact time (interpolated between samples) the ball next descends through height h, with the
   * point in `out`; -1 if it doesn't (already below h, or never that high).
   */
  function descendThrough(tr, h, out) {
    if (!tr || tr.n < 2) return -1;
    const i0 = Math.max(1, Math.ceil((sim.now - tr.t0) / SAMPLE_DT - 1e-6));
    for (let i = i0; i < tr.n; i++) {
      const y0 = tr.y[i - 1];
      const y1 = tr.y[i];
      if (y0 > h && y1 <= h) {
        const f = (y0 - h) / (y0 - y1);
        out.set(tr.x[i - 1] + (tr.x[i] - tr.x[i - 1]) * f, h, tr.z[i - 1] + (tr.z[i] - tr.z[i - 1]) * f);
        return tr.t0 + tr.t[i - 1] + (tr.t[i] - tr.t[i - 1]) * f;
      }
    }
    return -1;
  }

  /**
   * Attack ball coming to human `p`? Contact = the moment the ball descends through
   * ATTACK_CONTACT_Y (where sets are aimed), on their side within reach of the net. It depends
   * only on the ball's flight, so it stays put while they run under it. Cases: the partner's set
   * (3rd touch), or an opponent ball dropping through attack height right at the net that they can
   * get to.
   */
  const spred = { t: 0, tStand: 0, kind: null, point: new Vector3() };
  function predictSpikeContact(p, out) {
    const tr = sim.traj;
    if (sim.mode !== 'rally' || ball.held || sim.landed || !tr || !isHuman(p)) return false;
    const T = p.team;
    const s = side(T);
    const ours = state.possessionTeam === T && ball.lastTeam === T;
    let kind;
    if (ours && state.touches === 2 && sim.lastToucherId === (p.id ^ 1)) kind = 'set';
    else if (ball.lastTeam === 1 - T && !sim.serveUntouched) kind = 'overpass';
    else return false;
    const t = descendThrough(tr, ATTACK_CONTACT_Y, out.point);
    if (t < 0) return false;
    const z = out.point.z * s;
    if (z <= 0.05 || z > (kind === 'set' ? 3.0 : TUNING.spikeOverpassMaxZ)) return false;
    if (kind === 'overpass') {
      // Only if they are up at the net and can get under it in time.
      const sm = hs[p.id].sm;
      const ongoing = sm.active && sm.epoch === sim.ballEpoch;
      const gap = hdist(p.pos, out.point) - reachRadius(p);
      if (!ongoing && p.pos.z * s > 2.5) return false;
      if (gap > PLAYER.moveSpeed * Math.max(0, t - sim.now - 0.1) + (ongoing ? 0.4 : 0.1)) return false;
    }
    const ts = descendThrough(tr, PLAYER.standingReach + 0.3, tmpB);
    out.t = t;
    out.tStand = ts > t ? ts : t;
    out.kind = kind;
    return true;
  }

  /**
   * Ball-synced spike meter -> meters.spike (same rules as the pass meter: one episode per
   * ball, blank briefly on a new ball, never runs backwards; with less warning than leadSec the
   * part before the JUMP mark is stretched so the needle starts at 0 while the JUMP mark and the
   * green zone stay true to time). If the player is still on the ground with J untouched once the
   * jump cue is well past (or they can't get there), the ball is handed to the K meter.
   */
  function updateSpikeMeter(p, h) {
    const sm = h.sm;
    const found = predictSpikeContact(p, spred);
    if (sm.active && sm.epoch !== sim.ballEpoch) {
      sm.active = false;
      sm.gapUntil = sim.now + 0.12;
    }
    if (!found) {
      // The ball has passed attack height: keep the episode briefly so a late release grades 'late'
      // (also while a landing is held for a remote player's late release).
      const keep = sm.active && sim.mode === 'rally' && (!sim.landed || !!sim.heldLanding) && sim.now - sm.t < 0.4;
      if (!keep) { sm.active = false; p.meters.spike = null; return; }
    } else if (!sm.active) {
      if (sim.now < sm.gapUntil) { p.meters.spike = null; return; }
      const tc0 = spred.t - sim.now;
      // Not enough warning to jump for it: leave it to K.
      if (tc0 < JUMP_TO_APEX + 0.05) { p.meters.spike = null; return; }
      sm.active = true;
      sm.epoch = sim.ballEpoch;
      sm.tc0 = tc0;
      sm.shown = 0;
      sm.handedOff = false;
      sm.jumpAt = -1;
      sm.t = spred.t;
      sm.tStand = spred.tStand;
      sm.kind = spred.kind;
      sm.point.copy(spred.point);
    } else {
      sm.t = spred.t;
      sm.tStand = spred.tStand;
      sm.point.copy(spred.point);
    }
    const { leadSec } = METER.spike;
    const tc = sm.t - sim.now;
    const m = spikeValueAt(sm, sim.now);
    // Grading value (unclamped above 1 after contact); the needle never runs backwards.
    sm.value = Math.max(m, sm.shown);
    sm.shown = Math.max(clamp(m, 0, 1), sm.shown);
    if (!sm.handedOff && sm.lockEpoch !== sim.ballEpoch) {
      if (p.grounded && h.hitHeld < 0) {
        const gap = hdist(p.pos, sm.point) - reachRadius(p);
        const cantReach = gap > PLAYER.moveSpeed * Math.max(0, tc - 0.1) + 0.3;
        if (tc < TUNING.spikeHandoffTc || (cantReach && tc < 0.6)) sm.handedOff = true;
      }
    }
    p.meters.spike = sm.handedOff || tc > leadSec || tc < -0.15 ? null : sm.shown;
  }

  const predicted = { t: 0, kind: null, point: new Vector3(), reason: 'none' };
  function endPassEpisode(h) {
    const pm = h.pm;
    if (pm.active) {
      const lp = h.lastPm;
      lp.epoch = pm.epoch; lp.t = pm.t; lp.kind = pm.kind; lp.point.copy(pm.point); lp.endedAt = sim.now;
    }
    pm.active = false;
  }
  /**
   * Smoothed contact prediction -> meters.pass. One episode per ball (ballEpoch): a new
   * touch/block/net deflection hides the needle briefly and starts again from 0 (never jumps
   * backwards). If the warning is shorter than leadSec, the pre-green part of the fill is
   * stretched so the needle still starts at 0; the green zone always maps to METER.pass.green.
   */
  function updatePassMeter(p, h, dt) {
    const pm = h.pm;
    const found = predictHumanContact(p, predicted);
    if (pm.active && pm.epoch !== sim.ballEpoch) {
      // New ball: blank the needle for a moment, then a fresh episode.
      endPassEpisode(h);
      pm.gapUntil = sim.now + 0.12;
    }
    if (!found) {
      // Brief prediction gaps at the edge of reach don't end an episode (no flicker); losing the
      // ball for a real reason (not their ball any more, out of range, attacking) does.
      const edge = predicted.reason === 'none' && pm.kind !== 'owned';
      if (edge && pm.active && sim.now - pm.lastSeen < 0.15 && pm.t - sim.now > -0.15) {
        showMeter(p, h);
        return;
      }
      endPassEpisode(h);
      p.meters.pass = null;
      return;
    }
    if (sim.now < pm.gapUntil) { p.meters.pass = null; return; }
    if (!pm.active) {
      pm.active = true;
      pm.epoch = sim.ballEpoch;
      pm.t = predicted.t;
      pm.tc0 = predicted.t - sim.now;
      pm.shown = 0;
    } else if (Math.abs(predicted.t - pm.t) > 0.25) {
      pm.t = predicted.t;
    } else {
      pm.t += (predicted.t - pm.t) * Math.min(1, dt * 10);
    }
    pm.lastSeen = sim.now;
    pm.kind = predicted.kind;
    pm.point.copy(predicted.point);
    showMeter(p, h);
  }

  function showMeter(p, h) {
    const pm = h.pm;
    const { leadSec, green } = METER.pass;
    const tc = pm.t - sim.now;
    // Too short to react to (ball only reaches them at the last instant): grade presses, but
    // don't flash a needle that is already full.
    if (tc > leadSec || tc < -0.15 || pm.tc0 < TUNING.passMinLead) { p.meters.pass = null; return; }
    const tcGreen = (1 - green[0]) * leadSec; // where green starts (s before contact)
    let m;
    if (tc <= tcGreen || pm.tc0 <= tcGreen + 0.05) m = 1 - tc / leadSec;
    else {
      const span = Math.min(Math.max(pm.tc0, tcGreen + 0.05), leadSec);
      m = green[0] * clamp((span - tc) / (span - tcGreen), 0, 1);
    }
    m = Math.max(clamp(m, 0, 1), pm.shown); // never backwards within an episode
    pm.shown = m;
    p.meters.pass = m;
  }

  function aiDesired(p, b) {
    const prof = profileFor(p.team);
    const maxV = PLAYER.moveSpeed * prof.speedMul;
    const dx = b.target.x - p.pos.x;
    const dz = b.target.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.04) { b.dvx = 0; b.dvz = 0; return; }
    const sp = Math.min(maxV, Math.sqrt(2 * PLAYER.accel * 0.7 * d));
    b.dvx = (dx / d) * sp;
    b.dvz = (dz / d) * sp;
  }

  function confine(p) {
    const s = side(p.team);
    const zs = p.pos.z * s;
    const zMin = PLAYER.radius;
    const zMax = COURT.halfLength + 2.5;
    if (zs < zMin) { p.pos.z = s * zMin; if (p.vel.z * s < 0) p.vel.z = 0; }
    else if (zs > zMax) { p.pos.z = s * zMax; if (p.vel.z * s > 0) p.vel.z = 0; }
    const xMax = COURT.halfWidth + 2.5;
    if (Math.abs(p.pos.x) > xMax) { p.pos.x = Math.sign(p.pos.x) * xMax; p.vel.x = 0; }
  }

  function separate() {
    const minD = PLAYER.radius * 2;
    for (let t = 0; t < 2; t++) {
      const a = players[t * 2];
      const b = players[t * 2 + 1];
      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      let d = Math.hypot(dx, dz);
      if (d >= minD) continue;
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
      const push = (minD - d) / 2;
      a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
      b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      confine(a);
      confine(b);
    }
  }

  function updatePlayers(dt) {
    for (const p of players) {
      const b = brains[p.id];
      if (isHuman(p)) humanControl(p, b);
      else { aiThink(g, p); aiDesired(p, b); }

      if (b.diveT >= 0) {
        b.diveT += dt;
        const f = Math.exp(-(b.diveT < 0.3 ? 1.5 : 7) * dt);
        p.vel.x *= f;
        p.vel.z *= f;
        if (b.diveT > 0.95) { b.diveT = -1; if (p.action === 'dive') setAction(p, null); }
      } else if (p.grounded) {
        const ax = b.dvx - p.vel.x;
        const az = b.dvz - p.vel.z;
        const m = Math.hypot(ax, az);
        const maxDv = PLAYER.accel * dt;
        if (m > maxDv) { p.vel.x += (ax / m) * maxDv; p.vel.z += (az / m) * maxDv; }
        else { p.vel.x = b.dvx; p.vel.z = b.dvz; }
      }
      if (!p.grounded) p.vel.y -= PLAYER.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (!p.grounded && p.pos.y <= 0) {
        p.pos.y = 0;
        p.vel.y = 0;
        p.grounded = true;
        emit('land', { playerId: p.id, position: p.pos.clone() });
      }
      confine(p);
    }
    separate();
    for (const p of players) {
      // Face the ball (or the net while serving).
      let want;
      const dx = ball.pos.x - p.pos.x;
      const dz = ball.pos.z - p.pos.z;
      if (sim.mode === 'serve' || ball.held || dx * dx + dz * dz < 0.01) want = side(p.team) > 0 ? Math.PI : 0;
      else want = Math.atan2(dx, dz);
      let diff = want - p.facing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const maxTurn = TUNING.turnRate * dt;
      p.facing += clamp(diff, -maxTurn, maxTurn);
      p.facing = Math.atan2(Math.sin(p.facing), Math.cos(p.facing));
      // Action timers.
      p.actionTime += dt;
      const dur = ACTION_DURATION[p.action];
      if (dur !== undefined && p.actionTime > dur && !(p.action === 'block' && !p.grounded)) p.action = null;
    }
  }

  function updateAim() {
    for (const p of players) p.meters.aimTarget = isHuman(p) ? aimFor(p) : null;
  }
  /** Where human `p`'s serve or attack would land (aim reticle), or null. */
  function aimFor(p) {
    const vec = hs[p.id].aimVec;
    const sv = sim.serve;
    if (sim.mode === 'serve' && sv.human && sv.stage === 'charging' && state.serverId === p.id) {
      vec.set(sv.target.x, 0, sv.target.z);
      return vec;
    }
    if (sim.mode === 'rally') {
      const T = p.team;
      const ours = state.possessionTeam === T && ball.lastTeam === T;
      // A set to this player, or them in the air near the net with a ball on their side to attack.
      const setToMe = ours && state.touches === 2 && sim.designated[T] === p.id;
      const attackBall = teamOfZ(ball.pos.z) === T && !(ours && (state.touches >= 3 || sim.lastToucherId === p.id));
      const likely = setToMe || p.meters.spike !== null || (!p.grounded && Math.abs(p.pos.z) < 1.8 && attackBall && ball.pos.y > NH);
      if (likely) {
        humanAimTarget(p, true, vec);
        vec.y = 0;
        return vec;
      }
    }
    return null;
  }

  /** Top-level meter fields mirror players[controlledId] (this screen's player). */
  function syncMirrors() {
    const c = players[state.controlledId] || players[0];
    const m = c.meters;
    const h = hs[c.id];
    const human = isHuman(c);
    state.passMeter = m.pass;
    state.spikeMeter = m.spike;
    state.hitCharge = m.hitCharge;
    state.serveCharge = m.serveCharge;
    state.serveRisk = m.serveRisk;
    state.aimTarget = m.aimTarget;
    state.hitWindow = human ? h.swing : 0;
    state.passWindow = human ? h.pass.armed : 0;
    m.hitWindow = state.hitWindow;
    m.passWindow = state.passWindow;
  }

  function checkStall(dt) {
    sim.rallyTime += dt;
    if (ball.vel.lengthSq() < 0.01) sim.stillTime += dt; else sim.stillTime = 0;
    if (sim.stillTime > 1.5 || sim.rallyTime > 120) {
      sim.stats.stalls++;
      awardPoint(1 - teamOfZ(ball.pos.z), 'in', ball.pos);
    }
  }

  /** A landing held for lag compensation is decided once no remote press can still arrive. */
  function checkHeldLanding() {
    const hl = sim.heldLanding;
    if (!hl) return;
    if (sim.now - hl.at > NET.maxRewind || !lagHold()) {
      sim.heldLanding = null;
      awardPoint(hl.verdict.winnerTeam, hl.verdict.reason, hl.pos);
    }
  }

  function clearLatches(h) {
    h.jumpPressed = false;
    h.hitPressed = false;
    h.hitReleased = false;
    h.passPressed = false;
    h.jumpT = null;
    h.hitPressT = null;
    h.hitReleaseT = null;
    h.passT = null;
  }

  // ---------------------------------------------------------------- main step
  function step(dt) {
    sim.now += dt;
    if (!sim.attract) state.time += dt;
    if (sim.touchCooldown > 0) sim.touchCooldown -= dt;

    if (sim.mode === 'serve') stepServe(dt);
    else if (sim.mode === 'point') {
      sim.pointTimer -= dt;
      if (sim.pointTimer <= 0) afterPoint();
    }

    updateDesignated();
    updateControl();
    updatePlayers(dt);
    if (!ball.held) stepBallPhysics(dt);
    if (sim.mode === 'rally') {
      checkBlock();
      checkTouches();
      if (sim.mode === 'rally') checkHeldLanding();
      if (sim.mode === 'rally' && !sim.heldLanding) checkStall(dt);
    }
    updateAim();
    for (const h of hs) {
      const p = players[h.id];
      if (h.swing > 0) h.swing = Math.max(0, h.swing - dt);
      const pa = h.pass;
      if (pa.armed > 0) pa.armed = Math.max(0, pa.armed - dt);
      if (pa.cooldown > 0) pa.cooldown = Math.max(0, pa.cooldown - dt);
      // A press belongs to one ball: another touch, a block or a net/post deflection voids it.
      if (pa.armEpoch !== sim.ballEpoch) { pa.armed = 0; pa.dive = false; }
      if (sim.mode !== 'rally') { h.swing = 0; pa.armed = 0; pa.dive = false; pa.lockEpoch = -1; }
      if (sim.mode !== 'rally' || !isHuman(p)) h.hitHeld = -1;
      updateSpikeMeter(p, h);
      updatePassMeter(p, h, dt);
      p.meters.hitCharge = h.hitHeld >= 0 ? Math.min(1, h.hitHeld / TUNING.windupSec) : null;
      const human = isHuman(p);
      p.meters.hitWindow = human ? h.swing : 0;
      p.meters.passWindow = human ? pa.armed : 0;
      clearLatches(h);
    }
    recordHistory();
    syncMirrors();
  }

  // ---------------------------------------------------------------- public API
  function update(dt) {
    let pausePressed = false;
    for (const h of hs) {
      const inp = h.inp;
      if (!inp) continue;
      // The same input object on two slots is polled once (edges would be lost otherwise).
      let dup = false;
      for (let k = 0; k < h.id; k++) if (hs[k].inp === inp) dup = true;
      if (!dup && typeof inp.poll === 'function') inp.poll();
      if (inp.pressed('jump')) { h.jumpPressed = true; if (h.lag) h.jumpT = inp.edgeTime('jump'); }
      if (inp.pressed('hit')) { h.hitPressed = true; if (h.lag) h.hitPressT = inp.edgeTime('hit'); }
      if (inp.pressed('pass')) { h.passPressed = true; if (h.lag) h.passT = inp.edgeTime('pass'); }
      if (inp.released('hit')) { h.hitReleased = true; if (h.lag) h.hitReleaseT = inp.edgeTime('hit'); }
      if (inp.pressed('pause')) pausePressed = true;
    }
    if (pauseOnlyInput) {
      if (typeof pauseOnlyInput.poll === 'function') pauseOnlyInput.poll();
      if (pauseOnlyInput.pressed('pause')) pausePressed = true;
    }
    if (pausePressed && allowPause && !sim.attract && (sim.mode === 'serve' || sim.mode === 'rally' || sim.mode === 'point')) {
      if (state.paused) resume(); else pause();
    }
    if (state.paused) {
      for (const h of hs) clearLatches(h);
      return;
    }
    if (!(dt > 0)) return;
    sim.acc += Math.min(dt, 0.1);
    while (sim.acc >= DT) {
      step(DT);
      sim.acc -= DT;
    }
  }

  function resetScore() {
    state.score[0] = 0;
    state.score[1] = 0;
    state.lastPoint = null;
    state.servingTeam = 0;
    state.serverId = 0;
    sim.lastServerIdx[0] = 0;
    sim.lastServerIdx[1] = -1;
  }

  function resetHumanState(h) {
    clearLatches(h);
    h.swing = 0;
    h.swingV = 0;
    h.hitHeld = -1;
    const pa = h.pass;
    pa.armed = 0; pa.dive = false; pa.cooldown = 0; pa.lockEpoch = -1; pa.armEpoch = -1; pa.grade = null; pa.timing = null;
    h.pm.active = false;
    h.lastPm.epoch = -1;
    h.sm.active = false;
    h.sm.lockEpoch = -1;
    h.spikeSwing.graded = false;
    h.hist.n = 0;
    const m = players[h.id].meters;
    m.pass = null; m.spike = null; m.hitCharge = null; m.serveCharge = null; m.serveRisk = null; m.aimTarget = null;
    m.passWindow = 0; m.hitWindow = 0;
  }

  const isInput = (x) => !!x && typeof x.held === 'function' && typeof x.pressed === 'function' &&
    typeof x.released === 'function' && typeof x.axis === 'function';

  /**
   * Which slots are human: `list[id]` = input object, or null = AI. Applied immediately; a player
   * switching to AI mid-rally just becomes AI (their meters/presses are dropped). If the current
   * server changes hands before serving, the serve restarts for the new owner (serveReady again).
   */
  function setInputs(list) {
    const arr = Array.isArray(list) ? list : [];
    for (const h of hs) {
      const next = autoplay ? null : (isInput(arr[h.id]) ? arr[h.id] : null);
      if (h.inp === next) continue;
      h.inp = next;
      h.lag = !!next && typeof next.edgeTime === 'function';
      resetHumanState(h);
    }
    if (sim.mode === 'serve' && !sim.attract) {
      const sv = sim.serve;
      const human = isHuman(players[state.serverId]);
      if (human !== sv.human && (sv.stage === 'ready' || sv.stage === 'charging')) {
        sv.human = human;
        sv.stage = 'ready';
        sv.charge = 0;
        sv.over = 0;
        sv.buffered = false;
        sv.timer = 0;
        sv.nextAt = TUNING.cpuServeDelay;
        clearServeMeters();
        emitServeReady();
      }
    }
    updateControl();
    syncMirrors();
  }

  function startMatch({ difficulty } = {}) {
    state.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    buildCpuProfile();
    sim.attract = false;
    state.time = 0;
    sim.acc = 0;
    sim.stats = createStats();
    resetScore();
    state.controlledId = defaultControlled;
    for (const h of hs) resetHumanState(h);
    if (state.paused) { state.paused = false; bus.emit('resume', {}); }
    setupServe(false); // phase is 'serve' before anyone hears about the match
    updateControl();
    syncMirrors();
    bus.emit('matchStart', { difficulty: state.difficulty });
    emitServeReady();
  }

  function pause() {
    if (state.paused || sim.attract || !allowPause) return;
    state.paused = true;
    bus.emit('pause', {});
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    sim.acc = 0;
    for (const h of hs) { h.hitPressed = false; h.hitReleased = false; }
    // Hit released while paused: cancel the charge instead of firing a weak serve.
    const sv = sim.serve;
    const serverInput = hs[state.serverId].inp || NULL_INPUT;
    if (sim.mode === 'serve' && sv.stage === 'charging' && !serverInput.held('hit')) {
      sv.stage = 'ready';
      sv.charge = 0;
      sv.over = 0;
      sv.buffered = false;
      clearServeMeters();
      players[state.serverId].meters.aimTarget = null;
      syncMirrors();
    }
    bus.emit('resume', {});
  }

  function toMenu() {
    sim.attract = true;
    if (state.paused) { state.paused = false; bus.emit('resume', {}); }
    for (const h of hs) resetHumanState(h);
    resetScore();
    setupServe();
    updateControl();
    syncMirrors();
    syncPhase();
    bus.emit('menu', {});
  }

  // Who is human: online `inputs[4]` (null = AI); offline `input` drives player 0.
  // Autoplay: everyone is AI, the input is only polled for pause.
  let pauseOnlyInput = null;
  if (autoplay) pauseOnlyInput = isInput(input) ? input : null;
  else if (Array.isArray(inputs)) setInputs(inputs);
  else setInputs([isInput(input) ? input : NULL_INPUT, null, null, null]);

  // Initial attract-mode rally behind the menu.
  resetScore();
  setupServe();
  updateControl();
  syncPhase();

  return {
    state,
    startMatch,
    update,
    pause,
    resume,
    toMenu,
    setInputs,
    /** Internal hooks for tests/QA (not part of the contract). */
    debug: { sim, brains, hs, profileFor, get stats() { return sim.stats; } },
  };
}

function createStats() {
  const stats = {
    rallies: 0,
    points: 0,
    hits: 0,
    hitsByType: {},
    rallyHits: [],
    curRallyHits: 0,
    reasons: {},
    spikes: [0, 0],
    blocks: [0, 0],
    crossings: 0,
    netViolations: 0,
    stalls: 0,
    shanks: 0,
    retroTouches: 0,       // lag compensation: late presses applied at the contact the player saw
    heldLandings: 0,       // landings whose point waited for a remote player's press
    heldRescued: 0,        // ...that were then played retroactively (no point)
    humanPass: {},
    passTiming: {},
    humanSpike: {},
    spikeTiming: {},
    pointsBy: [{}, {}],
    onHit(h) {
      stats.hits++;
      stats.curRallyHits++;
      stats.hitsByType[h.type] = (stats.hitsByType[h.type] || 0) + 1;
    },
    onPoint(winner, reason) {
      stats.points++;
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      stats.pointsBy[winner][reason] = (stats.pointsBy[winner][reason] || 0) + 1;
      stats.rallyHits.push(stats.curRallyHits);
      stats.curRallyHits = 0;
    },
  };
  return stats;
}
