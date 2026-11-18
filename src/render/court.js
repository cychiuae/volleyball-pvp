// Beach court: sand, tape lines, net + posts + antennas, ocean, and all the cozy beach decor.
// createCourt(scene) -> { update(dt, elapsed, state?) }  (state drives footprints / ball dents)
// All decor stays OUTSIDE the play area (|x| > 7 or |z| > 11) so it never blocks the court.
import * as THREE from 'three';
import { COURT, PALETTE } from '../config.js';
import {
  toonMaterial, addOutline, dataTexture, blobTexture, DecorBuilder, mat, mul, rng, valueNoise2,
  registerGlow,
} from './toon.js';
import { createSandMarks } from './sandMarks.js';

const SHORE_Z = -24; // rest waterline (far side, beyond the far baseline)

export function createCourt(scene) {
  const root = new THREE.Group();
  root.name = 'court';
  scene.add(root);

  const uTime = { value: 0 };
  const decals = []; // fake contact shadows under decor: [x, z, sx, sz, rot]

  buildSand(root);
  buildLines(root);
  const net = buildNet(root);
  const ocean = buildOcean(root, uTime);
  buildDecor(root, uTime, decals);
  buildDecals(root, decals);
  const clouds = buildClouds(root);
  const gulls = buildGulls(root);
  const crab = buildCrab(root);
  const boat = buildBoat(root);
  const marks = createSandMarks(root, uTime);

  return {
    root,
    net: net.mesh,
    marks,
    update(dt, elapsed, state) {
      const t = elapsed ?? (uTime.value + (dt || 0));
      uTime.value = t;
      if (state) marks.update(state, t);
      net.update(dt || 0);
      clouds.update(dt || 0, t);
      gulls.update(t);
      crab.update(t);
      boat.update(t);
      ocean.position.y = 0.03;
    },
  };
}

// ============================================================================ sand

function buildSand(root) {
  const sand = new THREE.Color(PALETTE.sand);
  const dark = new THREE.Color(PALETTE.sandDark);
  const light = new THREE.Color(PALETTE.sand).lerp(new THREE.Color('#ffffff'), 0.45);
  const speck = new THREE.Color(PALETTE.sandDark).lerp(new THREE.Color('#8a6a48'), 0.5);
  const R = rng(7);
  const c = new THREE.Color();
  const tex = dataTexture(256, 256, (u, v, o) => {
    const n = valueNoise2(u * 8, v * 8, 1, 8) * 0.6 + valueNoise2(u * 24, v * 24, 2, 24) * 0.4;
    const warp = valueNoise2(u * 4, v * 4, 3, 4);
    const ripple = Math.sin((v * 5 + warp * 0.9) * Math.PI * 2) * 0.5 + 0.5;
    c.copy(sand).lerp(dark, THREE.MathUtils.clamp(n * 0.55 + ripple * 0.18 - 0.12, 0, 1));
    const h = R();
    if (h > 0.986) c.lerp(speck, 0.55);
    else if (h > 0.972) c.lerp(dark, 0.4);
    else if (h < 0.012) c.lerp(light, 0.9);
    c.convertLinearToSRGB();
    o[0] = c.r * 255; o[1] = c.g * 255; o[2] = c.b * 255;
  }, { repeat: true });
  const W = 520, D = 320; // x: ±260, z: -40 .. 280
  tex.repeat.set(W / 5, D / 5);

  const geo = new THREE.PlaneGeometry(W, D, 104, 64);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -40 + D / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let k = 1 - 0.07 * valueNoise2(x / 16, z / 16, 11) - 0.05 * valueNoise2(x / 5, z / 5, 12);
    // Raked, slightly brighter sand in and around the court.
    const inCourt = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x) - 6, Math.abs(z) - 10, 0), 0, 4);
    k += 0.05 * inCourt;
    // Darker, damp sand approaching the waterline.
    k -= 0.16 * THREE.MathUtils.smoothstep(-z, -SHORE_Z - 6, -SHORE_Z + 1);
    colors[i * 3] = k; colors[i * 3 + 1] = k; colors[i * 3 + 2] = k * 0.98;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, toonMaterial('#ffffff', { map: tex, vertexColors: true }));
  mesh.name = 'sand';
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ============================================================================ court lines

