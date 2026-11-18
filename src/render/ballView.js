// Ball visuals: panelled toon volleyball, blob shadow, landing marker, speed trail, aim reticle.
// createBallView(scene) -> { update(dt, ball, fullState?) }
import * as THREE from 'three';
import { BALL, COURT, PALETTE, TEAMS } from '../config.js';
import { toonMaterial, addOutline, dataTexture, blobTexture } from './toon.js';

const TRAIL_N = 18;
const UP = new THREE.Vector3(0, 1, 0);

export function createBallView(scene) {
  const root = new THREE.Group();
  root.name = 'ballView';
  scene.add(root);

  // ------------------------------------------------------------- ball
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.radius, 32, 20),
    toonMaterial('#ffffff', { map: ballTexture() }),
  );
  ball.name = 'ball';
  ball.castShadow = false; // the blob shadow straight below reads better for depth than a slanted sun shadow
  addOutline(ball, 0.022);
  root.add(ball);

  // ------------------------------------------------------------- blob shadow
  const shadow = new THREE.Mesh(
    flatPlane(1),
    new THREE.MeshBasicMaterial({
      map: blobTexture(), color: '#5a3d36', transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  );
  shadow.name = 'ballShadow';
  shadow.renderOrder = 3;
  root.add(shadow);

  // ------------------------------------------------------------- landing marker
  const markerMat = new THREE.MeshBasicMaterial({
    map: targetTexture(), color: TEAMS[0].color, transparent: true, opacity: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, fog: false,
  });
  const marker = new THREE.Mesh(flatPlane(2), markerMat);
  marker.name = 'landingMarker';
  marker.renderOrder = 4;
  marker.visible = false;
  root.add(marker);
  const teamColors = TEAMS.map((t) => new THREE.Color(t.color));
  const outColor = new THREE.Color('#ffffff');
  const markerColor = new THREE.Color(TEAMS[0].color);
  let markerAlpha = 0;
  const markerPos = new THREE.Vector3();
  let markerHas = false;

  // ------------------------------------------------------------- aim reticle
  const aimMat = new THREE.MeshBasicMaterial({
    map: reticleTexture(), color: TEAMS[0].color, transparent: true, opacity: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, fog: false,
  });
  const aim = new THREE.Mesh(flatPlane(1.6), aimMat);
  aim.name = 'aimReticle';
  aim.renderOrder = 5;
  aim.visible = false;
  root.add(aim);
  let aimAlpha = 0;
  const aimPos = new THREE.Vector3();

  // ------------------------------------------------------------- speed trail (two crossed ribbons)
  const trailPts = Array.from({ length: TRAIL_N }, () => new THREE.Vector3());
  let trailCount = 0;
  const vCount = 2 * TRAIL_N * 2;
  const tPos = new Float32Array(vCount * 3);
  const tCol = new Float32Array(vCount * 4);
  const tIdx = [];
  for (let r = 0; r < 2; r++) {
    const o = r * TRAIL_N * 2;
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = o + i * 2, b = o + (i + 1) * 2;
      tIdx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 4).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setIndex(tIdx);
  const trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  trail.name = 'ballTrail';
  trail.frustumCulled = false;
  trail.renderOrder = 6;
  trail.visible = false;
  root.add(trail);
  let trailI = 0;
  const trailColor = new THREE.Color();
  const white = new THREE.Color('#ffffff');

  // ------------------------------------------------------------- temps
  const tmpQ = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const d = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const lastPos = new THREE.Vector3();
  let haveLast = false;
  let clock = 0;

  function update(dt, b, fullState) {
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    if (!b) return;
    const visible = b.visible !== false;
    ball.visible = visible;
    shadow.visible = visible;

    // --- ball transform + spin
    ball.position.copy(b.pos);
    if (b.spin) {
      const w = b.spin.length();
      if (w > 1e-4 && dt > 0) {
        axis.copy(b.spin).multiplyScalar(1 / w);
        tmpQ.setFromAxisAngle(axis, w * dt);
        ball.quaternion.premultiply(tmpQ).normalize();
      }
    }

    // --- blob shadow
    const h = Math.max(0, b.pos.y - BALL.radius);
    const size = BALL.radius * 2.8 * (1 + h * 0.11);
    shadow.position.set(b.pos.x, 0.02, b.pos.z);
    shadow.scale.set(Math.min(size, 2.4), 1, Math.min(size, 2.4));
    shadow.material.opacity = Math.max(0.2, 0.62 / (1 + h * 0.16));

    // --- landing marker
    const inFlight = visible && b.landing && !b.held;
    if (inFlight) {
      if (!markerHas) markerPos.copy(b.landing);
      markerPos.lerp(b.landing, 1 - Math.exp(-25 * dt));
      markerHas = true;
      const side = markerPos.z >= 0 ? 0 : 1;
      const out = Math.abs(markerPos.x) > COURT.halfWidth + BALL.radius || Math.abs(markerPos.z) > COURT.halfLength + BALL.radius;
      markerColor.copy(teamColors[side]);
      if (out) markerColor.lerp(outColor, 0.55);
      markerMat.color.lerp(markerColor, 1 - Math.exp(-12 * dt));
      markerAlpha = Math.min(1, markerAlpha + dt * 6);
      const alt = THREE.MathUtils.clamp(h / 7, 0, 1);
      const s = (0.5 + 0.55 * alt) * (1 + 0.07 * Math.sin(clock * 10));
      marker.scale.set(s, 1, s);
      markerMat.opacity = markerAlpha * (out ? 0.55 : 0.92);
    } else {
      markerAlpha = Math.max(0, markerAlpha - dt * 5);
      markerMat.opacity = markerAlpha * 0.9;
      if (markerAlpha <= 0) markerHas = false;
    }
    marker.visible = markerAlpha > 0.01;
    marker.position.set(markerPos.x, 0.03, markerPos.z);
    marker.rotation.y = clock * 1.2;

    // --- aim reticle (human attack aim)
    const at = fullState && fullState.aimTarget;
    if (at) {
      if (aimAlpha <= 0.01) aimPos.copy(at);
      aimPos.lerp(at, 1 - Math.exp(-18 * dt));
      aimAlpha = Math.min(1, aimAlpha + dt * 7);
    } else {
      aimAlpha = Math.max(0, aimAlpha - dt * 6);
    }
    aim.visible = aimAlpha > 0.01;
    aim.position.set(aimPos.x, 0.035, aimPos.z);
    aim.rotation.y = -clock * 2.2;
    const as = 1 + 0.1 * Math.sin(clock * 12);
    aim.scale.set(as, 1, as);
    aimMat.opacity = aimAlpha * 0.95;

    // --- speed trail
    const speed = b.vel ? b.vel.length() : 0;
    const target = visible && !b.held ? THREE.MathUtils.clamp((speed - 11) / 7, 0, 1) : 0;
    trailI += (target - trailI) * (1 - Math.exp(-(target > trailI ? 14 : 5) * dt));
    const jumped = haveLast && lastPos.distanceToSquared(b.pos) > 9;
    if (!visible || jumped) trailCount = 0;
    lastPos.copy(b.pos);
    haveLast = true;
    if (visible) {
      for (let i = Math.min(trailCount, TRAIL_N - 1); i > 0; i--) trailPts[i].copy(trailPts[i - 1]);
      trailPts[0].copy(b.pos);
      trailCount = Math.min(TRAIL_N, trailCount + 1);
    }
    trail.visible = trailI > 0.02 && trailCount > 2;
    if (trail.visible) {
      const team = b.lastTeam === 0 || b.lastTeam === 1 ? b.lastTeam : 0;
      trailColor.copy(teamColors[team]).lerp(white, 0.45);
      writeTrail(trailI, trailColor);
    }
  }

  function writeTrail(intensity, color) {
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < TRAIL_N; i++) {
        const k = Math.min(i, trailCount - 1);
        const p = trailPts[k];
        if (k > 0) d.subVectors(trailPts[k - 1], p); else d.subVectors(p, trailPts[Math.min(1, trailCount - 1)]);
        if (d.lengthSq() < 1e-8) d.set(0, 0, 1);
        d.normalize();
        p1.crossVectors(d, UP);
        if (p1.lengthSq() < 1e-6) p1.set(1, 0, 0);
        p1.normalize();
        if (r === 1) p2.crossVectors(d, p1).normalize(); else p2.copy(p1);
        const f = i / (TRAIL_N - 1);
        const w = BALL.radius * 0.95 * (1 - f);
        const vi = (r * TRAIL_N + i) * 2;
        tPos[vi * 3] = p.x + p2.x * w; tPos[vi * 3 + 1] = p.y + p2.y * w; tPos[vi * 3 + 2] = p.z + p2.z * w;
        tPos[vi * 3 + 3] = p.x - p2.x * w; tPos[vi * 3 + 4] = p.y - p2.y * w; tPos[vi * 3 + 5] = p.z - p2.z * w;
        const a = i < trailCount ? intensity * 0.75 * Math.pow(1 - f, 1.4) : 0;
        for (let s = 0; s < 2; s++) {
          const ci = (vi + s) * 4;
          tCol[ci] = color.r; tCol[ci + 1] = color.g; tCol[ci + 2] = color.b; tCol[ci + 3] = a;
        }
      }
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
  }

  return { update, root, ball };
}

