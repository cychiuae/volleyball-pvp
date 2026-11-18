// Sand footprints, landing scuffs, dive streaks and ball dents.
// createSandMarks(parent, uTime) -> { update(state, elapsed), clear(), mesh }
//
// Implementation: one InstancedMesh of flat decals (1 draw call) using "2x multiply" blending
// (result = 2 * src * dst): a decal value of 0.5 leaves the sand untouched, < 0.5 darkens
// (dent centre), > 0.5 brightens (pushed-up rim). Because it modulates whatever is already on
// screen, marks stay correct inside character shadows. Each instance stores its birth time; the
// shader fades it out, so nothing is re-uploaded per frame except newly stamped instances.
import * as THREE from 'three';
import { BALL } from '../config.js';
import { dataTexture, valueNoise2, registerGlow } from './toon.js';

const MAX = 768;
const STRIDE = 0.42;        // metres between alternating footprints
const FOOT_SPREAD = 0.09;   // half distance between left/right prints
const CELL = { foot: 0, scuff: 1, dent: 2, streak: 3 };
const LIFE = { foot: 8, scuff: 9, dent: 10, streak: 9 };

export function createSandMarks(parent, uTime) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // +v of the texture points to -Z
  const data = new Float32Array(MAX * 3); // birth, cell, life
  const aData = new THREE.InstancedBufferAttribute(data, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aData', aData);

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime, uMap: { value: atlasTexture() }, uLinear: { value: 0 } },
    vertexShader: /* glsl */`
      uniform float uTime;
      attribute vec3 aData;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float cell = aData.y;
        vUv = (uv + vec2(mod(cell, 2.0), floor(cell / 2.0))) * 0.5;
        float age = uTime - aData.x;
        vFade = age < 0.0 ? 0.0 : 1.0 - smoothstep(aData.z * 0.45, aData.z, age);
        vFade *= smoothstep(0.0, 0.08, age); // tiny press-in
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform float uLinear;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        // toon steps: two dent levels, one rim level
        float d = step(0.35, t.r) * 0.55 + step(0.8, t.r) * 0.45;
        float r = step(0.45, t.g);
        float f = mix(1.0, 1.0 - 0.27 * d + 0.13 * r, vFade); // multiplier on the sand
        if (abs(f - 1.0) < 0.004) discard;
        // Direct render blends in sRGB-encoded space; the post chain blends in linear HDR, where the
        // same visual strength needs the multiplier raised to ~2.2.
        f = mix(f, pow(f, 2.2), uLinear);
        float v = 0.5 * f;
        gl_FragColor = vec4(vec3(v), 1.0);
      }`,
    transparent: true,
    side: THREE.DoubleSide, // mirrored (left) footprints use a negative x scale
    depthWrite: false,
    toneMapped: false,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  // Glow level 1 == rendering through the linear post chain (see stage.setQuality).
  registerGlow((g) => { material.uniforms.uLinear.value = g; });

  const mesh = new THREE.InstancedMesh(geo, material, MAX);
  mesh.name = 'sandMarks';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  parent.add(mesh);

  let cursor = 0;
  let used = 0;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function stamp(x, z, yaw, sx, sz, kind, now) {
    const i = cursor;
    cursor = (cursor + 1) % MAX;
    used = Math.min(MAX, used + 1);
    // Texture +v points to -Z; rotate so it points along (sin yaw, cos yaw).
    q.setFromAxisAngle(yAxis, yaw + Math.PI);
    mesh.setMatrixAt(i, m4.compose(p.set(x, 0.006, z), q, s.set(sx, 1, sz)));
    mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    mesh.instanceMatrix.needsUpdate = true;
    data[i * 3] = now; data[i * 3 + 1] = CELL[kind]; data[i * 3 + 2] = LIFE[kind];
    aData.addUpdateRange(i * 3, 3);
    aData.needsUpdate = true;
    mesh.count = used;
  }

  // Per-player tracking (fixed size, no allocations).
  const track = Array.from({ length: 8 }, () => ({
    x: 0, z: 0, init: false, side: 1, grounded: true, action: null, diveStamped: false,
  }));
  let ballLow = true;
  let lastPhase = null;
  let lastScoreSum = 0;

  function clear() {
    cursor = 0; used = 0; mesh.count = 0;
    for (const t of track) t.init = false;
  }

  function update(state, now) {
    if (!state || !state.players) return;
    // Clear on match start / back to menu (the court has no event bus).
    const scoreSum = state.score ? state.score[0] + state.score[1] : 0;
    if (lastPhase !== null && state.phase !== lastPhase &&
        (state.phase === 'menu' || (lastPhase === 'menu' && state.phase !== 'menu'))) clear();
    else if (scoreSum < lastScoreSum) clear(); // restart
    lastPhase = state.phase;
    lastScoreSum = scoreSum;
    if (state.paused) return;

    const n = Math.min(state.players.length, track.length);
    for (let i = 0; i < n; i++) {
      const pl = state.players[i];
      const t = track[i];
      const px = pl.pos.x, pz = pl.pos.z;
      const grounded = pl.grounded !== false && pl.pos.y < 0.05;
      if (!t.init) { t.x = px; t.z = pz; t.init = true; t.grounded = grounded; t.action = pl.action; continue; }
      const vx = pl.vel ? pl.vel.x : 0, vz = pl.vel ? pl.vel.z : 0;
      const speed = Math.hypot(vx, vz);
      const yaw = speed > 0.5 ? Math.atan2(vx, vz) : (pl.facing || 0);

      // Take-off: both feet.
      if (t.grounded && !grounded && pl.action !== 'dive') {
        footPair(px, pz, yaw, now);
      }
      // Landing: scuff (+ feet).
      if (!t.grounded && grounded && pl.action !== 'dive') {
        stamp(px, pz, yaw, 0.62, 0.62, 'scuff', now);
        footPair(px, pz, yaw, now);
        t.x = px; t.z = pz;
      }
      // Dive: one long streak once the body hits the sand.
      if (pl.action !== t.action) t.diveStamped = false;
      if (pl.action === 'dive' && !t.diveStamped && (pl.actionTime || 0) > 0.2 && pl.pos.y < 0.15) {
        const dyaw = pl.facing || yaw;
        stamp(px + Math.sin(dyaw) * 0.3, pz + Math.cos(dyaw) * 0.3, dyaw, 0.75, 1.5, 'streak', now);
        t.diveStamped = true;
      }
      // Running: alternating prints every stride.
      if (grounded && pl.action !== 'dive') {
        const dx = px - t.x, dz = pz - t.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= STRIDE) {
          const myaw = Math.atan2(dx, dz);
          t.side = -t.side;
          const ox = Math.cos(myaw) * FOOT_SPREAD * t.side, oz = -Math.sin(myaw) * FOOT_SPREAD * t.side;
          stamp(px + ox, pz + oz, myaw, t.side > 0 ? 0.17 : -0.17, 0.28, 'foot', now);
          t.x = px; t.z = pz;
        } else if (dist > 3) { t.x = px; t.z = pz; } // teleport (reset positions)
      } else {
        t.x = px; t.z = pz;
      }
      t.grounded = grounded;
      t.action = pl.action;
    }

    // Ball dent on sand contact (hysteresis so a resting ball stamps once).
    const b = state.ball;
    if (b && b.visible !== false && !b.held) {
      const h = b.pos.y - BALL.radius;
      if (!ballLow && h < 0.06 && Math.abs(b.pos.x) < 30 && b.pos.z > -22) {
        stamp(b.pos.x, b.pos.z, Math.random() * 6.28, 0.62, 0.62, 'dent', now);
        ballLow = true;
      } else if (h > 0.25) ballLow = false;
    } else if (b && b.held) ballLow = true;
  }

  function footPair(x, z, yaw, now) {
    const ox = Math.cos(yaw) * FOOT_SPREAD * 1.3, oz = -Math.sin(yaw) * FOOT_SPREAD * 1.3;
    stamp(x + ox, z + oz, yaw, 0.17, 0.28, 'foot', now);
    stamp(x - ox, z - oz, yaw, -0.17, 0.28, 'foot', now);
  }

  return { update, clear, mesh };
}

