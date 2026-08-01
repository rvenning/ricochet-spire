// Ricochet Spire — the arena simulation.
//
// This file touches no DOM, no canvas and no audio. That is not tidiness for
// its own sake: it is what lets tests/bot.test.js drive the REAL engine
// headlessly, so the balance numbers in the report come from the game people
// actually play rather than from a model of it.
//
// It also contains NO Math.random. Every draw comes from a seeded generator
// handed in by run.js (see js/rng.js), and every one of them happens at
// start() — which bricks hold a power-up, which power-up — so `step()` is a
// pure function of the state before it. A changed clear time in the bot report
// is therefore always a real design change and never a bad roll.
//
// Everything is in LOGICAL pixels: a fixed 420x660 playfield that render.js
// letterboxes onto whatever screen it has. The sim never knows the screen size.
//
// The clock is a FIXED 1/60 step with an accumulator inside tick(). A ball at
// 300px/s crosses a 21px brick in 70ms, so a variable 50ms frame would let it
// pass clean through one; the substep loop inside moveBall() closes the rest of
// that gap by advancing at most 5 logical px at a time.

// Playfield geometry. These numbers are not free choices — the ratio between
// the ball's speed and the gap it has to cross decides how long an arena takes,
// and the first pass got it badly wrong: a 20-brick room took the perfect bot
// nearly two minutes, because a round trip from paddle to bricks and back was
// four seconds and broke one brick. Arcade Breakout crosses its playfield in
// about a second; everything below is tuned to land in the same place.
const LW = 420;                 // logical playfield width
const LH = 600;                 // logical playfield height
const BW = LW / GRID_COLS;      // 35 — brick cell width
const BH = 26;                  // brick cell height
const BRICK_TOP = 96;           // y of the first brick row
const PADDLE_Y = LH - 44;       // top edge of the paddle
const PADDLE_H = 12;
const BALL_R = 6;
// Paddle width as a FRACTION OF THE FIELD is the difficulty dial of the whole
// genre, and the one to reach for before touching health or brick counts —
// it makes a mistake more likely without making a room any longer.
// 80/420 is ~19%; arcade Arkanoid sits near 13%. The first pass was 90 (21%)
// and the ordinary bot dropped 0.29 balls per room in act 1 and ZERO across
// the whole of act 2, which is not a skill test at all.
const BASE_PADDLE_W = 80;

// Paddle feel. Two numbers, and they do different jobs:
//
//   PADDLE_EASE is how it FEELS. The paddle closes a fraction of the remaining
//   distance every frame, so a 5px correction is instant and a cross-field
//   sweep starts fast and settles instead of stopping dead. Brick Breaker DX
//   uses exactly this with a rate of 16 and it is the cleanest paddle in the
//   family; a constant-velocity chase (what this file had first) moves a 5px
//   correction at the same speed as a 300px one, which reads as sluggish up
//   close and laggy far away.
//
//   BASE_PADDLE_SPEED is the BALANCE. Brick Breaker DX has no cap at all, which
//   is fine there because its bot only measures clear times. Here a dropped ball
//   costs run health, so an uncapped paddle would make the ordinary bot stop
//   missing and the whole difficulty curve would go with it. 2000px/s crosses
//   the 420px field in ~0.2s, which is about as fast as a thumb actually moves
//   — so it never feels like a limit in normal play, and still punishes being
//   caught on the wrong side of the arena.
const PADDLE_EASE = 16;
const BASE_PADDLE_SPEED = 2000;
const KEY_PADDLE_SPEED = 760;   // keys are coarse; matching the pointer is unplayable
const STEP = 1 / 60;
const MAX_STEPS = 8;            // a backgrounded tab must not simulate a minute
const MAX_SUBSTEP = 5;          // logical px of ball travel per collision pass

// Gravity Shift cycles through these. Fixed order, so it is learnable.
const GRAV_DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

// What Chaos is allowed to switch on. Deliberately excludes the cards that
// would end a run outright (glass, mini) — chaos should surprise, not execute.
const CHAOS_POOL = ["gravity", "portals", "timewarp", "ricochet", "mirror",
                    "growing", "electric", "boomerang"];

