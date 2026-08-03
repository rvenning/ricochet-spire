// Pins down the two behaviours a brick breaker lives or dies by: a ball that
// never tunnels through a brick, and a ball that never settles into a loop the
// player cannot break out of. Both failure modes are silent — nothing errors,
// the arena just never ends.

const test = require("node:test");
const assert = require("node:assert");
const { loadEngine } = require("./load.js");

const S = loadEngine();
const { Physics, Game, compileDeck, ARENA_BY_ID, LW, LH, BALL_R, PADDLE_Y, STEP } = S;

test("circleRect reports the shallowest way out", () => {
  // Approaching a brick's left face.
  const hit = Physics.circleRect(10, 20, 6, 12, 10, 30, 20);
  assert.ok(hit);
  assert.equal(hit.nx, -1);
  assert.equal(hit.ny, 0);
  assert.ok(hit.depth > 0 && hit.depth <= 6);
  // Clear of it entirely.
  assert.equal(Physics.circleRect(0, 0, 6, 40, 40, 30, 20), null);
});

test("a ball whose centre is inside a brick is pushed out the nearest face", () => {
  // Dead centre of a 30x20 brick at (0,0) but nearer the top.
  const hit = Physics.circleRect(15, 6, 6, 0, 0, 30, 20);
  assert.ok(hit);
  assert.equal(hit.ny, -1, "closest face is the top, so it leaves upward");
  assert.ok(hit.depth > 6, "the push-out has to clear the radius as well");
});

test("unstick keeps the ball out of both dead ends", () => {
  const speed = 400;
  // Almost horizontal: must be given a real vertical component.
  let v = Physics.unstick(399, 4, speed);
  assert.ok(Math.abs(v.vy) / speed >= 0.27, `vy fraction ${Math.abs(v.vy) / speed}`);
  // Almost vertical: must be given a real horizontal one, or a centred paddle
  // bounces it up and down the same column forever.
  v = Physics.unstick(2, -399, speed);
  assert.ok(Math.abs(v.vx) / speed >= 0.29, `vx fraction ${Math.abs(v.vx) / speed}`);
  // Direction (which quadrant) is never changed, only the angle.
  v = Physics.unstick(-300, 260, speed);
  assert.ok(v.vx < 0 && v.vy > 0);
  // Speed is preserved exactly.
  assert.ok(Math.abs(Math.hypot(v.vx, v.vy) - speed) < 0.001);
});

test("paddleBounce turns contact position into an angle", () => {
  const s = 400;
  const mid = Physics.paddleBounce(0, s);
  assert.ok(mid.vy < 0 && Math.abs(mid.vx) < 1, "dead centre goes straight up");
  const edge = Physics.paddleBounce(1, s);
  assert.ok(edge.vx > 0 && edge.vy < 0, "the right edge sends it right and up");
  assert.ok(Math.abs(Math.hypot(edge.vx, edge.vy) - s) < 0.001, "speed is unchanged");
  // Past the edge is clamped rather than folded back round.
  assert.deepEqual(Physics.paddleBounce(4, s), Physics.paddleBounce(1, s));
  // Symmetric.
  const l = Physics.paddleBounce(-0.5, s), r = Physics.paddleBounce(0.5, s);
  assert.ok(Math.abs(l.vx + r.vx) < 1e-9);
});

test("predictX folds wall bounces into one answer", () => {
  // Straight down: lands where it started.
  assert.ok(Math.abs(Physics.predictX(100, 0, 0, 300, 300, 0, 420) - 100) < 0.01);
  // Going up: there is no landing yet.
  assert.equal(Physics.predictX(100, 300, 40, -300, 500, 0, 420), 100);
  // One reflection off the right wall: travelling 420 right from x=210 puts it
  // at 630, which folds back to 210.
  const x = Physics.predictX(210, 0, 420, 420, 1, 0, 420);
  assert.ok(x >= 0 && x <= 420, `${x} is off the field`);
  // The prediction must agree with the simulation, or the aim guide lies.
  const sim = (x0, vx, vy, targetY) => {
    let x = x0, y = 0;
    const dt = 0.0005;
    while (y < targetY) {
      x += vx * dt; y += vy * dt;
      if (x < 0) { x = -x; vx = -vx; }
      if (x > 420) { x = 840 - x; vx = -vx; }
    }
    return x;
  };
  for (const [x0, vx] of [[80, 300], [300, -420], [210, 700], [12, -140]]) {
    const want = sim(x0, vx, 400, 500);
    const got = Physics.predictX(x0, 0, vx, 400, 500, 0, 420);
    assert.ok(Math.abs(want - got) < 3, `predicted ${got.toFixed(1)}, simulated ${want.toFixed(1)}`);
  }
});

/* --------------------------------------------------------- the engine itself */
function start(arenaId, deck = [], extra = {}) {
  Game.on = {};
  Game.start(Object.assign({
    arena: ARENA_BY_ID[arenaId], boss: null, build: compileDeck(deck),
    seed: 1234, floor: 0, tier: "standard", hp: 200, hpMax: 200,
    hpMul: 1, speedMul: 1, scoreMul: 1, hpPerBall: 8, timeLimit: 180, goldBase: 30,
  }, extra));
  return Game;
}

