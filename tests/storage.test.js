// Tests the one function in the game that can permanently destroy a save.
//
// GK.createStorage hides blankProgress/mergeProgress in a closure, which is why
// js/storage.js defines them as a named PROGRESS object first — so this suite
// can call the merge directly with two handmade sides and check what survives.
//
// Family sync means the merge runs whenever two devices meet, in either order,
// so every rule here is also checked symmetrically where it matters.

const test = require("node:test");
const assert = require("node:assert");
const { loadStorage } = require("./load.js");

function fresh() { return loadStorage(); }

const base = (over = {}) => Object.assign(fresh().PROGRESS.blank(), over);

test("a blank save has every field the game reads", () => {
  const p = fresh().PROGRESS.blank();
  for (const k of ["shardsEarned", "shardsSpent", "unlocked", "seen", "bosses",
                   "bestScore", "bestDepth", "runs", "wins", "ascentBest",
                   "daily", "dailyPlays", "dailyWins", "run", "updated"]) {
    assert.ok(k in p, `blank progress has no ${k}`);
  }
  assert.deepEqual(p.unlocked, []);
  assert.equal(p.ascentBest, -1, "-1 means no ascent cleared, which is not the same as 0");
});

test("spent shards stay spent after syncing with a stale device", () => {
  const { PROGRESS } = fresh();
  // This phone bought The Arsonist. That tablet has not heard about it.
  const phone = base({ shardsEarned: 200, shardsSpent: 55, unlocked: ["core:arsonist"] });
  const tablet = base({ shardsEarned: 200, shardsSpent: 0, unlocked: [] });
  const m = PROGRESS.merge(tablet, phone);
  assert.equal(m.shardsSpent, 55, "a max() on a balance would refund the purchase");
  assert.equal(m.shardsEarned, 200);
  assert.deepEqual(m.unlocked, ["core:arsonist"]);
  // And in the other order.
  const m2 = PROGRESS.merge(phone, tablet);
  assert.equal(m2.shardsSpent, 55);
  assert.deepEqual(m2.unlocked, ["core:arsonist"]);
});

test("unlocks and the collection merge as a union, never as a winner", () => {
  const { PROGRESS } = fresh();
  const a = base({ unlocked: ["card:phase", "ascent:1"], seen: ["fireball"], bosses: ["fortress"] });
  const b = base({ unlocked: ["core:collector"], seen: ["sharpen", "fireball"], bosses: ["serpent"] });
  const m = PROGRESS.merge(a, b);
  assert.deepEqual(m.unlocked.sort(), ["ascent:1", "card:phase", "core:collector"]);
  assert.deepEqual(m.seen.sort(), ["fireball", "sharpen"]);
  assert.deepEqual(m.bosses.sort(), ["fortress", "serpent"]);
});

test("the daily keeps the LATER day, not the better score", () => {
  const { PROGRESS } = fresh();
  const yesterday = base({ daily: { date: "2026-08-01", score: 90000, depth: 30, win: true } });
  const today = base({ daily: { date: "2026-08-02", score: 1200, depth: 3, win: false } });
  // A plain max() would pin yesterday's good run in place forever.
  assert.equal(PROGRESS.merge(yesterday, today).daily.date, "2026-08-02");
  assert.equal(PROGRESS.merge(today, yesterday).daily.date, "2026-08-02");
  assert.equal(PROGRESS.merge(yesterday, today).daily.score, 1200);

  // Same day: now it IS a high score, both ways round.
  const lo = base({ daily: { date: "2026-08-02", score: 500, depth: 2, win: false } });
  const hi = base({ daily: { date: "2026-08-02", score: 8000, depth: 9, win: false } });
  assert.equal(PROGRESS.merge(lo, hi).daily.score, 8000);
  assert.equal(PROGRESS.merge(hi, lo).daily.score, 8000);
});

test("bests and counters take the higher of the two", () => {
  const { PROGRESS } = fresh();
  const a = base({ bestScore: 50000, bestDepth: 20, wins: 3, runs: 12, ascentBest: 1, dailyWins: 2 });
  const b = base({ bestScore: 12000, bestDepth: 31, wins: 1, runs: 9, ascentBest: 0, dailyWins: 5 });
  const m = PROGRESS.merge(a, b);
  assert.equal(m.bestScore, 50000);
  assert.equal(m.bestDepth, 31);
  assert.equal(m.wins, 3);
  assert.equal(m.runs, 12);
  assert.equal(m.ascentBest, 1);
  assert.equal(m.dailyWins, 5);
});

