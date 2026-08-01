// Ricochet Spire — the run.
//
// game.js plays one arena. This file plays the twenty-odd hours between them:
// it generates the branching map, hands out card offers, stocks the shops,
// runs the events, tracks health and gold across the whole climb, and decides
// when the run is over.
//
// Like game.js it touches no DOM and calls no Math.random. Everything it draws
// comes from RNG.sub(seed, purpose, act, floor) — a generator identified by
// WHERE it is used rather than by how many numbers came before it. Two
// consequences the design leans on hard:
//
//   * The Daily Challenge is genuinely the same run for everyone. Same map,
//     same arenas, same three cards on floor 4, same shop stock.
//   * A saved run is {seed, act, floor, path, deck, gold, hp} and nothing else.
//     Closing the tab thirty minutes into a climb costs you nothing, because
//     rebuilding the run from the seed rebuilds every draw exactly.
//
// The map is Slay the Spire's shape: several paths walking up through a lane
// grid, merging where they meet. Two properties matter and are asserted in
// tests/map.test.js — every node you can start on can reach the boss, and no
// two edges cross (a crossing map is unreadable, which is a bug even though
// nothing breaks).

// A climb passes about thirty rooms, most of which hand out a card. Left
// uncapped the bots finished with 36-card decks and every run looked the same,
// because by act 3 you simply owned most of the game. Twelve is enough for the
// silly combinations the brief asks for while still forcing a decision: past
// that, taking a card means giving one up.
const DECK_LIMIT = 12;

const FLOORS = 12;              // 0..10 are rooms, 11 is the boss
const LANES = 5;
const ACTS = 3;
const PATHS = 6;                // random walks used to grow the map
const BOSS_FLOOR = FLOORS - 1;

// Floors whose type is fixed, so a run always has the same skeleton however
// the branches fall: a chest halfway up, a campfire before the boss.
const FIXED_FLOORS = { 0: "battle", 1: "battle", 4: "treasure", 10: "rest", 11: "boss" };

const NODE_WEIGHTS = { battle: 46, elite: 15, event: 22, shop: 9, rest: 8 };

// Where each type is ALLOWED to appear, inclusive. Weights alone are not
// enough: with a campfire already fixed on floor 10, an 8% roll on seven free
// floors put four of them on some paths, and four campfires means health stops
// being a resource at all. A window is the cheap fix, and it is checkable —
// tests/map.test.js asserts the resulting mix over 200 maps.
const TYPE_FLOORS = {
  battle: [0, 10],
  event: [2, 10],
  shop: [2, 9],
  elite: [3, 9],       // never a coin-flip death on floor 2
  rest: [6, 7],        // adjacent, so NO_REPEAT allows at most one of them
};

// Types that may not repeat directly above one another on a path. Two
// campfires in a row is a wasted floor; two shops in a row is a broke player.
const NO_REPEAT = new Set(["rest", "shop", "elite", "treasure"]);

