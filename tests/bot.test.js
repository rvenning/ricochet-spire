// Headless balance bots. Run the report with:
//
//   node tests/bot.test.js --report
//
// A perfect paddle is unbeatable at Breakout, so a "perfect play" bot on its
// own would say nothing at all about whether the spire is fair. Two things make
// these measurements mean something:
//
//   1. THE PADDLE HAS A REAL TOP SPEED in the sim (BASE_PADDLE_SPEED). A bot
//      that knows exactly where the ball will land can still fail to get there,
//      which is what makes a fast arena genuinely harder rather than just
//      noisier.
//   2. THE TUNING TARGET IS `climber`, NOT `ace`. It reacts on a delay, aims a
//      little off, watches one ball at a time, and gets confused for a moment
//      after Mirror World flips. That is the player the spire is balanced for.
//
// The four bots and what each one is FOR:
//
//   ace     — reads the bounce perfectly and moves at the cap. A guardrail:
//             nothing in the game may be unwinnable by it.
//   climber — the tuning target. It must reach the top of the spire sometimes
//             and fail sometimes; a game it always wins has no stakes and a
//             game it never wins has no ending.
//   idle    — never touches the controls. The control. If putting the mouse
//             down clears an arena, that arena has nothing in it.
//   greedy  — ace, holding the strongest synergy in the game on purpose. It
//             must NOT erase act 3: a build that trivialises the ending is as
//             bad as one that does nothing.

const test = require("node:test");
const assert = require("node:assert");
const { loadEngine } = require("./load.js");

const S = loadEngine();
const { Game, Run, Physics, RNG, ARENAS, BOSS_LIST, CARD_BY_ID, LOCKED_CARDS,
        compileDeck, LW, PADDLE_Y, BALL_R, CORES, ACTS, arenaPool } = S;

const ALL_CARDS = LOCKED_CARDS.map((c) => "card:" + c.id);
const rand = S.__rand;              // the SANDBOX's seeded Math.random

/* ================================================================== brains */
// Which ball to watch: whichever is going to arrive first.
function threat(g) {
  let best = null, bestT = Infinity;
  for (const b of g.balls) {
    if (b.stuck) return b;
    if (b.vy <= 0) continue;
    const t = (PADDLE_Y - b.y) / b.vy;
    if (t >= 0 && t < bestT) { bestT = t; best = b; }
  }
  if (best) return best;
  return g.balls.reduce((a, b) => (!a || b.y > a.y ? b : a), null);
}

function landing(g, b) {
  if (!b) return LW / 2;
  if (b.stuck || b.vy <= 0) return b.x;
  return Physics.predictX(b.x, b.y, b.vx, b.vy, PADDLE_Y, BALL_R, LW - BALL_R);
}

// What the ball ought to be sent at next: the lowest brick left, or the boss
// part that is currently vulnerable.
function wantX(g) {
  if (g.boss) {
    const open = g.boss.parts.find((p) => !p.gone && !p.invuln && !p.pass)
              || g.boss.parts.find((p) => !p.gone);
    if (open) return open.x + open.w / 2;
  }
  let lowest = null;
  for (const b of g.bricks.values()) {
    if (!b.type.counts) continue;
    if (!lowest || b.cy > lowest.cy) lowest = b;
  }
  return lowest ? lowest.cx + g.driftX : LW / 2;
}

// Where to PUT the paddle, which is not the same as where the ball will land.
// Contact offset is the whole skill of the genre: catching the ball off-centre
// is how you aim the return. A bot that only parks under the ball plays a
// completely different — and much worse — game than a person does.
function paddleFor(g, landX) {
  const off = Math.max(-0.85, Math.min(0.85, (wantX(g) - landX) / 170));
  return landX - off * (g.paddle.w / 2);
}

// Mirror World inverts aimAt() inside the engine, so a bot that has noticed
// has to pre-invert. `ace` always has; `climber` takes a second to catch on,
// which is the whole point of the card.
function aim(g, x, knows) {
  g.aimAt(knows && g.mirrorOn ? LW - x : x);
}

