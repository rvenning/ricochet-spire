// Ricochet Spire — events, shops and treasure.
//
// Everything here is DATA. An event's outcome is an object of well-known keys
// (`gold`, `hp`, `heal`, `card`, `bane`, `shards`) that run.js knows how to
// apply — never a function that reaches into the run and does its own thing.
// That is what lets tests/events.test.js prove every branch of every event is
// applicable, that no choice is strictly worse than another for free, and that
// a run can't be handed a card id that no longer exists.
//
// Outcome keys:
//   gold    +/- gold, applied before anything else
//   hp      +/- current health (negative is the cost of a gamble)
//   hpMax   +/- maximum health
//   heal    heal this much, capped at max
//   card    { rarity } — offer a card of that rarity to pick from three
//   bane    a specific card id, taken whether you like it or not
//   shards  permanent currency, straight into the Archive
//   need    { gold } — the choice is greyed out unless you can pay

const EVENTS = [
  { id: "brazier", name: "The Cold Brazier", icon: "🔥",
    text: "A brazier on the landing, long dead. Something is still warm underneath the ash.",
    choices: [
      { label: "Rake it out", detail: "Take a burn, take the coin.",
        out: { hp: -8, gold: 78, msg: "You come away singed and richer." } },
      { label: "Leave it", detail: "Warm your hands and move on.",
        out: { heal: 10, msg: "The last of the heat does you good." } },
    ] },

  { id: "cartographer", name: "The Cartographer", icon: "🗺️",
    text: "A woman is drawing the spire from the inside, which cannot be done. She offers you a page.",
    choices: [
      { label: "Buy the page", detail: "Costs 65 gold. She knows a card you'd want.",
        need: { gold: 65 }, out: { gold: -65, card: { rarity: "rare" }, msg: "She was right." } },
      { label: "Ask what she wants", detail: "Trade health for knowledge.",
        out: { hpMax: -6, card: { rarity: "uncommon" }, msg: "She takes a little of your future." } },
      { label: "Walk past", detail: "Nothing ventured.",
        out: { gold: 18, msg: "You pocket a coin she dropped." } },
    ] },

  { id: "wager", name: "The Wager", icon: "🎲",
    text: "A hooded figure sets three cups on a step. \"Double or nothing,\" it says, \"on your health.\"",
    choices: [
      { label: "Take the wager", detail: "Lose 14 health. Gain a rare card and 60 gold.",
        out: { hp: -14, gold: 60, card: { rarity: "rare" }, msg: "Painful. Worth it." } },
      { label: "Refuse politely", detail: "It shrugs and gives you the cups.",
        out: { gold: 30, msg: "The cups were silver." } },
    ] },

  { id: "forge", name: "The Guttering Forge", icon: "⚒️",
    text: "A forge with no smith. The bellows still work if you pump them yourself.",
    choices: [
      { label: "Work the bellows", detail: "Hard graft. A sharper ball.",
        out: { hp: -6, bane: null, card: { rarity: "uncommon", type: "ball" }, msg: "You make something." } },
      { label: "Melt down your coin", detail: "Spend 80 gold for lasting health.",
        need: { gold: 80 }, out: { gold: -80, hpMax: 16, heal: 16, msg: "Reforged, and steadier." } },
      { label: "Take the scrap", detail: "There is always scrap.",
        out: { gold: 42, msg: "Enough to be going on with." } },
    ] },

  { id: "fountain", name: "Still Water", icon: "⛲",
    text: "A fountain runs uphill. The water is very clear and slightly wrong.",
    choices: [
      { label: "Drink deep", detail: "Full health, and something clings to you.",
        out: { heal: 999, bane: "growing", msg: "You feel wonderful. The bricks look thicker." } },
      { label: "Sip", detail: "A modest, honest heal.",
        out: { heal: 14, msg: "Cool and ordinary." } },
      { label: "Fill a flask", detail: "Carry it instead.",
        out: { hpMax: 10, msg: "You'll be glad of it later." } },
    ] },

  { id: "mirrorman", name: "The Man in the Mirror", icon: "🪞",
    text: "Your reflection is a half-step behind. It taps the glass and points at your deck.",
    choices: [
      { label: "Shake its hand", detail: "It gives you power and takes your bearings.",
        out: { card: { rarity: "rare" }, bane: "mirror", msg: "Left is right for a while now." } },
      { label: "Break the glass", detail: "Seven years, or 20 health.",
        out: { hp: -20, shards: 24, msg: "Shards. Literally." } },
      { label: "Nod and leave", detail: "It nods back.",
        out: { heal: 6, msg: "A civil encounter." } },
    ] },

  { id: "collector", name: "The Collector's Landing", icon: "🏺",
    text: "Shelves of things taken from climbers who did not finish. Some of it is yours already.",
    choices: [
      { label: "Take a relic", detail: "Costs 55 gold.",
        need: { gold: 55 }, out: { gold: -55, card: { rarity: "uncommon" }, msg: "It fits your hand." } },
      { label: "Take two", detail: "Costs 120 gold. Greedy.",
        need: { gold: 120 }, out: { gold: -120, card: { rarity: "rare" }, shards: 12, msg: "Both, then." } },
      { label: "Leave it be", detail: "Superstition is free.",
        out: { shards: 8, msg: "You find a shard on the way out." } },
    ] },

  { id: "gauntlet", name: "The Narrow Stair", icon: "🪜",
    text: "The stair narrows until you must choose: squeeze through, or take the long way round.",
    choices: [
      { label: "Squeeze through", detail: "It costs you, but you arrive early.",
        out: { hp: -12, gold: 55, card: { rarity: "common" }, msg: "Bruised, but ahead." } },
      { label: "The long way", detail: "Rest as you go.",
        out: { heal: 18, msg: "You take your time." } },
    ] },

  { id: "hoard", name: "The Loose Brick", icon: "🧱",
    text: "One brick in the wall is a different colour. It moves when you push it.",
    choices: [
      { label: "Pull it out", detail: "Something behind it. Something else too.",
        out: { gold: 96, hp: -9, msg: "Gold, and a very cross spider." } },
      { label: "Push it in", detail: "A door opens somewhere below.",
        out: { shards: 18, msg: "You hear a lock turn." } },
      { label: "Leave the wall alone", detail: "Sensible.",
        out: { heal: 8, gold: 12, msg: "Nothing happens, restfully." } },
    ] },

  { id: "duel", name: "The Idle Champion", icon: "⚔️",
    text: "A climber sits on the landing eating an apple. \"Spar with me,\" she says. \"I'm bored.\"",
    choices: [
      { label: "Spar", detail: "You will lose. You will also learn.",
        out: { hp: -16, card: { rarity: "rare", type: "paddle" }, msg: "She shows you the trick of it." } },
      { label: "Share the apple", detail: "She has another.",
        out: { heal: 12, gold: 24, msg: "It was a very good apple." } },
    ] },

  { id: "shrine", name: "The Shrine of Small Losses", icon: "🕯️",
    text: "A shrine to everything dropped on the way up. Offerings are expected.",
    choices: [
      { label: "Offer gold", detail: "Give 70 gold, gain lasting health.",
        need: { gold: 70 }, out: { gold: -70, hpMax: 22, heal: 22, msg: "The shrine approves." } },
      { label: "Offer blood", detail: "Give 15 health, gain a card.",
        out: { hp: -15, card: { rarity: "uncommon" }, msg: "Accepted." } },
      { label: "Sweep the steps", detail: "Costs nothing but your time.",
        out: { heal: 8, shards: 5, msg: "The shrine is grateful, in its small way." } },
    ] },

  { id: "engine", name: "The Sleeping Engine", icon: "⚙️",
    text: "Something enormous is running below the floor, very slowly. There is a lever.",
    choices: [
      { label: "Pull the lever", detail: "Whatever it does, it does it hard.",
        out: { card: { rarity: "rare" }, bane: "chaos", msg: "The spire shudders and rearranges." } },
      { label: "Oil the bearings", detail: "Costs 45 gold. Everything runs smoother.",
        need: { gold: 45 }, out: { gold: -45, card: { rarity: "uncommon", type: "utility" }, msg: "It purrs." } },
      { label: "Tiptoe past", detail: "Let sleeping engines lie.",
        out: { heal: 10, shards: 6, msg: "You leave it sleeping." } },
    ] },
];