/* ========================================================== map generation */
function buildMap(seed, act, unlocked) {
  const rng = RNG.sub(seed, "map", act);
  const nodes = new Map();      // "f:l" -> node
  const edgesByFloor = [];      // floor -> [[fromLane, toLane], ...]
  for (let f = 0; f < FLOORS; f++) edgesByFloor.push([]);

  const key = (f, l) => f + ":" + l;
  const ensure = (f, l) => {
    const k = key(f, l);
    if (!nodes.has(k)) nodes.set(k, { id: "a" + act + k, floor: f, lane: l, to: [], from: [] });
    return nodes.get(k);
  };

  // Two edges on the same floor cross when one starts left of the other and
  // ends right of it. Forbidding that outright is cheaper than untangling.
  const crosses = (f, a, b) => edgesByFloor[f].some(([c, d]) =>
    (a < c && b > d) || (a > c && b < d));

  const link = (f, a, b) => {
    if (!edgesByFloor[f].some(([c, d]) => c === a && d === b)) edgesByFloor[f].push([a, b]);
    const from = ensure(f, a), to = ensure(f + 1, b);
    if (!from.to.includes(to.id)) from.to.push(to.id);
    if (!to.from.includes(from.id)) to.from.push(from.id);
  };

  for (let p = 0; p < PATHS; p++) {
    let lane = rng.int(0, LANES - 1);
    ensure(0, lane);
    for (let f = 0; f < BOSS_FLOOR - 1; f++) {
      const cands = rng.shuffle([lane - 1, lane, lane + 1].filter((l) => l >= 0 && l < LANES));
      let next = cands.find((c) => !crosses(f, lane, c));
      if (next === undefined) next = lane;         // staying put never crosses
      link(f, lane, next);
      lane = next;
    }
    link(BOSS_FLOOR - 1, lane, 2);                 // every path ends at the boss
  }

  // ------------------------------------------------------------ node types
  const list = [...nodes.values()].sort((a, b) => a.floor - b.floor || a.lane - b.lane);
  const byId = {};
  for (const n of list) byId[n.id] = n;

  for (const n of list) {
    if (FIXED_FLOORS[n.floor]) { n.type = FIXED_FLOORS[n.floor]; continue; }
    const parents = n.from.map((id) => byId[id]).filter(Boolean);
    const banned = new Set(parents.filter((p) => NO_REPEAT.has(p.type)).map((p) => p.type));
    const opts = Object.keys(NODE_WEIGHTS).filter((t) => {
      if (banned.has(t)) return false;
      const w = TYPE_FLOORS[t];
      return !w || (n.floor >= w[0] && n.floor <= w[1]);
    });
    const r = RNG.sub(seed, "type", act, n.floor, n.lane);
    n.type = r.weighted(opts, (t) => NODE_WEIGHTS[t]) || "battle";
  }

  const bossPool = (BOSS_POOL[act] || ["fortress"]).filter((k) =>
    k === BOSS_POOL[act][0] || (unlocked || []).includes("boss:" + k));
  const bossKey = RNG.sub(seed, "boss", act).pick(bossPool.length ? bossPool : BOSS_POOL[act]);

  const entries = list.filter((n) => n.floor === 0).map((n) => n.id);
  return { act, nodes: list, byId, entries, bossKey, edgesByFloor };
}

/* ============================================================ card drawing */
// Weighted draw WITHOUT replacement, respecting each card's copy limit and the
// player's Archive. `bias` multiplies the rare and legendary weights — that is
// the whole difference between a normal reward and an elite's.
function drawCards(rng, pool, deck, n, bias = 1, type = null) {
  const counts = {};
  for (const id of deck) counts[id] = (counts[id] || 0) + 1;
  let avail = pool.filter((c) => (counts[c.id] || 0) < c.max && (!type || c.type === type));
  const out = [];
  for (let i = 0; i < n && avail.length; i++) {
    const pick = rng.weighted(avail, (c) =>
      c.weight * ((c.rarity === "rare" || c.rarity === "legendary") ? bias : 1));
    if (!pick) break;
    out.push(pick.id);
    avail = avail.filter((c) => c.id !== pick.id);
  }
  return out;
}

// A single card of a stated rarity, for events that promise one.
function drawByRarity(rng, pool, deck, rarity, type) {
  const counts = {};
  for (const id of deck) counts[id] = (counts[id] || 0) + 1;
  const tiers = ["legendary", "rare", "uncommon", "common"];
  const from = tiers.slice(tiers.indexOf(rarity));   // fall back down if empty
  for (const t of from) {
    const avail = pool.filter((c) => c.rarity === t && (counts[c.id] || 0) < c.max &&
                                     (!type || c.type === type));
    if (avail.length) return rng.pick(avail).id;
  }
  return null;
}

