// Ricochet Spire — the arenas.
//
// "Levels shouldn't simply be rectangles." Every arena is a brick layout PLUS a
// twist: something in the room that changes how the ball moves. The layout is
// 12-character rows (see bricks.js for the alphabet) and the twist is a list of
// hazards, each of which is plain data the sim knows how to run.
//
// Rows are written as fixed-width strings on purpose — a miscounted row is the
// classic way to ship an arena that can't be finished, so tests/arenas.test.js
// checks every row's width, checks every character exists, and runs a flood
// fill from outside the layout proving no countable brick is sealed behind
// steel. All thirty are linted on every `node --test`.
//
// `speed` is the ball's launch speed in logical px/s, and it is the single
// biggest lever on how a room feels. The playfield is 420x600, so ~460 means
// the ball crosses it about once a second, which is arcade Breakout's pace.
// The first draft of this file was half that and every room took two minutes;
// tests/bot.test.js now asserts a clear-time band so it cannot drift back.
//
// A run never plays these in a fixed order: run.js draws from the pool for the
// current act and tier, seeded, so two runs on the same floor rarely match.

const GRID_COLS = 12;

// Hazard kinds the sim implements. A kind not in this list is a typo, and
// tests/arenas.test.js fails on it.
const HAZARD_KINDS = [
  "wind",       // { ax }            constant sideways push
  "gravity",    // { ay }            constant downward pull
  "conveyor",   // { y, h, vx }      a band that drags the ball along
  "portal",     // { ax, ay, bx, by } free-standing gate pair
  "blackhole",  // { x, y, r, pull } radial attraction inside r
  "mover",      // { x, y, w, h, span, period }  solid wall sliding sideways
  "laser",      // { x, w, on, off, phase }      column that turns solid
  "bumper",     // { x, y, r, boost }            round wall that speeds you up
  "dark",       // { r }             renderer only: you can only see near the ball
  "ice",        // {}                the paddle slides instead of stopping
  "drift",      // { amp, period }   the whole brick field slides side to side
];

