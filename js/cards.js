// Ricochet Spire — the card registry.
//
// A card is a PASSIVE modifier that lasts the whole run. There is no hand and
// nothing to play: you draft cards between fights and the deck you end up with
// is your build. That is what the design brief's ball/paddle/rule lists
// actually describe, and it keeps the arena a game of reflexes rather than menus.
//
// Three shapes of card, in ascending order of how much code they cost:
//
//   stats  — a number the sim already reads. `{ damage: 2 }` needs no new code
//            anywhere, which is why most cards are only stats.
//   flags  — a named behaviour the sim checks for by name. Adding one means
//            adding a branch in game.js AND the name to FLAG_KEYS below.
//   on     — a hook, for the handful of things neither of the above expresses.
//
// run.js compiles the whole deck into ONE build object at the start of every
// arena (summed stats, a Set of flags, arrays of hooks) so the sim never walks
// the deck per frame. tests/cards.test.js lints that every stat key and every
// flag is one the engine actually reads — a typo'd stat is otherwise a card
// that silently does nothing.

// ---------------------------------------------------------------- vocabulary
// The closed sets. game.js reads every one of these; a card may not invent a
// key, and the test suite fails the build if one does.
const STAT_KEYS = [
  "damage",        // flat damage added to every brick hit
  "paddleW",       // logical px added to paddle width
  "paddleSpeed",   // px/s added to how fast the paddle can travel
  "ballSpeed",     // px/s added to the ball's base speed
  "extraBalls",    // extra balls served at the start of an arena
  "pierce",        // bricks a ball passes through before it reflects
  "shield",        // free ball-losses per arena
  "heal",          // run HP restored on clearing an arena
  "hpMax",         // added to the run's maximum HP
  "goldPct",       // percent more gold
  "scorePct",      // percent more score
  "dropPct",       // percentage points added to the power-up drop chance
  "laserRate",     // paddle shots per second
  "magnet",        // px/s^2 the paddle pulls a nearby ball sideways
  "comboRate",     // extra combo steps per brick destroyed
  "chargeEvery",   // supercharge the next brick hit every N paddle hits
  "chargeDmg",     // how much damage that supercharge adds
];

const FLAG_KEYS = [
  // ball
  "burn", "freeze", "boomerang", "explosive", "phase", "heavy", "electric", "poison",
  // paddle
  "sticky", "twin", "magnetic", "reflect", "spin", "mini",
  // rules
  "gravity", "portals", "chain", "growing", "mirror", "chaos", "timewarp", "ricochet",
  // other
  "laser", "vampire", "glass", "greed", "focus", "singularity",
];

const HOOK_KEYS = [
  "levelStart", "paddleHit", "wallBounce", "brickHit", "brickBreak",
  "ballLost", "tick", "levelEnd",
];

const RARITY_WEIGHT = { common: 60, uncommon: 27, rare: 11, legendary: 2 };

