// Ricochet Spire — the power-ups that fall out of bricks.
//
// These are the SHORT game: temporary buffs that last part of one arena, as
// opposed to cards, which last the whole run. They exist so a bad arena can
// still turn around, and so there is a reason to chase a brick you don't need.
//
// A timed power-up is pure data — the sim derives paddle width, ball speed and
// so on from `Game.effects` every frame — so adding one is usually a single
// entry here plus one line where the derived value is computed. Instants get an
// `apply(g)`.
//
// Two of them are BAD. A falling pickup you have to decide about is more
// interesting than one you always want, and the bad ones are drawn in warning
// colours so the decision is readable at a glance.

const POWERUPS = {
  wide:   { name: "Wide Paddle", icon: "↔", color: "#35e0d0", kind: "timed", dur: 15, weight: 10 },
  slow:   { name: "Slow Ball", icon: "🐢", color: "#7cc5ff", kind: "timed", dur: 13, weight: 9 },
  pierce: { name: "Piercing", icon: "🔻", color: "#ff9a3d", kind: "timed", dur: 11, weight: 7 },
  beam:   { name: "Beam", icon: "⚡", color: "#ffd24a", kind: "timed", dur: 13, weight: 8 },
  pull:   { name: "Magnet", icon: "🧲", color: "#a06bff", kind: "timed", dur: 13, weight: 7 },
  power:  { name: "Power Hit", icon: "💪", color: "#ff3d92", kind: "timed", dur: 12, weight: 8 },

  multi:  { name: "Multiball", icon: "3×", color: "#35e0d0", kind: "instant", weight: 9,
            apply(g) { g.splitBalls(3); } },
  bomb:   { name: "Airburst", icon: "💣", color: "#ff6a3d", kind: "instant", weight: 6,
            apply(g) { g.burstLowest(2.4); } },
  mend:   { name: "Repair", icon: "❤️", color: "#ff5470", kind: "instant", weight: 6,
            apply(g) { g.healRun(7); } },
  purse:  { name: "Purse", icon: "🪙", color: "#ffd24a", kind: "instant", weight: 7,
            apply(g) { g.addGold(22); } },

  // The two you dodge.
  shrink: { name: "Shrink", icon: "↕", color: "#ff5470", kind: "timed", dur: 11, weight: 5, bad: true },
  rush:   { name: "Overheat", icon: "🔥", color: "#ff5470", kind: "timed", dur: 10, weight: 5, bad: true },
};

for (const [id, p] of Object.entries(POWERUPS)) p.id = id;

const POWERUP_LIST = Object.values(POWERUPS);

// Weighted draw. The rng is always a seeded generator handed down from the run,
// never Math.random — see js/rng.js for why.
function pickPowerup(rng, luck = 1) {
  return rng.weighted(POWERUP_LIST, (p) => (p.bad ? p.weight / luck : p.weight * luck));
}

if (typeof module !== "undefined") module.exports = { POWERUPS, POWERUP_LIST, pickPowerup };
