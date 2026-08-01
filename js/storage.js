// Ricochet Spire — saved progress and family sync.
//
// PROGRESS is a named object rather than two inline callbacks, because
// GK.createStorage keeps them in a closure where a test cannot reach them —
// and `merge` is the one function in the whole game that can permanently
// destroy somebody's save. tests/storage.test.js calls it directly.
//
// Three merge rules here are worth knowing before changing anything:
//
//   1. SHARDS are spendable, so a single balance merged with max() would
//      resurrect everything you had bought. Both halves of the ledger are
//      monotonic counters and the balance is derived.
//   2. UNLOCKS merge as a UNION, never as a max. Buying The Arsonist on the
//      iPad must not be undone by syncing a phone that was offline.
//   3. THE DAILY is not a high score. A plain max() would pin yesterday's
//      good run in place forever, so the later DATE wins and the score is only
//      compared when the dates are equal.

const PROGRESS = {
  blank: () => ({
    shardsEarned: 0,        // monotonic
    shardsSpent: 0,         // monotonic
    unlocked: [],           // Archive purchases — union merged
    seen: [],               // every card ever drafted — union merged, the collection
    bosses: [],             // boss keys beaten — union merged

    bestScore: 0,           // the leaderboard headline
    bestDepth: 0,           // deepest floor reached, as act*12 + floor
    runs: 0,                // monotonic: climbs STARTED
    runsDone: 0,            // monotonic: climbs FINISHED — the saved-run gate
    wins: 0,
    ascentBest: -1,         // highest ascent cleared; -1 means none

    daily: { date: "", score: 0, depth: 0, win: false },
    dailyPlays: 0,
    dailyWins: 0,

    run: null,              // the mid-climb save; see runIsStale below
    updated: 0,
  }),

  merge: (a, b) => {
    const uni = (x, y) => [...new Set([...(x || []), ...(y || [])])];

    // Later date wins outright; same day is a genuine tie-break on score.
    const da = a.daily || {}, db = b.daily || {};
    let daily;
    if ((da.date || "") === (db.date || "")) {
      daily = (db.score || 0) > (da.score || 0) ? db : da;
      if (!daily.date) daily = { date: "", score: 0, depth: 0, win: false };
    } else {
      daily = (db.date || "") > (da.date || "") ? db : da;
    }

    const runs = Math.max(a.runs || 0, b.runs || 0);
    const runsDone = Math.max(a.runsDone || 0, b.runsDone || 0);
    // Keep whichever saved climb belongs to a run nobody has FINISHED yet.
    // A climb gets serial = runsDone + 1 when it starts; finishing it anywhere
    // bumps runsDone to that number, so the stale copy on the other device
    // stops qualifying and is dropped rather than resumed.
    //
    // Gating on climbs STARTED instead was the first attempt and it is off by
    // one: the serial equals that counter the moment the run begins, so a
    // strictly-greater test threw the save away immediately and "resume" never
    // once appeared.
    const pickRun = (r) => (r && r.serial && r.serial > runsDone ? r : null);
    const ra = pickRun(a.run), rb = pickRun(b.run);
    const run = (!ra) ? rb : (!rb) ? ra
      : ((rb.visited || []).length > (ra.visited || []).length ? rb : ra);

    return {
      // Spread first so a field a newer build added survives an older client.
      ...a, ...b,
      shardsEarned: Math.max(a.shardsEarned || 0, b.shardsEarned || 0),
      shardsSpent: Math.max(a.shardsSpent || 0, b.shardsSpent || 0),
      unlocked: uni(a.unlocked, b.unlocked),
      seen: uni(a.seen, b.seen),
      bosses: uni(a.bosses, b.bosses),
      bestScore: Math.max(a.bestScore || 0, b.bestScore || 0),
      bestDepth: Math.max(a.bestDepth || 0, b.bestDepth || 0),
      runs, runsDone,
      wins: Math.max(a.wins || 0, b.wins || 0),
      ascentBest: Math.max(a.ascentBest ?? -1, b.ascentBest ?? -1),
      dailyPlays: Math.max(a.dailyPlays || 0, b.dailyPlays || 0),
      dailyWins: Math.max(a.dailyWins || 0, b.dailyWins || 0),
      daily,
      run,
    };
  },
};