function buildLines(root) {
  const b = new DecorBuilder();
  const { halfWidth: hw, halfLength: hl, lineWidth: lw } = COURT;
  const h = 0.008;
  const side = new THREE.BoxGeometry(lw, h, hl * 2 + lw);
  const base = new THREE.BoxGeometry(hw * 2 + lw, h, lw);
  b.add(side, PALETTE.line, mat(-hw, h / 2, 0));
  b.add(side, PALETTE.line, mat(hw, h / 2, 0));
  b.add(base, PALETTE.line, mat(0, h / 2, -hl));
  b.add(base, PALETTE.line, mat(0, h / 2, hl));
  // Little anchor pegs at the corners (cute detail, flush with the sand).
  const peg = new THREE.CylinderGeometry(0.06, 0.06, 0.012, 10);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(peg, '#ff9f6b', mat(sx * hw, 0.006, sz * hl));
  const mesh = new THREE.Mesh(b.build(), toonMaterial('#ffffff', { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  mesh.name = 'courtLines';
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ============================================================================ net

function buildNet(root) {
  const { halfWidth: hw, netHeight: top, netBottom: bot, netHalfSpan: span, antennaHeight } = COURT;
  const group = new THREE.Group();
  group.name = 'netGroup';
  root.add(group);

  // --- hardware: posts, pads, tapes, antennas (one merged, outlined mesh)
  const b = new DecorBuilder();
  const postColor = PALETTE.post;
  const padColor = new THREE.Color(PALETTE.post).lerp(new THREE.Color('#ffffff'), 0.55).getStyle();
  const postH = top + 0.32;
  for (const sx of [-1, 1]) {
    const x = sx * span;
    b.add(new THREE.CylinderGeometry(0.065, 0.075, postH, 14), postColor, mat(x, postH / 2, 0));
    b.add(new THREE.SphereGeometry(0.095, 14, 10), postColor, mat(x, postH, 0));
    b.add(new THREE.CapsuleGeometry(0.13, 1.25, 4, 14), padColor, mat(x, 0.82, 0));
    for (const y of [0.45, 1.2]) b.add(new THREE.TorusGeometry(0.135, 0.025, 6, 16), postColor, mat(x, y, 0, Math.PI / 2));
    b.add(new THREE.CylinderGeometry(0.34, 0.42, 0.08, 16), PALETTE.sandDark, mat(x, 0.02, 0));
    // guy rope to a little stake in the sand, outside the court
    const ropeFrom = new THREE.Vector3(x, postH - 0.05, 0);
    const ropeTo = new THREE.Vector3(x + sx * 1.6, 0.05, 0);
    addRope(b, ropeFrom, ropeTo, 0.012, '#f6f0e6');
    b.add(new THREE.CylinderGeometry(0.035, 0.02, 0.25, 6), '#c08a5a', mat(ropeTo.x, 0.08, 0));
  }
  const tapeLen = span * 2 - 0.1;
  b.add(new THREE.BoxGeometry(tapeLen, 0.075, 0.03), PALETTE.net, mat(0, top - 0.0375, 0));
  b.add(new THREE.BoxGeometry(tapeLen, 0.04, 0.022), PALETTE.net, mat(0, bot + 0.02, 0));
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.05, top - bot, 0.034), PALETTE.net, mat(sx * hw, (top + bot) / 2, 0));
    // red/white striped antenna
    const ax = sx * (hw + 0.035);
    const len = top + antennaHeight - bot;
    const n = Math.round(len / 0.1);
    const seg = len / n;
    const g = new THREE.CylinderGeometry(0.022, 0.022, seg, 8, 1, true);
    for (let i = 0; i < n; i++) b.add(g, i % 2 ? '#ffffff' : '#ff4d5e', mat(ax, bot + seg * (i + 0.5), 0.03));
    b.add(new THREE.SphereGeometry(0.03, 8, 6), '#ff4d5e', mat(ax, top + antennaHeight, 0.03));
  }
  const hardware = new THREE.Mesh(b.build(), toonMaterial('#ffffff', { vertexColors: true }));
  hardware.name = 'netHardware';
  hardware.castShadow = true;
  hardware.receiveShadow = true;
  addOutline(hardware, 0.016);
  group.add(hardware);

  // --- net mesh (grid texture, transparent)
  const cell = 32;
  const grid = dataTexture(cell, cell, (u, v, o, x, y) => {
    const onLine = x < 2 || x >= cell - 2 || y < 2 || y >= cell - 2;
    o[0] = o[1] = o[2] = 255;
    o[3] = onLine ? 255 : 0;
  }, { repeat: true, srgb: false });
  const netW = span * 2 - 0.16;
  const netTop = top - 0.075;
  const netBot = bot + 0.04;
  const netH = netTop - netBot;
  grid.repeat.set(netW / 0.11, netH / 0.11);
  const cord = new THREE.Color(PALETTE.outline).lerp(new THREE.Color(PALETTE.net), 0.3);
  const netMat = toonMaterial(cord, {
    map: grid, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.02,
    emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0,
  });
  const segX = 64, segY = 6;
  const netGeo = new THREE.PlaneGeometry(netW, netH, segX, segY);
  netGeo.translate(0, (netTop + netBot) / 2, 0);
  const mesh = new THREE.Mesh(netGeo, netMat);
  mesh.name = 'net';
  mesh.renderOrder = 2;
  group.add(mesh);

  const posAttr = netGeo.getAttribute('position');
  const base = Float32Array.from(posAttr.array);
  const ripples = []; // { x, y, amp, age }
  let flash = 0;
  /** Called by effects on net bounces: position (Vector3-like), strength 0..1. */
  mesh.userData.ripple = (p, strength = 0.6) => {
    if (ripples.length >= 4) ripples.shift();
    ripples.push({ x: p?.x ?? 0, y: THREE.MathUtils.clamp(p?.y ?? (netTop + netBot) / 2, netBot, netTop), amp: 0.06 + 0.12 * strength, age: 0 });
    flash = Math.max(flash, 0.35 + 0.5 * strength);
  };
  let dirty = false;
  function update(dt) {
    if (flash > 0) {
      flash = Math.max(0, flash - dt * 2.5);
      netMat.emissiveIntensity = flash * 0.9;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].age += dt;
      if (ripples[i].age > 1.6) ripples.splice(i, 1);
    }
    if (!ripples.length && !dirty) return;
    const arr = posAttr.array;
    for (let i = 0; i < posAttr.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1];
      const pinY = Math.sin(Math.PI * (y - netBot) / netH);
      const pinX = Math.min(1, (span - 0.1 - Math.abs(x)) / 1.2);
      let dz = 0;
      for (const r of ripples) {
        const d = Math.hypot(x - r.x, (y - r.y) * 1.6);
        dz += r.amp * Math.exp(-d * 0.9) * Math.sin(d * 6 - r.age * 16) * Math.exp(-r.age * 2.6);
      }
      arr[i * 3 + 2] = dz * pinY * Math.max(0, pinX);
    }
    posAttr.needsUpdate = true;
    dirty = ripples.length > 0;
  }
  return { mesh, update };
}

function addRope(b, from, to, r, color) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const m = new THREE.Matrix4().compose(from.clone().lerp(to, 0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(new THREE.CylinderGeometry(r, r, len, 5, 1, true), color, m);
}

// ============================================================================ ocean

function buildOcean(root, uTime) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uShallow: { value: new THREE.Color('#8ff0e8') },
    uMid: { value: new THREE.Color(PALETTE.ocean) },
    uDeep: { value: new THREE.Color('#2f8fe0') },
    uFoam: { value: new THREE.Color('#ffffff') },
    uWet: { value: new THREE.Color(PALETTE.sandDark).lerp(new THREE.Color('#8a6a48'), 0.35) },
    uShore: { value: SHORE_Z },
    uGlow: { value: 0 },
  }]);
  uniforms.uTime = uTime;
  registerGlow((g) => { uniforms.uGlow.value = g; });
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: true,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      uniform float uTime;
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float off = 1.0 - smoothstep(-110.0, -45.0, wp.z);
        wp.y += off * (sin(wp.x * 0.07 + uTime * 0.8) * 0.28 + sin(wp.z * 0.1 - uTime * 1.1) * 0.22);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform float uTime; uniform float uShore; uniform float uGlow;
      uniform vec3 uShallow; uniform vec3 uMid; uniform vec3 uDeep; uniform vec3 uFoam; uniform vec3 uWet;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec2 xz = vWorld.xz;
        float depth = (uShore - xz.y) * 0.08;            // virtual depth of the beach slope
        float swash = 0.15 * sin(uTime * 0.55) + 0.06 * sin(uTime * 1.25 + xz.x * 0.21)
                    + 0.05 * sin(xz.x * 0.07 - uTime * 0.4) + 0.08 * (noise(vec2(xz.x * 0.12, uTime * 0.25)) - 0.5);
        float cover = depth + swash;
        float reach = depth + 0.3;
        if (reach < 0.0) discard;
        vec4 col;
        if (cover < 0.0) {
          col = vec4(uWet, smoothstep(0.0, 0.25, reach) * 0.3);          // damp sand left by the wave
        } else {
          float d = depth;
          float band = floor(smoothstep(0.0, 1.6, d) * 3.0 + 0.5) / 3.0;  // toon-stepped shallows
          vec3 water = mix(uShallow, uMid, band);
          water = mix(water, uDeep, smoothstep(3.0, 14.0, d));
          // soft lighter caustic-like ripples
          float rip = noise(xz * vec2(0.35, 0.6) + vec2(uTime * 0.25, -uTime * 0.18));
          water = mix(water, uShallow, smoothstep(0.62, 0.78, rip) * 0.25 * (1.0 - smoothstep(4.0, 12.0, d)));
          // foam hugging the moving water's edge
          float edge = 1.0 - smoothstep(0.0, 0.05 + 0.04 * noise(xz * 0.9 + uTime * 0.3), cover);
          // rolling foam stripes heading to shore
          float f = fract(xz.y * 0.12 - uTime * 0.2 + 0.25 * noise(vec2(xz.x * 0.05, 3.0)));
          float stripe = smoothstep(0.0, 0.03, f) * (1.0 - smoothstep(0.035, 0.09, f));
          stripe *= step(0.35, noise(vec2(xz.x * 0.18, xz.y * 0.05 + uTime * 0.1)));
          stripe *= 1.0 - smoothstep(0.6, 3.5, d);
          // twinkling sun sparkles offshore
          vec2 cellId = floor(xz * 0.9);
          float sp = hash(cellId);
          float tw = step(0.965, sp) * step(0.75, sin(uTime * 3.0 + sp * 60.0)) * smoothstep(1.0, 5.0, d);
          water = mix(water, uFoam, max(edge, stripe * 0.8));
          water += tw * (0.45 + 1.6 * uGlow); // HDR sparkle -> blooms in high quality
          col = vec4(water, mix(0.65, 1.0, smoothstep(0.0, 0.35, cover)));
        }
        gl_FragColor = col;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(1400, 700, 100, 80);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -17 - 350);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'ocean';
  mesh.position.y = 0.03;
  mesh.renderOrder = 1;
  root.add(mesh);
  return mesh;
}

