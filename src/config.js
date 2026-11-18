// Shared constants for every module. Units: meters, seconds, radians.
// Coordinate system (Three.js, Y up):
//   - Net lies in the plane z = 0, running along X.
//   - Team 0 (HUMAN, "Peach") plays on z > 0, nearest the camera.
//   - Team 1 (CPU, "Mint") plays on z < 0, far side.
//   - Court is centered at the origin; floor (sand surface) is y = 0.

export const COURT = {
  halfWidth: 4,        // in-bounds |x| <= halfWidth
  halfLength: 8,       // in-bounds |z| <= halfLength (each side is 8m deep)
  lineWidth: 0.08,
  netHeight: 2.0,      // top of the net tape
  netBottom: 1.0,      // bottom edge of the mesh (below is open)
  netHalfSpan: 4.6,    // posts at x = ±netHalfSpan
  antennaHeight: 0.8,  // antennas stick up above the net top at x = ±halfWidth
};

export const BALL = {
  radius: 0.24,
  gravity: 9.0,        // m/s^2, slightly floaty for arcade feel
  airDrag: 0.06,       // linear drag coefficient per second
  netRestitution: 0.3, // speed kept when bouncing off the net mesh
  sandRestitution: 0.25,
};

export const PLAYER = {
  height: 1.3,          // chibi total height (feet at y=0 to top of head)
  radius: 0.35,         // body collision radius
  moveSpeed: 5.2,       // m/s on sand
  accel: 30,            // m/s^2
  jumpVelocity: 6.2,
  gravity: 20,          // players fall faster than the ball (snappy jumps)
  standingReach: 1.7,   // y of fingertips with arms up while standing
  reachRadius: 0.95,    // horizontal distance from body center at which the ball can be played
  reachBelow: 0.15,     // lowest y a ball can be played at (digs)
};

export const RULES = {
  pointsToWin: 15,
  winBy: 2,
  maxTouches: 3,
  pointPauseSec: 2.2,   // celebration pause after a point
  serveTimeoutSec: 8,   // CPU auto-serves / human must serve within this
};

export const TEAMS = [
  {
    id: 0,
    name: 'Team Peach',
    color: '#ff8fab',
    accent: '#ffd6e0',
    side: 1,            // sign of z for this team's half
    players: [
      { name: 'Momo', skin: '#ffe0c7', hair: '#5b3a29', hairStyle: 'bun',      shirt: '#ff8fab', shorts: '#ffffff', accessory: 'headband' },
      { name: 'Pip',  skin: '#f1c7a1', hair: '#f6c453', hairStyle: 'spiky',    shirt: '#ff8fab', shorts: '#ffffff', accessory: 'cap' },
    ],
  },
  {
    id: 1,
    name: 'Team Mint',
    color: '#5ed3b5',
    accent: '#c9f5e8',
    side: -1,
    players: [
      { name: 'Kiki', skin: '#ffd9b8', hair: '#2d2a4a', hairStyle: 'pigtails', shirt: '#5ed3b5', shorts: '#2f6f8f', accessory: 'visor' },
      { name: 'Bo',   skin: '#c99b74', hair: '#e86a5a', hairStyle: 'bob',      shirt: '#5ed3b5', shorts: '#2f6f8f', accessory: 'none' },
    ],
  },
];

// Base AI profiles. `normal` is also Pip's (the human's partner) profile at every difficulty.
// Opponent-only extras (spike pace, dig shanks, block success...) live in CPU_MODS in src/game/game.js.
export const DIFFICULTY = {
  easy:   { reaction: 0.45, speedMul: 0.80, errorRate: 0.22, spikeChance: 0.35, blockChance: 0.15, aimNoise: 1.4 },
  normal: { reaction: 0.28, speedMul: 0.92, errorRate: 0.10, spikeChance: 0.65, blockChance: 0.35, aimNoise: 0.9 },
  hard:   { reaction: 0.15, speedMul: 0.94, errorRate: 0.08, spikeChance: 0.72, blockChance: 0.42, aimNoise: 0.8 },
};

export const PALETTE = {
  sky: '#9fdcff',
  skyHorizon: '#fff1d6',
  sand: '#f7dfa8',
  sandDark: '#e9c98a',
  ocean: '#4cc9f0',
  line: '#ffffff',
  net: '#ffffff',
  post: '#ff9f6b',
  ball: ['#ffd43b', '#4dabf7', '#ffffff'],
  outline: '#3b2b3a',
};

// Timing meters shared by game logic (quality) and UI (drawing). Values are meter fractions 0..1.
// Single source of truth: the UI draws the green zone from these, the game grades releases with them.
export const METER = {
  serve: { fillSec: 1.1, green: [0.85, 1.0] },       // full charge is best; holding too long at 1 → serveRisk
  // Spike (J): BALL-SYNCED like the pass meter. While an attack ball is coming to Momo the needle
  // fills toward the ideal contact moment: fill = 1 - timeToContact / leadSec (1.0 = contact).
  // Press Space at jumpMark (Momo reaches her jump apex at contact), release J in green.
  spike: { leadSec: 1.1, green: [0.74, 0.95], jumpMark: 1 - (PLAYER.jumpVelocity / PLAYER.gravity) / 1.1 }, // green ≈ 0.29 s .. 0.055 s before contact; jumpMark ≈ 0.72 (0.31 s before)
  // Pass/set (K): the meter fills by itself as an incoming ball approaches Momo's contact point.
  // fill = 1 - timeToContact / leadSec (1.0 = contact moment). Press K once while in green.
  pass:  { leadSec: 0.8, green: [0.75, 0.925] },     // green ≈ 0.20 s .. 0.06 s before contact
};

// Online multiplayer (see docs/NETWORK.md).
export const NET = {
  wsPath: '/ws',
  defaultPort: 8787,
  snapshotHz: 30,       // server → client state snapshots per second
  interpDelay: 0.1,     // s; clients render this far behind the newest snapshot
  maxRewind: 0.25,      // s; lag compensation never rewinds further than this (0.35 would suit RTT 200 ms but needs gameplay retuning; must stay < game POS_HISTORY 0.4 s)
  maxPlayers: 4,
};