const EVENT_BY_ID = {};
for (const e of EVENTS) EVENT_BY_ID[e.id] = e;

// ------------------------------------------------------------------- shops
// A shop always stocks four cards and two services. Prices scale with the act
// so gold keeps meaning something on floor 30.
const SHOP_SERVICES = [
  { id: "heal", name: "A hot meal", icon: "🍲", desc: "Restore 22 health.",
    cost: 55, out: { heal: 22 } },
  { id: "hpMax", name: "Reinforced frame", icon: "🦾", desc: "+20 maximum health, and heal it.",
    cost: 105, out: { hpMax: 20, heal: 20 } },
  { id: "shard", name: "Buy a shard", icon: "💠", desc: "Trade gold for one Archive shard.",
    cost: 90, out: { shards: 14 } },
  { id: "reroll", name: "Fresh stock", icon: "🔁", desc: "Restock this shop once.",
    cost: 45, out: { reroll: true } },
];

const CARD_PRICE = { common: 62, uncommon: 96, rare: 148, legendary: 235 };

// ---------------------------------------------------------------- treasure
// A treasure room is a free card plus a purse. `tier` is which chest you found.
const CHESTS = [
  { id: "small", name: "Iron Chest", icon: "📦", weight: 50,
    gold: [30, 55], rarity: "common", shards: 0 },
  { id: "medium", name: "Brass Chest", icon: "🧰", weight: 35,
    gold: [55, 90], rarity: "uncommon", shards: 6 },
  { id: "large", name: "Gilded Chest", icon: "🎁", weight: 15,
    gold: [90, 150], rarity: "rare", shards: 14 },
];

// ------------------------------------------------------------------- rests
const REST_OPTIONS = [
  { id: "sleep", name: "Sleep", icon: "🛏️", desc: "Heal 34% of your maximum health." },
  { id: "study", name: "Study", icon: "📖", desc: "Take one card of your choosing from three." },
  { id: "dig", name: "Dig in", icon: "⛏️", desc: "+12 maximum health, and heal it." },
];

if (typeof module !== "undefined") {
  module.exports = { EVENTS, EVENT_BY_ID, SHOP_SERVICES, CARD_PRICE, CHESTS, REST_OPTIONS };
}