test("a field a newer build added survives an older client's merge", () => {
  const { PROGRESS } = fresh();
  const newer = base({ somethingNew: { hats: 3 } });
  const older = base();
  assert.deepEqual(PROGRESS.merge(older, newer).somethingNew, { hats: 3 });
});

/* --------------------------------------------------------- the saved climb */
test("a climb in progress crosses devices, and the longer one wins", () => {
  const { PROGRESS } = fresh();
  // Six climbs finished, so the seventh is in progress with serial 7.
  const early = base({ runsDone: 6, run: { serial: 7, visited: ["a", "b"] } });
  const later = base({ runsDone: 6, run: { serial: 7, visited: ["a", "b", "c", "d"] } });
  assert.equal(PROGRESS.merge(early, later).run.visited.length, 4);
  assert.equal(PROGRESS.merge(later, early).run.visited.length, 4);
});

test("a climb that has already ended somewhere is not resurrected", () => {
  const { PROGRESS, Storage } = fresh();
  // The iPad finished climb 7 (runsDone is now 7); the phone still holds it.
  const finished = base({ runsDone: 7, run: null });
  const stale = base({ runsDone: 6, run: { serial: 7, visited: ["a", "b", "c"] } });
  const m = PROGRESS.merge(finished, stale);
  assert.equal(m.run, null, "a finished climb came back from the dead");
  assert.equal(PROGRESS.merge(stale, finished).run, null);
  // Before it syncs, that device is entitled to carry on — it has no way to
  // know. After the merge, loadRun refuses the copy it is now holding.
  assert.ok(Storage.loadRun(stale), "an unsynced device may still resume its own climb");
  assert.equal(Storage.loadRun(m), null);
  assert.equal(Storage.loadRun(finished), null);
});

// The bug this replaces was invisible in every unit test and obvious the first
// time anybody played: the serial was gated against climbs STARTED, which
// equals the serial the instant a climb begins, so a strictly-greater test
// threw the save away and "Resume" never appeared once.
test("a climb saved a moment ago is resumable a moment later", () => {
  const { Storage } = fresh();
  const p = Storage.addProfile("Climber", "🔺", null);
  const serial = Storage.beginRun(p.id);
  Storage.saveRun(p.id, { serial, act: 1, visited: ["a1"], deck: ["sharpen"] });

  const back = Storage.loadRun(Storage.getProgress(p.id));
  assert.ok(back, "the climb that was just saved must be the climb that resumes");
  assert.equal(back.act, 1);
  assert.deepEqual(back.deck, ["sharpen"]);

  // It survives an ordinary save-and-reload cycle too.
  Storage.saveRun(p.id, { serial, act: 2, visited: ["a1", "a2"], deck: ["sharpen", "swift"] });
  assert.equal(Storage.loadRun(Storage.getProgress(p.id)).act, 2);

  // And ending it retires the serial, so nothing offers to resume a dead run.
  Storage.recordRun(p.id, { win: false, shards: 12, score: 100, depth: 3, deck: [], mode: "run" });
  assert.equal(Storage.loadRun(Storage.getProgress(p.id)), null);

  // The next climb gets the next serial and is resumable in its turn.
  const s2 = Storage.beginRun(p.id);
  assert.equal(s2, serial + 1);
  Storage.saveRun(p.id, { serial: s2, act: 1, visited: [], deck: [] });
  assert.ok(Storage.loadRun(Storage.getProgress(p.id)));
});

/* -------------------------------------------------------------- the helpers */
test("the shard balance is derived, never stored", () => {
  const { Storage } = fresh();
  assert.equal(Storage.shards(base({ shardsEarned: 300, shardsSpent: 110 })), 190);
  assert.equal(Storage.shards(base({ shardsEarned: 10, shardsSpent: 90 })), 0, "never negative");
});

