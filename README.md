# Cute Beach Volley 🏐

A cute, chibi-style 3D 2v2 beach volleyball game that runs in the browser. It's built with Three.js and Vite.

Play as **Momo** with your AI partner **Pip** (Team Peach) against **Kiki** and **Bo** (Team Mint).
Every touch is timing-based: hit the green zone on the meter for a clean pass, set, spike or serve.
Online, up to 4 players can share a room, and the AI fills any empty slot.

Everything is procedural: the models, textures, sounds and music are all generated in code, so there are no asset files.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm run dev          # single-player at http://localhost:5173
```

### Online multiplayer

Run the game server next to the dev server. Vite proxies the WebSocket (`/ws`) to it:

```bash
npm run dev          # terminal 1: the game
npm run server       # terminal 2: multiplayer server on port 8787
```

For production, build the game and let the Node server host it and the rooms on a single port:

```bash
npm run build
npm start            # serves dist/ + WebSocket on PORT (default 8787)
```

| Env var | Purpose |
|---|---|
| `PORT` | Server port (default `8787`) |
| `VITE_SERVER_URL` | Build-time override for the WebSocket URL (default: same host as the page, `/ws`) |

The server also exposes `GET /healthz` for health checks.

## How to play

You control **Momo** only. Pip plays their own touches. Nothing is automatic for you except blocking.

| Action | Keyboard | Gamepad |
|---|---|---|
| Move (Up = toward the net) | WASD / Arrow keys | Left stick / D-pad |
| Jump (at the net = block) | Space | A / Cross |
| Pass / Set | K | B / Circle |
| Hit (spike / serve) | J | X / Square |
| Pause | Esc / P | Start |
| Mute | M | |

### Timing meters

- **Pass / Set (K):** when a ball comes toward Momo, a meter fills up to the moment of contact.
  Press K **once** while it's green for an accurate pass. A slightly early or late press gives a sloppy pass.
  A press that's way off shanks the ball. A ball just out of reach turns K into a dive.
- **Spike (J):** when Pip sets you, the spike meter follows the ball. Press **Space** at the JUMP mark,
  hold **J** to wind up, then **release J in the green zone** for full power. Steer with the move keys to aim.
- **Serve (J):** hold J to charge and release to serve. Use left/right while charging to aim.
  If you hold at full charge too long, the serve is likely to go long.

### Rules

Rally scoring. The first team to **15** wins, and you must win by 2. Each side gets a maximum of 3 touches.
There are three CPU difficulties: Easy, Normal and Hard.

### Online rooms

Open **Online**, enter a name, and create a room. Share the 4-letter code so friends can join. Each player picks a
slot: Momo or Pip on Team Peach, or Kiki or Bo on Team Mint. Any empty slot is played by the AI, so you can play 1v1,
co-op against the CPU or a full 2v2. The server is authoritative and uses lag compensation, so timing presses are judged by
what you saw on your screen.

## Development

```bash
npm test             # node --test tests/*.test.js
npm run build        # production build into dist/
npm run preview      # preview the production build
```

### Project layout

```
src/
  config.js        all dimensions, colors, rosters, difficulty and meter tuning
  main.js          integration: wires the modules below together
  game/            simulation, physics, rules, AI, input (DOM-free, also runs on the server)
  render/          renderer, camera, lighting, toon materials, court, ball, VFX
  characters/      procedural chibi players and their animations
  ui/              DOM menus, HUD, meters, lobby
  audio/           WebAudio-synthesized SFX and music
  net/             browser multiplayer client and snapshot interpolation
server/            Node HTTP + WebSocket server, rooms, authoritative game loop
tests/             node:test suites
docs/              architecture and network contracts
```

### Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): module contracts, game state shape, events and controls.
- [`docs/NETWORK.md`](docs/NETWORK.md): the multiplayer protocol, slots, snapshots and lag compensation.

Most tuning lives in `src/config.js`. Start there.
