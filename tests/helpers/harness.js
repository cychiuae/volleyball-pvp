// Headless match runner shared by the tests (not a test file itself).
import { createEventBus } from '../../src/core/events.js';
import { createGame } from '../../src/game/game.js';
import { createVirtualInput } from '../../src/game/input.js';
import { METER } from '../../src/config.js';


/**
 * Move-key direction whose spike target (game's aim mapping) is farthest from the defenders.
 * `team` = attacker's team (a team-1 human's keys are mirrored: right = -x).
 */
function bestAim(s, defaultAim, team = 0) {
  const sgn = team === 0 ? 1 : -1;
  const opp = s.players.filter((q) => q.team !== team);
  let best = [0, 0];
  let bestD = -1;
  for (const ax of [-1, 0, 1]) {
    for (const ay of [-1, 0, 1]) {
      const x = ax !== 0 ? ax * 2.9 * sgn : defaultAim.x;
      const depth = ay > 0 ? 6.9 : ay < 0 ? 2.5 : defaultAim.d;
      const dmin = Math.min(...opp.map((q) => Math.hypot(q.pos.x - x, q.pos.z + depth * sgn)));
      if (dmin > bestD + 0.3) { bestD = dmin; best = [ax, ay]; }
    }
  }
  return best;
}


/**
 * Scripted "human" playing Momo (players[0]) with the real controls and ~100 ms reaction latency
 * (decisions are made on the current state but applied `latency` frames later):
 *  - serve: hold Hit (J) to a random charge, release;
 *  - follows the landing marker for her own balls; presses Pass (K) once per ball aiming for the
 *    middle of the pass meter's green zone, with +-`passJitter` s of human timing error;
 *  - attacks Pip's sets by following the spike meter cues: runs under the predicted contact
 *    point, presses Space when the needle reaches the JUMP mark (+-`jumpJitter` s, shifted by
 *    `jumpBias` s, + = later), holds J from then and releases it at the middle of green
 *    (+ `releaseBias` meter units) +-`releaseJitter` s; if the meter is handed to K, bumps it over;
 *  - sometimes blocks the CPU attack, otherwise defends deep.
 * Options: hitButton / passButton = false disables that button entirely; aim = true steers spikes
 * with the move keys (in the air) toward the spot farthest from the CPU defenders.
 * id = which player the bot drives (any slot; team-1 bots think in their own mirrored frame and
 * read that player's own meters: players[id].meters, debug.hs[id]).
 */