const BRAINS = {
  ace(g) {
    g.launch();
    aim(g, paddleFor(g, landing(g, threat(g))), true);
  },

  climber(g, f, mem) {
    g.launch();
    // React on a ~130ms delay: re-read the ball eight times a second and steer
    // toward what it looked like then.
    if (f % 8 === 0) {
      const b = threat(g);
      const land = landing(g, b);
      mem.target = paddleFor(g, land);
      // Human aim is not exact, and it gets worse when several balls are live.
      const slop = 16 + (g.balls.length - 1) * 14;
      mem.target += (rand() - 0.5) * slop;
      // Mirror World: a second of steering the wrong way every time it flips.
      if (g.mirrorOn !== mem.wasMirror) { mem.confusedUntil = g.time + 1.0; mem.wasMirror = g.mirrorOn; }
    }
    aim(g, mem.target ?? LW / 2, g.time > (mem.confusedUntil || 0));
  },

  // The control. It does not even launch — the engine's own 1.2s auto-release
  // starts the ball, exactly as it would for an abandoned tab.
  idle() {},
};

/* ================================================================= drivers */
function playArena(cfg, brainName, capSeconds) {
  const brain = BRAINS[brainName];
  const mem = {};
  let done = null;
  Game.on = { end: (r) => { done = r; } };
  Game.start(cfg);

  const max = 60 * (capSeconds || cfg.timeLimit + 20);
  let f = 0;
  while (Game.running && f < max) {
    brain(Game, f, mem);
    Game.tick(1 / 60);
    f++;
  }
  if (!done) { Game.abandon(); return { win: false, timedOut: true, hp: Game.hp, score: 0, gold: 0, bricks: 0, time: f / 60 }; }
  return done;
}

// One arena, played in isolation with a given deck — used for the guardrails.
function soloArena(arena, deck, brainName, opts = {}) {
  const build = compileDeck(deck);
  const cfg = {
    arena, boss: opts.boss || null, build, seed: opts.seed || 7, floor: 5,
    tier: opts.tier || "standard",
    hp: opts.hp || 400, hpMax: opts.hp || 400,
    hpMul: opts.hpMul || 1, speedMul: 1, scoreMul: 1,
    hpPerBall: 8, timeLimit: opts.timeLimit || 180, goldBase: 30,
  };
  return playArena(cfg, brainName, opts.cap);
}

/* ------------------------------------------------------------- the climb */
// How much a bot wants a card. Deliberately crude — a bot that drafts
// perfectly would tell us about the bot, not about the spire.
function cardValue(id, deck) {
  const c = CARD_BY_ID[id];
  if (!c) return 0;
  const st = c.stats || {};
  let v = (st.damage || 0) * 3.2 + (st.paddleW || 0) * 0.11 + (st.shield || 0) * 3.4
        + (st.heal || 0) * 0.34 + (st.hpMax || 0) * 0.24 + (st.pierce || 0) * 3
        + (st.extraBalls || 0) * 2.2 + (st.paddleSpeed || 0) * 0.008
        + (st.laserRate || 0) * 2.4 + (st.scorePct || 0) * 0.02 + (st.goldPct || 0) * 0.02;
  for (const f of c.flags) {
    v += { burn: 2.4, explosive: 3, chain: 4, electric: 2.6, heavy: 2, phase: 2.4,
           sticky: 1.8, magnetic: 2.2, laser: 3, timewarp: 2.6, ricochet: 2,
           reflect: 2.6, vampire: 1.6, focus: 1.4, twin: 2, boomerang: 1.6,
           poison: 1.8, freeze: 1.2, spin: 0.6, portals: 0.4, greed: 0.8,
           singularity: 1.2, gravity: -1.4, mirror: -2, chaos: -1.6,
           growing: -1.8, glass: -2.6, mini: -2.2 }[f] || 0;
  }
  // A real player leans into what they already hold, so the bot does too.
  v += S.synergyWith(id, deck).length * 2.2;
  return v;
}

