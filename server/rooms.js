// Rooms, lobby rules and the authoritative game loop (docs/NETWORK.md).
// Transport-agnostic: index.js hands us a `send(string)` per client; tests can drive it directly.
import { randomInt } from 'node:crypto';
import { NET } from '../src/config.js';
import { createEventBus } from '../src/core/events.js';
import { createGame } from '../src/game/game.js';
import { createNullInput } from '../src/game/input.js';
import { encodeEventPayload, encodeSnapshot } from '../src/net/snapshot.js';
import { CODE_ALPHABET } from './protocol.js';
import { createRemoteInput } from './remoteInput.js';

export const LIMITS = {
  maxRooms: 200,
  clientsPerRoom: NET.maxPlayers,
  idleRoomMs: 30 * 60 * 1000,
  rateMsgsPerSec: 120,
  rateBurst: 120,
  floodKickDrops: 2000,       // dropped messages within floodWindowMs before the socket is closed
  floodWindowMs: 10000,
};
const SLOT_CHANGE_PHASES = new Set(['serve', 'point', 'matchOver']);

/**
 * @param {{ timeScale?: number, now?: () => number, log?: (...a) => void }} [opts]
 *   timeScale: sim seconds per real second (tests run matches fast); snapshots stay at real-time rate.
 */