test("the ball never leaves the playfield, however long it runs", () => {
  const g = start("splitwind", ["overclock", "overclock"]);   // wind, bumper, fast
  g.launch();
  for (let i = 0; i < 60 * 90 && g.running; i++) {
    g.aimAt(g.balls[0] ? g.balls[0].x : LW / 2);
    g.tick(1 / 60);
    for (const b of g.balls) {
      assert.ok(b.x >= -2 && b.x <= LW + 2, `ball at x=${b.x.toFixed(1)} on frame ${i}`);
      assert.ok(b.y >= -2, `ball at y=${b.y.toFixed(1)} on frame ${i}`);
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), "NaN in the ball");
    }
  }
});

test("a fast ball cannot tunnel through a brick", () => {
  // Far faster than anything the game hands out, aimed straight at the wall.
  const g = start("foyer", []);
  g.launch();
  const before = g.remaining;
  const b = g.balls[0];
  b.x = 210; b.y = 400; b.vx = 0; b.vy = -1;
  g.arena = { ...g.arena, speed: 2400 };
  for (let i = 0; i < 60 && g.running; i++) g.tick(1 / 60);
  assert.ok(g.remaining < before, "it should have broken something, not gone through");
});

test("the loop clamps a huge frame instead of teleporting everything", () => {
  const g = start("foyer", []);
  g.launch();
  const b = g.balls[0];
  const y0 = b.y;
  g.tick(60);                       // a tab that was hidden for a minute
  assert.ok(Math.abs(b.y - y0) < LH, "one enormous frame moved the ball a whole screen");
  assert.ok(g.time < 1, `${g.time}s of simulation from one frame`);
});

test("update is safe to step after the arena has ended", () => {
  const g = start("foyer", []);
  g.finish(false);
  const hp = g.hp, t = g.time;
  for (let i = 0; i < 100; i++) g.tick(1 / 60);
  assert.equal(g.hp, hp, "a finished arena kept simulating");
  assert.equal(g.time, t);
});

test("losing is decided before winning in the same step", () => {
  const g = start("foyer", []);
  g.hp = 1;
  g.remaining = 0;                  // the last brick just broke...
  g.hp = -1;                        // ...in the step that also took the last ball
  let result = null;
  g.on = { end: (r) => { result = r; } };
  g.tick(1 / 60);
  assert.ok(result);
  assert.equal(result.win, false, "a run that ended in death was scored as a clear");
});

test("a spare ball costs half; the last one costs full", () => {
  const g = start("foyer", ["splitter", "splitter"]);   // serves three
  assert.equal(g.balls.length, 3);
  const full = g.hpPerBall;
  const half = Math.round(full / 2);
  let hp = g.hp;

  g.loseBall(g.balls[0]);
  assert.equal(g.hp, hp - half, "one of three should cost half");
  assert.equal(g.balls.length, 2, "and no replacement while others are in play");
  hp = g.hp;

  g.loseBall(g.balls[0]);
  assert.equal(g.hp, hp - half, "two of three should cost half");
  assert.equal(g.balls.length, 1);
  hp = g.hp;

  g.loseBall(g.balls[0]);
  assert.equal(g.hp, hp - full, "the last ball costs full price");
  assert.equal(g.balls.length, 1, "and a fresh ball is served");
});

test("with one ball, every drop is a last-ball drop", () => {
  const g = start("foyer", []);
  assert.equal(g.balls.length, 1);
  const hp = g.hp;
  g.loseBall(g.balls[0]);
  assert.equal(g.hp, hp - g.hpPerBall, "no multiball means no discount");
});

test("multiball is cheaper than losing the same balls one at a time", () => {
  // The whole point: three balls dropping must cost less than three separate
  // last-ball drops would have.
  const multi = start("foyer", ["splitter", "splitter"]);
  const before = multi.hp;
  for (let i = 0; i < 3; i++) multi.loseBall(multi.balls[0]);
  const withMulti = before - multi.hp;
  assert.ok(withMulti < multi.hpPerBall * 3,
    `three balls cost ${withMulti}, the same as ${multi.hpPerBall * 3} one at a time`);
  assert.ok(withMulti > multi.hpPerBall,
    "but it must still cost more than a single drop, or multiball is immunity");
});

test("a shield covers whichever ball drops first, as the card says", () => {
  const g = start("foyer", ["splitter", "bulwark"]);    // two balls, one shield
  assert.equal(g.balls.length, 2);
  assert.equal(g.shields, 1);
  const hp = g.hp;
  g.loseBall(g.balls[0]);
  assert.equal(g.shields, 0, "the shield should have fired");
  assert.equal(g.hp, hp, "and covered the cost");
});

