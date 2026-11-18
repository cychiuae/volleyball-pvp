// DOM/CSS overlay for Cute Beach Volley: main menu, HUD (scoreboard, touch counter, serve meter,
// pause/mute buttons), juicy popups, first-time hint, pause and game-over screens, and the online
// screens (name/code entry, lobby, net status chip, error toasts, name tags over other humans).
// Contract: docs/ARCHITECTURE.md -> createUI(rootEl, events, callbacks) -> { update(state, view), setRoom, setNetStatus }.
// docs/NETWORK.md -> room object. Nothing here touches window/document at import time.
import './ui.css';
import { TEAMS, RULES, METER } from '../config.js';
import { MUTE_STORAGE_KEY, playCue, setAudioPerspective } from '../audio/audio.js';

export const NAME_STORAGE_KEY = 'cuteBeachVolley.name';
const NAME_MAX = 12;
// Room codes: 4 chars, no ambiguous I, O, 0, 1 (docs/NETWORK.md).
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
/** Normalise typed room-code text: uppercase, drop spaces/punctuation, max 4. Exported for tests. */
export function normalizeCode(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}
/** null if `code` is a valid room code, else a short reason. Exported for tests. */
export function codeProblem(code) {
  if (CODE_RE.test(code)) return null;
  if (/[IO01]/.test(code)) return "Codes never use I, O, 0 or 1";
  return 'Room codes are 4 letters';
}
const ERROR_TEXT = {
  noRoom: ['No room with that code', 'Double-check the letters?'],
  full: ['That room is full', 'Max 4 players per room'],
  notOwner: ['Only the host can do that', ''],
  slotTaken: ['That spot was just taken', 'Pick another one!'],
  rateLimit: ['Whoa, slow down!', 'Too many clicks at once'],
  badMsg: ['Something went wrong', 'Please try again'],
  started: ['Match in progress', 'Grab a free spot at the next point'],
};
/** Known error code carried by a net status/error payload, or null. Exported for tests. */
export function errorCodeOf(p) {
  if (!p) return null;
  if (typeof p === 'string') return ERROR_TEXT[p] ? p : (Object.keys(ERROR_TEXT).find((k) => p.includes(k)) ?? null);
  for (const v of [p.code, p.message, p.msg]) {
    const c = typeof v === 'string' ? errorCodeOf(v) : null;
    if (c) return c;
  }
  return null;
}

const DIFFS = ['easy', 'normal', 'hard'];
const DIFF_INFO = {
  easy: { label: 'Easy', blurb: 'Chill vibes' },
  normal: { label: 'Normal', blurb: 'Fair match' },
  hard: { label: 'Hard', blurb: 'Beach pros' },
};

const REASON_TEXT = {
  out: 'Out!',
  net: 'Into the net!',
  fourHits: 'Four hits!',
  serveFault: 'Service fault',
  in: '',
};

// Green zones come from config METER. Serve: full charge is best (green at the top); the only danger
// is holding at full past the grace period, which state.serveRisk (0..1) drives (red tint + shake;
// missing = 0). Spike: BALL-SYNCED (state.spikeMeter fills toward the contact moment): Space at the
// JUMP mark, release J in green; below = early (weak), above = late (wild). Graded by the game ('swing').
const SERVE_GREEN = METER?.serve?.green ?? [0.85, 1];
const SPIKE_GREEN = METER?.spike?.green ?? [0.74, 0.95];
const SPIKE_JUMP = typeof METER?.spike?.jumpMark === 'number' ? METER.spike.jumpMark : 0.72;
const SPIKE_RESULT_MS = 520;
const SPIKE_JUMP_SOON = 0.1; // fill before the JUMP mark where the mark starts to pulse (anticipation)
const SPIKE_JUMP_NOW = 0.09; // fill after the mark that "JUMP!" stays up while Momo is still grounded

/**
 * Spike meter cue phase: 'jump' | 'jumpSoon' | 'jumpNow' (Momo grounded, around the JUMP mark) or
 * 'release' (airborne, or past the jump moment: release J in green). Exported for tests.
 */
export function spikeCue(c, grounded, jumpMark = SPIKE_JUMP) {
  if (!grounded) return 'release';
  if (c < jumpMark - SPIKE_JUMP_SOON) return 'jump';
  if (c < jumpMark) return 'jumpSoon';
  if (c < jumpMark + SPIKE_JUMP_NOW) return 'jumpNow';
  return 'release';
}

/** Fallback spike verdict from a meter value when 'swing' carries no `timing`. Exported for tests. */
export function spikeResult(c, green = SPIKE_GREEN) {
  const [lo, hi] = green;
  if (c < lo) return 'early';
  if (c > hi) return 'late';
  return Math.abs(c - (lo + hi) / 2) <= (hi - lo) * 0.25 ? 'perfect' : 'good';
}
const SPIKE_LABEL = { perfect: 'PERFECT!', good: 'GOOD', early: 'EARLY', late: 'LATE!', none: 'no ball' };
const SPIKE_TONE = { perfect: 'green', good: 'green', early: 'dull', late: 'red', none: 'dull' };

// Pass/Set meter: fills on its own toward the contact moment; press K while it's green.
const PASS_GREEN = METER?.pass?.green ?? [0.75, 0.925];
const PASS_RESULT_MS = 450;
const PASS_VERDICT = {
  perfect: ['green', 'PERFECT!'], good: ['green', 'GOOD'],
  early: ['amber', 'EARLY'], late: ['amber', 'LATE'],
  tooEarly: ['red', 'TOO EARLY'], tooLate: ['red', 'TOO LATE'],
};
/** Fallback verdict from a meter value when passAttempt carries no `timing`. Exported for tests. */
export function passTimingFromMeter(c, green = PASS_GREEN) {
  if (typeof c !== 'number') return null;
  const [lo, hi] = green;
  if (c < lo - 0.25) return 'tooEarly';
  if (c < lo) return 'early';
  if (c > hi) return c >= 0.995 ? 'tooLate' : 'late';
  return Math.abs(c - (lo + hi) / 2) <= (hi - lo) * 0.25 ? 'perfect' : 'good';
}

const POPUP_MIN_SHOW_MS = 650; // a popup stays at least this long before a queued one replaces it
const POPUP_DEDUPE_MS = 600; // identical text within this window is dropped
const POPUP_QUEUE_MAX = 3;
const POPUP_OUT_MS = 260; // matches .cbv-pop.is-out animation
const HINT_MS = 5500;

const BALL_SVG = `<svg class="cbv-ball-svg" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="10.4" fill="#ffd43b"/>
  <path d="M12 1.6c-2.2 3.6-2.4 7.6.2 10.6 2.7 3 6.6 3.6 10.1 2.2" fill="none" stroke="#4dabf7" stroke-width="2.2"/>
  <path d="M2.4 8.2c3.9-1.4 7.8-.7 9.8 3.9 1.6 3.8.6 7.6-1.9 10.3" fill="none" stroke="#4dabf7" stroke-width="2.2"/>
  <path d="M4.5 18.6c2.4-2.6 4.6-4.4 7.7-6.4" fill="none" stroke="#ffffff" stroke-width="2"/>
  <circle cx="12" cy="12" r="10.4" fill="none" stroke="#3b2b3a" stroke-width="1.6"/>
</svg>`;

// Party popper icon (inline SVG so it renders without an emoji font).
const PARTY_SVG = `<svg class="cbv-party" viewBox="0 0 40 40" aria-label="party">
  <path d="M6 35 L14 12 L28 26 Z" fill="#ffd43b" stroke="#3b2b3a" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M10 24 L20 30 M12 18 L24 27" stroke="#ff8fab" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M20 9 q2 -5 6 -4 M29 14 q5 -2 7 1 M24 6 l1 -3" fill="none" stroke="#3b2b3a" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="33" cy="7" r="2.4" fill="#5ed3b5" stroke="#3b2b3a" stroke-width="1.4"/>
  <circle cx="35" cy="22" r="2.2" fill="#4dabf7" stroke="#3b2b3a" stroke-width="1.4"/>
  <rect x="16" y="2" width="4" height="4" rx="1" fill="#ff8fab" stroke="#3b2b3a" stroke-width="1.2" transform="rotate(20 18 4)"/>
</svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="2"/><rect x="13.8" y="5" width="4.2" height="14" rx="2"/></svg>`;
const ICON_SOUND = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_MUTED = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" stroke-linejoin="round"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const ICON_GLOBE = `<svg class="cbv-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="#c9f5e8" stroke="currentColor" stroke-width="2.2"/><path d="M3 12h18M12 2.8c-3.2 3.4-3.2 15 0 18.4M12 2.8c3.2 3.4 3.2 15 0 18.4" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>`;
const ICON_COPY = `<svg class="cbv-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="3" fill="#fff" stroke="currentColor" stroke-width="2.2"/><path d="M5 16V6a3 3 0 0 1 3-3h8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_CROWN = `<svg class="cbv-crown" viewBox="0 0 24 18" aria-label="Host"><path d="M2.5 15.5 3.5 4l5.2 5L12 2l3.3 7 5.2-5 1 11.5z" fill="#ffd43b" stroke="#3b2b3a" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.6" fill="#ff8fab"/></svg>`;

