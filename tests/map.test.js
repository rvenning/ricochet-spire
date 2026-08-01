// Lints the generated maps and the run layer.
//
// A map is generated, so there is no hand-authored artefact to inspect — the
// only way to know it is sound is to make a few hundred of them and check the
// properties that must hold for all of them. Two matter most: every node you
// can start on must reach the boss (otherwise a player picks a branch and the
// climb dead-ends), and no two edges on a floor may cross (nothing breaks, but
// a crossed map is unreadable, which is a bug in a game you play with a
// thumb).

const test = require("node:test");
const assert = require("node:assert");
const { loadEngine } = require("./load.js");

const S = loadEngine();
const { Run, buildMap, drawCards, drawByRarity, RNG, CARD_BY_ID, draftPool,
        FLOORS, LANES, ACTS, BOSS_FLOOR, FIXED_FLOORS, NODE_WEIGHTS,
        EVENTS, EVENT_BY_ID, SHOP_SERVICES, CHESTS, REST_OPTIONS, CARD_PRICE,
        CARDS, LOCKED_CARDS } = S;

const SEEDS = Array.from({ length: 70 }, (_, i) => 1000 + i * 977);
const ALL_UNLOCKED = LOCKED_CARDS.map((c) => "card:" + c.id);

function everyMap(fn) {
  const fails = [];
  for (const seed of SEEDS) {
    for (let act = 1; act <= ACTS; act++) {
      const m = buildMap(seed, act, ALL_UNLOCKED);
      fn(m, fails, seed, act);
    }
  }
  return fails;
}

