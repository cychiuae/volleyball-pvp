// Pose = flat Float32Array of animation channels, so poses can be blended without allocation.
// Conventions (character faces +Z, its left is +X):
//   TILT_X  + = whole body leans forward (pivot at feet)    TILT_Z + = leans toward -X
//   TORSO_X + = bends forward   TORSO_Y + = right shoulder (-X) twists forward
//   HEAD_X  + = looks down
//   *SX     + = arm raised forward/up (0 = hanging, PI = straight up)
//   *SZ     + = arm spread outward     *EL + = elbow bent (forearm folds forward/up)
//   SHRUG   = shoulder lift (m)        ARM_ST = arm stretch factor (1 = normal)
//   *FZ/*FY = foot target offset forward / up (m), solved with 2-bone IK
//   CROUCH  = hip drop (m), feet stay planted       SQ = squash(-)/stretch(+) of the whole rig
export const RIG_Y = 0, RIG_Z = 1, TILT_X = 2, TILT_Z = 3, SQ = 4, CROUCH = 5, HIPS_X = 6;
export const TORSO_X = 7, TORSO_Y = 8, TORSO_Z = 9, HEAD_X = 10, HEAD_Y = 11, HEAD_Z = 12;
export const LSX = 13, LSZ = 14, LEL = 15, RSX = 16, RSZ = 17, REL = 18;
export const SHRUG = 19, ARM_ST = 20, HAND_S = 21;
export const LFZ = 22, LFY = 23, RFZ = 24, RFY = 25, LEG_SPREAD = 26;
export const POSE_SIZE = 27;

export function neutral(p) {
  p.fill(0);
  p[ARM_ST] = 1;
  p[HAND_S] = 1;
  p[LEG_SPREAD] = 0.06;
  return p;
}

export function createPose() {
  return neutral(new Float32Array(POSE_SIZE));
}

/** out = a + (b - a) * w. Safe when out aliases a or b. */
export function blendPose(out, a, b, w) {
  for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * w;
  return out;
}

// ---------- easing ----------
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Normalized progress of t through [a, b], clamped. */
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
export const easeOutCubic = (x) => 1 - (1 - x) * (1 - x) * (1 - x);
export const easeInCubic = (x) => x * x * x;
export const easeInQuad = (x) => x * x;
export const easeInOutSine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
export const easeOutBack = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const y = x - 1;
  return 1 + c3 * y * y * y + c1 * y * y;
};
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Three-stage keyframe: base -> v1 (w1) -> v2 (w2) -> v3 (w3). */
export const k3 = (base, v1, v2, v3, w1, w2, w3) => lerp(lerp(lerp(base, v1, w1), v2, w2), v3, w3);
