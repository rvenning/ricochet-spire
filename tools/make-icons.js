// Ricochet Spire icons: a neon spire silhouette with a ball ricocheting off a
// paddle at its foot. Everything is drawn at 4x and box-downsampled, which is
// the only antialiasing png.js has.
//
//   $env:Path += ';C:\Program Files\nodejs'
//   node tools/make-icons.js

const fs = require("fs");
const path = require("path");
const { makeCanvas, downsample, encodePNG } = require("../lib/tools/png.js");

const VOID = "#07060f";
const DEEP = "#160f33";
const LINE = "#33296b";
const NEON = "#35e0d0";
const MAG = "#ff3d92";
const VIO = "#a06bff";
const INK = "#ecebff";

// `art` scales the drawing about the centre. The maskable icon uses a smaller
// value so nothing important is lost to a circular crop.
function paint(size, art) {
  const SS = 4, big = size * SS;
  const cv = makeCanvas(big);
  const u = big / 100;                        // one unit = 1% of the icon
  const mid = big / 2;
  const S = (v) => v * u * art;
  const cy = (v) => mid + (v - 50) * u * art; // y in icon units, scaled about centre
  const cx = (v) => mid + (v - 50) * u * art;

  cv.fillRect(0, 0, big, big, VOID);
  cv.fillRoundRect(0, 0, big, big, 22 * u, DEEP);

  // Faint scan lines, so the flat fill reads as a screen rather than a card.
  for (let i = 0; i < 11; i++) cv.fillRect(0, (8 + i * 8) * u, big, 1.2 * u, LINE, 0.5);

  // The spire: three stacked bands of bricks narrowing to a point.
  const rows = [
    { y: 24, w: 26, c: MAG },
    { y: 33, w: 38, c: VIO },
    { y: 42, w: 50, c: NEON },
  ];
  for (const r of rows) {
    const w = S(r.w), h = S(7);
    const x = cx(50) - w / 2, y = cy(r.y);
    cv.fillRoundRect(x - S(1.4), y - S(1.4), w + S(2.8), h + S(2.8), S(2.6), VOID, 0.85);
    cv.fillRoundRect(x, y, w, h, S(2), r.c);
    cv.fillRect(x + S(3), y + S(1), w - S(6), S(1.2), INK, 0.55);
  }
  // The cap.
  cv.fillTriangle(cx(50), cy(13), cx(41), cy(23), cx(59), cy(23), VOID, 0.85);
  cv.fillTriangle(cx(50), cy(15.5), cx(43), cy(23), cx(57), cy(23), MAG);

  // The ricochet: a dotted arc from the paddle up to the spire.
  const pts = [[36, 66], [42, 60], [48, 55], [55, 51], [61, 48]];
  for (let i = 0; i < pts.length; i++) {
    cv.fillCircle(cx(pts[i][0]), cy(pts[i][1]), S(1.5 - i * 0.12), NEON, 0.35 + i * 0.13);
  }

  // The ball.
  cv.fillCircle(cx(64), cy(46), S(4.4), VOID, 0.9);
  cv.fillCircle(cx(64), cy(46), S(3.4), INK);

  // The paddle.
  const pw = S(34), ph = S(5);
  const px = cx(46) - pw / 2, py = cy(72);
  cv.fillRoundRect(px - S(1.4), py - S(1.4), pw + S(2.8), ph + S(2.8), S(3), VOID, 0.85);
  cv.fillRoundRect(px, py, pw, ph, S(2.4), NEON);
  cv.fillRect(px + S(4), py + S(1), pw - S(8), S(1.2), INK, 0.7);

  return encodePNG(size, size, downsample(cv.px, big, SS));
}

const out = path.join(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });

for (const [name, size, art] of [
  ["icon-192.png", 192, 1.0],
  ["icon-512.png", 512, 1.0],
  ["maskable-512.png", 512, 0.72],
]) {
  fs.writeFileSync(path.join(out, name), paint(size, art));
  console.log(`icons/${name}`);
}