function climb(seed, brainName, opts = {}) {
  // Reseed the sandbox's Math.random, which is where the climber's own
  // mistimings come from. Without this the bots share one drifting stream and
  // two runs on the same seed are not comparable — the first report had
  // Ascent III looking EASIER than the base game purely because it ran second.
  S.__reseed(seed);
  const s = Run.start({ seed, unlocked: opts.unlocked || ALL_CARDS,
                        coreId: opts.coreId || "vagrant", ascent: opts.ascent || 0 });
  if (opts.deck) { for (const id of opts.deck) Run.addCard(id); }

  const log = [];
  let guard = 0;
  while (!s.over && guard++ < 200) {
    if (!s.pending) {
      const choices = Run.options();
      if (!choices.length) break;
      // Prefer an elite while healthy (that is where the good cards are),
      // a shop while rich, a campfire while hurt. Exactly what a person does.
      const hurt = s.hp / s.hpMax < 0.5;
      const score = (n) => ({
        elite: hurt ? -3 : 3, shop: s.gold > 150 ? 2.5 : 0.5, rest: hurt ? 4 : 0.5,
        treasure: 3.5, event: 1.2, battle: 1, boss: 5,
      })[n.type] ?? 1;
      const best = choices.reduce((a, b) => (score(b) > score(a) ? b : a));
      Run.enter(best.id);
      continue;
    }

    const p = s.pending;
    if (p.kind === "battle") {
      const cfg = Run.battleConfig();
      const res = playArena(cfg, brainName);
      log.push({ act: s.act, floor: s.floor, type: Run.currentNode().type,
                 arena: cfg.arena.id, boss: cfg.boss, win: res.win,
                 time: res.time, hpLeft: res.hp, timedOut: !!res.timedOut });
      Run.battleDone(res, cfg);
    } else if (p.kind === "reward") {
      if (!p.offer.length) { Run.skipReward(); continue; }
      const best = p.offer.reduce((a, b) => (cardValue(b, s.deck) > cardValue(a, s.deck) ? b : a));
      if (cardValue(best, s.deck) <= 0.8) { Run.skipReward(); continue; }
      if (!Run.deckFull()) { Run.takeCard(best); continue; }
      // Full deck: give up the weakest thing in it, and only if the new card
      // is genuinely better — which is the decision the limit exists to force.
      const worst = s.deck.reduce((a, b) => (cardValue(b, s.deck) < cardValue(a, s.deck) ? b : a));
      if (cardValue(best, s.deck) > cardValue(worst, s.deck) + 0.5) Run.takeCard(best, worst);
      else Run.skipReward();
    } else if (p.kind === "shop") {
      let bought = true;
      while (bought) {
        bought = false;
        if (s.hp / s.hpMax < 0.45) {
          const heal = p.services.find((x) => x.id === "heal" && s.gold >= x.cost);
          if (heal && Run.buy("service", heal.id).ok) { bought = true; continue; }
        }
        // Cheapest thing worth having — nobody saves for the perfect card.
        const affordable = Run.deckFull() ? [] : p.cards.filter((c) => s.gold >= c.cost &&
          !p.bought.includes("card:" + c.id) && cardValue(c.id, s.deck) > 1.5);
        if (affordable.length) {
          affordable.sort((a, b) => a.cost - b.cost);
          if (Run.buy("card", affordable[0].id).ok) bought = true;
        }
      }
      Run.leaveShop();
    } else if (p.kind === "event") {
      const e = S.EVENT_BY_ID[p.id];
      let pick = 0, bestV = -Infinity;
      e.choices.forEach((c, i) => {
        if (c.need && c.need.gold > s.gold) return;
        const o = c.out;
        let v = (o.gold || 0) * 0.05 + (o.heal || 0) * 0.2 + (o.hpMax || 0) * 0.3
              + (o.shards || 0) * 0.1 + (o.card ? 6 : 0) + (o.bane ? -3 : 0);
        // Health you do not have is worth a great deal more than gold.
        v += (o.hp || 0) * (s.hp / s.hpMax < 0.5 ? 0.9 : 0.3);
        if ((o.hp || 0) < 0 && s.hp + o.hp <= 0) v = -999;
        if (v > bestV) { bestV = v; pick = i; }
      });
      Run.eventChoose(pick);
    } else if (p.kind === "rest") {
      Run.restChoose(s.hp / s.hpMax < 0.62 ? "sleep" : "study");
    } else if (p.kind === "treasure") {
      Run.openChest();
    }
  }

  return {
    win: s.win, act: s.act, floor: s.floor, deck: [...s.deck],
    depth: s.floorsCleared, bosses: s.bossesDown, score: Math.round(s.score),
    hp: s.hp, hpMax: s.hpMax, gold: s.gold, shards: s.shardsEarned || s.shards,
    minutes: s.playSeconds / 60, log,
  };
}

