// Server-side input object for one remote human, fed by validated `input` messages.
// Implements the game's input interface (src/game/input.js) plus the optional edgeTime(action)
// used for lag compensation (docs/NETWORK.md).
//
// Edges are queued per action and never lost: each poll() consumes at most one 'down' and one
// 'up' per action (in arrival order), so a tap that starts and ends between two server ticks
// still produces pressed() and released(), and a second tap in the same tick is delivered on the
// next poll. Every consumed edge keeps the viewTime the client stamped it with.

export const REMOTE_ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'pass', 'hit'];
const QUEUE_CAP = 32; // per action; beyond this the oldest pair is collapsed (a flooding client only hurts itself)

export function createRemoteInput() {
  const queues = Object.create(null);   // action -> [{ down: bool, vt: number|null }]
  const held = Object.create(null);     // state after consumed edges
  const pressed = Object.create(null);
  const released = Object.create(null);
  const edgeAt = Object.create(null);   // action -> viewTime of the latest consumed edge (or undefined)
  for (const a of REMOTE_ACTIONS) { queues[a] = []; held[a] = false; }
  const ax = { x: 0, y: 0 };
  let lastSeq = -1;
  let clampTime = null; // () => sim time, set by the room so viewTimes are bounded to [now - rewind, now]
  let maxRewind = 0.25;

  /** Final held state once every queued edge of `a` is applied. */
  function pendingHeld(a) {
    const qq = queues[a];
    return qq.length ? qq[qq.length - 1].down : held[a];
  }

  function push(a, down, vt) {
    const qq = queues[a];
    if (qq.length && qq[qq.length - 1].down === down) return; // duplicate edge: ignore
    if (!qq.length && held[a] === down) return;                 // already in that state
    qq.push({ down, vt });
    if (qq.length > QUEUE_CAP) qq.splice(0, 2); // drop the oldest down/up pair; parity preserved
  }

  return {
    /**
     * Apply one validated input message: { seq, axis:{x,y}, held:[actions], edges:[[a,'down'|'up',vt]] }.
     * Returns false for stale/duplicate seq.
     */
    feed(msg) {
      if (msg.seq <= lastSeq) return false;
      lastSeq = msg.seq;
      ax.x = msg.axis.x; ax.y = msg.axis.y;
      for (const [a, kind, vt] of msg.edges) {
        if (!(a in queues)) continue;
        push(a, kind === 'down', vt);
      }
      // Reconcile with the authoritative held list (covers a client that missed an edge).
      for (const a of REMOTE_ACTIONS) {
        const want = msg.held.includes(a);
        if (pendingHeld(a) !== want) push(a, want, null);
      }
      return true;
    },
    /** Release everything (slot lost, match reset). */
    reset() {
      for (const a of REMOTE_ACTIONS) {
        queues[a].length = 0;
        held[a] = false; pressed[a] = false; released[a] = false; edgeAt[a] = undefined;
      }
      ax.x = 0; ax.y = 0;
    },
    setClock(fn, rewind) { clampTime = fn; if (Number.isFinite(rewind)) maxRewind = rewind; },

    // ---- game input interface
    poll() {
      const now = clampTime ? clampTime() : null;
      for (const a of REMOTE_ACTIONS) {
        pressed[a] = false;
        released[a] = false;
        const qq = queues[a];
        // Consume edges until we would repeat an edge kind already seen this poll.
        while (qq.length) {
          const e = qq[0];
          if (e.down ? pressed[a] : released[a]) break;
          qq.shift();
          if (e.down) pressed[a] = true; else released[a] = true;
          held[a] = e.down;
          let vt = e.vt;
          if (vt !== null && now !== null) vt = Math.min(now, Math.max(now - maxRewind, vt));
          edgeAt[a] = vt === null ? undefined : vt;
        }
      }
    },
    held: (a) => !!held[a],
    pressed: (a) => !!pressed[a],
    released: (a) => !!released[a],
    axis() {
      // Digital fallback when the client sent a zero axis but holds direction keys.
      if (ax.x !== 0 || ax.y !== 0) return { x: ax.x, y: ax.y };
      let x = (held.right ? 1 : 0) - (held.left ? 1 : 0);
      let y = (held.up ? 1 : 0) - (held.down ? 1 : 0);
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      return { x, y };
    },
    /** state.time (from the player's point of view) of the latest consumed edge of `a`; undefined = now. */
    edgeTime: (a) => edgeAt[a],
    dispose() {},
  };
}
