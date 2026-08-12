// rng.js
// Deterministic PRNG so a given seed always reproduces the exact same
// network, events, budget, and options. Math.random() must never be used
// anywhere in scenario generation.

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 * Same seed -> same infinite output sequence, forever, across browsers.
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [min, max). */
export function rngFloat(rng, min, max) {
  return min + rng() * (max - min);
}

/** Random integer in [min, max] inclusive. */
export function rngInt(rng, min, max) {
  return Math.floor(rngFloat(rng, min, max + 1));
}

/** Pick one element deterministically. */
export function rngPick(rng, array) {
  if (array.length === 0) throw new Error('rngPick: empty array');
  return array[rngInt(rng, 0, array.length - 1)];
}

/** Shuffle a copy of the array deterministically (Fisher-Yates). */
export function rngShuffle(rng, array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Produce a 32-bit unsigned seed from the browser's CSPRNG.
 * Used ONLY to pick a fresh seed for a brand new round — never used to
 * drive gameplay math directly, and never used again once a seed exists.
 */
export function generateRandomSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
  }
  // Fallback only for non-browser (e.g. Node test) environments.
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