function flatPlane(size) {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Equirect panel texture: three interlocking strip panels per cube face, like a real volleyball. */
function ballTexture() {
  const cols = PALETTE.ball.map((c) => new THREE.Color(c));
  const seam = new THREE.Color(PALETTE.outline);
  const c = new THREE.Color();
  const dir = new THREE.Vector3();
  return dataTexture(256, 128, (u, v, o) => {
    const theta = (1 - v) * Math.PI, phi = u * Math.PI * 2;
    dir.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    let face, s, edge;
    if (ax >= ay && ax >= az) { face = 0; s = dir.y / ax; edge = ax - Math.max(ay, az); }
    else if (ay >= az) { face = 1; s = dir.z / ay; edge = ay - Math.max(ax, az); }
    else { face = 2; s = dir.x / az; edge = az - Math.max(ax, ay); }
    const strip = s < -1 / 3 ? 0 : s < 1 / 3 ? 1 : 2;
    c.copy(strip === 1 ? cols[(face + 1) % 3] : cols[face]);
    const seamD = Math.min(Math.abs(Math.abs(s) - 1 / 3) * 0.6, edge * 1.4);
    const k = 1 - THREE.MathUtils.smoothstep(seamD, 0.006, 0.02);
    c.lerp(seam, k * 0.55);
    c.convertLinearToSRGB();
    o[0] = c.r * 255; o[1] = c.g * 255; o[2] = c.b * 255;
  });
}

const band = (r, a, b, aa = 0.02) => THREE.MathUtils.smoothstep(r, a - aa, a + aa) * (1 - THREE.MathUtils.smoothstep(r, b - aa, b + aa));

/** Landing target: thick outer ring, dashed inner ring, centre dot, faint fill; dark rims for contrast. */
function targetTexture() {
  return dataTexture(128, 128, (u, v, o) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    const ang = Math.atan2(y, x);
    const ring = band(r, 0.8, 0.94);
    const rim = band(r, 0.75, 0.99) * (1 - ring);
    const dash = band(r, 0.5, 0.6) * (Math.sin(ang * 8) > -0.2 ? 1 : 0);
    const dot = 1 - THREE.MathUtils.smoothstep(r, 0.15, 0.19);
    const dotRim = band(r, 0.13, 0.24) * (1 - dot);
    const fill = r < 0.96 ? 0.18 : 0;
    const bright = Math.max(ring, dash, dot);
    const dark = Math.max(rim, dotRim) * 0.9;
    const a = Math.max(bright, dark, fill);
    const g = bright >= dark ? (bright > fill ? 255 : 255) : 70;
    o[0] = o[1] = o[2] = g;
    o[3] = Math.round(255 * Math.min(1, a));
  }, { srgb: false });
}

/** Aim reticle: ring with four inward ticks and a centre cross. */
function reticleTexture() {
  return dataTexture(128, 128, (u, v, o) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    const ring = band(r, 0.66, 0.78);
    const ax = Math.abs(x), ay = Math.abs(y);
    const ticks = (ax < 0.06 && ay > 0.4 && ay < 0.95) || (ay < 0.06 && ax > 0.4 && ax < 0.95) ? 1 : 0;
    const cross = (ax < 0.035 && ay < 0.16) || (ay < 0.035 && ax < 0.16) ? 1 : 0;
    const rim = band(r, 0.62, 0.82) * (1 - ring);
    const a = Math.max(ring, ticks, cross, rim * 0.8);
    const g = Math.max(ring, ticks, cross) >= rim * 0.8 ? 255 : 70;
    o[0] = o[1] = o[2] = g;
    o[3] = Math.round(255 * a);
  }, { srgb: false });
}
