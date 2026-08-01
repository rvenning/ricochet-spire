// Ricochet Spire — the bosses.
//
// The engine knows nothing about any individual boss. It calls five methods —
// update, hitTest, partAt, onHit, splash — and reads `dead`. Everything a boss
// IS lives in this file, so a new one is one entry and no engine change.
//
// A boss is a set of PARTS: rectangles in logical coordinates that the ball
// collides with. `makeBoss` supplies the geometry and the damage plumbing;
// each boss supplies only what makes it itself — how its parts move, what
// happens when one is hit, and when it changes phase.
//
// Every boss carries its own ROOM (an arena-shaped object), because a boss
// fight wants a layout built around what that boss does — cover for the
// Fortress, a clear lane for the Serpent — rather than a generic empty box.
//
// No randomness anywhere: movement is a function of elapsed time and phase, so
// a boss fight replays identically for the same seed and the balance bot's
// clear times mean something.

const BOSSES = {};

// ---------------------------------------------------------------- the base
function makeBoss(spec, g, hpMul) {
  const boss = {
    key: spec.key,
    name: spec.name,
    icon: spec.icon,
    blurb: spec.blurb,
    game: g,
    t: 0,
    phase: 1,
    phases: spec.phases || 2,
    dead: false,
    parts: [],
    hpMul,

    // A part is a rectangle with hit points. `core: true` means it counts
    // toward the health bar and toward the boss dying; anything else is armour,
    // legs, decoration — destructible or not, but never the objective.
    addPart(p) {
      const part = Object.assign({
        w: 44, h: 24, hp: 10, armour: 0, core: false, gone: false,
        color: "#ff3d92", glow: "#ff8ec1", glyph: "", pass: false,
      }, p);
      part.maxHp = part.hp;
      this.parts.push(part);
      return part;
    },

    livingParts() { return this.parts.filter((p) => !p.gone); },

    hpFrac() {
      let hp = 0, max = 0;
      for (const p of this.parts) { if (!p.core) continue; hp += Math.max(0, p.hp); max += p.maxHp; }
      return max > 0 ? hp / max : 0;
    },

    // Deepest overlapping part wins, exactly as bricks resolve, so a ball in a
    // corner between two plates picks the surface it is most inside.
    hitTest(ball) {
      let best = null, bestHit = null;
      for (const p of this.parts) {
        if (p.gone || p.pass) continue;
        const hit = Physics.circleRect(ball.x, ball.y, ball.r, p.x, p.y, p.w, p.h);
        if (hit && (!bestHit || hit.depth > bestHit.depth)) { best = p; bestHit = hit; }
      }
      // Pass-through parts (the Serpent's body) take damage without turning
      // the ball around — checked separately so they never block a real hit.
      if (!best) {
        for (const p of this.parts) {
          if (p.gone || !p.pass) continue;
          if (Physics.circleRect(ball.x, ball.y, ball.r, p.x, p.y, p.w, p.h)) {
            this.onHit(p, ball, 1);
            return null;
          }
        }
        return null;
      }
      return { part: best, nx: bestHit.nx, ny: bestHit.ny, depth: bestHit.depth };
    },

    partAt(x, y) {
      for (const p of this.parts) {
        if (p.gone) continue;
        if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return p;
      }
      return null;
    },

    splash(cx, cy, rad, dmg) {
      for (const p of this.parts) {
        if (p.gone) continue;
        const px = p.x + p.w / 2, py = p.y + p.h / 2;
        if (Math.hypot(px - cx, py - cy) <= rad) this.damage(p, dmg, "boom");
      }
    },

    // Where every source of damage arrives. Armour on a part works the same
    // way it does on a Bulwark brick, so the answer to a plated boss is the
    // same answer as to a plated arena — which is the point.
    damage(part, dmg, source) {
      if (part.gone || part.invuln) return false;
      let d = dmg;
      if (part.armour) d = Math.max(1, Math.ceil(d / (1 + part.armour)));
      part.hp -= d;
      g.emit("bossHit", { part, dmg: d, source, x: part.x + part.w / 2, y: part.y + part.h / 2 });
      if (part.hp > 0) return false;

      part.gone = true;
      part.hp = 0;
      g.emit("bossPart", { part, x: part.x + part.w / 2, y: part.y + part.h / 2 });
      if (spec.onPartDown) spec.onPartDown(this, g, part);
      this.checkDead();
      return true;
    },

    onHit(part, ball, dmg) {
      if (spec.onHit) { spec.onHit(this, g, part, ball, dmg); return; }
      this.damage(part, dmg, "ball");
    },

    checkDead() {
      if (this.dead) return;
      const coresLeft = this.parts.some((p) => p.core && !p.gone);
      if (!coresLeft) {
        this.dead = true;
        g.bossDefeated();
      }
    },

    // Phase changes are announced so the UI can flash and the music can shift.
    toPhase(n) {
      if (n <= this.phase) return;
      this.phase = n;
      if (spec.onPhase) spec.onPhase(this, g, n);
      g.emit("bossPhase", { phase: n, boss: this });
    },

    update(dt) {
      this.t += dt;
      spec.update(this, g, dt);
    },
  };

  spec.build(boss, g, hpMul);
  return boss;
}