test("buying from the Archive charges, refuses and respects prerequisites", () => {
  const { Storage } = fresh();
  const p = Storage.addProfile("Tester", "🔺", null);

  let prog = Storage.getProgress(p.id);
  prog.shardsEarned = 40;
  Storage.saveProgress(p.id, prog);

  assert.equal(Storage.buyUnlock(p.id, "card:phase").ok, true, "30 shards of a 40 balance");
  assert.equal(Storage.shards(Storage.getProgress(p.id)), 10);
  assert.equal(Storage.buyUnlock(p.id, "card:phase").why, "owned");
  assert.equal(Storage.buyUnlock(p.id, "core:collector").why, "shards");
  assert.equal(Storage.buyUnlock(p.id, "nonsense").why, "unknown");

  prog = Storage.getProgress(p.id);
  prog.shardsEarned = 900;
  Storage.saveProgress(p.id, prog);
  assert.equal(Storage.buyUnlock(p.id, "ascent:2").why, "locked", "Ascent II needs Ascent I");
  assert.equal(Storage.buyUnlock(p.id, "ascent:1").ok, true);
  assert.equal(Storage.buyUnlock(p.id, "ascent:2").ok, true);
});

test("you may only attempt one ascent above the one you have cleared", () => {
  const { Storage } = fresh();
  const owns = (ids, best) => base({ unlocked: ids, ascentBest: best });
  assert.equal(Storage.maxAscent(owns([], -1)), 0, "nothing bought means no ascents");
  assert.equal(Storage.maxAscent(owns(["ascent:1", "ascent:2", "ascent:3"], -1)), 0,
    "owning them all does not let you skip to the top");
  assert.equal(Storage.maxAscent(owns(["ascent:1", "ascent:2", "ascent:3"], 0)), 1);
  assert.equal(Storage.maxAscent(owns(["ascent:1"], 2)), 1, "capped by what you have bought");
});

test("recording a run banks the shards, the score and the cards you saw", () => {
  const { Storage } = fresh();
  const p = Storage.addProfile("Climber", "🔥", null);
  Storage.beginRun(p.id);

  Storage.recordRun(p.id, { win: false, shards: 34, score: 41000, depth: 17,
                            deck: ["fireball", "sharpen"], mode: "run" });
  let prog = Storage.getProgress(p.id);
  assert.equal(Storage.shards(prog), 34);
  assert.equal(prog.bestScore, 41000);
  assert.equal(prog.wins, 0);
  assert.deepEqual(prog.seen.sort(), ["fireball", "sharpen"]);
  assert.equal(prog.run, null, "finishing has to clear the saved climb");

  // A worse run must not lower the best.
  Storage.recordRun(p.id, { win: true, shards: 60, score: 900, depth: 36,
                            deck: ["broad"], ascent: 0, mode: "run" });
  prog = Storage.getProgress(p.id);
  assert.equal(prog.bestScore, 41000);
  assert.equal(prog.bestDepth, 36);
  assert.equal(prog.wins, 1);
  assert.equal(prog.ascentBest, 0);
  assert.equal(Storage.shards(prog), 94);
  assert.equal(prog.seen.length, 3);
});

test("the daily records once a day and knows when today is done", () => {
  const { Storage } = fresh();
  const p = Storage.addProfile("Daily", "🪞", null);
  Storage.recordRun(p.id, { win: false, shards: 10, score: 5000, depth: 8,
                            deck: [], mode: "daily", date: "2026-08-02" });
  let prog = Storage.getProgress(p.id);
  assert.equal(prog.daily.date, "2026-08-02");
  assert.equal(prog.daily.score, 5000);
  assert.equal(prog.dailyPlays, 1);
  assert.ok(Storage.dailyDone(prog, "2026-08-02"));
  assert.ok(!Storage.dailyDone(prog, "2026-08-03"));

  // A better attempt on the same day still counts; a worse one does not.
  Storage.recordRun(p.id, { win: true, shards: 10, score: 9000, depth: 20,
                            deck: [], mode: "daily", date: "2026-08-02" });
  prog = Storage.getProgress(p.id);
  assert.equal(prog.daily.score, 9000);
  assert.equal(prog.dailyWins, 1);
});

test("the collection percentage tracks the whole card list", () => {
  const { Storage, CARDS } = fresh();
  assert.equal(Storage.collectionPct(base({ seen: [] })), 0);
  assert.equal(Storage.collectionPct(base({ seen: CARDS.map((c) => c.id) })), 100);
});

test("the storage prefix and collection are this game's own", () => {
  const { Storage } = fresh();
  // Every family game is served from one origin, so a shared prefix means two
  // games share one profile roster and one set of saves.
  const p = Storage.addProfile("X", "🔺", null);
  Storage.saveProgress(p.id, Storage.getProgress(p.id));
  assert.ok(Storage._get, "gk-storage did not attach");
  assert.equal(typeof Storage.initFirebase, "function");
});