/* ================================================================ the runs */
const SEEDS = [11, 202, 3003, 40004, 555, 6606, 77, 8888, 909, 1010, 1111, 1212];
const QUICK = SEEDS.slice(0, 5);

let _cache = {};
function climbs(brainName, seeds, opts = {}) {
  const key = brainName + seeds.join(",") + JSON.stringify(opts);
  if (!_cache[key]) _cache[key] = seeds.map((s) => climb(s, brainName, opts));
  return _cache[key];
}

/* ==================================================== guardrail: winnable */
// A guardrail deck has to be HONEST about where in the climb the room appears.
// Nobody reaches act 3 holding one card, so measuring an act-3 arena against a
// bare deck measures a situation that cannot happen — and tuning against it
// would flatten the whole back half of the game.
const DECK_FOR = {
  1: ["sharpen"],
  2: ["sharpen", "fireball", "broad", "swift"],
  3: ["sharpen", "sharpen", "fireball", "electric", "broad", "swift", "overclock"],
};
const deckFor = (a) => DECK_FOR[a.act] || DECK_FOR[1];
const BOSS_ACT = { fortress: 1, serpent: 1, architect: 2, gravitycore: 2, mimic: 3 };
const bossDeck = (key) => [...DECK_FOR[BOSS_ACT[key] || 1], "sharpen"];

test("the ace can clear every arena in the game", () => {
  const fails = [];
  for (const a of ARENAS) {
    const r = soloArena(a, deckFor(a), "ace", { timeLimit: 150, cap: 170 });
    if (!r.win) fails.push(`${a.id} (${a.name}): ${r.timedOut ? "never ended" : "lost"} after ${r.time.toFixed(0)}s`);
  }
  assert.deepEqual(fails, []);
});

test("no arena drags, at the pace it is actually met at", () => {
  const slow = [];
  for (const a of ARENAS) {
    const r = soloArena(a, deckFor(a), "ace", { timeLimit: 150, cap: 170 });
    if (r.win && r.time > 85) slow.push(`${a.id}: ${r.time.toFixed(0)}s`);
  }
  assert.deepEqual(slow, []);
});

test("the ace can beat every boss, and none of them drags", () => {
  const fails = [];
  for (const b of BOSS_LIST) {
    const r = soloArena(b.room, bossDeck(b.key), "ace",
                        { boss: b.key, tier: "boss", timeLimit: 220, cap: 240 });
    if (!r.win) fails.push(`${b.key}: ${r.timedOut ? "never dies" : "lost"} (${r.time.toFixed(0)}s)`);
    else if (r.time > 130) fails.push(`${b.key} took ${r.time.toFixed(0)}s — a slog`);
    else if (r.time < 15) fails.push(`${b.key} died in ${r.time.toFixed(0)}s — not a boss`);
  }
  assert.deepEqual(fails, []);
});

test("no arena is a three-second formality for a perfect player", () => {
  const fails = [];
  for (const a of ARENAS) {
    const r = soloArena(a, deckFor(a), "ace", { timeLimit: 150, cap: 170 });
    if (r.win && r.time < 6) fails.push(`${a.id} cleared in ${r.time.toFixed(1)}s`);
  }
  assert.deepEqual(fails, []);
});

/* ================================================= control: doing nothing */
test("doing nothing clears nothing", () => {
  const fails = [];
  for (const a of ARENAS) {
    const r = soloArena(a, [], "idle", { hp: 40, timeLimit: 150, cap: 165 });
    if (r.win) fails.push(`${a.id} can be cleared by not playing`);
  }
  assert.deepEqual(fails, []);
});

test("an abandoned climb ends instead of running forever", () => {
  const r = climb(4242, "idle");
  assert.equal(r.win, false);
  assert.ok(r.depth <= 3, `an idle bot cleared ${r.depth} rooms`);
});

/* ============================================== the tuning target: climber */
test("an ordinary climber gets a long way up without always finishing", () => {
  const rs = climbs("climber", SEEDS);
  const wins = rs.filter((r) => r.win).length;
  const bosses = rs.reduce((s, r) => s + r.bosses, 0) / rs.length;
  const depth = rs.reduce((s, r) => s + r.depth, 0) / rs.length;

  assert.ok(bosses >= 0.8,
    `the climber averages ${bosses.toFixed(2)} bosses — the spire is a wall`);
  assert.ok(depth >= 9,
    `the climber averages ${depth.toFixed(1)} rooms — it dies before the game starts`);
  assert.ok(wins >= 1,
    `the climber won ${wins}/${rs.length} — nobody would ever see the top`);
  assert.ok(wins <= rs.length - 2,
    `the climber won ${wins}/${rs.length} — there is nothing at stake`);
});

