// Ricochet Spire — pure collision maths.
//
// No state, no DOM, no randomness: every function here takes numbers and
// returns numbers, which is what lets tests/physics.test.js pin down the two
// behaviours a brick breaker lives or dies by — a ball that never tunnels
// through a brick, and a ball that never settles into a loop the player can't
// break out of.

const Physics = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },

  // Shortest push-out of a circle from an axis-aligned rectangle, or null when
  // they don't overlap. `nx/ny` is the unit axis of LEAST penetration and
  // `depth` is how far along it the circle has to move to be clear — resolving
  // on the shallowest axis is what stops a ball clipping a brick's corner and
  // being flung sideways along the wall of bricks.
  circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nearX = Physics.clamp(cx, rx, rx + rw);
    const nearY = Physics.clamp(cy, ry, ry + rh);
    const dx = cx - nearX, dy = cy - nearY;
    const d2 = dx * dx + dy * dy;

    if (d2 > r * r) return null;

    if (d2 > 1e-9) {
      // Centre is outside the rect: the contact normal points out of the
      // nearest edge or corner.
      const d = Math.sqrt(d2);
      return { nx: dx / d, ny: dy / d, depth: r - d };
    }

    // Centre is INSIDE the rect (a fast ball that arrived mid-substep). Pick
    // the face it is closest to and push it out through that one.
    const left = cx - rx, right = rx + rw - cx;
    const top = cy - ry, bottom = ry + rh - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { nx: -1, ny: 0, depth: left + r };
    if (m === right) return { nx: 1, ny: 0, depth: right + r };
    if (m === top) return { nx: 0, ny: -1, depth: top + r };
    return { nx: 0, ny: 1, depth: bottom + r };
  },

  // Reflect a velocity about a unit normal.
  reflect(vx, vy, nx, ny) {
    const d = 2 * (vx * nx + vy * ny);
    return { vx: vx - d * nx, vy: vy - d * ny };
  },

  // Rescale a velocity to an exact speed, preserving direction. A zero vector
  // is sent straight up rather than producing NaN.
  atSpeed(vx, vy, speed) {
    const m = Math.hypot(vx, vy);
    if (m < 1e-6) return { vx: 0, vy: -speed };
    return { vx: (vx / m) * speed, vy: (vy / m) * speed };
  },

  // The anti-boredom guarantee. Left alone, a brick breaker ball finds two
  // degenerate states: a near-horizontal drift that ping-pongs between the
  // side walls forever, and a perfectly vertical bounce that can only ever hit
  // one column. Both are unplayable, and both are silent — nothing errors, the
  // level just never ends.
  //
  // So the direction is clamped into a band: at least MIN_VY of the speed must
  // be vertical, and at least MIN_VX horizontal. Applied after every bounce.
  //
  // MIN_VX is the load-bearing one and it was originally far too small. A
  // player (or a bot) who parks the paddle exactly under the ball hits it dead
  // centre, gets it back dead centre, and does that forever — the ball crawls
  // sideways a few degrees at a time and an arena of twenty bricks runs out
  // the clock. At 0.30 a centred hit still leaves ~17 degrees off vertical,
  // which crosses the whole field between bounces. The headless bots found
  // this: an idle paddle was clearing arenas and a perfect one was not.
  unstick(vx, vy, speed) {
    const MIN_VY = 0.28;   // ~16 degrees off horizontal
    const MIN_VX = 0.30;   // ~17 degrees off vertical
    let ux = vx / speed, uy = vy / speed;
    const sy = uy < 0 ? -1 : 1;
    const sx = ux < 0 ? -1 : 1;

    if (Math.abs(uy) < MIN_VY) {
      uy = sy * MIN_VY;
      ux = sx * Math.sqrt(Math.max(0, 1 - MIN_VY * MIN_VY));
    }
    if (Math.abs(ux) < MIN_VX) {
      ux = sx * MIN_VX;
      uy = sy * Math.sqrt(Math.max(0, 1 - MIN_VX * MIN_VX));
    }
    const m = Math.hypot(ux, uy) || 1;
    return { vx: (ux / m) * speed, vy: (uy / m) * speed };
  },

  // Where the paddle hits the ball decides where it goes: dead centre sends it
  // straight up, the outer edge sends it away at MAX_ANGLE. This is the whole
  // skill ceiling of the genre, so it is a plain function of the offset rather
  // than a reflection off the paddle's surface.
  paddleBounce(offset, speed) {
    const MAX_ANGLE = 1.13;                       // ~65 degrees from vertical
    const a = Physics.clamp(offset, -1, 1) * MAX_ANGLE;
    return { vx: Math.sin(a) * speed, vy: -Math.cos(a) * speed };
  },

  // Ballistic prediction: where does a ball travelling in a straight line
  // reach `targetY`, reflecting off two side walls? Used by the renderer's aim
  // guide and by the bots — both must agree with the sim, so there is one copy.
  predictX(x, y, vx, vy, targetY, minX, maxX) {
    if (vy <= 0) return x;                        // going up: no landing yet
    const span = maxX - minX;
    if (span <= 0) return x;
    const t = (targetY - y) / vy;
    let px = x + vx * t - minX;
    // Fold the unbounded travel back into [0, span) with a triangle wave.
    px = ((px % (span * 2)) + span * 2) % (span * 2);
    if (px > span) px = span * 2 - px;
    return px + minX;
  },
};

if (typeof module !== "undefined") module.exports = { Physics };