/* ==================================================================== Run */
const Run = {
  on: {},
  emit(name, data) { const f = this.on[name]; if (f) f(data); },

  state: null,
  maps: {},

  /* ------------------------------------------------------------ lifecycle */
  start({ seed, mode = "run", coreId = "vagrant", unlocked = [], ascent = 0 }) {
    const core = CORE_BY_ID[coreId] || CORES[0];
    const mods = ascentMods(ascent);
    this.maps = {};
    this.state = {
      seed, mode, coreId: core.id, ascent, unlocked: [...unlocked],
      act: 1, nodeId: null, floor: -1,
      visited: [],
      deck: [...core.deck],
      gold: core.gold,
      hpBonus: 0,
      hp: 0, hpMax: 0,
      score: 0, bricks: 0, bossesDown: 0, elitesDown: 0, floorsCleared: 0,
      shards: 0, seenEvents: [],
      arenaCount: { standard: 0, elite: 0 },
      pending: null,
      over: false, win: false,
      startedAt: Date.now(),
      playSeconds: 0,
    };
    this.recompute();
    this.state.hp = Math.max(10, Math.round(this.state.hpMax * mods.startHpMul));
    this.emit("start", { state: this.state });
    return this.state;
  },

  // Derived health. Recomputed whenever the deck or a bonus changes, and any
  // INCREASE heals you by the same amount — taking Vitality mid-run should
  // feel like a heal, not like a bigger empty bar.
  recompute() {
    const s = this.state;
    const core = CORE_BY_ID[s.coreId] || CORES[0];
    s.build = compileDeck(s.deck);
    const before = s.hpMax || 0;
    let max = core.hp + s.build.stats.hpMax + s.hpBonus;
    if (s.build.flags.has("glass")) max = Math.ceil(max / 2);
    s.hpMax = Math.max(8, Math.round(max));
    if (before && s.hpMax > before) s.hp += s.hpMax - before;
    s.hp = Math.min(s.hp, s.hpMax);
  },

  map(act) {
    const a = act || this.state.act;
    if (!this.maps[a]) this.maps[a] = buildMap(this.state.seed, a, this.state.unlocked);
    return this.maps[a];
  },

  // The nodes you may move to right now: the entry row at the start of an act,
  // otherwise wherever the current node leads.
  options() {
    const s = this.state;
    if (s.over || s.pending) return [];
    const m = this.map();
    if (!s.nodeId) return m.entries.map((id) => m.byId[id]);
    return (m.byId[s.nodeId].to || []).map((id) => m.byId[id]).filter(Boolean);
  },

  currentNode() {
    const s = this.state;
    return s.nodeId ? this.map().byId[s.nodeId] : null;
  },

  /* --------------------------------------------------------------- moving */
  enter(nodeId) {
    const s = this.state;
    if (s.over || s.pending) return null;
    const legal = this.options().some((n) => n.id === nodeId);
    if (!legal) return null;

    const node = this.map().byId[nodeId];
    s.nodeId = nodeId;
    s.floor = node.floor;
    s.visited.push(nodeId);

    switch (node.type) {
      case "battle": case "elite": case "boss":
        s.pending = { kind: "battle", node: node.type };
        break;
      case "shop":
        s.pending = this.makeShop();
        break;
      case "event":
        s.pending = this.makeEvent();
        break;
      case "rest":
        s.pending = { kind: "rest", options: REST_OPTIONS.map((o) => o.id) };
        break;
      case "treasure":
        s.pending = this.makeTreasure();
        break;
    }
    this.emit("node", { node, pending: s.pending });
    return s.pending;
  },

  /* -------------------------------------------------------------- battles */
  // Everything game.js needs to run this fight. The only place the two layers
  // touch.
  battleConfig() {
    const s = this.state;
    const node = this.currentNode();
    const kind = node.type;
    const mods = ascentMods(s.ascent);
    const isBoss = kind === "boss";
    const isElite = kind === "elite";

    let arena, boss = null;
    if (isBoss) {
      boss = this.map().bossKey;
      arena = BOSSES.room(boss);
    } else {
      arena = this.pickArena(isElite ? "elite" : "standard");
    }

    // Act difficulty comes mostly from WHAT is in the room — act 3 arenas are
    // built out of Monoliths and Bulwarks — so this multiplier stays gentle.
    // The first pass had it at +55% per act on top of that and the perfect bot
    // could not finish an act-3 room inside three minutes.
    const hpMul = (1 + (s.act - 1) * 0.18 + node.floor * 0.02)
      * (isElite ? 1.28 * mods.eliteMul : 1)
      * mods.hpMul;

    return {
      arena, boss,
      build: s.build,
      seed: s.seed,
      floor: node.floor,
      tier: kind,
      hp: s.hp, hpMax: s.hpMax,
      hpMul,
      speedMul: 1 + (s.act - 1) * 0.06 + (isElite ? 0.04 : 0),
      scoreMul: 1 + (s.act - 1) * 0.55 + (isElite ? 0.4 : 0) + (isBoss ? 0.8 : 0),
      // What a dropped ball costs. It rises through the climb rather than
      // being flat: a bot dying on the very first room of a run turned out to
      // be a flat 8 against a starting 62, which is eight mistakes for the
      // whole of act 1. This is the main dial for overall difficulty — it is
      // the only one that makes a mistake matter without making a room longer.
      hpPerBall: Math.round(((isBoss ? 6 : isElite ? 4 : 0) + 6 + s.act * 2.5) * (mods.hurtMul || 1)),
      timeLimit: isBoss ? 240 : isElite ? 190 : 155,
      goldBase: Math.round((26 + node.floor * 2.4 + s.act * 9) * (isElite ? 2 : 1) * (isBoss ? 3 : 1)),
    };
  },

  // Arenas are drawn from a shuffled bag per act and tier, so a run never
  // repeats a room until it has seen all of them.
  pickArena(tier) {
    const s = this.state;
    const pool = arenaPool(s.act, tier);
    const bag = RNG.sub(s.seed, "arenabag", s.act, tier).shuffle(pool);
    const i = s.arenaCount[tier] % bag.length;
    s.arenaCount[tier]++;
    return bag[i];
  },

  // Called with the result object game.js emitted.
  battleDone(result, cfg) {
    const s = this.state;
    const node = this.currentNode();
    s.hp = result.hp;
    s.score += result.score;
    s.bricks += result.bricks;
    s.playSeconds += result.time;

    if (!result.win || s.hp <= 0) { this.endRun(false); return null; }

    s.floorsCleared++;
    if (node.type === "elite") s.elitesDown++;
    if (node.type === "boss") s.bossesDown++;

    const goldMul = 1 + s.build.stats.goldPct / 100;
    const gold = Math.round((cfg.goldBase + result.gold) * goldMul);
    s.gold += gold;

    // Reward: three cards, with the rare odds leaning up for anything harder
    // than a standard fight.
    const bias = node.type === "boss" ? 3.4 : node.type === "elite" ? 2.2 : 1;
    const n = node.type === "boss" ? 4 : 3;
    const rng = RNG.sub(s.seed, "reward", s.act, node.floor, node.lane);
    const offer = drawCards(rng, draftPool(s.unlocked), s.deck, n, bias);

    s.pending = { kind: "reward", offer, gold, from: node.type,
                  bonusShards: node.type === "boss" ? 20 : node.type === "elite" ? 8 : 0 };
    if (s.pending.bonusShards) s.shards += s.pending.bonusShards;

    this.emit("reward", s.pending);
    return s.pending;
  },

  /* -------------------------------------------------------------- rewards */
  // `replaceId` is only needed once the deck is full, and the UI asks for it
  // then: the reward screen turns into "which one goes?".
  takeCard(id, replaceId) {
    const s = this.state;
    if (!s.pending || !s.pending.offer || !s.pending.offer.includes(id)) return false;
    if (!this.addCard(id, replaceId)) return false;
    s.pending = null;
    this.afterNode();
    return true;
  },

  deckFull() { return this.state.deck.length >= DECK_LIMIT; },

  skipReward() {
    const s = this.state;
    if (!s.pending) return false;
    // Skipping is worth something, or nobody ever would.
    s.gold += 22;
    s.pending = null;
    this.afterNode();
    return true;
  },

  addCard(id, replaceId) {
    const c = CARD_BY_ID[id];
    if (!c) return false;
    const deck = this.state.deck;
    const have = deck.filter((x) => x === id).length;
    if (have >= c.max) return false;
    if (deck.length >= DECK_LIMIT) {
      const i = replaceId ? deck.indexOf(replaceId) : -1;
      if (i < 0) return false;
      deck.splice(i, 1);
      this.emit("drop", { id: replaceId });
    }
    deck.push(id);
    this.recompute();
    this.emit("card", { id });
    return true;
  },

  /* ---------------------------------------------------------------- shops */
  makeShop() {
    const s = this.state;
    const rng = RNG.sub(s.seed, "shop", s.act, s.floor, s.visited.length);
    const cards = drawCards(rng, draftPool(s.unlocked), s.deck, 4, 1.5);
    const markup = s.build.flags.has("greed") ? 1.2 : 1;
    const actMul = 1 + (s.act - 1) * 0.28;
    return {
      kind: "shop",
      cards: cards.map((id) => ({
        id, cost: Math.round(CARD_PRICE[CARD_BY_ID[id].rarity] * actMul * markup) })),
      services: rng.shuffle(SHOP_SERVICES).slice(0, 3).map((sv) => ({
        id: sv.id, cost: Math.round(sv.cost * actMul * markup) })),
      bought: [],
      rerolled: false,
    };
  },

  buy(kind, id) {
    const s = this.state;
    const p = s.pending;
    if (!p || p.kind !== "shop") return { ok: false, why: "no shop" };
    const tag = kind + ":" + id;
    if (p.bought.includes(tag)) return { ok: false, why: "gone" };

    const row = (kind === "card" ? p.cards : p.services).find((x) => x.id === id);
    if (!row) return { ok: false, why: "gone" };
    if (kind === "card" && this.deckFull()) return { ok: false, why: "full" };
    if (s.gold < row.cost) return { ok: false, why: "poor" };

    s.gold -= row.cost;
    p.bought.push(tag);

    if (kind === "card") { this.addCard(id); return { ok: true }; }

    const sv = SHOP_SERVICES.find((x) => x.id === id);
    if (sv.out.reroll) {
      if (p.rerolled) return { ok: false, why: "gone" };
      const fresh = this.makeShop();
      fresh.bought = p.bought;
      fresh.rerolled = true;
      s.pending = fresh;
      return { ok: true, rerolled: true };
    }
    this.applyOutcome(sv.out);
    return { ok: true };
  },

  leaveShop() {
    if (!this.state.pending || this.state.pending.kind !== "shop") return false;
    this.state.pending = null;
    this.afterNode();
    return true;
  },

  /* --------------------------------------------------------------- events */
  // An event you have already met this run is boring, so the pool shrinks as
  // you climb and only reopens once you have seen all twelve.
  makeEvent() {
    const s = this.state;
    const seen = new Set(s.seenEvents || []);
    const rng = RNG.sub(s.seed, "event", s.act, s.floor, s.visited.length);
    const pool = EVENTS.filter((e) => !seen.has(e.id));
    const e = rng.pick(pool.length ? pool : EVENTS);
    (s.seenEvents = s.seenEvents || []).push(e.id);
    return { kind: "event", id: e.id };
  },

  eventChoose(index) {
    const s = this.state;
    if (!s.pending || s.pending.kind !== "event") return null;
    const e = EVENT_BY_ID[s.pending.id];
    const choice = e.choices[index];
    if (!choice) return null;
    if (choice.need && choice.need.gold && s.gold < choice.need.gold) return null;

    const res = this.applyOutcome(choice.out);
    s.pending = null;
    // A card outcome opens a small pick screen instead of resolving instantly.
    if (res.offer) {
      s.pending = { kind: "reward", offer: res.offer, gold: 0, from: "event", bonusShards: 0 };
      this.emit("reward", s.pending);
      return { msg: choice.out.msg, offer: res.offer };
    }
    this.afterNode();
    return { msg: choice.out.msg };
  },

  /* ---------------------------------------------------------------- rests */
  restChoose(id) {
    const s = this.state;
    if (!s.pending || s.pending.kind !== "rest") return null;
    if (id === "sleep") {
      const before = s.hp;
      // Healing supply, not the cost of a mistake, is what decides how long a
      // climb lasts: raising hpPerBall barely moved the win rate because the
      // bot simply healed more. This is the dial that actually bites.
      s.hp = Math.min(s.hpMax, s.hp + Math.round(s.hpMax * 0.26));
      s.pending = null;
      this.afterNode();
      return { healed: s.hp - before };
    }
    if (id === "dig") {
      s.hpBonus += 12;
      this.recompute();
      s.hp = Math.min(s.hpMax, s.hp + 12);
      s.pending = null;
      this.afterNode();
      return { hpMax: 12 };
    }
    // "Study" turns the campfire into a small draft.
    const rng = RNG.sub(s.seed, "rest", s.act, s.floor, s.visited.length);
    const offer = drawCards(rng, draftPool(s.unlocked), s.deck, 3, 1.8);
    s.pending = { kind: "reward", offer, gold: 0, from: "rest", bonusShards: 0 };
    this.emit("reward", s.pending);
    return { offer };
  },

  /* ------------------------------------------------------------- treasure */
  makeTreasure() {
    const s = this.state;
    const rng = RNG.sub(s.seed, "chest", s.act, s.floor, s.visited.length);
    const chest = rng.weighted(CHESTS, (c) => c.weight);
    const gold = rng.int(chest.gold[0], chest.gold[1]) + Math.round(s.act * 12);
    const offer = drawCards(rng, draftPool(s.unlocked), s.deck, 3,
                            chest.id === "large" ? 3 : chest.id === "medium" ? 1.8 : 1.2);
    return { kind: "treasure", chest: chest.id, gold, shards: chest.shards, offer, opened: false };
  },

  openChest() {
    const s = this.state;
    const p = s.pending;
    if (!p || p.kind !== "treasure" || p.opened) return null;
    p.opened = true;
    s.gold += Math.round(p.gold * (1 + s.build.stats.goldPct / 100));
    s.shards += p.shards;
    s.pending = { kind: "reward", offer: p.offer, gold: p.gold, from: "treasure", bonusShards: p.shards };
    this.emit("reward", s.pending);
    return s.pending;
  },

  /* -------------------------------------------------------------- outcomes */
  // One place applies every event/shop/rest outcome, so a new event is data
  // and never code. Returns `{offer}` when the outcome opens a card pick.
  applyOutcome(out) {
    const s = this.state;
    const res = {};
    if (out.gold) s.gold = Math.max(0, s.gold + out.gold);
    if (out.hpMax) { s.hpBonus += out.hpMax; this.recompute(); }
    if (out.hp) s.hp += out.hp;
    if (out.heal) s.hp = Math.min(s.hpMax, s.hp + out.heal);
    if (out.shards) s.shards += out.shards;
    // A curse can only stick if there is room for it. Silently shoving a card
    // out of a full deck to make space for a downside would be a nasty
    // surprise buried in an event's small print.
    if (out.bane && !this.deckFull()) this.addCard(out.bane);
    if (out.card) {
      const rng = RNG.sub(s.seed, "gift", s.act, s.floor, s.visited.length);
      const pool = draftPool(s.unlocked);
      const ids = [];
      const first = drawByRarity(rng, pool, s.deck, out.card.rarity, out.card.type);
      if (first) ids.push(first);
      const rest = drawCards(rng, pool, [...s.deck, ...ids], 2,
                             out.card.rarity === "rare" ? 2.4 : 1.4, out.card.type);
      res.offer = [...ids, ...rest];
    }
    s.hp = Math.min(s.hp, s.hpMax);
    // An event that costs more health than you have really can end a run.
    if (s.hp <= 0) { s.hp = 0; this.endRun(false); }
    return res;
  },

  /* --------------------------------------------------------------- moving on */
  afterNode() {
    const s = this.state;
    if (s.over) return;
    const node = this.currentNode();
    if (node && node.type === "boss") {
      if (s.act >= ACTS) { this.endRun(true); return; }
      s.act++;
      s.nodeId = null;
      s.floor = -1;
      s.arenaCount = { standard: 0, elite: 0 };
      this.emit("act", { act: s.act });
    }
    this.emit("map", {});
  },

  endRun(win) {
    const s = this.state;
    if (s.over) return;
    s.over = true;
    s.win = win;
    s.pending = null;
    const earned = shardsFor({
      floorsCleared: s.floorsCleared, bossesDown: s.bossesDown, win, ascent: s.ascent,
    });
    s.shardsEarned = s.shards + earned;
    this.emit("over", { win, state: s, shards: s.shardsEarned });
  },

  /* ---------------------------------------------------------- save/restore */
  // Everything needed to rebuild the run. Notably NOT the map, the offers or
  // the shop stock — those all come back out of the seed.
  serialize() {
    const s = this.state;
    if (!s || s.over) return null;
    const keep = ["seed", "mode", "coreId", "ascent", "unlocked", "act", "nodeId", "floor",
                  "visited", "deck", "gold", "hpBonus", "hp", "hpMax", "score", "bricks",
                  "bossesDown", "elitesDown", "floorsCleared", "shards", "arenaCount",
                  "pending", "startedAt", "playSeconds", "seenEvents", "serial", "date"];
    const out = { v: 1 };
    for (const k of keep) out[k] = s[k];
    return out;
  },

  restore(saved) {
    if (!saved || saved.v !== 1) return null;
    this.maps = {};
    this.state = Object.assign({ over: false, win: false }, saved);
    this.recompute();
    this.state.hp = Math.min(this.state.hp, this.state.hpMax);
    this.emit("start", { state: this.state, resumed: true });
    return this.state;
  },

  /* ------------------------------------------------------------------ views */
  // A compact description of the current climb, for the HUD and the map screen.
  summary() {
    const s = this.state;
    return {
      act: s.act, floor: s.floor, hp: s.hp, hpMax: s.hpMax, gold: s.gold,
      score: Math.round(s.score), deck: s.deck.length, shards: s.shards,
      mode: s.mode, over: s.over, win: s.win,
    };
  },
};

if (typeof module !== "undefined") {
  module.exports = { Run, buildMap, drawCards, drawByRarity,
                     FLOORS, LANES, ACTS, BOSS_FLOOR, NODE_WEIGHTS, FIXED_FLOORS,
                     TYPE_FLOORS, NO_REPEAT, DECK_LIMIT };
}