// ------------------------------------------------------------------- the deck
const CARDS = [
  /* ---------------------------------------------------------- ball cards */
  { id: "fireball", name: "Fireball", type: "ball", rarity: "common", icon: "🔥",
    desc: "Bricks the ball touches catch fire and keep burning for 3s.",
    flags: ["burn"], tags: ["fire"], synergy: ["explosive", "chain"] },

  { id: "iceball", name: "Ice Ball", type: "ball", rarity: "common", icon: "❄️",
    desc: "Chilled bricks stop regrowing and healing. Ball runs slightly slower.",
    stats: { ballSpeed: -14 }, flags: ["freeze"], tags: ["control"], synergy: ["growing"] },

  { id: "boomerang", name: "Boomerang Ball", type: "ball", rarity: "uncommon", icon: "🪃",
    desc: "After touching the ceiling the ball curves back toward your paddle.",
    flags: ["boomerang"], tags: ["control"], synergy: ["focus"] },

  { id: "explosive", name: "Explosive Ball", type: "ball", rarity: "uncommon", icon: "💥",
    desc: "Every 4th brick you destroy detonates.",
    flags: ["explosive"], tags: ["blast"], synergy: ["fireball", "chain"] },

  { id: "phase", name: "Phase Ball", type: "ball", rarity: "rare", icon: "👻",
    desc: "The ball passes straight through steel. Nothing is walled off any more.",
    flags: ["phase"], tags: ["control"] },

  { id: "heavy", name: "Heavy Ball", type: "ball", rarity: "uncommon", icon: "🪨",
    desc: "+2 damage, and the ball ploughs on through bricks it destroys. Slower.",
    stats: { damage: 2, ballSpeed: -22 }, flags: ["heavy"], tags: ["damage"], synergy: ["drill"] },

  { id: "electric", name: "Electric Ball", type: "ball", rarity: "uncommon", icon: "⚡",
    desc: "Each brick you break arcs 1 damage into the nearest brick.",
    flags: ["electric"], tags: ["spread"], synergy: ["chain", "explosive"] },

  { id: "poison", name: "Poison Ball", type: "ball", rarity: "common", icon: "☠️",
    desc: "Bricks the ball touches take 1 damage every 2s, forever.",
    flags: ["poison"], tags: ["dot"], synergy: ["timewarp"] },

  { id: "sharpen", name: "Sharpen", type: "ball", rarity: "common", icon: "🔪", max: 3,
    desc: "+1 damage on every hit.",
    stats: { damage: 1 }, tags: ["damage"] },

  { id: "splitter", name: "Splitter", type: "ball", rarity: "uncommon", icon: "🔱", max: 2,
    desc: "Start every arena with one extra ball.",
    stats: { extraBalls: 1 }, tags: ["balls"], synergy: ["sticky", "laser"] },

  { id: "overclock", name: "Overclock", type: "ball", rarity: "common", icon: "🌀", max: 2,
    desc: "+1 damage and a noticeably faster ball. Harder to read.",
    stats: { damage: 1, ballSpeed: 42 }, tags: ["damage"], synergy: ["timewarp"] },

  { id: "drill", name: "Drill Bit", type: "ball", rarity: "rare", icon: "🛠️", max: 2,
    desc: "The ball punches through one extra brick before it turns around.",
    stats: { pierce: 1 }, tags: ["damage"], synergy: ["heavy"] },

  /* -------------------------------------------------------- paddle cards */
  { id: "sticky", name: "Sticky Paddle", type: "paddle", rarity: "common", icon: "🧲",
    desc: "The ball sticks to the paddle. Tap to launch it exactly where you want.",
    flags: ["sticky"], tags: ["control"], synergy: ["splitter", "laser"] },

  { id: "twin", name: "Double Paddle", type: "paddle", rarity: "rare", icon: "⚌",
    desc: "A second paddle mirrors you higher up the arena.",
    flags: ["twin"], tags: ["control"] },

  { id: "magnetic", name: "Magnetic Paddle", type: "paddle", rarity: "uncommon", icon: "🔵",
    desc: "The paddle drags a falling ball toward itself.",
    stats: { magnet: 280 }, flags: ["magnetic"], tags: ["control"] },

  { id: "barrier", name: "Reflective Shield", type: "paddle", rarity: "uncommon", icon: "🛡️",
    desc: "A floor barrier flickers on for 3s out of every 22. Free saves.",
    flags: ["reflect"], tags: ["defence"] },

  { id: "spin", name: "Rotating Paddle", type: "paddle", rarity: "common", icon: "🔄",
    desc: "A moving paddle spins the ball, curving it the way you swiped.",
    flags: ["spin"], tags: ["control"] },

  { id: "broad", name: "Long Paddle", type: "paddle", rarity: "common", icon: "📏", max: 3,
    desc: "A wider paddle.",
    stats: { paddleW: 20 }, tags: ["defence"] },

  { id: "mini", name: "Mini Paddle", type: "paddle", rarity: "rare", icon: "🤏",
    desc: "A third of your paddle is gone — but everything pays far more.",
    stats: { scorePct: 65, goldPct: 55 }, flags: ["mini"], tags: ["risk"], synergy: ["magnetic", "barrier"] },

  { id: "swift", name: "Swift Rails", type: "paddle", rarity: "common", icon: "💨", max: 2,
    desc: "The paddle moves a good deal faster.",
    stats: { paddleSpeed: 170 }, tags: ["control"], synergy: ["mini"] },

  { id: "laser", name: "Laser Paddle", type: "paddle", rarity: "uncommon", icon: "🔫",
    desc: "The paddle fires upward on its own.",
    stats: { laserRate: 1.5 }, flags: ["laser"], tags: ["damage"], synergy: ["sticky", "autoloader"] },

  { id: "autoloader", name: "Autoloader", type: "paddle", rarity: "uncommon", icon: "⚙️", max: 2,
    desc: "Lasers fire much faster. Useless without a Laser Paddle.",
    stats: { laserRate: 1.3 }, tags: ["damage"], synergy: ["laser"] },

  { id: "bulwark", name: "Bulwark", type: "paddle", rarity: "uncommon", icon: "🧱", max: 2,
    desc: "The first ball you drop each arena costs you nothing.",
    stats: { shield: 1 }, tags: ["defence"] },

  { id: "coil", name: "Lode Coil", type: "paddle", rarity: "common", icon: "🧿", max: 2,
    desc: "Stronger pull on a falling ball. Needs a Magnetic Paddle to do anything.",
    stats: { magnet: 220 }, tags: ["control"], synergy: ["magnetic"] },

  /* ---------------------------------------------------------- rule cards */
  { id: "gravity", name: "Gravity Shift", type: "rule", rarity: "uncommon", icon: "🧭",
    desc: "Every 15s gravity picks a new direction. Read it or lose the ball.",
    stats: { scorePct: 30 }, flags: ["gravity"], tags: ["chaos"] },

  { id: "portals", name: "Portal Mode", type: "rule", rarity: "uncommon", icon: "🌀",
    desc: "Two gates open in every arena. The ball goes in one and out the other.",
    flags: ["portals"], tags: ["chaos"] },

  { id: "chain", name: "Chain Lightning", type: "rule", rarity: "rare", icon: "🌩️",
    desc: "Breaking a brick puts 1 damage into every brick beside it.",
    flags: ["chain"], tags: ["spread"], synergy: ["fireball", "explosive", "electric"] },

  { id: "growing", name: "Growing Bricks", type: "rule", rarity: "uncommon", icon: "🌱",
    desc: "Every brick toughens over time — but the whole arena pays far more.",
    stats: { scorePct: 55 }, flags: ["growing"], tags: ["risk"], synergy: ["iceball"] },

  { id: "mirror", name: "Mirror World", type: "rule", rarity: "uncommon", icon: "🪞",
    desc: "Your controls reverse for 10s out of every 30. Gold flows in.",
    stats: { goldPct: 80 }, flags: ["mirror"], tags: ["risk"] },

  { id: "chaos", name: "Chaos", type: "rule", rarity: "rare", icon: "🎲",
    desc: "Every 40s a different rule switches itself on. Nobody knows which.",
    stats: { scorePct: 90 }, flags: ["chaos"], tags: ["chaos", "risk"] },

  { id: "timewarp", name: "Time Warp", type: "rule", rarity: "common", icon: "⏳",
    desc: "The ball slows right down near your paddle. Everything is catchable.",
    flags: ["timewarp"], tags: ["control"], synergy: ["overclock", "poison"] },

  { id: "ricochet", name: "Ricochet Master", type: "rule", rarity: "uncommon", icon: "📐",
    desc: "Every wall bounce loads the ball with +1 damage, up to +5.",
    flags: ["ricochet"], tags: ["damage"], synergy: ["portals", "boomerang"] },

  { id: "focus", name: "Singular Focus", type: "rule", rarity: "rare", icon: "🎯",
    desc: "Only one ball may exist — and it hits like three. +3 damage.",
    stats: { damage: 3 }, flags: ["focus"], tags: ["damage"], synergy: ["boomerang", "magnetic"] },

  { id: "glass", name: "Glass Cannon", type: "rule", rarity: "rare", icon: "🥃",
    desc: "Double damage. Half the health you had.",
    flags: ["glass"], tags: ["risk"], synergy: ["barrier", "bulwark"] },

  { id: "singularity", name: "Singularity", type: "rule", rarity: "legendary", icon: "🕳️",
    desc: "A black hole hangs in the middle of every arena, dragging the ball into the bricks.",
    flags: ["singularity"], tags: ["chaos"] },

  /* ------------------------------------------------------- utility cards */
  { id: "vitality", name: "Vitality", type: "utility", rarity: "common", icon: "❤️", max: 2,
    desc: "+18 maximum health, and heal a little after every arena.",
    stats: { hpMax: 18, heal: 5 }, tags: ["defence"] },

  { id: "mend", name: "Mend", type: "utility", rarity: "common", icon: "🩹", max: 2,
    desc: "Heal 9 health every time you clear an arena.",
    stats: { heal: 9 }, tags: ["defence"] },

  { id: "vampire", name: "Siphon", type: "utility", rarity: "uncommon", icon: "🦇",
    desc: "Every 25 bricks you break returns 1 health.",
    flags: ["vampire"], tags: ["defence"], synergy: ["chain", "explosive"] },

  { id: "greed", name: "Greed", type: "utility", rarity: "uncommon", icon: "🪙",
    desc: "Bricks cough up gold as they break. Shopkeepers notice, and charge more.",
    flags: ["greed"], tags: ["gold"] },

  { id: "fortune", name: "Fortune", type: "utility", rarity: "common", icon: "💰", max: 2,
    desc: "+45% gold from everything.",
    stats: { goldPct: 45 }, tags: ["gold"] },

  { id: "scholar", name: "Scholar", type: "utility", rarity: "common", icon: "📘", max: 2,
    desc: "+40% score from everything.",
    stats: { scorePct: 40 }, tags: ["score"] },

  { id: "lodestone", name: "Lodestone", type: "utility", rarity: "common", icon: "🎁", max: 2,
    desc: "Far more bricks give up a power-up.",
    stats: { dropPct: 22 }, tags: ["drops"] },

  { id: "crescendo", name: "Crescendo", type: "utility", rarity: "common", icon: "🎵", max: 2,
    desc: "Your combo climbs twice as fast between paddle touches.",
    stats: { comboRate: 1 }, tags: ["score"], synergy: ["scholar"] },

  { id: "charge", name: "Charge Coil", type: "utility", rarity: "uncommon", icon: "🔋",
    desc: "Every 5th paddle touch supercharges the next brick hit for +6 damage.",
    stats: { chargeEvery: 5, chargeDmg: 6 }, tags: ["damage"], synergy: ["supercharge"] },

  { id: "supercharge", name: "Supercharge", type: "utility", rarity: "rare", icon: "⚗️", max: 2,
    desc: "+9 to a supercharged hit. Needs a Charge Coil to mean anything.",
    stats: { chargeDmg: 9 }, tags: ["damage"], synergy: ["charge"] },

  /* -------------------------------------------------------- legendaries */
  { id: "keystone", name: "Keystone", type: "utility", rarity: "legendary", icon: "🗝️",
    desc: "The spire recognises you. +3 damage, a longer paddle, +15 health.",
    stats: { damage: 3, paddleW: 16, hpMax: 15 }, tags: ["damage", "defence"] },

  { id: "prismatic", name: "Prismatic Core", type: "ball", rarity: "legendary", icon: "💎",
    desc: "Explosive, electric and chaining, all at once.",
    flags: ["explosive", "electric", "chain"], tags: ["blast", "spread"],
    synergy: ["fireball", "ricochet"] },

  { id: "eternity", name: "Eternity", type: "utility", rarity: "legendary", icon: "♾️",
    desc: "Three free drops every arena, and 15 health back on every clear.",
    stats: { shield: 3, heal: 15 }, tags: ["defence"] },
];