export function createLobby({ timeScale = 1, now = () => Date.now(), log = () => {} } = {}) {
  const rooms = new Map();      // code -> room
  let nextClientId = 1;
  const snapPeriod = 1 / NET.snapshotHz;

  // ------------------------------------------------------------ clients
  function connect(send, { onKick } = {}) {
    const c = {
      id: `c${nextClientId++}`,
      name: '',
      room: null,
      slot: null,
      pending: undefined,       // queued slot request mid-rally: 0..3 | null (leave) | undefined (none)
      joinedAt: 0,
      input: createRemoteInput(),
      ping: 0,
      tokens: LIMITS.rateBurst,
      lastRefill: now(),
      drops: 0,
      dropWindowStart: now(),
      lastRateErr: 0,
      bytes: { snap: 0, ev: 0, room: 0, other: 0 },
      msgs: { snap: 0, ev: 0, room: 0, other: 0 },
      sendRaw: send,
      onKick: onKick || (() => {}),
    };
    return c;
  }

  function sendTo(c, str, kind = 'other') {
    c.bytes[kind] += str.length;
    c.msgs[kind]++;
    try { c.sendRaw(str); } catch (err) { log('send failed', err && err.message); }
  }
  const sendObj = (c, obj, kind) => sendTo(c, JSON.stringify(obj), kind);
  const sendError = (c, code, msg) => sendObj(c, { t: 'error', code, msg });

  /** Token bucket: true if the message may be processed. */
  function allow(c) {
    const t = now();
    c.tokens = Math.min(LIMITS.rateBurst, c.tokens + ((t - c.lastRefill) / 1000) * LIMITS.rateMsgsPerSec);
    c.lastRefill = t;
    if (c.tokens >= 1) { c.tokens -= 1; return true; }
    if (t - c.dropWindowStart > LIMITS.floodWindowMs) { c.dropWindowStart = t; c.drops = 0; }
    c.drops++;
    if (t - c.lastRateErr > 1000) { c.lastRateErr = t; sendError(c, 'rateLimit', 'too many messages'); }
    if (c.drops > LIMITS.floodKickDrops) c.onKick('flood');
    return false;
  }

  // ------------------------------------------------------------ rooms
  function newCode() {
    for (let tries = 0; tries < 1000; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function createRoom(owner) {
    const code = newCode();
    if (!code) return null;
    const room = {
      code,
      clients: [],
      owner: owner.id,
      slots: [null, null, null, null],
      phase: 'lobby',
      difficulty: 'normal',
      game: null,
      bus: null,
      legacyInputs: false,
      m: 0,
      joinCount: 0,
      lastActive: now(),
      namesDirty: true,
      snapAcc: 0,
      snapCount: 0,
      lastPingBroadcast: 0,
    };
    rooms.set(code, room);
    return room;
  }

  function roomView(room, c) {
    return {
      code: room.code,
      you: c.id,
      owner: room.owner,
      clients: room.clients.map((x) => {
        const o = { id: x.id, name: x.name, slot: x.slot, ping: Math.round(x.ping) };
        if (x.pending !== undefined) o.pending = x.pending;
        return o;
      }),
      slots: room.slots.map((x) => (x ? x.id : null)),
      phase: room.phase,
      difficulty: room.difficulty,
    };
  }
  function broadcastRoom(room) {
    for (const c of room.clients) sendObj(c, { t: 'room', room: roomView(room, c) }, 'room');
  }
  function broadcast(room, str, kind) {
    for (const c of room.clients) sendTo(c, str, kind);
  }

  function addToRoom(room, c, name) {
    room.joinCount++;
    c.name = name || `Player ${room.joinCount}`;
    c.room = room;
    c.slot = null;
    c.pending = undefined;
    c.joinedAt = now();
    c.input.reset();
    // Lag compensation: viewTimes are bounded to [now - NET.maxRewind, now] of this room's sim.
    c.input.setClock(() => (room.game ? room.game.state.time : null), NET.maxRewind);
    room.clients.push(c);
    room.namesDirty = true;
    room.lastActive = now();
  }

  function setSlot(room, c, slot) {
    if (c.slot !== null) room.slots[c.slot] = null;
    c.slot = slot;
    c.pending = undefined;
    c.input.reset();
    if (slot !== null) room.slots[slot] = c;
    room.namesDirty = true;
    if (room.game) applyInputs(room);
  }

  const lowestFreeSlot = (room) => room.slots.indexOf(null);

  function leaveRoom(c, { notify = true } = {}) {
    const room = c.room;
    if (!room) return;
    if (c.slot !== null) room.slots[c.slot] = null;
    c.slot = null;
    c.pending = undefined;
    c.input.reset();
    c.room = null;
    room.clients = room.clients.filter((x) => x !== c);
    if (notify) sendObj(c, { t: 'room', room: null }, 'room');
    if (room.clients.length === 0) {
      deleteRoom(room);
      return;
    }
    if (room.owner === c.id) room.owner = room.clients[0].id; // oldest remaining client
    room.namesDirty = true;
    if (room.game) applyInputs(room);
    broadcastRoom(room);
  }

  function deleteRoom(room, reason) {
    rooms.delete(room.code);
    if (room.game) endGame(room, { emitMenu: false });
    for (const c of room.clients) {
      c.room = null; c.slot = null; c.pending = undefined; c.input.reset();
      if (reason) sendError(c, 'noRoom', reason);
      sendObj(c, { t: 'room', room: null }, 'room');
    }
    room.clients = [];
    log(`room ${room.code} deleted${reason ? ` (${reason})` : ''}`);
  }

  // ------------------------------------------------------------ game
  function inputsFor(room) {
    return room.slots.map((c) => (c ? c.input : null));
  }

  function applyInputs(room) {
    if (!room.game) return;
    if (!room.legacyInputs) room.game.setInputs(inputsFor(room));
    // Legacy game (single `input` for player 0): the proxy below reads room.slots[0] live.
  }

  function makeGame(room) {
    const bus = createEventBus();
    const emit = bus.emit;
    bus.emit = (name, payload) => {
      forwardEvent(room, name, payload);
      emit(name, payload);
    };
    room.bus = bus;
    let game = createGame({ events: bus, inputs: inputsFor(room), allowPause: false });
    room.legacyInputs = typeof game.setInputs !== 'function';
    if (room.legacyInputs) {
      // src/game predates multi-human input: drive player 0 from whoever holds slot 0.
      const nul = createNullInput();
      const cur = () => (room.slots[0] ? room.slots[0].input : nul);
      const proxy = {
        poll: () => cur().poll(), held: (a) => cur().held(a), pressed: (a) => cur().pressed(a),
        released: (a) => cur().released(a), axis: () => cur().axis(),
        edgeTime: (a) => (cur().edgeTime ? cur().edgeTime(a) : undefined), dispose() {},
      };
      game = createGame({ events: bus, input: proxy });
    }
    room.game = game;
    return game;
  }

  function forwardEvent(room, name, payload) {
    if (!room.game) return;
    const { p, v } = encodeEventPayload(payload);
    const msg = { t: 'ev', name, p, m: room.m, st: Math.round(room.game.state.time * 1000) };
    if (v) msg.v = v;
    broadcast(room, JSON.stringify(msg), 'ev');
  }

  function endGame(room, { emitMenu = true } = {}) {
    const g = room.game;
    if (!g) return;
    if (emitMenu) { try { g.toMenu(); } catch (err) { log('toMenu threw', err); } }
    room.game = null;
    room.bus = null;
    room.phase = 'lobby';
    for (const c of room.clients) c.input.reset();
  }

  function startMatch(room, difficulty) {
    // Queued slot requests are honoured before the serve.
    for (const c of room.clients) if (c.pending !== undefined) applyPending(room, c);
    room.difficulty = difficulty;
    if (!room.game) makeGame(room);
    for (const c of room.clients) c.input.reset();
    applyInputs(room);
    room.phase = 'playing';
    room.m++;
    room.namesDirty = true;
    room.snapAcc = snapPeriod; // snapshot on the next tick
    room.game.startMatch({ difficulty });
  }

  function applyPending(room, c) {
    const want = c.pending;
    c.pending = undefined;
    if (want === undefined) return true;
    if (want !== null && room.slots[want] && room.slots[want] !== c) {
      sendError(c, 'slotTaken', 'that slot was taken');
      return false;
    }
    setSlot(room, c, want);
    return true;
  }

  function sendSnapshot(room) {
    const g = room.game;
    room.snapCount++;
    const withNames = room.namesDirty || room.snapCount % NET.snapshotHz === 0;
    room.namesDirty = false;
    const s = encodeSnapshot(g.state, {
      m: room.m,
      humans: room.slots.map((c) => !!c),
      names: withNames ? room.slots.map((c) => (c ? c.name : null)) : null,
    });
    broadcast(room, JSON.stringify({ t: 'snap', s }), 'snap');
  }

  // ------------------------------------------------------------ message handling
  function handle(c, msg) {
    if (msg.error) { sendError(c, msg.error, msg.msg); return; }
    const room = c.room;
    if (room && msg.t !== 'ping' && msg.t !== 'input') room.lastActive = now();
    switch (msg.t) {
      case 'create': {
        if (room) leaveRoom(c, { notify: false });
        if (rooms.size >= LIMITS.maxRooms) { sendError(c, 'full', 'server is full, try again later'); sendObj(c, { t: 'room', room: null }, 'room'); return; }
        const r = createRoom(c);
        if (!r) { sendError(c, 'full', 'no free room codes'); return; }
        addToRoom(r, c, msg.name);
        setSlot(r, c, 0);
        log(`room ${r.code} created by ${c.id}`);
        broadcastRoom(r);
        return;
      }
      case 'join': {
        const r = rooms.get(msg.code);
        if (!r) { sendError(c, 'noRoom', 'no room with that code'); return; }
        if (r === room) { broadcastRoom(r); return; }
        if (r.clients.length >= LIMITS.clientsPerRoom) { sendError(c, 'full', 'that room is full'); return; }
        if (room) leaveRoom(c, { notify: false });
        addToRoom(r, c, msg.name);
        if (r.phase === 'lobby') {
          const free = lowestFreeSlot(r);
          if (free >= 0) setSlot(r, c, free);
        }
        broadcastRoom(r);
        return;
      }
      case 'slot': {
        if (!room) { sendError(c, 'noRoom', 'not in a room'); return; }
        const want = msg.slot;
        if (want !== null && room.slots[want] && room.slots[want] !== c) { sendError(c, 'slotTaken', 'that slot is taken'); return; }
        if (want === c.slot) {
          if (c.pending !== undefined) { c.pending = undefined; broadcastRoom(room); }
          return;
        }
        if (room.game && !SLOT_CHANGE_PHASES.has(room.game.state.phase)) {
          c.pending = want; // applied at the next point break (tick)
          broadcastRoom(room);
          return;
        }
        setSlot(room, c, want);
        broadcastRoom(room);
        return;
      }
      case 'start': {
        if (!room) { sendError(c, 'noRoom', 'not in a room'); return; }
        if (room.owner !== c.id) { sendError(c, 'notOwner', 'only the room owner can start'); return; }
        const humans = room.slots.filter(Boolean).length +
          room.clients.filter((x) => x.slot === null && x.pending !== undefined && x.pending !== null && !room.slots[x.pending]).length;
        if (humans === 0) { sendError(c, 'noPlayers', 'someone must take a slot first'); return; }
        startMatch(room, msg.difficulty);
        broadcastRoom(room);
        return;
      }
      case 'toLobby': {
        if (!room) { sendError(c, 'noRoom', 'not in a room'); return; }
        if (room.owner !== c.id) { sendError(c, 'notOwner', 'only the room owner can end the match'); return; }
        endGame(room);
        for (const x of room.clients) if (x.pending !== undefined) applyPending(room, x);
        broadcastRoom(room);
        return;
      }
      case 'input': {
        if (room && room.game && c.slot !== null) {
          c.input.feed(msg);
          if (msg.edges.length || msg.axis.x !== 0 || msg.axis.y !== 0) room.lastActive = now();
        }
        return;
      }
      case 'ping': {
        const st = room && room.game ? Math.round(room.game.state.time * 1000) / 1000 : 0;
        sendObj(c, { t: 'pong', c: msg.c, st, m: room ? room.m : 0 });
        return;
      }
      case 'leave': {
        if (room) leaveRoom(c); else sendObj(c, { t: 'room', room: null }, 'room');
        return;
      }
      default:
        sendError(c, 'badMsg', 'unknown message type');
    }
  }

  function disconnect(c) {
    leaveRoom(c, { notify: false });
  }

  function notePing(c, ms) {
    if (!Number.isFinite(ms)) return;
    const prev = c.ping;
    c.ping = ms;
    const room = c.room;
    if (room && Math.abs(prev - ms) >= 5 && now() - room.lastPingBroadcast > 2000) {
      room.lastPingBroadcast = now();
      broadcastRoom(room);
    }
  }

  // ------------------------------------------------------------ loop
  let lastIdleCheck = now();
  /** Advance every running room by `realDt` seconds of wall time. */
  function tick(realDt) {
    if (!(realDt > 0)) return;
    realDt = Math.min(realDt, 0.25); // after a stall, don't fast-forward a huge chunk
    for (const room of rooms.values()) {
      if (!room.game) continue;
      try {
        let remaining = realDt * timeScale;
        while (remaining > 1e-9 && room.game) {
          const step = Math.min(remaining, 0.05);
          room.game.update(step);
          remaining -= step;
        }
      } catch (err) {
        log(`room ${room.code}: game crashed, back to lobby`, err);
        endGame(room, { emitMenu: false });
        broadcastRoom(room);
        continue;
      }
      if (!room.game) continue;
      // Slot requests queued during a rally go through at the next point break.
      if (SLOT_CHANGE_PHASES.has(room.game.state.phase)) {
        let changed = false;
        for (const c of room.clients) if (c.pending !== undefined) { applyPending(room, c); changed = true; }
        if (changed) broadcastRoom(room);
      }
      room.snapAcc += realDt;
      if (room.snapAcc >= snapPeriod) {
        room.snapAcc = Math.min(room.snapAcc - snapPeriod, snapPeriod);
        sendSnapshot(room);
      }
    }
    const t = now();
    if (t - lastIdleCheck > 5000) {
      lastIdleCheck = t;
      for (const room of [...rooms.values()]) {
        if (t - room.lastActive > LIMITS.idleRoomMs) deleteRoom(room, 'room closed after 30 minutes of inactivity');
      }
    }
  }

  function close() {
    for (const room of [...rooms.values()]) deleteRoom(room);
  }

  return {
    connect, allow, handle, disconnect, notePing, tick, close,
    rooms,
    stats: () => ({ rooms: rooms.size }),
  };
}
