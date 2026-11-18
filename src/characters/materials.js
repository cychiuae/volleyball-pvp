// Shared toon materials and geometries for characters. Everything here is cached at module
// level so four characters (and any rebuilds) share GPU resources.
import * as THREE from 'three';
import { PALETTE } from '../config.js';

let gradientMap = null;

/** 4-step toon ramp (soft pastel shadows). */
export function getGradientMap() {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([120, 175, 228, 255]);
  gradientMap = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

const toonCache = new Map();

export function toColor(c) {
  return c instanceof THREE.Color ? c.clone() : new THREE.Color(c);
}

/** Lighten/darken helper: lerp `color` toward `toward` by t. Returns a new Color (build-time only). */
export function tint(color, toward, t) {
  return toColor(color).lerp(toColor(toward), t);
}

// ---------------------------------------------------------------------------------------------
// Anime polish for the character toon materials, injected with onBeforeCompile (the toon
// shading is unchanged):
//   * cel rim light: two hard (anti-aliased) fresnel bands, warm white on the sun side and
//     tinted toward PALETTE.sky on the shadow side;
//   * stepped specular: a small crisp Blinn-Phong highlight (skin), and on hair an anime
//     "angel ring": a Kajiya-Kay style band along the strand direction (meridian tangent),
//     masked to the sun-facing arc so it reads as a glossy band around the head, not a dot.
// Every patched material compiles the SAME shader code under one customProgramCacheKey, so all
// characters share one program for each Three parameter set. Only the vec4 uCharFx is per material.
// ---------------------------------------------------------------------------------------------
const FX_KEY = 'cbv-char-toon-fx-v1';

// x = rim strength, y = spec strength, z = spec cutoff (cos of N.H), w = halo band strength
export const FX = {
  cloth: [0.4, 0.0, 1.1, 0.0],
  skin: [0.34, 0.08, 0.982, 0.0],
  hair: [0.3, 0.0, 1.1, 0.24],
};

const sharedFx = {
  uRimLit: { value: new THREE.Color('#fff2dc') },
  uRimShade: { value: new THREE.Color(PALETTE.sky).lerp(new THREE.Color('#ffffff'), 0.25) },
};

const FX_PARS = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform vec4 uCharFx;
uniform vec3 uRimLit;
uniform vec3 uRimShade;
float cbvStep( float edge, float x ) {
  float w = fwidth( x ) * 0.8 + 1e-4;
  return smoothstep( edge - w, edge + w, x );
}
`;

const FX_MAIN = /* glsl */`
{
  vec3 fxN = normalize( normal );
  vec3 fxV = normalize( vViewPosition );
  #if NUM_DIR_LIGHTS > 0
    vec3 fxL = directionalLights[ 0 ].direction;
  #else
    vec3 fxL = vec3( 0.0, 1.0, 0.0 );
  #endif
  float fxLit = cbvStep( 0.0, dot( fxN, fxL ) );
  // cel rim: soft outer band + thin bright core at the silhouette
  float fxFres = 1.0 - saturate( dot( fxN, fxV ) );
  float fxRim = cbvStep( 0.56, fxFres ) * 0.4 + cbvStep( 0.74, fxFres ) * 0.6;
  vec3 fxRimCol = mix( uRimShade, uRimLit, fxLit );
  // tint by the surface colour so the rim stays cel-like (no grey "glass" edge on dark hair)
  vec3 fxTint = 0.4 + 0.9 * diffuseColor.rgb;
  outgoingLight += fxRimCol * fxTint * ( fxRim * uCharFx.x * mix( 0.7, 1.0, fxLit ) );
  // stepped specular (sun side only)
  vec3 fxH = normalize( fxL + fxV );
  float fxNH = saturate( dot( fxN, fxH ) );
  float fxSpec = cbvStep( uCharFx.z, fxNH ) * uCharFx.y;
  // angel ring: band where the strand tangent (surface "up") is perpendicular to H
  vec3 fxUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 fxT = fxUp - fxN * dot( fxN, fxUp );
  float fxTl = length( fxT );
  fxT = fxTl > 1e-3 ? fxT / fxTl : fxUp;
  float fxBand = 1.0 - cbvStep( 0.075, abs( dot( fxT, fxH ) ) );
  float fxHalo = fxBand * cbvStep( 0.6, fxNH ) * uCharFx.w;
  outgoingLight += uRimLit * ( fxSpec * fxLit ) + uRimLit * fxTint * ( fxHalo * fxLit );
}
#include <opaque_fragment>
`;

function patchFragment(src) {
  return src
    .replace('#include <clipping_planes_pars_fragment>', FX_PARS)
    .replace('#include <opaque_fragment>', FX_MAIN);
}

function applyCharFx(mat, kind) {
  const p = FX[kind] || FX.cloth;
  const fx = { value: new THREE.Vector4(p[0], p[1], p[2], p[3]) };
  mat.userData.charFx = fx; // per-material uniform (tweakable at runtime)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCharFx = fx;
    shader.uniforms.uRimLit = sharedFx.uRimLit;
    shader.uniforms.uRimShade = sharedFx.uRimShade;
    shader.fragmentShader = patchFragment(shader.fragmentShader);
  };
  mat.customProgramCacheKey = () => FX_KEY;
  return mat;
}

/**
 * Cached MeshToonMaterial per color + side + kind ('cloth' | 'skin' | 'hair'), patched with
 * rim light and stepped specular.
 */
export function toonMat(color, side = THREE.FrontSide, kind = 'cloth') {
  const c = toColor(color);
  const key = c.getHexString() + '|' + side + '|' + kind;
  let m = toonCache.get(key);
  if (!m) {
    m = applyCharFx(new THREE.MeshToonMaterial({ color: c, gradientMap: getGradientMap(), side }), kind);
    toonCache.set(key, m);
  }
  return m;
}

let outline = null;
/** Inverted-hull outline material (shared). */
export function outlineMat() {
  if (!outline) {
    outline = new THREE.MeshBasicMaterial({ color: PALETTE.outline, side: THREE.BackSide });
  }
  return outline;
}

const geoCache = new Map();
/** Cached geometry by key; `make` runs once. */
export function geo(key, make) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/** Adds an inverted-hull outline child sharing the mesh's geometry. */
export function addOutline(mesh, scale = 1.06) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat());
  o.scale.setScalar(scale);
  o.castShadow = false;
  o.receiveShadow = false;
  o.name = 'outline';
  mesh.add(o);
  return o;
}

/** Mesh with castShadow on. */
export function solid(geometry, material, name) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = false;
  if (name) m.name = name;
  return m;
}
