// Integration entry point. Wires the modules together per docs/ARCHITECTURE.md.
import { createEventBus } from './core/events.js';
import { Vector3 } from 'three';
import { TEAMS, PLAYER } from './config.js';
import { createGame } from './game/game.js';
import { createInput } from './game/input.js';
import { createStage } from './render/stage.js';
import { createCourt } from './render/court.js';
import { createBallView } from './render/ballView.js';
import { createEffects } from './render/effects.js';
import { createCharacter } from './characters/character.js';
import { createUI } from './ui/ui.js';
import { createAudio } from './audio/audio.js';
import { createNetClient } from './net/client.js';

const events = createEventBus();
const input = createInput(window);
const game = createGame({ events, input });

const stage = createStage(document.getElementById('app'));
const court = createCourt(stage.scene);
const ballView = createBallView(stage.scene);
const effects = createEffects(stage.scene, events);
const audio = createAudio(events);

// One character view per simulated player, in game.state.players order.
const characters = game.state.players.map((p) => {
  const team = TEAMS[p.team];
  const c = createCharacter(team.players[p.index], team.color);
  stage.scene.add(c.root);
  return c;
});

// Online play (docs/NETWORK.md). `active` is whichever game the views render: the local
// simulation offline, the server-driven adapter while in a room. Only ONE of them is updated per
// frame, since both poll the same input (updating both would lose key edges).
const net = createNetClient({ events, input });
let active = game;
function startSound() { audio.unlock(); audio.startMusic(); }

const ui = createUI(document.getElementById('ui'), events, {
  onStart(difficulty) {
    startSound();
    game.startMatch({ difficulty });
  },
  onPause() { active.pause(); },
  onResume() { active.resume(); },
  onRestart() { active.startMatch({ difficulty: active.state.difficulty }); },
  onQuitToMenu() { active.toMenu(); },
  onToggleMute() { audio.setMuted(!audio.isMuted()); return audio.isMuted(); },
  // Online
  onOnlineOpen() { net.connect(); },
  onOnlineCreate(name) { startSound(); net.create(name); },
  onOnlineJoin(code, name) { startSound(); net.join(code, name); },
  onOnlineSlot(slot) { net.takeSlot(slot); },
  onOnlineStart(difficulty) { startSound(); net.start(difficulty); },
  onOnlineToLobby() { net.toLobby(); },
  onOnlineLeave() { net.leave(); },
});

net.onStatus((st) => ui.setNetStatus(st));
net.onRoom((room) => {
  if (room && active !== net.game) {
    if (game.state.phase !== 'menu') game.toMenu(); // leave any offline match behind
    active = net.game;
  } else if (!room && active === net.game) {
    active = game;
  }
  ui.setRoom(room);
});

// Debug/test hook (used by QA scripts).
window.__volley = { game, events, stage, net, get active() { return active; } };

// Screen-space anchors for UI elements that follow the action (e.g. timing meters beside Momo,
// avoiding Pip and the ball). Reused objects: no per-frame allocation.
const tmpWorld = new Vector3();
const anchors = { ball: { x: 0, y: 0 }, heads: [0, 1, 2, 3].map(() => ({ x: 0, y: 0 })) };
// momoScreen/pipScreen = LOCAL player / local partner (names kept for compatibility, see ARCHITECTURE.md).
const view = { momoScreen: null, pipScreen: null, ballScreen: null, playerScreens: [null, null, null, null] };
function project(x, y, z, out) {
  tmpWorld.set(x, y, z).project(stage.camera);
  if (tmpWorld.z > 1) return null;
  const rect = stage.renderer.domElement.getBoundingClientRect();
  out.x = rect.left + (tmpWorld.x * 0.5 + 0.5) * rect.width;
  out.y = rect.top + (-tmpWorld.y * 0.5 + 0.5) * rect.height;
  return out;
}
function updateView(s) {
  const head = PLAYER.height + 0.15;
  for (let i = 0; i < 4; i++) {
    const p = s.players[i];
    view.playerScreens[i] = project(p.pos.x, p.pos.y + head, p.pos.z, anchors.heads[i]);
  }
  const me = Number.isInteger(s.controlledId) ? s.controlledId : 0;
  view.momoScreen = view.playerScreens[me];
  view.pipScreen = view.playerScreens[me ^ 1]; // partner: 0<->1, 2<->3
  const b = s.ball;
  view.ballScreen = b.visible ? project(b.pos.x, b.pos.y, b.pos.z, anchors.ball) : null;
}

let last = performance.now();
let elapsed = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;

  active.update(dt);
  const s = active.state;

  court.update(dt, elapsed, s);
  ballView.update(dt, s.ball, s);
  // View-only field for the spike wind-up pose (the game exposes the meter as state.hitCharge).
  // Guarded: a non-finite value here poisons the rig transforms and blanks the whole frame.
  for (const p of s.players) {
    const hc = p.meters ? p.meters.hitCharge : p.id === s.controlledId ? s.hitCharge : null;
    p.windup = Number.isFinite(hc) ? hc : null;
  }
  s.players.forEach((p, i) => characters[i].update(dt, p));
  effects.update(dt);
  stage.updateCamera(dt, s);
  updateView(s);
  ui.update(s, view);
  stage.render();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
