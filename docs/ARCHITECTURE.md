# Cute Beach Volley — Architecture Contract

3D 2v2 beach volleyball in the browser. Offline: you (Momo, Team Peach, near the camera) + AI partner
vs CPU (Team Mint, far side). Online: up to 4 humans, AI fills empty slots — see **docs/NETWORK.md**. Style: cute, chibi, pastel, toon-shaded, sunny beach.

Stack: Vite + Three.js r170 (`import * as THREE from 'three'`), plain ES modules, no frameworks.
No external asset files: all geometry, textures (CanvasTexture), sounds (WebAudio) are procedural.
`npm run dev` serves; `npm run build` must succeed; `npm test` runs `node --test tests/*.test.js`.

**Read `src/config.js` first** — all dimensions, colors, team rosters and difficulty knobs live there.
`src/main.js` is the integration point and shows exactly how each module is called. Don't change
another owner's module; if a contract must change, say so in your final report.

## Coordinates
- Y up, meters. Floor/sand surface is y = 0. Net in plane z = 0 along X.
- Team 0 (human, Peach) on z > 0, near the camera. Team 1 (CPU, Mint) on z < 0.
- `facing` is a yaw angle around +Y. **A model at yaw 0 faces +Z.** `root.rotation.y = facing`.
  Team 0 facing the net → facing = π. Team 1 facing the net → facing = 0.

## Module ownership
| Path | Owner | Exports |
|---|---|---|
| `src/config.js`, `src/core/*`, `src/main.js`, `index.html` | lead (integration) | — |
| `src/game/*`, `tests/*.test.js` | gameplay-engineer | `createGame`, `createInput` |
| `src/render/*` | environment-artist | `createStage`, `createCourt`, `createBallView`, `createEffects` |
| `src/characters/*` | character-artist | `createCharacter` |
| `src/ui/*`, `src/audio/*` | ui-audio-designer | `createUI`, `createAudio` |
| `server/*`, `src/net/*`, `tests/net*.test.js` | network-engineer | `createNetClient`, the Node server |

## Game state (read-only for everyone except src/game)
`game.state` is a live object mutated in place by the simulation; views read it every frame.
Vectors are `THREE.Vector3`.

```js
state = {
  phase: 'menu' | 'serve' | 'rally' | 'point' | 'matchOver',
  paused: boolean,
  difficulty: 'easy' | 'normal' | 'hard',
  time: number,                 // seconds of simulated play
  score: [number, number],      // [team0, team1]
  servingTeam: 0 | 1,
  serverId: number,             // index into players
  touches: number,              // touches by the team currently in possession (0..3)
  possessionTeam: 0 | 1 | null, // team whose side the ball is on / last touched
  controlledId: number,         // the player THIS SCREEN controls: 0 (Momo) offline; online = my slot (client sets it)
                                //   The top-level meter fields below MIRROR players[controlledId].meters.
  serveRisk: number | null,     // 0..1 risk of a long serve from holding at full charge past the grace period (null when not charging)
  serveCharge: number | null,   // 0..1 while the human holds the serve button, else null
  passMeter: number | null,     // 0..1 pass/set timing meter while a ball is incoming to Momo (fill = 1 - timeToContact/METER.pass.leadSec); null otherwise
  passWindow: number,           // seconds left in Momo's pass/set window after pressing Pass (0 = closed)
  spikeMeter: number | null,    // 0..1 BALL-SYNCED spike meter while an attack ball is coming to Momo
                                //   (fill = 1 - timeToContact/METER.spike.leadSec; green = METER.spike.green;
                                //   jump cue at METER.spike.jumpMark); null otherwise
  hitCharge: number | null,     // 0..1 wind-up while Momo holds J (pose only; NOT the grade), else null
  hitWindow: number,            // seconds the swing stays live after releasing J (a graded release stays live until
                                //   predicted contact + a little, so up to ~1.1 s; 0 = closed)
  aimTarget: Vector3 | null,    // where a human attack would land (for an aim reticle), or null
  lastPoint: { winnerTeam, reason } | null,
  ball: {
    pos: Vector3, vel: Vector3,
    spin: Vector3,              // angular velocity (rad/s) for visual rotation only
    visible: boolean,
    landing: Vector3 | null,    // predicted floor contact point (y = 0) while in flight
    held: boolean,              // true while a server holds/tosses the ball before contact
    lastTeam: 0 | 1 | null,
  },
  players: [                    // always 4, order: team0 p0, team0 p1, team1 p0, team1 p1
    {
      id: number, team: 0 | 1, index: 0 | 1,
      pos: Vector3,             // feet position; pos.y > 0 when airborne
      vel: Vector3,
      facing: number,           // yaw, see Coordinates
      grounded: boolean,
      action: null | 'bump' | 'set' | 'spike' | 'serveToss' | 'serveHit' | 'block' | 'dive' | 'celebrate' | 'sad',
      actionTime: number,       // seconds since `action` started (reset to 0 on each new action)
      controlled: boolean,      // true only for players[controlledId] (this screen's player)
      human: boolean,           // controlled by any human (local or remote); false = AI
      name?: string,            // online only: the human's display name (set by the net client)
      meters: {                 // per-player timing meters (same meaning as the top-level fields)
        pass, spike, hitCharge, serveCharge, serveRisk,   // number | null
        passWindow, hitWindow,  // seconds, 0 = closed
        aimTarget,              // Vector3 | null
      },
      windup?: number | null,   // VIEW-ONLY, written by main.js for player 0 = state.hitCharge (spike wind-up pose)
    },
  ],
}
```

