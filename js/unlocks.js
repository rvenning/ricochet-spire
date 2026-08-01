// Ricochet Spire — the Archive: what shards buy.
//
// Shards are the only thing that survives a death. Everything here is bought
// once and owned forever, on every device (the unlocked list is merged as a
// UNION across devices, so buying something on the iPad can never be undone by
// syncing an older phone).
//
// The rule the table follows: an unlock adds VARIETY, never raw power. Buying
// things must not make the spire easier, or the game quietly deletes itself for
// anybody who plays a lot. So the shop sells cards into the draft pool, extra
// bosses, harder difficulties and cosmetics — never "+2 damage forever".
//
// The starting pool is deliberately generous: a first run should already feel
// like a deck-builder, not like a demo.

// Cards NOT in the starting draft pool. Everything else is available from the
// first run. tests/cards.test.js checks every id here is a real card, and —
// more usefully — that locking these has not emptied a whole rarity out of the
// opening pool. A first run that can never see a rare or a legendary is not a
// deck-builder, it is a tutorial, and it was exactly what the first draft of
// this list shipped.
const LOCKED_CARDS = [
  { id: "phase", shards: 30 },
  { id: "twin", shards: 30 },
  { id: "drill", shards: 35 },
  { id: "supercharge", shards: 35 },
  { id: "chain", shards: 40 },
  { id: "focus", shards: 45 },
  { id: "singularity", shards: 80 },
  { id: "prismatic", shards: 90 },
  { id: "eternity", shards: 90 },
];

const UNLOCKS = [
  // ------------------------------------------------------------- new cards
  ...LOCKED_CARDS.map((c) => ({
    id: "card:" + c.id, kind: "card", ref: c.id, shards: c.shards,
    group: "Cards", name: null,          // filled in from the card registry
  })),

  // ------------------------------------------------------------- new cores
  { id: "core:arsonist", kind: "core", ref: "arsonist", shards: 55, group: "Climbers",
    name: "The Arsonist", icon: "🔥", desc: "Starts alight, and fragile with it." },
  { id: "core:collector", kind: "core", ref: "collector", shards: 90, group: "Climbers",
    name: "The Collector", icon: "🪙", desc: "Rich, and bad at breaking things." },

  // ------------------------------------------------------------ new bosses
  { id: "boss:gravitycore", kind: "boss", ref: "gravitycore", shards: 50, group: "The Spire",
    name: "Gravity Core", icon: "🌌", desc: "A second guardian for the middle of the spire." },
  { id: "boss:serpent", kind: "boss", ref: "serpent", shards: 50, group: "The Spire",
    name: "The Serpent", icon: "🐍", desc: "A second guardian for the lower spire." },

  // ---------------------------------------------------------- difficulties
  // Ascents raise the ceiling for people who have finished. They pay more
  // shards, which is the only reason to climb one.
  { id: "ascent:1", kind: "ascent", ref: 1, shards: 60, group: "Ascents",
    name: "Ascent I", icon: "⛰️", desc: "Elites hit harder. +25% shards." },
  { id: "ascent:2", kind: "ascent", ref: 2, shards: 110, group: "Ascents",
    name: "Ascent II", icon: "🏔️", desc: "Every brick is tougher. +50% shards.",
    needs: "ascent:1" },
  { id: "ascent:3", kind: "ascent", ref: 3, shards: 180, group: "Ascents",
    name: "Ascent III", icon: "🌋", desc: "You start with less health. +80% shards.",
    needs: "ascent:2" },
];

const UNLOCK_BY_ID = {};
for (const u of UNLOCKS) UNLOCK_BY_ID[u.id] = u;

// How much a run pays into the Archive. Deliberately shallow — a full clear is
// worth about three deaths, so a losing streak still moves you forward.
function shardsFor(result) {
  const floors = result.floorsCleared || 0;
  const base = 6 + floors * 2 + (result.bossesDown || 0) * 14;
  const win = result.win ? 40 : 0;
  const asc = 1 + (result.ascent || 0) * 0.25 + (result.ascent >= 3 ? 0.05 : 0);
  return Math.round((base + win) * asc);
}

// Ascent modifiers, read by run.js when it sets a run up.
//
// Note what is NOT here: ball speed. It reads like an obvious difficulty knob
// and it is worse than useless — a faster ball ends a room sooner, so it cuts
// the player's total exposure more than it raises the risk of any one return.
// With a paddle quick enough to keep up, the bots had Ascent III coming out
// EASIER than the base climb, entirely because of the speed multiplier.
//
// What actually makes a run harder is time under fire and the cost of a
// mistake: tougher bricks (longer rooms), tougher elites, and less health to
// absorb the drops along the way.
function ascentMods(level) {
  return {
    hpMul: 1 + level * 0.16,
    eliteMul: 1 + level * 0.13,
    startHpMul: level >= 3 ? 0.68 : level >= 2 ? 0.82 : level >= 1 ? 0.92 : 1,
    hurtMul: 1 + level * 0.18,          // a dropped ball costs more up here
    shardMul: 1 + level * 0.25 + (level >= 3 ? 0.05 : 0),
  };
}

// Cards available to draft: everything not locked, plus anything bought.
function draftPool(unlocked) {
  const owned = new Set(unlocked || []);
  const lockedIds = new Set(LOCKED_CARDS.map((c) => c.id));
  return CARDS.filter((c) => !lockedIds.has(c.id) || owned.has("card:" + c.id));
}

if (typeof module !== "undefined") {
  module.exports = { UNLOCKS, UNLOCK_BY_ID, LOCKED_CARDS, shardsFor, ascentMods, draftPool };
}
