import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput, createVirtualInput } from '../src/game/input.js';

function fakeWindow() {
  const win = new EventTarget();
  win.navigator = { getGamepads: () => [] };
  return win;
}
function key(win, type, code, extra = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  win.dispatchEvent(e);
  return e;
}

test('keyboard: held vs edge-triggered pressed/released, preventDefault on game keys', () => {
  const win = fakeWindow();
  const input = createInput(win);
  const down = key(win, 'keydown', 'Space');
  assert.equal(down.defaultPrevented, true);
  input.poll();
  assert.equal(input.pressed('jump'), true);
  assert.equal(input.held('jump'), true);
  key(win, 'keydown', 'Space', { repeat: true });
  input.poll();
  assert.equal(input.pressed('jump'), false, 'auto-repeat is not a new press');
  assert.equal(input.held('jump'), true);
  key(win, 'keyup', 'Space');
  input.poll();
  assert.equal(input.released('jump'), true);
  assert.equal(input.held('jump'), false);
  input.dispose();
});

test('keyboard: a tap shorter than a frame still registers press and release', () => {
  const win = fakeWindow();
  const input = createInput(win);
  key(win, 'keydown', 'KeyP');
  key(win, 'keyup', 'KeyP');
  input.poll();
  assert.equal(input.pressed('pause'), true);
  assert.equal(input.released('pause'), true);
  assert.equal(input.held('pause'), false);
});

test('keyboard: WASD/arrows axis, Esc pauses, M is left alone, blur clears', () => {
  const win = fakeWindow();
  const input = createInput(win);
  key(win, 'keydown', 'KeyW');
  key(win, 'keydown', 'ArrowRight');
  input.poll();
  const a = input.axis();
  assert.ok(a.x > 0.6 && a.y > 0.6, 'up-right diagonal, normalised');
  assert.ok(Math.hypot(a.x, a.y) <= 1.0001);
  const m = key(win, 'keydown', 'KeyM');
  assert.equal(m.defaultPrevented, false);
  key(win, 'keydown', 'Escape');
  input.poll();
  assert.equal(input.pressed('pause'), true);
  win.dispatchEvent(new Event('blur'));
  input.poll();
  assert.equal(input.held('up'), false);
  assert.deepEqual(input.axis(), { x: 0, y: 0 });
});

test('keyboard: J = Hit, K = Pass, Space = jump (all separate)', () => {
  const win = fakeWindow();
  const input = createInput(win);
  const e = key(win, 'keydown', 'KeyJ');
  assert.equal(e.defaultPrevented, true);
  input.poll();
  assert.equal(input.pressed('hit'), true);
  assert.equal(input.held('pass'), false);
  assert.equal(input.held('jump'), false);
  key(win, 'keyup', 'KeyJ');
  const k = key(win, 'keydown', 'KeyK');
  assert.equal(k.defaultPrevented, true);
  input.poll();
  assert.equal(input.pressed('pass'), true);
  assert.equal(input.held('hit'), false, 'K is no longer Hit');
  key(win, 'keydown', 'Space');
  input.poll();
  assert.equal(input.pressed('jump'), true);
  assert.equal(input.pressed('hit'), false);
  assert.equal(input.pressed('pass'), false);
});

test('gamepad: A jumps, B passes, X hits', () => {
  const win = fakeWindow();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  win.navigator = { getGamepads: () => [{ connected: true, axes: [0, 0], buttons }] };
  const input = createInput(win);
  buttons[2].pressed = true;
  input.poll();
  assert.equal(input.pressed('hit'), true);
  assert.equal(input.held('jump'), false);
  buttons[2].pressed = false;
  buttons[1].pressed = true;
  input.poll();
  assert.equal(input.pressed('pass'), true);
  assert.equal(input.released('hit'), true);
  buttons[1].pressed = false;
  buttons[0].pressed = true;
  input.poll();
  assert.equal(input.pressed('jump'), true);
  assert.equal(input.held('pass'), false);
});

test('virtual input mirrors the interface', () => {
  const v = createVirtualInput();
  v.set('jump', true);
  v.poll();
  assert.equal(v.pressed('jump'), true);
  v.poll();
  assert.equal(v.pressed('jump'), false);
  assert.equal(v.held('jump'), true);
  v.set('jump', false);
  v.poll();
  assert.equal(v.released('jump'), true);
  v.setAxis(0.5, -0.5);
  assert.deepEqual(v.axis(), { x: 0.5, y: -0.5 });
});