export function createScriptedHuman(game, input, {
  blockRate = 0.5, rng = Math.random, hitButton = true, passButton = true,
  latencySec = 0.1, passJitter = 0.05, passBias = 0, mash = false, releaseJitter = 0.1, jumpJitter = 0.1,
  jumpBias = 0, releaseBias = 0, aim = false, id = 0,
} = {}) {
  const T = id < 2 ? 0 : 1;
  const O = 1 - T;
  const sgn = T === 0 ? 1 : -1;   // local z = world z * sgn (own side > 0)
  const L = (z) => z * sgn;
  const mateId = id ^ 1;
  const greenMidTc = (1 - (METER.pass.green[0] + METER.pass.green[1]) / 2) * METER.pass.leadSec;
  let lastMash = false;
  let prevMeter = null;
  const [g0, g1] = METER.spike.green;
  const { leadSec: spikeLead, jumpMark } = METER.spike;
  let holding = false;
  let spikeKey = null;
  let spikeHeldKey = null;
  let jumpedKey = null;
  let jumpAtM = 0;      // needle value at which to press Space
  let releaseAtM = 0;   // needle value at which to release J
  let prevSpike = null;
  let wantCharge = 0.6;
  let blockKey = null;
  let willBlock = false;
  let passedKey = null;
  let lead = 0.2;
  let leadKey = null;
  const queue = [];
  function decide(dt) {
    const s = game.state;
    const sim = game.debug.sim;
    const hs = game.debug.hs[id];
    const p = s.players[id];
    const out = { ax: 0, ay: 0, jump: false, hit: false, pass: false };
    if (s.phase === 'serve') {
      if (s.serverId === id && hitButton) {
        const charge = p.meters.serveCharge;
        if (charge === null) {
          wantCharge = 0.3 + rng() * 0.7;
          out.hit = sim.serve.stage === 'ready' && sim.serve.timer > 0.5;
        } else {
          out.hit = charge < wantCharge;
        }
      }
      return out;
    }
    // Spike meter: needle value expected `latencySec` from now (the bot acts with latency, so it
    // anticipates the moving needle like a human does).
    const sm = p.meters.spike;
    let smAhead = null;
    if (sm !== null) {
      const rate = prevSpike !== null && sm > prevSpike ? (sm - prevSpike) / dt : 1 / spikeLead;
      smAhead = sm + rate * latencySec;
    }
    prevSpike = sm;
    // A spike hold in progress: keep J down until the needle reaches the planned release point.
    if (holding) {
      if (sm !== null && smAhead < releaseAtM) out.hit = true;
      else holding = false;
    }
    let tx = -1.5;
    let tz = 4.8;
    if (s.phase === 'rally') {
      const ball = s.ball;
      const ours = s.possessionTeam === T && ball.lastTeam === T;
      const next = sim.designated[T];
      const landing = ball.landing;
      const onUs = L(ball.pos.z) > 0 || (landing && L(landing.z) > 0);
      let passH = 0; // contact height if Momo should pass/set this ball
      if (ours && s.touches === 2 && next === id && landing) {
        const smi = hs.sm;
        const attackBall = smi.active && smi.epoch === sim.ballEpoch && !smi.handedOff;
        if (attackBall) {
          // Run under the predicted contact point (the spike meter's ball).
          tx = smi.point.x;
          tz = Math.max(0.6, L(smi.point.z));
          const key = `${sim.ballEpoch}`;
          if (spikeKey !== key) {
            spikeKey = key;
            jumpAtM = jumpMark + (jumpBias + (rng() * 2 - 1) * jumpJitter) / spikeLead;
            releaseAtM = (g0 + g1) / 2 + releaseBias + ((rng() * 2 - 1) * releaseJitter) / spikeLead;
          }
          const under = Math.hypot(tx - p.pos.x, tz * sgn - p.pos.z) < 0.9;
          // Wind up J a little before the jump (or before an early release), jump on the mark.
          if (hitButton && sm !== null && spikeHeldKey !== key && smAhead >= Math.min(jumpAtM, releaseAtM) - 0.05) {
            spikeHeldKey = key;
            holding = true;
            out.hit = smAhead < releaseAtM;
          }
          if (hitButton && sm !== null && p.grounded && jumpedKey !== key && under && smAhead >= jumpAtM) {
            jumpedKey = key;
            out.jump = true;
          }
        } else {
          tx = landing.x;
          tz = Math.max(0.7, L(landing.z) + 0.3);
          // Not attacking this one (handed to K): bump it over with Pass.
          if (p.grounded && !holding) passH = 1.0;
        }
      } else if (ours && s.touches === 1 && next === id && landing) {
        tx = landing.x; tz = L(landing.z); passH = 1.75; // set Pip's pass
      } else if (ours && s.touches === 1 && next === mateId) {
        tx = Math.max(-2.6, Math.min(2.6, p.pos.x)); tz = 3.3;
      } else if (ours && s.touches === 2) {
        tx = p.pos.x; tz = 3.6;
      } else if (landing && onUs && L(landing.z) > 0 && next === id && !(ours && s.touches >= 3)) {
        tx = landing.x; tz = L(landing.z); passH = 1.0; // our first ball
      } else if (landing && L(landing.z) > 0 && !(ours && s.touches >= 3)) {
        tx = -s.players[mateId].pos.x * 0.3; tz = 2.0;
      } else if (ball.lastTeam === O && s.possessionTeam === O && s.touches === 2 && landing) {
        const key = landing.x.toFixed(2);
        if (blockKey !== key) { blockKey = key; willBlock = rng() < blockRate; }
        if (willBlock) {
          tx = landing.x; tz = 0.45;
          if (p.grounded && ball.vel.y < 0 && ball.pos.y < 3.5 && Math.abs(p.pos.x - tx) < 0.8) out.jump = true;
        } else { tx = 0; tz = 5; }
      }
      // Pass/Set timing: watch the pass meter and press once so that (after reaction latency)
      // the press lands at the middle of green, +- passJitter. passBias shifts it (s, + = earlier).
      // mash = hammer K every frame once the meter shows.
      const m = p.meters.pass;
      if (passButton && passH > 0 && m !== null) {
        const key = `${sim.ballEpoch}`;
        if (leadKey !== key) {
          leadKey = key;
          lead = greenMidTc + passBias + (rng() * 2 - 1) * passJitter;
        }
        // Read time-to-contact off the needle: linear inside green; before green, from how fast
        // the needle is moving (the pre-green fill is stretched for short warnings).
        const gStart = METER.pass.green[0];
        const tcGreen = (1 - gStart) * METER.pass.leadSec;
        let tcNow = (1 - m) * METER.pass.leadSec;
        if (m < gStart && prevMeter !== null && m > prevMeter) {
          const rate = (m - prevMeter) / dt;
          tcNow = tcGreen + (gStart - m) / rate;
        }
        if (mash) out.pass = !lastMash;
        else if (passedKey !== key && tcNow <= lead + latencySec) { out.pass = true; passedKey = key; }
      }
      lastMash = out.pass;
      prevMeter = m;
    }
    const dx = tx - p.pos.x;
    const dz = tz * sgn - p.pos.z;
    const d = Math.hypot(dx, dz);
    // Axis y is "up" = toward the net (-z for team 0, +z for team 1; x mirrored for team 1).
    // In the air the keys only aim.
    if (p.grounded && d > 0.15) { out.ax = dx / d * sgn; out.ay = -dz / d * sgn; }
    if (aim && !p.grounded) [out.ax, out.ay] = bestAim(s, hs.defaultAim, T);
    return out;
  }
  return function drive(dt) {
    queue.push(decide(dt));
    const latency = Math.round(latencySec / dt);
    const a = queue.length > latency ? queue.shift() : { ax: 0, ay: 0, jump: false, hit: false, pass: false };
    input.setAxis(a.ax, a.ay);
    input.set('jump', a.jump);
    input.set('hit', a.hit);
    input.set('pass', a.pass);
  };
}

