// Ricochet Spire — sound and music, synthesized through gamekit's WebAudio
// layer. No files to load, so nothing to wait for on a cold start.
//
// The music is a LOOKAHEAD PUMP, not a note-per-setInterval: a ~110ms timer
// schedules everything due in the next 0.6 seconds against the WebAudio clock.
// Timer-per-note drifts audibly and collapses entirely in a backgrounded tab,
// where browsers throttle timers to about 1Hz.

const Sfx = GK.Sfx;

Object.assign(Sfx, {
  // The combo climbs the scale. Hearing the pitch rise is most of why a long
  // rally feels good, and it costs one Math.pow.
  brickHit(combo = 0) {
    const step = Math.min(combo, 16);
    this.tone({ freq: 300 * Math.pow(2, step / 20), type: "square", dur: 0.045, vol: 0.09 });
  },
  brickBreak(combo = 0) {
    const step = Math.min(combo, 16);
    this.tone({ freq: 420 * Math.pow(2, step / 18), type: "triangle", dur: 0.09, vol: 0.11, slide: 140 });
    this.noise({ dur: 0.05, vol: 0.05 });
  },
  paddle() { this.tone({ freq: 200, type: "square", dur: 0.05, vol: 0.09, slide: 90 }); },
  charged() { this.tone({ freq: 300, type: "sawtooth", dur: 0.12, vol: 0.1, slide: 420 }); },
  wall() { this.tone({ freq: 150, type: "square", dur: 0.03, vol: 0.05 }); },
  launch() { this.tone({ freq: 260, type: "sawtooth", dur: 0.14, vol: 0.1, slide: 520 }); },
  clank() { this.tone({ freq: 110, type: "square", dur: 0.07, vol: 0.09, slide: -40 }); },
  bumper() { this.tone({ freq: 640, type: "sine", dur: 0.1, vol: 0.11, slide: 300 }); },

  boom() {
    this.noise({ dur: 0.3, vol: 0.16 });
    this.tone({ freq: 120, type: "sawtooth", dur: 0.26, vol: 0.13, slide: -80 });
  },
  arc() { this.tone({ freq: 1500, type: "square", dur: 0.05, vol: 0.06, slide: -700 }); },
  laser() { this.tone({ freq: 900, type: "sawtooth", dur: 0.05, vol: 0.05, slide: -420 }); },
  gate() {
    this.tone({ freq: 420, type: "sine", dur: 0.13, vol: 0.09, slide: 500 });
    this.tone({ freq: 620, type: "sine", dur: 0.13, vol: 0.06, when: 0.05, slide: -300 });
  },

  pickup() {
    this.tone({ freq: 660, type: "triangle", dur: 0.09, vol: 0.11 });
    this.tone({ freq: 990, type: "triangle", dur: 0.12, vol: 0.1, when: 0.07 });
  },
  badPickup() { this.tone({ freq: 220, type: "sawtooth", dur: 0.22, vol: 0.11, slide: -110 }); },
  save() { this.tone({ freq: 520, type: "sine", dur: 0.16, vol: 0.12, slide: 260 }); },
  hurt() {
    this.tone({ freq: 300, type: "sawtooth", dur: 0.22, vol: 0.13, slide: -190 });
    this.noise({ dur: 0.14, vol: 0.08 });
  },
  heal() { this.tone({ freq: 520, type: "sine", dur: 0.2, vol: 0.09, slide: 220 }); },

  ruleShift() {
    this.tone({ freq: 180, type: "sawtooth", dur: 0.3, vol: 0.1, slide: 260 });
    this.tone({ freq: 240, type: "square", dur: 0.3, vol: 0.06, when: 0.05, slide: -120 });
  },

  bossHit() { this.tone({ freq: 170, type: "square", dur: 0.07, vol: 0.1, slide: 60 }); },
  bossBlock() { this.tone({ freq: 90, type: "square", dur: 0.1, vol: 0.09 }); },
  bossPhase() {
    [0, 4, 7].forEach((s, i) =>
      this.tone({ freq: 220 * Math.pow(2, s / 12), type: "sawtooth", dur: 0.3, vol: 0.11, when: i * 0.09 }));
  },
  bossDown() {
    [12, 7, 4, 0].forEach((s, i) =>
      this.tone({ freq: 660 * Math.pow(2, s / 12), type: "triangle", dur: 0.36, vol: 0.13, when: i * 0.12 }));
    this.noise({ dur: 0.5, vol: 0.12, when: 0.1 });
  },

  cardTake() {
    [0, 5, 9, 12].forEach((s, i) =>
      this.tone({ freq: 440 * Math.pow(2, s / 12), type: "triangle", dur: 0.22, vol: 0.1, when: i * 0.06 }));
  },
  buy() { this.tone({ freq: 880, type: "square", dur: 0.06, vol: 0.09 });
          this.tone({ freq: 1320, type: "square", dur: 0.08, vol: 0.07, when: 0.05 }); },
  nope() { this.tone({ freq: 160, type: "square", dur: 0.13, vol: 0.09, slide: -50 }); },

  climbWin() {
    [0, 4, 7, 12, 16, 19].forEach((s, i) =>
      this.tone({ freq: 330 * Math.pow(2, s / 12), type: "triangle", dur: 0.5, vol: 0.12, when: i * 0.12 }));
  },
  climbLose() {
    [0, -3, -7, -12].forEach((s, i) =>
      this.tone({ freq: 300 * Math.pow(2, s / 12), type: "sawtooth", dur: 0.45, vol: 0.11, when: i * 0.16 }));
  },
});

