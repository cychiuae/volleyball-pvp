// WebAudio-synthesized SFX + background music for Cute Beach Volley. No audio files.
// Contract: docs/ARCHITECTURE.md -> createAudio(events) -> { unlock, setMuted, isMuted, startMusic, stopMusic }.
// Safe to import in Node: nothing touches window/AudioContext until unlock() is called.

export const MUTE_STORAGE_KEY = 'cuteBeachVolley.muted';

const MUSIC_LEVEL = 0.25;
const MUSIC_DUCKED = 0.1; // while paused
const SFX_LEVEL = 0.8;
const BPM = 100;
const STEP = 60 / BPM / 2; // eighth notes
const SWING = 0.1; // fraction of a step that off-beats are delayed
const LOOKAHEAD = 0.15; // seconds of audio scheduled ahead
const TICK_MS = 25;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// --- music data (key of C, I–V–vi–IV) ---
// Ukulele (re-entrant gCEA) voicings, low-to-high string order G C E A.
const CHORDS = [
  { name: 'C', uke: [67, 60, 64, 72], root: 36, fifth: 43 },
  { name: 'G', uke: [67, 62, 67, 71], root: 43, fifth: 38 },
  { name: 'Am', uke: [69, 60, 64, 69], root: 45, fifth: 40 },
  { name: 'F', uke: [69, 60, 65, 69], root: 41, fifth: 36 },
];
// Island strum per bar of 8 eighths: D . D U . U D U
const STRUM = { 0: 'D', 2: 'D', 3: 'U', 5: 'U', 6: 'D', 7: 'U' };
// Bass per bar: [step, 'root'|'fifth', lengthInSteps]
const BASS = [[0, 'root', 2.5], [3, 'root', 1], [4, 'fifth', 1.6], [6, 'root', 1.6]];
// Marimba melody: 8 bars x 8 eighths (null = rest). Bars follow C G Am F C G Am F.
const MELODY = [
  76, null, 79, null, 81, 79, 76, null,
  74, null, null, 71, 74, null, 79, null,
  76, null, 72, null, 76, 79, 81, null,
  77, null, 76, null, 72, null, null, null,
  79, null, 81, 79, 76, null, 72, null,
  74, null, 76, 74, 71, null, 67, null,
  69, 72, 76, null, 81, null, 79, null,
  77, null, 76, null, 74, null, 72, null,
];
// The full loop is 16 bars: 8 bars with melody, then 8 "breathing" bars with sparse marimba.
const LOOP_STEPS = 16 * 8;

// UI-driven cues (things the game doesn't emit an event for, e.g. the spike needle crossing the JUMP
// mark). The UI calls playCue(name); every live audio instance plays it (respecting mute/unlock).
const cueSinks = new Set();
export function playCue(name) {
  for (const fn of cueSinks) fn(name);
}

// Listener perspective, set by the UI every frame (online the local player may be on Team Mint, and a
// client that joins mid-match never sees 'matchStart'). team = this screen's team (0 offline);
// live = true forces game events audible (online, in a running match). Offline nobody calls it with
// anything but { team: 0, live: false }, so offline sound is unchanged.
const perspective = { team: 0, live: false };
export function setAudioPerspective({ team = 0, live = false } = {}) {
  perspective.team = team === 1 ? 1 : 0;
  perspective.live = !!live;
}

