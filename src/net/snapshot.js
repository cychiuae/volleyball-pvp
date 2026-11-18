// Compact snapshot codec shared by the server (encode) and the browser client (decode/interpolate).
// Pure JS, no DOM / Node APIs, no three.js: the server imports it from ../src/net/snapshot.js.
//
// Wire shape (JSON, all numbers quantised to integers):
//   s = {
//     m: matchSerial,               // bumps on every (re)start; the client resets its clock on change
//     t: simTimeMs,                 // state.time in ms
//     g: [phase, diff, score0, score1, servingTeam, serverId, touches, possessionTeam(-1 = null),
//         lastPointWinner(-1 = null), lastPointReason(-1 = null)],
//     b: [px,py,pz, vx,vy,vz, sx,sy,sz, flags(visible | held<<1), lastTeam(-1), (lx,ly,lz)?],
//     p: [ player x4: [px,py,pz, vx,vy,vz, facing, flags(grounded | human<<1), action, actionTimeMs,
//                      meters?] ],
//     n: [name|null x4]             // only when names/slots changed, on joins and every second
//   }
//   meters = 0 when every meter is idle, else
//            [pass, spike, hitCharge, serveCharge, serveRisk, passWindowMs, hitWindowMs, (ax,ay,az)?]
//            with -1 = null for the 0..1 meters (quantised to 1e-3).
// Units: positions mm, velocities cm/s, spin 1e-2 rad/s, angles 1e-3 rad, times ms.
// Enumerations are sent as indices into the tables below; an unknown value (added later by
// src/game) is sent as its string, so the codec never silently drops new states.

export const PHASES = ['menu', 'serve', 'rally', 'point', 'matchOver'];
export const DIFFS = ['easy', 'normal', 'hard'];
export const ACTIONS_ENUM = [null, 'bump', 'set', 'spike', 'serveToss', 'serveHit', 'block', 'dive', 'celebrate', 'sad'];
export const REASONS = ['in', 'out', 'net', 'fourHits', 'serveFault'];

const enc = (table, v) => {
  const i = table.indexOf(v);
  return i >= 0 ? i : (typeof v === 'string' ? v : 0);
};
export const decEnum = (table, v) => (typeof v === 'string' ? v : table[v] ?? table[0]);

const q = (v, s) => (Number.isFinite(v) ? Math.round(v * s) : 0);
const qm = (v) => (v === null || v === undefined || !Number.isFinite(v) ? -1 : Math.round(Math.max(0, v) * 1000));
const qi = (v) => (v === null || v === undefined || !Number.isFinite(v) ? -1 : v | 0);

/** Meter fields of a player, falling back to the legacy top-level mirrors for the controlled player. */
function metersOf(state, p) {
  if (p.meters) return p.meters;
  if (p.id !== state.controlledId) return null;
  return {
    pass: state.passMeter, spike: state.spikeMeter, hitCharge: state.hitCharge,
    serveCharge: state.serveCharge, serveRisk: state.serveRisk, aimTarget: state.aimTarget,
    passWindow: state.passWindow, hitWindow: state.hitWindow,
  };
}

function encMeters(m) {
  if (!m) return 0;
  const pw = Number.isFinite(m.passWindow) ? m.passWindow : 0;
  const hw = Number.isFinite(m.hitWindow) ? m.hitWindow : 0;
  const a = m.aimTarget;
  if (m.pass == null && m.spike == null && m.hitCharge == null && m.serveCharge == null &&
      m.serveRisk == null && !a && !(pw > 0) && !(hw > 0)) return 0;
  const out = [qm(m.pass), qm(m.spike), qm(m.hitCharge), qm(m.serveCharge), qm(m.serveRisk), q(pw, 1000), q(hw, 1000)];
  if (a) out.push(q(a.x, 1000), q(a.y, 1000), q(a.z, 1000));
  return out;
}

