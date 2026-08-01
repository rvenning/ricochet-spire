// Ricochet Spire — brick registry.
//
// A brick type is one entry keyed by the character used in an arena's `rows`.
// Adding a new brick is one entry here plus a letter in a layout — the engine
// knows nothing about any specific type, it only calls the hooks.
//
// `hp: Infinity` means indestructible, and `counts` is derived from that: only
// countable bricks have to be cleared to finish an arena, so a wall of steel
// can decorate a layout without making it unwinnable.
//
// `onHit` fires on every hit that lands, BEFORE damage is applied.
// `onBreak` fires once, when the brick's hp reaches zero.
// `tick(g, b, dt)` runs each fixed step for the few bricks that live.

const BRICKS = {
  ".": null,                                    // empty cell

  "1": {
    name: "Chip", hp: 1, score: 40,
    colors: ["#4a5df0", "#8b9bff"], glyph: "",
  },

  "2": {
    name: "Slab", hp: 2, score: 75,
    colors: ["#7b3fe4", "#b98cff"], glyph: "",
  },

  "3": {
    name: "Block", hp: 3, score: 130,
    colors: ["#c22fa4", "#ff7fdc"], glyph: "",
  },

  "4": {
    name: "Monolith", hp: 4, score: 220,
    colors: ["#d94a2b", "#ff9a6e"], glyph: "",
  },

  "S": {
    // Steel shapes the arena. It never breaks, so it must never enclose a
    // countable brick — tests/arenas.test.js runs a flood fill to prove it
    // doesn't.
    name: "Steel", hp: Infinity, score: 0,
    colors: ["#3d4358", "#6b7490"], glyph: "▦",
  },

  "X": {
    name: "Volatile", hp: 1, score: 110,
    colors: ["#e8672a", "#ffbb63"], glyph: "✷",
    onBreak(g, b) { g.explodeAt(b.cx, b.cy, 1.6, b); },
  },

  "B": {
    // Hit it and it starts counting. The fuse is a fixed 1.3s rather than a
    // roll, so a chain reaction plays out identically for every player on the
    // same seed.
    name: "Charge", hp: 2, score: 160,
    colors: ["#2b3350", "#ff5470"], glyph: "◉",
    onHit(g, b) { if (!b.fuse) { b.fuse = 1.3; g.emit("fuse", { brick: b }); } },
    onBreak(g, b) { g.explodeAt(b.cx, b.cy, 2.1, b); },
    tick(g, b, dt) {
      if (!b.fuse) return;
      b.fuse -= dt;
      if (b.fuse <= 0) { b.fuse = 0; g.damageBrick(b, 99, null, "fuse"); }
    },
  },

  "G": {
    // Worth a fortune and dies to a breath. The reason to aim.
    name: "Prism", hp: 1, score: 400, sparkle: true,
    colors: ["#1fd8c4", "#a9fff2"], glyph: "◆",
    onBreak(g, b) { g.shockNeighbours(b, 1); },
  },

  "R": {
    // Living brick: heals 1 hp every 6 seconds unless you finish it off.
    name: "Knitter", hp: 3, score: 190, alive: true,
    colors: ["#2f8f4f", "#7ee08f"], glyph: "❃",
    tick(g, b, dt) {
      if (b.hp >= b.maxHp) return;
      b.regen = (b.regen || 0) + dt;
      if (b.regen >= 6) { b.regen = 0; b.hp++; g.emit("regen", { brick: b }); }
    },
  },

  "A": {
    // Armour caps every hit at 1 damage, so raw damage cards stop working and
    // Piercing / Heavy / explosions become the answer. This is the brick that
    // makes deck-building matter instead of "take the biggest number".
    name: "Bulwark", hp: 4, score: 240, armour: true,
    colors: ["#8a6b2f", "#e0bd6a"], glyph: "◈",
  },

  "V": {
    name: "Vault", hp: 2, score: 90, drop: "always",
    colors: ["#b8912b", "#ffd97a"], glyph: "★",
  },

  "P": {
    // Two portal bricks per arena, linked in the order they appear. A ball
    // that touches one comes out of the other travelling the same way.
    name: "Gate", hp: Infinity, score: 0, portal: true,
    colors: ["#2a1f52", "#a06bff"], glyph: "◎",
  },

  "M": {
    // Turns the ball a quarter-turn instead of reflecting it. Cheap chaos, and
    // the arenas that use it read completely differently.
    name: "Deflector", hp: 2, score: 150, deflect: true,
    colors: ["#155e75", "#67e8f9"], glyph: "◤",
  },

  "T": {
    // Growing bricks: +1 hp every 10s, capped, so a slow arena punishes
    // dithering. The Growing Bricks rule card turns every brick into one.
    name: "Creeper", hp: 2, score: 170, grows: true,
    colors: ["#5b3fa8", "#c0a6ff"], glyph: "▲",
    tick(g, b, dt) {
      b.grow = (b.grow || 0) + dt;
      // Capped low: an unbounded creeper turns a slow room into an unclearable
      // one rather than a tense one.
      if (b.grow >= 10 && b.maxHp < 5) { b.grow = 0; b.maxHp++; b.hp++; }
    },
  },
};

// Derived once: an arena is finished when every COUNTABLE brick is gone.
// Steel and gates decorate; they are never part of the objective.
for (const [ch, t] of Object.entries(BRICKS)) {
  if (!t) continue;
  t.ch = ch;
  t.counts = t.hp !== Infinity;
  t.maxHp = t.hp;
}

const BRICK_CHARS = Object.keys(BRICKS);

if (typeof module !== "undefined") module.exports = { BRICKS, BRICK_CHARS };