const Storage = GK.createStorage({
  prefix: "rs",
  collection: "ricochetspire",
  firebaseConfig: window.FIREBASE_CONFIG,
  blankProgress: PROGRESS.blank,
  mergeProgress: PROGRESS.merge,
});

Object.assign(Storage, {
  PROGRESS,

  shards(p) { return Math.max(0, (p.shardsEarned || 0) - (p.shardsSpent || 0)); },

  isUnlocked(p, id) { return (p.unlocked || []).includes(id); },

  // Returns { ok, why } so the UI can say WHY rather than just refusing.
  buyUnlock(profileId, id) {
    const p = this.getProgress(profileId);
    const u = UNLOCK_BY_ID[id];
    if (!u) return { ok: false, why: "unknown" };
    if (this.isUnlocked(p, id)) return { ok: false, why: "owned" };
    if (u.needs && !this.isUnlocked(p, u.needs)) return { ok: false, why: "locked" };
    if (this.shards(p) < u.shards) return { ok: false, why: "shards" };
    p.shardsSpent += u.shards;
    p.unlocked = [...(p.unlocked || []), id];
    p.updated = Date.now();
    this.saveProgress(profileId, p);
    return { ok: true, progress: p };
  },

  // The highest ascent this profile may choose: one above the best cleared,
  // and never above what has been bought.
  maxAscent(p) {
    let owned = 0;
    for (let i = 1; i <= 3; i++) if (this.isUnlocked(p, "ascent:" + i)) owned = i;
    return Math.min(owned, (p.ascentBest ?? -1) + 1);
  },

  /* ------------------------------------------------------------- the climb */
  // A run in progress. `serial` is what makes a stale copy on another device
  // detectable — see the merge above.
  saveRun(profileId, snapshot) {
    const p = this.getProgress(profileId);
    if (snapshot) snapshot.serial = snapshot.serial || (p.runsDone || 0) + 1;
    p.run = snapshot;
    p.updated = Date.now();
    this.saveProgress(profileId, p);
    return p;
  },

  loadRun(p) {
    const r = p && p.run;
    if (!r || !r.serial || r.serial <= (p.runsDone || 0)) return null;
    return r;
  },

  beginRun(profileId) {
    const p = this.getProgress(profileId);
    p.runs = (p.runs || 0) + 1;
    p.updated = Date.now();
    this.saveProgress(profileId, p);
    return (p.runsDone || 0) + 1;      // becomes this climb's serial
  },

  // Called once when a climb ends, win or lose.
  recordRun(profileId, out) {
    const p = this.getProgress(profileId);
    p.run = null;
    p.runsDone = (p.runsDone || 0) + 1;      // retires this climb's serial
    p.shardsEarned = (p.shardsEarned || 0) + (out.shards || 0);
    p.bestScore = Math.max(p.bestScore || 0, out.score || 0);
    p.bestDepth = Math.max(p.bestDepth || 0, out.depth || 0);
    if (out.win) {
      p.wins = (p.wins || 0) + 1;
      p.ascentBest = Math.max(p.ascentBest ?? -1, out.ascent || 0);
    }
    p.seen = [...new Set([...(p.seen || []), ...(out.deck || [])])];
    if (out.bossesDown && out.bossKeys) {
      p.bosses = [...new Set([...(p.bosses || []), ...out.bossKeys])];
    }
    if (out.mode === "daily") {
      p.dailyPlays = (p.dailyPlays || 0) + 1;
      if (out.win) p.dailyWins = (p.dailyWins || 0) + 1;
      const cur = p.daily || { date: "", score: 0 };
      if (out.date > (cur.date || "") ||
          (out.date === cur.date && (out.score || 0) > (cur.score || 0))) {
        p.daily = { date: out.date, score: out.score || 0, depth: out.depth || 0, win: !!out.win };
      }
    }
    p.updated = Date.now();
    this.saveProgress(profileId, p);
    return p;
  },

  dailyDone(p, date) { return (p.daily && p.daily.date) === date; },

  collectionPct(p) {
    const total = CARDS.length;
    return total ? Math.round(((p.seen || []).length / total) * 100) : 0;
  },
});

if (typeof module !== "undefined") module.exports = { PROGRESS, Storage };
