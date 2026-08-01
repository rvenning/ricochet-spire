# Ricochet Spire 🔺

**Climb. Bounce. Break.** A roguelite deck-builder wearing Breakout's clothes —
draft a deck of ball, paddle and rule cards, pick your own route up a branching
spire, and find out what your build does to the thing at the top.

Familiar for the first minute. Then Gravity Shift turns up, and it isn't.

**Play it: https://rvenning.github.io/ricochet-spire/**

Ages 13+.

---

## What a run looks like

```
Act I  ──▶  11 rooms  ──▶  BOSS
Act II ──▶  11 rooms  ──▶  BOSS
Act III──▶  11 rooms  ──▶  THE MIMIC
```

Every act is a branching map. You choose the route: battles, elites, shops,
events, treasure and a campfire before the boss. Health carries across the
*whole* climb, so a dropped ball in act I is still costing you in act III.
Death ends the run — but shards come home either way, and the Archive
remembers.

Runs take 20–40 minutes, and they save after every room. Close the tab and the
lobby offers to pick the climb back up exactly where it was.

## Features

- **48 cards** across ball, paddle, rule and utility types, drafted one room at
  a time. Fireball + Explosive Ball + Chain Lightning is a different game to
  Sticky Paddle + Laser + Splitter, and the game tells you which of your cards
  a new one combos with.
- **A 12-card deck limit.** Past that, taking a card means giving one up.
- **30 hand-built arenas**, each with a twist — conveyors, portals, black
  holes, sliding steel, blinking light columns, ice, darkness, drifting walls.
- **5 bosses with multiple phases.** The Fortress hides behind armour plates,
  the Serpent lets the ball straight through its body, the Architect rebuilds
  the room while you fight it, Gravity Core decides which way is down, and the
  Mimic turns up holding your own deck.
- **Rule cards** that change the game rather than the numbers: Gravity Shift,
  Mirror World, Chaos, Growing Bricks, Time Warp, Ricochet Master.
- **A Daily Challenge** — one seed a day, the same map, the same arenas, the
  same three cards on floor four for everybody, with its own leaderboard tab.
- **The Archive**: shards buy new cards, new climbers, new bosses and three
  Ascents. None of it makes the spire easier, only stranger.
- **Family profiles** with optional PINs, a shared leaderboard, and progress
  synced across every device in the house.
- Installable as an app, and it plays offline.

## Built on gamekit

Profiles, PINs, storage + family sync, the sound engine, screens and modals,
the juice layer and the PWA install all come from
[gamekit](https://github.com/rvenning/gamekit), vendored into `lib/`.

Re-vendor after a kit change:

```bash
node "../gamekit/tools/sync-to-game.js" "../ricochet-spire"
```

Then bump `CACHE` in `sw.js`, or devices keep serving the copy they already
have.

## How it is put together

No build step, no framework — plain `<script>` tags.

| File | What it is |
|---|---|
| `js/rng.js` | Deterministic seeded randomness. Every draw is keyed on *where* it happens, never on how many came before — which is what makes the Daily identical for everybody and a saved run rebuildable from `{seed, act, floor, path, deck}` alone. |
| `js/game.js` | The arena simulation. No DOM, no canvas, no audio, no `Math.random`. Fixed 1/60 step. |
| `js/run.js` | The climb: map generation, the deck, health and gold, node resolution. Also DOM-free. |
| `js/render.js` | Canvas renderer and arena input. Owns no state. |
| `js/main.js` | Screens, wiring, the frame loop — everything that touches the DOM. |
| `js/cards.js` `bricks.js` `arenas.js` `bosses.js` `events.js` `unlocks.js` `powerups.js` | Data registries. Adding content is an entry in one of these. |

Keeping the two simulations free of the DOM is what lets `tests/bot.test.js`
run the real engine headlessly.

## Tests

```bash
node --test
```

100+ checks with no dependencies: card and arena linters (including a flood
fill proving no scoring brick is sealed behind steel), map generation checked
over 200 seeds for reachability and non-crossing edges, save-merge rules, and
four balance bots.

The bots are the interesting part:

```bash
node tests/bot.test.js --report
```

- **ace** — reads the bounce perfectly. Nothing may be unwinnable by it.
- **climber** — the tuning target: reacts on a delay, aims a little off, gets
  confused for a second every time Mirror World flips.
- **idle** — never touches the controls. If putting the mouse down clears a
  room, that room has nothing in it.
- **greedy** — the strongest known synergy, on purpose. It must not erase act
  three.

## Local development

```bash
npx http-server . -p 8111 -c-1
```

Then open http://localhost:8111. `?debug=1` adds a dev panel — note that it
suppresses saving by design, so never check persistence on a debug URL.

Regenerate the icons with `node tools/make-icons.js`.

## Storage

Progress lives in `localStorage` under the `rs_` prefix and syncs to the
`ricochetspire` Firestore collection in the shared family project. The API key
in `js/firebase-config.js` is a public client config, not a secret — it is
restricted to the Cloud Firestore API and the rules require an anonymous
sign-in.

Shards are stored as two monotonic counters (`shardsEarned` / `shardsSpent`)
with the balance derived, so syncing an older device can never refund something
you have already bought.
