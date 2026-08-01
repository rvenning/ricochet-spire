// Lints the thirty arenas, the boss rooms and the brick registry.
//
// The check that earns its keep is the flood fill: it walks the empty space
// around a layout and proves every brick you have to break can actually be
// reached. Steel is impassable, so a layout that accidentally rings a scoring
// brick with it is unwinnable — the arena simply never ends, the run stalls
// on a 155-second timeout, and there is nothing in the console to explain it.
// Hand-counted rows get this wrong about one time in fifty.

const test = require("node:test");
const assert = require("node:assert");
const { loadEngine } = require("./load.js");

const S = loadEngine();
const { ARENAS, GRID_COLS, HAZARD_KINDS, BRICKS, BRICK_CHARS, arenaPool,
        BOSS_LIST, BOSS_POOL, POWERUP_LIST, pickPowerup, RNG, LW, LH,
        BRICK_TOP, BH, PADDLE_Y } = S;

const ALL_ROOMS = [...ARENAS, ...BOSS_LIST.map((b) => b.room)];

test("every row is exactly the grid width and uses known bricks", () => {
  const fails = [];
  for (const a of ALL_ROOMS) {
    if (!a.rows.length) fails.push(`${a.id}: no rows`);
    a.rows.forEach((row, i) => {
      if (row.length !== GRID_COLS) fails.push(`${a.id} row ${i}: ${row.length} chars, want ${GRID_COLS}`);
      for (const ch of row) if (!BRICK_CHARS.includes(ch)) fails.push(`${a.id} row ${i}: unknown brick "${ch}"`);
    });
  }
  assert.deepEqual(fails, []);
});

test("no scoring brick is sealed behind indestructible ones", () => {
  const fails = [];
  for (const a of ALL_ROOMS) {
    const R = a.rows.length, C = GRID_COLS;
    const at = (r, c) => a.rows[r][c];
    const passable = (r, c) => {
      if (r < 0 || r >= R || c < 0 || c >= C) return true;    // open space outside
      const ch = at(r, c);
      if (ch === ".") return true;
      const t = BRICKS[ch];
      return !!t && t.hp !== Infinity;                        // you can break it and go on
    };

    const seen = new Set();
    const q = [];
    const push = (r, c) => {
      const k = r + ":" + c;
      if (seen.has(k) || !passable(r, c)) return;
      if (r < -1 || r > R || c < -1 || c > C) return;
      seen.add(k); q.push([r, c]);
    };
    for (let c = -1; c <= C; c++) { push(-1, c); push(R, c); }
    for (let r = -1; r <= R; r++) { push(r, -1); push(r, C); }
    while (q.length) {
      const [r, c] = q.pop();
      push(r - 1, c); push(r + 1, c); push(r, c - 1); push(r, c + 1);
    }

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const t = BRICKS[at(r, c)];
        if (t && t.counts && !seen.has(r + ":" + c)) {
          fails.push(`${a.id}: ${t.name} at row ${r} col ${c} is sealed in`);
        }
      }
    }
  }
  assert.deepEqual(fails, []);
});

test("gates come in pairs and there is always something to break", () => {
  const fails = [];
  for (const a of ALL_ROOMS) {
    const flat = a.rows.join("");
    const gates = [...flat].filter((ch) => ch === "P").length;
    if (gates % 2 !== 0) fails.push(`${a.id}: ${gates} gates — they teleport in pairs`);
    if (gates > 4) fails.push(`${a.id}: ${gates} gates is too many to read`);
    const scoring = [...flat].filter((ch) => BRICKS[ch] && BRICKS[ch].counts).length;
    if (!a.boss && scoring < 8) fails.push(`${a.id}: only ${scoring} breakable bricks`);
  }
  assert.deepEqual(fails, []);
});

test("the brick field fits above the paddle", () => {
  const fails = [];
  for (const a of ALL_ROOMS) {
    const bottom = BRICK_TOP + a.rows.length * BH;
    if (bottom > PADDLE_Y - 120) fails.push(`${a.id}: bricks reach ${bottom}, paddle is at ${PADDLE_Y}`);
  }
  assert.deepEqual(fails, []);
});

