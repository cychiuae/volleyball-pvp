// Builds the chibi model + rig from primitives. Dimensions are authored for a 1.30 m
// character (feet at y = 0); character.js scales the rig to PLAYER.height.
import * as THREE from 'three';
import { geo, toonMat, addOutline, solid, tint } from './materials.js';
import { getFaceMaterials, getNumberMaterial, FACE, FACE_PATCH } from './textures.js';

const PI = Math.PI;

// ---- rig dimensions (meters, authored height 1.30) ----
export const DIM = {
  height: 1.3,
  hipY: 0.36,          // hips group height
  hipJoint: -0.03,     // leg joints below hips
  legX: 0.085,
  thigh: 0.13,         // hip joint -> knee
  shin: 0.155,         // knee -> ankle
  ankleY: 0.045,       // ankle height above the sand at rest
  shoulderX: 0.175,
  shoulderY: 0.27,     // above hips (torso local)
  upperArm: 0.135,
  forearmCenter: 0.05,
  handY: 0.125,        // elbow -> hand center
  neckY: 0.38,         // above hips (torso local)
};

const unitSphere = () => geo('unitSphere', () => new THREE.SphereGeometry(1, 14, 10));
const headGeo = () => geo('head', () => new THREE.SphereGeometry(1, 22, 16));
const bodyGeo = () => geo('body', () => new THREE.SphereGeometry(1, 18, 12));

function capsule(key, r, len) {
  return geo(key, () => new THREE.CapsuleGeometry(r, len, 3, 8));
}

function setCast(mesh, on) {
  mesh.castShadow = on;
  return mesh;
}

// ---------------- hair ----------------
function buildHair(head, look, teamColor, parts) {
  const hairMat = toonMat(look.hair || '#5b3a29', THREE.FrontSide, 'hair');
  const style = look.hairStyle;
  const isBob = style === 'bob';
  const capGeo = isBob
    ? geo('hairBob', () => new THREE.SphereGeometry(1.08, 20, 10, 0, PI * 2, 0, PI * 0.62))
    : geo('hairCap', () => new THREE.SphereGeometry(1.07, 20, 10, 0, PI * 2, 0, PI / 2 + 0.1));
  const cap = solid(capGeo, hairMat, 'hairCap');
  cap.rotation.x = isBob ? -0.85 : -0.45; // tilt back: hairline up front, longer at the nape
  addOutline(cap, 1.035);
  head.add(cap);

  if (style === 'bun') {
    const bun = solid(unitSphere(), hairMat, 'bun');
    bun.scale.setScalar(0.37);
    bun.position.set(0, 0.92, -0.42);
    head.add(bun);
    parts.bun = bun;
  } else if (style === 'spiky') {
    const coneGeo = geo('spike', () => {
      const g = new THREE.ConeGeometry(0.24, 0.72, 5);
      g.translate(0, 0.36, 0);
      return g;
    });
    const up = new THREE.Vector3(0, 1, 0);
    const dirs = [
      // flicks out at the sides and nape (visible under a cap), plus a crown tuft
      [0.97, 0.05, -0.2], [-0.97, 0.05, -0.2], [0.6, -0.35, -0.72], [-0.6, -0.35, -0.72],
      [0, -0.45, -0.89], [0.15, 0.95, -0.25],
    ];
    for (const d of dirs) {
      if (look.accessory === 'cap' && d[1] > 0.5) continue; // crown tuft would poke through the cap
      const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
      const s = solid(coneGeo, hairMat, 'spike');
      s.quaternion.setFromUnitVectors(up, dir);
      s.position.copy(dir).multiplyScalar(0.84);
      head.add(s);
    }
  } else if (style === 'pigtails') {
    const tieMat = toonMat(teamColor);
    for (const side of [1, -1]) {
      const g = new THREE.Group();
      g.position.set(side * 0.86, 0.3, -0.3);
      g.rotation.z = side * 0.25;
      const tie = setCast(solid(unitSphere(), tieMat, 'tie'), false);
      tie.scale.setScalar(0.14);
      const tail = solid(unitSphere(), hairMat, 'pigtail');
      tail.scale.set(0.3, 0.46, 0.3);
      tail.position.set(side * 0.1, -0.4, 0);
      g.add(tail, tie);
      head.add(g);
      parts.pigtails.push({ group: g, side });
    }
  }
}