/** Tiny chibi face for a roster entry (TEAMS[t].players[i]) as inline SVG. */
function faceSVG(look) {
  const h = look.hair || '#5b3a29';
  const k = look.skin || '#ffe0c7';
  const ink = '#3b2b3a';
  const st = `stroke="${ink}" stroke-width="2" stroke-linejoin="round"`;
  let back = '';
  if (look.hairStyle === 'bun') back = `<circle cx="20" cy="6.5" r="5" fill="${h}" ${st}/>`;
  else if (look.hairStyle === 'pigtails') back = `<circle cx="5" cy="23" r="5" fill="${h}" ${st}/><circle cx="35" cy="23" r="5" fill="${h}" ${st}/>`;
  else if (look.hairStyle === 'bob') back = `<path d="M5.5 22a14.5 14.5 0 0 1 29 0v9h-5V22h-19v9h-5z" fill="${h}" ${st}/>`;
  else if (look.hairStyle === 'spiky') back = `<path d="M7 17 9 6l5 5 3-8 3.5 7L25 3l2.5 8L33 7l-1 10z" fill="${h}" ${st}/>`;
  return `<svg class="cbv-face" viewBox="0 0 40 40" aria-hidden="true">${back}
    <circle cx="20" cy="22.5" r="13.5" fill="${k}" ${st}/>
    <path d="M6.6 21.5A13.5 13.5 0 0 1 33.4 21.5C29 18.5 25 16.4 20 16.4S11 18.5 6.6 21.5z" fill="${h}" ${st}/>
    <circle cx="15" cy="25" r="1.9" fill="${ink}"/><circle cx="25" cy="25" r="1.9" fill="${ink}"/>
    <ellipse cx="11.6" cy="29" rx="2.6" ry="1.5" fill="#ff8fab" opacity="0.6"/><ellipse cx="28.4" cy="29" rx="2.6" ry="1.5" fill="#ff8fab" opacity="0.6"/>
    <path d="M18 29.2q2 2 4 0" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortName = (t) => TEAMS[t].name.replace(/^Team\s+/i, '');

/** Team that is one point from winning (given current score), or null. Exported for tests. */
export function matchPointTeam(score, rules = RULES) {
  for (const t of [0, 1]) {
    const me = score[t];
    const them = score[1 - t];
    const won = me >= rules.pointsToWin && me - them >= rules.winBy;
    if (won) return null;
    if (me + 1 >= rules.pointsToWin && me + 1 - them >= rules.winBy) return t;
  }
  return null;
}

/**
 * Popup spec for a 'hit' event, or null. Exported for tests.
 * me = this screen's player: { id, team } (offline Momo = { id: 0, team: 0 }); team null = spectator.
 */
export function hitPopup(p, me = { id: 0, team: 0 }) {
  if (!p) return null;
  const myId = me ? me.id : null;
  const myTeam = me && (me.team === 0 || me.team === 1) ? me.team : null;
  const ours = myTeam === null || p.team === myTeam;
  // My spikes are judged by the game's timing quality when it's reported; otherwise by power.
  const strong = p.playerId === myId && typeof p.quality === 'number' ? p.quality >= 0.8 : (p.power ?? 0) > 0.75;
  if (p.type === 'spike' && strong) {
    return ours
      ? { text: 'NICE SPIKE!', team: p.team, priority: 2 }
      : { text: 'Whoa!', team: p.team, priority: 2 };
  }
  if (p.type === 'block') return { text: 'BLOCK!', team: p.team, priority: 2 };
  // No quality popups for my passes/sets/digs: the pass meter verdict (PERFECT/GOOD/...) beside
  // my player already gives that feedback, and two messages at once read as mixed signals.
  // Praise digs only for my team; the other side digging constantly would be noisy.
  if (p.type === 'dig' && myTeam !== null && p.team === myTeam && p.playerId !== myId) return { text: 'Great dig!', team: p.team, priority: 1 };
  return null;
}

/** Popup spec for a 'point' event. Exported for tests. */
export function pointPopup(p, matchPoint = null) {
  const t = p.winnerTeam === 1 ? 1 : 0;
  const item = { text: `POINT ${shortName(t).toUpperCase()}!`, sub: REASON_TEXT[p.reason] ?? '', team: t, priority: 3, duration: 1700 };
  if (matchPoint === 0 || matchPoint === 1) {
    item.extra = `MATCH POINT ${shortName(matchPoint).toUpperCase()}`;
    item.extraTeam = matchPoint;
    item.duration = 2300;
  }
  return item;
}

export function createUI(rootEl, events, callbacks = {}) {
  const doc = rootEl.ownerDocument;
  const win = doc.defaultView;
  const now = () => (win.performance ? win.performance.now() : Date.now());
  const call = (name, ...args) => (typeof callbacks[name] === 'function' ? callbacks[name](...args) : undefined);

  // ---------- DOM ----------
  const root = doc.createElement('div');
  root.className = 'cbv';
  root.style.setProperty('--peach', TEAMS[0].color);
  root.style.setProperty('--peach-soft', TEAMS[0].accent);
  root.style.setProperty('--mint', TEAMS[1].color);
  root.style.setProperty('--mint-soft', TEAMS[1].accent);
  root.innerHTML = `
    <div class="cbv-layer cbv-menu-wrap">
      <div class="cbv-menu">
        <h1 class="cbv-title">
          <span class="cbv-title-ball">${BALL_SVG}<span class="cbv-title-shadow"></span></span>
          <span class="cbv-title-text"><span>Cute</span> <span>Beach</span> <span>Volley</span></span>
        </h1>
        <section class="cbv-panel cbv-menu-panel" aria-label="Main menu">
          <div class="cbv-menu-main">
            <div class="cbv-matchup">
              ${teamCard(0)}
              <div class="cbv-vs">VS</div>
              ${teamCard(1)}
            </div>
            <div class="cbv-diff" role="radiogroup" aria-label="Difficulty">
              ${DIFFS.map((d) => `<button type="button" class="cbv-btn cbv-diff-btn" role="radio" data-diff="${d}">
                  <span class="cbv-diff-label">${DIFF_INFO[d].label}</span><span class="cbv-diff-blurb">${DIFF_INFO[d].blurb}</span>
                </button>`).join('')}
            </div>
            <button type="button" class="cbv-btn cbv-btn-big cbv-start">Start! <kbd>Enter</kbd></button>
            <button type="button" class="cbv-btn cbv-online-btn">${ICON_GLOBE}<span>Play Online</span><span class="cbv-online-hint">with friends</span></button>
          </div>
          <div class="cbv-controls">
            <div class="cbv-controls-title">How to play</div>
            <div class="cbv-bigkeys"><span><kbd class="cbv-wide">SPACE</kbd> Jump</span><span class="cbv-dotsep">&middot;</span><span><kbd>K</kbd> Pass/Set</span><span class="cbv-dotsep">&middot;</span><span><kbd>J</kbd> Hit</span></div>
            <ul>
              <li><span class="cbv-keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd>&larr;</kbd><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd>&rarr;</kbd></span><span><b>Move</b> (up = toward the net)</span></li>
              <li><span class="cbv-keys"><kbd>K</kbd></span><span><b>Pass/Set:</b> press K when the meter hits <b class="cbv-green">GREEN</b> as the ball arrives (follow the landing marker). Bump on the 1st touch, set for Pip on the 2nd</span></li>
              <li><span class="cbv-keys"><kbd>K</kbd></span><span><b>Dive:</b> K when the ball is just out of reach</span></li>
              <li><span class="cbv-keys"><kbd class="cbv-wide">Space</kbd><span class="cbv-sep">then</span><kbd>J</kbd></span><span><b class="cbv-hl">Spike:</b> when Pip sets you, the spike meter follows the ball: SPACE at the <b>JUMP</b> mark, hold J and release it in the <b class="cbv-green">GREEN</b> (move keys aim)</span></li>
              <li><span class="cbv-keys"><span class="cbv-sep">hold</span><kbd>J</kbd></span><span><b>Serve:</b> hold to charge, release to serve (left/right aims)</span></li>
              <li><span class="cbv-keys"><kbd class="cbv-wide">Space</kbd></span><span><b>Block:</b> jump at the net when the CPU attacks (the block itself is automatic)</span></li>
              <li><span class="cbv-keys"><kbd>Esc</kbd><kbd>P</kbd><span class="cbv-sep">&middot;</span><kbd>M</kbd></span><span><b>Pause</b> &middot; <b>Mute</b></span></li>
            </ul>
            <p class="cbv-note">You play ${esc(TEAMS[0].players[0].name)}. ${esc(TEAMS[0].players[1].name)} is your CPU partner and plays their own touches.</p>
          </div>
        </section>
        <section class="cbv-panel cbv-online-panel" aria-label="Play online">
          <h2 class="cbv-online-title">${ICON_GLOBE}<span>Play Online</span></h2>
          <p class="cbv-online-sub">Up to 4 friends &middot; AI fills the empty spots</p>
          <label class="cbv-field cbv-name-field"><span class="cbv-field-label">Your name</span>
            <input class="cbv-input cbv-name-input" type="text" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" placeholder="Beach buddy" aria-label="Your name">
          </label>
          <div class="cbv-online-actions">
            <div class="cbv-online-card">
              <div class="cbv-card-title">New room</div>
              <button type="button" class="cbv-btn cbv-btn-big cbv-create">Create room</button>
              <div class="cbv-card-note">You'll get a code to share</div>
            </div>
            <div class="cbv-online-or">or</div>
            <div class="cbv-online-card">
              <div class="cbv-card-title">Join a friend</div>
              <div class="cbv-join-row">
                <input class="cbv-input cbv-code-input" type="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" aria-label="Room code" aria-describedby="cbv-code-err">
                <button type="button" class="cbv-btn cbv-join" disabled>Join</button>
              </div>
              <div class="cbv-card-note cbv-code-err" id="cbv-code-err" aria-live="polite">Ask the host for the 4-letter code</div>
            </div>
          </div>
          <div class="cbv-online-foot">
            <button type="button" class="cbv-btn cbv-online-back">Back <kbd>Esc</kbd></button>
          </div>
        </section>
      </div>
    </div>

    <div class="cbv-layer cbv-overlay cbv-lobby">
      <section class="cbv-panel cbv-lobby-panel" aria-label="Lobby">
        <div class="cbv-lobby-head">
          <div class="cbv-code-box">
            <span class="cbv-code-label">Room code</span>
            <span class="cbv-code" aria-live="polite"></span>
            <button type="button" class="cbv-btn cbv-copy" title="Copy room code">${ICON_COPY}<span class="cbv-copy-text">Copy</span></button>
          </div>
          <p class="cbv-lobby-sub"></p>
        </div>
        <div class="cbv-lobby-banner" aria-live="polite"></div>
        <div class="cbv-lobby-teams">
          ${[0, 1].map((t) => `<div class="cbv-lobby-team" data-team="${t}">
            <div class="cbv-lobby-team-name"><span class="cbv-chip"></span>${esc(TEAMS[t].name)}</div>
            <div class="cbv-slots">${[0, 1].map((i) => `<button type="button" class="cbv-slot" data-slot="${t * 2 + i}">
              <span class="cbv-slot-face">${faceSVG(TEAMS[t].players[i])}</span>
              <span class="cbv-slot-char">${esc(TEAMS[t].players[i].name)}</span>
              <span class="cbv-slot-who"></span>
              <span class="cbv-slot-act"></span>
            </button>`).join('')}</div>
          </div>`).join('<div class="cbv-vs">VS</div>')}
        </div>
        <div class="cbv-waiting"></div>
        <div class="cbv-lobby-foot">
          <div class="cbv-host-only">
            <div class="cbv-lobby-label">AI difficulty</div>
            <div class="cbv-diff cbv-lobby-diff" role="radiogroup" aria-label="AI difficulty">
              ${DIFFS.map((d) => `<button type="button" class="cbv-btn cbv-diff-btn" role="radio" data-diff="${d}">
                  <span class="cbv-diff-label">${DIFF_INFO[d].label}</span><span class="cbv-diff-blurb">${DIFF_INFO[d].blurb}</span>
                </button>`).join('')}
            </div>
            <button type="button" class="cbv-btn cbv-btn-big cbv-lobby-start">Start match! <kbd>Enter</kbd></button>
          </div>
          <button type="button" class="cbv-btn cbv-to-lobby cbv-host-only cbv-lobby-end">End match &amp; back to lobby</button>
          <div class="cbv-guest-only cbv-wait-host"><span class="cbv-wait-ball">${BALL_SVG}</span><span>Waiting for the host to start<span class="cbv-dots"><i>.</i><i>.</i><i>.</i></span></span></div>
          <div class="cbv-lobby-keys"><span><kbd class="cbv-wide">SPACE</kbd> Jump</span><span><kbd>K</kbd> Pass/Set</span><span><kbd>J</kbd> Hit</span><span><kbd>WASD</kbd> Move</span></div>
          <button type="button" class="cbv-btn cbv-leave">Leave room</button>
        </div>
      </section>
    </div>

    <div class="cbv-layer cbv-hud">
      <div class="cbv-score" aria-live="polite">
        <div class="cbv-score-team" data-team="0">
          <span class="cbv-serve-ball">${BALL_SVG}</span>
          <span class="cbv-score-you">YOU</span><span class="cbv-chip"></span><span class="cbv-score-name">${esc(shortName(0))}</span>
          <span class="cbv-score-num">0</span>
        </div>
        <span class="cbv-score-dash">&ndash;</span>
        <div class="cbv-score-team" data-team="1">
          <span class="cbv-score-num">0</span>
          <span class="cbv-score-name">${esc(shortName(1))}</span><span class="cbv-chip"></span><span class="cbv-score-you">YOU</span>
          <span class="cbv-serve-ball">${BALL_SVG}</span>
        </div>
      </div>
      <div class="cbv-touches" aria-label="Touches">
        <span class="cbv-touches-name"></span>
        <span class="cbv-dot"></span><span class="cbv-dot"></span><span class="cbv-dot"></span>
      </div>
      <div class="cbv-meter" aria-hidden="true">
        <div class="cbv-meter-label">POWER</div>
        <div class="cbv-meter-warn">LET GO!</div>
        <div class="cbv-meter-tube">
          <div class="cbv-meter-sweet"></div>
          <div class="cbv-meter-fill"></div>
        </div>
      </div>
      <div class="cbv-tags" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<div class="cbv-tag" data-team="${i < 2 ? 0 : 1}"><span class="cbv-tag-name"></span></div>`).join('')}</div>
      <div class="cbv-hint"><span class="cbv-hint-ball">${BALL_SVG}</span><span class="cbv-hint-lines">
        <span><b>Pass/Set:</b> press <kbd>K</kbd> when the meter hits <b class="cbv-green">GREEN</b> as the ball arrives</span>
        <span><b>Spike:</b> the meter follows the ball: <kbd>SPACE</kbd> at the <b>JUMP</b> mark, release <kbd>J</kbd> in the <b class="cbv-green">GREEN</b></span>
      </span></div>
    </div>

    <div class="cbv-layer cbv-popups" aria-live="polite"></div>
    <div class="cbv-layer cbv-toasts" role="status" aria-live="assertive"></div>

    <div class="cbv-corner">
      <div class="cbv-net" data-status="offline" title="Connection"><span class="cbv-net-dot"></span><span class="cbv-net-text">Offline</span></div>
      <button type="button" class="cbv-btn cbv-icon-btn cbv-pause-btn" aria-label="Pause" title="Pause (Esc / P)">${ICON_PAUSE}</button>
      <button type="button" class="cbv-btn cbv-icon-btn cbv-mute-btn" aria-label="Mute" title="Mute (M)"></button>
    </div>

    <div class="cbv-layer cbv-overlay cbv-pause">
      <section class="cbv-panel cbv-small-panel" aria-label="Paused">
        <h2 class="cbv-panel-title cbv-pause-title">Paused</h2>
        <p class="cbv-panel-sub cbv-pause-sub">Take a breather in the shade.</p>
        <p class="cbv-live-note cbv-on-only"><span class="cbv-live-dot"></span><span><b>Match continues&hellip;</b><small>Online games don't pause</small></span></p>
        <div class="cbv-btn-col">
          <button type="button" class="cbv-btn cbv-btn-big cbv-resume">Resume</button>
          <button type="button" class="cbv-btn cbv-restart cbv-off-only">Restart</button>
          <button type="button" class="cbv-btn cbv-quit cbv-off-only">Menu</button>
          <button type="button" class="cbv-btn cbv-to-lobby cbv-on-only cbv-host-only">Back to lobby</button>
          <button type="button" class="cbv-btn cbv-leave cbv-on-only">Leave room</button>
        </div>
      </section>
    </div>

    <div class="cbv-layer cbv-overlay cbv-over">
      <div class="cbv-confetti" aria-hidden="true"></div>
      <section class="cbv-panel cbv-small-panel" aria-label="Match over">
        <h2 class="cbv-panel-title cbv-over-title"></h2>
        <div class="cbv-final">
          <span class="cbv-final-team" style="color:var(--peach)">${esc(shortName(0))}</span>
          <span class="cbv-final-num cbv-final-a">0</span><span class="cbv-score-dash">&ndash;</span><span class="cbv-final-num cbv-final-b">0</span>
          <span class="cbv-final-team" style="color:var(--mint)">${esc(shortName(1))}</span>
        </div>
        <p class="cbv-panel-sub cbv-over-sub"></p>
        <div class="cbv-btn-col">
          <button type="button" class="cbv-btn cbv-btn-big cbv-again cbv-off-only">Play again <kbd>Enter</kbd></button>
          <button type="button" class="cbv-btn cbv-quit cbv-off-only">Menu</button>
          <button type="button" class="cbv-btn cbv-btn-big cbv-rematch cbv-on-only cbv-host-only">Rematch! <kbd>Enter</kbd></button>
          <button type="button" class="cbv-btn cbv-to-lobby cbv-on-only cbv-host-only">Back to lobby</button>
          <div class="cbv-wait-host cbv-on-only cbv-guest-only"><span class="cbv-wait-ball">${BALL_SVG}</span><span>Waiting for the host<span class="cbv-dots"><i>.</i><i>.</i><i>.</i></span></span></div>
          <button type="button" class="cbv-btn cbv-leave cbv-on-only cbv-guest-only">Leave room</button>
        </div>
      </section>
    </div>`;
  rootEl.appendChild(root);

  function teamCard(t) {
    const team = TEAMS[t];
    return `<div class="cbv-team-card" data-team="${t}">
      <div class="cbv-team-top"><span class="cbv-chip cbv-chip-big"></span><span class="cbv-you">${t === 0 ? 'YOU' : 'CPU'}</span></div>
      <div class="cbv-team-name">${esc(team.name)}</div>
      <div class="cbv-team-players">${t === 0
        ? `<span class="cbv-pl">${esc(team.players[0].name)} <span class="cbv-role">You</span></span><span class="cbv-pl">${esc(team.players[1].name)} <span class="cbv-role">CPU partner</span></span>`
        : team.players.map((p) => esc(p.name)).join(' &amp; ')}</div>
    </div>`;
  }

  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];
  const menuWrap = q('.cbv-menu-wrap');
  const hud = q('.cbv-hud');
  const popLayer = q('.cbv-popups');
  const pauseLayer = q('.cbv-pause');
  const overLayer = q('.cbv-over');
  const pauseBtn = q('.cbv-pause-btn');
  const muteBtn = q('.cbv-mute-btn');
  const diffBtns = qa('.cbv-menu-main .cbv-diff-btn');
  const startBtn = q('.cbv-start');
  const resumeBtn = q('.cbv-resume');
  const restartBtn = q('.cbv-restart');
  const againBtn = q('.cbv-again');
  const scoreTeams = qa('.cbv-score-team');
  const scoreNums = scoreTeams.map((el) => el.querySelector('.cbv-score-num'));
  const touchesEl = q('.cbv-touches');
  const touchesName = q('.cbv-touches-name');
  const dots = qa('.cbv-dot');
  const meter = q('.cbv-meter');
  const meterFill = q('.cbv-meter-fill');
  const hint = q('.cbv-hint');
  const overTitle = q('.cbv-over-title');
  const overSub = q('.cbv-over-sub');
  const finalA = q('.cbv-final-a');
  const finalB = q('.cbv-final-b');
  const confetti = q('.cbv-confetti');
  // online
  const onlineBtn = q('.cbv-online-btn');
  const nameInput = q('.cbv-name-input');
  const codeInput = q('.cbv-code-input');
  const codeErr = q('.cbv-code-err');
  const createBtn = q('.cbv-create');
  const joinBtn = q('.cbv-join');
  const lobbyLayer = q('.cbv-lobby');
  const codeEl = q('.cbv-code');
  const copyBtn = q('.cbv-copy');
  const copyText = q('.cbv-copy-text');
  const lobbySub = q('.cbv-lobby-sub');
  const lobbyBanner = q('.cbv-lobby-banner');
  const slotBtns = qa('.cbv-slot');
  const waitingEl = q('.cbv-waiting');
  const lobbyDiffBtns = qa('.cbv-lobby-diff .cbv-diff-btn');
  const lobbyStartBtn = q('.cbv-lobby-start');
  const rematchBtn = q('.cbv-rematch');
  const toastLayer = q('.cbv-toasts');
  const netChip = q('.cbv-net');
  const netText = q('.cbv-net-text');
  const pauseTitle = q('.cbv-pause-title');
  const pauseSub = q('.cbv-pause-sub');
  const scoreYou = scoreTeams.map((el) => el.querySelector('.cbv-score-you'));
  const tagEls = qa('.cbv-tag').map((el) => ({ el, name: el.querySelector('.cbv-tag-name'), text: null, on: false, x: null, y: null, w: 0, h: 0, rect: null }));

  q('.cbv-meter-sweet').style.cssText = `bottom:${SERVE_GREEN[0] * 100}%;height:${(SERVE_GREEN[1] - SERVE_GREEN[0]) * 100}%`;

  // ---------- small helpers ----------
  const shown = new Map();
  function show(el, on) {
    if (shown.get(el) === on) return;
    shown.set(el, on);
    el.classList.toggle('is-on', on);
    if (!on && el.contains(doc.activeElement)) doc.activeElement.blur();
  }
  function bump(el, cls = 'is-bump') {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }
  function focusSoon(el) {
    win.requestAnimationFrame(() => { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } });
  }

  // ---------- difficulty ----------
  let difficulty = 'normal';
  function selectDiff(d) {
    if (!DIFFS.includes(d)) return;
    difficulty = d;
    for (const b of diffBtns) {
      const on = b.dataset.diff === d;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  selectDiff(difficulty);

  // ---------- mute ----------
  let muted = false;
  try { muted = win.localStorage.getItem(MUTE_STORAGE_KEY) === '1'; } catch { /* ignore */ }
  function renderMute() {
    muteBtn.innerHTML = muted ? ICON_MUTED : ICON_SOUND;
    muteBtn.classList.toggle('is-muted', muted);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteBtn.setAttribute('aria-pressed', String(muted));
  }
  function toggleMute() {
    const r = call('onToggleMute');
    muted = typeof r === 'boolean' ? r : !muted;
    renderMute();
    bump(muteBtn, 'is-wiggle');
  }
  renderMute();

  // ---------- online state (docs/NETWORK.md) ----------
  let room = null; // the server's room object; null = offline
  let menuView = 'main'; // offline main menu sub-view: 'main' | 'online' (name + create/join)
  let pending = null; // 'create' | 'join' while waiting for the first room message
  let pendingTimer = 0;
  let netPaused = false; // online "pause": the overlay is open, the match keeps running
  let lobbyDiff = 'normal';
  let lobbyDiffRoom; // room.difficulty that lobbyDiff was last synced from
  let netStatus = { status: 'offline', ping: null };
  let me = { id: 0, team: 0 }; // this screen's player (refreshed every frame from state.controlledId)

  /** My slot (player id) in room `r`, or null (waiting in the lobby). */
  function mySlotOf(r) {
    if (!r) return null;
    const i = Array.isArray(r.slots) ? r.slots.indexOf(r.you) : -1;
    if (i >= 0 && i < 4) return i;
    const c = Array.isArray(r.clients) ? r.clients.find((x) => x && x.id === r.you) : null;
    return c && Number.isInteger(c.slot) && c.slot >= 0 && c.slot < 4 ? c.slot : null;
  }
  const isOwner = () => !!room && room.owner != null && room.owner === room.you;
  const isEditable = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable);

  // ---------- actions ----------
  let lastState = null;
  function start() {
    if (room || menuView !== 'main') return;
    if (lastState && lastState.phase !== 'menu') return;
    doc.activeElement?.blur?.();
    call('onStart', difficulty);
  }

  // Clicking a button: run the action, then blur so game keys (Space jump) can't re-trigger it later.
  // The UI deliberately ignores J/K (hit) and Space: those belong to the game.
  function onClick(el, fn) {
    el.addEventListener('click', (e) => { fn(e); el.blur(); });
  }
  for (const b of diffBtns) {
    onClick(b, () => selectDiff(b.dataset.diff));
    b.addEventListener('focus', () => selectDiff(b.dataset.diff));
  }
  onClick(startBtn, start);
  onClick(pauseBtn, () => (room ? openNetPause() : call('onPause')));
  onClick(muteBtn, toggleMute);
  onClick(resumeBtn, () => (room ? closeNetPause() : call('onResume')));
  onClick(restartBtn, () => call('onRestart'));
  onClick(againBtn, () => call('onRestart'));
  for (const b of qa('.cbv-quit')) onClick(b, () => call('onQuitToMenu'));

  // ----- online: entry panel (name + create / join) -----
  let savedName = '';
  try { savedName = win.localStorage.getItem(NAME_STORAGE_KEY) || ''; } catch { /* ignore */ }
  nameInput.value = savedName.slice(0, NAME_MAX);
  try {
    const qs = new win.URLSearchParams(win.location.search);
    const c = normalizeCode(qs.get('room') || '');
    if (c) codeInput.value = c;
  } catch { /* ignore */ }

  function cleanName() {
    return nameInput.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  }
  function saveName(n) {
    try { win.localStorage.setItem(NAME_STORAGE_KEY, n); } catch { /* ignore */ }
  }
  function renderMenuView() {
    menuWrap.dataset.view = menuView;
  }
  function openOnline() {
    if (room) return;
    menuView = 'online';
    renderMenuView();
    validateCode(false);
    call('onOnlineOpen');
    focusSoon(nameInput.value ? (codeInput.value ? joinBtn : createBtn) : nameInput);
  }
  function closeOnline() {
    menuView = 'main';
    setPending(null);
    renderMenuView();
    call('onOnlineClose');
    focusSoon(onlineBtn);
  }
  function validateCode(loud) {
    const raw = codeInput.value;
    const code = normalizeCode(raw);
    if (raw !== code) codeInput.value = code;
    const problem = codeProblem(code);
    joinBtn.disabled = !!problem || !!pending;
    let msg = 'Ask the host for the 4-letter code';
    let bad = false;
    if (code && problem && (loud || code.length === 4 || /[IO01]/.test(code))) { msg = problem; bad = true; }
    else if (code && problem) msg = `${4 - code.length} more letter${code.length === 3 ? '' : 's'}...`;
    else if (!problem) msg = 'Looks good!';
    codeErr.textContent = msg;
    codeErr.classList.toggle('is-err', bad);
    codeErr.classList.toggle('is-ok', !problem);
    codeInput.classList.toggle('is-err', bad);
    return problem ? null : code;
  }
  function setPending(kind) {
    pending = kind;
    win.clearTimeout(pendingTimer);
    if (kind) {
      pendingTimer = win.setTimeout(() => {
        if (pending && !room) toast("No answer from the server", 'Check your connection and try again');
        setPending(null);
      }, 10000);
    }
    createBtn.disabled = !!kind;
    createBtn.textContent = kind === 'create' ? 'Creating...' : 'Create room';
    joinBtn.textContent = kind === 'join' ? 'Joining...' : 'Join';
    createBtn.classList.toggle('is-busy', kind === 'create');
    joinBtn.classList.toggle('is-busy', kind === 'join');
    validateCode(false);
  }
  function doCreate() {
    if (pending || room) return;
    const name = cleanName();
    nameInput.value = name;
    saveName(name);
    setPending('create');
    call('onOnlineCreate', name);
  }
  function doJoin() {
    if (pending || room) return;
    const code = validateCode(true);
    if (!code) {
      bump(codeInput, 'is-shake');
      codeInput.focus({ preventScroll: true });
      return;
    }
    const name = cleanName();
    nameInput.value = name;
    saveName(name);
    setPending('join');
    call('onOnlineJoin', code, name);
  }
  onClick(onlineBtn, openOnline);
  onClick(q('.cbv-online-back'), closeOnline);
  onClick(createBtn, doCreate);
  onClick(joinBtn, doJoin);
  codeInput.addEventListener('input', () => validateCode(false));
  nameInput.addEventListener('change', () => saveName(cleanName()));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (normalizeCode(codeInput.value).length === 4) doJoin(); else doCreate(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOnline(); }
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOnline(); }
  });

  // ----- online: lobby -----
  function selectLobbyDiff(d) {
    if (!DIFFS.includes(d)) return;
    lobbyDiff = d;
    for (const b of lobbyDiffBtns) {
      const on = b.dataset.diff === d;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  selectLobbyDiff(lobbyDiff);
  for (const b of lobbyDiffBtns) onClick(b, () => selectLobbyDiff(b.dataset.diff));
  const humansIn = (r) => (r && Array.isArray(r.slots) ? r.slots.filter((x) => x != null).length : 0);
  function lobbyStart() {
    if (!room || !isOwner() || room.phase === 'playing') return;
    if (!humansIn(room)) { toast('Nobody is playing yet', 'Take a spot first!', 'info'); return; }
    call('onOnlineStart', lobbyDiff);
  }
  onClick(lobbyStartBtn, lobbyStart);
  onClick(rematchBtn, () => { if (room && isOwner()) call('onOnlineStart', DIFFS.includes(room.difficulty) ? room.difficulty : lobbyDiff); });
  for (const b of qa('.cbv-to-lobby')) onClick(b, () => { if (room && isOwner()) { netPaused = false; call('onOnlineToLobby'); } });
  for (const b of qa('.cbv-leave')) onClick(b, () => { if (room) { netPaused = false; call('onOnlineLeave'); } });
  for (const b of slotBtns) {
    onClick(b, () => {
      if (!room) return;
      const i = Number(b.dataset.slot);
      if (b.dataset.state === 'mine') call('onOnlineSlot', null);
      else if (b.dataset.state === 'free') call('onOnlineSlot', i);
      else bump(b, 'is-wiggle');
    });
  }
  let copyTimer = 0;
  async function copyCode() {
    const code = room && room.code;
    if (!code) return;
    let ok = false;
    try { await win.navigator.clipboard.writeText(code); ok = true; } catch { /* insecure context: fall back */ }
    if (!ok) {
      try {
        const ta = doc.createElement('textarea');
        ta.value = code;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
        root.appendChild(ta);
        ta.select();
        ok = doc.execCommand('copy');
        ta.remove();
      } catch { /* ignore */ }
    }
    copyText.textContent = ok ? 'Copied!' : 'Copy failed';
    copyBtn.classList.toggle('is-done', ok);
    bump(copyBtn, 'is-wiggle');
    win.clearTimeout(copyTimer);
    copyTimer = win.setTimeout(() => { copyText.textContent = 'Copy'; copyBtn.classList.remove('is-done'); }, 1600);
  }
  onClick(copyBtn, copyCode);

  function renderRoom() {
    root.classList.toggle('is-online', !!room);
    root.classList.toggle('is-host', isOwner());
    if (!room) return;
    const code = String(room.code || '').slice(0, 8);
    if (codeEl.dataset.code !== code) {
      codeEl.dataset.code = code;
      codeEl.innerHTML = [...code].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`).join('');
      codeEl.setAttribute('aria-label', `Room code ${code.split('').join(' ')}`);
    }
    const clients = Array.isArray(room.clients) ? room.clients.filter(Boolean) : [];
    const byId = new Map(clients.map((c) => [c.id, c]));
    const slots = Array.isArray(room.slots) ? room.slots : [];
    const mySlot = mySlotOf(room);
    const playing = room.phase === 'playing';
    slotBtns.forEach((b, i) => {
      const cid = slots[i] ?? null;
      const c = cid != null ? byId.get(cid) : null;
      const mine = cid != null && cid === room.you;
      const st = mine ? 'mine' : cid != null ? 'taken' : 'free';
      const look = TEAMS[i < 2 ? 0 : 1].players[i % 2];
      const name = c && c.name ? String(c.name).slice(0, 24) : 'Player';
      b.dataset.state = st;
      b.querySelector('.cbv-slot-who').innerHTML = cid != null
        ? `<span class="cbv-slot-name">${esc(name)}</span>${cid === room.owner ? ICON_CROWN : ''}${mine ? '<span class="cbv-you-badge">You</span>' : ''}`
        : '<span class="cbv-ai">AI</span>';
      b.querySelector('.cbv-slot-act').textContent = mine ? 'Click to leave' : st === 'free' ? (mySlot === null ? 'Click to play' : 'Click to switch') : '';
      b.setAttribute('aria-disabled', String(st === 'taken'));
      b.setAttribute('aria-label', `${look.name}: ${cid != null ? name : 'AI'}${mine ? ' (you, click to leave)' : st === 'free' ? ' (free, click to take)' : ''}`);
    });
    const waiting = clients.filter((c) => !slots.includes(c.id));
    waitingEl.innerHTML = waiting.length
      ? `<span class="cbv-waiting-label">Watching:</span>${waiting.map((c) => `<span class="cbv-wait-chip${c.id === room.you ? ' is-me' : ''}">${esc(String(c.name || 'Player').slice(0, 24))}${c.id === room.owner ? ICON_CROWN : ''}${c.id === room.you ? ' <b>(you)</b>' : ''}</span>`).join('')}`
      : '';
    waitingEl.classList.toggle('is-empty', !waiting.length);
    if (room.difficulty !== lobbyDiffRoom) {
      lobbyDiffRoom = room.difficulty;
      if (DIFFS.includes(room.difficulty)) selectLobbyDiff(room.difficulty);
    }
    const diffLabel = DIFF_INFO[room.difficulty]?.label ?? DIFF_INFO[lobbyDiff].label;
    const meLine = mySlot !== null
      ? `You're ${TEAMS[mySlot < 2 ? 0 : 1].players[mySlot % 2].name} on ${TEAMS[mySlot < 2 ? 0 : 1].name}`
      : 'Pick a spot to play!';
    lobbySub.textContent = isOwner() ? meLine : `${meLine} · AI: ${diffLabel}`;
    let banner = '';
    if (playing && mySlot === null) banner = 'Match in progress! Grab an AI spot and you jump in at the next point.';
    else if (playing) banner = 'Starting the match...';
    lobbyBanner.textContent = banner;
    lobbyBanner.classList.toggle('is-on', !!banner);
    lobbyLayer.classList.toggle('is-playing', playing);
    const n = humansIn(room);
    lobbyStartBtn.disabled = !n || playing;
    lobbyStartBtn.title = n ? '' : 'Someone needs to take a spot first';
  }

  function setRoom(r) {
    const prev = room;
    room = r && typeof r === 'object' && typeof r.code === 'string' ? r : null;
    if (room) {
      if (pending) setPending(null);
      if (prev && prev.owner !== room.owner && isOwner()) toast("You're the host now!", 'You can start matches and pick the AI level', 'info');
      if (!prev || prev.code !== room.code) lobbyDiffRoom = undefined;
      if (room.phase !== 'playing') netPaused = false;
    } else if (prev) {
      // left / disconnected: back to the online panel of the main menu
      menuView = 'online';
      netPaused = false;
      renderMenuView();
      setPending(null);
      active = false; // offline popups are driven by matchStart / menu again
      clearPopups();
      hintUntil = 0;
    }
    renderRoom();
  }

  // ----- online: connection status chip + error toasts -----
  function renderNet() {
    const { status, ping } = netStatus;
    netChip.dataset.status = status;
    let text = 'Offline';
    if (status === 'connecting') text = 'Connecting...';
    else if (status === 'online') text = Number.isFinite(ping) ? `Online · ${Math.round(ping)} ms` : 'Online';
    netText.textContent = text;
    netChip.dataset.ping = status !== 'online' || !Number.isFinite(ping) ? '' : ping < 90 ? 'good' : ping < 180 ? 'ok' : 'bad';
    netChip.title = netStatus.message ? `Connection: ${netStatus.message}` : 'Connection';
  }
  function setNetStatus(p) {
    if (!p || typeof p !== 'object') return;
    const st = p.status;
    if (st === 'error') {
      const code = errorCodeOf(p);
      const [title, sub] = code ? ERROR_TEXT[code] : [String(p.message || p.msg || 'Connection problem').slice(0, 80), ''];
      toast(title, sub, code === 'started' ? 'info' : 'error');
      if (code === 'noRoom' || code === 'full') {
        codeErr.textContent = title;
        codeErr.classList.add('is-err');
        bump(codeInput, 'is-shake');
      }
      setPending(null);
      if (netStatus.status === 'connecting') { netStatus = { status: 'offline', ping: null, message: p.message }; renderNet(); }
      return;
    }
    if (st !== 'connecting' && st !== 'online' && st !== 'offline') return;
    const prevSt = netStatus.status;
    const ping = Number.isFinite(p.ping) ? p.ping : st === 'online' ? netStatus.ping : null;
    netStatus = { status: st, ping, message: typeof p.message === 'string' ? p.message : '' };
    if (st === 'offline' && prevSt !== 'offline') {
      if (prevSt === 'online' && (room || menuView === 'online')) toast('Disconnected', netStatus.message || 'Lost the connection to the server');
      else if (prevSt === 'connecting' && pending) toast("Can't reach the server", netStatus.message || 'Is it running? Try again in a moment');
      setPending(null);
    }
    renderNet();
  }
  renderNet();

  const TOAST_MS = 3400;
  function toast(title, sub = '', tone = 'error') {
    for (const el of toastLayer.children) {
      if (el.dataset.title === title && !el.classList.contains('is-out')) {
        win.clearTimeout(Number(el.dataset.timer));
        el.dataset.timer = String(win.setTimeout(() => dropToast(el), TOAST_MS));
        bump(el, 'is-wiggle');
        return;
      }
    }
    const el = doc.createElement('div');
    el.className = 'cbv-toast';
    el.dataset.tone = tone;
    el.dataset.title = title;
    el.innerHTML = `<span class="cbv-toast-ico">${tone === 'error' ? '!' : 'i'}</span><span class="cbv-toast-body"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span>`;
    toastLayer.appendChild(el);
    while (toastLayer.children.length > 3) toastLayer.firstElementChild.remove();
    el.dataset.timer = String(win.setTimeout(() => dropToast(el), TOAST_MS));
  }
  function dropToast(el) {
    el.classList.add('is-out');
    win.setTimeout(() => el.remove(), 320);
  }

  // ----- online pause: the overlay opens but the match keeps running -----
  function openNetPause() {
    if (netPaused) return;
    netPaused = true;
    call('onPause');
  }
  function closeNetPause() {
    if (!netPaused) return;
    netPaused = false;
    call('onResume');
  }

  // Space must never activate our buttons (it's the jump key). preventDefault only stops
  // the button activation; the event still propagates to the game's window listener.
  const blockSpace = (e) => {
    if ((e.key === ' ' || e.code === 'Space') && e.target instanceof win.HTMLElement && e.target.closest('button')) e.preventDefault();
  };
  root.addEventListener('keydown', blockSpace);
  root.addEventListener('keyup', blockSpace);

  let ui = { lobby: false, inMatch: false }; // what update() last showed (for the key handler)
  win.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return; // typing a name / code: no shortcuts (inputs handle Enter/Esc)
    const s = lastState;
    const phase = s ? s.phase : 'menu';
    const onOurButton = e.target instanceof win.HTMLElement && root.contains(e.target) && e.target.closest('button');

    if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
      toggleMute();
      return;
    }
    if (room) {
      if (ui.lobby) {
        if (e.key === 'Enter' && !e.repeat && !onOurButton && isOwner()) { e.preventDefault(); lobbyStart(); }
        return;
      }
      if (!ui.inMatch) return;
      const pauseKey = e.key === 'Escape' || e.key === 'Esc' || e.key === 'p' || e.key === 'P';
      if (pauseKey && !e.repeat && phase !== 'matchOver') {
        if (netPaused) closeNetPause(); else openNetPause();
        return;
      }
      if (e.key === 'Enter' && !e.repeat && !onOurButton) {
        if (phase === 'matchOver') { if (isOwner()) { e.preventDefault(); rematchBtn.click(); } }
        else if (netPaused) { e.preventDefault(); closeNetPause(); }
      }
      return;
    }
    if (phase === 'menu') {
      if (menuView === 'online') {
        if (e.key === 'Escape') { e.preventDefault(); closeOnline(); }
        return;
      }
      if (e.key === 'Enter') {
        // Enter starts the offline match, unless a non-difficulty button (Play Online, mute) is focused
        if (onOurButton && !onOurButton.matches('.cbv-diff-btn, .cbv-start')) return;
        e.preventDefault();
        if (!e.repeat) start();
        return;
      }
      const i = DIFFS.indexOf(difficulty);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); selectDiff(DIFFS[Math.max(0, i - 1)]); focusDiff(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); selectDiff(DIFFS[Math.min(DIFFS.length - 1, i + 1)]); focusDiff(); }
      return;
    }
    if (e.key === 'Enter' && !e.repeat && !onOurButton) {
      if (phase === 'matchOver') { e.preventDefault(); call('onRestart'); }
      else if (s && s.paused) { e.preventDefault(); call('onResume'); }
    }
  });
  function focusDiff() {
    const b = diffBtns.find((x) => x.dataset.diff === difficulty);
    if (b && doc.activeElement !== b && root.contains(doc.activeElement)) b.focus({ preventScroll: true });
  }

  // ---------- popups ----------
  let active = false; // true between matchStart and menu: ignore attract-mode events otherwise
  let paused = false;
  let current = null; // { el, start, item }
  let queue = [];
  const recent = new Map(); // text -> time last enqueued
  let lastTick = now();

  function popup(item) {
    if (!active) return;
    const t = now();
    if (t - (recent.get(item.text) ?? -1e9) < POPUP_DEDUPE_MS) return;
    recent.set(item.text, t);
    item.priority ??= 1;
    item.duration ??= 1300;
    if (item.priority >= 3) {
      // Big moments clear the backlog of small stuff and take over immediately.
      queue = queue.filter((x) => x.priority >= 3);
      if (current && current.item.priority < 3) dismissCurrent();
    }
    queue.push(item);
    if (queue.length > POPUP_QUEUE_MAX) {
      // drop the oldest lowest-priority item
      let worst = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[worst].priority) worst = i;
      queue.splice(worst, 1);
    }
    pumpPopups();
  }

  let nextAllowedAt = 0; // don't show a new popup until the outgoing one has left
  function dismissCurrent() {
    if (!current) return;
    const el = current.el;
    current = null;
    nextAllowedAt = now() + POPUP_OUT_MS;
    el.classList.add('is-out');
    win.setTimeout(() => el.remove(), POPUP_OUT_MS + 40);
  }

  function showPopup(item) {
    const el = doc.createElement('div');
    el.className = `cbv-pop cbv-pop-p${item.priority}${item.small ? ' cbv-pop-small' : ''}`;
    if (item.team === 0 || item.team === 1) el.style.setProperty('--pop', TEAMS[item.team].color);
    el.innerHTML = `<div class="cbv-pop-text">${esc(item.text)}</div>`
      + (item.sub ? `<div class="cbv-pop-sub">${esc(item.sub)}</div>` : '')
      + (item.extra ? `<div class="cbv-pop-extra" style="--xc:${TEAMS[item.extraTeam ?? item.team].color}">${esc(item.extra)}</div>` : '');
    popLayer.appendChild(el);
    current = { el, start: now(), item };
  }

  function pumpPopups() {
    const t = now();
    if (current) {
      const age = t - current.start;
      // A queued popup only cuts the current one short if it's at least as important.
      const preempt = queue.length && age > POPUP_MIN_SHOW_MS && queue[0].priority >= current.item.priority;
      if (age > current.item.duration || preempt) dismissCurrent();
    }
    if (!current && queue.length && t >= nextAllowedAt) showPopup(queue.shift());
  }

  function clearPopups() {
    queue = [];
    recent.clear();
    if (current) dismissCurrent();
    popLayer.replaceChildren();
    current = null;
  }

  // ---------- hint ----------
  let hintShown = false; // once per page session, on the first rally
  let hintUntil = 0;

  // ---------- events ----------
  const on = (name, fn) => events && typeof events.on === 'function' && events.on(name, fn);
  on('matchStart', () => {
    active = true;
    clearPopups();
    doc.activeElement?.blur?.();
  });
  on('menu', () => {
    active = false;
    clearPopups();
    hintUntil = 0;
  });
  on('serveReady', (p) => {
    if (!p) return;
    // Offline the only human is Momo (id 0 = me.id). Online every human serves, so check it's MY serve.
    if (p.isHuman && p.playerId === me.id) {
      popup({ text: 'Your serve!', sub: 'Hold J, release to serve', team: p.team === 1 ? 1 : 0, priority: 2, duration: 2200 });
    } else if (p.team === 0 || p.team === 1) {
      // Say who serves so the player doesn't press J for a serve that isn't theirs. Kept small.
      const look = TEAMS[p.team].players[(p.playerId ?? 0) % 2];
      const pl = lastState && Array.isArray(lastState.players) ? lastState.players[p.playerId] : null;
      const human = pl && pl.human && typeof pl.name === 'string' && pl.name ? pl.name.slice(0, 16) : null;
      const who = human ?? (p.team === me.team ? (look ? look.name : shortName(p.team)) : shortName(p.team));
      popup({ text: `${who} serves`, team: p.team, priority: 1, duration: 1100, small: true });
    }
  });
  on('passAttempt', (p) => {
    if (active && p && p.playerId === me.id) pass.pending = { timing: p.timing, meter: p.meter };
  });
  on('swing', (p) => {
    if (active && p && p.playerId === me.id) spike.pending = { timing: p.timing, meter: p.meter };
  });
  on('hit', (p) => {
    const item = hitPopup(p, me);
    if (item) popup(item);
  });
  on('point', (p) => {
    if (!p) return;
    hintUntil = Math.min(hintUntil, now()); // the hint shouldn't compete with the point popup
    // MATCH POINT rides along as an extra line of the point popup (no second overlapping popup).
    popup(pointPopup(p, Array.isArray(p.score) ? matchPointTeam(p.score) : null));
  });
  let matchWinner = null;
  on('matchOver', (p) => { if (p) matchWinner = p.winnerTeam; });

  // ---------- per-frame update ----------
  const cache = {
    score0: null, score1: null, serving: null, possession: undefined, touches: null,
    charge: undefined, sweet: null, risk: undefined, phase: null, paused: null,
    online: undefined, lobby: undefined, mine: undefined,
  };

  // ---------- timing meters beside Momo: J SPIKE (right of the head), K PASS (left) ----------
  // One visual language: early | GREEN | late zones, saturated fill + needle, verdict flash.
  const meters = []; // both timing meters, so each can avoid the other
  let hudRects = []; // scoreboard + corner buttons, refreshed whenever a meter appears
  function measureHud() {
    hudRects = [q('.cbv-score'), q('.cbv-corner')].map((e) => {
      const r = e.getBoundingClientRect();
      return [r.left - 4, r.top - 4, r.right + 4, r.bottom + 4];
    }).filter((r) => r[2] > r[0]);
  }
  const EDGE = 8;
  const LABEL_ROOM = 112;
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const overlapArea = (l, t, r, b, o) => Math.max(0, Math.min(r, o[2]) - Math.max(l, o[0])) * Math.max(0, Math.min(b, o[3]) - Math.max(t, o[1]));
  function createTimingMeter({ kind, key, name, green, side, barExtra = '', wrapExtra = '' }) {
    const el = doc.createElement('div');
    el.className = `cbv-tm cbv-tm-${kind}`;
    el.setAttribute('aria-hidden', 'true');
    const [lo, hi] = green;
    const zones = `<i class="z-early" style="bottom:0;height:${lo * 100}%"></i>`
      + `<i class="z-green" style="bottom:${lo * 100}%;height:${(hi - lo) * 100}%"></i>`
      + `<i class="z-late" style="bottom:${hi * 100}%;height:${(1 - hi) * 100}%"></i>`;
    el.innerHTML = `<div class="cbv-tm-col"><div class="cbv-tm-key"><kbd>${key}</kbd>${name}</div>`
      + `<div class="cbv-tm-barwrap"><div class="cbv-tm-bar"><div class="cbv-tm-zones">${zones}</div>`
      + `<div class="cbv-tm-fill"><div class="cbv-tm-zones">${zones}</div></div>${barExtra}<div class="cbv-tm-needle"></div></div>`
      + `${wrapExtra}</div></div>`
      + '<div class="cbv-tm-label"></div>';
    hud.appendChild(el);
    const label = el.querySelector('.cbv-tm-label');
    const m = { on: false, charge: null, zone: null, until: 0, x: null, y: null, rx: null, ry: null, w: 32, h: 130, cand: null, curSide: null, lastT: 0 };

    // Placement: score four spots (preferred side / other side x beside head / lower beside body),
    // avoiding Pip, the ball and the other meter, keeping the column and its verdict label fully on
    // screen. A stickiness bonus stops flip-flopping and the position glides to the chosen spot.
    function place(view) {
      const t = now();
      const W = win.innerWidth || 800;
      const H = win.innerHeight || 600;
      const s = Math.max(0.6, Math.min(1.6, H / 720));
      const ms = view && view.momoScreen;
      const pip = view && view.pipScreen;
      const ball = view && view.ballScreen;
      const hx = ms ? ms.x : W * 0.5;
      const hy = ms ? ms.y : H * 0.55;
      const obstacles = [];
      if (pip) obstacles.push([pip.x - 30 * s, pip.y - 10 * s, pip.x + 30 * s, pip.y + 88 * s, 2]);
      if (ball) { const br = 20 * s + 10; obstacles.push([ball.x - br, ball.y - br, ball.x + br, ball.y + br, 4]); }
      for (const o of meters) if (o !== api && o.on && o.rect) obstacles.push([...o.rect, 1.5]);
      for (const tg of tagEls) if (tg.on && tg.rect) obstacles.push([...tg.rect, 1]); // other humans' name tags
      for (const r of hudRects) obstacles.push([...r, 1.5]);
      let best = null;
      for (const sd of [side, side === 'right' ? 'left' : 'right']) {
        for (const lvl of ['head', 'body']) {
          const dx = (lvl === 'head' ? 30 : 38) * s;
          const left = sd === 'right' ? hx + dx : hx - dx - m.w;
          const top = lvl === 'head' ? hy - 26 * s : hy + 24 * s;
          const cl = clampN(left, EDGE, W - EDGE - m.w);
          const ct = clampN(top, EDGE, H - EDGE - m.h);
          const key = sd + lvl;
          let cost = (sd === side ? 0 : 140) + (lvl === 'head' ? 0 : 45);
          cost += (Math.abs(cl - left) + Math.abs(ct - top)) * 3; // had to be pushed back on screen
          const room = sd === 'right' ? W - EDGE - (cl + m.w) : cl - EDGE;
          if (room < LABEL_ROOM) cost += 80; // verdict label would be cut off
          for (const o of obstacles) {
            const a = overlapArea(cl, ct, cl + m.w, ct + m.h, o);
            if (a > 0) cost += (100 + a * 0.25) * o[4]; // any contact counts, more overlap costs more
          }
          if (key === m.cand) cost -= 50;
          if (!best || cost < best.cost) best = { key, sd, cl, ct, cost };
        }
      }
      m.cand = best.key;
      if (best.sd !== m.curSide) {
        m.curSide = best.sd;
        el.classList.toggle('is-left', best.sd === 'left');
      }
      const dt = m.lastT ? Math.min(0.1, (t - m.lastT) / 1000) : 0;
      m.lastT = t;
      if (m.x === null) {
        m.x = best.cl;
        m.y = best.ct;
      } else {
        const k = 1 - Math.exp(-dt * 14);
        m.x += (best.cl - m.x) * k;
        m.y += (best.ct - m.y) * k;
      }
      m.x = clampN(m.x, EDGE, W - EDGE - m.w);
      m.y = clampN(m.y, EDGE, H - EDGE - m.h);
      api.rect = [m.x, m.y, m.x + m.w, m.y + m.h];
      const rx = Math.round(m.x);
      const ry = Math.round(m.y);
      if (rx !== m.rx || ry !== m.ry) {
        m.rx = rx;
        m.ry = ry;
        el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      }
    }
    function measure() {
      m.w = el.offsetWidth || m.w;
      m.h = el.offsetHeight || m.h;
    }
    function show() {
      if (m.on && !m.until) return;
      if (!m.on) { m.x = null; m.lastT = 0; measure(); measureHud(); }
      m.on = true;
      m.until = 0;
      el.classList.remove('is-result');
      delete el.dataset.tone;
      el.classList.add('is-on');
    }
    function set(c, view) {
      show();
      if (c !== m.charge) {
        m.charge = c;
        el.style.setProperty('--c', c.toFixed(3));
        const zone = c < lo ? (c >= lo - 0.18 ? 'near' : 'early') : c > hi ? 'late' : 'green';
        if (zone !== m.zone) { m.zone = zone; el.dataset.zone = zone; }
      }
      place(view);
    }
    function flash(tone, text, ms, t, view, c = null) {
      if (!m.on) { m.x = null; m.lastT = 0; measure(); }
      if (typeof c === 'number') { m.charge = c; el.style.setProperty('--c', c.toFixed(3)); }
      el.classList.add('is-on');
      el.classList.remove('is-result');
      void el.offsetWidth; // restart the flash animation
      el.dataset.tone = tone;
      label.textContent = text;
      el.classList.add('is-result');
      m.on = true;
      m.until = t + ms;
      place(view);
    }
    function tick(t, view) {
      if (!m.until) return;
      place(view);
      if (t >= m.until) hide();
    }
    function hide() {
      m.on = false;
      m.until = 0;
      m.zone = null;
      m.charge = null;
      el.classList.remove('is-on', 'is-result');
      delete el.dataset.zone;
      delete el.dataset.tone;
    }
    const api = { el, set, flash, tick, hide, rect: null, get on() { return m.on; }, get flashing() { return !!m.until; } };
    meters.push(api);
    return api;
  }

  // Spike meter extras: a JUMP mark (Space) on the bar at METER.spike.jumpMark, a tag beside it, and a
  // "J" release tag beside the green zone. data-cue on the meter switches the emphasis between them.
  const [sgLo, sgHi] = SPIKE_GREEN;
  const SPACE_GLYPH = '<svg viewBox="0 0 20 10" aria-hidden="true"><path d="M2 2v5h16V2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const spikeMeter = createTimingMeter({
    kind: 'spike', key: 'J', name: 'SPIKE', green: SPIKE_GREEN, side: 'right',
    barExtra: `<div class="cbv-tm-jumpline" style="bottom:${(SPIKE_JUMP * 100).toFixed(2)}%"></div>`,
    wrapExtra: `<div class="cbv-tm-tag cbv-tm-jumptag" style="--at:${SPIKE_JUMP.toFixed(3)}"><kbd class="cbv-tm-space">${SPACE_GLYPH}</kbd><span>JUMP<b>!</b></span></div>`
      + `<div class="cbv-tm-tag cbv-tm-reltag" style="--at:${((sgLo + sgHi) / 2).toFixed(3)}"><kbd>J</kbd><span class="cbv-tm-rel-hit">HIT!</span><span class="cbv-tm-rel-go">LET GO!</span></div>`,
  });
  const passMeter = createTimingMeter({ kind: 'pass', key: 'K', name: 'PASS', green: PASS_GREEN, side: 'left' });
  const spike = { last: null, spent: false, pending: null, cue: null, held: null };
  const pass = { last: null, spent: false, pending: null };

  function setSpikeCue(cue) {
    if (cue === spike.cue) return;
    spike.cue = cue;
    if (cue) spikeMeter.el.dataset.cue = cue;
    else delete spikeMeter.el.dataset.cue;
  }
  function setSpikeHeld(held) {
    if (held === spike.held) return;
    spike.held = held;
    spikeMeter.el.classList.toggle('is-held', held);
  }

  function updateSpike(state, view, t) {
    // Ball-synced: shown whenever state.spikeMeter is a number (undefined before the game side lands).
    const sm = typeof state.spikeMeter === 'number' ? Math.max(0, Math.min(1, state.spikeMeter)) : null;
    const mine = Array.isArray(state.players) && me.id !== null ? state.players[me.id] : null;
    const grounded = mine ? mine.grounded !== false : true;
    setSpikeHeld(typeof state.hitCharge === 'number'); // wind-up: J glyph pressed (no second needle)
    if (spike.pending) {
      // A 'swing' arrived since the last frame: flash the game's verdict.
      const p = spike.pending;
      spike.pending = null;
      const timing = p.timing || (typeof p.meter === 'number' ? spikeResult(p.meter) : null);
      if (timing && SPIKE_LABEL[timing]) {
        const c = typeof p.meter === 'number' ? Math.max(0, Math.min(1, p.meter)) : timing === 'none' ? 0 : null;
        setSpikeCue(null);
        spikeMeter.el.classList.toggle('is-small', timing === 'none');
        spikeMeter.flash(SPIKE_TONE[timing], SPIKE_LABEL[timing], timing === 'none' ? 380 : SPIKE_RESULT_MS, t, view, c);
        if (timing !== 'none') spike.spent = true;
      }
    }
    if (sm === null) {
      spike.spent = false; // ball contacted / gone: the next attack ball gets a fresh meter
      spike.last = null;
      if (spikeMeter.on && !spikeMeter.flashing) spikeMeter.hide();
      if (!spikeMeter.flashing) setSpikeCue(null);
    } else {
      // Soft tick as the needle crosses the JUMP mark while Momo is still on the sand.
      if (spike.last !== null && spike.last < SPIKE_JUMP && sm >= SPIKE_JUMP && grounded && !spike.spent) playCue('jumpMark');
      spike.last = sm;
      if (!spike.spent) {
        if (spikeMeter.el.classList.contains('is-small')) spikeMeter.el.classList.remove('is-small');
        setSpikeCue(spikeCue(sm, grounded));
        spikeMeter.set(sm, view);
      }
    }
    spikeMeter.tick(t, view);
  }

  function updatePass(state, view, t) {
    const pm = typeof state.passMeter === 'number' ? Math.max(0, Math.min(1, state.passMeter)) : null;
    if (pass.pending) {
      // A passAttempt arrived since the last frame: flash its verdict (one press per ball).
      const timing = pass.pending.timing || passTimingFromMeter(pass.pending.meter ?? pass.last);
      pass.pending = null;
      if (timing && PASS_VERDICT[timing]) {
        const [tone, text] = PASS_VERDICT[timing];
        passMeter.flash(tone, text, PASS_RESULT_MS, t, view);
        pass.spent = true;
      }
    }
    if (pm === null) {
      pass.spent = false; // ball contacted / gone: the next incoming ball gets a fresh meter
      pass.last = null;
      if (passMeter.on && !passMeter.flashing) passMeter.hide();
    } else {
      pass.last = pm;
      if (!pass.spent) passMeter.set(pm, view);
    }
    passMeter.tick(t, view);
  }

  function hideMeters() {
    spikeMeter.hide();
    passMeter.hide();
    spike.last = null;
    spike.spent = false;
    spike.pending = null;
    setSpikeCue(null);
    setSpikeHeld(false);
    pass.last = null;
    pass.spent = false;
    pass.pending = null;
  }

  // ---------- name tags above the OTHER human players (online) ----------
  function roomNameFor(i) {
    if (!room || !Array.isArray(room.slots) || !Array.isArray(room.clients)) return null;
    const cid = room.slots[i];
    const c = cid != null ? room.clients.find((x) => x && x.id === cid) : null;
    return c && c.name ? String(c.name) : null;
  }
  function updateTags(state, view, on) {
    const screens = view && Array.isArray(view.playerScreens) ? view.playerScreens : null;
    const W = win.innerWidth || 800;
    const H = win.innerHeight || 600;
    const sc = Math.max(0.7, Math.min(1.3, H / 720));
    const meterRects = [];
    for (const m of meters) if (m.on && m.rect) meterRects.push(m.rect);
    for (let i = 0; i < 4; i++) {
      const tg = tagEls[i];
      const p = on && screens && Array.isArray(state.players) ? state.players[i] : null;
      const at = screens ? screens[i] : null;
      if (!(p && p.human && i !== me.id && at && Number.isFinite(at.x) && Number.isFinite(at.y))) {
        if (tg.on) { tg.on = false; tg.rect = null; tg.el.classList.remove('is-on'); }
        continue;
      }
      const team = p.team === 1 ? 1 : p.team === 0 ? 0 : i < 2 ? 0 : 1;
      const raw = (typeof p.name === 'string' && p.name.trim()) || roomNameFor(i) || TEAMS[team].players[i % 2].name;
      const text = String(raw).trim().slice(0, 16);
      if (text !== tg.text) { tg.text = text; tg.name.textContent = text; tg.w = 0; }
      if (tg.el.dataset.team !== String(team)) tg.el.dataset.team = String(team);
      if (!tg.on) { tg.on = true; tg.el.classList.add('is-on'); tg.w = 0; }
      if (!tg.w) { tg.w = tg.el.offsetWidth || 60; tg.h = tg.el.offsetHeight || 22; }
      let x = at.x - tg.w / 2;
      let y = at.y - tg.h - 8 * sc;
      const y0 = y;
      // never cover my timing meters: hop above (or below) a meter it would overlap
      for (const r of meterRects) {
        if (x < r[2] + 4 && x + tg.w > r[0] - 4 && y < r[3] + 4 && y + tg.h > r[1] - 4) {
          const up = r[1] - tg.h - 6;
          y = up >= EDGE ? up : r[3] + 6;
        }
      }
      x = clampN(x, EDGE, W - EDGE - tg.w);
      y = clampN(y, EDGE, H - EDGE - tg.h);
      tg.rect = [x, y, x + tg.w, y + tg.h];
      const moved = Math.abs(y - y0) > 2;
      if (moved !== tg.moved) { tg.moved = moved; tg.el.classList.toggle('is-moved', moved); }
      const rx = Math.round(x);
      const ry = Math.round(y);
      if (rx !== tg.x || ry !== tg.y) {
        tg.x = rx;
        tg.y = ry;
        tg.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      }
    }
  }

  function update(state, view) {
    if (!state) return;
    lastState = state;
    const t = now();
    const phase = state.phase;
    const online = !!room;
    const mySlot = online ? mySlotOf(room) : null;
    const matchPhase = phase === 'serve' || phase === 'rally' || phase === 'point' || phase === 'matchOver';
    const roomPlaying = online && room.phase === 'playing';
    // Online the HUD belongs to a running room match; the lobby shows otherwise, and over the match for
    // clients without a slot (joined mid-match: they can grab an AI spot at the next point).
    const inMatch = matchPhase && (!online || roomPlaying);
    const lobbyOn = online && (!roomPlaying || mySlot === null || !matchPhase);

    // This screen's player: state.controlledId (0 = Momo offline; online = my slot, null without one).
    const cid = state.controlledId;
    const validId = Number.isInteger(cid) && cid >= 0 && cid < 4;
    const ctl = online ? (mySlot === null ? null : validId ? cid : mySlot) : validId ? cid : 0;
    const mp = ctl !== null && Array.isArray(state.players) ? state.players[ctl] : null;
    const team = ctl === null ? null : mp && (mp.team === 0 || mp.team === 1) ? mp.team : ctl < 2 ? 0 : 1;
    if (me.id !== ctl || me.team !== team) me = { id: ctl, team };
    setAudioPerspective({ team: team ?? 0, live: online && inMatch && phase !== 'matchOver' });
    if (online && active !== inMatch) {
      // online there may be no matchStart/menu event for us (joined mid-match, back to lobby)
      active = inMatch;
      if (!active) { clearPopups(); hintUntil = 0; }
    }

    // Offline pause freezes the sim; online "pause" only opens the overlay (the match keeps running).
    const offPaused = !online && !!state.paused && inMatch && phase !== 'matchOver';
    if (netPaused && (!online || !inMatch || phase === 'matchOver' || lobbyOn)) netPaused = false;
    const isPaused = online ? netPaused : offPaused;

    // Freeze popup timers while paused (offline only).
    if (offPaused && current) current.start += t - lastTick;
    if (offPaused && hintUntil) hintUntil += t - lastTick;
    lastTick = t;

    const menuOn = !online && phase === 'menu';
    show(menuWrap, menuOn);
    show(lobbyLayer, lobbyOn);
    show(hud, inMatch);
    show(pauseBtn, inMatch && phase !== 'matchOver' && !isPaused && !lobbyOn);
    show(pauseLayer, isPaused);
    show(overLayer, inMatch && phase === 'matchOver' && !lobbyOn);
    show(netChip, online || (menuOn && menuView === 'online'));
    ui = { lobby: lobbyOn, inMatch: inMatch && !lobbyOn };
    if (offPaused !== paused) {
      paused = offPaused;
      root.classList.toggle('is-paused', paused);
    }
    if (online !== cache.online) {
      cache.online = online;
      pauseTitle.textContent = online ? 'Menu' : 'Paused';
      resumeBtn.textContent = online ? 'Back to the game' : 'Resume';
    }
    if (lobbyOn !== cache.lobby) {
      cache.lobby = lobbyOn;
      if (lobbyOn && isOwner() && !roomPlaying) focusSoon(lobbyStartBtn);
      else if (!lobbyOn && lobbyLayer.contains(doc.activeElement)) doc.activeElement.blur();
    }

    if (phase !== cache.phase) {
      const prev = cache.phase;
      cache.phase = phase;
      if (phase === 'menu') {
        if (!online && prev && prev !== 'menu') focusSoon(diffBtns.find((b) => b.dataset.diff === difficulty));
      } else if (prev === 'menu' || prev === null) {
        doc.activeElement?.blur?.();
      }
      if (phase === 'matchOver' && inMatch) showGameOver(state);
      if (phase === 'rally' && !hintShown && active) {
        hintShown = true;
        hintUntil = t + HINT_MS;
      }
    }
    if (cache.paused !== isPaused) {
      cache.paused = isPaused;
      if (isPaused) focusSoon(resumeBtn);
    }

    if (inMatch) {
      const s0 = state.score?.[0] ?? 0;
      const s1 = state.score?.[1] ?? 0;
      if (s0 !== cache.score0) { const first = cache.score0 === null; cache.score0 = s0; scoreNums[0].textContent = s0; if (!first && s0 > 0) bump(scoreNums[0]); }
      if (s1 !== cache.score1) { const first = cache.score1 === null; cache.score1 = s1; scoreNums[1].textContent = s1; if (!first && s1 > 0) bump(scoreNums[1]); }
      if (state.servingTeam !== cache.serving) {
        cache.serving = state.servingTeam;
        scoreTeams.forEach((el, i) => el.classList.toggle('is-serving', i === state.servingTeam));
      }
      // Online: mark which team is mine (offline keeps the plain "Peach - Mint").
      const mine = online ? team : null;
      if (mine !== cache.mine) {
        cache.mine = mine;
        scoreTeams.forEach((el, i) => el.classList.toggle('is-mine', i === mine));
        scoreYou.forEach((el, i) => el.classList.toggle('is-on', i === mine));
      }

      const pt = state.possessionTeam === 0 || state.possessionTeam === 1 ? state.possessionTeam : null;
      if (pt !== cache.possession || phase !== cache.touchPhase) {
        cache.touchPhase = phase;
        cache.possession = pt;
        touchesEl.classList.toggle('is-on', pt !== null && phase !== 'matchOver');
        if (pt !== null) {
          touchesEl.style.setProperty('--team', TEAMS[pt].color);
          touchesName.textContent = shortName(pt);
        }
      }
      const tc = Math.max(0, Math.min(RULES.maxTouches, state.touches | 0));
      if (tc !== cache.touches) {
        const grew = cache.touches !== null && tc > cache.touches;
        cache.touches = tc;
        dots.forEach((d, i) => d.classList.toggle('is-filled', i < tc));
        if (grew && tc > 0) bump(dots[tc - 1], 'is-pop');
      }

      const ch = ctl !== null && typeof state.serveCharge === 'number' ? Math.max(0, Math.min(1, state.serveCharge)) : null;
      if (ch !== cache.charge) {
        cache.charge = ch;
        meter.classList.toggle('is-on', ch !== null);
        if (ch !== null) {
          meterFill.style.transform = `scaleY(${ch})`;
          const zone = ch >= SERVE_GREEN[0] && ch <= SERVE_GREEN[1] ? 'sweet' : 'low';
          if (zone !== cache.sweet) {
            cache.sweet = zone;
            meter.dataset.zone = zone;
          }
        }
      }
      // Overhold risk, quantized so we only touch the DOM on visible changes.
      const risk = ch === null ? 0 : Math.round(Math.max(0, Math.min(1, Number(state.serveRisk) || 0)) * 20) / 20;
      if (risk !== cache.risk) {
        cache.risk = risk;
        meter.style.setProperty('--risk', risk);
        meter.style.setProperty('--shake', `${(1 + risk * 4).toFixed(1)}px`);
        meter.classList.toggle('is-risky', risk > 0);
      }
    } else if (cache.score0 !== null) {
      // reset so the next match renders fresh without bump animations
      cache.score0 = cache.score1 = cache.serving = cache.touches = null;
      cache.possession = undefined;
      cache.charge = undefined;
      cache.risk = undefined;
      cache.mine = undefined;
    }

    const bigPopup = !!current && current.item.priority >= 3;
    const hintOn = hintUntil > t && inMatch && phase !== 'matchOver' && !bigPopup && !lobbyOn;
    if (!hintOn && hintUntil && hintUntil <= t) hintUntil = 0;
    show(hint, hintOn);

    if (inMatch && phase !== 'matchOver' && !offPaused && ctl !== null) {
      updateSpike(state, view, t);
      updatePass(state, view, t);
    } else if (!offPaused && (spikeMeter.on || passMeter.on)) {
      hideMeters();
    }
    updateTags(state, view, inMatch && phase !== 'matchOver');

    if (!offPaused) pumpPopups();
  }

  function showGameOver(state) {
    const score = state.score || [0, 0];
    const winner = matchWinner ?? (score[0] >= score[1] ? 0 : 1);
    matchWinner = null;
    const myT = me.team === 1 ? 1 : 0;
    const won = winner === myT;
    clearPopups();
    hintUntil = 0;
    overLayer.classList.toggle('is-win', won);
    overTitle.innerHTML = won ? `You win! ${PARTY_SVG}` : 'So close!';
    const again = room ? (isOwner() ? ' Rematch?' : '') : ' Rematch?';
    overSub.textContent = won ? `${TEAMS[myT].name} rules the beach!` : `${TEAMS[1 - myT].name} takes this one.${again}`;
    finalA.textContent = score[0];
    finalB.textContent = score[1];
    confetti.replaceChildren();
    if (won) {
      const colors = [TEAMS[0].color, TEAMS[1].color, '#ffd43b', '#4dabf7', '#ffffff', TEAMS[0].accent];
      for (let i = 0; i < 36; i++) {
        const c = doc.createElement('i');
        c.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};`
          + `animation-delay:${(Math.random() * 1.2).toFixed(2)}s;animation-duration:${(2.4 + Math.random() * 1.8).toFixed(2)}s;`
          + `--rot:${Math.round(Math.random() * 720 - 360)}deg;--drift:${Math.round(Math.random() * 120 - 60)}px`;
        confetti.appendChild(c);
      }
    }
    if (!room) focusSoon(againBtn);
    else if (isOwner()) focusSoon(rematchBtn);
  }

  const api = {
    update,
    setRoom,
    setNetStatus,
    /** Show an error toast directly: a NETWORK.md error code ('noRoom', 'full', ...) or a message. */
    showError(codeOrMsg) { setNetStatus({ status: 'error', message: String(codeOrMsg ?? '') }); },
  };
  try { win.__volleyUI = api; } catch { /* debug/test hook only */ }
  return api;
}
