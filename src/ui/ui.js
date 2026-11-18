// DOM/CSS overlay for Cute Beach Volley: main menu, HUD (scoreboard, touch counter, serve meter,
// pause/mute buttons), juicy popups, first-time hint, pause and game-over screens.
// Contract: docs/ARCHITECTURE.md -> createUI(rootEl, events, callbacks) -> { update(state) }.
// Nothing here touches window/document at import time; everything happens inside createUI.
import './ui.css';
import { TEAMS, RULES, METER } from '../config.js';
import { MUTE_STORAGE_KEY, playCue } from '../audio/audio.js';

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

/** Popup spec for a 'hit' event, or null. Exported for tests. */
export function hitPopup(p) {
  if (!p) return null;
  // Momo's spikes are judged by the game's timing quality when it's reported; otherwise by power.
  const strong = p.team === 0 && p.playerId === 0 && typeof p.quality === 'number' ? p.quality >= 0.8 : (p.power ?? 0) > 0.75;
  if (p.type === 'spike' && strong) {
    return p.team === 0
      ? { text: 'NICE SPIKE!', team: 0, priority: 2 }
      : { text: 'Whoa!', team: 1, priority: 2 };
  }
  if (p.type === 'block') return { text: 'BLOCK!', team: p.team, priority: 2 };
  // No quality popups for Momo's passes/sets/digs: the pass meter verdict (PERFECT/GOOD/...) beside
  // Momo already gives that feedback, and two messages at once read as mixed signals.
  // Praise digs only for the player's team; the CPU digging constantly would be noisy.
  if (p.type === 'dig' && p.team === 0 && p.playerId !== 0) return { text: 'Great dig!', team: 0, priority: 1 };
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
      </div>
    </div>

    <div class="cbv-layer cbv-hud">
      <div class="cbv-score" aria-live="polite">
        <div class="cbv-score-team" data-team="0">
          <span class="cbv-serve-ball">${BALL_SVG}</span>
          <span class="cbv-chip"></span><span class="cbv-score-name">${esc(shortName(0))}</span>
          <span class="cbv-score-num">0</span>
        </div>
        <span class="cbv-score-dash">&ndash;</span>
        <div class="cbv-score-team" data-team="1">
          <span class="cbv-score-num">0</span>
          <span class="cbv-score-name">${esc(shortName(1))}</span><span class="cbv-chip"></span>
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
      <div class="cbv-hint"><span class="cbv-hint-ball">${BALL_SVG}</span><span class="cbv-hint-lines">
        <span><b>Pass/Set:</b> press <kbd>K</kbd> when the meter hits <b class="cbv-green">GREEN</b> as the ball arrives</span>
        <span><b>Spike:</b> the meter follows the ball: <kbd>SPACE</kbd> at the <b>JUMP</b> mark, release <kbd>J</kbd> in the <b class="cbv-green">GREEN</b></span>
      </span></div>
    </div>

    <div class="cbv-layer cbv-popups" aria-live="polite"></div>

    <div class="cbv-corner">
      <button type="button" class="cbv-btn cbv-icon-btn cbv-pause-btn" aria-label="Pause" title="Pause (Esc / P)">${ICON_PAUSE}</button>
      <button type="button" class="cbv-btn cbv-icon-btn cbv-mute-btn" aria-label="Mute" title="Mute (M)"></button>
    </div>

    <div class="cbv-layer cbv-overlay cbv-pause">
      <section class="cbv-panel cbv-small-panel" aria-label="Paused">
        <h2 class="cbv-panel-title">Paused</h2>
        <p class="cbv-panel-sub">Take a breather in the shade.</p>
        <div class="cbv-btn-col">
          <button type="button" class="cbv-btn cbv-btn-big cbv-resume">Resume</button>
          <button type="button" class="cbv-btn cbv-restart">Restart</button>
          <button type="button" class="cbv-btn cbv-quit">Menu</button>
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
          <button type="button" class="cbv-btn cbv-btn-big cbv-again">Play again <kbd>Enter</kbd></button>
          <button type="button" class="cbv-btn cbv-quit">Menu</button>
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
  const diffBtns = qa('.cbv-diff-btn');
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

  // ---------- actions ----------
  let lastState = null;
  function start() {
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
  onClick(pauseBtn, () => call('onPause'));
  onClick(muteBtn, toggleMute);
  onClick(resumeBtn, () => call('onResume'));
  onClick(restartBtn, () => call('onRestart'));
  onClick(againBtn, () => call('onRestart'));
  for (const b of qa('.cbv-quit')) onClick(b, () => call('onQuitToMenu'));

  // Space must never activate our buttons (it's the jump key). preventDefault only stops
  // the button activation; the event still propagates to the game's window listener.
  const blockSpace = (e) => {
    if ((e.key === ' ' || e.code === 'Space') && e.target instanceof win.HTMLElement && e.target.closest('button')) e.preventDefault();
  };
  root.addEventListener('keydown', blockSpace);
  root.addEventListener('keyup', blockSpace);

  win.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const s = lastState;
    const phase = s ? s.phase : 'menu';
    const onOurButton = e.target instanceof win.HTMLElement && root.contains(e.target) && e.target.closest('button');

    if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
      toggleMute();
      return;
    }
    if (phase === 'menu') {
      if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) start(); return; }
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
    if (p.isHuman) {
      popup({ text: 'Your serve!', sub: 'Hold J, release to serve', team: 0, priority: 2, duration: 2200 });
    } else if (p.team === 0 || p.team === 1) {
      // Say who serves so the player doesn't press J for a serve that isn't theirs. Kept small.
      const look = TEAMS[p.team].players[(p.playerId ?? 0) % 2];
      const who = p.team === 0 ? (look ? look.name : shortName(0)) : shortName(1);
      popup({ text: `${who} serves`, team: p.team, priority: 1, duration: 1100, small: true });
    }
  });
  on('passAttempt', (p) => {
    if (active && p && p.playerId === 0) pass.pending = { timing: p.timing, meter: p.meter };
  });
  on('swing', (p) => {
    if (active && p && p.playerId === 0) spike.pending = { timing: p.timing, meter: p.meter };
  });
  on('hit', (p) => {
    const item = hitPopup(p);
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
    const momo = Array.isArray(state.players) ? state.players[0] : null;
    const grounded = momo ? momo.grounded !== false : true;
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

  function update(state, view) {
    if (!state) return;
    lastState = state;
    const t = now();
    const phase = state.phase;
    const inMatch = phase === 'serve' || phase === 'rally' || phase === 'point' || phase === 'matchOver';
    const isPaused = !!state.paused && inMatch && phase !== 'matchOver';

    // Freeze popup timers while paused.
    if (isPaused && current) current.start += t - lastTick;
    if (isPaused && hintUntil) hintUntil += t - lastTick;
    lastTick = t;

    show(menuWrap, phase === 'menu');
    show(hud, inMatch);
    show(pauseBtn, inMatch && phase !== 'matchOver' && !isPaused);
    show(pauseLayer, isPaused);
    show(overLayer, phase === 'matchOver');
    if (isPaused !== paused) {
      paused = isPaused;
      root.classList.toggle('is-paused', paused);
    }

    if (phase !== cache.phase) {
      const prev = cache.phase;
      cache.phase = phase;
      if (phase === 'menu') {
        if (prev && prev !== 'menu') focusSoon(diffBtns.find((b) => b.dataset.diff === difficulty));
      } else if (prev === 'menu' || prev === null) {
        doc.activeElement?.blur?.();
      }
      if (phase === 'matchOver') showGameOver(state);
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

      const ch = typeof state.serveCharge === 'number' ? Math.max(0, Math.min(1, state.serveCharge)) : null;
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
    }

    const bigPopup = !!current && current.item.priority >= 3;
    const hintOn = hintUntil > t && inMatch && phase !== 'matchOver' && !bigPopup;
    if (!hintOn && hintUntil && hintUntil <= t) hintUntil = 0;
    show(hint, hintOn);

    if (inMatch && phase !== 'matchOver' && !isPaused) {
      updateSpike(state, view, t);
      updatePass(state, view, t);
    } else if (!isPaused && (spikeMeter.on || passMeter.on)) {
      hideMeters();
    }

    if (!isPaused) pumpPopups();
  }

  function showGameOver(state) {
    const score = state.score || [0, 0];
    const winner = matchWinner ?? (score[0] >= score[1] ? 0 : 1);
    matchWinner = null;
    const won = winner === 0;
    clearPopups();
    hintUntil = 0;
    overLayer.classList.toggle('is-win', won);
    overTitle.innerHTML = won ? `You win! ${PARTY_SVG}` : 'So close!';
    overSub.textContent = won ? `${TEAMS[0].name} rules the beach!` : `${TEAMS[1].name} takes this one. Rematch?`;
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
    focusSoon(againBtn);
  }

  return { update };
}