/* ============================================================== the music */
// Semitone offsets against a root, one entry per eighth note. `null` is a rest.
// Two tracks: the climb (cool, patient) and a boss (driving, minor sixth).
const TRACKS = {
  climb: {
    root: 110, bpm: 96,
    bass: [0, null, 0, null, -5, null, -5, null, -3, null, -3, null, -7, null, -7, null],
    lead: [12, null, 15, 19, null, 15, 12, null, 10, null, 12, 15, null, 12, 10, null,
           7, null, 10, 12, null, 10, 7, null, 5, null, 7, 10, null, 7, 5, null],
  },
  boss: {
    root: 98, bpm: 132,
    bass: [0, 0, null, 0, -1, null, 0, null, -4, -4, null, -4, -5, null, -4, null],
    lead: [12, 11, 12, 15, null, 14, 12, null, 8, 7, 8, 11, null, 10, 8, null,
           12, 15, 17, 18, null, 17, 15, null, 12, 11, 8, 7, null, 8, 11, null],
  },
};

const Music = {
  enabled: true,
  track: null,
  playing: false,
  step: 0,
  nextT: 0,
  timer: null,

  play(name) {
    if (!this.enabled || !Sfx.enabled) return;
    if (this.playing && this.track === name) return;
    this.stop();
    Sfx.init();
    if (!Sfx.ctx) return;
    this.track = name;
    this.playing = true;
    this.step = 0;
    this.nextT = Sfx.ctx.currentTime + 0.12;
    this.timer = setInterval(() => this.pump(), 110);
  },

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.track = null;
  },

  pump() {
    if (!this.playing || !Sfx.ctx || !Sfx.enabled || !this.enabled) return;
    const t = TRACKS[this.track];
    if (!t) return;
    const spb = 60 / t.bpm / 2;                 // one eighth note
    const now = Sfx.ctx.currentTime;

    // If the tab was hidden the clock has run on without us. Skip the missed
    // steps silently rather than firing them all at once.
    if (this.nextT < now - 0.4) { this.nextT = now + 0.05; }

    while (this.nextT < now + 0.6) {
      const when = this.nextT - now;
      const b = t.bass[this.step % t.bass.length];
      const l = t.lead[this.step % t.lead.length];
      if (b !== null && b !== undefined) {
        Sfx.tone({ freq: t.root * Math.pow(2, b / 12), type: "triangle",
                   dur: spb * 1.7, vol: 0.055, when });
      }
      if (l !== null && l !== undefined) {
        Sfx.tone({ freq: t.root * Math.pow(2, l / 12), type: "square",
                   dur: spb * 0.85, vol: 0.032, when });
      }
      this.step++;
      this.nextT += spb;
    }
  },

  // Pausing shifts the clock forward instead of stopping it, so the phrase
  // picks up where it left off rather than restarting.
  hold(seconds) { this.nextT += seconds; },
};

// game.js emits `sfxFuse` through the engine rather than importing audio, so
// bricks.js can make a noise without knowing this file exists.
Sfx.fuse = function () { this.tone({ freq: 700, type: "square", dur: 0.06, vol: 0.07, slide: -200 }); };