export function runMatch({ difficulty = 'normal', seed = 1, human = false, maxSeconds = 1500, onStep, onEvent, humanOpts, dt = 1 / 60 } = {}) {
  const events = createEventBus();
  const input = createVirtualInput();
  const game = createGame({ events, input, seed, autoplay: !human });
  const log = [];
  for (const name of ['matchStart', 'serveReady', 'hit', 'jump', 'land', 'bounce', 'point', 'controlSwitch', 'matchOver', 'pause', 'resume', 'menu', 'swing', 'passAttempt']) {
    events.on(name, (p) => {
      log.push({ name, p, t: game.state.time, speed: name === 'hit' ? game.state.ball.vel.length() : undefined });
      if (onEvent) onEvent(name, p, game);
    });
  }
  let r = seed >>> 0;
  const rng = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
  const drive = human ? createScriptedHuman(game, input, { rng, ...humanOpts }) : null;
  game.startMatch({ difficulty });
  let t = 0;
  while (game.state.phase !== 'matchOver' && t < maxSeconds) {
    if (drive) drive(dt);
    game.update(dt);
    t += dt;
    if (onStep) onStep(game);
  }
  return { game, log, seconds: t };
}

export function summarize(game, log) {
  const st = game.debug.stats;
  const rh = st.rallyHits;
  const avg = rh.reduce((a, b) => a + b, 0) / Math.max(1, rh.length);
  return {
    score: [...game.state.score],
    points: st.points,
    avgHitsPerRally: +avg.toFixed(2),
    maxHits: Math.max(...rh),
    crossingsPerRally: +(st.crossings / Math.max(1, st.points)).toFixed(2),
    hitsByType: st.hitsByType,
    reasons: st.reasons,
    spikes: st.spikes,
    blocks: st.blocks,
    netViolations: st.netViolations,
    stalls: st.stalls,
    pointsBy: st.pointsBy,
  };
}