// A room is an arena in every respect except that clearing its bricks is not
// the objective — the boss is. `speed` is the ball speed the fight opens at.
function room(id, name, speed, rows, hazards) {
  return { id, name, act: 0, tier: "boss", speed, rows, hazards: hazards || [],
           twist: "", boss: true };
}

/* ============================================================ THE FORTRESS */
BOSSES.fortress = {
  key: "fortress", name: "The Fortress", icon: "🏰", phases: 3,
  blurb: "Armour plates all the way down. Get them off, then hit what's underneath.",
  room: room("boss-fortress", "The Fortress", 470, [
    "............",
    "S..........S",
    "............",
    "............",
    "............",
    "S..........S",
  ], []),

  // Boss health is measured in BALL RETURNS, not in hit points. A round trip
  // from the paddle is a little over a second, so ~40 landed hits is a boss
  // that takes a minute — and 140 (which is what the first draft of these
  // numbers came to) is one the perfect bot could not kill inside five.
  build(b) {
    // Six plates in a wall, two cores hiding behind them.
    for (let i = 0; i < 6; i++) {
      b.addPart({ key: "plate" + i, x: 48 + i * 54, y: 130, w: 48, h: 26,
        hp: Math.round(6 * b.hpMul), armour: 1, color: "#4a5570", glow: "#8b9bc4", glyph: "▤" });
    }
    b.core1 = b.addPart({ key: "core1", x: 96, y: 172, w: 60, h: 34,
      hp: Math.round(18 * b.hpMul), core: true, invuln: true,
      color: "#ff3d92", glow: "#ffa6d0", glyph: "◉" });
    b.core2 = b.addPart({ key: "core2", x: 264, y: 172, w: 60, h: 34,
      hp: Math.round(18 * b.hpMul), core: true, invuln: true,
      color: "#ff3d92", glow: "#ffa6d0", glyph: "◉" });
  },

  update(b, g, dt) {
    // The whole wall sways; the sway doubles each phase, so the same shot gets
    // harder to line up as the fight goes on.
    const amp = 26 * b.phase;
    const dx = Math.sin(b.t * (0.5 + b.phase * 0.22)) * amp;
    for (const p of b.parts) {
      if (p.baseX === undefined) p.baseX = p.x;
      p.x = p.baseX + dx;
    }
    // Plates gone means cores open.
    const platesLeft = b.parts.filter((p) => p.key.startsWith("plate") && !p.gone).length;
    if (platesLeft <= 3) b.toPhase(2);
    if (platesLeft === 0) b.toPhase(3);
    b.core1.invuln = platesLeft > 3;
    b.core2.invuln = platesLeft > 3;

    // From phase 2 it starts dropping rubble into the arena to crowd the ball.
    if (b.phase >= 2) {
      b.dropT = (b.dropT || 0) + dt;
      if (b.dropT >= 6) {
        b.dropT = 0;
        const c = (b.rubble = ((b.rubble || 0) + 5) % GRID_COLS);
        g.addBrick(3 + (b.phase === 3 ? 1 : 0), c, "2");
      }
    }
  },

  onHit(b, g, part, ball, dmg) {
    if (part.invuln) { g.emit("bossBlock", { x: part.x + part.w / 2, y: part.y }); return; }
    b.damage(part, dmg, "ball");
  },
};

