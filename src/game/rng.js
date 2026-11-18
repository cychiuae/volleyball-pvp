// Small seedable PRNG (mulberry32) so headless tests are reproducible.

export function createRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  let spare = null;
  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    gauss() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u === 0) u = next();
      v = next();
      const m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    },
  };
}
