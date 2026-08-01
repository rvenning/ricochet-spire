// Ricochet Spire — the app shell.
//
// Everything that touches the DOM lives here. game.js decides what is true in
// an arena, run.js decides what is true about the climb, and both only emit
// events; this file animates them, plays them and writes them down.
//
// Init runs on DOMContentLoaded rather than inline at the bottom of <body>: a
// first render before layout settles resolves viewport-relative clamp() font
// sizes against the inherited value, and only the FIRST screen comes out wrong,
// which is the kind of bug nobody reports and everybody notices.

const AVATARS = ["🔺", "🔥", "🪙", "💠", "🌀", "⚡", "🪞", "🐉", "🤖", "👑", "🦊", "🎲"];

const App = {
  profile: null,
  progress: null,
  cfg: null,               // the battleConfig of the arena in progress
  active: false,           // is the arena screen showing?
  paused: false,
  lastTs: 0,
  lbTab: "best",
  setup: { coreId: "vagrant", ascent: 0 },
  _hud: "",

  el(id) { return document.getElementById(id); },

  /* ------------------------------------------------------------------ boot */
  init() {
    Render.boot();
    this.wireGame();

    GK.UI.onScreenChange = (name) => {
      this.active = name === "game";
      if (name === "game") Render.resize();
      else Music.stop();
      if (name === "splash") this.refreshSplash();
    };

    GK.Profiles.init({
      storage: Storage,
      avatars: AVATARS,
      meta: (p, prog) => `🏆 ${(prog.bestScore || 0).toLocaleString()} · ` +
        `🔺 ${prog.wins || 0} climbed · 💠 ${Storage.shards(prog)}`,
      onEnter: (p) => this.enter(p),
      addLabel: "New Climber",
    });

    GK.initPWA({ appName: "Ricochet Spire" });
    GK.UI.bindSoundToggle(Storage);

    const settings = Storage.getSettings();
    Sfx.enabled = settings.sound !== false;
    Music.enabled = settings.music !== false;
    this.paintMusicButtons();

    this.refreshSplash();

    Storage.initFirebase().then((live) => {
      const badge = this.el("sync-badge");
      if (badge) badge.textContent = live ? "☁️ synced with the family" : "📴 this device only";
      if (live && GK.UI.screen === "profiles") GK.Profiles.renderList();
      if (live && GK.UI.screen === "splash") this.refreshSplash();
      if (live && GK.UI.screen === "leaderboard") this.showLeaderboard(this.lbTab);
    });

    GK.Debug.init({ storage: Storage, title: "RICOCHET SPIRE" })
      .action("+300 gold", () => { if (Run.state) Run.state.gold += 300; this.paintMapHud(); })
      .action("+200 shards", () => { if (Run.state) Run.state.shards += 200; })
      .action("clear room", () => { if (Game.running) { Game.remaining = 0; Game.boss && (Game.boss.dead = true); } })
      .action("full health", () => { if (Run.state) { Run.state.hp = Run.state.hpMax; this.paintMapHud(); } })
      .toggle("aim", "aim line");

    requestAnimationFrame((ts) => this.frame(ts));
  },

  frame(ts) {
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000 || 0);
    this.lastTs = ts;
    if (this.active) {
      if (Game.running && !this.paused) Game.tick(dt);
      Render.update(dt);
      // Fx gets REAL seconds: slow-motion must not slow its own recovery, and
      // skipping this leaves the screen flash and shake stuck on forever.
      Fx.update(dt);
      Tween.update(dt);
      Render.render();
      this.paintArenaHud();
    }
    GK.Debug.frame(dt);
    requestAnimationFrame((t) => this.frame(t));
  },

  /* ------------------------------------------------------------- the bridge */
  // One object assigned onto Game.on. Each handler is sound, particles and DOM
  // — never a decision. Decisions belong in the sim.
  wireGame() {
    Game.on = {
      launch: (d) => { Sfx.launch(); Fx.burst(d.x, d.y, "#35e0d0", 5, 110, 0.24, 1.8); },
      paddle: (d) => {
        if (d.charged) Sfx.charged(); else Sfx.paddle();
        Fx.dust(d.x, d.y, 4, "rgba(53,224,208,0.8)");
      },
      wall: () => Sfx.wall(),
      clank: (d) => { Sfx.clank(); Fx.burst(d.x, d.y, "#8b9bc4", 5, 120, 0.24, 1.8); },
      bumper: (d) => { Sfx.bumper(); Fx.burst(d.x, d.y, "#ffd24a", 8, 150, 0.3, 2); },
      portal: (d) => { Sfx.gate(); Fx.sparkle(d.x, d.y, "#a06bff", 8); },
      shoot: () => Sfx.laser(),
      arc: (d) => { Sfx.arc(); Fx.lightning(d.x1, d.y1, d.x2, d.y2, "#ffd24a"); },

      brickHit: (d) => {
        if (d.source === "ball") Sfx.brickHit(Game.combo);
        Fx.burst(d.x, d.y, d.brick.type.colors[1], 3, 90, 0.22, 1.6);
      },
      brickBreak: (d) => {
        Sfx.brickBreak(d.combo);
        Fx.burst(d.x, d.y, d.brick.type.colors[1], 9, 170, 0.36, 2.2);
        if (d.combo >= 6 && d.combo % 3 === 0) {
          Fx.text(d.x, d.y, `${d.combo}×`, { color: "#35e0d0", size: 15 });
        }
      },
      fuse: () => Sfx.fuse(),
      boom: (d) => {
        Sfx.boom();
        Fx.addShake(6);
        Fx.burst(d.x, d.y, "#ff8a3d", 22, 230, 0.5, 3);
        Fx.addFlash(0.16, "#ff8a3d");
      },

      drop: (d) => Fx.sparkle(d.x, d.y, POWERUPS[d.id] ? POWERUPS[d.id].color : "#fff", 5),
      pickup: (d) => {
        const p = POWERUPS[d.id];
        if (d.bad) { Sfx.badPickup(); Fx.addFlash(0.18, "#ff5470"); }
        else Sfx.pickup();
        GK.UI.toast(`${p.icon} ${p.name}`);
        this.paintPills();
      },
      effectEnd: () => this.paintPills(),

      shieldUsed: () => { Sfx.save(); Fx.addFlash(0.2, "#35e0d0"); GK.UI.toast("🧱 Bulwark held"); },
      save: (d) => { Sfx.save(); Fx.burst(d.x, LH - 8, "#35e0d0", 8, 150, 0.3, 2); },
      ballLost: (d) => {
        Sfx.hurt();
        Fx.addShake(9);
        Fx.addFlash(0.3, "#ff5470");
        Fx.text(d.x, LH - 70, `-${Game.hpPerBall}`, { color: "#ff5470", size: 19 });
      },
      heal: (d) => { Sfx.heal(); Fx.text(Game.paddle.x, PADDLE_Y - 30, `+${d.by}`, { color: "#35e0d0", size: 16 }); },
      split: () => Fx.addFlash(0.12, "#35e0d0"),
      gold: () => {},

      gravityShift: () => { Sfx.ruleShift(); GK.UI.toast("🧭 Gravity shifts"); Fx.addShake(5); },
      mirror: (d) => { if (d.on) { Sfx.ruleShift(); GK.UI.toast("🪞 Controls reversed"); } },
      chaos: (d) => { Sfx.ruleShift(); GK.UI.toast(`🎲 Chaos: ${d.flag}`); Fx.addFlash(0.2, "#a06bff"); },
      grow: () => GK.UI.toast("🌱 The bricks thicken"),
      beam: (d) => { if (d.on) Sfx.laser(); },

      bossHit: (d) => { Sfx.bossHit(); Fx.burst(d.x, d.y, "#ffa6d0", 6, 140, 0.28, 2); },
      bossBlock: (d) => { Sfx.bossBlock(); Fx.burst(d.x, d.y, "#8b9bc4", 5, 90, 0.24, 1.8); },
      bossPart: (d) => { Sfx.boom(); Fx.addShake(8); Fx.burst(d.x, d.y, "#ff3d92", 24, 220, 0.5, 3); },
      bossPhase: (d) => {
        Sfx.bossPhase();
        Fx.addFlash(0.3, "#ff3d92");
        Fx.addShake(10);
        GK.UI.toast(`Phase ${d.phase}`);
      },
      mimicked: (d) => GK.UI.toast(`🪞 It copied your ${d.flag}`),
      bossDown: () => {
        Sfx.bossDown();
        Fx.addShake(13);
        Fx.slowMo(0.35, 0.7);
        Fx.confetti(LW, LH, ["#35e0d0", "#ff3d92", "#a06bff", "#ffd24a"], 70);
      },

      end: (r) => this.arenaDone(r),
    };
  },

  /* ------------------------------------------------------------- navigation */
  play() {
    Sfx.init();
    GK.UI.showScreen("profiles");
    GK.Profiles.renderList();
  },

  refreshSplash() {
    const last = GK.Profiles.cfg && GK.Profiles.lastProfile();
    const btn = this.el("btn-continue-as");
    if (last) {
      btn.style.display = "";
      btn.textContent = `${last.avatar} Continue as ${last.name}`;
      btn.onclick = () => { Sfx.init(); GK.Profiles.select(last); };
      this.el("btn-start").textContent = "👥 Someone else";
    } else {
      btn.style.display = "none";
      this.el("btn-start").textContent = "▶ Enter the Spire";
    }
  },

  enter(p) {
    this.profile = p;
    this.progress = Storage.getProgress(p.id);
    this.showLobby();
  },

  showLobby() {
    this.progress = Storage.getProgress(this.profile.id);
    const pr = this.progress;
    this.el("lobby-who").textContent = `${this.profile.avatar} ${GK.util.esc(this.profile.name)}`;
    this.el("lobby-stats").innerHTML = [
      ["🏆", (pr.bestScore || 0).toLocaleString(), "best"],
      ["🔺", pr.wins || 0, "climbed"],
      ["💠", Storage.shards(pr), "shards"],
      ["🃏", Storage.collectionPct(pr) + "%", "seen"],
    ].map(([i, v, l]) => `<div><b>${i} ${v}</b><span>${l}</span></div>`).join("");

    const saved = Storage.loadRun(pr);
    const resume = this.el("btn-resume");
    if (saved) {
      resume.style.display = "";
      resume.textContent = `↩ Resume — Act ${saved.act}, ${saved.deck.length} cards`;
    } else resume.style.display = "none";

    const today = RNG.today();
    const daily = this.el("btn-daily");
    if (Storage.dailyDone(pr, today)) {
      daily.textContent = `🗓️ Daily done — ${(pr.daily.score || 0).toLocaleString()}`;
      daily.disabled = true;
    } else {
      daily.textContent = "🗓️ Daily Challenge";
      daily.disabled = false;
    }
    GK.UI.showScreen("lobby");
  },

  showHelp() { Sfx.click(); GK.UI.openModal("modal-help"); },

  toggleMusic() {
    Music.enabled = !Music.enabled;
    const s = Storage.getSettings(); s.music = Music.enabled; Storage.saveSettings(s);
    if (!Music.enabled) Music.stop();
    else if (this.active && Game.running) Music.play(this.cfg && this.cfg.boss ? "boss" : "climb");
    this.paintMusicButtons();
    Sfx.click();
  },
  paintMusicButtons() {
    document.querySelectorAll(".btn-music").forEach((b) => { b.textContent = Music.enabled ? "🎵" : "🔇"; });
  },

  /* ------------------------------------------------------------------ setup */
  showSetup() {
    Sfx.click();
    this.progress = Storage.getProgress(this.profile.id);
    const pr = this.progress;
    this.el("setup-shards").textContent = Storage.shards(pr);

    const owned = (c) => !c.locked || Storage.isUnlocked(pr, "core:" + c.id);
    if (!owned(CORE_BY_ID[this.setup.coreId])) this.setup.coreId = "vagrant";

    this.el("core-list").innerHTML = CORES.map((c) => {
      const have = owned(c);
      const kit = c.deck.map((id) => `${CARD_BY_ID[id].icon} ${CARD_BY_ID[id].name}`).join(" · ");
      return `<button class="core ${have ? "" : "locked"} ${this.setup.coreId === c.id ? "on" : ""}"
        ${have ? `onclick="App.pickCore('${c.id}')"` : "disabled"}>
        <span class="ico">${c.icon}</span>
        <span><h3>${c.name}${have ? "" : ` 🔒 ${c.shards}💠`}</h3>
        <p>${c.blurb}</p>
        <span class="kit">❤️ ${c.hp} · 🪙 ${c.gold} · ${kit}</span></span></button>`;
    }).join("");

    const max = Storage.maxAscent(pr);
    const wrap = this.el("ascent-pick");
    if (max <= 0) wrap.innerHTML = "";
    else {
      this.setup.ascent = Math.min(this.setup.ascent, max);
      let html = "";
      for (let i = 0; i <= max; i++) {
        html += `<button class="${this.setup.ascent === i ? "on" : ""}" onclick="App.pickAscent(${i})">` +
          (i === 0 ? "Base climb" : `Ascent ${"I".repeat(i)}`) + "</button>";
      }
      wrap.innerHTML = html;
    }
    GK.UI.showScreen("setup");
  },

  pickCore(id) { Sfx.click(); this.setup.coreId = id; this.showSetup(); },
  pickAscent(n) { Sfx.click(); this.setup.ascent = n; this.showSetup(); },

  beginClimb() {
    Sfx.cardTake();
    const serial = Storage.beginRun(this.profile.id);
    this.progress = Storage.getProgress(this.profile.id);
    // A normal climb wants a seed nobody can guess; the Daily wants one
    // everybody shares. This is the only Math.random in the game, and it is
    // deliberately outside the simulation.
    const seed = RNG.seedFrom(`${Date.now()}:${this.profile.id}:${Math.random()}`);
    Run.start({ seed, mode: "run", coreId: this.setup.coreId,
                unlocked: this.progress.unlocked || [], ascent: this.setup.ascent });
    Run.state.serial = serial;
    this.saveRun();
    this.showMap();
  },

  startDaily() {
    const today = RNG.today();
    this.progress = Storage.getProgress(this.profile.id);
    if (Storage.dailyDone(this.progress, today)) { Sfx.nope(); GK.UI.toast("Come back tomorrow"); return; }
    Sfx.cardTake();
    const serial = Storage.beginRun(this.profile.id);
    Run.start({ seed: RNG.seedFrom(today), mode: "daily", coreId: "vagrant",
                unlocked: this.progress.unlocked || [], ascent: 0 });
    Run.state.serial = serial;
    Run.state.date = today;
    this.saveRun();
    GK.UI.toast(`🗓️ ${today} — same climb for everyone`);
    this.showMap();
  },

  resumeClimb() {
    const saved = Storage.loadRun(Storage.getProgress(this.profile.id));
    if (!saved) { this.showLobby(); return; }
    Sfx.click();
    Run.restore(saved);
    this.routePending();
  },

  saveRun() {
    if (!Run.state || Run.state.over) return;
    const snap = Run.serialize();
    if (!snap) return;
    snap.serial = Run.state.serial;
    Storage.saveRun(this.profile.id, snap);
  },

  /* -------------------------------------------------------------- the map */
  showMap() {
    const s = Run.state;
    if (!s) { this.showLobby(); return; }
    if (s.pending) { this.routePending(); return; }

    const m = Run.map();
    const open = new Set(Run.options().map((n) => n.id));
    const visited = new Set(s.visited);

    const GAP = 74, PAD = 46;
    const wrap = this.el("map-wrap");
    const nodes = this.el("map-nodes");
    const height = (FLOORS - 1) * GAP + PAD * 2;
    nodes.style.height = height + "px";
    wrap.style.height = height + "px";

    const px = (n) => ({
      left: `${10 + (n.lane / (LANES - 1)) * 80}%`,
      bottom: `${PAD + n.floor * GAP}px`,
    });

    nodes.innerHTML = m.nodes.map((n) => {
      const p = px(n);
      const cls = ["node"];
      if (n.type === "boss") cls.push("boss");
      if (visited.has(n.id)) cls.push("done");
      if (s.nodeId === n.id) cls.push("here");
      if (open.has(n.id)) cls.push("open");
      const icon = { battle: "⚔️", elite: "☠️", event: "❔", shop: "🛒", rest: "🔥",
                     treasure: "📦", boss: "👁️" }[n.type];
      const label = { battle: "Battle", elite: "Elite", event: "Event", shop: "Shop",
                      rest: "Campfire", treasure: "Treasure", boss: m.bossKey }[n.type];
      return `<button class="${cls.join(" ")}" style="left:${p.left};bottom:${p.bottom}"
        aria-label="${label}" title="${label}"
        ${open.has(n.id) ? `onclick="App.enterNode('${n.id}')"` : "disabled"}>${icon}</button>`;
    }).join("");

    // Edges, drawn under the nodes. Percentages so it survives a resize.
    const svg = this.el("map-edges");
    svg.setAttribute("viewBox", `0 0 100 ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.height = height + "px";
    let lines = "";
    for (const n of m.nodes) {
      for (const id of n.to) {
        const t = m.byId[id];
        const x1 = 10 + (n.lane / (LANES - 1)) * 80, x2 = 10 + (t.lane / (LANES - 1)) * 80;
        const y1 = height - (PAD + n.floor * GAP), y2 = height - (PAD + t.floor * GAP);
        const lit = visited.has(n.id) && (visited.has(id) || open.has(id));
        lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
          `stroke="${lit ? "#35e0d0" : "#2a2158"}" stroke-width="0.5" vector-effect="non-scaling-stroke" ` +
          `stroke-dasharray="${lit ? "" : "4 4"}"/>`;
      }
    }
    svg.innerHTML = lines;

    this.el("act-line").textContent =
      `${s.mode === "daily" ? "Daily · " : ""}Act ${s.act} of ${ACTS} · ` +
      `${s.nodeId ? `floor ${s.floor + 1}` : "choose where to start"}` +
      (s.ascent ? ` · Ascent ${"I".repeat(s.ascent)}` : "");
    this.paintMapHud();
    GK.UI.showScreen("map");

    // Keep the next choice in view rather than the bottom of the act.
    const cur = m.byId[s.nodeId];
    const screen = this.el("screen-map");
    const focusFloor = cur ? cur.floor : 0;
    screen.scrollTop = Math.max(0, height - (focusFloor * GAP) - screen.clientHeight + 140);
  },

  paintMapHud() {
    const s = Run.state;
    if (!s) return;
    this.el("map-hp").textContent = `❤️ ${s.hp}/${s.hpMax}`;
    this.el("map-gold").textContent = `🪙 ${s.gold}`;
  },

  enterNode(id) {
    Sfx.click();
    if (!Run.enter(id)) return;
    this.saveRun();
    this.routePending();
  },

  // One switch decides which screen a pending state belongs on, so resuming a
  // saved climb lands exactly where it was left — including mid-shop.
  routePending() {
    const s = Run.state;
    if (!s) { this.showLobby(); return; }
    if (s.over) { this.showResults(); return; }
    const p = s.pending;
    if (!p) { this.showMap(); return; }
    if (p.kind === "battle") this.startArena();
    else if (p.kind === "reward") this.showReward();
    else if (p.kind === "shop") this.showShop();
    else if (p.kind === "event") this.showEvent();
    else if (p.kind === "rest") this.showRest();
    else if (p.kind === "treasure") this.showTreasure();
    else this.showMap();
  },

  /* ------------------------------------------------------------- the arena */
  startArena() {
    this.cfg = Run.battleConfig();
    this.paused = false;
    GK.UI.showScreen("game");
    Render.resize();
    Fx.reset();
    Game.start(this.cfg);
    this.paintPills();
    const kind = Run.currentNode().type;
    this.el("hud-hint").textContent = kind === "boss"
      ? `${BOSSES[this.cfg.boss].icon} ${BOSSES[this.cfg.boss].name} — ${BOSSES[this.cfg.boss].blurb}`
      : `${this.cfg.arena.name} — ${this.cfg.arena.twist}`;
    setTimeout(() => { const h = this.el("hud-hint"); if (h) h.textContent = ""; }, 4200);
    Music.play(this.cfg.boss ? "boss" : "climb");
  },

  paintArenaHud() {
    if (!Game.arena) return;
    const key = `${Game.hp}|${Math.round(Game.score)}|${Game.combo}`;
    if (key === this._hud) return;
    this._hud = key;
    this.el("hud-hp").textContent = `❤️ ${Math.max(0, Game.hp)}`;
    this.el("hud-score").textContent = Math.round(Game.score).toLocaleString();
    this.el("hud-combo").textContent = Game.combo >= 3 ? `${Game.combo}× combo` : "";
  },

  paintPills() {
    const wrap = this.el("hud-fx");
    if (!wrap || !Game.effects) return;
    wrap.innerHTML = Object.keys(Game.effects).map((id) => {
      const p = POWERUPS[id];
      return `<span class="pill ${p.bad ? "bad" : ""}">${p.icon} ${Math.ceil(Game.effects[id])}s</span>`;
    }).join("");
  },

  pause() {
    if (!Game.running) return;
    this.paused = true;
    Sfx.click();
    GK.UI.openModal("modal-pause");
  },
  resume() {
    this.paused = false;
    GK.UI.closeModal("modal-pause");
    Sfx.click();
  },
  abandonArena() {
    GK.UI.closeModal("modal-pause");
    this.paused = false;
    Game.abandon();
  },

  arenaDone(r) {
    Music.stop();
    if (r.abandoned) { Run.endRun(false); this.showResults(); return; }
    const pending = Run.battleDone(r, this.cfg);
    if (Run.state.over) { Sfx.climbLose(); this.showResults(); return; }
    Sfx.climbWin();
    this.saveRun();
    setTimeout(() => this.showReward(), 700);
  },

  /* ------------------------------------------------------------- the reward */
  showReward() {
    const p = Run.state.pending;
    if (!p || p.kind !== "reward") { this.showMap(); return; }
    const from = { boss: "The way is open", elite: "Hard-won", treasure: "Inside the chest",
                   rest: "You study by the fire", event: "Something changes hands" }[p.from]
                 || "The room is clear";
    this.el("reward-title").textContent = from;
    const bits = [];
    if (p.gold) bits.push(`+${p.gold} 🪙`);
    if (p.bonusShards) bits.push(`+${p.bonusShards} 💠`);
    bits.push(Run.deckFull() ? `deck full (${DECK_LIMIT}) — taking one means dropping one`
                             : `${Run.state.deck.length}/${DECK_LIMIT} cards`);
    this.el("reward-sub").textContent = bits.join(" · ");

    this.el("reward-cards").innerHTML = p.offer
      .map((id) => this.cardHTML(id, { onclick: `App.takeCard('${id}')` })).join("")
      || `<p class="pick-sub">Nothing left you can carry.</p>`;
    this.el("btn-skip").textContent = p.from === "treasure" || p.from === "rest"
      ? "Leave it" : "Skip — take 22 🪙";
    GK.UI.showScreen("reward");
  },

  takeCard(id) {
    if (Run.deckFull()) { this.askReplace(id); return; }
    if (!Run.takeCard(id)) { Sfx.nope(); return; }
    Sfx.cardTake();
    this.afterPending();
  },

  askReplace(id) {
    Sfx.click();
    this._incoming = id;
    const c = CARD_BY_ID[id];
    this.el("replace-sub").textContent = `Taking ${c.icon} ${c.name} means letting one of these go.`;
    this.el("replace-grid").innerHTML = Run.state.deck
      .map((d, i) => this.cardHTML(d, { onclick: `App.replaceWith('${d}')`, short: true, key: i })).join("");
    GK.UI.openModal("modal-replace");
  },

  replaceWith(dropId) {
    if (!Run.takeCard(this._incoming, dropId)) { Sfx.nope(); return; }
    Sfx.cardTake();
    GK.UI.closeModal("modal-replace");
    const c = CARD_BY_ID[dropId];
    GK.UI.toast(`Dropped ${c.icon} ${c.name}`);
    this.afterPending();
  },

  skipReward() {
    Sfx.click();
    Run.skipReward();
    this.afterPending();
  },

  afterPending() {
    this.saveRun();
    if (Run.state.over) this.showResults();
    else if (Run.state.pending) this.routePending();
    else this.showMap();
  },

  /* --------------------------------------------------------------- the shop */
  showShop() {
    const p = Run.state.pending;
    this.el("shop-gold").textContent = `🪙 ${Run.state.gold}`;
    const gone = new Set(p.bought);
    this.el("shop-cards").className = "card-row four";
    this.el("shop-cards").innerHTML = p.cards.map((c) => this.cardHTML(c.id, {
      onclick: `App.buy('card','${c.id}')`,
      cost: c.cost,
      dim: gone.has("card:" + c.id) || Run.state.gold < c.cost || Run.deckFull(),
      owned: gone.has("card:" + c.id),
    })).join("");

    this.el("shop-services").innerHTML = p.services.map((sv) => {
      const def = SHOP_SERVICES.find((x) => x.id === sv.id);
      const bought = gone.has("service:" + sv.id);
      const poor = Run.state.gold < sv.cost;
      return `<button class="service ${bought ? "gone" : poor ? "poor" : ""}"
        ${bought ? "disabled" : `onclick="App.buy('service','${sv.id}')"`}>
        <div class="ico">${def.icon}</div><div class="nm">${def.name}</div>
        <div class="ds">${def.desc}</div><div class="cost">🪙 ${sv.cost}</div></button>`;
    }).join("");
    GK.UI.showScreen("shop");
  },

  buy(kind, id) {
    const r = Run.buy(kind, id);
    if (!r.ok) {
      Sfx.nope();
      GK.UI.toast({ poor: "Not enough gold", full: `Deck is full (${DECK_LIMIT})`,
                    gone: "Already sold", locked: "Not yet" }[r.why] || "No");
      return;
    }
    Sfx.buy();
    this.saveRun();
    this.showShop();
  },

  leaveShop() {
    Sfx.click();
    Run.leaveShop();
    this.afterPending();
  },

  /* -------------------------------------------------------------- the event */
  showEvent() {
    const e = EVENT_BY_ID[Run.state.pending.id];
    this.el("event-icon").textContent = e.icon;
    this.el("event-name").textContent = e.name;
    this.el("event-text").textContent = e.text;
    this.el("event-choices").innerHTML = e.choices.map((c, i) => {
      const cant = c.need && c.need.gold > Run.state.gold;
      return `<button class="choice ${cant ? "locked" : ""}"
        ${cant ? "disabled" : `onclick="App.chooseEvent(${i})"`}>
        <b>${c.label}${c.need ? ` — 🪙 ${c.need.gold}` : ""}</b><span>${c.detail}</span></button>`;
    }).join("");
    GK.UI.showScreen("event");
  },

  chooseEvent(i) {
    const res = Run.eventChoose(i);
    if (!res) { Sfx.nope(); return; }
    Sfx.cardTake();
    if (res.msg) GK.UI.toast(res.msg);
    this.afterPending();
  },

  /* ----------------------------------------------------------- the campfire */
  showRest() {
    const s = Run.state;
    this.el("rest-text").textContent =
      `You are on ${s.hp} of ${s.hpMax} health, holding ${s.deck.length} cards. ` +
      `Nothing is trying to kill you here.`;
    this.el("rest-choices").innerHTML = REST_OPTIONS.map((o) =>
      `<button class="choice" onclick="App.chooseRest('${o.id}')">
        <b>${o.icon} ${o.name}</b><span>${o.desc}</span></button>`).join("");
    GK.UI.showScreen("rest");
  },

  chooseRest(id) {
    const r = Run.restChoose(id);
    if (!r) { Sfx.nope(); return; }
    Sfx.heal();
    if (r.healed) GK.UI.toast(`+${r.healed} health`);
    if (r.hpMax) GK.UI.toast(`+${r.hpMax} maximum health`);
    this.afterPending();
  },

  /* ------------------------------------------------------------ the treasure */
  showTreasure() {
    const p = Run.state.pending;
    const chest = CHESTS.find((c) => c.id === p.chest);
    this.el("chest-icon").textContent = chest.icon;
    this.el("chest-name").textContent = chest.name;
    this.el("chest-text").textContent =
      `Something inside is worth having. ${p.shards ? "You can feel a shard in there too." : ""}`;
    GK.UI.showScreen("treasure");
  },

  openChest() {
    const p = Run.openChest();
    if (!p) { this.showMap(); return; }
    Sfx.cardTake();
    Fx.confetti(LW, LH, ["#ffd24a", "#35e0d0"], 40);
    this.saveRun();
    this.showReward();
  },

  /* ------------------------------------------------------------- the ending */
  showResults() {
    const s = Run.state;
    Music.stop();
    if (!s._recorded) {
      s._recorded = true;
      const keys = [];
      for (let a = 1; a <= s.bossesDown; a++) keys.push(Run.map(a).bossKey);
      Storage.recordRun(this.profile.id, {
        win: s.win, shards: s.shardsEarned || s.shards, score: Math.round(s.score),
        depth: (s.act - 1) * FLOORS + Math.max(0, s.floor), deck: s.deck,
        ascent: s.ascent, mode: s.mode, date: s.date || RNG.today(),
        bossesDown: s.bossesDown, bossKeys: keys,
      });
      this.progress = Storage.getProgress(this.profile.id);
      if (s.win) { Sfx.climbWin(); Fx.confetti(LW, LH, ["#35e0d0", "#ff3d92", "#ffd24a"], 90); }
    }

    this.el("res-emoji").textContent = s.win ? "👑" : "💀";
    this.el("res-title").textContent = s.win
      ? (s.mode === "daily" ? "Daily conquered" : "The spire is yours")
      : `Fell on act ${s.act}, floor ${Math.max(1, s.floor + 1)}`;
    this.el("res-score").textContent = Math.round(s.score).toLocaleString();
    this.el("res-stats").innerHTML = [
      ["🔺", s.floorsCleared, "rooms cleared"],
      ["👁️", s.bossesDown, "bosses"],
      ["💠", s.shardsEarned || s.shards, "shards earned"],
    ].map(([i, v, l]) => `<div><b>${i} ${v}</b><span>${l}</span></div>`).join("");
    this.el("res-deck").innerHTML = s.deck
      .map((id) => `<span>${CARD_BY_ID[id].icon} ${CARD_BY_ID[id].name}</span>`).join("");
    GK.UI.showScreen("results");
  },

  confirmAbandon() { Sfx.click(); GK.UI.openModal("modal-abandon"); },
  parkClimb() {
    GK.UI.closeModal("modal-abandon");
    this.saveRun();
    Storage.flushProgress && Storage.flushProgress();
    GK.UI.toast("💾 Climb saved");
    this.showLobby();
  },
  abandonRun() {
    GK.UI.closeModal("modal-abandon");
    Run.endRun(false);
    this.showResults();
  },

  /* -------------------------------------------------------------- the cards */
  cardHTML(id, opts = {}) {
    const c = CARD_BY_ID[id];
    if (!c) return "";
    const combo = Run.state ? synergyWith(id, Run.state.deck) : [];
    const cls = ["gcard", c.rarity];
    if (combo.length && !opts.short) cls.push("combo");
    if (opts.dim) cls.push("poor");
    if (opts.owned) cls.push("owned");
    const tag = opts.short ? c.type
      : combo.length ? `combos with ${combo.map((x) => CARD_BY_ID[x].name).join(", ")}`
      : `${c.rarity} ${c.type}`;
    // The label matters: a card is a button full of nested spans, so without
    // it the control has no accessible name at all — invisible to a screen
    // reader and unidentifiable to anything driving the page.
    const aria = `${c.name} — ${c.rarity} ${c.type}${opts.cost != null ? `, ${opts.cost} gold` : ""}`;
    return `<button class="${cls.join(" ")}" aria-label="${aria}" title="${c.name}: ${c.desc}"
      ${opts.owned ? "disabled" : `onclick="${opts.onclick}"`}>
      <span class="ico">${c.icon}</span>
      <span class="nm">${c.name}</span>
      ${opts.short ? "" : `<span class="ds">${c.desc}</span>`}
      <span class="tag">${tag}</span>
      ${opts.cost != null ? `<span class="cost">🪙 ${opts.cost}</span>` : ""}
    </button>`;
  },

  showDeck() {
    Sfx.click();
    const s = Run.state;
    if (!s) return;
    const counts = {};
    for (const id of s.deck) counts[id] = (counts[id] || 0) + 1;
    this.el("deck-title").textContent = `🃏 Your deck — ${s.deck.length}/${DECK_LIMIT}`;
    this.el("deck-grid").innerHTML = Object.entries(counts).map(([id, n]) => {
      const c = CARD_BY_ID[id];
      return `<div class="gcard ${c.rarity}"><span class="ico">${c.icon}</span>
        <span class="nm">${c.name}${n > 1 ? ` ×${n}` : ""}</span>
        <span class="tag">${c.type}</span></div>`;
    }).join("");
    GK.UI.openModal("modal-deck");
  },

  /* ------------------------------------------------------------ leaderboard */
  showLeaderboard(tab) {
    this.lbTab = tab || this.lbTab;
    Sfx.click();
    const today = RNG.today();
    this.el("tab-best").classList.toggle("active", this.lbTab === "best");
    this.el("tab-daily").classList.toggle("active", this.lbTab === "daily");

    if (this.lbTab === "daily") {
      GK.Profiles.renderLeaderboard("lb-rows", {
        cols: (r) => {
          const d = r.progress.daily || {};
          const ok = d.date === today;
          return `<span class="lb-stat">${ok ? `🗓️ ${(d.score || 0).toLocaleString()}` : "—"}</span>` +
                 `<span class="lb-stat">${ok && d.win ? "👑" : ""}</span>`;
        },
        sort: (a, b) => {
          const sa = (a.progress.daily || {}).date === today ? a.progress.daily.score : -1;
          const sb = (b.progress.daily || {}).date === today ? b.progress.daily.score : -1;
          return sb - sa;
        },
        meId: this.profile && this.profile.id,
        empty: "Nobody has run today's spire yet.",
      });
    } else {
      GK.Profiles.renderLeaderboard("lb-rows", {
        cols: (r) => `<span class="lb-stat">🏆 ${(r.progress.bestScore || 0).toLocaleString()}</span>` +
                     `<span class="lb-stat">🔺 ${r.progress.wins || 0}</span>`,
        sort: (a, b) => (b.progress.bestScore || 0) - (a.progress.bestScore || 0),
        meId: this.profile && this.profile.id,
        empty: "No climbs yet — go first.",
      });
    }
    GK.UI.showScreen("leaderboard");
  },

  /* ---------------------------------------------------------------- archive */
  showArchive() {
    Sfx.click();
    this.progress = Storage.getProgress(this.profile.id);
    const pr = this.progress;
    const shards = Storage.shards(pr);
    this.el("archive-shards").textContent = shards;
    this.el("archive-hint").textContent =
      `Shards come home from every climb, won or lost. Everything here is yours for good — ` +
      `and none of it makes the spire easier, only stranger. ` +
      `You have seen ${(pr.seen || []).length} of ${CARDS.length} cards.`;

    const groups = {};
    for (const u of UNLOCKS) (groups[u.group] = groups[u.group] || []).push(u);

    this.el("archive-list").innerHTML = Object.entries(groups).map(([name, items]) => {
      const rows = items.map((u) => {
        const owned = Storage.isUnlocked(pr, u.id);
        const blocked = u.needs && !Storage.isUnlocked(pr, u.needs);
        const cant = !owned && (blocked || shards < u.shards);
        const card = u.kind === "card" ? CARD_BY_ID[u.ref] : null;
        const icon = u.icon || (card && card.icon) || "💠";
        const title = u.name || (card && card.name) || u.ref;
        const desc = u.desc || (card && card.desc) || "";
        return `<button class="arch ${owned ? "owned" : cant ? "cant" : ""}"
          ${owned ? "disabled" : `onclick="App.buyUnlock('${u.id}')"`}>
          <span class="ico">${icon}</span>
          <span><b>${title}</b><small>${desc}</small></span>
          <span class="price">${owned ? "owned" : `💠 ${u.shards}`}</span></button>`;
      }).join("");
      return `<div class="arch-group">${name}</div>${rows}`;
    }).join("");
    GK.UI.showScreen("archive");
  },

  buyUnlock(id) {
    const r = Storage.buyUnlock(this.profile.id, id);
    if (!r.ok) {
      Sfx.nope();
      GK.UI.toast({ shards: "Not enough shards", locked: "Clear the one below it first",
                    owned: "Already yours" }[r.why] || "No");
      return;
    }
    Sfx.cardTake();
    Fx.confetti(LW, LH, ["#35e0d0", "#a06bff"], 30);
    GK.UI.toast(`💠 ${UNLOCK_BY_ID[id].name || id} unlocked`);
    this.showArchive();
  },
};

// Init on DOMContentLoaded, not inline at the bottom of <body>: a first render
// before layout settles resolves viewport-relative clamp() font sizes against
// the inherited value, and only the first screen comes out wrong.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => App.init());
else App.init();
