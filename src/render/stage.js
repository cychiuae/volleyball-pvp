// Renderer, scene, camera rig, lights, sky and fog.
// createStage(containerEl) -> { renderer, scene, camera, updateCamera(dt, state), render(),
//                               setQuality('high'|'low'), quality, viewYaw, localTeam }
// The camera views the court from the side of the LOCAL player's team
// (players[state.controlledId].team): team 0 from +z, team 1 rotated 180 deg about y (from -z).
// The whole rig (gameplay framing, serve view, rally follow, point push-in, menu/result orbits)
// is computed in a canonical "team 0" local frame and rotated by viewYaw at the end; viewYaw
// springs smoothly between 0 and PI when the local team changes, so there is never a pop.
// 'high' renders through a post chain (MSAA HDR target -> soft bloom -> warm grade/vignette ->
// OutputPass); 'low' is a plain direct render. Default 'high' with auto-downgrade when slow;
// ?quality=low|high in the URL forces a level and disables the auto switch.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { COURT, PALETTE } from '../config.js';
import { setGlowLevel } from './toon.js';

// Bloom tuning. Lit white surfaces (sand, court lines, shorts) peak around luminance 1.05-1.1, so
// the threshold sits above that; only HDR-boosted things (sun disc, sparkles, VFX) glow.
const BLOOM = { strength: 0.32, radius: 0.45, threshold: 1.18, smoothWidth: 0.3 };
const SLOW_FRAME_MS = 22;     // auto-downgrade when the average frame time stays above this
const SLOW_WINDOW_MS = 3000;  // ...over this much play time

// Sun comes from behind the LOCAL team (camera side) and a little to the left, high in the sky:
// it lights the opponents' faces and throws shadows away from the camera so they read on the sand.
// SUN_DIR is the team-0 direction; the light (and the sky's sun disc) rotate with viewYaw so a
// team-1 view gets the same readable front lighting instead of a backlit, face-in-shadow court.
// Per-client cosmetic only; scene.userData.viewYaw is published for other render modules.
export const SUN_DIR = new THREE.Vector3(-0.45, 1.0, 0.62).normalize();

const BASE_FOV = 45;
const GAME_ELEVATION = THREE.MathUtils.degToRad(28); // camera pitch above the look target
const DEFAULT_LOOK = new THREE.Vector3(0, 0.6, -0.6);