/* ============================================================== THE SERPENT */
BOSSES.serpent = {
  key: "serpent", name: "The Serpent", icon: "🐍", phases: 3,
  blurb: "Long, fast, and the ball goes straight through its body. Hit the head.",
  room: room("boss-serpent", "The Serpent", 468, [
    "............",
    ".S........S.",
    "............",
    "............",
  ], []),

  build(b) {
    b.head = b.addPart({ key: "head", x: 190, y: 140, w: 46, h: 30,
      hp: Math.round(85 * b.hpMul), core: true,
      color: "#1fd8c4", glow: "#a9fff2", glyph: "◆" });
    // Body segments do not block the ball — they only bleed it for a point.
    for (let i = 0; i < 8; i++) {
      b.addPart({ key: "seg" + i, x: 190, y: 140, w: 30, h: 22, hp: 9999, pass: true,
        color: "#0f8f82", glow: "#3fd6c4", glyph: "" });
    }
  },

  update(b, g, dt) {
    const segs = b.parts.filter((p) => p.key.startsWith("seg"));
    const sp = 0.55 + b.phase * 0.32;
    const amp = 150;
    const path = (u) => ({
      x: LW / 2 + Math.sin(u * sp) * amp - 20,
      y: 140 + Math.sin(u * sp * 1.7) * (36 + b.phase * 12),
    });
    const h = path(b.t);
    b.head.x = h.x; b.head.y = h.y;
    segs.forEach((s, i) => {
      const p = path(b.t - (i + 1) * 0.16);
      s.x = p.x + 8; s.y = p.y + 4;
    });

    const frac = b.hpFrac();
    if (frac < 0.65) b.toPhase(2);
    if (frac < 0.3) b.toPhase(3);
  },

  onHit(b, g, part, ball, dmg) {
    if (part.pass) { b.damage(b.head, 1, "body"); return; }   // body bleeds it
    b.damage(part, dmg, "ball");
  },
};

/* ============================================================ THE ARCHITECT */
BOSSES.architect = {
  key: "architect", name: "The Architect", icon: "📐", phases: 3,
  blurb: "It builds faster than you break. Take the pillars down and reach it.",
  // It starts with an empty room and fills it itself. The first version put
  // its bricks on rows 2-4, which is exactly where the boss stands — it walled
  // its own core off and the perfect bot could never finish the fight.
  room: room("boss-architect", "The Architect", 490, [
    "............",
    "............",
    "............",
    "............",
    "............",
  ], []),

  build(b) {
    b.addPart({ key: "pillarL", x: 62, y: 150, w: 34, h: 78,
      hp: Math.round(20 * b.hpMul), color: "#7b3fe4", glow: "#c0a6ff", glyph: "▮" });
    b.addPart({ key: "pillarR", x: 324, y: 150, w: 34, h: 78,
      hp: Math.round(20 * b.hpMul), color: "#7b3fe4", glow: "#c0a6ff", glyph: "▮" });
    b.core = b.addPart({ key: "core", x: 170, y: 158, w: 80, h: 46,
      hp: Math.round(58 * b.hpMul), core: true, armour: 1,
      color: "#a06bff", glow: "#e0d0ff", glyph: "⬢" });
  },

  update(b, g, dt) {
    b.core.x = 170 + Math.sin(b.t * 0.7) * 58;
    const frac = b.hpFrac();
    if (frac < 0.66) b.toPhase(2);
    if (frac < 0.33) b.toPhase(3);

    // Armour comes off as the pillars fall — that IS the fight.
    const pillars = b.parts.filter((p) => p.key.startsWith("pillar") && !p.gone).length;
    b.core.armour = pillars;

    // It rebuilds the room BELOW itself, between you and the fight, and the
    // interval tightens every phase. Capped: an uncapped Architect eventually
    // fills the room solid and the fight becomes unwinnable rather than hard.
    b.buildT = (b.buildT || 0) + dt;
    const gap = 4.2 - b.phase * 0.9;
    if (b.buildT >= gap && g.bricks.size < 14) {
      b.buildT = 0;
      b.n = (b.n || 0) + 1;
      const c = (b.n * 5) % GRID_COLS;
      const r = 5 + (b.n % 3);
      g.addBrick(r, c, b.phase >= 3 ? "3" : "2");
    }
  },
};