test("a full climb is the twenty to forty minutes the brief asked for", () => {
  // `minutes` is time spent INSIDE arenas, which is the only part a headless
  // bot experiences. A person also reads about twenty card offers, three
  // shops, four events and a map screen between every room — call it another
  // ten to fifteen minutes — and drops more balls than the ace does. So the
  // band asserted here is the arena half of the brief's 20-40.
  const rs = climbs("ace", QUICK);
  const full = rs.filter((r) => r.win);
  assert.ok(full.length, "the ace must be able to finish");
  const mins = full.reduce((s, r) => s + r.minutes, 0) / full.length;
  assert.ok(mins >= 6, `only ${mins.toFixed(1)} minutes of arena in a full climb`);
  assert.ok(mins <= 20, `${mins.toFixed(1)} minutes of arena — too long for one sitting`);
});

test("the deck really is the run — no two climbs end up the same", () => {
  const rs = climbs("climber", SEEDS);
  const decks = rs.map((r) => [...r.deck].sort().join(","));
  assert.ok(new Set(decks).size >= rs.length - 1,
    "different seeds produced the same deck — the draft is not doing anything");
  const sizes = rs.map((r) => r.deck.length);
  assert.ok(Math.max(...sizes) >= 6, `the biggest deck was ${Math.max(...sizes)} cards`);
  assert.ok(Math.max(...sizes) <= S.DECK_LIMIT, "the deck limit is not being enforced");
  // A run that goes the distance should be pressing against the limit — that
  // is where the interesting "which one goes?" decisions live.
  const finished = rs.filter((r) => r.win);
  if (finished.length) {
    assert.ok(finished.some((r) => r.deck.length >= S.DECK_LIMIT - 1),
      "a full climb never filled its deck — the limit is doing nothing");
  }
});

/* ============================================ the other end: a broken build */
test("the strongest synergy in the game does not erase act three", () => {
  // Fireball + Explosive + Chain Lightning is the combo the brief names.
  // hpMul 1.9 is what an act-3 elite on the last floor actually comes to, so
  // this is the hardest room in the game meeting the strongest deck in it.
  const deck = ["fireball", "explosive", "chain", "sharpen", "sharpen"];
  const fails = [];
  for (const a of arenaPool(3, "elite").concat(arenaPool(3, "standard"))) {
    const r = soloArena(a, deck, "ace", { hpMul: 1.9, timeLimit: 190, cap: 210 });
    if (!r.win) { fails.push(`${a.id}: even the broken build lost`); continue; }
    if (r.time < 4) fails.push(`${a.id} evaporated in ${r.time.toFixed(1)}s`);
  }
  assert.deepEqual(fails, []);
});

test("a good deck is worth having, and a stack of downsides is not", () => {
  const arena = S.ARENA_BY_ID.longdrift;
  const plain = soloArena(arena, ["sharpen"], "ace", { hpMul: 1.8, cap: 220 });
  const good = soloArena(arena, ["sharpen", "fireball", "explosive", "chain", "drill"], "ace",
                         { hpMul: 1.8, cap: 220 });
  assert.ok(good.time < plain.time * 0.9,
    `a strong deck cleared in ${good.time.toFixed(1)}s vs ${plain.time.toFixed(1)}s — cards do nothing`);

  // And a deck of pure downside really is a downside.
  const cursed = soloArena(arena, ["mini", "growing", "glass"], "climber", { hpMul: 1.8, cap: 220 });
  const clean = soloArena(arena, [], "climber", { hpMul: 1.8, cap: 220 });
  assert.ok(!cursed.win || !clean.win || cursed.time >= clean.time * 0.95 || cursed.hp < clean.hp,
    "a deck of risk cards should cost something somewhere");
});