test("a shield eats the first drop and then stops", () => {
  const g = start("foyer", ["bulwark"]);
  assert.equal(g.shields, 1);
  g.launch();
  const hp = g.hp;
  g.loseBall(g.balls[0]);
  assert.equal(g.hp, hp, "the shield should have covered that");
  assert.equal(g.shields, 0);
  g.loseBall(g.balls[0]);
  assert.ok(g.hp < hp, "the second drop has to hurt");
});

// Robert reported "the paddle is sometimes moving on its own" and he was right:
// Chill Pit's ice used to be a bang-bang accelerator — full thrust toward the
// target from whichever side — with friction of about 1% of velocity per frame.
// It sailed past, pushed back just as hard, and swung to and fro forever.
// "Sometimes" was one arena in act 1.
test("the paddle comes to rest after a swipe, in every arena", () => {
  const fails = [];
  for (const a of S.ARENAS) {
    const g = start(a.id, []);
    g.paddle.x = 80; g.paddle.vx = 0;
    g.aimAt(300);                       // the swipe ends here; no input after it
    let settled = -1, overshoot = 0;
    for (let f = 0; f < 60 * 5; f++) {
      g.stepPaddle(1 / 60);
      overshoot = Math.max(overshoot, g.paddle.x - 300);
      if (settled < 0 && Math.abs(g.paddle.x - 300) < 1 && Math.abs(g.paddle.vx) < 20) settled = f;
    }
    if (settled < 0) fails.push(`${a.id}: never settles (${g.paddle.x.toFixed(0)}px, v=${g.paddle.vx.toFixed(0)})`);
    else if (settled > 60 * 2) fails.push(`${a.id}: takes ${(settled / 60).toFixed(1)}s to settle`);
    if (overshoot > 60) fails.push(`${a.id}: overshoots by ${overshoot.toFixed(0)}px`);
  }
  assert.deepEqual(fails, []);
});

test("but ice still slides — it is not just a slow paddle", () => {
  const g = start("chillpit", []);
  g.paddle.x = 80; g.paddle.vx = 0;
  g.aimAt(300);
  let overshoot = 0;
  for (let f = 0; f < 60 * 3; f++) { g.stepPaddle(1 / 60); overshoot = Math.max(overshoot, g.paddle.x - 300); }
  assert.ok(overshoot > 6, `ice overshot by only ${overshoot.toFixed(1)}px — that is not ice`);
});

test("a plain paddle does not overshoot at all", () => {
  const g = start("foyer", []);
  g.paddle.x = 80; g.paddle.vx = 0;
  g.aimAt(300);
  let overshoot = 0;
  for (let f = 0; f < 60 * 3; f++) { g.stepPaddle(1 / 60); overshoot = Math.max(overshoot, g.paddle.x - 300); }
  assert.ok(overshoot < 0.5, `a normal paddle overshot by ${overshoot.toFixed(1)}px`);
});

test("Time Warp slows the ball near the paddle and nowhere else", () => {
  const g = start("foyer", ["timewarp"]);
  const b = g.balls[0];
  b.y = 120;
  const high = g.ballSpeed(b);
  b.y = PADDLE_Y - 40;
  assert.ok(g.ballSpeed(b) < high * 0.7, "the whole point of the card");
});

test("Mirror World reverses the controls, exactly once", () => {
  const g = start("foyer", ["mirror"]);
  g.aimAt(100);
  assert.equal(g.paddle.target, 100);
  g.mirrorOn = true;
  g.aimAt(100);
  assert.equal(g.paddle.target, LW - 100);
});

test("armour blunts raw damage but yields to Piercing", () => {
  const g = start("anvil", ["sharpen", "sharpen", "sharpen", "sharpen"]);
  const brick = [...g.bricks.values()].find((b) => b.type.armour);
  const before = brick.hp;
  g.damageBrick(brick, g.ballDamage(g.balls[0]), null, "ball");
  const blunted = before - brick.hp;

  const g2 = start("anvil", ["drill", "drill", "heavy"]);
  const brick2 = [...g2.bricks.values()].find((b) => b.type.armour);
  const b2 = brick2.hp;
  g2.damageBrick(brick2, g2.ballDamage(g2.balls[0]), null, "ball");
  assert.ok(b2 - brick2.hp > blunted,
    `piercing did ${b2 - brick2.hp} where raw damage did ${blunted}`);
});

test("a chain reaction terminates instead of recursing forever", () => {
  const g = start("cascade", ["fireball", "explosive", "chain", "electric"]);
  g.launch();
  // Detonate by hand and make sure the call returns at all.
  const first = [...g.bricks.values()][0];
  g.damageBrick(first, 99, null, "test");
  assert.ok(g.remaining >= 0);
  assert.ok(Number.isFinite(g.score));
});

test("effects stack as duration, capped at twice the base", () => {
  const g = start("foyer", []);
  g.collect("wide"); g.collect("wide"); g.collect("wide"); g.collect("wide");
  assert.equal(g.effects.wide, S.POWERUPS.wide.dur * 2);
});