/**
 * Encode `state` (the live game.state) into the compact wire object.
 * @param {object} state
 * @param {{ m: number, humans: boolean[], names?: (string|null)[] | null }} ctx
 */
export function encodeSnapshot(state, ctx) {
  const b = state.ball;
  const lp = state.lastPoint;
  const s = {
    m: ctx.m,
    t: q(state.time, 1000),
    g: [
      enc(PHASES, state.phase), enc(DIFFS, state.difficulty), state.score[0] | 0, state.score[1] | 0,
      qi(state.servingTeam), qi(state.serverId), qi(state.touches), qi(state.possessionTeam),
      lp ? qi(lp.winnerTeam) : -1, lp ? enc(REASONS, lp.reason) : -1,
    ],
    b: [
      q(b.pos.x, 1000), q(b.pos.y, 1000), q(b.pos.z, 1000),
      q(b.vel.x, 100), q(b.vel.y, 100), q(b.vel.z, 100),
      b.spin ? q(b.spin.x, 100) : 0, b.spin ? q(b.spin.y, 100) : 0, b.spin ? q(b.spin.z, 100) : 0,
      (b.visible ? 1 : 0) | (b.held ? 2 : 0), qi(b.lastTeam),
    ],
    p: new Array(state.players.length),
  };
  if (b.landing) s.b.push(q(b.landing.x, 1000), q(b.landing.y, 1000), q(b.landing.z, 1000));
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const human = ctx.humans ? !!ctx.humans[i] : !!p.human;
    s.p[i] = [
      q(p.pos.x, 1000), q(p.pos.y, 1000), q(p.pos.z, 1000),
      q(p.vel.x, 100), q(p.vel.y, 100), q(p.vel.z, 100),
      q(p.facing, 1000), (p.grounded ? 1 : 0) | (human ? 2 : 0),
      enc(ACTIONS_ENUM, p.action ?? null), q(p.actionTime, 1000),
      encMeters(metersOf(state, p)),
    ];
  }
  if (ctx.names) s.n = ctx.names;
  return s;
}

/** Cheap structural check of a decoded snapshot (client side, defensive against garbage). */
export function isSnapshot(s) {
  return !!s && typeof s === 'object' && Number.isFinite(s.m) && Number.isFinite(s.t) &&
    Array.isArray(s.g) && Array.isArray(s.b) && s.b.length >= 11 && Array.isArray(s.p) && s.p.length === 4 &&
    s.p.every((p) => Array.isArray(p) && p.length >= 10);
}

// ------------------------------------------------------------------ events
/**
 * Serialise an event payload: Vector3-like objects become [x,y,z] arrays (rounded to 0.1 mm) and
 * their keys are listed in `v` so the client can turn exactly those back into Vector3s.
 * Must be called synchronously at emit time (the game reuses its vectors).
 */
export function encodeEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return { p: {}, v: null };
  const p = {};
  let v = null;
  for (const k of Object.keys(payload)) {
    const val = payload[k];
    if (val && typeof val === 'object' && (val.isVector3 || ('x' in val && 'y' in val && 'z' in val && !Array.isArray(val)))) {
      p[k] = [r4(val.x), r4(val.y), r4(val.z)];
      (v || (v = [])).push(k);
    } else if (Array.isArray(val)) {
      p[k] = val.map((x) => (typeof x === 'number' ? r4(x) : x));
    } else if (typeof val === 'number') {
      p[k] = Number.isFinite(val) ? r4(val) : null;
    } else if (val === null || typeof val === 'string' || typeof val === 'boolean') {
      p[k] = val;
    } else if (val && typeof val === 'object') {
      // Nested plain objects (none today): one level, numbers rounded.
      const o = {};
      for (const kk of Object.keys(val)) {
        const x = val[kk];
        o[kk] = typeof x === 'number' ? r4(x) : (x && typeof x === 'object' && x.isVector3 ? [r4(x.x), r4(x.y), r4(x.z)] : x);
      }
      p[k] = o;
    }
  }
  return { p, v };
}
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0);
