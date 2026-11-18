// Pooled particle VFX driven by game events (no per-frame allocations).
// createEffects(scene, events) -> { update(dt) }
import * as THREE from 'three';
import { COURT, PALETTE, TEAMS } from '../config.js';
import { toonMaterial, dataTexture, registerGlow, getGlowLevel } from './toon.js';

const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'rx', 'ry', 'rz', 'wx', 'wy', 'wz', 'grav', 'drag', 'cr', 'cg', 'cb', 'seed', 'rest'];

/**
 * Instanced particle pool. mode: 'puff' (grow then shrink), 'pop' (shrink over life), 'confetti'
 * (flutter, settle on sand). Active particles are kept packed in [0, n) so mesh.count = n.
 */
function createPool(scene, name, geometry, material, max, mode) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 7;
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < max; i++) mesh.setColorAt(i, white);
  mesh.count = 0;
  scene.add(mesh);

  const f = {};
  for (const k of FIELDS) f[k] = new Float32Array(max);
  let n = 0;
  let cursor = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();

  function spawn(x, y, z, vx, vy, vz, life, size, color, grav = 9, drag = 1) {
    let i;
    if (n < max) i = n++;
    else { i = cursor; cursor = (cursor + 1) % max; } // recycle when saturated
    f.px[i] = x; f.py[i] = y; f.pz[i] = z;
    f.vx[i] = vx; f.vy[i] = vy; f.vz[i] = vz;
    f.age[i] = 0; f.life[i] = life; f.size[i] = size;
    f.rx[i] = Math.random() * 6.28; f.ry[i] = Math.random() * 6.28; f.rz[i] = Math.random() * 6.28;
    const spin = mode === 'confetti' ? 9 : 6;
    f.wx[i] = (Math.random() - 0.5) * spin; f.wy[i] = (Math.random() - 0.5) * spin; f.wz[i] = (Math.random() - 0.5) * spin;
    f.grav[i] = grav; f.drag[i] = drag;
    col.set(color);
    f.cr[i] = col.r; f.cg[i] = col.g; f.cb[i] = col.b;
    f.seed[i] = Math.random() * 100;
    f.rest[i] = 0;
    return i;
  }

  function kill(i) {
    n--;
    if (i !== n) for (const k of FIELDS) f[k][i] = f[k][n];
  }

  function update(dt) {
    for (let i = n - 1; i >= 0; i--) {
      f.age[i] += dt;
      if (f.age[i] >= f.life[i]) { kill(i); continue; }
      const k = Math.exp(-f.drag[i] * dt);
      f.vx[i] *= k; f.vy[i] *= k; f.vz[i] *= k;
      f.vy[i] -= f.grav[i] * dt;
      if (mode === 'confetti' && !f.rest[i]) {
        const t = f.age[i] + f.seed[i];
        f.vx[i] += Math.sin(t * 3.1) * 2.2 * dt;
        f.vz[i] += Math.cos(t * 2.7) * 1.6 * dt;
        f.vy[i] = Math.max(f.vy[i], -1.6); // flutter down slowly
      }
      f.px[i] += f.vx[i] * dt; f.py[i] += f.vy[i] * dt; f.pz[i] += f.vz[i] * dt;
      if (!f.rest[i]) { f.rx[i] += f.wx[i] * dt; f.ry[i] += f.wy[i] * dt; f.rz[i] += f.wz[i] * dt; }
      const ground = mode === 'confetti' ? 0.02 : f.size[i] * 0.3;
      if (f.py[i] < ground) {
        f.py[i] = ground;
        if (mode === 'confetti') {
          f.rest[i] = 1; f.vx[i] = f.vy[i] = f.vz[i] = 0; f.rx[i] = -Math.PI / 2; f.rz[i] = 0;
        } else {
          f.vy[i] = Math.abs(f.vy[i]) * 0.25; f.vx[i] *= 0.6; f.vz[i] *= 0.6;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const t = f.age[i] / f.life[i];
      let sc;
      if (mode === 'puff') sc = f.size[i] * (0.45 + 0.9 * Math.sqrt(t)) * (1 - t * t * t);
      else if (mode === 'confetti') sc = f.size[i] * (t > 0.85 ? (1 - t) / 0.15 : 1);
      else sc = f.size[i] * Math.min(1, t * 8) * (1 - t * t);
      p.set(f.px[i], f.py[i], f.pz[i]);
      q.setFromEuler(e.set(f.rx[i], f.ry[i], f.rz[i]));
      s.set(sc, sc, sc);
      mesh.setMatrixAt(i, m4.compose(p, q, s));
      const fade = mode === 'puff' ? 1 - 0.25 * t : 1;
      col.setRGB(f.cr[i] * fade, f.cg[i] * fade, f.cb[i] * fade);
      mesh.setColorAt(i, col);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return { spawn, update, clear() { n = 0; mesh.count = 0; }, get count() { return n; }, mesh };
}

function starGeometry() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 ? 0.45 : 1;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.08, bevelSegments: 1 });
  g.center();
  return g;
}