Game API (`src/game/game.js`):
```js
const game = createGame({ events, input });          // offline: input drives player 0, others AI
const game = createGame({ events, inputs, allowPause: false }); // online server: inputs[4], null = AI slot
game.setInputs(inputs);                              // change human/AI slots at any time
game.state;                         // as above; phase 'menu' until startMatch
game.startMatch({ difficulty });    // resets score, phase -> 'serve'
game.update(dt);                    // advance; must be a no-op for sim while paused or in 'menu'
                                    // (in 'menu' it may run an attract-mode idle animation)
game.pause(); game.resume(); game.toMenu();
```
Input (`src/game/input.js`): `createInput(window)` → object the game polls each update
(keyboard; gamepad optional). The game owns the meaning of keys.
Input interface: `poll(), held(a), pressed(a), released(a), axis(), dispose()`, plus OPTIONAL
`edgeTime(a)` → the `state.time` at which the latest edge of action `a` happened from the player's
point of view (remote inputs only; absent/undefined = now). The game uses it for lag compensation
(docs/NETWORK.md). Movement is screen-relative from the player's own side: "up" = toward the net
for both teams (team 1 humans see the court from the -z side).

### Controls (UI shows these on the menu)
The human controls exactly ONE player: Momo (players[0]). The partner Pip is fully AI-controlled
and plays its own touches (pass / set / attack) like a real beach partner.
Three action buttons, nothing is automatic for Momo except blocking:
- Move: WASD / Arrow keys (screen-relative: Up = toward the net).
- Jump: Space (gamepad A). Jumping at the net while the CPU attacks = **block** (automatic).
- Pass / Set: K (gamepad B). Context-sensitive: on our 1st touch = **bump** (receive) to the set
  spot; on our 2nd touch = **set** for Pip; on a 3rd touch = bump it over (free ball).
  TIMING-SENSITIVE, like the spike: when a ball is incoming to Momo, the pass meter beside Momo fills
  toward the contact moment (state.passMeter, config METER.pass). Press K ONCE while it is GREEN =
  accurate pass/set. Slightly early/late = sloppy (off target, still playable). Way too early =
  arms out too soon, the ball shanks off. Too late = shank, or the ball drops. One press per ball
  (mashing doesn't work). A ball just out of reach + K = **dive/dig**, graded the same way.
  No press = no touch (the ball drops).
- Hit: J (gamepad X).
  - **Spike**: when an attack ball is coming to Momo (Pip's set, or an overpass at the net) the
    spike meter beside Momo fills BY ITSELF toward the ideal contact moment (state.spikeMeter,
    config METER.spike) — like the pass meter, it follows the ball, not a stopwatch. Rhythm:
    press Space when the needle reaches the JUMP mark, hold J to wind up, RELEASE J while the
    needle is GREEN = full power + accurate aim. Early release = weak; late = wild/net/out.
    A green release keeps the swing live until the ball arrives, so the release moment is the
    only skill check (plus jumping roughly on the mark). Aim with the move keys at release.
    Releasing J on the ground = standing shot over the net, graded the same way.
  - **Serve**: hold J to charge the power meter, release to serve (left/right while charging aims).
- Esc / P: pause. M: mute.

## Render APIs (`src/render/*`)
```js
const stage = createStage(containerEl);   // { renderer, scene, camera, updateCamera(dt, state), render() }
                                          // camera views from the side of players[state.controlledId].team (team 1 = mirrored, from -z)
                                          // owns resize handling, lights, shadows, sky/fog
const court = createCourt(scene);         // { update(dt, elapsed, state) } — state optional (footprints) sand, lines, net, posts, beach decor
const ballView = createBallView(scene);   // { update(dt, state.ball, state) } — state optional, for the aim reticle ball mesh, blob shadow, landing marker
const effects = createEffects(scene, events); // { update(dt) } subscribes to events for VFX
```
Characters (`src/characters/character.js`):
```js
const c = createCharacter(look, teamColor); // look = TEAMS[t].players[i] from config
c.root;                                     // THREE.Object3D; feet at local origin, faces +Z at yaw 0
c.update(dt, playerState);                  // sets root.position/rotation from playerState and animates
```
UI (`src/ui/ui.js`) — DOM overlay inside `#ui` (pointer-events: none on root; enable on panels):
```js
const ui = createUI(rootEl, events, { onStart(difficulty), onPause(), onResume(), onRestart(),
                                      onQuitToMenu(), onToggleMute() /* returns muted bool */ });
ui.update(state, view);   // every frame; view = { momoScreen, pipScreen, ballScreen, playerScreens }: {x, y} | null in CSS px
                          // momoScreen = LOCAL player's head (players[controlledId]), pipScreen = local partner's head
                          // (names kept for compatibility), ballScreen = ball centre, playerScreens[4] = every head (name tags)
// Online additions (docs/NETWORK.md):
//   callbacks.onOnline{Create(name), Join(code, name), Slot(slot|null), Start(difficulty), ToLobby(), Leave()}
//   ui.setRoom(room | null)            // lobby / in-room state; null = offline
//   ui.setNetStatus({ status, ping, message })
```
Audio (`src/audio/audio.js`) — WebAudio synthesized, no files:
```js
const audio = createAudio(events); // { unlock(), setMuted(b), isMuted(), startMusic(), stopMusic() }
```

## Events (`events.emit(name, payload)`) — emitted by src/game only
| name | payload |
|---|---|
| `matchStart` | `{ difficulty }` |
| `serveReady` | `{ team, playerId, isHuman }` |
| `hit` | `{ playerId, team, type: 'serve'\|'bump'\|'set'\|'spike'\|'dink'\|'block'\|'dig', position: Vector3, power: 0..1, touches }` |
| `passAttempt` | `{ playerId, position, timing: 'perfect'\|'good'\|'early'\|'late'\|'tooEarly'\|'tooLate', meter: number\|null }` — every Pass press in a rally, misses included |
| `swing` | `{ playerId, position, airborne, timing: 'perfect'\|'good'\|'early'\|'late'\|'none', meter: number\|null }` — one per J release in a rally, whiffs included ('none' = no attack ball, meter null). Only the FIRST graded release per attack ball counts (mashing J emits nothing more); meter is capped at 1 |
| `jump` | `{ playerId, position }` |
| `land` | `{ playerId, position }` |
| `bounce` | `{ position, surface: 'sand'\|'net'\|'post', speed }` |
| `point` | `{ winnerTeam, reason: 'in'\|'out'\|'net'\|'fourHits'\|'serveFault', score: [a,b], position }` |
| `controlSwitch` | `{ playerId }` — no longer emitted (fixed control) |
| `matchOver` | `{ winnerTeam, score }` |
| `pause` / `resume` | `{}` |
| `menu` | `{}` |
UI-only actions (menu clicks, mute) don't go through the bus; they use the callbacks above.