const ARENAS = [
  /* ============================================================== ACT ONE */
  { id: "foyer", name: "The Foyer", act: 1, tier: "standard", speed: 440,
    twist: "A quiet room to find your hands in.",
    rows: [
      "............",
      "...111111...",
      "...122221...",
      "...111111...",
    ], hazards: [] },

  { id: "draught", name: "Draught Hall", act: 1, tier: "standard", speed: 452,
    twist: "A steady draught pushes everything to the right.",
    rows: [
      "..11....11..",
      ".1111..1111.",
      "..11....11..",
      "....1122....",
      "....2211....",
    ], hazards: [{ kind: "wind", ax: 74 }] },

  { id: "slowbelt", name: "Slow Belt", act: 1, tier: "standard", speed: 448,
    twist: "A conveyor across the middle drags the ball left.",
    rows: [
      "...111111...",
      "..11222211..",
      "..11222211..",
      "...111111...",
    ], hazards: [{ kind: "conveyor", y: 300, h: 46, vx: -132 }] },

  { id: "gatehouse", name: "Gatehouse", act: 1, tier: "standard", speed: 456,
    twist: "Two gates in the wall. In one side, out the other.",
    rows: [
      "P..1111...S.",
      "...1221.....",
      "..112211....",
      "...1111...P.",
    ], hazards: [] },

  { id: "pendulum", name: "Pendulum", act: 1, tier: "standard", speed: 460,
    twist: "A slab of steel swings back and forth in front of the bricks.",
    rows: [
      "..222222222.",
      "..1........1",
      "..1.111111.1",
      "..1........1",
      "..222222222.",
    ], hazards: [{ kind: "mover", x: 120, y: 330, w: 88, h: 14, span: 150, period: 5.5 }] },

  { id: "chillpit", name: "Chill Pit", act: 1, tier: "standard", speed: 444,
    twist: "The floor is ice. Your paddle keeps going after you stop.",
    rows: [
      "..11222211..",
      ".1122222211.",
      "..11222211..",
      "....1111....",
    ], hazards: [{ kind: "ice" }] },

  { id: "beacon", name: "Beacon", act: 1, tier: "standard", speed: 464,
    twist: "A light column blinks on and off across the middle of the room.",
    // Bricks in the MIDDLE, not down the side walls. The first version parked
    // two columns against each edge and the perfect bot needed nearly two
    // minutes to pick them off — a brick in the far corner is worth about
    // eight in the middle, which is not a difficulty curve, it is a wait.
    rows: [
      "............",
      "..22222222..",
      "..2V2222V2..",
      "..22222222..",
      "...222222...",
    ], hazards: [{ kind: "laser", x: 210, w: 16, on: 1.5, off: 2.6, phase: 0 }] },

  { id: "kiln", name: "The Kiln", act: 1, tier: "elite", speed: 478,
    twist: "Volatile bricks, and everything falls harder than it should.",
    rows: [
      "..X2222222X.",
      "..2X.....X2.",
      "..2..333..2.",
      "..2X.....X2.",
      "..X2222222X.",
    ], hazards: [{ kind: "gravity", ay: 118 }] },

  { id: "ironworks", name: "Ironworks", act: 1, tier: "elite", speed: 472,
    twist: "Armour caps every hit. Find another way through.",
    rows: [
      ".A........A.",
      ".122222221..",
      "..2.3333.2..",
      ".122222221..",
      ".A........A.",
    ], hazards: [] },

  { id: "splitwind", name: "Splitwind", act: 1, tier: "elite", speed: 475,
    twist: "A hard crosswind and a bumper that flings the ball faster.",
    rows: [
      "...222222...",
      "..22S..S22..",
      "..2......2..",
      "..22S..S22..",
      "...222222...",
    ], hazards: [
      { kind: "wind", ax: -110 },
      { kind: "bumper", x: 210, y: 400, r: 20, boost: 1.1 },
    ] },

  /* ============================================================== ACT TWO */
  { id: "loom", name: "The Loom", act: 2, tier: "standard", speed: 490,
    twist: "Knitters mend themselves. Finish what you start.",
    rows: [
      "R..2222..R..",
      ".2..RR..2...",
      "22.2222.22..",
      ".2..RR..2...",
      "R..2222..R..",
    ], hazards: [] },

  { id: "prismvault", name: "Prism Vault", act: 2, tier: "standard", speed: 486,
    twist: "You can barely see. What glitters is worth a fortune.",
    rows: [
      "SS......SS..",
      "S.2G22G2.S..",
      "..222222....",
      "S.2G22G2.S..",
      "SS......SS..",
    ], hazards: [{ kind: "dark", r: 168 }] },

  { id: "longdrift", name: "Long Drift", act: 2, tier: "standard", speed: 483,
    twist: "The whole wall of bricks is sliding sideways.",
    rows: [
      "223223223223",
      "3..3..3..3..",
      "223223223223",
      "..3..3..3..3",
    ], hazards: [{ kind: "drift", amp: 46, period: 7.5 }] },

  { id: "twingates", name: "Twin Gates", act: 2, tier: "standard", speed: 494,
    twist: "Four gates. Nothing goes where you expect.",
    rows: [
      "P...2222...P",
      "..22.33.22..",
      ".2..3333..2.",
      "..22.33.22..",
      "P...2222...P",
    ], hazards: [] },

  { id: "crossbelt", name: "Cross-Belt", act: 2, tier: "standard", speed: 490,
    twist: "Two belts running opposite ways. Pick your lane.",
    rows: [
      "3333....3333",
      "3..3.VV.3..3",
      "3333....3333",
      "..2222222...",
    ], hazards: [
      { kind: "conveyor", y: 300, h: 40, vx: 150 },
      { kind: "conveyor", y: 400, h: 40, vx: -150 },
    ] },

  { id: "deadfall", name: "Deadfall", act: 2, tier: "standard", speed: 486,
    twist: "Something heavy sits in the middle of the room.",
    rows: [
      "2222222222..",
      "2........2..",
      "2..S..S..2..",
      "2........2..",
      "2222222222..",
    ], hazards: [{ kind: "blackhole", x: 210, y: 420, r: 165, pull: 250 }] },

  { id: "battery", name: "Battery", act: 2, tier: "standard", speed: 498,
    twist: "Charges. Hit one and step back.",
    rows: [
      ".B2222222B..",
      ".2..333..2..",
      ".2.3B3B3.2..",
      ".2..333..2..",
      ".B2222222B..",
    ], hazards: [] },

  { id: "grinder", name: "The Grinder", act: 2, tier: "elite", speed: 509,
    twist: "Two steel jaws sliding across an armoured wall.",
    rows: [
      "A3333333A...",
      ".3.....3....",
      "..333333....",
      ".3.....3....",
      "A3333333A...",
    ], hazards: [
      { kind: "mover", x: 60, y: 320, w: 76, h: 13, span: 130, period: 4.2 },
      { kind: "mover", x: 240, y: 400, w: 76, h: 13, span: 130, period: 5.1 },
    ] },

  { id: "nursery", name: "The Nursery", act: 2, tier: "elite", speed: 502,
    twist: "Creepers thicken while you dither. Be quick.",
    // Growing bricks feed back on themselves — a slow clear makes the room
    // tougher, which makes the clear slower. The first version packed in
    // nineteen Creepers across five rows and spiralled to 98s. Fewer of them,
    // and the loop stays a threat rather than a trap.
    rows: [
      "T3333333T3..",
      ".3.TTTT.3...",
      "..3TTTT3....",
      "T3333333T3..",
    ], hazards: [] },

  { id: "static", name: "Static Field", act: 2, tier: "elite", speed: 505,
    twist: "Two light columns, out of step. Time your run.",
    rows: [
      "33.333333.33",
      "33.3.GG.3.33",
      "33.333333.33",
      "..X......X..",
    ], hazards: [
      { kind: "laser", x: 96, w: 16, on: 1.6, off: 2.2, phase: 0 },
      { kind: "laser", x: 312, w: 16, on: 1.6, off: 2.2, phase: 1.9 },
    ] },

  /* ============================================================ ACT THREE */
  { id: "mirrorhall", name: "Mirror Hall", act: 3, tier: "standard", speed: 517,
    twist: "Deflectors turn the ball a quarter-turn instead of bouncing it.",
    rows: [
      "M33333333M..",
      "3M3.44.3M3..",
      "33M4444M33..",
      "3M3.44.3M3..",
      "M33333333M..",
    ], hazards: [] },

  { id: "cathedral", name: "Cathedral", act: 3, tier: "standard", speed: 521,
    twist: "Vast, and gravity is heavier in here.",
    // A nave, not a solid block. Forty-five Monoliths under act-3 scaling came
    // to three hundred hit points and even the strongest deck in the game ran
    // out the clock on it.
    rows: [
      "334444444433",
      "3..4....4..3",
      "...3.GG.3...",
      "3..4....4..3",
      "3334....4333",
    ], hazards: [{ kind: "gravity", ay: 138 }] },

  { id: "riptide", name: "Riptide", act: 3, tier: "standard", speed: 513,
    twist: "A belt and a crosswind pulling the same way.",
    rows: [
      "3344443344..",
      "3.4..4.34...",
      "3344443344..",
      "..3444443...",
    ], hazards: [
      { kind: "conveyor", y: 330, h: 52, vx: 168 },
      { kind: "wind", ax: 92 },
    ] },

  { id: "eventide", name: "Eventide", act: 3, tier: "standard", speed: 517,
    twist: "Dark, and something is pulling in the dark.",
    rows: [
      "34G4444G43..",
      "4........4..",
      "3.444444.3..",
      "4........4..",
      "34G4444G43..",
    ], hazards: [
      { kind: "dark", r: 150 },
      { kind: "blackhole", x: 200, y: 430, r: 180, pull: 300 },
    ] },

  { id: "anvil", name: "The Anvil", act: 3, tier: "standard", speed: 524,
    twist: "Solid all the way through. Bring something that pierces.",
    rows: [
      "A4444444A4..",
      "44.A44A.44..",
      "A4444444A4..",
      "..44444444..",
    ], hazards: [] },

  { id: "serpentine", name: "Serpentine", act: 3, tier: "standard", speed: 521,
    twist: "Three steel bars sliding at different speeds.",
    rows: [
      "3434343434..",
      "4343434343..",
      "3434343434..",
      "4343434343..",
    ], hazards: [
      { kind: "mover", x: 40, y: 330, w: 70, h: 12, span: 160, period: 3.6 },
      { kind: "mover", x: 180, y: 386, w: 70, h: 12, span: 160, period: 4.9 },
      { kind: "mover", x: 100, y: 442, w: 70, h: 12, span: 160, period: 6.3 },
    ] },

  { id: "cascade", name: "Cascade", act: 3, tier: "standard", speed: 517,
    twist: "Wire the wall, then set one corner off and stand well back.",
    // Explosives are spaced OUT, not packed. Packed together they chained
    // across the whole board in under two seconds and an idle paddle could
    // clear the room — the bots caught it on the first report.
    rows: [
      "X4X44444X4X4",
      "4B444444B4B4",
      "44X4444X44X4",
      "4B444B444B44",
    ], hazards: [] },

  { id: "crownvault", name: "Crown Vault", act: 3, tier: "elite", speed: 536,
    twist: "Armoured, guarded, and it holds the best bricks in the spire.",
    rows: [
      "A44A44A44A..",
      "44.GGGG.44..",
      "4.4GGGG4.4..",
      "44.GGGG.44..",
      "A44A44A44A..",
    ], hazards: [{ kind: "laser", x: 168, w: 18, on: 1.9, off: 1.8, phase: 0 }] },

  { id: "maelstrom", name: "Maelstrom", act: 3, tier: "elite", speed: 540,
    twist: "The room turns, falls and pulls all at once.",
    rows: [
      "R4T4R4T4R4T4",
      "4T4R4T4R4T4R",
      "R4T4R4T4R4T4",
    ], hazards: [
      { kind: "drift", amp: 54, period: 6.2 },
      { kind: "gravity", ay: 120 },
      { kind: "blackhole", x: 210, y: 440, r: 170, pull: 280 },
    ] },

  { id: "gauntlet", name: "The Gauntlet", act: 3, tier: "elite", speed: 543,
    twist: "Everything the spire has, in one room.",
    rows: [
      "P4A4X4X4A4P.",
      "4B44GG44B4..",
      "A4T4444T4A..",
      "4B44GG44B4..",
      "P4A4X4X4A4P.",
    ], hazards: [
      { kind: "wind", ax: -84 },
      { kind: "conveyor", y: 380, h: 44, vx: 140 },
      { kind: "mover", x: 130, y: 460, w: 80, h: 12, span: 140, period: 4.4 },
    ] },
];

const ARENA_BY_ID = {};
for (const a of ARENAS) {
  a.hazards = a.hazards || [];
  ARENA_BY_ID[a.id] = a;
}

// Everything an act/tier could draw. run.js shuffles this seeded and walks it,
// so a run never repeats an arena until the pool is exhausted.
function arenaPool(act, tier) {
  return ARENAS.filter((a) => a.act === act && a.tier === tier);
}

if (typeof module !== "undefined") {
  module.exports = { ARENAS, ARENA_BY_ID, GRID_COLS, HAZARD_KINDS, arenaPool };
}