export function createAudio(events) {
  let ctx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let noiseBuf = null;
  let muted = readMuted();
  let active = false; // game events are audible only between matchStart and menu
  let wantMusic = false;
  let musicTimer = null;
  let step = 0;
  let nextStepTime = 0;

  function readMuted() {
    try { return globalThis.localStorage?.getItem(MUTE_STORAGE_KEY) === '1'; } catch { return false; }
  }
  function writeMuted(v) {
    try { globalThis.localStorage?.setItem(MUTE_STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }

  // ---------- context ----------
  function unlock() {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      try {
        ctx = new AC();
      } catch {
        ctx = null;
        return;
      }
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(comp);
      musicBus = ctx.createGain();
      musicBus.gain.value = MUSIC_LEVEL;
      musicBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = SFX_LEVEL;
      sfxBus.connect(master);
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (wantMusic) runMusic();
  }

  const ready = () => !!ctx && !muted;

  function setMuted(b) {
    muted = !!b;
    writeMuted(muted);
    if (ctx && master) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, t + 0.08);
    }
  }

  // ---------- synthesis primitives ----------
  function panNode(dest, pan) {
    if (!pan || !ctx.createStereoPanner) return dest;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(dest);
    return p;
  }

  /** Oscillator with an attack/exponential-decay envelope. */
  function tone({ t = ctx.currentTime, freq = 440, freqEnd = null, type = 'sine', dur = 0.2, gain = 0.3,
    attack = 0.004, bus = sfxBus, pan = 0, filter = null, filterQ = 0.8, detune = 0, vibrato = null }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    if (detune) osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = panNode(bus, pan);
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      f.Q.value = filterQ;
      f.connect(out);
      out = f;
    }
    osc.connect(g);
    g.connect(out);
    let lfo = null;
    if (vibrato) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = vibrato.rate;
      const lg = ctx.createGain();
      lg.gain.value = vibrato.depth;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
    return { osc, gain: g };
  }

  /** Filtered noise burst. */
  function noise({ t = ctx.currentTime, dur = 0.1, gain = 0.3, type = 'bandpass', freq = 1000, freqEnd = null,
    q = 1, attack = 0.003, bus = sfxBus, pan = 0, curve = 'exp' }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    else g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(panNode(bus, pan));
    src.loop = true; // random offset into a looping 2 s buffer: every burst sounds a bit different
    src.start(t, Math.random() * 1.9);
    src.stop(t + dur + 0.05);
    return { src, gain: g, filter: f };
  }

  // Marimba-ish: sine with fast decay plus a quick high partial for the mallet "tok".
  function marimba(t, midi, gain = 0.25, bus = musicBus, dur = 0.5) {
    const f = mtof(midi);
    tone({ t, freq: f, type: 'sine', dur, gain, attack: 0.003, bus });
    tone({ t, freq: f * 4, type: 'sine', dur: 0.06, gain: gain * 0.35, attack: 0.001, bus });
  }
  // Ukulele-ish pluck: short decaying triangle, a touch of octave for brightness.
  function pluck(t, midi, gain = 0.12, bus = musicBus) {
    const f = mtof(midi);
    tone({ t, freq: f, type: 'triangle', dur: 0.42, gain, attack: 0.002, bus, filter: 3200 });
    tone({ t, freq: f * 2, type: 'triangle', dur: 0.12, gain: gain * 0.25, attack: 0.001, bus, filter: 4000 });
  }

  function whistle(t, dur = 0.22, gain = 0.16) {
    tone({ t, freq: 2350, type: 'sine', dur, gain, attack: 0.01, vibrato: { rate: 34, depth: 120 } });
    noise({ t, dur, gain: gain * 0.25, type: 'bandpass', freq: 2400, q: 6 });
  }

  // ---------- SFX ----------
  // a Team Mint listener sees the court mirrored (camera from -z), so left/right flip too
  const panOf = (pos) => (pos && typeof pos.x === 'number' ? clamp((perspective.team === 1 ? -pos.x : pos.x) / 7, -0.8, 0.8) : 0);
  // far side quieter (the far side is z < 0 for Team Peach, z > 0 for a Team Mint listener)
  const distGain = (pos) => (pos && typeof pos.z === 'number' && pos.z * (perspective.team === 1 ? -1 : 1) < 0 ? 0.72 : 1);

  function sfxHit(p) {
    const t = ctx.currentTime;
    const pan = panOf(p.position);
    const k = distGain(p.position);
    const power = clamp(p.power ?? 0.5, 0, 1);
    switch (p.type) {
      case 'serve':
        noise({ t, dur: 0.07, gain: 0.35 * k, type: 'bandpass', freq: 1500, q: 1.2, pan });
        tone({ t, freq: 220, freqEnd: 90, type: 'sine', dur: 0.16, gain: 0.5 * k, pan });
        tone({ t, freq: 480, freqEnd: 240, type: 'triangle', dur: 0.08, gain: 0.18 * k, pan });
        break;
      case 'bump':
        tone({ t, freq: 470, freqEnd: 250, type: 'sine', dur: 0.17, gain: 0.42 * k, attack: 0.006, pan });
        tone({ t, freq: 940, freqEnd: 500, type: 'sine', dur: 0.06, gain: 0.08 * k, pan });
        noise({ t, dur: 0.05, gain: 0.08 * k, type: 'lowpass', freq: 900, pan });
        break;
      case 'set':
        tone({ t, freq: 820, freqEnd: 1250, type: 'sine', dur: 0.08, gain: 0.3 * k, attack: 0.002, pan });
        tone({ t, freq: 620, type: 'triangle', dur: 0.06, gain: 0.12 * k, pan });
        break;
      case 'spike': {
        const g = (0.55 + 0.45 * power) * k;
        noise({ t, dur: 0.04 + 0.05 * power, gain: 0.55 * g, type: 'highpass', freq: 1800, q: 0.7, pan });
        noise({ t, dur: 0.12 + 0.2 * power, gain: 0.3 * g, type: 'bandpass', freq: 3000, freqEnd: 900, q: 0.8, pan });
        tone({ t, freq: 190, freqEnd: 55, type: 'sine', dur: 0.2, gain: 0.7 * g, attack: 0.001, pan });
        tone({ t, freq: 340, freqEnd: 120, type: 'square', dur: 0.06, gain: 0.12 * g, filter: 1600, pan });
        break;
      }
      case 'dink':
        tone({ t, freq: 1250, freqEnd: 1000, type: 'sine', dur: 0.06, gain: 0.16 * k, attack: 0.001, pan });
        break;
      case 'block':
        for (const dt of [0, 0.075]) {
          tone({ t: t + dt, freq: 140, freqEnd: 65, type: 'sine', dur: 0.14, gain: 0.55 * k, attack: 0.002, pan });
          noise({ t: t + dt, dur: 0.06, gain: 0.2 * k, type: 'lowpass', freq: 1200, pan });
        }
        break;
      case 'dig':
        noise({ t, dur: 0.12, gain: 0.25 * k, type: 'lowpass', freq: 700, pan });
        tone({ t, freq: 230, freqEnd: 120, type: 'sine', dur: 0.12, gain: 0.4 * k, pan });
        tone({ t: t + 0.02, freq: 520, freqEnd: 380, type: 'triangle', dur: 0.07, gain: 0.08 * k, pan });
        break;
      default:
        tone({ t, freq: 500, freqEnd: 300, type: 'sine', dur: 0.12, gain: 0.3 * k, pan });
    }
  }

  function sfxJump(p) {
    noise({ t: ctx.currentTime, dur: 0.2, gain: 0.07 * distGain(p?.position), type: 'bandpass', freq: 450, freqEnd: 1700, q: 1.4, attack: 0.03, pan: panOf(p?.position) });
  }

  // Arm swing on every Hit press (whiffs included): a quick airy "fwip". Brighter when airborne.
  function sfxSwing(p) {
    const t = ctx.currentTime;
    const air = !!p.airborne;
    const pan = panOf(p.position);
    noise({ t, dur: 0.13, gain: (air ? 0.12 : 0.09) * distGain(p.position), type: 'bandpass', freq: air ? 900 : 700, freqEnd: air ? 3200 : 2200, q: 2.2, attack: 0.02, pan });
    noise({ t: t + 0.03, dur: 0.08, gain: 0.04, type: 'highpass', freq: 4000, attack: 0.01, pan });
  }

  // Spike JUMP-mark cue: a soft wooden "tok" (two quick sine partials), quiet enough to sit under the music.
  function sfxJumpMark() {
    const t = ctx.currentTime;
    tone({ t, freq: 1046, freqEnd: 980, type: 'sine', dur: 0.06, gain: 0.07, attack: 0.002 });
    tone({ t, freq: 2093, type: 'sine', dur: 0.03, gain: 0.025, attack: 0.001 });
  }

  // Pass/Set press ("ready" tick). Quiet: the bump/set contact sound plays separately on 'hit'.
  function sfxPassAttempt(p) {
    const t = ctx.currentTime;
    const pan = panOf(p.position);
    tone({ t, freq: 1320, freqEnd: 1560, type: 'sine', dur: 0.045, gain: 0.05, attack: 0.002, pan });
    noise({ t, dur: 0.03, gain: 0.025, type: 'highpass', freq: 5000, pan });
  }

  function sfxBounce(p) {
    const t = ctx.currentTime;
    const speed = Math.max(0, p.speed ?? 4);
    const pan = panOf(p.position);
    const k = distGain(p.position);
    if (p.surface === 'net') {
      const g = clamp(0.1 + speed * 0.025, 0.1, 0.35) * k;
      for (let i = 0; i < 4; i++) {
        noise({ t: t + i * 0.045 + Math.random() * 0.02, dur: 0.09, gain: g * (1 - i * 0.2), type: 'bandpass', freq: 2600 + Math.random() * 1400, q: 0.9, pan });
      }
      tone({ t, freq: 110, freqEnd: 80, type: 'sine', dur: 0.12, gain: g * 0.6, pan });
    } else if (p.surface === 'post') {
      const g = clamp(0.08 + speed * 0.02, 0.08, 0.3) * k;
      for (const [f, m] of [[523, 1], [1187, 0.6], [1771, 0.4], [2630, 0.25]]) {
        tone({ t, freq: f, type: 'sine', dur: 0.5 * m + 0.15, gain: g * m, attack: 0.001, pan });
      }
      noise({ t, dur: 0.03, gain: g, type: 'highpass', freq: 3000, pan });
    } else {
      if (speed < 0.6) return;
      const g = clamp(speed / 14, 0.04, 0.45) * k;
      noise({ t, dur: 0.16 + Math.min(0.1, speed * 0.01), gain: g, type: 'lowpass', freq: 250 + speed * 70, q: 0.7, pan });
      tone({ t, freq: 95, freqEnd: 50, type: 'sine', dur: 0.12, gain: g * 0.8, pan });
    }
  }

  function crowdCheer(t, amount = 1) {
    // Swelling "crowd" bed: two detuned noise bands.
    for (const [f, q] of [[900, 0.6], [2200, 0.9]]) {
      const n = noise({ t, dur: 1.9, gain: 0.0001, type: 'bandpass', freq: f, q, attack: 0.001, curve: 'lin' });
      const g = n.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0.0001, t);
      g.linearRampToValueAtTime(0.13 * amount, t + 0.35);
      g.linearRampToValueAtTime(0.09 * amount, t + 0.9);
      g.linearRampToValueAtTime(0.0001, t + 1.85);
    }
    // Scattered claps.
    for (let i = 0; i < 26; i++) {
      const ct = t + 0.05 + Math.random() * 1.4;
      noise({ t: ct, dur: 0.03, gain: (0.05 + Math.random() * 0.06) * amount, type: 'bandpass', freq: 1400 + Math.random() * 1200, q: 1.5, pan: Math.random() * 1.4 - 0.7 });
    }
    // A couple of "woo!" voices: pitched sine glides.
    for (let i = 0; i < 3; i++) {
      const vt = t + 0.1 + Math.random() * 0.4;
      const f = 500 + Math.random() * 300;
      tone({ t: vt, freq: f, freqEnd: f * 1.5, type: 'triangle', dur: 0.45, gain: 0.025 * amount, attack: 0.08, filter: 1800, pan: Math.random() - 0.5, vibrato: { rate: 6, depth: 12 } });
    }
  }

  function happyJingle(t) {
    [72, 76, 79, 84].forEach((m, i) => marimba(t + i * 0.09, m, 0.22, sfxBus, 0.35));
    marimba(t + 0.38, 88, 0.2, sfxBus, 0.6);
    marimba(t + 0.38, 79, 0.12, sfxBus, 0.6);
  }

  function sadWahWah(t) {
    const notes = [67, 66, 65, 64];
    notes.forEach((m, i) => {
      const nt = t + i * 0.3;
      const last = i === notes.length - 1;
      const dur = last ? 0.75 : 0.28;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = mtof(m - 12);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 6;
      f.frequency.setValueAtTime(350, nt);
      f.frequency.linearRampToValueAtTime(1400, nt + 0.08);
      f.frequency.linearRampToValueAtTime(400, nt + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, nt);
      g.gain.linearRampToValueAtTime(0.12, nt + 0.03);
      g.gain.setValueAtTime(0.12, nt + dur - 0.06);
      g.gain.linearRampToValueAtTime(0.0001, nt + dur);
      if (last) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.5;
        const lg = ctx.createGain();
        lg.gain.value = 4;
        lfo.connect(lg);
        lg.connect(osc.frequency);
        lfo.start(nt);
        lfo.stop(nt + dur);
      }
      osc.connect(f);
      f.connect(g);
      g.connect(sfxBus);
      osc.start(nt);
      osc.stop(nt + dur + 0.02);
    });
  }

  function sfxPoint(p) {
    const t = ctx.currentTime;
    whistle(t, 0.16, 0.14);
    whistle(t + 0.2, 0.12, 0.12);
    if (p.winnerTeam === perspective.team) {
      happyJingle(t + 0.4);
      crowdCheer(t + 0.3, 1);
    } else {
      sadWahWah(t + 0.45);
      crowdCheer(t + 0.3, 0.35); // polite applause for the other side
    }
  }

  function fanfare(t) {
    // Ta-ta-ta TAAA: G4 G4 G4 C5... then bright C major chord.
    const bus = sfxBus;
    const brass = (nt, m, dur, g = 0.12) => {
      tone({ t: nt, freq: mtof(m), type: 'square', dur, gain: g * 0.5, attack: 0.01, bus, filter: 2200 });
      tone({ t: nt, freq: mtof(m), type: 'triangle', dur, gain: g, attack: 0.01, bus, detune: 6 });
    };
    [[0, 67, 0.14], [0.15, 67, 0.14], [0.3, 67, 0.14], [0.45, 72, 0.5], [0.95, 71, 0.15], [1.1, 72, 0.15], [1.25, 76, 0.2]].forEach(([dt, m, d]) => brass(t + dt, m, d + 0.08));
    [72, 76, 79, 84].forEach((m) => brass(t + 1.5, m, 1.2, 0.09));
    [84, 88, 91, 96].forEach((m, i) => marimba(t + 1.5 + i * 0.06, m, 0.12, bus, 0.8));
    crowdCheer(t + 1.4, 1.2);
  }

  function consolation(t) {
    // Gentle, warm "good game" tune: descending then resolving to a soft major chord.
    const mel = [[0, 76], [0.3, 74], [0.6, 72], [0.9, 69], [1.2, 71], [1.5, 72]];
    mel.forEach(([dt, m]) => marimba(t + dt, m, 0.18, sfxBus, 0.55));
    [60, 64, 67, 72].forEach((m, i) => pluck(t + 1.9 + i * 0.05, m, 0.1, sfxBus));
    crowdCheer(t + 1.6, 0.3);
  }

  function blip(up) {
    const t = ctx.currentTime;
    tone({ t, freq: up ? 520 : 760, freqEnd: up ? 780 : 480, type: 'sine', dur: 0.1, gain: 0.14 });
  }

  // ---------- music ----------
  function scheduleStep(s, time) {
    const bar = Math.floor(s / 8) % 16;
    const inBar = s % 8;
    const chord = CHORDS[bar % 4];
    const t = time + (inBar % 2 === 1 ? STEP * SWING : 0);

    const strum = STRUM[inBar];
    if (strum) {
      const notes = strum === 'D' ? chord.uke : [...chord.uke].reverse();
      const g = strum === 'D' ? (inBar === 0 ? 0.11 : 0.085) : 0.06;
      notes.forEach((m, i) => pluck(t + i * 0.013, m, g));
    }
    for (const [bs, which, len] of BASS) {
      if (bs === inBar) {
        const m = which === 'root' ? chord.root : chord.fifth;
        tone({ t, freq: mtof(m), type: 'triangle', dur: len * STEP, gain: 0.32, attack: 0.008, bus: musicBus, filter: 500 });
      }
    }
    // Shaker: soft filtered noise on every eighth, accented off-beats.
    noise({ t, dur: 0.045, gain: inBar % 2 ? 0.05 : 0.028, type: 'highpass', freq: 6500, q: 0.7, bus: musicBus, attack: 0.008 });

    if (bar < 8) {
      const m = MELODY[bar * 8 + inBar];
      if (m != null) marimba(t, m, 0.2);
    } else if (inBar === 0 || inBar === 3) {
      // breathing section: just a couple of soft chord tones high up
      marimba(t, chord.uke[inBar === 0 ? 3 : 2] + 12, 0.09);
    }
  }

  function musicTick() {
    if (!ctx) return;
    const now = ctx.currentTime;
    // If the tab was throttled/suspended we fell behind: resync instead of bursting notes.
    if (nextStepTime < now - 0.2) nextStepTime = now + 0.05;
    while (nextStepTime < now + LOOKAHEAD) {
      if (!muted) scheduleStep(step, nextStepTime);
      step = (step + 1) % LOOP_STEPS;
      nextStepTime += STEP;
    }
  }

  function runMusic() {
    if (!ctx || musicTimer !== null) return;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(0.0001, t);
    musicBus.gain.linearRampToValueAtTime(MUSIC_LEVEL, t + 1.2);
    step = 0;
    nextStepTime = t + 0.1;
    musicTimer = setInterval(musicTick, TICK_MS);
    musicTick();
  }

  function startMusic() {
    wantMusic = true;
    runMusic();
  }

  function stopMusic() {
    wantMusic = false;
    if (musicTimer !== null) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (ctx) {
      const t = ctx.currentTime;
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(musicBus.gain.value, t);
      musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.3);
    }
  }

  function duckMusic(on) {
    if (!ctx || musicTimer === null) return;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(musicBus.gain.value, t);
    musicBus.gain.linearRampToValueAtTime(on ? MUSIC_DUCKED : MUSIC_LEVEL, t + 0.25);
  }

  // ---------- events ----------
  // Each handler is a no-op before unlock, while muted, or outside a real match (attract mode).
  const guard = (fn) => (p) => {
    if (!(active || perspective.live) || !ready()) return;
    try { fn(p || {}); } catch (err) { console.warn('[audio]', err); }
  };
  if (events && typeof events.on === 'function') {
    events.on('matchStart', () => { active = true; duckMusic(false); });
    events.on('menu', () => { active = false; duckMusic(false); });
    events.on('hit', guard(sfxHit));
    events.on('jump', guard(sfxJump));
    events.on('swing', guard(sfxSwing));
    events.on('passAttempt', guard(sfxPassAttempt));
    events.on('bounce', guard(sfxBounce));
    events.on('point', guard(sfxPoint));
    events.on('serveReady', guard(() => whistle(ctx.currentTime + 0.05, 0.2, 0.12)));
    events.on('matchOver', guard((p) => (p.winnerTeam === perspective.team ? fanfare : consolation)(ctx.currentTime + 0.3)));
    events.on('pause', guard(() => { blip(false); duckMusic(true); }));
    events.on('resume', guard(() => { blip(true); duckMusic(false); }));
  }
  const CUES = { jumpMark: sfxJumpMark };
  cueSinks.add((name) => { if (CUES[name]) guard(CUES[name])(); });

  return {
    unlock,
    setMuted,
    isMuted: () => muted,
    startMusic,
    stopMusic,
  };
}
