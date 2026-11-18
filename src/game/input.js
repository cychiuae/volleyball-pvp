// Input: keyboard (+ optional gamepad) polled by the game once per update.
// The game owns the meaning of actions. DOM access is confined to createInput().
//
// Interface (shared by createInput / createVirtualInput):
//   poll()            sample devices, compute edges since the previous poll (call once per frame)
//   held(action)      true while down
//   pressed(action)   went down since the previous poll (taps shorter than a frame still count)
//   released(action)  went up since the previous poll
//   axis()            { x, y } in -1..1, x = right, y = up (screen-relative, up = toward the net)
//   dispose()
// Actions: 'left' 'right' 'up' 'down' 'jump' (Space / pad A) 'pass' (K / pad B) 'hit' (J / pad X)
// 'pause' (Esc, P / pad Start).
// M (mute) is deliberately not handled (the UI owns it).

export const ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'pass', 'hit', 'pause'];

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump',
  KeyJ: 'hit', KeyK: 'pass',
  Escape: 'pause', KeyP: 'pause',
};
// Fallback for environments without KeyboardEvent.code.
const KEYMAP_BY_KEY = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  ' ': 'jump', Spacebar: 'jump',
  j: 'hit', J: 'hit', k: 'pass', K: 'pass',
  Escape: 'pause', Esc: 'pause', p: 'pause', P: 'pause',
};

function createEdgeTracker() {
  const now = Object.create(null);
  const prev = Object.create(null);
  const pressed = Object.create(null);
  const released = Object.create(null);
  const downEvents = new Set();
  const upEvents = new Set();
  return {
    noteDown(a) { downEvents.add(a); },
    noteUp(a) { upEvents.add(a); },
    /** isHeld(action) -> boolean for the current device state */
    update(isHeld) {
      for (const a of ACTIONS) {
        const h = !!isHeld(a);
        pressed[a] = (h && !prev[a]) || downEvents.has(a);
        released[a] = (!h && !!prev[a]) || (upEvents.has(a) && !h);
        now[a] = h;
        prev[a] = h;
      }
      downEvents.clear();
      upEvents.clear();
    },
    held: (a) => !!now[a],
    pressed: (a) => !!pressed[a],
    released: (a) => !!released[a],
  };
}

function digitalAxis(held) {
  let x = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
  let y = (held('up') ? 1 : 0) - (held('down') ? 1 : 0);
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  return { x, y };
}

function isEditable(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

/** Keyboard + gamepad input bound to `win` (normally `window`). */
export function createInput(win) {
  const keysDown = new Map(); // code -> action
  const edges = createEdgeTracker();
  const pad = { x: 0, y: 0, jump: false, pass: false, hit: false, pause: false, left: false, right: false, up: false, down: false };

  const actionFor = (e) => KEYMAP[e.code] || KEYMAP_BY_KEY[e.key] || null;

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    const a = actionFor(e);
    if (!a) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const code = e.code || e.key;
    if (e.repeat && keysDown.has(code)) return;
    if (!keysDown.has(code)) edges.noteDown(a);
    keysDown.set(code, a);
  }
  function onKeyUp(e) {
    const a = actionFor(e);
    if (!a) return;
    if (!isEditable(e.target) && typeof e.preventDefault === 'function') e.preventDefault();
    const code = e.code || e.key;
    if (keysDown.delete(code)) edges.noteUp(a);
  }
  function clearAll() {
    for (const a of keysDown.values()) edges.noteUp(a);
    keysDown.clear();
  }
  function onVisibility() {
    if (win.document && win.document.hidden) clearAll();
  }

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', clearAll);
  if (win.document && win.document.addEventListener) win.document.addEventListener('visibilitychange', onVisibility);

  const keyHeld = (a) => {
    for (const v of keysDown.values()) if (v === a) return true;
    return false;
  };

  function pollGamepad() {
    pad.x = 0; pad.y = 0;
    pad.jump = pad.pass = pad.hit = pad.pause = pad.left = pad.right = pad.up = pad.down = false;
    const nav = win.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') return;
    let pads;
    try { pads = nav.getGamepads(); } catch { return; }
    if (!pads) return;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.25) { pad.x = ax; pad.y = -ay; }
      pad.jump = pad.jump || b(0);       // A / Cross
      pad.pass = pad.pass || b(1);       // B / Circle
      pad.hit = pad.hit || b(2);         // X / Square
      pad.pause = pad.pause || b(9);
      pad.up = pad.up || b(12);
      pad.down = pad.down || b(13);
      pad.left = pad.left || b(14);
      pad.right = pad.right || b(15);
      break; // first connected pad only
    }
  }

  const heldAny = (a) => keyHeld(a) || !!pad[a] ||
    (a === 'left' && pad.x < -0.5) || (a === 'right' && pad.x > 0.5) ||
    (a === 'up' && pad.y > 0.5) || (a === 'down' && pad.y < -0.5);

  return {
    poll() {
      pollGamepad();
      edges.update(heldAny);
    },
    held: edges.held,
    pressed: edges.pressed,
    released: edges.released,
    axis() {
      if (pad.x !== 0 || pad.y !== 0) {
        const len = Math.hypot(pad.x, pad.y);
        return len > 1 ? { x: pad.x / len, y: pad.y / len } : { x: pad.x, y: pad.y };
      }
      return digitalAxis(edges.held);
    },
    dispose() {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', clearAll);
      if (win.document && win.document.removeEventListener) win.document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * Programmatic input with the same interface (bots, tests, demos).
 * `set(action, down)` changes held state; `setAxis(x, y)` overrides the analog axis.
 */
export function createVirtualInput() {
  const down = Object.create(null);
  const edges = createEdgeTracker();
  let analog = null;
  return {
    set(action, isDown) {
      const was = !!down[action];
      if (isDown && !was) edges.noteDown(action);
      if (!isDown && was) edges.noteUp(action);
      down[action] = !!isDown;
    },
    setAxis(x, y) { analog = x === null || x === undefined ? null : { x, y }; },
    releaseAll() { for (const a of ACTIONS) this.set(a, false); analog = null; },
    poll() { edges.update((a) => !!down[a]); },
    held: edges.held,
    pressed: edges.pressed,
    released: edges.released,
    axis() { return analog ? { ...analog } : digitalAxis(edges.held); },
    dispose() {},
  };
}

/** Input that never reports anything (used when no input is supplied). */
export function createNullInput() {
  return {
    poll() {}, held: () => false, pressed: () => false, released: () => false,
    axis: () => ({ x: 0, y: 0 }), dispose() {},
  };
}
