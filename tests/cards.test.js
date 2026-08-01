// Lints the card registry, the deck compiler and the Archive.
//
// The failure this suite exists to stop: a card whose `stats` key or `flags`
// entry the engine does not read. That card looks perfectly normal in the
// reward screen, costs a pick, and does absolutely nothing — and there is no
// symptom anywhere. Every check below collects its failures and asserts the
// whole list at once, so one run names every offender instead of the first.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadEngine } = require("./load.js");

const S = loadEngine();
const { CARDS, CARD_BY_ID, CORES, STAT_KEYS, FLAG_KEYS, HOOK_KEYS, RARITY_WEIGHT,
        compileDeck, synergyWith, LOCKED_CARDS, draftPool, UNLOCKS, UNLOCK_BY_ID,
        shardsFor, ascentMods } = S;

const GAME_SRC = fs.readFileSync(path.join(ROOT, "js", "game.js"), "utf8");
const RUN_SRC = fs.readFileSync(path.join(ROOT, "js", "run.js"), "utf8");

test("every card is complete and well formed", () => {
  const fails = [];
  const ids = new Set();
  for (const c of CARDS) {
    if (ids.has(c.id)) fails.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.name) fails.push(`${c.id}: no name`);
    if (!c.icon) fails.push(`${c.id}: no icon`);
    if (!c.desc || c.desc.length < 12) fails.push(`${c.id}: description too thin`);
    if (!["ball", "paddle", "rule", "utility"].includes(c.type)) fails.push(`${c.id}: bad type ${c.type}`);
    if (!RARITY_WEIGHT[c.rarity]) fails.push(`${c.id}: bad rarity ${c.rarity}`);
    if (!(c.max >= 1 && c.max <= 3)) fails.push(`${c.id}: silly max ${c.max}`);
    if (!Object.keys(c.stats).length && !c.flags.length && !Object.keys(c.on).length)
      fails.push(`${c.id}: does nothing at all`);
  }
  assert.deepEqual(fails, []);
});

test("no card invents a stat, flag or hook the engine does not read", () => {
  const fails = [];
  const stats = new Set(STAT_KEYS);
  const flags = new Set(FLAG_KEYS);
  const hooks = new Set(HOOK_KEYS);
  for (const c of CARDS) {
    for (const k of Object.keys(c.stats)) if (!stats.has(k)) fails.push(`${c.id}: unknown stat "${k}"`);
    for (const f of c.flags) if (!flags.has(f)) fails.push(`${c.id}: unknown flag "${f}"`);
    for (const h of Object.keys(c.on)) if (!hooks.has(h)) fails.push(`${c.id}: unknown hook "${h}"`);
  }
  assert.deepEqual(fails, []);
});

// The stronger half of the check above: the vocabulary may exist and still be
// dead if nothing ever asks for it. Both a stat and a flag are read by name —
// stats as `stats.<key>`, flags always through the engine's `f("<name>")`
// lookup — so a plain source search is exact enough to catch a member of the
// list that no longer has an implementation behind it.
//
// Two files count as "the engine": game.js runs an arena, run.js runs the
// climb, and a few stats (health, gold) only ever matter to the latter.
test("the engine actually reads every stat and flag it declares", () => {
  const fails = [];
  const SRC = GAME_SRC + "\n" + RUN_SRC;
  for (const k of STAT_KEYS) {
    if (!SRC.includes(`stats.${k}`)) fails.push(`stat "${k}" is never read`);
  }
  for (const f of FLAG_KEYS) {
    if (!GAME_SRC.includes(`f("${f}")`)) fails.push(`flag "${f}" is never read in game.js`);
  }
  assert.deepEqual(fails, []);
});

test("synergy references point at real cards, and are not self-referential", () => {
  const fails = [];
  for (const c of CARDS) {
    for (const s of c.synergy) {
      if (!CARD_BY_ID[s]) fails.push(`${c.id}: synergy with unknown card "${s}"`);
      if (s === c.id) fails.push(`${c.id}: synergy with itself`);
    }
  }
  assert.deepEqual(fails, []);
});

test("rarity is spread across the deck, not piled into one tier", () => {
  const by = {};
  for (const c of CARDS) by[c.rarity] = (by[c.rarity] || 0) + 1;
  assert.ok(CARDS.length >= 40, `only ${CARDS.length} cards — the brief wants a deck-builder`);
  for (const r of Object.keys(RARITY_WEIGHT)) {
    assert.ok(by[r] >= 3, `only ${by[r] || 0} ${r} cards`);
  }
  assert.ok(by.common > by.legendary, "commons must outnumber legendaries");
});