/**
 * A virtual input whose changes reach the game `delaySec` late (network latency), like the
 * server's remote input: `edgeTime(action)` reports the game time (state.time) at which the bot
 * actually made the latest delivered edge (the "view time"). `front` is what the bot drives
 * (same set/setAxis API as createVirtualInput). withEdgeTime = false omits edgeTime (no lag comp).
 */
export function createLaggedInput(game, delaySec, { withEdgeTime = true } = {}) {
  const real = createVirtualInput();
  const queue = [];
  const down = Object.create(null);
  const edgeAt = Object.create(null);
  const front = {
    set(a, d) { queue.push({ at: game.state.time, a, d: !!d }); },
    setAxis(x, y) { queue.push({ at: game.state.time, axis: [x, y] }); },
  };
  const input = {
    poll() {
      const now = game.state.time;
      while (queue.length && queue[0].at + delaySec <= now + 1e-9) {
        const q = queue.shift();
        if (q.axis) { real.setAxis(q.axis[0], q.axis[1]); continue; }
        if (!!down[q.a] !== q.d) { down[q.a] = q.d; edgeAt[q.a] = q.at; real.set(q.a, q.d); }
      }
      real.poll();
    },
    held: real.held,
    pressed: real.pressed,
    released: real.released,
    axis: real.axis,
    dispose() {},
  };
  if (withEdgeTime) input.edgeTime = (a) => edgeAt[a];
  return { front, input };
}

/**
 * Headless match with scripted cue-following humans on the given slots (others AI).
 * lagSec > 0 delivers every human's input that late (with edgeTime unless lagComp = false).
 */
export function runMultiMatch({
  humans = [0], difficulty = 'normal', seed = 1, maxSeconds = 1500, dt = 1 / 60, lagSec = 0, lagComp = true,
  humanOpts = {}, onStep, onEvent, allowPause = false,
} = {}) {
  const events = createEventBus();
  let game = null;
  const inputs = [null, null, null, null];
  const fronts = [];
  const lagged = [];
  for (const id of humans) {
    if (lagSec > 0) {
      const li = createLaggedInput({ get state() { return game.state; } }, lagSec, { withEdgeTime: lagComp });
      inputs[id] = li.input;
      fronts[id] = li.front;
      lagged.push(li);
    } else {
      inputs[id] = createVirtualInput();
      fronts[id] = inputs[id];
    }
  }
  game = createGame({ events, inputs, seed, allowPause });
  const log = [];
  for (const name of ['matchStart', 'serveReady', 'hit', 'jump', 'land', 'bounce', 'point', 'matchOver', 'pause', 'resume', 'menu', 'swing', 'passAttempt']) {
    events.on(name, (p) => {
      log.push({ name, p, t: game.state.time });
      if (onEvent) onEvent(name, p, game);
    });
  }
  let r = seed >>> 0;
  const rng = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
  const drivers = humans.map((id) => createScriptedHuman(game, fronts[id], { rng, id, ...humanOpts }));
  game.startMatch({ difficulty });
  let t = 0;
  while (game.state.phase !== 'matchOver' && t < maxSeconds) {
    for (const d of drivers) d(dt);
    game.update(dt);
    t += dt;
    if (onStep) onStep(game);
  }
  return { game, log, seconds: t, inputs };
}
