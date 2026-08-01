// Ricochet Spire — deterministic randomness.
//
// The whole game hangs off this file. A run is a SEED, and everything the run
// contains — the shape of the map, which arena each battle uses, which three
// cards a reward offers, what the shop stocks — is derived from that seed. Two
// people playing the same Daily Challenge get the identical run, a saved run
// resumes without storing any RNG state, and the balance bots in tests/ measure
// real design changes instead of lucky rolls.
//
// The one rule that makes all of that work:
//
//   NEVER draw from a running stream. Derive a fresh generator from
//   COORDINATES — RNG.sub(seed, "reward", act, floor) — so the numbers a node
//   produces depend only on where that node is, never on what the player did
//   to get there or how many draws happened first.
//
// Consequence: `serialize()` in run.js stores {seed, act, floor, path, deck,
// gold, hp} and nothing else. Rebuilding the run rebuilds every draw exactly.
//
// This mirrors GK.util.seedFrom / GK.util.seededRand, but is defined here with
// no `window` dependency so game.js and run.js load into a bare Node sandbox.

const RNG = {
  // FNV-1a: any string -> a 32-bit seed. "2026-08-01" -> a day's challenge.
  seedFrom(str) {
    const s = String(str);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  },

  // mulberry32, with the conveniences hung off the callable.
  make(seed = 0) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = (lo, hi) => lo + next() * (hi - lo);
    next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    next.chance = (p) => next() < p;
    next.shuffle = (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    // Weighted pick. `weight` maps an item to a positive number; items with a
    // weight of 0 or less can never come out.
    next.weighted = (arr, weight) => {
      let total = 0;
      for (const it of arr) total += Math.max(0, weight(it));
      if (total <= 0) return null;
      let r = next() * total;
      for (const it of arr) {
        r -= Math.max(0, weight(it));
        if (r <= 0) return it;
      }
      return arr[arr.length - 1];
    };
    return next;
  },

  // The whole point of the file: a generator identified by where it is used.
  // RNG.sub(seed, "shop", 2, 8) always yields the same numbers for act 2's
  // floor-8 shop, no matter what has been drawn anywhere else.
  sub(seed, ...parts) {
    return RNG.make((seed ^ RNG.seedFrom(parts.join(""))) >>> 0);
  },

  // Today's Daily Challenge seed, in the player's own timezone — the date on
  // their calendar is the date they play.
  today(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  },
};

if (typeof module !== "undefined") module.exports = { RNG };
