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

const ui = createUI(document.getElementById('ui'), events, {
  onStart(difficulty) {
    audio.unlock();
    audio.startMusic();
    game.startMatch({ difficulty });
  },
  onPause() { game.pause(); },
  onResume() { game.resume(); },
  onRestart() { game.startMatch({ difficulty: game.state.difficulty }); },
  onQuitToMenu() { game.toMenu(); },
  onToggleMute() { audio.setMuted(!audio.isMuted()); return audio.isMuted(); },
});

// Debug/test hook (used by QA scripts).
window.__volley = { game, events, stage };

// Screen-space anchors for UI elements that follow the action (e.g. timing meters beside Momo,
// avoiding Pip and the ball). Reused objects: no per-frame allocation.
const tmpWorld = new Vector3();
const anchors = { momo: { x: 0, y: 0 }, pip: { x: 0, y: 0 }, ball: { x: 0, y: 0 } };
const view = { momoScreen: null, pipScreen: null, ballScreen: null };
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
  const [momo, pip] = s.players;
  view.momoScreen = project(momo.pos.x, momo.pos.y + head, momo.pos.z, anchors.momo);
  view.pipScreen = project(pip.pos.x, pip.pos.y + head, pip.pos.z, anchors.pip);
  const b = s.ball;
  view.ballScreen = b.visible ? project(b.pos.x, b.pos.y, b.pos.z, anchors.ball) : null;
}

let last = performance.now();
let elapsed = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;

  game.update(dt);
  const s = game.state;

  court.update(dt, elapsed, s);
  ballView.update(dt, s.ball, s);
  // View-only field for the spike wind-up pose (the game exposes the meter as state.hitCharge).
  // Guarded: a non-finite value here poisons the rig transforms and blanks the whole frame.
  s.players[0].windup = Number.isFinite(s.hitCharge) ? s.hitCharge : null;
  s.players.forEach((p, i) => characters[i].update(dt, p));
  effects.update(dt);
  stage.updateCamera(dt, s);
  updateView(s);
  ui.update(s, view);
  stage.render();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