/**
 * 2x2 atlas, R = dent depth, G = rim. Cells: 0 footprint (points +v), 1 landing scuff,
 * 2 ball dent, 3 dive streak (along v).
 */
function atlasTexture() {
  const S = 64;
  const ell = (u, v, cx, cy, rx, ry) => 1 - Math.hypot((u - cx) / rx, (v - cy) / ry);
  const field = (cell, u, v) => {
    switch (cell) {
      case 0: { // chibi footprint: round heel, wider ball, three toe beans
        let f = Math.max(ell(u, v, 0.5, 0.3, 0.2, 0.2), ell(u, v, 0.52, 0.56, 0.25, 0.2));
        for (const [cx, cy] of [[0.36, 0.8], [0.52, 0.84], [0.67, 0.79]]) f = Math.max(f, ell(u, v, cx, cy, 0.08, 0.075));
        return f;
      }
      case 1: { // scuff: lumpy blob plus spray
        const n = valueNoise2(u * 6, v * 6, 5) - 0.5;
        let f = ell(u, v, 0.5, 0.5, 0.3, 0.27) + n * 0.5;
        for (let k = 0; k < 7; k++) {
          const a = k * 0.9 + 0.3, r = 0.38 + (k % 3) * 0.03;
          f = Math.max(f, ell(u, v, 0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.04, 0.04));
        }
        return f;
      }
      case 2: // ball dent: smooth bowl
        return ell(u, v, 0.5, 0.5, 0.3, 0.3);
      default: { // dive streak: capsule along v with drag grooves
        const cy = Math.min(0.82, Math.max(0.2, v));
        let f = ell(u, v, 0.5, cy, 0.24, 0.16);
        f += 0.12 * Math.sin(u * 40) * (v < 0.75 ? 1 : 0);
        return f;
      }
    }
  };
  return dataTexture(S * 2, S * 2, (u, v, o, x, y) => {
    const cell = (x >= S ? 1 : 0) + (y >= S ? 2 : 0);
    const lu = (x % S + 0.5) / S, lv = (y % S + 0.5) / S;
    const f = field(cell, lu, lv);
    const depth = cell === 2 ? THREE.MathUtils.smoothstep(f, 0, 0.6) : THREE.MathUtils.smoothstep(f, 0, 0.25);
    const rimW = cell === 0 ? 0.22 : 0.4;
    const rim = f < 0 && f > -rimW ? 1 - Math.abs(f + rimW / 2) / (rimW / 2) : 0;
    // keep a transparent (neutral) border so decals never show their quad edges
    const edge = Math.min(lu, lv, 1 - lu, 1 - lv) > 0.04 ? 1 : 0;
    o[0] = Math.round(255 * depth * edge);
    o[1] = Math.round(255 * Math.max(0, rim) * edge);
    o[2] = 0;
    o[3] = 255;
  }, { srgb: false, mipmaps: false });
}