// ------------------------------------------------------------------ indexing
const CARD_BY_ID = {};
for (const c of CARDS) {
  c.max = c.max || 1;
  c.stats = c.stats || {};
  c.flags = c.flags || [];
  c.tags = c.tags || [];
  c.synergy = c.synergy || [];
  c.on = c.on || {};
  c.weight = RARITY_WEIGHT[c.rarity];
  CARD_BY_ID[c.id] = c;
}

// The three cores a run can start from. Cores 2 and 3 are bought in the
// Archive with shards; the first is always available.
const CORES = [
  { id: "vagrant", name: "The Vagrant", icon: "🔺", locked: false,
    blurb: "A plain ball and a steady hand. The honest way up.",
    deck: ["sharpen"], hp: 62, gold: 42 },
  { id: "arsonist", name: "The Arsonist", icon: "🔥", locked: true, shards: 55,
    blurb: "Starts alight. Less health, and everything you touch burns.",
    deck: ["fireball", "sharpen"], hp: 48, gold: 32 },
  { id: "collector", name: "The Collector", icon: "🪙", locked: true, shards: 90,
    blurb: "Poorer at breaking things, far richer at everything else.",
    deck: ["fortune", "lodestone"], hp: 55, gold: 96 },
];

const CORE_BY_ID = {};
for (const c of CORES) CORE_BY_ID[c.id] = c;