test("compileDeck sums stats, unions flags and respects copies", () => {
  const b = compileDeck(["sharpen", "sharpen", "sharpen", "fireball", "broad"]);
  assert.equal(b.stats.damage, 3, "three Sharpens is +3 damage");
  assert.equal(b.stats.paddleW, 20);
  assert.ok(b.flags.has("burn"));
  assert.equal(b.counts.sharpen, 3);
  // Every declared stat exists on a compiled build, so the engine can add to
  // any of them without an undefined creeping in.
  for (const k of STAT_KEYS) assert.equal(typeof b.stats[k], "number", `stat ${k} missing`);
});

test("compileDeck survives a card that no longer exists", () => {
  // A run saved before a card was retired must still load.
  const b = compileDeck(["sharpen", "a-card-that-was-cut"]);
  assert.equal(b.stats.damage, 1);
  assert.equal(b.ids.length, 2);
});

test("compileDeck folds in flags the arena or Chaos added", () => {
  const b = compileDeck(["sharpen"], { extraFlags: ["gravity"] });
  assert.ok(b.flags.has("gravity"));
});

test("synergyWith spots a combo in both directions", () => {
  // fireball lists explosive; explosive lists fireball.
  assert.deepEqual(synergyWith("fireball", ["explosive"]), ["explosive"]);
  assert.ok(synergyWith("scholar", ["crescendo"]).includes("crescendo"),
    "crescendo names scholar, so scholar must see crescendo");
  assert.deepEqual(synergyWith("fireball", ["broad"]), []);
});

test("every core starts with a legal deck", () => {
  const fails = [];
  for (const c of CORES) {
    if (!c.name || !c.icon || !c.blurb) fails.push(`${c.id}: incomplete`);
    if (!(c.hp >= 40 && c.hp <= 80)) fails.push(`${c.id}: odd starting hp ${c.hp}`);
    for (const id of c.deck) if (!CARD_BY_ID[id]) fails.push(`${c.id}: starts with unknown card ${id}`);
    if (c.locked && !UNLOCK_BY_ID["core:" + c.id]) fails.push(`${c.id}: locked but not buyable`);
  }
  assert.deepEqual(fails, []);
});

test("the Archive only sells things that exist", () => {
  const fails = [];
  for (const u of UNLOCKS) {
    if (!(u.shards > 0)) fails.push(`${u.id}: free?`);
    if (u.needs && !UNLOCK_BY_ID[u.needs]) fails.push(`${u.id}: needs unknown ${u.needs}`);
    if (u.kind === "card" && !CARD_BY_ID[u.ref]) fails.push(`${u.id}: unknown card ${u.ref}`);
    if (u.kind === "core" && !S.CORE_BY_ID[u.ref]) fails.push(`${u.id}: unknown core ${u.ref}`);
    if (u.kind === "boss" && !S.BOSSES[u.ref]) fails.push(`${u.id}: unknown boss ${u.ref}`);
  }
  for (const c of LOCKED_CARDS) {
    if (!CARD_BY_ID[c.id]) fails.push(`locked card ${c.id} does not exist`);
  }
  assert.deepEqual(fails, []);
});

test("a first run already has a real deck-builder's worth of choice", () => {
  const open = draftPool([]);
  assert.ok(open.length >= 30, `only ${open.length} cards available before any unlock`);
  // Every rarity has to be reachable on run one, or the draft feels flat.
  for (const r of Object.keys(RARITY_WEIGHT)) {
    assert.ok(open.some((c) => c.rarity === r), `no ${r} card available at the start`);
  }
  // And buying everything opens the rest.
  const all = draftPool(LOCKED_CARDS.map((c) => "card:" + c.id));
  assert.equal(all.length, CARDS.length);
});

test("shards reward progress without making a win compulsory", () => {
  const died = shardsFor({ floorsCleared: 6, bossesDown: 0, win: false, ascent: 0 });
  const won = shardsFor({ floorsCleared: 36, bossesDown: 3, win: true, ascent: 0 });
  assert.ok(died >= 12, `a losing run pays ${died} — too mean to keep playing`);
  assert.ok(won > died * 2, "a full clear must clearly outpay a death");
  assert.ok(won < died * 12, "a full clear must not make deaths pointless");
  // Ascents pay more, which is the only reason to climb one.
  assert.ok(shardsFor({ floorsCleared: 36, bossesDown: 3, win: true, ascent: 3 }) > won);
});

test("ascents raise the ceiling in every direction they claim to", () => {
  const a0 = ascentMods(0), a3 = ascentMods(3);
  assert.equal(a0.hpMul, 1);
  assert.equal(a0.startHpMul, 1);
  assert.ok(a3.hpMul > a0.hpMul);
  assert.ok(a3.startHpMul < 1);
  assert.ok(a3.hurtMul > a0.hurtMul, "a mistake must cost more up there");
  assert.ok(a3.eliteMul > a0.eliteMul);
  assert.ok(a3.shardMul > a0.shardMul);
  // Deliberately NOT ball speed: a faster ball ends a room sooner and cuts the
  // player's total exposure, so it made Ascent III come out easier than base.
  assert.equal(a3.speedMul, undefined, "ascents must not lean on ball speed");
});
