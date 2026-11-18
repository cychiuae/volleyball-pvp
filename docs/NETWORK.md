# Cute Beach Volley — Online Multiplayer Contract

Up to 4 humans per room; AI plays every empty slot. Covers 1v1, co-op vs CPU and full 2v2.
Read together with docs/ARCHITECTURE.md (which this extends) and `NET` in src/config.js.

## Topology: server-authoritative
```
browser (client) ──ws──►  server/index.js  (Node)
  local input  ── input msgs ──►  room.game = createGame({ events, inputs })   // the SAME src/game code
  views        ◄── snapshots ──   fixed 120 Hz sim, snapshots at NET.snapshotHz
  audio/VFX/UI ◄── events ─────   every game event forwarded
```
- The server runs the real simulation (src/game is DOM-free, so it runs in Node). Clients never
  simulate; they render interpolated snapshots ~NET.interpDelay behind the newest one.
- One HTTP server does both: serves `dist/` (the built game) and accepts WebSockets on `NET.wsPath`.
  `PORT` env (default `NET.defaultPort`). Vite dev proxies `NET.wsPath` to it, so `npm run dev` +
  `npm run server` work together; production = `npm run build && npm start`.
- Client URL: `VITE_SERVER_URL` if set, else same host as the page (`ws(s)://<host><wsPath>`).

## Ownership
| Path | Owner |
|---|---|
| `server/*`, `src/net/*`, `tests/net*.test.js` | network-engineer |
| `src/game/*` (multi-human sim, lag compensation hooks) | gameplay-engineer |
| `src/ui/*` (online menu, lobby, name tags, net status) | ui-audio-designer |
| `src/render/*` (camera from the local player's side) | environment-artist |
| `src/main.js`, `src/config.js`, docs, `package.json`, `vite.config.js` | lead |

## Slots
Slot = player id: 0 Momo, 1 Pip (Team Peach, z > 0) · 2 Kiki, 3 Bo (Team Mint, z < 0).
A client holds at most one slot (or none = waiting in the lobby, cannot be in a running match
without a slot). Empty slots are AI. An AI on a team with ≥1 human uses the partner profile
(like Pip offline); an AI on an all-AI team uses the room difficulty (opponent profile + CPU_MODS).
A room with 0 humans in slots cannot start.

## Protocol (JSON text frames, one object per frame, field `t` = type)
Client → server
| t | fields | notes |
|---|---|---|
| `create` | `name` | creates a room; sender becomes owner, auto-takes slot 0 |
| `join` | `code, name` | errors: `noRoom`, `full` (4 clients), `started` is NOT an error: join mid-match goes to lobby list without a slot, may take a free slot at the next point break |
| `slot` | `slot: 0..3 \| null` | take a free slot / leave your slot. Mid-match: only during `serve`/`point`/`matchOver` phases |
| `start` | `difficulty` | owner only; starts (or restarts) the match |
| `toLobby` | — | owner only; ends the match, everyone back to lobby |
| `input` | `seq, axis:{x,y}, held:[actions], edges:[[action, 'down'\|'up', viewTime]]` | sent every client frame while in a match (≤ 60/s). `viewTime` = `state.time` of the frame the player was looking at when the edge happened |
| `ping` | `c` | client timestamp; server answers `pong` |
| `leave` | — | leave the room |

Server → client
| t | fields |
|---|---|
| `room` | `room` (shape below) — sent on every room change |
| `snap` | `s` — compact game state (see Snapshot) at `NET.snapshotHz` while a match exists |
| `ev` | `name, p` — a game event, payload with Vector3s as `[x,y,z]` arrays (client converts back to `THREE.Vector3`) |
| `pong` | `c, st` — echo + server sim time |
| `error` | `code, msg` — `noRoom`, `full`, `notOwner`, `slotTaken`, `badMsg`, `rateLimit` |

```js
room = {
  code: 'ABCD',                  // 4 letters, no ambiguous chars (no I, O, 0, 1)
  you: 'c7',                     // your client id
  owner: 'c3',
  clients: [{ id, name, slot: 0..3 | null, ping: ms }],
  slots: [clientId | null, x4],  // index = player id
  phase: 'lobby' | 'playing',
  difficulty: 'easy' | 'normal' | 'hard',
}
```
Names: trimmed, max 12 chars, stripped to printable; default "Player N".

## Snapshot
Everything views read from `game.state` (ARCHITECTURE.md), quantised (positions to mm, angles to
1e-3). Includes per-player `human`, `meters` and `name`. Not included: `controlled`, `controlledId`
and the top-level meter mirrors — the client sets those for its own slot.

## Client: `src/net/client.js`
```js
const net = createNetClient({ events, input, url });   // events = the page's event bus
net.connect();                    // lazily, when the player opens Online
net.create(name); net.join(code, name); net.takeSlot(slot | null);
net.start(difficulty); net.toLobby(); net.leave();
net.onRoom(fn(room | null));      // null = left / disconnected
net.onStatus(fn({ status: 'connecting'|'online'|'offline'|'error', ping, message }));
net.game;                         // REMOTE GAME ADAPTER, same interface as createGame():
                                  //   state, update(dt), startMatch({difficulty}), pause(), resume(), toMenu()
```
The adapter's `update(dt)` polls `input`, sends an `input` message, advances the render clock and
writes the interpolated snapshot into `net.game.state` (a live object of the ARCHITECTURE shape,
Vector3s reused), sets `controlledId` = my slot, `players[i].controlled = (i === my slot)`, and the
top-level meter mirrors from `players[mySlot].meters`. Server events are re-emitted on `events` at
the moment their sim time is rendered (not on arrival), so sounds/VFX line up with the picture.
Online, `pause()` does NOT pause the match (the menu overlay opens, play continues).

## Lag compensation (timing meters must stay fair at RTT ≤ 200 ms)
A press is judged by what the player SAW: every edge carries `viewTime`. The server's remote input
implements the optional input method `edgeTime(action)` (ARCHITECTURE.md › Input), and the game:
- grades K / J-release / serve timing against `viewTime`, not arrival time;
- applies a jump as if it started at `viewTime` (rewind ≤ NET.maxRewind);
- if a green/good press arrives after the predicted contact already passed on the server, the touch
  is applied retroactively at the contact point on the stored ball trajectory, then fast-forwarded;
- holds a point decision up to NET.maxRewind while a remote human has a live meter episode on that ball.
Local (offline) input has no `edgeTime`, so offline play is unchanged.

## Robustness / security (the server is internet-facing)
Validate every message (types, ranges, size ≤ 4 KB), rate-limit (≤ 120 msgs/s per client, drop
beyond), cap rooms (≤ 200) and clients, remove idle rooms after 30 min, never eval or echo raw
input except sanitised names. Disconnect = slot becomes AI immediately; owner leaving passes
ownership to the oldest client; the last client leaving deletes the room.