// ---------------------------------------------------------- deck compilation
// Called once at the start of every arena. Walking 20 cards per brick hit
// would be silly; this flattens the deck into the three things the sim reads.
function compileDeck(ids, opts = {}) {
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = 0;
  const flags = new Set();
  const hooks = {};
  const counts = {};

  for (const id of ids) {
    const c = CARD_BY_ID[id];
    if (!c) continue;                       // a card retired since the run was saved
    counts[id] = (counts[id] || 0) + 1;
  }

  for (const [id, n] of Object.entries(counts)) {
    const c = CARD_BY_ID[id];
    for (const [k, v] of Object.entries(c.stats)) stats[k] += v * n;
    for (const f of c.flags) flags.add(f);
    for (const [name, fn] of Object.entries(c.on)) {
      (hooks[name] = hooks[name] || []).push({ fn, n, card: c });
    }
  }

  // Some flags are also switched on by the arena or by Chaos, not only by a
  // card, so the sim gets one merged set rather than checking two places.
  for (const f of opts.extraFlags || []) flags.add(f);

  return { stats, flags, hooks, counts, ids: [...ids] };
}

// How interesting a deck is to look at — used to glow a reward card that
// combos with what you already hold.
function synergyWith(cardId, ownedIds) {
  const c = CARD_BY_ID[cardId];
  if (!c) return [];
  const owned = new Set(ownedIds);
  const hits = c.synergy.filter((s) => owned.has(s));
  for (const other of ownedIds) {
    const o = CARD_BY_ID[other];
    if (o && o.synergy.includes(cardId) && !hits.includes(other)) hits.push(other);
  }
  return hits;
}

if (typeof module !== "undefined") {
  module.exports = { CARDS, CARD_BY_ID, CORES, CORE_BY_ID, STAT_KEYS, FLAG_KEYS,
                     HOOK_KEYS, RARITY_WEIGHT, compileDeck, synergyWith };
}