// ---------------- accessories ----------------
function brimGeo() {
  return geo('brim', () => {
    // pie-slice disc centred on +Z (cylinder theta 0 points at +Z)
    return new THREE.CylinderGeometry(1, 1, 1, 18, 1, false, -1.1, 2.2);
  });
}

function buildAccessory(head, look, teamColor) {
  const acc = look.accessory;
  const team = toonMat(teamColor);
  if (acc === 'headband') {
    const band = solid(geo('headband', () => new THREE.TorusGeometry(1, 0.075, 6, 28)), team, 'headband');
    band.rotation.x = -PI / 2 - 0.45;
    band.position.set(0, 0.9 * 0.3, -0.435 * 0.3);
    band.scale.setScalar(1.035);
    head.add(band);
  } else if (acc === 'cap') {
    const dome = solid(geo('capDome', () => new THREE.SphereGeometry(1.13, 18, 8, 0, PI * 2, 0, PI / 2 - 0.2)), team, 'capDome');
    dome.rotation.x = -0.35;
    addOutline(dome, 1.03);
    head.add(dome);
    const brim = solid(brimGeo(), toonMat('#ffffff'), 'capBrim');
    brim.scale.set(1.0, 0.06, 1.55);
    brim.position.set(0, 0.57, 0.02);
    brim.rotation.x = 0.06;
    head.add(brim);
  } else if (acc === 'visor') {
    const band = solid(
      geo('visorBand', () => new THREE.CylinderGeometry(1.09, 1.09, 0.24, 22, 1, true)),
      toonMat('#ffffff', THREE.DoubleSide), 'visorBand',
    );
    band.rotation.x = -0.45;
    band.position.set(0, 0.9 * 0.36, -0.435 * 0.36);
    head.add(band);
    const brim = solid(brimGeo(), toonMat(tint(teamColor, '#ffffff', 0.1)), 'visorBrim');
    brim.scale.set(1.0, 0.06, 1.45);
    brim.position.set(0, 0.66, 0.0);
    brim.rotation.x = 0.16;
    head.add(brim);
  }
}

// ---------------- limbs ----------------
function buildArm(torso, side, skinMat) {
  const shoulder = new THREE.Group();
  shoulder.name = side > 0 ? 'shoulderL' : 'shoulderR';
  shoulder.position.set(side * DIM.shoulderX, DIM.shoulderY, 0);
  const upper = solid(capsule('upperArm', 0.047, 0.08), skinMat, 'upperArm');
  upper.position.y = -DIM.upperArm / 2;
  const elbow = new THREE.Group();
  elbow.position.y = -DIM.upperArm;
  const fore = solid(capsule('forearm', 0.043, 0.06), skinMat, 'forearm');
  fore.position.y = -DIM.forearmCenter;
  const hand = solid(unitSphere(), skinMat, 'hand');
  hand.scale.setScalar(0.058);
  hand.position.y = -DIM.handY;
  addOutline(hand, 1.13);
  elbow.add(fore, hand);
  shoulder.add(upper, elbow);
  torso.add(shoulder);
  return { shoulder, upper, elbow, fore, hand, side };
}

function buildLeg(hips, side, skinMat, shortsMat) {
  const hip = new THREE.Group();
  hip.name = side > 0 ? 'hipL' : 'hipR';
  hip.position.set(side * DIM.legX, DIM.hipJoint, 0);
  const thigh = solid(capsule('thigh', 0.07, 0.05), shortsMat, 'thigh'); // shorts leg
  thigh.position.y = -0.05;
  const knee = new THREE.Group();
  knee.position.y = -DIM.thigh;
  const shin = solid(capsule('shin', 0.054, 0.09), skinMat, 'shin');
  shin.position.y = -0.065;
  const ankle = new THREE.Group();
  ankle.position.y = -DIM.shin;
  const foot = solid(unitSphere(), skinMat, 'foot');
  foot.scale.set(0.062, 0.042, 0.092);
  foot.position.set(0, -0.003, 0.03);
  addOutline(foot, 1.12);
  ankle.add(foot);
  knee.add(shin, ankle);
  hip.add(thigh, knee);
  hips.add(hip);
  return { hip, knee, ankle, foot, side };
}