/* =========================================================== THE GRAVITY CORE */
BOSSES.gravitycore = {
  key: "gravitycore", name: "Gravity Core", icon: "🌌", phases: 3,
  blurb: "Down is wherever it says it is. Four shards, then the heart.",
  room: room("boss-gravitycore", "Gravity Core", 496, [
    "............",
    "..S......S..",
    "............",
    "............",
  ], []),

  build(b) {
    b.heart = b.addPart({ key: "heart", x: 180, y: 180, w: 60, h: 48,
      hp: Math.round(38 * b.hpMul), core: true, invuln: true,
      color: "#ffd24a", glow: "#fff3c0", glyph: "✺" });
    for (let i = 0; i < 4; i++) {
      b.addPart({ key: "shard" + i, x: 190, y: 190, w: 30, h: 30,
        hp: Math.round(11 * b.hpMul), color: "#4a5df0", glow: "#a9b6ff", glyph: "◈" });
    }
  },

  update(b, g, dt) {
    const shards = b.parts.filter((p) => p.key.startsWith("shard"));
    const alive = shards.filter((p) => !p.gone).length;
    b.heart.invuln = alive > 0;

    const spin = b.t * (0.9 + b.phase * 0.45);
    const rad = 96;
    shards.forEach((s, i) => {
      const a = spin + (i / shards.length) * Math.PI * 2;
      s.x = 210 + Math.cos(a) * rad - s.w / 2;
      s.y = 204 + Math.sin(a) * rad * 0.62 - s.h / 2;
    });
    b.heart.x = 180 + Math.sin(b.t * 0.5) * 24;

    if (alive <= 2) b.toPhase(2);
    if (alive === 0) b.toPhase(3);

    // It owns gravity. Every 7 seconds down is somewhere else, and phase 3
    // halves that. This is a hazard the engine already runs, mutated live.
    b.gT = (b.gT || 0) + dt;
    const period = b.phase >= 3 ? 3.5 : 7;
    if (b.gT >= period) {
      b.gT = 0;
      b.gDir = ((b.gDir || 0) + 1) % 4;
      const [gx, gy] = GRAV_DIRS[b.gDir];
      let h = g.hazards.find((z) => z.__core);
      if (!h) { h = { kind: "gravity", ay: 0, __core: true, t: 0 }; g.hazards.push(h); }
      // A gravity hazard only pulls down, so a sideways pull is a wind hazard.
      h.ay = gy * 190;
      let w = g.hazards.find((z) => z.__coreW);
      if (!w) { w = { kind: "wind", ax: 0, __coreW: true, t: 0 }; g.hazards.push(w); }
      w.ax = gx * 190;
      g.emit("gravityShift", { dir: b.gDir });
    }
  },

  onHit(b, g, part, ball, dmg) {
    if (part.invuln) { g.emit("bossBlock", { x: part.x + part.w / 2, y: part.y }); return; }
    b.damage(part, dmg, "ball");
  },
};

/* ================================================================ THE MIMIC */
BOSSES.mimic = {
  key: "mimic", name: "The Mimic", icon: "🪞", phases: 3,
  blurb: "It has been watching you climb. Now it has your deck.",
  room: room("boss-mimic", "The Mimic", 520, [
    "............",
    ".S........S.",
    "............",
    ".S........S.",
  ], []),

  build(b, g) {
    b.addPart({ key: "faceL", x: 108, y: 156, w: 88, h: 56,
      hp: Math.round(48 * b.hpMul), core: true,
      color: "#ff3d92", glow: "#ffc0dd", glyph: "◑" });
    b.addPart({ key: "faceR", x: 224, y: 156, w: 88, h: 56,
      hp: Math.round(48 * b.hpMul), core: true,
      color: "#35e0d0", glow: "#c4fff8", glyph: "◐" });
    // It copies you: whatever you turned up with, it now has too. A deck full
    // of chaos rules makes this fight chaotic, which is the joke.
    b.stolen = [...g.build.flags].filter((f) =>
      ["gravity", "portals", "mirror", "timewarp", "growing", "chaos"].includes(f));
  },

  update(b, g, dt) {
    const halves = b.parts.filter((p) => !p.gone);
    const sway = Math.sin(b.t * (0.6 + b.phase * 0.3)) * (34 + b.phase * 16);
    b.parts[0].x = 108 + sway;
    b.parts[1].x = 224 - sway;
    const bob = Math.sin(b.t * 1.4) * 12;
    for (const p of b.parts) p.y = 156 + bob;

    const frac = b.hpFrac();
    if (frac < 0.66) b.toPhase(2);
    if (frac < 0.33) b.toPhase(3);

    if (halves.length === 1 && !b.enraged) {
      b.enraged = true;
      // The survivor takes what's left of the other one's malice.
      halves[0].armour = 1;
      g.emit("bossPhase", { phase: b.phase, boss: b, enraged: true });
    }
  },

  onPhase(b, g, n) {
    // At each phase it turns one of your own rules back on you, for good.
    const f = b.stolen[n - 2];
    if (f) { g.dynFlags.add(f); g.emit("mimicked", { flag: f }); }
    else if (n >= 2) { g.dynFlags.add("gravity"); g.emit("mimicked", { flag: "gravity" }); }
  },
};

// ------------------------------------------------------------------ registry
const BOSS_LIST = Object.values(BOSSES);
for (const b of BOSS_LIST) b.room.bossKey = b.key;

// Which bosses can end which act. Two candidates for acts 1 and 2 so a run's
// shape changes; the Mimic always guards the top.
const BOSS_POOL = {
  1: ["fortress", "serpent"],
  2: ["architect", "gravitycore"],
  3: ["mimic"],
};

BOSSES.make = function (key, g, hpMul) {
  const spec = BOSSES[key];
  if (!spec || typeof spec.build !== "function") throw new Error("unknown boss: " + key);
  return makeBoss(spec, g, hpMul || 1);
};

BOSSES.room = function (key) { return BOSSES[key].room; };

if (typeof module !== "undefined") {
  module.exports = { BOSSES, BOSS_LIST, BOSS_POOL, makeBoss };
}