const Game = {
  // main.js assigns the whole handler object once; the sim only ever emits.
  on: {},
  emit(name, data) { const f = this.on[name]; if (f) f(data); },

  running: false,
  active: false,

  /* ------------------------------------------------------------- lifecycle */
  // cfg = { arena, build, seed, tier, hp, hpMax, hpMul, scoreMul, goldBase,
  //         hpPerBall, timeLimit, boss }
  start(cfg) {
    const a = cfg.arena;
    this.cfg = cfg;
    this.arena = a;
    this.build = cfg.build;
    this.rng = RNG.sub(cfg.seed, "arena", a.id, cfg.floor || 0);

    this.running = true;
    this.won = false;
    this.acc = 0;
    this.time = 0;
    this.timeLimit = cfg.timeLimit || 180;

    this.hpMax = cfg.hpMax;
    this.hp = cfg.hp;
    this.hpPerBall = cfg.hpPerBall || 8;
    this.score = 0;
    this.gold = 0;
    this.combo = 0;
    this.comboBest = 0;
    this.bricksBroken = 0;
    this.shields = this.build.stats.shield;
    this.breakStreak = 0;         // for Explosive Ball's every-4th rule
    this.paddleHits = 0;          // for Charge Coil's every-Nth rule

    this.effects = {};            // powerup id -> seconds remaining
    this.drops = [];
    this.shots = [];
    this.fx = [];                 // short-lived visual events for the renderer
    this.dynFlags = new Set();    // flags Chaos or the arena switched on

    // Rule timers. All start at zero so two players on a seed see them fire
    // at the same moments.
    this.gravIdx = 0; this.gravT = 0;
    this.mirrorT = 0; this.mirrorOn = false;
    this.chaosT = 0; this.chaosPick = null;
    this.growT = 0;
    this.shieldT = 0; this.shieldOn = false;
    this.laserT = 0;
    this.driftX = 0;

    this.paddle = {
      x: LW / 2, target: LW / 2, vx: 0,
      w: BASE_PADDLE_W, y: PADDLE_Y,
    };
    this.paddle.w = this.paddleWidth();
    // Drawn once, up front, like every other roll in this file.
    this.serveLean = this.rng.range(0.16, 0.34) * (this.rng() < 0.5 ? -1 : 1);

    this.buildBricks(a, cfg.hpMul || 1);
    this.buildHazards(a);

    this.boss = null;
    if (cfg.boss && typeof BOSSES !== "undefined") {
      this.boss = BOSSES.make(cfg.boss, this, cfg.hpMul || 1);
    }

    this.balls = [];
    this.serve(true);

    this.runHooks("levelStart");
    this.emit("start", { arena: a, boss: this.boss });
  },

  // Called with REAL seconds. Speed and the fixed step are handled here, so
  // the frame loop and the bots get byte-identical physics.
  tick(dtReal) {
    if (!this.running) return;
    this.acc += Math.min(0.25, dtReal);
    let steps = 0;
    while (this.acc >= STEP && steps++ < MAX_STEPS && this.running) {
      this.acc -= STEP;
      this.step(STEP);
    }
    if (steps >= MAX_STEPS) this.acc = 0;
  },

  abandon() {
    if (!this.running) return;
    this.running = false;
    this.emit("end", this.result(false, true));
  },

  finish(win) {
    if (!this.running) return;
    this.running = false;
    this.won = win;
    if (win) {
      const heal = this.build.stats.heal;
      if (heal > 0) this.healRun(heal);
    }
    this.runHooks("levelEnd", { win });
    this.emit("end", this.result(win, false));
  },

  result(win, abandoned) {
    return {
      win, abandoned,
      score: Math.round(this.score),
      gold: Math.round(this.gold),
      hp: this.hp, hpMax: this.hpMax,
      time: this.time,
      bricks: this.bricksBroken,
      comboBest: this.comboBest,
      arena: this.arena.id,
      boss: this.cfg.boss || null,
    };
  },

  /* ------------------------------------------------------------ construction */
  buildBricks(a, hpMul) {
    this.bricks = new Map();
    this.rows = a.rows.length;
    this.remaining = 0;
    this.portalBricks = [];

    const luck = 1 + this.build.stats.dropPct / 100;
    const dropChance = 0.13 + this.build.stats.dropPct / 100;

    for (let r = 0; r < a.rows.length; r++) {
      const row = a.rows[r];
      for (let c = 0; c < GRID_COLS; c++) {
        const ch = row[c];
        const t = BRICKS[ch];
        if (!t) continue;
        const hp = t.hp === Infinity ? Infinity : Math.max(1, Math.round(t.hp * hpMul));
        const b = {
          r, c, type: t, hp, maxHp: hp,
          cx: c * BW + BW / 2, cy: BRICK_TOP + r * BH + BH / 2,
          burn: 0, burnAcc: 0, poison: 0, poisonAcc: 0, chill: 0,
        };
        // The one place a random number is drawn, and it is drawn now rather
        // than when the brick breaks — so the result is the same however the
        // player gets there.
        if (t.counts) {
          const forced = t.drop === "always";
          b.drop = (forced || this.rng() < dropChance)
            ? pickPowerup(this.rng, luck).id : null;
          this.remaining++;
        }
        if (t.portal) this.portalBricks.push(b);
        this.bricks.set(r * GRID_COLS + c, b);
      }
    }
  },

  buildHazards(a) {
    this.hazards = a.hazards.map((h) => ({ ...h, t: h.phase || 0, on: false }));

    // Portal Mode adds a pair to any arena that hasn't got one of its own.
    if (this.f("portals") && !this.portalBricks.length &&
        !this.hazards.some((h) => h.kind === "portal")) {
      this.hazards.push({ kind: "portal", ax: 40, ay: 250, bx: LW - 40, by: 470, t: 0 });
    }
    // Singularity hangs a black hole in the middle of the brick field.
    if (this.f("singularity")) {
      this.hazards.push({ kind: "blackhole", x: LW / 2,
        y: BRICK_TOP + this.rows * BH + 90, r: 190, pull: 300, t: 0 });
    }
    this.dark = this.hazards.find((h) => h.kind === "dark") || null;
    this.ice = this.hazards.some((h) => h.kind === "ice");
  },

  /* ------------------------------------------------------------ flag lookup */
  // Every flag read goes through here, because a flag can come from the deck,
  // from the arena, or from Chaos having just switched it on. One place to ask
  // means Chaos costs nothing at each of the thirty call sites.
  f(name) { return this.build.flags.has(name) || this.dynFlags.has(name); },

  runHooks(name, ctx) {
    const hs = this.build.hooks[name];
    if (!hs) return;
    for (const h of hs) h.fn(this, ctx || {}, h.n);
  },

  /* ------------------------------------------------------------ derived state */
  paddleWidth() {
    let w = BASE_PADDLE_W + this.build.stats.paddleW;
    if (this.f("mini")) w *= 0.64;
    if (this.effects.wide) w *= 1.42;
    if (this.effects.shrink) w *= 0.74;
    return Math.max(30, Math.min(230, w));
  },

  paddleSpeed() {
    let s = BASE_PADDLE_SPEED + this.build.stats.paddleSpeed;
    // A small paddle gets some compensation, but not enough to cancel the
    // downside — at +260 the Mini Paddle deck stopped costing anything at all
    // and the risk card became strictly good.
    if (this.f("mini")) s += 140;
    return s;
  },

  // Base speed for the arena, before per-ball boosts and Time Warp.
  baseSpeed() {
    let s = this.arena.speed + this.build.stats.ballSpeed;
    s *= this.cfg.speedMul || 1;
    // A room that is dragging speeds itself up rather than waiting out the
    // clock. Capped, so it never becomes unreadable.
    s += Math.min(150, this.time * 3.4);
    if (this.effects.slow) s *= 0.76;
    if (this.effects.rush) s *= 1.26;
    return Math.max(120, s);
  },

  ballSpeed(ball) {
    let s = this.baseSpeed() * (ball.boost || 1);
    if (this.f("timewarp") && ball.y > PADDLE_Y - 130) s *= 0.55;
    return s;
  },

  ballDamage(ball) {
    let d = 1 + this.build.stats.damage;
    if (this.effects.power) d += 3;
    if (this.f("glass")) d *= 2;
    if (this.f("ricochet")) d += Math.min(5, ball.wallCharge || 0);
    if (ball.charged) d += this.build.stats.chargeDmg;
    return d;
  },

  ballPierce() {
    return this.build.stats.pierce + (this.effects.pierce ? 2 : 0);
  },

  comboMult() { return Math.min(4, 1 + this.combo * 0.05); },

  /* -------------------------------------------------------------- the step */
  step(dt) {
    this.time += dt;

    this.stepRules(dt);
    this.stepPaddle(dt);
    this.stepHazards(dt);
    this.stepBricks(dt);
    this.stepShots(dt);
    this.stepDrops(dt);

    for (let i = this.balls.length - 1; i >= 0; i--) {
      this.moveBall(this.balls[i], dt);
      if (!this.running) return;
    }

    if (this.boss) this.boss.update(dt);

    for (const id of Object.keys(this.effects)) {
      this.effects[id] -= dt;
      if (this.effects[id] <= 0) { delete this.effects[id]; this.emit("effectEnd", { id }); }
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      this.fx[i].life -= dt;
      if (this.fx[i].life <= 0) this.fx.splice(i, 1);
    }

    this.runHooks("tick", { dt });

    // Terminal checks live HERE, on the path every driver goes through — a
    // headless bot never touches the player-facing methods, and a win check
    // hiding inside one of those would leave a bot's run never ending.
    //
    // LOSING IS CHECKED FIRST. The last brick of an arena can break in the same
    // step that the last ball falls past the paddle, and reporting that as a
    // clear would hand out a reward the player didn't survive to collect.
    if (this.hp <= 0) { this.hp = 0; this.finish(false); return; }
    if (this.time >= this.timeLimit) { this.finish(false); return; }
    if (this.boss ? this.boss.dead : this.remaining <= 0) { this.finish(true); return; }
  },

  stepRules(dt) {
    if (this.f("gravity")) {
      this.gravT += dt;
      if (this.gravT >= 15) {
        this.gravT = 0;
        this.gravIdx = (this.gravIdx + 1) % GRAV_DIRS.length;
        this.emit("gravityShift", { dir: this.gravIdx });
      }
    }
    if (this.f("mirror")) {
      this.mirrorT += dt;
      const was = this.mirrorOn;
      const cyc = this.mirrorT % 30;
      this.mirrorOn = cyc >= 20;
      if (this.mirrorOn !== was) this.emit("mirror", { on: this.mirrorOn });
    } else this.mirrorOn = false;

    if (this.f("chaos")) {
      this.chaosT += dt;
      if (this.chaosT >= 40) {
        this.chaosT = 0;
        if (this.chaosPick) this.dynFlags.delete(this.chaosPick);
        // Drawn from a generator keyed on the arena and how far in we are, so
        // the surprise is identical for everyone playing this seed.
        const r = RNG.sub(this.cfg.seed, "chaos", this.arena.id, Math.round(this.time));
        this.chaosPick = r.pick(CHAOS_POOL.filter((c) => !this.build.flags.has(c)));
        if (this.chaosPick) {
          this.dynFlags.add(this.chaosPick);
          this.emit("chaos", { flag: this.chaosPick });
        }
      }
    }

    if (this.f("growing")) {
      this.growT += dt;
      if (this.growT >= 14) {
        this.growT = 0;
        for (const b of this.bricks.values()) {
          if (!b.type.counts || b.chill > 0 || b.maxHp >= 9) continue;
          b.maxHp++; b.hp++;
        }
        this.emit("grow", {});
      }
    }

    if (this.f("reflect")) {
      this.shieldT += dt;
      this.shieldOn = (this.shieldT % 22) < 3;
    }
  },

  stepPaddle(dt) {
    const p = this.paddle;
    p.w = this.paddleWidth();
    const half = p.w / 2;
    const target = Math.max(half, Math.min(LW - half, p.target));
    const maxV = this.paddleSpeed();

    if (this.ice) {
      // Ice: the paddle accelerates toward the target and coasts. Overshooting
      // is the point.
      const dir = Math.sign(target - p.x);
      p.vx += dir * 2600 * dt;
      p.vx = Math.max(-maxV, Math.min(maxV, p.vx));
      p.vx *= Math.pow(0.55, dt);
      p.x += p.vx * dt;
    } else {
      // Ease toward the target, then clamp to the speed limit. The ease gives
      // the feel; the clamp keeps the limit real.
      const dx = target - p.x;
      let move = dx * Math.min(1, dt * PADDLE_EASE);
      const cap = maxV * dt;
      if (move > cap) move = cap;
      else if (move < -cap) move = -cap;
      p.x += move;
      p.vx = move / dt;
    }
    p.x = Math.max(half, Math.min(LW - half, p.x));

    // Any ball still stuck rides along, and lets go on its own if the player
    // is doing something else — a run must never be able to stall forever.
    for (const b of this.balls) {
      if (!b.stuck) continue;
      b.x = p.x + (b.stickOff || 0);
      b.y = PADDLE_Y - BALL_R - 1;
      b.hold -= dt;
      if (b.hold <= 0) this.launchBall(b);
    }

    if (this.f("laser") || this.effects.beam) {
      const rate = this.build.stats.laserRate + (this.effects.beam ? 1.6 : 0);
      if (rate > 0) {
        this.laserT += dt;
        const gap = 1 / rate;
        while (this.laserT >= gap) {
          this.laserT -= gap;
          this.shots.push({ x: p.x - 14, y: PADDLE_Y, vy: -560 });
          this.shots.push({ x: p.x + 14, y: PADDLE_Y, vy: -560 });
          this.emit("shoot", { x: p.x, y: PADDLE_Y });
        }
      }
    }
  },

  stepHazards(dt) {
    for (const h of this.hazards) {
      h.t += dt;
      if (h.kind === "mover") {
        h.cx = h.x + h.span * 0.5 * (1 + Math.sin((h.t / h.period) * Math.PI * 2));
      } else if (h.kind === "laser") {
        const cyc = h.t % (h.on + h.off);
        const was = h.on_;
        h.on_ = cyc < h.on;
        if (h.on_ !== was) this.emit("beam", { on: h.on_, x: h.x });
      } else if (h.kind === "drift") {
        this.driftX = h.amp * Math.sin((h.t / h.period) * Math.PI * 2);
      }
    }
  },

  stepBricks(dt) {
    for (const b of this.bricks.values()) {
      if (b.chill > 0) b.chill -= dt;
      if (b.type.tick && b.chill <= 0) b.type.tick(this, b, dt);
      if (b.burn > 0) {
        b.burn -= dt; b.burnAcc += dt;
        if (b.burnAcc >= 1) { b.burnAcc -= 1; this.damageBrick(b, 1, null, "burn"); }
      }
      if (b.poison) {
        b.poisonAcc += dt;
        if (b.poisonAcc >= 2) { b.poisonAcc -= 2; this.damageBrick(b, 1, null, "poison"); }
      }
    }
  },

  stepShots(dt) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.y += s.vy * dt;
      if (s.y < 0) { this.shots.splice(i, 1); continue; }
      const b = this.brickAt(s.x, s.y);
      if (b) {
        this.shots.splice(i, 1);
        this.damageBrick(b, 1 + Math.floor(this.build.stats.damage / 2), null, "laser");
        continue;
      }
      if (this.boss) {
        const part = this.boss.partAt(s.x, s.y);
        if (part) { this.shots.splice(i, 1); this.boss.onHit(part, null, 1); }
      }
    }
  },

  stepDrops(dt) {
    const p = this.paddle;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.y += 132 * dt;
      if (d.y > LH + 20) { this.drops.splice(i, 1); continue; }
      if (d.y > PADDLE_Y - 8 && d.y < PADDLE_Y + PADDLE_H + 8 &&
          Math.abs(d.x - p.x) < p.w / 2 + 12) {
        this.drops.splice(i, 1);
        this.collect(d.id);
      }
    }
  },

  collect(id) {
    const p = POWERUPS[id];
    if (!p) return;
    if (p.kind === "instant") p.apply(this);
    else {
      // Stacking extends the timer rather than adding a second copy, capped at
      // twice the base so a lucky arena can't hand out a permanent buff.
      this.effects[id] = Math.min((this.effects[id] || 0) + p.dur, p.dur * 2);
    }
    this.emit("pickup", { id, bad: !!p.bad });
  },

  /* ------------------------------------------------------------------ balls */
  serve(first) {
    const p = this.paddle;
    const extra = this.f("focus") ? 0 : this.build.stats.extraBalls;
    const n = first ? 1 + extra : 1;
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i - (n - 1) / 2) * 18;
      this.balls.push({
        x: p.x + off, y: PADDLE_Y - BALL_R - 1,
        vx: 0, vy: -1, r: BALL_R,
        stuck: true, stickOff: off, hold: 1.2, portalCd: 0, pierced: 0,
        boost: 1, wallCharge: 0, homing: 0, spin: 0, charged: false,
      });
    }
    this.emit("serve", { balls: this.balls.length });
  },

  // The player (or a bot) letting go of a held ball.
  launch() {
    let any = false;
    for (const b of this.balls) if (b.stuck) { this.launchBall(b); any = true; }
    return any;
  },

  launchBall(b) {
    b.stuck = false;
    const off = this.paddle.w > 0 ? (b.x - this.paddle.x) / (this.paddle.w / 2) : 0;
    // A serve from dead centre leaves at exactly 0 degrees, and a paddle parked
    // at the middle then returns it along the identical path forever — an
    // abandoned game can clear a room by itself. The lean is drawn from the
    // arena's own seed, so it is still perfectly reproducible; it just isn't
    // symmetric.
    const lean = off * 0.55 + (this.serveLean || 0);
    const v = Physics.paddleBounce(lean, this.ballSpeed(b));
    b.vx = v.vx; b.vy = v.vy;
    this.emit("launch", { x: b.x, y: b.y });
  },

  moveBall(b, dt) {
    if (b.stuck) return;

    // Forces first, then the swept move. Gravity, wind, magnets and spin all
    // change the DIRECTION; the speed is re-pinned afterwards, so no amount of
    // accumulated force can make the ball outrun the player.
    let ax = 0, ay = 0;
    for (const h of this.hazards) {
      if (h.kind === "wind") ax += h.ax;
      else if (h.kind === "gravity") ay += h.ay;
      else if (h.kind === "conveyor") {
        if (b.y > h.y && b.y < h.y + h.h) ax += h.vx * 1.6;
      } else if (h.kind === "blackhole") {
        const dx = h.x - b.x, dy = h.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d > 1 && d < h.r) {
          const k = h.pull * (1 - d / h.r) / d;
          ax += dx * k; ay += dy * k;
        }
      }
    }
    if (this.f("gravity")) {
      const [gx, gy] = GRAV_DIRS[this.gravIdx];
      ax += gx * 205; ay += gy * 205;
    }
    if (this.f("magnetic") && b.y > PADDLE_Y - 190 && b.vy > 0) {
      ax += Math.sign(this.paddle.x - b.x) * this.build.stats.magnet;
    }
    if (this.effects.pull && b.vy > 0 && b.y > PADDLE_Y - 210) {
      ax += Math.sign(this.paddle.x - b.x) * 300;
    }
    if (b.homing > 0) {
      b.homing -= dt;
      ax += Math.sign(this.paddle.x - b.x) * 320;
    }
    if (b.spin) { ax += b.spin; b.spin *= Math.pow(0.35, dt); }
    if (b.portalCd > 0) b.portalCd = Math.max(0, b.portalCd - dt);

    b.vx += ax * dt; b.vy += ay * dt;

    if (b.boost > 1) b.boost = Math.max(1, b.boost - dt * 0.12);

    const target = this.ballSpeed(b);
    const v = Physics.atSpeed(b.vx, b.vy, target);
    b.vx = v.vx; b.vy = v.vy;

    const dist = target * dt;
    const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      this.collideWalls(b);
      if (!this.running || b.dead) return;
      this.collideHazards(b);
      this.collidePaddle(b);
      this.collideBricks(b);
      if (this.boss) this.collideBoss(b);
      if (!this.running || b.dead) return;
    }
  },

  bounce(b, nx, ny, depth) {
    const r = Physics.reflect(b.vx, b.vy, nx, ny);
    b.vx = r.vx; b.vy = r.vy;
    if (depth) { b.x += nx * (depth + 0.01); b.y += ny * (depth + 0.01); }
    const u = Physics.unstick(b.vx, b.vy, Math.hypot(b.vx, b.vy) || 1);
    b.vx = u.vx; b.vy = u.vy;
  },

  collideWalls(b) {
    let hit = false;
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); hit = true; }
    else if (b.x + b.r > LW) { b.x = LW - b.r; b.vx = -Math.abs(b.vx); hit = true; }

    if (b.y - b.r < 0) {
      b.y = b.r; b.vy = Math.abs(b.vy); hit = true;
      if (this.f("boomerang")) b.homing = 1.1;
    }

    if (hit) {
      if (this.f("ricochet")) b.wallCharge = Math.min(5, (b.wallCharge || 0) + 1);
      this.runHooks("wallBounce", { ball: b });
      this.emit("wall", { x: b.x, y: b.y });
    }

    // The floor.
    if (b.y - b.r > LH) { this.loseBall(b); return; }
    if (this.shieldOn && b.vy > 0 && b.y + b.r > LH - 8) {
      b.y = LH - 8 - b.r; b.vy = -Math.abs(b.vy);
      this.emit("save", { x: b.x });
    }
  },

  collideHazards(b) {
    for (const h of this.hazards) {
      if (h.kind === "mover") {
        const hit = Physics.circleRect(b.x, b.y, b.r, h.cx, h.y, h.w, h.h);
        if (hit) { this.bounce(b, hit.nx, hit.ny, hit.depth); this.emit("clank", { x: b.x, y: b.y }); }
      } else if (h.kind === "laser" && h.on_) {
        const hit = Physics.circleRect(b.x, b.y, b.r, h.x, BRICK_TOP - 20, h.w, PADDLE_Y - BRICK_TOP + 20);
        if (hit) { this.bounce(b, hit.nx, hit.ny, hit.depth); this.emit("clank", { x: b.x, y: b.y }); }
      } else if (h.kind === "bumper") {
        const d = Math.hypot(b.x - h.x, b.y - h.y);
        if (d < h.r + b.r && d > 0.01) {
          this.bounce(b, (b.x - h.x) / d, (b.y - h.y) / d, h.r + b.r - d);
          b.boost = Math.min(1.4, (b.boost || 1) * h.boost);
          this.emit("bumper", { x: h.x, y: h.y });
        }
      } else if (h.kind === "portal") {
        if (b.portalCd > 0) continue;
        const near = (px, py) => Math.hypot(b.x - px, b.y - py) < 20;
        const out = (px, py) => {
          const m = Math.hypot(b.vx, b.vy) || 1;
          b.x = px + (b.vx / m) * 26; b.y = py + (b.vy / m) * 26;
          b.portalCd = 0.3;
          this.emit("portal", { x: b.x, y: b.y });
        };
        if (near(h.ax, h.ay)) out(h.bx, h.by);
        else if (near(h.bx, h.by)) out(h.ax, h.ay);
      }
    }
  },

  collidePaddle(b) {
    const p = this.paddle;
    if (b.vy <= 0) return;
    const hit = Physics.circleRect(b.x, b.y, b.r, p.x - p.w / 2, p.y, p.w, PADDLE_H);
    if (hit) {
      this.catchOn(b, p.x, p.w, p.y);
      return;
    }
    // Double Paddle: a second, narrower surface higher up the arena.
    if (this.f("twin")) {
      const tw = p.w * 0.68, tx = LW - p.x, ty = PADDLE_Y - 128;
      const h2 = Physics.circleRect(b.x, b.y, b.r, tx - tw / 2, ty, tw, PADDLE_H);
      if (h2) {
        this.bounce(b, h2.nx, h2.ny, h2.depth);
        this.emit("paddle", { x: b.x, y: ty, twin: true });
      }
    }
  },

  catchOn(b, px, pw, py) {
    b.y = py - b.r - 0.5;
    b.wallCharge = 0;
    this.combo = 0;

    this.paddleHits++;
    const every = this.build.stats.chargeEvery;
    b.charged = every > 0 && this.paddleHits % every === 0;

    if (this.f("sticky")) {
      b.stuck = true; b.hold = 2.4; b.stickOff = b.x - px;
      b.vx = 0; b.vy = 0;
      this.emit("paddle", { x: b.x, y: py, stuck: true });
      this.runHooks("paddleHit", { ball: b });
      return;
    }

    const off = (b.x - px) / (pw / 2);
    const v = Physics.paddleBounce(off, this.ballSpeed(b));
    b.vx = v.vx; b.vy = v.vy;
    if (this.f("spin")) b.spin = this.paddle.vx * 0.55;

    this.runHooks("paddleHit", { ball: b });
    this.emit("paddle", { x: b.x, y: py, charged: b.charged });
  },

  loseBall(b) {
    b.dead = true;
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);

    if (this.shields > 0) {
      this.shields--;
      this.emit("shieldUsed", { left: this.shields });
      if (!this.balls.length) this.serve(false);
      return;
    }

    this.hp -= this.hpPerBall;
    this.runHooks("ballLost", { ball: b });
    this.emit("ballLost", { hp: this.hp, x: b.x });
    if (this.hp <= 0) return;                      // step() ends the arena
    if (!this.balls.length) this.serve(false);
  },

  splitBalls(n) {
    if (this.f("focus")) return;                   // Singular Focus means one
    const src = this.balls.filter((b) => !b.stuck);
    const from = src.length ? src : this.balls;
    if (!from.length) return;
    const seed = from[0];
    for (let i = 1; i < n; i++) {
      const a = (i / n) * 1.2 - 0.6;
      const sp = Math.hypot(seed.vx, seed.vy) || this.baseSpeed();
      const dir = Math.atan2(seed.vy, seed.vx) + a;
      this.balls.push({
        x: seed.x, y: seed.y,
        vx: Math.cos(dir) * sp, vy: Math.sin(dir) * sp, r: BALL_R,
        stuck: false, boost: seed.boost, wallCharge: 0, homing: 0, spin: 0,
        charged: false, portalCd: 0, pierced: 0, hold: 0, stickOff: 0,
      });
    }
    this.emit("split", { count: this.balls.length });
  },

  /* ----------------------------------------------------------------- bricks */
  key(r, c) { return r * GRID_COLS + c; },

  // Bricks slide with the Drift hazard, so every lookup un-shifts first — one
  // place, so nothing can disagree about where a brick actually is.
  brickAt(x, y) {
    const c = Math.floor((x - this.driftX) / BW);
    const r = Math.floor((y - BRICK_TOP) / BH);
    if (c < 0 || c >= GRID_COLS || r < 0) return null;
    return this.bricks.get(this.key(r, c)) || null;
  },

  brickRect(b) {
    return [b.c * BW + this.driftX, BRICK_TOP + b.r * BH, BW, BH];
  },

  collideBricks(b) {
    if (!this.bricks.size) return;
    const c0 = Math.floor((b.x - b.r - this.driftX) / BW);
    const c1 = Math.floor((b.x + b.r - this.driftX) / BW);
    const r0 = Math.floor((b.y - b.r - BRICK_TOP) / BH);
    const r1 = Math.floor((b.y + b.r - BRICK_TOP) / BH);

    let best = null, bestHit = null;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (c < 0 || c >= GRID_COLS || r < 0) continue;
        const br = this.bricks.get(this.key(r, c));
        if (!br) continue;
        // Phase Ball walks through steel; it does NOT walk through gates,
        // which are the point of the arenas that have them.
        if (this.f("phase") && br.hp === Infinity && !br.type.portal) continue;
        const [rx, ry, rw, rh] = this.brickRect(br);
        const hit = Physics.circleRect(b.x, b.y, b.r, rx, ry, rw, rh);
        if (hit && (!bestHit || hit.depth > bestHit.depth)) { best = br; bestHit = hit; }
      }
    }
    if (!best) return;

    if (best.type.portal) { this.throughGate(b, best); return; }

    if (best.type.deflect) {
      // A quarter-turn instead of a reflection.
      const t = b.vx; b.vx = -b.vy; b.vy = t;
      this.bounce(b, bestHit.nx, bestHit.ny, bestHit.depth);
      this.damageBrick(best, this.ballDamage(b), b, "ball");
      return;
    }

    const dmg = this.ballDamage(b);
    if (this.f("burn")) { best.burn = 3; best.burnAcc = 0; }
    if (this.f("poison")) best.poison = 1;
    if (this.f("freeze")) best.chill = 5;
    this.runHooks("brickHit", { brick: best, ball: b });

    const killed = this.damageBrick(best, dmg, b, "ball");
    b.charged = false;
    b.wallCharge = 0;

    // Heavy and Piercing carry straight on through what they destroyed; a
    // reflection there would throw away exactly the thing you bought.
    const carry = killed && (this.f("heavy") || (b.pierced || 0) < this.ballPierce());
    if (carry) { b.pierced = (b.pierced || 0) + 1; return; }
    b.pierced = 0;
    this.bounce(b, bestHit.nx, bestHit.ny, bestHit.depth);
  },

  // Gates pair up in the order they appear in the layout — 0 with 1, 2 with 3
  // — so an arena with four of them has two independent links rather than one
  // muddle. The ball comes out PAST its exit, travelling the way it went in:
  // dropping it on the exit's centre meant it re-entered the moment the
  // cooldown lapsed, and Twin Gates became an unwinnable loop.
  throughGate(b, gate) {
    if (b.portalCd > 0) return;
    const i = this.portalBricks.indexOf(gate);
    const to = this.portalBricks[i ^ 1];
    if (!to) return;
    const m = Math.hypot(b.vx, b.vy) || 1;
    b.x = to.c * BW + BW / 2 + this.driftX + (b.vx / m) * (BW * 0.5 + b.r + 2);
    b.y = BRICK_TOP + to.r * BH + BH / 2 + (b.vy / m) * (BH * 0.5 + b.r + 2);
    b.portalCd = 0.35;
    this.emit("portal", { x: b.x, y: b.y });
  },

  // The single funnel every source of damage goes through — ball, laser, burn,
  // poison, explosion, chain, boss. Returns true when the brick died.
  damageBrick(brick, dmg, ball, source, depth = 0) {
    if (!brick || brick.dead || brick.hp === Infinity) return false;

    if (brick.type.onHit) brick.type.onHit(this, brick);

    let d = dmg;
    if (brick.type.armour) {
      // Armour is what stops "take the biggest number" being a strategy: raw
      // damage is quartered, and only Piercing and Heavy add on top of it.
      // At a third, a fast high-damage ball out-DPS'd a piercing one on the
      // Anvil and armour stopped meaning anything.
      d = Math.max(1, Math.ceil(d / 4)) + this.build.stats.pierce * 2 + (this.f("heavy") ? 3 : 0);
    }

    brick.hp -= d;
    this.emit("brickHit", { brick, dmg: d, source, x: brick.cx + this.driftX, y: brick.cy });

    if (brick.hp > 0) return false;

    brick.dead = true;
    this.bricks.delete(this.key(brick.r, brick.c));
    if (brick.type.counts) this.remaining--;
    this.bricksBroken++;

    this.combo += 1 + this.build.stats.comboRate;
    this.comboBest = Math.max(this.comboBest, this.combo);

    const mult = this.comboMult() * (1 + this.build.stats.scorePct / 100) * (this.cfg.scoreMul || 1);
    this.score += brick.type.score * mult;

    if (this.f("greed")) this.gold += 1;
    if (this.f("vampire") && this.bricksBroken % 25 === 0) this.healRun(1);

    if (brick.drop) this.dropPowerupAt(brick.cx + this.driftX, brick.cy, brick.drop);

    this.emit("brickBreak", { brick, x: brick.cx + this.driftX, y: brick.cy, combo: this.combo });
    this.runHooks("brickBreak", { brick, ball });

    if (depth < 4) {
      if (this.f("explosive")) {
        this.breakStreak++;
        if (this.breakStreak >= 4) {
          this.breakStreak = 0;
          this.explodeAt(brick.cx, brick.cy, 1.5, brick, depth + 1);
        }
      }
      if (this.f("chain")) this.shockNeighbours(brick, 1, depth + 1);
      if (this.f("electric")) this.arcFrom(brick, depth + 1);
      if (brick.type.onBreak) brick.type.onBreak(this, brick, depth + 1);
    }
    return true;
  },

  explodeAt(cx, cy, radiusCells, source, depth = 0) {
    const rad = radiusCells * BW;
    const list = [];
    for (const b of this.bricks.values()) {
      if (b === source) continue;
      if (Math.hypot(b.cx - cx, b.cy - cy) <= rad) list.push(b);
    }
    this.fx.push({ kind: "boom", x: cx + this.driftX, y: cy, r: rad, life: 0.3 });
    this.emit("boom", { x: cx + this.driftX, y: cy, r: rad });
    for (const b of list) this.damageBrick(b, 2, null, "boom", depth + 1);
    if (this.boss) this.boss.splash(cx, cy, rad, 2);
  },

  shockNeighbours(brick, dmg, depth = 0) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const n = this.bricks.get(this.key(brick.r + dr, brick.c + dc));
        if (n) this.damageBrick(n, dmg, null, "chain", depth + 1);
      }
    }
  },

  arcFrom(brick, depth = 0) {
    let best = null, bestD = Infinity;
    for (const b of this.bricks.values()) {
      const d = Math.hypot(b.cx - brick.cx, b.cy - brick.cy);
      if (d < bestD && d <= BW * 3.2) { bestD = d; best = b; }
    }
    if (!best) return;
    this.emit("arc", { x1: brick.cx + this.driftX, y1: brick.cy,
                       x2: best.cx + this.driftX, y2: best.cy });
    this.damageBrick(best, 1, null, "arc", depth + 1);
  },

  // Airburst: detonate over whatever is lowest, which is what a player about
  // to lose the ball actually wants.
  burstLowest(radiusCells) {
    let low = null;
    for (const b of this.bricks.values()) if (!low || b.cy > low.cy) low = b;
    if (low) this.explodeAt(low.cx, low.cy, radiusCells, null, 1);
  },

  dropPowerupAt(x, y, id) {
    this.drops.push({ x, y, id });
    this.emit("drop", { x, y, id });
  },

  addBrick(r, c, ch) {
    const t = BRICKS[ch];
    if (!t || this.bricks.has(this.key(r, c))) return null;
    const hp = t.hp === Infinity ? Infinity : Math.max(1, Math.round(t.hp * (this.cfg.hpMul || 1)));
    const b = { r, c, type: t, hp, maxHp: hp, drop: null,
                cx: c * BW + BW / 2, cy: BRICK_TOP + r * BH + BH / 2,
                burn: 0, burnAcc: 0, poison: 0, poisonAcc: 0, chill: 0 };
    this.bricks.set(this.key(r, c), b);
    if (t.counts) this.remaining++;
    this.emit("spawnBrick", { brick: b });
    return b;
  },

  /* -------------------------------------------------------------- the boss */
  collideBoss(b) {
    const part = this.boss.hitTest(b);
    if (!part) return;
    this.bounce(b, part.nx, part.ny, part.depth);
    this.boss.onHit(part.part, b, this.ballDamage(b));
    b.charged = false;
    b.wallCharge = 0;
  },

  bossDefeated() {
    this.emit("bossDown", {});
  },

  /* --------------------------------------------------------------- run bits */
  healRun(n) {
    const before = this.hp;
    this.hp = Math.min(this.hpMax, this.hp + n);
    if (this.hp !== before) this.emit("heal", { hp: this.hp, by: this.hp - before });
  },

  addGold(n) {
    this.gold += n;
    this.emit("gold", { gold: this.gold });
  },

  /* ----------------------------------------------------------------- input */
  // Aim the paddle at a logical x. Mirror World flips it here, once, so every
  // input path (pointer, keyboard, bot) is reversed identically.
  aimAt(x) {
    this.paddle.target = this.mirrorOn ? LW - x : x;
  },

  // Keyboard/held input: -1, 0 or 1. This walks the TARGET rather than the
  // paddle, so the same ease applies and a held key feels like a smooth sweep.
  nudge(dir, dt) {
    if (!dir) return;
    const d = this.mirrorOn ? -dir : dir;
    const rate = KEY_PADDLE_SPEED + this.build.stats.paddleSpeed * 0.4;
    this.paddle.target = Math.max(0, Math.min(LW, this.paddle.target + d * rate * dt));
  },
};

if (typeof module !== "undefined") {
  module.exports = { Game, LW, LH, BW, BH, BRICK_TOP, PADDLE_Y, PADDLE_H, BALL_R,
                     BASE_PADDLE_W, BASE_PADDLE_SPEED, STEP, GRAV_DIRS, CHAOS_POOL };
}