export function createEffects(scene, events) {
  const root = new THREE.Group();
  root.name = 'effects';
  scene.add(root);

  const sandLight = new THREE.Color(PALETTE.sand).lerp(new THREE.Color('#ffffff'), 0.35);
  const puffs = createPool(root, 'fxPuffs', new THREE.IcosahedronGeometry(1, 1), toonMaterial('#ffffff'), 220, 'puff');
  const stars = createPool(root, 'fxStars', starGeometry(), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 120, 'pop');
  const sparks = createPool(root, 'fxSparks', new THREE.OctahedronGeometry(1, 0).scale(0.6, 1.4, 0.6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 240, 'pop');
  const confetti = createPool(root, 'fxConfetti', new THREE.PlaneGeometry(1, 0.6), toonMaterial('#ffffff', { side: THREE.DoubleSide }), 520, 'confetti');

  // With bloom on, push the sparkly bits into HDR so only they glow (sand/lines stay below threshold).
  const unglow = registerGlow((g) => {
    stars.mesh.material.color.setScalar(1 + 1.4 * g);
    sparks.mesh.material.color.setScalar(1 + 1.2 * g);
    confetti.mesh.material.color.setScalar(1 + 0.15 * g);
  });

  // Shockwave rings (individual meshes, hidden when idle -> no draw cost).
  const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
  const rings = Array.from({ length: 8 }, (_, i) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.name = `fxRing${i}`;
    m.visible = false;
    m.renderOrder = 8;
    root.add(m);
    return { mesh: m, age: 0, life: 0, size: 1, active: false };
  });
  let ringCursor = 0;

  // Block "wall" flashes.
  const wallTex = dataTexture(64, 64, (u, v, o) => {
    const dx = Math.max(0, Math.abs(u - 0.5) * 2 - 0.6) / 0.4, dy = Math.max(0, Math.abs(v - 0.5) * 2 - 0.5) / 0.5;
    const d = Math.min(1, Math.hypot(dx, dy));
    const hatch = (Math.floor(u * 10) + Math.floor(v * 7)) % 2 ? 1 : 0.8;
    o[0] = o[1] = o[2] = 255;
    o[3] = Math.round(255 * (1 - d * d) * hatch);
  }, { srgb: false });
  const walls = Array.from({ length: 2 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.5), new THREE.MeshBasicMaterial({
      map: wallTex, color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    m.name = `fxWall${i}`;
    m.visible = false;
    m.renderOrder = 8;
    root.add(m);
    return { mesh: m, age: 0, active: false };
  });
  let wallCursor = 0;

  let paused = false;
  let confettiEmit = 0; // seconds of big confetti emission remaining (matchOver)
  let confettiTeam = 0;
  let confettiAcc = 0;

  const teamCol = (t) => TEAMS[t === 1 ? 1 : 0].color;
  const confettiColors = (t) => [TEAMS[t].color, TEAMS[t].accent, '#ffffff', PALETTE.ball[0], TEAMS[t].color];
  const rand = (a, b) => a + Math.random() * (b - a);
  const P = (p) => p || { x: 0, y: 0, z: 0 };

  // ---------------------------------------------------------------- emitters
  function sandPuff(pos, count, strength = 1) {
    const { x, z } = P(pos);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.8, 2.6) * strength;
      puffs.spawn(x + Math.cos(a) * 0.15, 0.05, z + Math.sin(a) * 0.15,
        Math.cos(a) * sp, rand(0.6, 2.0) * strength, Math.sin(a) * sp,
        rand(0.45, 0.8), rand(0.09, 0.17) * (0.7 + 0.5 * strength), Math.random() < 0.3 ? PALETTE.sandDark : sandLight, 3.5, 3.2);
    }
  }

  function starBurst(pos, count, size, speed, colors) {
    const { x, y, z } = P(pos);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const sp = speed * rand(0.6, 1.1);
      stars.spawn(x, y, z, Math.cos(a) * r * sp, u * sp + 1.2, Math.sin(a) * r * sp,
        rand(0.35, 0.6), size * rand(0.7, 1.2), colors[i % colors.length], 4, 4.5);
    }
  }

  function sparkBurst(pos, count, size, speed, color) {
    const { x, y, z } = P(pos);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const sp = speed * rand(0.5, 1.2);
      sparks.spawn(x, y, z, Math.cos(a) * r * sp, u * sp, Math.sin(a) * r * sp,
        rand(0.3, 0.55), size * rand(0.6, 1.2), Math.random() < 0.25 ? '#ffffff' : color, 6, 3.5);
    }
  }

  function ring(pos, size, color, horizontal, life = 0.4) {
    const r = rings[ringCursor];
    ringCursor = (ringCursor + 1) % rings.length;
    const { x, y, z } = P(pos);
    r.mesh.position.set(x, horizontal ? 0.04 : y, z);
    // Vertical rings lean back toward the local camera, whichever side it is on (stage publishes
    // scene.userData.viewYaw: 0 = team-0 view from +z, PI = team-1 view from -z).
    r.mesh.rotation.set(horizontal ? -Math.PI / 2 : -0.25, horizontal ? 0 : scene.userData.viewYaw || 0, 0, 'YXZ');
    r.mesh.material.color.set(color).multiplyScalar(1 + 0.6 * getGlowLevel());
    r.age = 0; r.life = life; r.size = size; r.active = true;
    r.mesh.visible = true;
  }

  function wallFlash(pos, color) {
    const w = walls[wallCursor];
    wallCursor = (wallCursor + 1) % walls.length;
    const { x, y } = P(pos);
    // A hair in front of the net on the local camera's side.
    w.mesh.position.set(x, Math.max(COURT.netHeight + 0.3, y), 0.05 * Math.cos(scene.userData.viewYaw || 0));
    w.mesh.material.color.set(color).multiplyScalar(1 + 1.5 * getGlowLevel()); // additive is weaker in linear
    w.age = 0; w.active = true; w.mesh.visible = true;
  }

  function confettiBurst(cx, cy, cz, count, team, spread, up) {
    const cols = confettiColors(team);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(1, 4) * spread;
      confetti.spawn(cx + rand(-spread, spread), cy + rand(-0.3, 0.3), cz + rand(-spread, spread) * 0.6,
        Math.cos(a) * sp, rand(2, 6) * up, Math.sin(a) * sp,
        rand(2.6, 4.2) * (up > 1 ? 1.4 : 1), rand(0.09, 0.15), cols[i % cols.length], 4.5, 1.6);
    }
  }

  // ---------------------------------------------------------------- event wiring
  const off = [];
  const on = (name, fn) => { if (events && events.on) off.push(events.on(name, fn)); };

  on('bounce', ({ position, surface, speed = 6 } = {}) => {
    const s = Math.min(1.6, 0.4 + speed / 10);
    if (surface === 'net') {
      const net = scene.getObjectByName('net');
      if (net && net.userData.ripple) net.userData.ripple(position, Math.min(1, speed / 14));
      starBurst(position, 5, 0.07, 2.5, ['#ffffff', '#fff3b0']);
      ring(position, 0.6 + s * 0.3, '#ffffff', false, 0.3);
    } else if (surface === 'post') {
      starBurst(position, 6, 0.08, 3, ['#ffffff', PALETTE.post]);
      sparkBurst(position, 6, 0.05, 3, PALETTE.post);
    } else {
      sandPuff(position, Math.round(8 + 10 * s), s);
      if (speed > 7) ring(position, 0.5 + s * 0.5, '#fff6e0', true, 0.45);
    }
  });

  on('land', ({ position } = {}) => sandPuff(position, 6, 0.55));
  on('jump', ({ position } = {}) => sandPuff(position, 4, 0.45));

  on('hit', ({ type, team, position, power = 0.5 } = {}) => {
    const tc = teamCol(team);
    switch (type) {
      case 'spike': {
        starBurst(position, 6 + Math.round(power * 6), 0.1 + 0.06 * power, 3 + 4 * power, ['#ffffff', '#fff3b0', tc]);
        sparkBurst(position, 12 + Math.round(power * 22), 0.06 + 0.03 * power, 4 + 8 * power, tc);
        ring(position, 0.7 + power * 1.3, tc, false, 0.35 + power * 0.15);
        ring(position, 0.4 + power * 0.7, '#ffffff', false, 0.25);
        break;
      }
      case 'serve': {
        starBurst(position, 5, 0.08, 2.8, ['#ffffff', '#fff3b0']);
        if (power > 0.55) { sparkBurst(position, 8 + Math.round(power * 8), 0.05, 4 + 4 * power, tc); ring(position, 0.6 + power * 0.6, tc, false, 0.3); }
        break;
      }
      case 'block': {
        wallFlash(position, tc);
        starBurst(position, 8, 0.1, 3.5, ['#ffffff', tc]);
        sparkBurst(position, 14, 0.06, 5, '#ffffff');
        break;
      }
      case 'dig': {
        starBurst(position, 4, 0.07, 2.2, ['#ffffff', '#fff3b0']);
        sandPuff(position, 16, 1.2); // dives kick up sand
        break;
      }
      default: // bump, set, dink
        starBurst(position, 4, 0.065, 2.2, ['#ffffff', '#fff3b0', tc]);
    }
  });

  on('point', ({ winnerTeam = 0 } = {}) => {
    const side = TEAMS[winnerTeam === 1 ? 1 : 0].side;
    confettiBurst(0, 3.8, side * 4, 70, winnerTeam === 1 ? 1 : 0, 2.2, 1);
  });

  on('matchOver', ({ winnerTeam = 0 } = {}) => {
    confettiTeam = winnerTeam === 1 ? 1 : 0;
    confettiEmit = 2.6;
    confettiAcc = 0;
    const side = TEAMS[confettiTeam].side;
    for (const x of [-3, 0, 3]) {
      confettiBurst(x, 5, side * 3, 60, confettiTeam, 1.8, 1.4);
      starBurst({ x, y: 4.5, z: side * 3 }, 6, 0.15, 4, ['#ffffff', TEAMS[confettiTeam].color, PALETTE.ball[0]]);
    }
  });

  const clearAll = () => {
    puffs.clear(); stars.clear(); sparks.clear(); confetti.clear(); confettiEmit = 0;
    for (const r of rings) { r.active = false; r.mesh.visible = false; }
    for (const w of walls) { w.active = false; w.mesh.visible = false; }
  };
  // A new match or the menu always unfreezes effects: the game clears its paused flag there
  // without emitting 'resume'.
  on('matchStart', () => { clearAll(); paused = false; });
  on('menu', () => { clearAll(); paused = false; });
  on('pause', () => { paused = true; });
  on('resume', () => { paused = false; });

  // ---------------------------------------------------------------- update
  function update(dt) {
    dt = Math.min(dt || 0, 0.05);
    if (paused || dt <= 0) return;

    if (confettiEmit > 0) {
      confettiEmit -= dt;
      confettiAcc += dt * 90;
      const side = TEAMS[confettiTeam].side;
      while (confettiAcc >= 1) {
        confettiAcc -= 1;
        const cols = confettiColors(confettiTeam);
        confetti.spawn(rand(-6, 6), rand(6, 8), side * rand(-1, 9), rand(-0.5, 0.5), rand(-0.5, 0.5), rand(-0.5, 0.5),
          rand(4, 6), rand(0.1, 0.16), cols[Math.floor(Math.random() * cols.length)], 3, 1.2);
      }
    }

    puffs.update(dt);
    stars.update(dt);
    sparks.update(dt);
    confetti.update(dt);

    for (const r of rings) {
      if (!r.active) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) { r.active = false; r.mesh.visible = false; continue; }
      const s = r.size * (0.3 + 0.9 * (1 - (1 - t) * (1 - t)));
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = 0.85 * (1 - t);
    }
    for (const w of walls) {
      if (!w.active) continue;
      w.age += dt;
      const t = w.age / 0.4;
      if (t >= 1) { w.active = false; w.mesh.visible = false; continue; }
      const s = 0.8 + 0.35 * Math.sqrt(t);
      w.mesh.scale.set(s, s, 1);
      w.mesh.material.opacity = 0.9 * (1 - t);
    }
  }

  return { update, dispose() { off.forEach((f) => f && f()); unglow(); clearAll(); } };
}