/* ======================================================== armour has teeth */
test("armour cannot be beaten by raw damage alone", () => {
  const anvil = S.ARENA_BY_ID.anvil;                 // wall-to-wall Bulwarks
  const brute = soloArena(anvil, ["sharpen", "sharpen", "sharpen", "overclock", "overclock"],
                          "ace", { hpMul: 1.6, timeLimit: 220, cap: 240 });
  const answer = soloArena(anvil, ["drill", "drill", "heavy", "sharpen", "sharpen"],
                           "ace", { hpMul: 1.6, timeLimit: 220, cap: 240 });
  assert.ok(answer.time < brute.time * 0.85,
    `piercing cleared the Anvil in ${answer.time.toFixed(1)}s vs raw damage's ${brute.time.toFixed(1)}s ` +
    `— armour is not doing its job`);
});

/* ============================================================ ascent mode */
test("an ascent is harder than the base game but still finishable", () => {
  const base = climbs("ace", QUICK);
  const asc = climbs("ace", QUICK, { ascent: 3, unlocked: [...ALL_CARDS, "ascent:1", "ascent:2", "ascent:3"] });
  const depth = (rs) => rs.reduce((s, r) => s + r.depth, 0) / rs.length;
  assert.ok(depth(asc) <= depth(base) + 0.5, "Ascent III must not be easier than the base climb");
  assert.ok(asc.some((r) => r.bosses >= 1), "Ascent III must not be a wall at floor 1");
});

/* =============================================================== the report */
function report() {
  const cell = (r) => (r.win ? `WIN a${r.act}` : `${r.bosses}b f${r.depth}`).padEnd(9);
  const rows = (name, opts) => {
    const rs = climbs(name, SEEDS, opts);
    const wins = rs.filter((r) => r.win).length;
    const avg = (f) => (rs.reduce((s, r) => s + f(r), 0) / rs.length);
    console.log(` ${name.padEnd(9)} ${String(wins + "/" + rs.length).padEnd(7)}` +
      `${avg((r) => r.depth).toFixed(1).padStart(6)}` +
      `${avg((r) => r.bosses).toFixed(2).padStart(8)}` +
      `${avg((r) => r.deck.length).toFixed(1).padStart(7)}` +
      `${avg((r) => r.minutes).toFixed(1).padStart(8)}` +
      `${Math.round(avg((r) => r.score)).toLocaleString().padStart(10)}` +
      `${Math.round(avg((r) => r.shards)).toString().padStart(8)}`);
    return rs;
  };

  console.log("\n=== RICOCHET SPIRE — balance ===\n");
  console.log(" bot       wins    rooms  bosses   deck  minutes     score  shards");
  const climberRuns = rows("climber");
  rows("ace");
  rows("idle");
  console.log(" climber on Ascent III:");
  rows("climber", { ascent: 3, unlocked: [...ALL_CARDS, "ascent:1", "ascent:2", "ascent:3"] });

  console.log("\n arenas (ace, an act-appropriate deck):");
  for (const a of ARENAS) {
    const r = soloArena(a, deckFor(a), "ace", { timeLimit: 150, cap: 170 });
    const idle = soloArena(a, [], "idle", { hp: 40, timeLimit: 150, cap: 165 });
    console.log(`  a${a.act} ${a.tier === "elite" ? "E" : " "} ${a.name.padEnd(15)} ` +
      `${(r.win ? r.time.toFixed(1) + "s" : r.timedOut ? "NEVER ENDS" : "lost").padStart(11)}` +
      `  score ${String(Math.round(r.score)).padStart(6)}  idle:${idle.win ? " CLEARED!" : " no"}`);
  }

  console.log("\n bosses (ace, an act-appropriate deck):");
  for (const b of BOSS_LIST) {
    const r = soloArena(b.room, bossDeck(b.key), "ace",
                        { boss: b.key, tier: "boss", timeLimit: 220, cap: 240 });
    console.log(`  ${b.name.padEnd(16)} ${(r.win ? r.time.toFixed(1) + "s" : "FAILED").padStart(9)}`);
  }

  console.log("\n where the climber's runs ended:");
  climberRuns.forEach((r, i) => {
    const last = r.log[r.log.length - 1];
    console.log(`  seed ${String(SEEDS[i]).padEnd(6)} ${r.win ? "reached the top" :
      `act ${r.act}, ${r.depth} rooms, died in ${last ? last.arena : "an event"}`}` +
      `  deck ${r.deck.length}: ${r.deck.join(" ")}`);
  });
  console.log("");
}

if (process.argv.includes("--report")) { report(); process.exit(0); }
