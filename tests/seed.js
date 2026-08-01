// Seed the SANDBOX's Math.random, loaded before every other script in the
// test bundle.
//
// The engine itself never calls Math.random — it draws from js/rng.js. This
// exists for two other reasons:
//
//   1. Anything that sneaks a Math.random in later fails loudly and
//      reproducibly instead of making the suite flaky.
//   2. THE BOTS need randomness of their own (a mistimed paddle, a greedy
//      draft) and the sandbox's seeded generator is not visible from the test
//      file — that runs in Node's own realm with a different, unseeded
//      Math.random. So the seeded one is exported as __rand() and every bot
//      routes its own coin flips through it.

(function () {
  let a = 0x9e3779b9;
  const mulberry = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = mulberry;

  globalThis.__reseed = function (n) { a = (n >>> 0) || 1; };
  globalThis.__rand = function () { return mulberry(); };
})();