// ============================================================================ static decor

const SWAY_GLSL = /* glsl */`
  {
    float sw = sway;
    vec3 wpos = position;
    transformed.x += sw * 0.14 * sin(uTime * 1.3 + wpos.x * 0.35 + wpos.z * 0.2);
    transformed.z += sw * 0.09 * sin(uTime * 1.05 + wpos.x * 0.21 + 1.7);
    transformed.y += sw * 0.06 * sin(uTime * 1.7 + wpos.z * 0.3);
  }`;

function swayMaterial(uTime, opts = {}) {
  const m = toonMaterial('#ffffff', { vertexColors: true, ...opts });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWAY_GLSL}`);
  };
  m.customProgramCacheKey = () => 'decor-sway';
  return m;
}

function buildDecor(root, uTime, decals) {
  const lined = new DecorBuilder(); // outlined, static
  const soft = new DecorBuilder();  // no outline (leaves, towels, far scenery), may sway
  const R = rng(42);

  // --- palms: left & right of the court, near the shore, and behind the camera
  const palms = [
    [-11, -14, 6.2], [-14.5, -6, 7.0], [-12, 5, 5.6], [-16, 13, 6.6], [-21, -18, 7.4], [-24, 2, 6.8],
    [11.5, -15, 6.6], [15, -7, 5.8], [17.5, 1, 7.2], [12.5, 14, 6.0], [22, -18, 7.0], [25, 10, 6.4],
    [-13, 30, 7.0], [14, 34, 6.6], [-30, 24, 7.2], [32, 26, 6.8], [-36, -14, 7.6], [38, -10, 7.0],
  ];
  for (const [x, z, h] of palms) {
    const lean = 0.35 + R() * 0.6;
    const yaw = Math.atan2(-x, -z) + (R() - 0.5) * 1.2 + Math.PI; // lean roughly away from the court
    palm(lined, soft, x, z, h, lean, yaw, R);
    decals.push([x, z, 2.2, 2.2, 0]);
  }

  // --- umbrellas + towels along the sidelines (outside |x| > 7)
  const umbrellaColors = ['#ff8fab', '#5ed3b5', '#ffd43b', '#b197fc', '#ff9f6b', '#4dabf7'];
  const spots = [[-9.5, -4, 0], [-10, 3, 1], [-9.2, 9.5, 2], [9.6, -3, 3], [10.2, 4.5, 4], [9.4, 10.5, 5], [-18.5, -10, 1], [19, -12, 0]];
  for (const [x, z, ci] of spots) {
    const tilt = 0.12 + R() * 0.12;
    const yaw = R() * Math.PI * 2;
    umbrella(lined, x, z, umbrellaColors[ci], tilt, yaw);
    decals.push([x + Math.sin(yaw) * 0.25, z + Math.cos(yaw) * 0.25, 3.2, 3.2, 0]);
    towel(soft, x + (x > 0 ? 0.6 : -0.6), z + 0.4, (R() - 0.5) * 0.6, umbrellaColors[(ci + 2) % umbrellaColors.length]);
  }

  // --- lifeguard tower (far left, behind the far baseline) and a tiki hut (right side)
  lifeguardTower(lined, -13.5, -17, Math.atan2(13.5, 17));
  decals.push([-13.5, -17, 4.2, 4.2, 0]);
  tikiHut(lined, soft, 15.5, 7.5, -Math.PI / 2 - 0.3);
  decals.push([15.5, 7.5, 5.5, 5.5, 0]);

  // --- small props: sandcastle, beach balls, surfboards, buckets, rocks, bushes
  sandcastle(lined, 9.2, 13.5);
  decals.push([9.2, 13.5, 1.8, 1.8, 0]);
  beachBall(lined, -8.6, 12.4, 0.28);
  beachBall(lined, 11.2, -9, 0.25);
  surfboard(lined, -8.4, -12.8, '#4dabf7', 0.2);
  surfboard(lined, -7.8, -13.3, '#ff8fab', -0.25);
  surfboard(lined, 18.4, -2, '#ffd43b', 0.1);
  for (let i = 0; i < 10; i++) {
    const x = (R() < 0.5 ? -1 : 1) * (14 + R() * 26);
    const z = SHORE_Z + 1 + R() * 4;
    rock(lined, x, z, 0.35 + R() * 0.6, R);
  }
  for (let i = 0; i < 22; i++) {
    const sx = R() < 0.5 ? -1 : 1;
    const x = sx * (19 + R() * 30);
    const z = -16 + R() * 60;
    bush(lined, x, z, 0.7 + R() * 0.8, R);
  }
  // starfish & shells sprinkled on the sand (outside the play area)
  for (let i = 0; i < 26; i++) {
    let x, z;
    do { x = (R() - 0.5) * 50; z = -21 + R() * 40; } while (Math.abs(x) < 7.5 && Math.abs(z) < 11.5);
    if (R() < 0.45) starfish(soft, x, z, R() * 6.28, ['#ff8a80', '#ffb36b', '#c59bff'][i % 3]);
    else shell(soft, x, z, R() * 6.28);
  }

  // --- inland "back beach" behind the +z baseline: the backdrop of the team-1 (Mint) camera,
  // which looks toward +z (team 0 looks out to sea). Beach huts, a dune fence, grassy dunes.
  backBeach(lined, soft, decals, R);

  // --- distant islands on the horizon and green hills inland
  island(soft, -140, -250, 55, 20, 30, R);
  island(soft, 70, -300, 70, 26, 34, R);
  island(soft, 200, -230, 40, 14, 22, R);
  island(soft, -260, -190, 50, 16, 26, R);
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.15 + 0.7 * (i / 8));
    const r = 210 + R() * 40;
    const x = Math.cos(a) * r * 1.2, z = 60 + Math.sin(a) * r;
    soft.add(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), i % 2 ? '#86cf7e' : '#9edb8f', mat(x, -2, z, 0, R() * 3, 0, 50 + R() * 40, 18 + R() * 16, 40 + R() * 20));
  }
  for (const sx of [-1, 1]) {
    soft.add(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#93d487', mat(sx * 230, -2, -40, 0, 0, 0, 60, 20, 90));
  }

  const linedMat = swayMaterial(uTime, { side: THREE.DoubleSide });
  const linedMesh = new THREE.Mesh(lined.build(), linedMat);
  linedMesh.name = 'decor';
  addOutline(linedMesh, 0.026);
  root.add(linedMesh);

  const softMesh = new THREE.Mesh(soft.build(), swayMaterial(uTime, { side: THREE.DoubleSide }));
  softMesh.name = 'decorSoft';
  root.add(softMesh);
}

let leafGeo = null;
function getLeafGeo() {
  if (leafGeo) return leafGeo;
  const L = 2.3, N = 9;
  const verts = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const w = 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08 + 0.04)), 0.8) + 0.015;
    const y = 0.45 * s - 1.15 * s * s;
    const z = L * s;
    verts.push(-w, y - 0.08 * w, z, 0, y + 0.06, z, w, y - 0.08 * w, z);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  leafGeo = new THREE.BufferGeometry();
  leafGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  leafGeo.setIndex(idx);
  leafGeo.computeVertexNormals();
  return leafGeo;
}

function palm(lined, soft, x, z, h, lean, yaw, R) {
  const N = 7;
  const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);
  const P = (s) => new THREE.Vector3(x + dirX * lean * h * 0.35 * s * s, h * s, z + dirZ * lean * h * 0.35 * s * s);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    const p0 = P(i / N), p1 = P((i + 1) / N);
    const d = new THREE.Vector3().subVectors(p1, p0);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(up, d.normalize());
    const rb = 0.22 - 0.09 * (i / N), rt = rb - 0.03;
    const m = new THREE.Matrix4().compose(p0.clone().lerp(p1, 0.5), q, new THREE.Vector3(1, 1, 1));
    lined.add(new THREE.CylinderGeometry(rt, rb, len * 1.02, 8), i % 2 ? '#b07a4f' : '#9a6741', m);
  }
  const top = P(1);
  const leafColors = ['#4fbf72', '#6fd18a', '#3fae66'];
  const n = 7 + Math.floor(R() * 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + R() * 0.4;
    const m = mat(top.x, top.y + 0.05, top.z, 0, a, 0, 0.9 + R() * 0.3);
    const tilt = mat(0, 0, 0, -0.25 - R() * 0.35, 0, (R() - 0.5) * 0.3);
    soft.add(getLeafGeo(), leafColors[k % 3], mul(m, tilt), (p) => Math.min(1, p.z / 2.3) * 1.0);
  }
  lined.add(new THREE.SphereGeometry(0.2, 10, 8), '#7a5a3a', mat(top.x, top.y, top.z));
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + 0.5;
    lined.add(new THREE.SphereGeometry(0.13, 10, 8), '#8b5e34', mat(top.x + Math.cos(a) * 0.2, top.y - 0.18, top.z + Math.sin(a) * 0.2));
  }
}

function umbrella(lined, x, z, color, tilt, yaw) {
  const base = mat(x, 0, z, 0, yaw, 0);
  const lean = mul(base, mat(0, 0, 0, tilt, 0, 0));
  lined.add(new THREE.CylinderGeometry(0.035, 0.035, 2.3, 8), '#fff6ea', mul(lean, mat(0, 1.15, 0)));
  const canopy = new THREE.ConeGeometry(1.45, 0.55, 12, 1, true);
  lined.add(canopy, (c) => (Math.floor(((Math.atan2(c.z, c.x) + Math.PI) / (Math.PI * 2)) * 12) % 2 ? color : '#ffffff'), mul(lean, mat(0, 2.25, 0)));
  // scalloped rim
  for (let i = 0; i < 12; i++) {
    const a = (i + 0.5) / 12 * Math.PI * 2;
    lined.add(new THREE.SphereGeometry(0.11, 8, 6), i % 2 ? color : '#ffffff', mul(lean, mat(Math.cos(a) * 1.4, 1.98, Math.sin(a) * 1.4, 0, 0, 0, 1, 0.6, 1)));
  }
  lined.add(new THREE.SphereGeometry(0.07, 8, 6), color, mul(lean, mat(0, 2.55, 0)));
}

function towel(soft, x, z, yaw, color) {
  const g = new THREE.BoxGeometry(0.95, 0.02, 1.9, 1, 1, 8);
  soft.add(g, (c) => (Math.floor((c.z + 0.95) / 0.32) % 2 ? color : '#ffffff'), mat(x, 0.012, z, 0, yaw, 0));
}

function lifeguardTower(lined, x, z, yaw) {
  const B = mat(x, 0, z, 0, yaw, 0);
  const white = '#ffffff', red = '#ff6b6b', wood = '#e8b27a';
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    lined.add(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 8), white, mul(B, mat(sx * 0.75, 1.1, sz * 0.75, sz * 0.08, 0, -sx * 0.08)));
  }
  lined.add(new THREE.BoxGeometry(2.1, 0.14, 2.1), wood, mul(B, mat(0, 2.2, 0)));
  lined.add(new THREE.BoxGeometry(1.6, 1.15, 1.5), red, mul(B, mat(0, 2.85, -0.1)));
  lined.add(new THREE.BoxGeometry(0.9, 0.55, 0.05), '#bfe9ff', mul(B, mat(0, 2.95, 0.66)));
  lined.add(new THREE.BoxGeometry(1.68, 0.1, 1.58), white, mul(B, mat(0, 2.3, -0.1)));
  lined.add(new THREE.ConeGeometry(1.45, 0.75, 4), white, mul(B, mat(0, 3.8, -0.1, 0, Math.PI / 4, 0)));
  // red cross
  lined.add(new THREE.BoxGeometry(0.34, 0.1, 0.02), red, mul(B, mat(0, 3.38, 0.65)));
  lined.add(new THREE.BoxGeometry(0.1, 0.34, 0.02), red, mul(B, mat(0, 3.38, 0.65)));
  // railing + ladder
  for (const sx of [-1, 1]) lined.add(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), wood, mul(B, mat(sx * 0.35, 1.2, 1.35, -0.5, 0, 0)));
  for (let i = 0; i < 6; i++) lined.add(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), wood, mul(B, mat(0, 0.25 + i * 0.36, 1.95 - i * 0.2, 0, 0, Math.PI / 2)));
  // flag
  lined.add(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6), white, mul(B, mat(0.6, 4.4, -0.1)));
  lined.add(new THREE.BoxGeometry(0.5, 0.3, 0.02), '#ffd43b', mul(B, mat(0.86, 4.8, -0.1)));
}

function tikiHut(lined, soft, x, z, yaw) {
  const B = mat(x, 0, z, 0, yaw, 0);
  const bamboo = '#d8b36a';
  for (const [px, pz] of [[-1.4, -1.1], [1.4, -1.1], [-1.4, 1.1], [1.4, 1.1]]) {
    lined.add(new THREE.CylinderGeometry(0.09, 0.1, 2.6, 8), bamboo, mul(B, mat(px, 1.3, pz)));
  }
  const roof = new THREE.ConeGeometry(2.6, 1.4, 14, 2, true);
  lined.add(roof, (c) => (Math.floor(((Math.atan2(c.z, c.x) + Math.PI) / (Math.PI * 2)) * 14) % 2 ? '#e7c46e' : '#d4a94f'), mul(B, mat(0, 3.2, 0)));
  lined.add(new THREE.SphereGeometry(0.18, 8, 6), '#d4a94f', mul(B, mat(0, 3.95, 0)));
  // fringe
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    soft.add(new THREE.ConeGeometry(0.12, 0.45, 4), i % 2 ? '#e7c46e' : '#cfa047', mul(B, mat(Math.cos(a) * 2.5, 2.35, Math.sin(a) * 2.5, Math.PI, 0, 0)), 0.15);
  }
  // counter, stools, a sign and a few fruity drinks
  lined.add(new THREE.BoxGeometry(2.6, 1.0, 0.7), '#c98d52', mul(B, mat(0, 0.5, 1.2)));
  lined.add(new THREE.BoxGeometry(2.8, 0.1, 0.85), '#f3d9a4', mul(B, mat(0, 1.05, 1.2)));
  for (const sx of [-0.8, 0, 0.8]) {
    lined.add(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 12), '#ff8fab', mul(B, mat(sx, 0.72, 2.05)));
    lined.add(new THREE.CylinderGeometry(0.04, 0.06, 0.7, 6), bamboo, mul(B, mat(sx, 0.35, 2.05)));
  }
  const drinks = ['#ff9f6b', '#5ed3b5', '#ffd43b'];
  for (let i = 0; i < 3; i++) {
    lined.add(new THREE.CylinderGeometry(0.07, 0.05, 0.2, 8), drinks[i], mul(B, mat(-0.7 + i * 0.6, 1.2, 1.25)));
    lined.add(new THREE.SphereGeometry(0.045, 6, 5), '#ffe066', mul(B, mat(-0.64 + i * 0.6, 1.32, 1.25)));
  }
  lined.add(new THREE.BoxGeometry(1.4, 0.4, 0.06), '#fff1d6', mul(B, mat(0, 2.25, 1.35)));
}

// Inland backdrop (z > 20): seen from the team-1 gameplay camera and the menu / result orbits.
// Everything is merged into the two decor meshes (no extra draw calls); ~9k triangles total.
function backBeach(lined, soft, decals, R) {
  // Row of pastel beach huts facing the court, a gap in the middle for the boardwalk.
  const hutCols = ['#ff8fab', '#5ed3b5', '#ffd43b', '#b197fc', '#4dabf7', '#ff9f6b'];
  [-21, -16.5, -12, 12, 16.5, 21].forEach((x, i) => {
    const z = 24.5 + R() * 1.5;
    beachHut(lined, x, z, Math.PI + (R() - 0.5) * 0.25 - x * 0.012, hutCols[i]);
    decals.push([x, z, 3.6, 3.6, 0]);
  });
  // Boardwalk from the court area up through the dunes, with a cute striped arch.
  for (let i = 0; i < 26; i++) {
    const z = 19 + i * 0.9;
    lined.add(new THREE.BoxGeometry(2.6, 0.1, 0.78), i % 2 ? '#e3b47c' : '#d9a76e', mat((R() - 0.5) * 0.06, 0.05, z, 0, (R() - 0.5) * 0.03, 0));
  }
  for (const sx of [-1, 1]) {
    lined.add(new THREE.CylinderGeometry(0.13, 0.15, 3.4, 8), (c) => (Math.floor((c.y + 1.7) / 0.42) % 2 ? '#ffffff' : '#ff8fab'), mat(sx * 1.7, 1.7, 21));
    lined.add(new THREE.SphereGeometry(0.2, 10, 8), '#ffd43b', mat(sx * 1.7, 3.5, 21));
  }
  lined.add(new THREE.BoxGeometry(3.0, 0.62, 0.12), (c) => (Math.abs(c.x) < 1.25 && Math.abs(c.y) < 0.2 ? '#5ed3b5' : '#fff6ea'), mat(0, 3.05, 21));
  for (let i = 0; i < 5; i++) lined.add(new THREE.SphereGeometry(0.075, 8, 6), hutCols[i], mat(-1 + i * 0.5, 3.05, 20.92));
  // Bunting: little flags sagging between the arch and the inner huts.
  for (const sx of [-1, 1]) {
    const a = new THREE.Vector3(sx * 1.7, 3.2, 21), b = new THREE.Vector3(sx * 10.6, 2.9, 25);
    const N = 11;
    for (let k = 1; k < N; k++) {
      const t = k / N;
      const p = a.clone().lerp(b, t);
      p.y -= Math.sin(Math.PI * t) * 0.7;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
      soft.add(new THREE.ConeGeometry(0.17, 0.4, 3), hutCols[k % hutCols.length], mat(p.x, p.y - 0.2, p.z, Math.PI, yaw, 0, 1, 1, 0.25), 0.5);
    }
  }
  // Wooden dune fence (slats + two wires) in short wavy runs, gaps for the boardwalk.
  for (const [x0, x1] of [[-30, -3], [3, 30]]) {
    for (let x = x0; x <= x1; x += 0.42) {
      const z = 31 + Math.sin(x * 0.21) * 1.1;
      const h = 0.85 + R() * 0.25;
      soft.add(new THREE.BoxGeometry(0.1, h, 0.04), R() < 0.5 ? '#c99a66' : '#b88857', mat(x, h / 2, z, 0, 0, (R() - 0.5) * 0.12));
    }
  }
  // Grassy dunes behind the fence, and a green bank further back that fills the top of the view.
  for (let i = 0; i < 16; i++) {
    const x = -48 + i * 6.4 + (R() - 0.5) * 3;
    if (Math.abs(x) < 4) continue;
    const z = 38 + R() * 6, sx = 5 + R() * 3, sy = 1.6 + R() * 1.6, sz = 4 + R() * 2;
    soft.add(new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), i % 2 ? '#f1d59e' : '#ecce92', mat(x, -0.05, z, 0, R() * 3, 0, sx, sy, sz));
    // marram grass tufts on the crest (sway in the wind)
    for (let k = 0; k < 7; k++) {
      const a = R() * Math.PI * 2, r = Math.sqrt(R()) * 0.75;
      const gx = x + Math.cos(a) * sx * r, gz = z + Math.sin(a) * sz * r;
      const gy = sy * Math.sqrt(Math.max(0, 1 - r * r)) - 0.1;
      for (let j = 0; j < 3; j++) {
        soft.add(new THREE.ConeGeometry(0.07, 0.9 + R() * 0.5, 3), j === 1 ? '#7fcf7a' : '#9edb8f',
          mat(gx + (j - 1) * 0.12, gy + 0.4, gz, (R() - 0.5) * 0.5, 0, (j - 1) * 0.35), (p) => THREE.MathUtils.clamp(p.y + 0.5, 0, 1) * 0.5);
      }
    }
  }
  for (let i = 0; i < 9; i++) {
    const x = -64 + i * 16 + (R() - 0.5) * 6;
    soft.add(new THREE.SphereGeometry(1, 18, 7, 0, Math.PI * 2, 0, Math.PI / 2), i % 2 ? '#93d487' : '#86cf7e',
      mat(x, -0.5, 58 + R() * 10, 0, R() * 3, 0, 11 + R() * 5, 4 + R() * 3, 8 + R() * 4));
  }
  // A few extra palms and bushes along the dunes so the inland horizon line is lively.
  for (const [x, z, h] of [[-25, 35, 6.8], [-6.5, 36, 6.2], [7, 37.5, 7.0], [24, 34, 6.4], [-40, 44, 7.4], [41, 46, 7.2]]) {
    palm(lined, soft, x, z, h, 0.3 + R() * 0.5, (R() - 0.5) * 1.2, R);
  }
  for (const [x, z] of [[-9, 34], [10, 33.5], [-18.5, 34.5], [19, 35]]) bush(lined, x, z, 0.8 + R() * 0.4, R);
}

function beachHut(lined, x, z, yaw, color) {
  const B = mat(x, 0, z, 0, yaw, 0);
  const white = '#fff6ea', wood = '#d9a76e';
  // short stilts + deck
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) lined.add(new THREE.CylinderGeometry(0.08, 0.08, 0.4, 6), wood, mul(B, mat(sx * 0.95, 0.2, sz * 0.9)));
  lined.add(new THREE.BoxGeometry(2.3, 0.14, 2.6), wood, mul(B, mat(0, 0.45, 0.2)));
  // striped walls (vertical stripes), door + round window on the court-facing (+z local) side
  lined.add(new THREE.BoxGeometry(2.0, 1.9, 1.9, 6, 1, 6), (c) => (Math.floor((c.x + c.z + 4) / 0.34) % 2 ? color : white), mul(B, mat(0, 1.47, 0)));
  lined.add(new THREE.BoxGeometry(0.62, 1.25, 0.05), white, mul(B, mat(0.35, 1.17, 0.97)));
  lined.add(new THREE.SphereGeometry(0.05, 6, 5), '#ffd43b', mul(B, mat(0.55, 1.15, 1.0)));
  lined.add(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), '#bfe9ff', mul(B, mat(-0.5, 1.75, 0.97, Math.PI / 2, 0, 0)));
  // pyramid roof with a little ball on top
  lined.add(new THREE.ConeGeometry(1.75, 0.95, 4), color, mul(B, mat(0, 2.88, 0, 0, Math.PI / 4, 0)));
  lined.add(new THREE.SphereGeometry(0.12, 8, 6), white, mul(B, mat(0, 3.42, 0)));
  // a step in front
  lined.add(new THREE.BoxGeometry(0.8, 0.12, 0.35), wood, mul(B, mat(0.35, 0.2, 1.65)));
}

function sandcastle(lined, x, z) {
  const c = PALETTE.sandDark;
  lined.add(new THREE.BoxGeometry(1.1, 0.35, 1.1), c, mat(x, 0.17, z));
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    lined.add(new THREE.CylinderGeometry(0.17, 0.2, 0.6, 10), c, mat(x + dx, 0.3, z + dz));
    lined.add(new THREE.ConeGeometry(0.2, 0.25, 10), '#e0b878', mat(x + dx, 0.72, z + dz));
  }
  lined.add(new THREE.CylinderGeometry(0.24, 0.28, 0.8, 12), c, mat(x, 0.6, z));
  lined.add(new THREE.ConeGeometry(0.28, 0.35, 12), '#e0b878', mat(x, 1.17, z));
  lined.add(new THREE.CylinderGeometry(0.01, 0.01, 0.4, 4), '#ffffff', mat(x, 1.5, z));
  lined.add(new THREE.BoxGeometry(0.22, 0.13, 0.01), '#ff8fab', mat(x + 0.11, 1.63, z));
  // bucket + spade
  lined.add(new THREE.CylinderGeometry(0.2, 0.15, 0.3, 12), '#4dabf7', mat(x + 1.0, 0.15, z + 0.4));
  lined.add(new THREE.BoxGeometry(0.12, 0.02, 0.5), '#ffd43b', mat(x - 0.9, 0.05, z + 0.5, 0.2, 0.6, 0));
}

function beachBall(lined, x, z, r) {
  const cols = ['#ff6b6b', '#ffffff', '#ffd43b', '#ffffff', '#4dabf7', '#ffffff'];
  lined.add(new THREE.SphereGeometry(r, 18, 12), (c) => cols[Math.floor(((Math.atan2(c.z, c.x) + Math.PI) / (Math.PI * 2)) * 6) % 6], mat(x, r, z, 0.4, 0.3, 0.2));
}

function surfboard(lined, x, z, color, rz) {
  lined.add(new THREE.CapsuleGeometry(0.28, 1.5, 4, 12), (c) => (Math.abs(c.x) < 0.05 ? '#ffffff' : color), mat(x, 0.9, z, 0.08, 0.3, rz, 1, 1, 0.18));
}

function rock(lined, x, z, s, R) {
  lined.add(new THREE.DodecahedronGeometry(1, 0), R() < 0.5 ? '#c9b8a0' : '#b5a48d', mat(x, s * 0.25, z, R(), R(), R(), s * 1.2, s * 0.6, s));
}

function bush(lined, x, z, s, R) {
  const cols = ['#6cc787', '#5bb876', '#82d494'];
  for (let i = 0; i < 3; i++) {
    lined.add(new THREE.SphereGeometry(1, 10, 8), cols[i], mat(x + (i - 1) * 0.6 * s, 0.45 * s, z + (R() - 0.5) * 0.5 * s, 0, 0, 0, 0.7 * s, 0.6 * s, 0.7 * s));
  }
  if (R() < 0.5) lined.add(new THREE.SphereGeometry(0.12 * s, 6, 5), '#ff8fab', mat(x + 0.2 * s, 0.85 * s, z + 0.3 * s));
}

function starfish(soft, x, z, rot, color) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 ? 0.07 : 0.17;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
  soft.add(g, color, mat(x, 0.032, z, Math.PI / 2, 0, rot));
}

function shell(soft, x, z, rot) {
  soft.add(new THREE.SphereGeometry(0.09, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), (c) => (Math.floor((Math.atan2(c.z, c.x) + Math.PI) * 2.5) % 2 ? '#ffd6e0' : '#fff1f4'), mat(x, 0, z, 0, rot, 0, 1, 0.5, 1.2));
}

function island(soft, x, z, sx, sy, sz, R) {
  const dome = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  soft.add(new THREE.CylinderGeometry(1, 1.08, 0.6, 24), PALETTE.sand, mat(x, 0, z, 0, 0, 0, sx * 1.15, 1, sz * 1.15));
  soft.add(dome, '#7cc77a', mat(x, 0, z, 0, 0, 0, sx, sy, sz));
  soft.add(dome, '#95d68c', mat(x + sx * 0.3, 0, z + sz * 0.2, 0, 0, 0, sx * 0.55, sy * 1.25, sz * 0.6));
  for (let i = 0; i < 4; i++) {
    const px = x + (R() - 0.5) * sx * 1.6, pz = z + sz * (0.6 + R() * 0.3);
    soft.add(new THREE.CylinderGeometry(0.5, 0.7, 9, 5), '#9a6741', mat(px, 4.5, pz, 0, 0, (R() - 0.5) * 0.4));
    soft.add(new THREE.SphereGeometry(4, 8, 5), '#4fbf72', mat(px, 9, pz, 0, 0, 0, 1, 0.35, 1));
  }
}

// ============================================================================ decals

function buildDecals(root, decals) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: blobTexture(), color: '#b98448', transparent: true, opacity: 0.38, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, material, decals.length);
  decals.forEach(([x, z, sx, sz], i) => mesh.setMatrixAt(i, mat(x, 0.012, z, 0, 0, 0, sx, 1, sz)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'decorShadows';
  mesh.renderOrder = 1;
  root.add(mesh);
}

// ============================================================================ clouds

function cloudGeometry(seed) {
  const R = rng(seed);
  const b = new DecorBuilder();
  const n = 5 + Math.floor(R() * 3);
  const sphere = new THREE.SphereGeometry(1, 14, 10);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    const r = 0.8 + (1 - Math.abs(t) * 1.6) * 0.7 + R() * 0.25;
    b.add(sphere, '#ffffff', mat(t * 4.2, r * 0.35 + R() * 0.3, (R() - 0.5) * 1.2, 0, 0, 0, r));
  }
  const g = b.build();
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) * 0.25); // flat-ish bottoms
  g.computeVertexNormals();
  return g;
}

function buildClouds(root) {
  const R = rng(99);
  const material = toonMaterial('#ffffff', { vertexColors: true, emissive: new THREE.Color('#e8f4ff'), emissiveIntensity: 0.16, fog: false });
  const variants = [cloudGeometry(3), cloudGeometry(8)];
  const items = [];
  const meshes = variants.map((g, vi) => {
    const count = 9;
    const m = new THREE.InstancedMesh(g, material, count);
    m.name = `clouds${vi}`;
    m.frustumCulled = false;
    root.add(m);
    for (let i = 0; i < count; i++) {
      // Mostly out over the sea near the horizon (visible from the gameplay camera), some all around.
      const around = i >= 6;
      const ang = around ? R() * Math.PI * 2 : -Math.PI / 2 + (R() - 0.5) * 1.6;
      const dist = around ? 240 + R() * 120 : 260 + R() * 160;
      items.push({
        mesh: m, i,
        x: Math.cos(ang) * dist, z: Math.sin(ang) * dist,
        y: (around ? 45 : 14) + R() * 26,
        s: 7 + R() * 7,
        speed: 1.2 + R() * 1.6,
        yaw: R() * 0.6 - 0.3,
      });
    }
    return m;
  });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  function write() {
    for (const c of items) {
      c.mesh.setMatrixAt(c.i, m4.compose(p.set(c.x, c.y, c.z), q.setFromEuler(e.set(0, c.yaw, 0)), s.set(c.s, c.s * 0.8, c.s * 0.7)));
    }
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  }
  write();
  return {
    update(dt) {
      for (const c of items) {
        c.x += c.speed * dt;
        if (c.x > 420) c.x -= 840;
      }
      write();
    },
  };
}

// ============================================================================ seagulls

function buildGulls(root) {
  const bodyB = new DecorBuilder();
  bodyB.add(new THREE.SphereGeometry(0.18, 10, 8), '#ffffff', mat(0, 0, 0, 0, 0, 0, 1, 0.9, 1.9));
  bodyB.add(new THREE.SphereGeometry(0.13, 10, 8), '#ffffff', mat(0, 0.08, 0.3));
  bodyB.add(new THREE.ConeGeometry(0.04, 0.14, 6), '#ffb347', mat(0, 0.07, 0.48, Math.PI / 2, 0, 0));
  bodyB.add(new THREE.SphereGeometry(0.022, 6, 5), '#3b2b3a', mat(0.07, 0.12, 0.38));
  bodyB.add(new THREE.SphereGeometry(0.022, 6, 5), '#3b2b3a', mat(-0.07, 0.12, 0.38));
  bodyB.add(new THREE.ConeGeometry(0.1, 0.25, 4), '#d9dee6', mat(0, 0.02, -0.38, -Math.PI / 2, 0, 0, 1, 1, 0.4));
  const wingB = new DecorBuilder();
  const wg = new THREE.BoxGeometry(0.62, 0.03, 0.26, 4, 1, 1);
  wg.translate(0.31, 0, 0);
  wingB.add(wg, (c) => (c.x > 0.45 ? '#7b8494' : '#eef1f5'), null);
  const material = toonMaterial('#ffffff', { vertexColors: true, side: THREE.DoubleSide });
  const N = 3;
  const bodies = new THREE.InstancedMesh(bodyB.build(), material, N);
  const wings = new THREE.InstancedMesh(wingB.build(), material, N * 2);
  bodies.name = 'gulls';
  wings.name = 'gullWings';
  bodies.frustumCulled = wings.frustumCulled = false;
  root.add(bodies, wings);
  const gulls = [
    { cx: -12, cz: -38, r: 7, y: 7.5, sp: 0.35, ph: 0 },
    { cx: -9, cz: -42, r: 9, y: 8.6, sp: 0.28, ph: 2.1 },
    { cx: 14, cz: -36, r: 6, y: 7.0, sp: -0.32, ph: 4.0 },
  ];
  const m = new THREE.Matrix4(), w = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), one = new THREE.Vector3(1.7, 1.7, 1.7);
  const mirror = new THREE.Vector3(-1, 1, 1), unit = new THREE.Vector3(1, 1, 1);
  return {
    update(t) {
      gulls.forEach((g, i) => {
        const a = t * g.sp + g.ph;
        p.set(g.cx + Math.cos(a) * g.r, g.y + Math.sin(t * 0.8 + i) * 0.4, g.cz + Math.sin(a) * g.r);
        const heading = Math.atan2(-Math.sin(a) * Math.sign(g.sp), Math.cos(a) * Math.sign(g.sp));
        q.setFromEuler(e.set(0, heading, -0.35 * Math.sign(g.sp)));
        m.compose(p, q, one);
        bodies.setMatrixAt(i, m);
        const glide = Math.sin(t * 0.5 + i * 1.7) > 0.3;
        const flap = glide ? 0.12 : Math.sin(t * 9 + i) * 0.6;
        for (const side of [1, -1]) {
          tmp.compose(p.set(0.08 * side, 0.06, 0.02), q.setFromEuler(e.set(0, 0, flap * side)), side > 0 ? unit : mirror);
          w.multiplyMatrices(m, tmp);
          wings.setMatrixAt(i * 2 + (side > 0 ? 0 : 1), w);
        }
      });
      bodies.instanceMatrix.needsUpdate = true;
      wings.instanceMatrix.needsUpdate = true;
    },
  };
}

// ============================================================================ crab

function buildCrab(root) {
  const b = new DecorBuilder();
  const red = '#ff6b5b', dark = '#e2493c';
  b.add(new THREE.SphereGeometry(0.22, 14, 10), red, mat(0, 0.16, 0, 0, 0, 0, 1.3, 0.7, 1));
  for (const sx of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 6), red, mat(sx * 0.08, 0.3, 0.12));
    b.add(new THREE.SphereGeometry(0.05, 8, 6), '#ffffff', mat(sx * 0.08, 0.38, 0.12));
    b.add(new THREE.SphereGeometry(0.025, 6, 5), '#3b2b3a', mat(sx * 0.08, 0.39, 0.165));
    b.add(new THREE.SphereGeometry(0.1, 10, 8), dark, mat(sx * 0.36, 0.2, 0.16, 0, 0, 0, 1, 0.8, 1.2));
    b.add(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 6), red, mat(sx * 0.27, 0.17, 0.08, 0, 0, sx * 1.2));
    for (let k = 0; k < 3; k++) b.add(new THREE.CylinderGeometry(0.018, 0.012, 0.22, 5), dark, mat(sx * 0.3, 0.08, -0.08 + k * 0.08, 0, 0, sx * 0.9));
  }
  b.add(new THREE.SphereGeometry(0.035, 6, 5), '#ffb3b3', mat(0.16, 0.2, 0.19));
  b.add(new THREE.SphereGeometry(0.035, 6, 5), '#ffb3b3', mat(-0.16, 0.2, 0.19));
  const mesh = new THREE.Mesh(b.build(), toonMaterial('#ffffff', { vertexColors: true }));
  mesh.name = 'crab';
  mesh.scale.setScalar(1.3);
  addOutline(mesh, 0.018);
  root.add(mesh);
  const cx = 10.5, cz = SHORE_Z + 4.5;
  return {
    update(t) {
      // Scuttle sideways, pause, scuttle back.
      const cycle = (t * 0.18) % 2;
      const phase = cycle < 1 ? cycle : 2 - cycle;
      const s = THREE.MathUtils.smootherstep(phase, 0.15, 0.85);
      const moving = phase > 0.15 && phase < 0.85;
      mesh.position.set(cx + (s - 0.5) * 5, moving ? Math.abs(Math.sin(t * 22)) * 0.03 : 0, cz + Math.sin(t * 0.3) * 0.4);
      mesh.rotation.y = Math.sin(t * 0.7) * 0.25;
      mesh.rotation.z = moving ? Math.sin(t * 22) * 0.06 : 0;
    },
  };
}

// ============================================================================ sailboat

function buildBoat(root) {
  const b = new DecorBuilder();
  b.add(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), '#ffffff', mat(0, 0.35, 0, 0, 0, 0, 1.1, 0.7, 3));
  b.add(new THREE.BoxGeometry(2.0, 0.12, 5.6), '#ff8fab', mat(0, 0.36, 0));
  b.add(new THREE.CylinderGeometry(0.07, 0.07, 6, 6), '#c08a5a', mat(0, 3.3, 0.3));
  const sail = new THREE.Shape();
  sail.moveTo(0, 0); sail.lineTo(0, 5.2); sail.quadraticCurveTo(1.4, 2.2, 2.6, 0); sail.lineTo(0, 0);
  const sg = new THREE.ShapeGeometry(sail, 6);
  b.add(sg, (c) => (c.y > 1.6 && c.y < 2.4 ? '#ffd43b' : '#fff8ee'), mat(0, 0.8, 0.4, 0, Math.PI / 2, 0));
  const mesh = new THREE.Mesh(b.build(), toonMaterial('#ffffff', { vertexColors: true, side: THREE.DoubleSide }));
  mesh.name = 'sailboat';
  root.add(mesh);
  return {
    update(t) {
      const x = ((t * 0.9 + 60) % 180) - 90;
      mesh.position.set(x, Math.sin(t * 1.1) * 0.15, -95);
      mesh.rotation.set(Math.sin(t * 0.9) * 0.04, Math.PI / 2, Math.sin(t * 1.3) * 0.06);
    },
  };
}