// Points that must stay on screen in the gameplay view (court corners with a little margin,
// heads of far players, antenna tips, the near server spot behind the baseline).
const HW = COURT.halfWidth + 0.35;
const HL = COURT.halfLength + 0.5;
const KEY_POINTS = [
  [-HW, 0, -HL], [HW, 0, -HL], [-HW, 1.6, -HL], [HW, 1.6, -HL],
  [-COURT.halfWidth, COURT.netHeight + COURT.antennaHeight, 0],
  [COURT.halfWidth, COURT.netHeight + COURT.antennaHeight, 0],
  [-HW, 0, HL], [HW, 0, HL], [0, 0, COURT.halfLength + 1.2],
  [-HW, 1.4, HL - 1], [HW, 1.4, HL - 1],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

const VIEW_SPRING = 2.2; // rad/s natural frequency of the team-side swing (~2 s, critically damped)

/** Team whose side the local camera sits on (offline controlledId is 0 -> team 0). */
export function localTeamOf(state) {
  const id = state && Number.isInteger(state.controlledId) ? state.controlledId : 0;
  const p = state && state.players && state.players[id];
  return p && p.team === 1 ? 1 : 0;
}

const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function createStage(containerEl) {
  const container = containerEl || document.body;

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  const fogColor = new THREE.Color(PALETTE.skyHorizon).lerp(new THREE.Color(PALETTE.sky), 0.25);
  scene.fog = new THREE.Fog(fogColor, 55, 360);

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, 0.3, 1600);
  camera.position.set(0, 7.5, 17);
  camera.lookAt(DEFAULT_LOOK);

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight('#cfeaff', '#f4d7a6', 1.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff0d8', 2.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2;
  sun.target.position.set(0, 0, 0);
  sun.position.copy(SUN_DIR).multiplyScalar(40);
  scene.add(sun, sun.target);
  const shadowBox = new THREE.Box3(new THREE.Vector3(-7.5, 0, -12), new THREE.Vector3(7.5, 4.5, 12));
  fitShadowFrustum(sun, shadowBox);

  // ---------------------------------------------------------------- sky dome
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(PALETTE.sky) },
      uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
      uZenith: { value: new THREE.Color(PALETTE.sky).lerp(new THREE.Color('#6cc4f5'), 0.55) },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color('#fff6d2') },
      uSunBoost: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uZenith;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunBoost;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.03, 0.32, h), 0.75));
        col = mix(col, uZenith, smoothstep(0.35, 1.0, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(s, 24.0) * 0.18 + pow(s, 300.0) * 0.35);
        col = mix(col, uSunColor * 1.08 * uSunBoost, smoothstep(0.9988, 0.9992, s)); // cute round sun disc
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // ---------------------------------------------------------------- resize
  function resize() {
    let w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) { w = window.innerWidth; h = window.innerHeight; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    viewW = w; viewH = h;
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    // Narrow / portrait screens: widen the lens a little; the fit solver pulls back the rest.
    camera.fov = BASE_FOV + 12 * (1 - smooth(0.55, 1.35, camera.aspect));
    camera.updateProjectionMatrix();
    fitCam.aspect = camera.aspect;
    fitCam.fov = camera.fov;
    fitCam.updateProjectionMatrix();
    // Choose the look-target depth for the gameplay framing.
    // Ties (portrait, where the width binds) go to the most vertically centred framing.
    // Moving the target toward the near side would let the camera sit closer, but it flattens the
    // far court, so only same-distance alternatives are considered.
    const best = solveGameplay(DEFAULT_LOOK, 0, tmpOut);
    const cands = [];
    baseLookZ = DEFAULT_LOOK.z;
    for (let z = -2; z <= 3.01; z += 0.25) {
      tmpLook.copy(DEFAULT_LOOK).setZ(z);
      const d = solveGameplay(tmpLook, 0, tmpOut);
      cands.push([z, d, verticalCentre(tmpOut, tmpLook)]);
    }
    let score = Infinity;
    for (const [z, d, c] of cands) {
      if (Math.abs(d - best) > best * 0.015) continue;
      const sc = Math.abs(c + 0.12);
      if (sc < score) { score = sc; baseLookZ = z; }
    }
  }
  function verticalCentre(pos, look) {
    fitCam.position.copy(pos);
    fitCam.lookAt(look);
    fitCam.updateMatrixWorld(true);
    fitCam.matrixWorldInverse.copy(fitCam.matrixWorld).invert();
    let lo = Infinity, hi = -Infinity;
    for (const p of KEY_POINTS) {
      tmpV2.copy(p).applyMatrix4(fitCam.matrixWorldInverse).applyMatrix4(fitCam.projectionMatrix);
      lo = Math.min(lo, tmpV2.y); hi = Math.max(hi, tmpV2.y);
    }
    return (lo + hi) / 2;
  }
  const tmpLook = new THREE.Vector3();
  const tmpOut = new THREE.Vector3();
  let baseLookZ = DEFAULT_LOOK.z;
  const fitCam = new THREE.PerspectiveCamera();

  // ---------------------------------------------------------------- camera rig
  const curPos = camera.position.clone();
  const curLook = DEFAULT_LOOK.clone();
  const desPos = new THREE.Vector3();
  const desLook = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const prevVel = new THREE.Vector3();
  let havePrevVel = false;
  let lastPhase = null;
  let phaseTime = 0;
  let transition = 0; // seconds of "soft" (slow) following after a phase change
  let orbitAngle = Math.PI / 2;
  let shake = 0;
  let shakeTime = 0;
  let clock = 0;
  let fitDist = 20;
  // Team-side view rotation (radians about +y). Rig state (curPos/curLook) lives in the local frame.
  let viewYaw = 0, yawVel = 0, localTeam = 0, sunYaw = 0;
  let sunFollowsView = true;
  const UP = new THREE.Vector3(0, 1, 0);
  const sunDir = SUN_DIR.clone();
  scene.userData.viewYaw = 0;

  function applySun(yaw) {
    sunYaw = yaw;
    sunDir.copy(SUN_DIR).applyAxisAngle(UP, yaw);
    sun.position.copy(sunDir).multiplyScalar(40);
    sun.updateMatrixWorld();
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    fitShadowFrustum(sun, shadowBox);
  }
  function stepViewYaw(dt, state) {
    if (state && state.players) localTeam = localTeamOf(state);
    const target = localTeam === 1 ? Math.PI : 0;
    // Critically damped spring: starts and ends gently, never overshoots.
    const w = VIEW_SPRING;
    const sub = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      yawVel += (w * w * (target - viewYaw) - 2 * w * yawVel) * h;
      viewYaw += yawVel * h;
    }
    if (Math.abs(target - viewYaw) < 1e-4 && Math.abs(yawVel) < 1e-4) { viewYaw = target; yawVel = 0; }
    scene.userData.viewYaw = viewYaw;
    const sy = sunFollowsView ? viewYaw : 0;
    if (Math.abs(sy - sunYaw) > 1e-5) applySun(sy);
  }
  // World <-> local (team-0 canonical) frame.
  const toLocal = (v) => v.applyAxisAngle(UP, -viewYaw);
  const toWorld = (v) => v.applyAxisAngle(UP, viewYaw);
  const localBall = { pos: new THREE.Vector3(), visible: false };
  const localState = { ball: localBall };

  const offsetDir = new THREE.Vector3(0, Math.sin(GAME_ELEVATION), Math.cos(GAME_ELEVATION));

  function fits(pos, look) {
    fitCam.position.copy(pos);
    fitCam.lookAt(look);
    fitCam.updateMatrixWorld(true);
    fitCam.matrixWorldInverse.copy(fitCam.matrixWorld).invert();
    for (const p of KEY_POINTS) {
      tmpV2.copy(p).applyMatrix4(fitCam.matrixWorldInverse);
      if (tmpV2.z > -0.5) return false;
      tmpV2.applyMatrix4(fitCam.projectionMatrix);
      if (Math.abs(tmpV2.x) > 0.94 || tmpV2.y > 0.9 || tmpV2.y < -0.96) return false;
    }
    return true;
  }

  // Binary-search the camera distance along the fixed elevation so every key point fits.
  function solveGameplay(look, camX, outPos) {
    let lo = 9, hi = 70;
    tmpV.copy(look).addScaledVector(offsetDir, hi);
    tmpV.x = camX;
    if (fits(tmpV, look)) {
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) * 0.5;
        tmpV.copy(look).addScaledVector(offsetDir, mid);
        tmpV.x = camX;
        if (fits(tmpV, look)) hi = mid; else lo = mid;
      }
    }
    outPos.copy(look).addScaledVector(offsetDir, hi);
    outPos.x = camX;
    return hi;
  }

  function gameplayView(state, outPos, outLook) {
    const ball = state && state.ball;
    const bx = ball && ball.visible ? ball.pos.x : 0;
    const bz = ball && ball.visible ? ball.pos.z : 0;
    outLook.copy(DEFAULT_LOOK);
    outLook.x = THREE.MathUtils.clamp(bx * 0.22, -0.9, 0.9);
    outLook.z = baseLookZ + THREE.MathUtils.clamp(bz * 0.1, -0.7, 0.7);
    const camX = outLook.x * 0.55;
    fitDist = solveGameplay(outLook, camX, outPos);
  }

  function updateCamera(dt, state) {
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    stepViewYaw(dt, state);
    let ls = null;
    if (state && state.ball && state.ball.pos) {
      localBall.visible = state.ball.visible;
      toLocal(localBall.pos.copy(state.ball.pos));
      ls = localState;
    }
    const phase = (state && state.phase) || 'menu';
    if (phase !== lastPhase) {
      if (lastPhase !== null) transition = phase === 'point' ? 0 : 1.4;
      if (phase === 'menu' || phase === 'matchOver') {
        orbitAngle = Math.atan2(curPos.z, curPos.x); // continue smoothly from where we are
      }
      lastPhase = phase;
      phaseTime = 0;
    }
    phaseTime += dt;
    transition = Math.max(0, transition - dt);

    let rate = 4.0;
    if (phase === 'menu') {
      orbitAngle += dt * 0.11;
      // Radius/height keep the camera above the palm crowns and umbrellas all the way round.
      const r = 23 + Math.sin(clock * 0.21) * 2;
      desPos.set(Math.cos(orbitAngle) * r, 10 + Math.sin(clock * 0.17) * 0.9, Math.sin(orbitAngle) * r);
      desLook.set(0, 1.2, 0);
      rate = 1.6;
    } else if (phase === 'matchOver') {
      // Slow, gentle swing over the court while the result screen is up.
      orbitAngle += dt * 0.06;
      desPos.set(Math.cos(orbitAngle) * 17, 6.2, Math.sin(orbitAngle) * 17);
      desLook.set(0, 1.4, 0);
      rate = 1.2;
    } else {
      gameplayView(ls, desPos, desLook);
      if (phase === 'point' && ls) {
        // Gentle push-in toward where the rally ended, then ease back before the next serve.
        focus.copy(localBall.pos);
        focus.y = THREE.MathUtils.clamp(focus.y, 0.3, 2.5);
        const w = smooth(0.1, 0.9, phaseTime) * (1 - smooth(1.4, 2.2, phaseTime));
        desLook.lerp(focus, 0.45 * w);
        desPos.lerp(tmpV.copy(focus).add(tmpV2.set(0, 4.5, 9)), 0.28 * w);
        rate = 2.2;
      }
    }
    if (transition > 0) rate = Math.min(rate, 1.6 + (1.4 - transition) * 1.5);

    const k = damp(rate, dt);
    curPos.lerp(desPos, k);
    curLook.lerp(desLook, k);

    // Screen shake on strong hits: detect a big jump in ball speed.
    if (state && state.ball && state.ball.vel) {
      const v = state.ball.vel;
      if (havePrevVel && !state.paused) {
        const speed = v.length();
        const jump = speed - prevVel.length();
        const dv = tmpV.copy(v).sub(prevVel).length();
        if (speed > 13 && jump > 6 && dv > 10) shake = Math.max(shake, THREE.MathUtils.clamp((speed - 11) / 12, 0.25, 1));
      }
      prevVel.copy(v);
      havePrevVel = true;
    }
    shakeTime += dt;
    shake *= Math.exp(-5.5 * dt);
    if (shake < 0.002) shake = 0;

    toWorld(camera.position.copy(curPos));
    if (shake > 0) {
      const a = 0.16 * shake;
      camera.position.x += a * Math.sin(shakeTime * 47.0) * 0.9;
      camera.position.y += a * Math.sin(shakeTime * 59.0 + 1.3) * 0.7;
      camera.position.z += a * Math.sin(shakeTime * 41.0 + 2.1) * 0.4;
    }
    camera.position.y = Math.max(camera.position.y, 0.8);
    camera.lookAt(toWorld(tmpV.copy(curLook)));
  }

  // ---------------------------------------------------------------- post / quality
  let composer = null;
  let viewW = 1, viewH = 1;
  let quality = 'low';
  const urlQ = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
  let autoQuality = !(urlQ === 'low' || urlQ === 'high');
  let perfAcc = 0, perfN = 0, warmup = 2.5, lastFrameT = 0;
  const stats = { renderMs: 0, frameMs: 16.7, calls: 0, triangles: 0, passes: 1 };

  const gradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uWarm: { value: new THREE.Vector3(1.025, 1.0, 0.97) },
      uVignette: { value: 0.13 },
      uSat: { value: 1.03 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse; uniform vec3 uWarm; uniform float uVignette; uniform float uSat;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        vec3 col = c.rgb * uWarm;                                   // light warm grade (linear HDR)
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = max(mix(vec3(l), col, uSat), 0.0);
        vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);
        float vig = smoothstep(0.32, 0.78, length(d));
        col *= 1.0 - uVignette * vig;                               // soft vignette
        col += vec3(0.012, 0.004, 0.0) * vig;                      // ...with a hint of peach
        gl_FragColor = vec4(col, c.a);
      }`,
  };

  function buildComposer() {
    const rt = new THREE.WebGLRenderTarget(viewW, viewH, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(renderer, rt); // both ping-pong targets keep MSAA (samples: 4)
    c.setPixelRatio(renderer.getPixelRatio());
    c.setSize(viewW, viewH);
    c.addPass(new RenderPass(scene, camera));
    // UnrealBloomPass internally works from half resolution downward.
    const bloom = new UnrealBloomPass(new THREE.Vector2(viewW, viewH), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    bloom.highPassUniforms.smoothWidth.value = BLOOM.smoothWidth;
    c.addPass(bloom);
    c.addPass(new ShaderPass(gradeShader));
    c.addPass(new OutputPass());
    return c;
  }

  /** 'high' = bloom + grade post chain, 'low' = direct render. */
  function setQuality(q, { auto = false } = {}) {
    const want = q === 'low' ? 'low' : 'high';
    if (!auto) autoQuality = false;
    if (want === 'high' && !composer) {
      try { composer = buildComposer(); } catch (err) { console.warn('[stage] post chain unavailable', err); quality = 'low'; applyGlow(); return quality; }
    }
    quality = want;
    perfAcc = 0; perfN = 0; warmup = 2.5;
    applyGlow();
    return quality;
  }
  function applyGlow() {
    const g = quality === 'high' ? 1 : 0;
    setGlowLevel(g);
    skyMat.uniforms.uSunBoost.value = g ? 2.6 : 1;
  }

  function trackPerf(now) {
    if (lastFrameT) {
      const ft = now - lastFrameT;
      stats.frameMs += (ft - stats.frameMs) * 0.05;
      const inPlay = lastPhase === 'serve' || lastPhase === 'rally' || lastPhase === 'point';
      const hidden = typeof document !== 'undefined' && document.hidden;
      // Long frames are capped (not skipped) so very slow machines still downgrade; only
      // pathological >1 s stalls (tab switches, debugger) are ignored.
      if (autoQuality && quality === 'high' && inPlay && !hidden && ft < 1000) {
        const fc = Math.min(ft, 250);
        if (warmup > 0) warmup -= fc / 1000;
        else {
          perfAcc += fc; perfN++;
          if (perfAcc >= SLOW_WINDOW_MS) {
            const avg = perfAcc / perfN;
            perfAcc = 0; perfN = 0;
            if (avg > SLOW_FRAME_MS) {
              console.info(`[stage] average frame ${avg.toFixed(1)} ms > ${SLOW_FRAME_MS} ms: switching to low quality`);
              setQuality('low', { auto: true });
              autoQuality = false;
            }
          }
        }
      }
    }
    lastFrameT = now;
  }

  function render() {
    const t0 = performance.now();
    trackPerf(t0);
    sky.position.copy(camera.position);
    renderer.info.reset();
    if (quality === 'high' && composer) {
      composer.render();
      stats.passes = composer.passes.length;
    } else {
      renderer.render(scene, camera);
      stats.passes = 1;
    }
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.renderMs += (performance.now() - t0 - stats.renderMs) * 0.1;
  }

  renderer.info.autoReset = false; // render() resets once per frame so info covers every pass
  window.addEventListener('resize', resize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
  resize();

  // Seed the rig with the gameplay framing so the first frame is sensible.
  gameplayView(null, curPos, curLook);
  camera.position.copy(curPos);
  camera.lookAt(curLook);

  setQuality(urlQ === 'low' ? 'low' : 'high', { auto: true });

  return {
    renderer, scene, camera, updateCamera, render, setQuality, sun, hemi, stats,
    get quality() { return quality; },
    /** Current team-side view rotation about +y (0 = team 0 view, PI = team 1 view). */
    get viewYaw() { return viewYaw; },
    get localTeam() { return localTeam; },
    /** Debug: false keeps the sun fixed in world space (team-0 lighting) for every view. */
    get sunFollowsView() { return sunFollowsView; },
    set sunFollowsView(v) { sunFollowsView = !!v; },
    get fitDistance() { return fitDist; },
  };
}

/** Fit the directional light's orthographic shadow camera tightly around a world-space box. */
function fitShadowFrustum(light, box) {
  const cam = light.shadow.camera;
  const view = new THREE.Matrix4().lookAt(light.position, light.target.position, new THREE.Vector3(0, 1, 0));
  view.setPosition(light.position);
  const inv = view.clone().invert();
  const p = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  cam.left = minX - 0.5; cam.right = maxX + 0.5;
  cam.bottom = minY - 0.5; cam.top = maxY + 0.5;
  cam.near = Math.max(0.5, -maxZ - 2);
  cam.far = -minZ + 2;
  cam.updateProjectionMatrix();
}
