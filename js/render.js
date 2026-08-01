// Ricochet Spire — the canvas renderer and the arena's input.
//
// Passive by design: this file owns no loop and no game state. main.js drives
// the frame; game.js decides what is true; this reads that state and paints it.
// That split is what keeps game.js free of the DOM, and therefore testable.
//
// Two canvas rules the family games learned the hard way, both applied below:
//
//   * The canvas takes its DISPLAY size from the stylesheet (width/height
//     100%) and only its BACKING STORE from here. Setting an inline pixel size
//     in resize() is correct for exactly as long as it takes something else to
//     reflow, after which the canvas hangs off the bottom of its stage with
//     every number the game computed looking perfectly self-consistent.
//
//   * Size drift is noticed in the loop rather than hunted down. A stage can
//     resize with no resize event at all — a web font landing, a HUD pill
//     appearing — so every frame cheaply checks whether the box still matches.

const Render = {
  cv: null, ctx: null, stage: null,
  W: 0, H: 0, scale: 1, ox: 0, oy: 0,
  t: 0,
  keys: { left: false, right: false },
  pointerX: null,

  boot() {
    this.cv = document.getElementById("cv");
    this.ctx = this.cv.getContext("2d");
    this.stage = document.getElementById("stage");

    const remeasure = () => {
      this.resize();
      // iOS settles its viewport lazily — toolbars, rotation, standalone
      // launch — so measure again once it has stopped moving.
      setTimeout(() => this.resize(), 350);
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", remeasure);
      window.visualViewport.addEventListener("scroll", () => this.resize());
    }
    // iOS ignores user-scalable=no for pinch, and only closing the tab undoes
    // a zoom once it has happened. Block it at the source.
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    document.addEventListener("gesturechange", (e) => e.preventDefault());

    // Input. Read the comments before simplifying any of this — every branch
    // is here because a device needed it.
    const aimAtClientX = (cx) => {
      if (!Game.running) return;
      const r = this.cv.getBoundingClientRect();
      const x = (cx - r.left - this.ox) / this.scale;
      this.pointerX = x;
      Game.aimAt(x);
    };

    this.cv.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      GK.Sfx.init();
      // Capture, so a swipe that strays over the HUD buttons floating on top
      // of the stage keeps steering the paddle instead of being stolen.
      if (this.cv.setPointerCapture) {
        try { this.cv.setPointerCapture(e.pointerId); } catch (_) {}
      }
      aimAtClientX(e.clientX);
      Game.launch();
    }, { passive: false });

    this.cv.addEventListener("pointermove", (e) => {
      // NOT `e.pressure > 0`: iOS Safari reports a pressure of 0 for ordinary
      // touch, so that test silently drops every swipe on an iPad and the
      // paddle only moves when you tap. Ask what kind of pointer it is.
      if (e.pointerType === "touch" || e.buttons || e.pointerType === "mouse") {
        e.preventDefault();
        aimAtClientX(e.clientX);
      }
    }, { passive: false });

    // Belt and braces for touch: some iOS builds are stingy with pointermove
    // during a fast flick, and touchmove always arrives. Both paths end in the
    // same call, so a duplicate is harmless.
    this.cv.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length) aimAtClientX(e.touches[0].clientX);
    }, { passive: false });

    this.cv.addEventListener("touchstart", (e) => {
      e.preventDefault();
      if (e.touches.length) aimAtClientX(e.touches[0].clientX);
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") this.keys.left = true;
      else if (e.key === "ArrowRight") this.keys.right = true;
      else if (e.key === " " || e.key === "Enter") { if (Game.running) Game.launch(); }
      else return;
      if (Game.running) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "ArrowLeft") this.keys.left = false;
      if (e.key === "ArrowRight") this.keys.right = false;
    });

    this.resize();
  },

  resize() {
    if (!this.stage) return;
    const box = this.stage.getBoundingClientRect();
    // The game screen is display:none until it is shown, and a resize then
    // reads 0x0. Keep the last good layout rather than dividing by nothing.
    if (box.width < 50 || box.height < 50) return;

    this.W = box.width; this.H = box.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);

    this.scale = Math.min(this.W / LW, this.H / LH);
    this.ox = (this.W - LW * this.scale) / 2;
    // Anchor the field LOW rather than centring it. A 420x600 playfield on a
    // portrait phone leaves ~270px spare, and splitting that evenly puts the
    // paddle in the middle of the screen — nowhere near the thumb holding the
    // device. Pushing it down costs nothing in balance and turns the leftover
    // band above into somewhere to draw the spire rising away.
    this.oy = (this.H - LH * this.scale) * 0.86;
  },

  update(dt) {
    this.t += dt;
    // Notice a stage that changed size without telling anybody.
    if (this.stage) {
      const b = this.stage.getBoundingClientRect();
      if (b.width > 50 && b.height > 50 &&
          (Math.abs(b.width - this.W) > 1 || Math.abs(b.height - this.H) > 1)) this.resize();
    }
    if (Game.running && (this.keys.left || this.keys.right)) {
      Game.nudge((this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0), dt);
    }
  },

  /* --------------------------------------------------------------- drawing */
  render() {
    const ctx = this.ctx;
    if (!ctx || !this.W) return;
    const dpr = this.dpr || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintSurround(ctx);

    // shakeOffset returns a TUPLE. Reading .x off it gives undefined, and a
    // transform with a NaN in it is silently ignored — the whole camera would
    // vanish with nothing in the console.
    const [shx, shy] = Fx.shakeOffset();
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale,
                     dpr * (this.ox + shx * this.scale), dpr * (this.oy + shy * this.scale));

    this.paintField(ctx);
    if (Game.arena) {
      this.paintHazards(ctx);
      this.paintBricks(ctx);
      if (Game.boss) this.paintBoss(ctx);
      this.paintDrops(ctx);
      this.paintShots(ctx);
      this.paintPaddle(ctx);
      this.paintBalls(ctx);
      this.paintDark(ctx);
    }

    Fx.render(ctx);

    if (Fx.flash > 0) {
      ctx.globalAlpha = Math.min(1, Fx.flash);
      ctx.fillStyle = Fx.flashColor;
      ctx.fillRect(-40, -40, LW + 80, LH + 80);
      ctx.globalAlpha = 1;
    }
  },

  // The playfield is 420x600 and a phone is not, so there is always a band —
  // mostly above, since the field is anchored low. Painting the spire climbing
  // away into it makes the letterbox read as architecture rather than as a bug,
  // and it is the one place the game gets to show you what you are climbing.
  paintSurround(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, "#0a0818");
    g.addColorStop(1, "#05040d");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    const top = this.oy;
    if (top > 40) {
      const cx = this.W / 2;
      const act = (Run.state && Run.state.act) || 1;
      const hue = ["#35e0d0", "#a06bff", "#ff3d92"][Math.min(2, act - 1)];
      ctx.save();
      // Storeys receding upward, narrowing to a point — the spire above you.
      for (let i = 0; i < 7; i++) {
        const k = i / 7;
        const y = top * (1 - k) - 8;
        if (y < -20) break;
        const w = (LW * this.scale) * (0.62 - k * 0.45);
        const h = Math.max(3, top * 0.085);
        ctx.globalAlpha = 0.06 + k * 0.05;
        ctx.fillStyle = hue;
        ctx.fillRect(cx - w / 2, y - h, w, h * 0.75);
        ctx.globalAlpha = 0.13 + k * 0.08;
        ctx.fillRect(cx - w / 2, y - h, w, 1.5);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = "#1d1740";
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const y = ((i * 61 + this.t * 7) % (this.H + 60)) - 30;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.W, y); ctx.stroke();
    }
    ctx.restore();
  },

  paintField(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, LH);
    g.addColorStop(0, "#150f33");
    g.addColorStop(0.55, "#0f0b26");
    g.addColorStop(1, "#0b0820");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LW, LH);

    // A faint grid so the ball's angle is readable against the background.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "#2a2158";
    ctx.lineWidth = 1;
    for (let x = 0; x <= LW; x += BW) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, LH); ctx.stroke(); }
    ctx.restore();

    ctx.strokeStyle = "#33296b";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, LW - 2, LH - 2);

    // The floor: bright when a barrier is up, a dim warning line otherwise.
    if (Game.shieldOn) {
      ctx.fillStyle = "rgba(53,224,208,0.30)";
      ctx.fillRect(0, LH - 10, LW, 10);
      ctx.fillStyle = "#35e0d0";
      ctx.fillRect(0, LH - 10, LW, 2);
    } else {
      ctx.fillStyle = "rgba(255,84,112,0.16)";
      ctx.fillRect(0, LH - 4, LW, 4);
    }
  },

  paintHazards(ctx) {
    for (const h of Game.hazards) {
      if (h.kind === "conveyor") {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = h.vx > 0 ? "#35e0d0" : "#a06bff";
        ctx.fillRect(0, h.y, LW, h.h);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = h.vx > 0 ? "#35e0d0" : "#a06bff";
        ctx.lineWidth = 2;
        const off = (this.t * (h.vx > 0 ? 60 : -60)) % 34;
        for (let x = -34 + off; x < LW + 34; x += 34) {
          const m = h.y + h.h / 2, d = h.vx > 0 ? 8 : -8;
          ctx.beginPath();
          ctx.moveTo(x, m - 6); ctx.lineTo(x + d, m); ctx.lineTo(x, m + 6);
          ctx.stroke();
        }
        ctx.restore();
      } else if (h.kind === "blackhole") {
        const g = ctx.createRadialGradient(h.x, h.y, 2, h.x, h.y, h.r);
        g.addColorStop(0, "rgba(160,107,255,0.55)");
        g.addColorStop(0.35, "rgba(70,40,140,0.22)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#07060f";
        ctx.beginPath(); ctx.arc(h.x, h.y, 13, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#a06bff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(h.x, h.y, 13 + Math.sin(this.t * 3) * 2, 0, Math.PI * 2); ctx.stroke();
      } else if (h.kind === "mover") {
        this.neonRect(ctx, h.cx || h.x, h.y, h.w, h.h, "#3d4358", "#8b9bc4", 4);
      } else if (h.kind === "laser") {
        const on = h.on_;
        ctx.save();
        ctx.globalAlpha = on ? 0.85 : 0.16;
        const g = ctx.createLinearGradient(h.x, 0, h.x + h.w, 0);
        g.addColorStop(0, "rgba(255,61,146,0)");
        g.addColorStop(0.5, "#ff3d92");
        g.addColorStop(1, "rgba(255,61,146,0)");
        ctx.fillStyle = g;
        ctx.fillRect(h.x - 6, BRICK_TOP - 20, h.w + 12, PADDLE_Y - BRICK_TOP + 20);
        ctx.restore();
      } else if (h.kind === "bumper") {
        ctx.fillStyle = "#221b47";
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.stroke();
      } else if (h.kind === "portal") {
        this.paintGate(ctx, h.ax, h.ay, "#a06bff");
        this.paintGate(ctx, h.bx, h.by, "#35e0d0");
      }
    }
  },

  paintGate(ctx, x, y, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.9 - i * 0.28;
      ctx.beginPath();
      ctx.arc(x, y, 8 + i * 6 + Math.sin(this.t * 4 - i) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  },

  paintBricks(ctx) {
    for (const b of Game.bricks.values()) {
      const t = b.type;
      const x = b.c * BW + Game.driftX, y = BRICK_TOP + b.r * BH;
      const hurt = t.counts && b.maxHp > 1 ? b.hp / b.maxHp : 1;

      this.neonRect(ctx, x + 1.5, y + 1.5, BW - 3, BH - 3, t.colors[0], t.colors[1], 4, hurt);

      if (t.sparkle) {
        ctx.save();
        ctx.globalAlpha = 0.4 + 0.4 * Math.sin(this.t * 4 + b.c);
        ctx.fillStyle = t.colors[1];
        ctx.fillRect(x + 4, y + 4, BW - 8, 2);
        ctx.restore();
      }
      if (b.burn > 0) { ctx.fillStyle = "rgba(255,138,61,0.35)"; ctx.fillRect(x + 1.5, y + 1.5, BW - 3, BH - 3); }
      if (b.poison) { ctx.fillStyle = "rgba(94,220,120,0.22)"; ctx.fillRect(x + 1.5, y + 1.5, BW - 3, BH - 3); }
      if (b.chill > 0) { ctx.fillStyle = "rgba(124,197,255,0.25)"; ctx.fillRect(x + 1.5, y + 1.5, BW - 3, BH - 3); }
      if (b.fuse) {
        ctx.fillStyle = Math.floor(this.t * 8) % 2 ? "#ff5470" : "#ffd24a";
        ctx.fillRect(x + 1.5, y + 1.5, BW - 3, 3);
      }

      if (t.glyph) {
        ctx.fillStyle = t.colors[1];
        ctx.font = `700 ${Math.round(BH * 0.5)}px 'Chakra Petch',sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.globalAlpha = 0.85;
        ctx.fillText(t.glyph, x + BW / 2, y + BH / 2 + 1);
        ctx.globalAlpha = 1;
      }
      // Remaining hits, for anything that takes more than two.
      if (t.counts && b.maxHp > 2) {
        ctx.fillStyle = "rgba(236,235,255,0.85)";
        ctx.font = `700 ${Math.round(BH * 0.42)}px 'Chakra Petch',sans-serif`;
        ctx.textAlign = "right"; ctx.textBaseline = "top";
        ctx.fillText(b.hp, x + BW - 4, y + 3);
      }
    }
  },

  neonRect(ctx, x, y, w, h, base, glow, r, hurt = 1) {
    const dark = hurt < 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.fillStyle = base;
    ctx.globalAlpha = dark ? 0.45 + 0.55 * hurt : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // A lit top edge so a wall of bricks has depth rather than reading flat.
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = glow;
    ctx.fillRect(x + r, y + 1, w - r * 2, 1.5);
    ctx.restore();
  },

  paintBoss(ctx) {
    const boss = Game.boss;
    for (const p of boss.parts) {
      if (p.gone) continue;
      ctx.save();
      if (p.pass) ctx.globalAlpha = 0.6;
      if (p.invuln) {
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([5, 4]);
      }
      this.neonRect(ctx, p.x, p.y, p.w, p.h, p.color, p.glow, 6,
                    p.maxHp > 1 ? Math.max(0.15, p.hp / p.maxHp) : 1);
      ctx.setLineDash([]);
      if (p.glyph) {
        ctx.fillStyle = p.glow;
        ctx.font = `700 ${Math.round(Math.min(p.w, p.h) * 0.6)}px 'Chakra Petch',sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.glyph, p.x + p.w / 2, p.y + p.h / 2 + 1);
      }
      ctx.restore();
    }

    // Health bar across the top of the arena.
    const f = boss.hpFrac();
    ctx.fillStyle = "rgba(7,6,15,0.75)";
    ctx.fillRect(24, 46, LW - 48, 12);
    ctx.fillStyle = "#ff3d92";
    ctx.fillRect(26, 48, (LW - 52) * Math.max(0, f), 8);
    ctx.strokeStyle = "#33296b"; ctx.lineWidth = 1;
    ctx.strokeRect(24, 46, LW - 48, 12);
    ctx.fillStyle = "#ecebff";
    ctx.font = "700 12px 'Chakra Petch',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(`${boss.icon} ${boss.name.toUpperCase()}  ·  PHASE ${boss.phase}`, LW / 2, 42);
  },

  paintDrops(ctx) {
    for (const d of Game.drops) {
      const p = POWERUPS[d.id];
      if (!p) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(Math.sin(this.t * 4 + d.x) * 0.16);
      ctx.fillStyle = "#0b0820";
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-11, -11, 22, 22, 6); else ctx.rect(-11, -11, 22, 22);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.font = "700 13px 'Chakra Petch',sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(p.icon, 0, 1);
      ctx.restore();
    }
  },

  paintShots(ctx) {
    ctx.fillStyle = "#ffd24a";
    for (const s of Game.shots) ctx.fillRect(s.x - 1.5, s.y - 9, 3, 12);
  },

  paintPaddle(ctx) {
    const p = Game.paddle;
    this.paddleAt(ctx, p.x, p.y, p.w, "#35e0d0", "#a9fff2");
    if (Game.f("twin")) {
      this.paddleAt(ctx, LW - p.x, PADDLE_Y - 128, p.w * 0.68, "#a06bff", "#d9c4ff");
    }
    // Charge Coil: show that the next hit is loaded.
    if (Game.build.stats.chargeEvery > 0) {
      const n = Game.build.stats.chargeEvery;
      const untilCharge = n - (Game.paddleHits % n);
      if (untilCharge === n) {
        ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y + PADDLE_H / 2, p.w / 2 + 6 + Math.sin(this.t * 8) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  },

  paddleAt(ctx, x, y, w, base, glow) {
    ctx.save();
    ctx.shadowColor = base;
    ctx.shadowBlur = 16;
    ctx.fillStyle = base;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y, w, PADDLE_H, 6);
    else ctx.rect(x - w / 2, y, w, PADDLE_H);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = glow;
    ctx.fillRect(x - w / 2 + 5, y + 2, w - 10, 2);
  },

  paintBalls(ctx) {
    for (const b of Game.balls) {
      const col = Game.f("burn") ? "#ff8a3d"
                : Game.f("freeze") ? "#7cc5ff"
                : Game.f("poison") ? "#7ee08f"
                : Game.f("electric") ? "#ffd24a" : "#ecebff";
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 18;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (b.charged) {
        ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (Game.f("ricochet") && b.wallCharge > 0) {
        ctx.fillStyle = "#ff3d92";
        ctx.font = "700 11px 'Chakra Petch',sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("+" + b.wallCharge, b.x, b.y - 11);
      }
      // A held ball needs an aim line, or "tap to launch" is a guess.
      if (b.stuck) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = "#35e0d0";
        ctx.setLineDash([4, 5]);
        ctx.lineWidth = 2;
        const off = Game.paddle.w ? (b.x - Game.paddle.x) / (Game.paddle.w / 2) : 0;
        const v = Physics.paddleBounce(off * 0.55, 1);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + v.vx * 90, b.y + v.vy * 90);
        ctx.stroke();
        ctx.restore();
      }
    }
  },

  // Darkness. One radial hole around the ball you are actually tracking, and
  // the paddle redrawn on top so you can always see what you are steering.
  paintDark(ctx) {
    if (!Game.dark) return;
    const b = Game.balls.reduce((a, c) => (!a || c.y > a.y ? c : a), null);
    const cx = b ? b.x : Game.paddle.x, cy = b ? b.y : Game.paddle.y;
    const r = Game.dark.r;
    const g = ctx.createRadialGradient(cx, cy, r * 0.42, cx, cy, r * 1.5);
    g.addColorStop(0, "rgba(5,4,13,0)");
    g.addColorStop(1, "rgba(5,4,13,0.94)");
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, LW + 80, LH + 80);
    this.paintPaddle(ctx);
    this.paintBalls(ctx);
  },

  /* -------------------------------------------------------------- for tests */
  // Screen pixel -> logical playfield coordinate. Exposed so a check can cross
  // "where it looks" against "where the engine thinks it is".
  toLogical(clientX, clientY) {
    const r = this.cv.getBoundingClientRect();
    return { x: (clientX - r.left - this.ox) / this.scale,
             y: (clientY - r.top - this.oy) / this.scale };
  },
  toScreen(x, y) {
    const r = this.cv.getBoundingClientRect();
    return { x: r.left + this.ox + x * this.scale, y: r.top + this.oy + y * this.scale };
  },
};
