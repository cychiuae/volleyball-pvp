// Procedural CanvasTextures for faces (one shared set of expressions) and jersey numbers.
// When no canvas is available (Node smoke tests), getters return null and the character
// simply skips the decals.
import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { getGradientMap } from './materials.js';

export const FACE = { NORMAL: 0, BLINK: 1, HAPPY: 2, SAD: 3, DETERMINED: 4, EFFORT: 5 };
const FACE_COUNT = 6;

// Face decal = sphere patch on the (unit) head. u spans phi, v spans theta.
// Canvas 256x160 maps to ~103deg wide x ~63deg tall: y=0 is +33deg elevation, y=160 is -30deg.
export const FACE_PATCH = { phiLength: 1.8, thetaStart: 1.0, thetaLength: 1.1 };
const W = 256;
const H = 160;
const EYE_L = 74;
const EYE_R = 182;
const EYE_Y = 76;
const INK = PALETTE.outline;
const IRIS = '#7b4fa0';
const BLUSH = 'rgba(255,120,150,0.5)';

export function makeCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch (_) { /* no canvas available */ }
  return null;
}

function make2d(w, h) {
  const canvas = makeCanvas(w, h);
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function decalMaterial(map) {
  return new THREE.MeshToonMaterial({
    map,
    gradientMap: getGradientMap(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

// ---------- face drawing ----------
function ellipse(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}

function blush(ctx, strong) {
  ctx.fillStyle = strong ? 'rgba(255,105,140,0.62)' : BLUSH;
  ellipse(ctx, 34, 110, 23, 12); ctx.fill();
  ellipse(ctx, 222, 110, 23, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(240,80,120,0.55)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (const cx of [34, 222]) {
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 9 + 3, 104);
      ctx.lineTo(cx + i * 9 - 3, 115);
      ctx.stroke();
    }
  }
}

function openEye(ctx, cx, cy, outer, opts = {}) {
  const rx = 19;
  const ry = opts.ry ?? 25;
  ctx.fillStyle = INK;
  ellipse(ctx, cx, cy, rx, ry); ctx.fill();
  // iris glow in the lower half
  ctx.save();
  ellipse(ctx, cx, cy, rx - 3, ry - 3); ctx.clip();
  const g = ctx.createLinearGradient(0, cy - ry * 0.2, 0, cy + ry);
  g.addColorStop(0, 'rgba(123,79,160,0)');
  g.addColorStop(1, IRIS);
  ctx.fillStyle = g;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  if (opts.teary) {
    ctx.fillStyle = 'rgba(160,220,255,0.75)';
    ellipse(ctx, cx, cy + ry * 0.75, rx, ry * 0.32); ctx.fill();
  }
  ctx.restore();
  // glossy highlights
  ctx.fillStyle = '#ffffff';
  const big = opts.teary ? 9.5 : 7.5;
  ellipse(ctx, cx + 6, cy - 10, big, big + 1); ctx.fill();
  ellipse(ctx, cx - 7, cy + 10, 3.6, 3.6); ctx.fill();
  if (opts.teary) { ellipse(ctx, cx + 9, cy + 6, 2.6, 2.6); ctx.fill(); }
  // tiny lash flick at the outer corner
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + outer * 15, cy - 17);
  ctx.lineTo(cx + outer * 23, cy - 22);
  ctx.stroke();
}

function smile(ctx) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(128, 114, 9, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

function drawFace(ctx, kind) {
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (kind) {
    case FACE.NORMAL:
      blush(ctx, false);
      openEye(ctx, EYE_L, EYE_Y, -1);
      openEye(ctx, EYE_R, EYE_Y, 1);
      smile(ctx);
      break;
    case FACE.BLINK:
      blush(ctx, false);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      for (const cx of [EYE_L, EYE_R]) {
        ctx.beginPath();
        ctx.arc(cx, EYE_Y - 6, 18, 0.12 * Math.PI, 0.88 * Math.PI);
        ctx.stroke();
      }
      smile(ctx);
      break;
    case FACE.HAPPY: {
      blush(ctx, true);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6.5;
      for (const cx of [EYE_L, EYE_R]) {
        ctx.beginPath();
        ctx.moveTo(cx - 17, EYE_Y + 8);
        ctx.lineTo(cx, EYE_Y - 10);
        ctx.lineTo(cx + 17, EYE_Y + 8);
        ctx.stroke();
      }
      // big open "D" smile with a tongue
      ctx.beginPath();
      ctx.moveTo(114, 108);
      ctx.lineTo(142, 108);
      ctx.arc(128, 108, 14, 0, Math.PI);
      ctx.closePath();
      ctx.fillStyle = '#c93d5c';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = '#ff8fa3';
      ellipse(ctx, 128, 124, 9, 6); ctx.fill();
      ctx.restore();
      ctx.lineWidth = 3.5;
      ctx.stroke();
      break;
    }
    case FACE.SAD: {
      blush(ctx, false);
      openEye(ctx, EYE_L, EYE_Y + 3, -1, { ry: 22, teary: true });
      openEye(ctx, EYE_R, EYE_Y + 3, 1, { ry: 22, teary: true });
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      // worried brows: inner ends raised
      ctx.beginPath(); ctx.moveTo(54, 50); ctx.lineTo(94, 39); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(162, 39); ctx.lineTo(202, 50); ctx.stroke();
      // wobbly frown
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(128, 130, 10, 1.15 * Math.PI, 1.85 * Math.PI);
      ctx.stroke();
      // tear drop
      ctx.fillStyle = 'rgba(120,200,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(EYE_R + 12, EYE_Y + 22);
      ctx.quadraticCurveTo(EYE_R + 20, EYE_Y + 38, EYE_R + 12, EYE_Y + 42);
      ctx.quadraticCurveTo(EYE_R + 4, EYE_Y + 38, EYE_R + 12, EYE_Y + 22);
      ctx.fill();
      break;
    }
    case FACE.DETERMINED: {
      blush(ctx, false);
      openEye(ctx, EYE_L, EYE_Y + 2, -1, { ry: 22 });
      openEye(ctx, EYE_R, EYE_Y + 2, 1, { ry: 22 });
      // cut a slanted upper lid (inner side lower) -> fierce look
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(EYE_L - 28, EYE_Y - 40); ctx.lineTo(EYE_L + 28, EYE_Y - 40);
      ctx.lineTo(EYE_L + 28, EYE_Y - 4); ctx.lineTo(EYE_L - 28, EYE_Y - 17);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(EYE_R - 28, EYE_Y - 40); ctx.lineTo(EYE_R + 28, EYE_Y - 40);
      ctx.lineTo(EYE_R + 28, EYE_Y - 17); ctx.lineTo(EYE_R - 28, EYE_Y - 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(EYE_L - 22, EYE_Y - 24); ctx.lineTo(EYE_L + 22, EYE_Y - 11); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(EYE_R - 22, EYE_Y - 11); ctx.lineTo(EYE_R + 22, EYE_Y - 24); ctx.stroke();
      // set jaw: small open shout
      ctx.fillStyle = '#c93d5c';
      ctx.beginPath();
      ctx.moveTo(119, 116); ctx.lineTo(137, 116);
      ctx.quadraticCurveTo(128, 130, 119, 116);
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.stroke();
      break;
    }
    case FACE.EFFORT: {
      blush(ctx, true);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6.5;
      ctx.beginPath(); // ">"
      ctx.moveTo(EYE_L - 14, EYE_Y - 14); ctx.lineTo(EYE_L + 12, EYE_Y); ctx.lineTo(EYE_L - 14, EYE_Y + 14);
      ctx.stroke();
      ctx.beginPath(); // "<"
      ctx.moveTo(EYE_R + 14, EYE_Y - 14); ctx.lineTo(EYE_R - 12, EYE_Y); ctx.lineTo(EYE_R + 14, EYE_Y + 14);
      ctx.stroke();
      ctx.fillStyle = '#c93d5c';
      ellipse(ctx, 128, 120, 8, 10); ctx.fill();
      ctx.lineWidth = 3.5; ctx.stroke();
      // sweat drop
      ctx.fillStyle = 'rgba(140,210,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(232, 30);
      ctx.quadraticCurveTo(242, 48, 232, 52);
      ctx.quadraticCurveTo(222, 48, 232, 30);
      ctx.fill();
      break;
    }
    default:
      break;
  }
}

let faceMaterials; // undefined = not built yet, null = no canvas

/** Array of materials indexed by FACE.*, or null when no canvas is available. */
export function getFaceMaterials() {
  if (faceMaterials !== undefined) return faceMaterials;
  faceMaterials = null;
  const mats = [];
  for (let i = 0; i < FACE_COUNT; i++) {
    const c = make2d(W, H);
    if (!c) return null;
    drawFace(c.ctx, i);
    mats.push(decalMaterial(toTexture(c.canvas)));
  }
  faceMaterials = mats;
  return mats;
}

const numberMaterials = new Map();

/** Jersey number decal material (white digits, outline-colored stroke), or null without canvas. */
export function getNumberMaterial(n) {
  if (numberMaterials.has(n)) return numberMaterials.get(n);
  const c = make2d(128, 128);
  let mat = null;
  if (c) {
    const { ctx } = c;
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = 'bold 96px "Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = INK;
    ctx.strokeText(String(n), 64, 70);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(n), 64, 70);
    mat = decalMaterial(toTexture(c.canvas));
  }
  numberMaterials.set(n, mat);
  return mat;
}
