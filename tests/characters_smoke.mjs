// Smoke test for src/characters (run: node tests/characters_smoke.mjs).
// Builds all four looks and drives update() through every action, speed and airborne state,
// checking for exceptions and non-finite transforms. Runs twice: with a fake canvas (decals on)
// and with no canvas at all (decals skipped), the latter in a child process.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const NO_CANVAS = process.env.CHAR_SMOKE_NO_CANVAS === '1';

if (!NO_CANVAS) {
  // Minimal fake 2D canvas: every method is a no-op; gradients have addColorStop.
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return () => ({ addColorStop() {}, width: 0 });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

const THREE = await import('three');
const { TEAMS, PLAYER } = await import('../src/config.js');
const { createCharacter } = await import('../src/characters/character.js');

const ACTIONS = [null, 'bump', 'set', 'spike', 'serveToss', 'serveHit', 'block', 'dive',
  'celebrate', 'sad', 'mysteryMove'];
const SPEEDS = [0, 1.5, 3.5, 5.5];

function makeState(team) {
  return {
    id: 0, team, index: 0,
    pos: new THREE.Vector3(1, 0, team === 0 ? 4 : -4),
    vel: new THREE.Vector3(),
    facing: team === 0 ? Math.PI : 0,
    grounded: true,
    action: null,
    actionTime: 0,
    controlled: team === 0,
  };
}

const tmp = new THREE.Vector3();
function checkFinite(root, label) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const e = o.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      if (!Number.isFinite(e[i])) throw new Error(`${label}: non-finite matrix on ${o.name || o.type}`);
    }
  });
}

let meshTotal = 0;
let updates = 0;
for (let t = 0; t < TEAMS.length; t++) {
  for (let i = 0; i < TEAMS[t].players.length; i++) {
    const look = TEAMS[t].players[i];
    const c = createCharacter(look, TEAMS[t].color);
    assert.ok(c.root instanceof THREE.Object3D, 'root is an Object3D');
    assert.equal(typeof c.update, 'function');

    let meshes = 0;
    c.root.traverse((o) => { if (o.isMesh) meshes++; });
    assert.ok(meshes <= 40, `${look.name}: ${meshes} meshes (budget 40)`);
    meshTotal += meshes;

    // height sanity at rest: bounding box top ~ PLAYER.height, bottom ~ 0
    const st = makeState(t);
    st.controlled = false;
    c.update(1 / 60, st);
    c.root.position.set(0, 0, 0);
    c.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    c.root.traverseVisible((o) => { if (o.isMesh && o.name !== 'outline') box.expandByObject(o, true); });
    assert.ok(box.min.y > -0.05 && box.min.y < 0.05, `${look.name}: feet at ${box.min.y.toFixed(3)}`);
    assert.ok(box.max.y > PLAYER.height * 0.9 && box.max.y < PLAYER.height * 1.2,
      `${look.name}: top at ${box.max.y.toFixed(3)}`);

    for (const action of ACTIONS) {
      for (const speed of SPEEDS) {
        for (const airborne of [false, true]) {
          const s = makeState(t);
          s.action = action;
          s.vel.set(speed * 0.6, 0, -speed * 0.8);
          s.controlled = (speed + (airborne ? 1 : 0)) % 2 === 0;
          const dur = 1.4;
          for (let k = 0; k * (1 / 60) < dur; k++) {
            const dt = k % 17 === 0 ? 0 : 1 / 60; // include dt = 0 frames
            s.actionTime += dt;
            if (airborne) {
              const tt = k / 60;
              s.grounded = tt > 0.9;
              s.pos.y = s.grounded ? 0 : Math.max(0, 6.2 * tt - 10 * tt * tt);
              s.vel.y = s.grounded ? 0 : 6.2 - 20 * tt;
            }
            s.pos.x += s.vel.x * dt;
            s.pos.z += s.vel.z * dt;
            c.update(dt, s);
            updates++;
            if (k % 10 === 0) checkFinite(c.root, `${look.name}/${action}/${speed}/${airborne}`);
            if (s.controlled && k > 30) {
              const ring = c.root.getObjectByName('controlRing');
              if (ring.visible) {
                ring.getWorldPosition(tmp);
                assert.ok(Math.abs(tmp.y - 0.02) < 1e-3, `ring y ${tmp.y} while pos.y=${s.pos.y}`);
              }
            }
          }
          checkFinite(c.root, `${look.name}/${action}/${speed}/${airborne} end`);
        }
      }
    }

    // action switching mid-way + restart of the same action + garbage input
    const s = makeState(t);
    const seq = ['spike', 'bump', 'bump', 'dive', null, 'celebrate', 'sad', undefined, 'toString', 'set'];
    for (const a of seq) {
      s.action = a;
      s.actionTime = 0;
      for (let k = 0; k < 12; k++) { s.actionTime += 1 / 60; c.update(1 / 60, s); }
    }
    // spike wind-up: hold (windup 0 -> 1, grounded and airborne), then release into 'spike'
    for (const airborne of [false, true]) {
      const w = makeState(t);
      w.grounded = !airborne;
      w.pos.y = airborne ? 0.6 : 0;
      for (let k = 0; k <= 75; k++) { w.windup = k / 60; c.update(k % 9 === 0 ? 0 : 1 / 60, w); }
      checkFinite(c.root, `${look.name}/windup/${airborne}`);
      w.windup = null; w.action = 'spike'; w.actionTime = 0;
      for (let k = 0; k < 50; k++) { w.actionTime += 1 / 60; c.update(1 / 60, w); }
      checkFinite(c.root, `${look.name}/windup->spike/${airborne}`);
    }
    for (const junk of [NaN, -1, 2, undefined, 'x', Infinity]) {
      s.windup = junk; s.action = null;
      for (let k = 0; k < 5; k++) c.update(1 / 60, s);
    }
    s.windup = null;
    checkFinite(c.root, `${look.name}/windup junk`);

    c.update(0, s);
    c.update(-1, s);
    c.update(NaN, s);
    c.update(1 / 60, { pos: s.pos, facing: NaN }); // sparse state
    checkFinite(c.root, `${look.name}/switching`);
  }
}

console.log(`characters smoke OK (${NO_CANVAS ? 'no canvas' : 'fake canvas'}): ` +
  `4 looks, ${meshTotal} meshes total, ${updates} updates`);

if (!NO_CANVAS) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, CHAR_SMOKE_NO_CANVAS: '1' },
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
