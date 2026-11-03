// Seeded RNG so a plan is reproducible from its URL. mulberry32: small, fast,
// and good enough for picking callouts.
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => (list.length ? list[int(list.length)] : undefined);
  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

export function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
