// Shared toon-shading helpers for src/render/*.
// - toonMaterial(color, opts): MeshToonMaterial with a small stepped gradient ramp.
// - addOutline(mesh, thickness, opts): cheap inverted-hull outline (child mesh, shares geometry).
// - dataTexture(w, h, fn): procedural RGBA texture that works without a DOM (Node-safe).
// - DecorBuilder: merges many small static parts into one vertex-colored geometry (1 draw call).
import * as THREE from 'three';
import { PALETTE } from '../config.js';

let rampTex = null;
/** Shared 4-step toon ramp (dark back, soft mid band, bright lit). */
export function toonRamp() {
  if (rampTex) return rampTex;
  const steps = [90, 150, 215, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  rampTex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  rampTex.minFilter = THREE.NearestFilter;
  rampTex.magFilter = THREE.NearestFilter;
  rampTex.generateMipmaps = false;
  rampTex.needsUpdate = true;
  return rampTex;
}

/**
 * MeshToonMaterial with the shared ramp.
 * opts: any MeshToonMaterial params (map, transparent, opacity, side, vertexColors, emissive...).
 */
export function toonMaterial(color = '#ffffff', opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...opts });
}

const outlineMats = new Map();
/**
 * Inverted-hull outline material: back faces pushed out along the normal by `thickness`
 * (in the mesh's local units). Works with instancing and fog. `extraVertex` (GLSL) is appended
 * after the displacement so animated meshes (e.g. swaying fronds) keep their hull in sync.
 */
export function outlineMaterial(thickness = 0.03, color = PALETTE.outline, extraVertex = '', uniforms = null) {
  const key = `${thickness}|${color}|${extraVertex}`;
  if (!extraVertex && outlineMats.has(key)) return outlineMats.get(key);
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  const t = thickness.toFixed(4);
  mat.onBeforeCompile = (shader) => {
    if (uniforms) Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `vec3 transformed = vec3( position ) + normalize( normal ) * ${t};\n${extraVertex}`,
    );
  };
  mat.customProgramCacheKey = () => `outline:${key}`;
  if (!extraVertex) outlineMats.set(key, mat);
  return mat;
}

/** Adds an inverted-hull outline as a child of `mesh` (shares its geometry). Returns the outline mesh. */
export function addOutline(mesh, thickness = 0.03, opts = {}) {
  const mat = opts.material || outlineMaterial(thickness, opts.color || PALETTE.outline);
  const outline = mesh.isInstancedMesh
    ? new THREE.InstancedMesh(mesh.geometry, mat, mesh.count)
    : new THREE.Mesh(mesh.geometry, mat);
  if (mesh.isInstancedMesh) outline.instanceMatrix = mesh.instanceMatrix;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.name = `${mesh.name || 'mesh'}-outline`;
  outline.raycast = () => {};
  mesh.add(outline);
  return outline;
}

/**
 * Procedural RGBA texture. fn(u, v, out) writes 0..255 into out[0..3] (u,v in 0..1).
 * Uses a DataTexture so it works in Node (no canvas) as well as the browser.
 */
export function dataTexture(w, h, fn, { repeat = false, srgb = true, mipmaps = true } = {}) {
  const data = new Uint8Array(w * h * 4);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn((x + 0.5) / w, (y + 0.5) / h, out, x, y);
      const i = (y * w + x) * 4;
      data[i] = out[0]; data[i + 1] = out[1]; data[i + 2] = out[2]; data[i + 3] = out[3];
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mipmaps;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

let blobTex = null;
/** Soft radial blob (white RGB, alpha falloff) for fake contact shadows. Tint via material color. */
export function blobTexture() {
  if (blobTex) return blobTex;
  blobTex = dataTexture(64, 64, (u, v, o) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.max(0, 1 - d);
    o[0] = o[1] = o[2] = 255;
    o[3] = Math.round(255 * Math.pow(a, 1.4) * Math.min(1, a * 3));
  }, { srgb: false });
  return blobTex;
}

// ---------------------------------------------------------------------------------------------
// Static decor merging

const _c = new THREE.Color();
const _v = new THREE.Vector3();

/**
 * Accumulates parts (geometry + color + transform) into a single non-indexed BufferGeometry
 * with position/normal/color(/sway) attributes. One draw call for an entire set of decor.
 */
export class DecorBuilder {
  constructor() { this.parts = []; this.vertexCount = 0; }

  /**
   * @param geo     BufferGeometry (not mutated)
   * @param color   color string/number, or fn(centroidLocal: Vector3, triIndex) -> color
   * @param matrix  Matrix4 placing the part
   * @param sway    0..1 sway weight (or fn(localPos) -> weight) for wind animation
   */
  add(geo, color, matrix, sway = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const pos = g.getAttribute('position');
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    const swayArr = new Float32Array(n);
    const cen = new THREE.Vector3();
    for (let t = 0; t < n; t += 3) {
      if (typeof color === 'function') {
        cen.set(0, 0, 0);
        for (let k = 0; k < 3; k++) cen.add(_v.fromBufferAttribute(pos, t + k));
        cen.multiplyScalar(1 / 3);
        _c.set(color(cen, t / 3));
      } else {
        _c.set(color);
      }
      for (let k = 0; k < 3; k++) {
        colors.set([_c.r, _c.g, _c.b], (t + k) * 3);
        if (typeof sway === 'function') swayArr[t + k] = sway(_v.fromBufferAttribute(pos, t + k));
        else swayArr[t + k] = sway;
      }
    }
    if (matrix) g.applyMatrix4(matrix);
    this.parts.push({ pos: g.getAttribute('position').array, nor: g.getAttribute('normal').array, colors, swayArr });
    this.vertexCount += n;
    g.dispose();
    return this;
  }

  build() {
    const n = this.vertexCount;
    const position = new Float32Array(n * 3);
    const normal = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const sway = new Float32Array(n);
    let o = 0;
    for (const p of this.parts) {
      position.set(p.pos, o * 3);
      normal.set(p.nor, o * 3);
      color.set(p.colors, o * 3);
      sway.set(p.swayArr, o);
      o += p.swayArr.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.parts = [];
    return g;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
/** Matrix helper: m(x,y,z, rx,ry,rz, sx,sy,sz). Returns a fresh Matrix4. */
export function mat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}
/** Compose parent * child matrices without mutating either. */
export function mul(a, b) { return _m.multiplyMatrices(a, b).clone(); }

/** Tiny deterministic PRNG so decor placement is stable between reloads. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 2D (for textures / vertex colors). `period` > 0 makes it tile. */
export function valueNoise2(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a, b) => {
    if (period) { a = ((a % period) + period) % period; b = ((b % period) + period) % period; }
    let n = (a * 374761393 + b * 668265263 + seed * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// ---------------------------------------------------------------------------------------------
// Glow level (set by stage.setQuality): 0 = direct render (no bloom), 1 = bloom on.
// Emissive-ish things (sun disc, ocean sparkles, VFX stars/sparks/confetti) push their colour
// into HDR only when bloom is on, so the 'low' path looks exactly like before.

const glowListeners = new Set();
let glowLevel = 0;
/** fn(level) is called now and whenever the level changes. Returns an unsubscribe function. */
export function registerGlow(fn) {
  glowListeners.add(fn);
  fn(glowLevel);
  return () => glowListeners.delete(fn);
}
export function setGlowLevel(level) {
  if (level === glowLevel) return;
  glowLevel = level;
  for (const fn of glowListeners) fn(level);
}
export function getGlowLevel() { return glowLevel; }