test("every starting node reaches the boss", () => {
  const fails = everyMap((m, fails, seed, act) => {
    const boss = m.nodes.find((n) => n.floor === BOSS_FLOOR);
    if (!boss) { fails.push(`${seed}/${act}: no boss node`); return; }
    for (const entry of m.entries) {
      const seen = new Set([entry]);
      const q = [entry];
      let reached = false;
      while (q.length) {
        const id = q.pop();
        if (id === boss.id) { reached = true; break; }
        for (const next of m.byId[id].to) if (!seen.has(next)) { seen.add(next); q.push(next); }
      }
      if (!reached) fails.push(`${seed}/${act}: ${entry} dead-ends`);
    }
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("no node is a dead end and none is unreachable", () => {
  const fails = everyMap((m, fails, seed, act) => {
    const reachable = new Set(m.entries);
    const q = [...m.entries];
    while (q.length) {
      const id = q.pop();
      for (const next of m.byId[id].to) if (!reachable.has(next)) { reachable.add(next); q.push(next); }
    }
    for (const n of m.nodes) {
      if (n.floor < BOSS_FLOOR && !n.to.length) fails.push(`${seed}/${act}: ${n.id} goes nowhere`);
      if (!reachable.has(n.id)) fails.push(`${seed}/${act}: ${n.id} cannot be reached`);
    }
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("no two edges cross on a floor", () => {
  const fails = everyMap((m, fails, seed, act) => {
    m.edgesByFloor.forEach((edges, f) => {
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const [a, b] = edges[i], [c, d] = edges[j];
          if ((a < c && b > d) || (a > c && b < d)) {
            fails.push(`${seed}/${act} floor ${f}: ${a}->${b} crosses ${c}->${d}`);
          }
        }
      }
    });
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("the skeleton of every act is the same", () => {
  const fails = everyMap((m, fails, seed, act) => {
    for (const n of m.nodes) {
      const fixed = FIXED_FLOORS[n.floor];
      if (fixed && n.type !== fixed) fails.push(`${seed}/${act}: floor ${n.floor} is ${n.type}, want ${fixed}`);
      if (!fixed && !NODE_WEIGHTS[n.type]) fails.push(`${seed}/${act}: ${n.id} has type ${n.type}`);
      if (n.floor < 3 && n.type === "elite") fails.push(`${seed}/${act}: elite on floor ${n.floor}`);
    }
    const bosses = m.nodes.filter((n) => n.type === "boss");
    if (bosses.length !== 1) fails.push(`${seed}/${act}: ${bosses.length} boss nodes`);
    if (!m.entries.length) fails.push(`${seed}/${act}: nowhere to start`);
    if (!S.BOSSES[m.bossKey]) fails.push(`${seed}/${act}: unknown boss ${m.bossKey}`);
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("no path stacks two of the same special room", () => {
  const fails = everyMap((m, fails, seed, act) => {
    for (const n of m.nodes) {
      if (!["rest", "shop", "elite", "treasure"].includes(n.type)) continue;
      for (const p of n.from) {
        if (m.byId[p].type === n.type && !FIXED_FLOORS[n.floor]) {
          fails.push(`${seed}/${act}: ${n.type} straight after ${n.type} at ${n.id}`);
        }
      }
    }
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("a climb has enough fights, and enough that is not a fight", () => {
  const mixes = [];
  for (const seed of SEEDS) {
    for (let act = 1; act <= ACTS; act++) {
      const m = buildMap(seed, act, ALL_UNLOCKED);
      // Walk one greedy path up and count what it meets, which is what a
      // player actually experiences — the whole-map histogram is not.
      let node = m.byId[m.entries[0]];
      const seen = { battle: 0, elite: 0, event: 0, shop: 0, rest: 0, treasure: 0, boss: 0 };
      while (node) {
        seen[node.type]++;
        const next = node.to[0];
        node = next ? m.byId[next] : null;
      }
      mixes.push(seen);
    }
  }
  const avg = (k) => mixes.reduce((s, m) => s + m[k], 0) / mixes.length;
  assert.ok(avg("battle") >= 3.5, `only ${avg("battle").toFixed(1)} fights per act`);
  assert.ok(avg("battle") <= 8, `${avg("battle").toFixed(1)} fights per act is a slog`);
  assert.ok(avg("elite") >= 0.6, `elites are too rare (${avg("elite").toFixed(2)}/act)`);
  assert.ok(avg("shop") + avg("event") >= 1.6, "not enough happens between the fights");
  for (const m of mixes) {
    assert.equal(m.boss, 1, "every path must end at exactly one boss");
    assert.equal(m.treasure, 1, "exactly one chest per act, on the fixed floor");
    // One campfire is guaranteed before the boss; the rest window allows at
    // most one more. Four of them made health stop mattering.
    assert.ok(m.rest >= 1 && m.rest <= 2, `${m.rest} campfires on one path`);
  }
});

test("every room type appears only where it is allowed to", () => {
  const fails = everyMap((m, fails, seed, act) => {
    for (const n of m.nodes) {
      if (FIXED_FLOORS[n.floor]) continue;
      const w = S.TYPE_FLOORS[n.type];
      if (w && (n.floor < w[0] || n.floor > w[1])) {
        fails.push(`${seed}/${act}: ${n.type} on floor ${n.floor}, window is ${w}`);
      }
    }
  });
  assert.deepEqual(fails.slice(0, 8), []);
});

test("the same seed builds the same map, a different seed does not", () => {
  const a = buildMap(555, 1, []);
  const b = buildMap(555, 1, []);
  const c = buildMap(556, 1, []);
  const sig = (m) => m.nodes.map((n) => `${n.floor}.${n.lane}.${n.type}>${n.to.join(",")}`).join("|");
  assert.equal(sig(a), sig(b), "a seed must be a run");
  assert.notEqual(sig(a), sig(c));
  assert.notEqual(sig(a), sig(buildMap(555, 2, [])), "acts must differ from each other");
});

/* ------------------------------------------------------------- card drawing */
test("drawCards never repeats, never exceeds a copy limit, never breaks", () => {
  const fails = [];
  const pool = draftPool([]);
  for (let i = 0; i < 200; i++) {
    const rng = RNG.make(i * 31 + 7);
    const offer = drawCards(rng, pool, ["sharpen", "sharpen", "sharpen"], 3, 1);
    if (new Set(offer).size !== offer.length) fails.push(`seed ${i}: duplicate in one offer`);
    if (offer.includes("sharpen")) fails.push(`seed ${i}: offered a 4th Sharpen (max 3)`);
    for (const id of offer) if (!CARD_BY_ID[id]) fails.push(`seed ${i}: offered ${id}`);
  }
  // A deck holding every card at its limit must simply offer nothing.
  const full = [];
  for (const c of CARDS) for (let i = 0; i < c.max; i++) full.push(c.id);
  assert.deepEqual(drawCards(RNG.make(1), pool, full, 3, 1), []);
  assert.deepEqual(fails.slice(0, 6), []);
});

test("a bias really does bring the rare cards out", () => {
  const pool = draftPool(ALL_UNLOCKED);
  const count = (bias) => {
    let rares = 0;
    for (let i = 0; i < 400; i++) {
      for (const id of drawCards(RNG.make(i * 17 + 3), pool, [], 3, bias)) {
        const c = CARD_BY_ID[id];
        if (c.rarity === "rare" || c.rarity === "legendary") rares++;
      }
    }
    return rares;
  };
  const plain = count(1), elite = count(2.2), boss = count(3.4);
  assert.ok(elite > plain * 1.3, `elite offers ${elite} rares vs ${plain} — not worth the risk`);
  assert.ok(boss > elite, "a boss must beat an elite for rares");
});

test("drawByRarity falls back down instead of returning nothing", () => {
  const pool = draftPool([]);
  // No legendary is available once keystone is already held at its limit.
  const held = CARDS.filter((c) => c.rarity === "legendary").map((c) => c.id);
  const id = drawByRarity(RNG.make(9), pool, held, "legendary");
  assert.ok(id, "a promised card must always arrive");
  assert.ok(CARD_BY_ID[id].rarity !== "legendary" || !held.includes(id));
});

/* ------------------------------------------------------------------- events */
test("every event branch is applicable and worth reading", () => {
  const fails = [];
  const ids = new Set();
  const OUT_KEYS = new Set(["gold", "hp", "hpMax", "heal", "card", "bane", "shards", "msg"]);
  for (const e of EVENTS) {
    if (ids.has(e.id)) fails.push(`duplicate event ${e.id}`);
    ids.add(e.id);
    if (!e.name || !e.icon || !e.text) fails.push(`${e.id}: incomplete`);
    if (e.choices.length < 2) fails.push(`${e.id}: an event with one option is a cutscene`);
    for (const c of e.choices) {
      if (!c.label || !c.detail) fails.push(`${e.id}: a choice with no label`);
      if (!c.out || !c.out.msg) fails.push(`${e.id}/${c.label}: no outcome message`);
      for (const k of Object.keys(c.out || {})) {
        if (!OUT_KEYS.has(k)) fails.push(`${e.id}/${c.label}: unknown outcome key "${k}"`);
      }
      if (c.out.bane && !CARD_BY_ID[c.out.bane]) fails.push(`${e.id}: bane ${c.out.bane} does not exist`);
      if (c.out.card && !["common", "uncommon", "rare", "legendary"].includes(c.out.card.rarity)) {
        fails.push(`${e.id}: card outcome with rarity ${c.out.card.rarity}`);
      }
      if (c.need && !(c.need.gold > 0)) fails.push(`${e.id}: a requirement of nothing`);
      // A choice that costs gold you might not have must actually check for it.
      if (c.out.gold < 0 && !(c.need && c.need.gold >= -c.out.gold)) {
        fails.push(`${e.id}/${c.label}: spends ${-c.out.gold} gold with no requirement`);
      }
    }
    // At least one branch has to be safe, or the event is a tax.
    const safe = e.choices.some((c) => !(c.out.hp < 0) && !(c.out.bane) && !(c.need));
    if (!safe) fails.push(`${e.id}: every branch has a cost — no way to walk away`);
  }
  assert.deepEqual(fails, []);
});

test("shops, chests and campfires are complete", () => {
  const fails = [];
  for (const s of SHOP_SERVICES) {
    if (!s.name || !s.icon || !s.desc) fails.push(`service ${s.id}: incomplete`);
    if (!(s.cost > 0)) fails.push(`service ${s.id}: free`);
  }
  for (const r of ["common", "uncommon", "rare", "legendary"]) {
    if (!(CARD_PRICE[r] > 0)) fails.push(`no price for ${r}`);
  }
  assert.ok(CARD_PRICE.legendary > CARD_PRICE.rare, "rarity must cost more");
  assert.ok(CARD_PRICE.rare > CARD_PRICE.uncommon);
  assert.ok(CARD_PRICE.uncommon > CARD_PRICE.common);
  let w = 0;
  for (const c of CHESTS) {
    if (!(c.weight > 0)) fails.push(`chest ${c.id}: never appears`);
    if (!(c.gold[1] > c.gold[0])) fails.push(`chest ${c.id}: bad gold range`);
    w += c.weight;
  }
  if (w !== 100) fails.push(`chest weights sum to ${w}, not 100`);
  if (REST_OPTIONS.length !== 3) fails.push("a campfire wants three things to do");
  assert.deepEqual(fails, []);
});

/* --------------------------------------------------------------- the run API */
function play(seed, opts = {}) {
  return Run.start({ seed, unlocked: ALL_UNLOCKED, ...opts });
}

test("a run starts on the entry row with a core's deck and gold", () => {
  const s = play(4242);
  assert.equal(s.act, 1);
  assert.equal(s.nodeId, null);
  assert.ok(s.hp > 0 && s.hp === s.hpMax);
  assert.deepEqual(s.deck, ["sharpen"]);
  const opts = Run.options();
  assert.ok(opts.length >= 1 && opts.every((n) => n.floor === 0));
  assert.equal(Run.enter("nonsense"), null, "you may not teleport");
});

test("entering a node produces the right pending screen", () => {
  const seen = new Set();
  for (const seed of SEEDS.slice(0, 30)) {
    play(seed);
    const m = Run.map(1);
    for (const n of m.nodes) {
      // Reach in and force each node type, rather than relying on the walk.
      Run.state.nodeId = n.from.length ? n.from[0] : null;
      Run.state.pending = null;
      if (!n.from.length && n.floor !== 0) continue;
      const p = Run.enter(n.id);
      if (!p) continue;
      seen.add(p.kind);
      assert.ok(["battle", "shop", "event", "rest", "treasure"].includes(p.kind), p.kind);
    }
  }
  for (const k of ["battle", "shop", "event", "rest", "treasure"]) {
    assert.ok(seen.has(k), `never produced a ${k} node in 30 seeds`);
  }
});

test("battleConfig scales with the act and the room's tier", () => {
  play(777);
  const m = Run.map(1);
  const first = m.byId[m.entries[0]];
  Run.enter(first.id);
  const c1 = Run.battleConfig();
  assert.ok(c1.arena && c1.build && c1.hpMul > 0);
  assert.equal(c1.boss, null);
  assert.equal(c1.hpPerBall, 9, "a dropped ball is cheapest in act 1");

  // Force the boss node of act 3 and compare.
  Run.state.act = 3;
  Run.state.nodeId = null;
  const m3 = Run.map(3);
  const boss = m3.nodes.find((n) => n.type === "boss");
  Run.state.nodeId = boss.id;
  Run.state.floor = boss.floor;
  const c3 = Run.battleConfig();
  assert.ok(c3.boss, "a boss node must bring a boss");
  assert.ok(c3.hpMul > c1.hpMul, "act 3 must be tougher than act 1");
  assert.ok(c3.hpPerBall > c1.hpPerBall, "and a mistake must cost more up there");
  assert.ok(c3.scoreMul > c1.scoreMul, "and worth more");
  assert.ok(c3.timeLimit > c1.timeLimit, "and given longer");
});

test("an act never repeats an arena", () => {
  play(31337);
  const seen = [];
  for (let i = 0; i < 7; i++) seen.push(Run.pickArena("standard").id);
  assert.equal(new Set(seen).size, seen.length, `repeated a room: ${seen.join(", ")}`);
});

test("taking a card changes the build; skipping pays instead", () => {
  const s = play(2024);
  const m = Run.map(1);
  Run.enter(m.entries[0]);
  const cfg = Run.battleConfig();
  const goldBefore = s.gold;
  const p = Run.battleDone({ win: true, hp: s.hpMax, score: 900, gold: 20, bricks: 40, time: 44 }, cfg);
  assert.equal(p.kind, "reward");
  assert.equal(p.offer.length, 3);
  assert.ok(s.gold > goldBefore, "clearing a room must pay");
  assert.ok(Run.takeCard(p.offer[0]));
  assert.ok(s.deck.includes(p.offer[0]));
  assert.equal(s.pending, null);

  // And skipping.
  const node = Run.options()[0];
  Run.enter(node.id);
  if (Run.state.pending.kind === "battle") {
    const c2 = Run.battleConfig();
    Run.battleDone({ win: true, hp: s.hp, score: 100, gold: 5, bricks: 10, time: 30 }, c2);
    const g = s.gold, n = s.deck.length;
    Run.skipReward();
    assert.equal(s.deck.length, n);
    assert.ok(s.gold > g, "skipping has to be worth something");
  }
});

test("losing a fight ends the run there and then", () => {
  const s = play(8);
  Run.enter(Run.map(1).entries[0]);
  const cfg = Run.battleConfig();
  const p = Run.battleDone({ win: false, hp: 0, score: 300, gold: 0, bricks: 12, time: 90 }, cfg);
  assert.equal(p, null);
  assert.equal(s.over, true);
  assert.equal(s.win, false);
  assert.ok(s.shardsEarned > 0, "even a short run must pay something into the Archive");
});

test("Glass Cannon halves your health once, and only once", () => {
  const s = play(11);
  const before = s.hpMax;
  Run.addCard("glass");
  assert.ok(Math.abs(s.hpMax - Math.ceil(before / 2)) <= 1, `${before} -> ${s.hpMax}`);
  const halved = s.hpMax;
  Run.addCard("sharpen");
  assert.equal(s.hpMax, halved, "recomputing must not halve it again");
});

test("Vitality heals you by exactly what it adds", () => {
  const s = play(12);
  s.hp = 20;
  const maxBefore = s.hpMax;
  Run.addCard("vitality");
  assert.equal(s.hpMax, maxBefore + 18);
  assert.equal(s.hp, 38, "a bigger bar you cannot fill is a cruel joke");
});

test("shops charge, refuse when you are broke, and never sell twice", () => {
  const s = play(99);
  s.gold = 400;
  Run.state.pending = Run.makeShop();
  const shop = s.pending;
  assert.equal(shop.cards.length, 4);
  assert.equal(shop.services.length, 3);
  const card = shop.cards[0];
  const before = s.gold;
  assert.equal(Run.buy("card", card.id).ok, true);
  assert.equal(s.gold, before - card.cost);
  assert.equal(Run.buy("card", card.id).why, "gone");
  s.gold = 0;
  const other = shop.cards[1];
  assert.equal(Run.buy("card", other.id).why, "poor");
});

test("Greed really does make the shopkeeper charge more", () => {
  play(1234);
  const plain = Run.makeShop();
  Run.addCard("greed");
  const greedy = Run.makeShop();
  assert.ok(greedy.cards[0].cost > plain.cards[0].cost,
    `${greedy.cards[0].cost} should exceed ${plain.cards[0].cost}`);
});

test("every event resolves through the same outcome applier", () => {
  const fails = [];
  for (const e of EVENTS) {
    for (let i = 0; i < e.choices.length; i++) {
      const s = play(4000 + i);
      s.gold = 500;                              // afford every branch
      s.hp = s.hpMax;
      Run.state.pending = { kind: "event", id: e.id };
      const res = Run.eventChoose(i);
      if (!res) { fails.push(`${e.id} choice ${i} did nothing`); continue; }
      if (s.hp > s.hpMax) fails.push(`${e.id} choice ${i} overhealed`);
      if (s.gold < 0) fails.push(`${e.id} choice ${i} left ${s.gold} gold`);
      const out = e.choices[i].out;
      if (out.card && !(s.pending && s.pending.kind === "reward")) {
        fails.push(`${e.id} choice ${i} promised a card and offered none`);
      }
      if (out.bane && !s.deck.includes(out.bane)) fails.push(`${e.id} choice ${i} bane not applied`);
    }
  }
  assert.deepEqual(fails, []);
});

test("a campfire always does something useful", () => {
  for (const opt of REST_OPTIONS) {
    const s = play(555);
    s.hp = Math.round(s.hpMax / 2);
    Run.state.pending = { kind: "rest", options: REST_OPTIONS.map((o) => o.id) };
    const r = Run.restChoose(opt.id);
    assert.ok(r, `${opt.id} did nothing`);
    if (opt.id === "sleep") assert.ok(r.healed > 0);
    if (opt.id === "dig") assert.ok(s.hpMax > 0 && r.hpMax === 12);
    if (opt.id === "study") assert.equal(r.offer.length, 3);
  }
});

test("clearing a boss moves you up an act; clearing act 3 wins", () => {
  const s = play(64);
  for (let act = 1; act <= ACTS; act++) {
    const m = Run.map(act);
    const boss = m.nodes.find((n) => n.type === "boss");
    s.nodeId = boss.id;
    s.floor = boss.floor;
    s.pending = { kind: "reward", offer: [], gold: 0, from: "boss", bonusShards: 0 };
    Run.skipReward();
    if (act < ACTS) {
      assert.equal(s.act, act + 1, `act ${act} boss should lead to act ${act + 1}`);
      assert.equal(s.nodeId, null, "a new act starts back on the entry row");
    }
  }
  assert.equal(s.over, true);
  assert.equal(s.win, true);
});

/* ------------------------------------------------------------ save / resume */
test("a saved climb resumes to exactly the same run", () => {
  const s = play(20260801);
  // Play a few nodes so there is something to lose.
  Run.enter(Run.map(1).entries[0]);
  const cfg = Run.battleConfig();
  const p = Run.battleDone({ win: true, hp: s.hp - 8, score: 1200, gold: 30, bricks: 55, time: 51 }, cfg);
  Run.takeCard(p.offer[1]);
  const next = Run.options()[0];
  Run.enter(next.id);

  const saved = JSON.parse(JSON.stringify(Run.serialize()));
  const before = { deck: [...s.deck], gold: s.gold, hp: s.hp, node: s.nodeId,
                   pending: JSON.stringify(s.pending), opts: Run.options().map((n) => n.id) };

  // Wipe everything, as a page reload would.
  Run.state = null; Run.maps = {};
  const back = Run.restore(saved);

  assert.deepEqual(back.deck, before.deck);
  assert.equal(back.gold, before.gold);
  assert.equal(back.hp, before.hp);
  assert.equal(back.nodeId, before.node);
  assert.equal(JSON.stringify(back.pending), before.pending);
  assert.deepEqual(Run.options().map((n) => n.id), before.opts, "the map must rebuild identically");
  // And the map itself — the whole reason only a seed is stored.
  const sig = (m) => m.nodes.map((n) => n.id + n.type).join("|");
  assert.equal(sig(Run.map(1)), sig(buildMap(20260801, 1, ALL_UNLOCKED)));
});

test("a finished run has nothing to save", () => {
  play(5);
  Run.endRun(false);
  assert.equal(Run.serialize(), null);
});

test("the Daily is the same climb for everybody who plays it", () => {
  const seedA = RNG.seedFrom("2026-08-02");
  const seedB = RNG.seedFrom("2026-08-02");
  assert.equal(seedA, seedB);
  assert.notEqual(seedA, RNG.seedFrom("2026-08-03"));

  const run = (seed) => {
    Run.start({ seed, mode: "daily", unlocked: ALL_UNLOCKED });
    const m = Run.map(1);
    Run.enter(m.entries[0]);
    const cfg = Run.battleConfig();
    const rewards = Run.battleDone(
      { win: true, hp: 50, score: 1000, gold: 25, bricks: 44, time: 47 }, cfg);
    return {
      map: m.nodes.map((n) => n.id + n.type).join("|"),
      boss: m.bossKey,
      arena: cfg.arena.id,
      offer: rewards.offer.join(","),
      shop: JSON.stringify(Run.makeShop()),
    };
  };
  assert.deepEqual(run(seedA), run(seedB),
    "same day, same map, same arena, same three cards, same shop");
  assert.notDeepEqual(run(seedA), run(RNG.seedFrom("2026-08-03")));
});

test("RNG.sub depends on where it is used, not on what came before it", () => {
  const a = RNG.sub(99, "shop", 2, 8);
  const b = RNG.sub(99, "shop", 2, 8);
  assert.equal(a(), b());
  // Draining one generator must not move another.
  const c = RNG.sub(99, "reward", 2, 8);
  const drain = RNG.sub(99, "shop", 2, 8);
  for (let i = 0; i < 50; i++) drain();
  assert.equal(RNG.sub(99, "reward", 2, 8)(), c());
});
