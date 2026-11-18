// Message validation for the internet-facing WebSocket protocol (docs/NETWORK.md).
// parseMessage(raw) never throws: it returns either a clean, fully-typed message object or
// { error: 'badMsg', msg } describing why it was rejected. Nothing from the client is echoed
// except sanitised names and validated numbers.
import { REMOTE_ACTIONS } from './remoteInput.js';

export const MAX_MSG_BYTES = 4096;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O (and no digits: no 0, 1)
const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
const INPUT_ACTIONS = new Set([...REMOTE_ACTIONS, 'pause']); // 'pause' accepted but ignored online
const MAX_EDGES = 32;
const MAX_HELD = 16;

const bad = (msg) => ({ error: 'badMsg', msg });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Trim, strip non-printable characters, collapse whitespace, max 12 characters. '' if nothing left. */
export function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.slice(0, 200)
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')   // control, format, surrogates, private use, line/para separators
    .replace(/[<>]/g, '')                     // belt and braces for careless innerHTML consumers
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 12).join('').trim();
}

export function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (c.length !== 4) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/**
 * @param {string|Buffer|ArrayBuffer|Buffer[]} raw
 * @param {boolean} isBinary
 */
export function parseMessage(raw, isBinary = false) {
  if (isBinary) return bad('binary frames are not accepted');
  if (Buffer.isBuffer(raw) && raw.length > MAX_MSG_BYTES) return bad('message too large');
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (text === null) return bad('unreadable frame');
  if (text.length > MAX_MSG_BYTES || Buffer.byteLength(text, 'utf8') > MAX_MSG_BYTES) return bad('message too large');
  let m;
  try { m = JSON.parse(text); } catch { return bad('invalid JSON'); }
  if (!isObj(m) || typeof m.t !== 'string') return bad('missing type');

  switch (m.t) {
    case 'create':
      return { t: 'create', name: sanitizeName(m.name) };
    case 'join': {
      const code = normalizeCode(m.code);
      if (!code) return { error: 'noRoom', msg: 'room code must be 4 letters' };
      return { t: 'join', code, name: sanitizeName(m.name) };
    }
    case 'slot': {
      if (m.slot === null) return { t: 'slot', slot: null };
      if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot > 3) return bad('slot must be 0..3 or null');
      return { t: 'slot', slot: m.slot };
    }
    case 'start': {
      const d = m.difficulty === undefined ? 'normal' : m.difficulty;
      if (!DIFFICULTIES.has(d)) return bad('difficulty must be easy|normal|hard');
      return { t: 'start', difficulty: d };
    }
    case 'toLobby': return { t: 'toLobby' };
    case 'leave': return { t: 'leave' };
    case 'ping': {
      if (!finite(m.c)) return bad('ping needs a numeric c');
      return { t: 'ping', c: m.c };
    }
    case 'input': return parseInput(m);
    default: return bad('unknown message type');
  }
}

function parseInput(m) {
  if (!Number.isSafeInteger(m.seq) || m.seq < 0) return bad('input.seq must be a non-negative integer');
  let x = 0, y = 0;
  if (m.axis !== undefined) {
    if (!isObj(m.axis) || !finite(m.axis.x) || !finite(m.axis.y)) return bad('input.axis must be {x,y} numbers');
    x = Math.max(-1, Math.min(1, m.axis.x));
    y = Math.max(-1, Math.min(1, m.axis.y));
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
  }
  const held = [];
  if (m.held !== undefined) {
    if (!Array.isArray(m.held) || m.held.length > MAX_HELD) return bad('input.held must be a short array');
    for (const a of m.held) {
      if (typeof a !== 'string' || !INPUT_ACTIONS.has(a)) return bad('input.held: unknown action');
      if (a !== 'pause' && !held.includes(a)) held.push(a);
    }
  }
  const edges = [];
  if (m.edges !== undefined) {
    if (!Array.isArray(m.edges) || m.edges.length > MAX_EDGES) return bad('input.edges must be a short array');
    for (const e of m.edges) {
      if (!Array.isArray(e) || e.length !== 3) return bad('input.edges: [action, kind, viewTime]');
      const [a, kind, vt] = e;
      if (typeof a !== 'string' || !INPUT_ACTIONS.has(a)) return bad('input.edges: unknown action');
      if (kind !== 'down' && kind !== 'up') return bad('input.edges: kind must be down|up');
      if (!finite(vt) || vt < 0 || vt > 1e7) return bad('input.edges: viewTime must be a sim time');
      if (a !== 'pause') edges.push([a, kind, vt]);
    }
  }
  return { t: 'input', seq: m.seq, axis: { x, y }, held, edges };
}