test("every hazard is a kind the engine implements, positioned on the field", () => {
  const fails = [];
  for (const a of ALL_ROOMS) {
    for (const h of a.hazards) {
      if (!HAZARD_KINDS.includes(h.kind)) { fails.push(`${a.id}: unknown hazard "${h.kind}"`); continue; }
      const need = {
        wind: ["ax"], gravity: ["ay"], conveyor: ["y", "h", "vx"],
        portal: ["ax", "ay", "bx", "by"], blackhole: ["x", "y", "r", "pull"],
        mover: ["x", "y", "w", "h", "span", "period"],
        laser: ["x", "w", "on", "off"], bumper: ["x", "y", "r", "boost"],
        dark: ["r"], ice: [], drift: ["amp", "period"],
      }[h.kind];
      for (const k of need) {
        if (typeof h[k] !== "number") fails.push(`${a.id}: ${h.kind} is missing ${k}`);
      }
      // Anything with a position has to be somewhere the ball can go.
      if (h.x !== undefined && (h.x < -40 || h.x > LW + 40)) fails.push(`${a.id}: ${h.kind} x=${h.x} off the field`);
      if (h.y !== undefined && (h.y < 0 || h.y > LH)) fails.push(`${a.id}: ${h.kind} y=${h.y} off the field`);
      if (h.kind === "mover" && (h.x + h.span + h.w > LW + 30)) fails.push(`${a.id}: mover slides off the right edge`);
      if (h.kind === "laser" && (h.on <= 0 || h.off <= 0)) fails.push(`${a.id}: laser never cycles`);
      if (h.kind === "conveyor" && (h.y < BRICK_TOP || h.y + h.h > PADDLE_Y)) {
        fails.push(`${a.id}: conveyor is not between the bricks and the paddle`);
      }
    }
    // A "twist" arena with no hazard and no exotic brick is just a rectangle.
    const exotic = a.rows.join("").split("").some((ch) => "XBGRAVPMT".includes(ch));
    if (!a.boss && !a.hazards.length && !exotic && a.id !== "foyer") {
      fails.push(`${a.id}: promises a twist and has neither a hazard nor a special brick`);
    }
  }
  assert.deepEqual(fails, []);
});

test("each act has enough rooms for a run never to repeat one", () => {
  const fails = [];
  for (let act = 1; act <= 3; act++) {
    const std = arenaPool(act, "standard");
    const elite = arenaPool(act, "elite");
    // A single act visits at most ~8 standard rooms and ~3 elites.
    if (std.length < 7) fails.push(`act ${act}: only ${std.length} standard arenas`);
    if (elite.length < 3) fails.push(`act ${act}: only ${elite.length} elite arenas`);
    for (const a of [...std, ...elite]) {
      if (!a.name || !a.twist) fails.push(`${a.id}: needs a name and a twist line`);
      if (!(a.speed >= 400 && a.speed <= 600)) fails.push(`${a.id}: speed ${a.speed} out of band`);
    }
  }
  assert.deepEqual(fails, []);
});

test("the spire gets faster and stranger act by act", () => {
  const mean = (act) => {
    const p = ARENAS.filter((a) => a.act === act);
    return p.reduce((s, a) => s + a.speed, 0) / p.length;
  };
  assert.ok(mean(2) > mean(1), "act 2 must be faster than act 1");
  assert.ok(mean(3) > mean(2), "act 3 must be faster than act 2");

  const twists = (act) => ARENAS.filter((a) => a.act === act)
    .reduce((s, a) => s + a.hazards.length, 0);
  assert.ok(twists(3) >= twists(1), "the top of the spire should not be the calmest part of it");
});

test("arena ids are unique", () => {
  const seen = new Set();
  const dupes = [];
  for (const a of ALL_ROOMS) { if (seen.has(a.id)) dupes.push(a.id); seen.add(a.id); }
  assert.deepEqual(dupes, []);
});