/**
 * Builds the model. Returns rig parts for animation.
 * Hierarchy: root > rig > hips > { shorts, torso > { body, neck > head, shoulderL/R > elbow }, hipL/R > knee > ankle }
 */
export function buildModel(look, teamColor, number) {
  const skinMat = toonMat(look.skin || '#ffe0c7', THREE.FrontSide, 'skin');
  const shirtMat = toonMat(look.shirt || teamColor);
  const shortsMat = toonMat(look.shorts || '#ffffff');

  const root = new THREE.Group();
  root.name = 'character:' + (look.name || '?');
  const rig = new THREE.Group();
  rig.name = 'rig';
  root.add(rig);

  const hips = new THREE.Group();
  hips.name = 'hips';
  hips.position.y = DIM.hipY;
  rig.add(hips);

  const shorts = solid(
    geo('shorts', () => new THREE.CylinderGeometry(0.88, 1, 1, 16, 1)),
    shortsMat, 'shorts',
  );
  shorts.scale.set(0.185, 0.12, 0.165);
  shorts.position.y = 0.0;
  addOutline(shorts, 1.06);
  hips.add(shorts);

  const torso = new THREE.Group();
  torso.name = 'torso';
  hips.add(torso);

  const body = solid(bodyGeo(), shirtMat, 'jersey');
  body.scale.set(0.2, 0.215, 0.18);
  body.position.y = 0.19;
  addOutline(body, 1.07);
  torso.add(body);

  // jersey numbers: big on the back (team 0 is seen from behind), smaller on the chest
  const numMat = getNumberMaterial(number);
  if (numMat) {
    const back = new THREE.Mesh(
      geo('numBack', () => new THREE.SphereGeometry(1.012, 12, 10, 1.5 * PI - 0.72, 1.44, 0.92, 1.2)),
      numMat,
    );
    back.name = 'numberBack';
    const front = new THREE.Mesh(
      geo('numFront', () => new THREE.SphereGeometry(1.012, 10, 8, 0.5 * PI - 0.45, 0.9, 1.02, 0.85)),
      numMat,
    );
    front.name = 'numberFront';
    body.add(back, front);
  }

  const neck = new THREE.Group();
  neck.name = 'neck';
  neck.position.set(0, DIM.neckY, 0);
  torso.add(neck);

  const head = solid(headGeo(), skinMat, 'head');
  head.scale.set(0.285, 0.265, 0.27);
  head.position.set(0, 0.265, 0.01);
  addOutline(head, 1.05);
  neck.add(head);

  let face = null;
  const faceMats = getFaceMaterials();
  if (faceMats) {
    face = new THREE.Mesh(
      geo('face', () => new THREE.SphereGeometry(
        1.012, 18, 12, PI / 2 - FACE_PATCH.phiLength / 2, FACE_PATCH.phiLength,
        FACE_PATCH.thetaStart, FACE_PATCH.thetaLength,
      )),
      faceMats[FACE.NORMAL],
    );
    face.name = 'face';
    face.renderOrder = 1;
    head.add(face);
  }

  const parts = { pigtails: [], bun: null };
  buildHair(head, look, teamColor, parts);
  buildAccessory(head, look, teamColor);

  const armL = buildArm(torso, 1, skinMat);
  const armR = buildArm(torso, -1, skinMat);
  const legL = buildLeg(hips, 1, skinMat, shortsMat);
  const legR = buildLeg(hips, -1, skinMat, shortsMat);

  return {
    root, rig, hips, torso, body, neck, head, face, faceMats,
    armL, armR, legL, legR,
    pigtails: parts.pigtails, bun: parts.bun,
  };
}
