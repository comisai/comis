// Shared world helpers for the self-driving real-world simulators.
// Zero-dependency. Seedable PRNG so an episode is reproducible (SIM_SEED), plus the
// canonical graded-outcome shape every terminal "act" tool returns.

/** Deterministic PRNG (mulberry32). Same seed → same stream. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string → uint32 hash (so SIM_SEED can be a word, not just a number). */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The canonical outcome a terminal "act" tool returns so Loop A's resolver gets a
 * clean success/failure signal. `outcome` ∈ 'success' | 'failure' | 'partial'.
 */
export function grade(outcome, { score = null, rationale = "", ...extra } = {}) {
  return { graded: true, outcome, score, rationale, ...extra };
}

/** Pick one element using the seeded rng. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Case-insensitive substring match used by the `query_*` observe tools. */
export function matches(haystack, needle) {
  if (!needle) return true;
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

/** Coerce a CLI flag string into number/bool/json/string. */
export function coerce(v) {
  if (v === undefined) return true; // bare flag → boolean true
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through to string */
    }
  }
  return v;
}