test("brick registry invariants", () => {
  const fails = [];
  for (const [ch, t] of Object.entries(BRICKS)) {
    if (!t) continue;
    if (!t.name) fails.push(`${ch}: no name`);
    if (t.hp !== Infinity && !(t.hp >= 1 && t.hp <= 6)) fails.push(`${ch}: hp ${t.hp} out of band`);
    if (t.counts !== (t.hp !== Infinity)) fails.push(`${ch}: counts flag disagrees with hp`);
    if (t.counts && !(t.score > 0)) fails.push(`${ch}: breakable but worth nothing`);
    if (!t.counts && t.score !== 0) fails.push(`${ch}: unbreakable but scores`);
    if (!Array.isArray(t.colors) || t.colors.length !== 2) fails.push(`${ch}: needs two colours`);
  }
  // The plain bricks must climb in value with their toughness, or there is no
  // reason for the arenas to use the tougher ones.
  const plain = ["1", "2", "3", "4"].map((c) => BRICKS[c]);
  for (let i = 1; i < plain.length; i++) {
    if (plain[i].score <= plain[i - 1].score) fails.push(`brick ${i + 1} is not worth more than ${i}`);
    if (plain[i].hp <= plain[i - 1].hp) fails.push(`brick ${i + 1} is not tougher than ${i}`);
  }
  assert.deepEqual(fails, []);
});

test("bosses are registered, complete, and pooled by act", () => {
  const fails = [];
  for (const b of BOSS_LIST) {
    if (!b.name || !b.icon || !b.blurb) fails.push(`${b.key}: incomplete`);
    if (typeof b.build !== "function" || typeof b.update !== "function") fails.push(`${b.key}: missing build/update`);
    if (!b.room || !b.room.rows) fails.push(`${b.key}: no room`);
    if (b.room.bossKey !== b.key) fails.push(`${b.key}: room points at ${b.room.bossKey}`);
    if (!(b.phases >= 2)) fails.push(`${b.key}: the brief wants multiple phases`);
  }
  for (const [act, keys] of Object.entries(BOSS_POOL)) {
    if (!keys.length) fails.push(`act ${act}: no boss`);
    for (const k of keys) if (!S.BOSSES[k]) fails.push(`act ${act}: unknown boss ${k}`);
  }
  // The first entry of each act's pool is the one available without an
  // unlock, so it must never be a locked boss.
  const locked = new Set(S.UNLOCKS.filter((u) => u.kind === "boss").map((u) => u.ref));
  for (const [act, keys] of Object.entries(BOSS_POOL)) {
    if (locked.has(keys[0])) fails.push(`act ${act}: default boss ${keys[0]} is behind an unlock`);
  }
  assert.deepEqual(fails, []);
});

test("power-ups are drawable and mostly good", () => {
  const fails = [];
  for (const p of POWERUP_LIST) {
    if (!p.name || !p.icon || !p.color) fails.push(`${p.id}: incomplete`);
    if (p.kind === "timed" && !(p.dur > 0)) fails.push(`${p.id}: timed with no duration`);
    if (p.kind === "instant" && typeof p.apply !== "function") fails.push(`${p.id}: instant with no effect`);
    if (!(p.weight > 0)) fails.push(`${p.id}: can never drop`);
  }
  // Over a thousand seeded draws every power-up must appear, and the bad ones
  // must stay a minority — a falling pickup you dread more often than not is
  // just a hazard with extra steps.
  const rng = RNG.make(4242);
  const seen = {};
  let bad = 0;
  for (let i = 0; i < 1000; i++) {
    const p = pickPowerup(rng, 1);
    seen[p.id] = (seen[p.id] || 0) + 1;
    if (p.bad) bad++;
  }
  for (const p of POWERUP_LIST) if (!seen[p.id]) fails.push(`${p.id} never dropped in 1000 draws`);
  if (bad > 250) fails.push(`${bad}/1000 drops are bad ones — too many`);
  assert.deepEqual(fails, []);
});
