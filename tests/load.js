// One place that knows how to load the game into Node.
//
// The game ships as plain <script> files with top-level `const` and no module
// system, so the suites run them through gamekit's vm harness. Concatenation
// order here must match index.html's — arenas.js defines GRID_COLS, which
// game.js reads at the top level, so a swapped pair is an immediate crash
// rather than a subtle bug.

const path = require("node:path");
const { loadScripts } = require("../lib/tools/test-harness.js");

const ROOT = path.join(__dirname, "..");

// The simulation and everything it is made of. No browser globals needed:
// game.js and run.js touch neither window nor document, which is the whole
// point of keeping them that way.
const ENGINE_FILES = [
  "tests/seed.js",
  "js/rng.js",
  "js/physics.js",
  "js/cards.js",
  "js/bricks.js",
  "js/powerups.js",
  "js/arenas.js",
  "js/game.js",
  "js/bosses.js",
  "js/events.js",
  "js/unlocks.js",
  "js/run.js",
];

const ENGINE_EXPORTS = [
  "RNG", "Physics",
  "CARDS", "CARD_BY_ID", "CORES", "CORE_BY_ID", "STAT_KEYS", "FLAG_KEYS", "HOOK_KEYS",
  "RARITY_WEIGHT", "compileDeck", "synergyWith",
  "BRICKS", "BRICK_CHARS",
  "POWERUPS", "POWERUP_LIST", "pickPowerup",
  "ARENAS", "ARENA_BY_ID", "GRID_COLS", "HAZARD_KINDS", "arenaPool",
  "Game", "LW", "LH", "BW", "BH", "BRICK_TOP", "PADDLE_Y", "PADDLE_H", "BALL_R",
  "BASE_PADDLE_W", "BASE_PADDLE_SPEED", "STEP", "GRAV_DIRS", "CHAOS_POOL",
  "BOSSES", "BOSS_LIST", "BOSS_POOL",
  "EVENTS", "EVENT_BY_ID", "SHOP_SERVICES", "CARD_PRICE", "CHESTS", "REST_OPTIONS",
  "UNLOCKS", "UNLOCK_BY_ID", "LOCKED_CARDS", "shardsFor", "ascentMods", "draftPool",
  "Run", "buildMap", "drawCards", "drawByRarity",
  "FLOORS", "LANES", "ACTS", "BOSS_FLOOR", "NODE_WEIGHTS", "FIXED_FLOORS",
  "TYPE_FLOORS", "NO_REPEAT", "DECK_LIMIT",
  "__rand", "__reseed",
];

function loadEngine() {
  return loadScripts({ baseDir: ROOT, files: ENGINE_FILES, exports: ENGINE_EXPORTS });
}

// The save layer needs the kit, and the kit needs a browser.
function loadStorage() {
  return loadScripts({
    baseDir: ROOT,
    files: ["lib/gk-util.js", "lib/gk-storage.js", "js/cards.js",
            "js/unlocks.js", "js/storage.js"],
    exports: ["Storage", "PROGRESS", "UNLOCK_BY_ID", "CARDS", "UNLOCKS"],
    browser: true,
  });
}

module.exports = { ROOT, loadEngine, loadStorage, ENGINE_FILES, ENGINE_EXPORTS };
