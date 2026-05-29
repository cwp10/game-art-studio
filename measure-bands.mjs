/**
 * TEMP band measurement — counts horizontal character bands in a spritesheet PNG.
 * Criteria per task: alpha>10 AND green-dominant (g-max(r,b)>40 && g>90), NOT white(240+).
 * Per-row count → threshold W*0.02 → contiguous bands; merge gaps < 30px.
 *   node measure-bands.mjs <png>
 */
import sharp from "sharp";

const png = process.argv[2];
if (!png) { console.error("usage: node measure-bands.mjs <png>"); process.exit(2); }

const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
const thresh = W * 0.02;

const rowCount = new Array(H).fill(0);
for (let y = 0; y < H; y++) {
  let c = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * C;
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a <= 10) continue;
    const white = r >= 240 && g >= 240 && b >= 240;
    if (white) continue;
    const greenDom = g - Math.max(r, b) > 40 && g > 90;
    if (greenDom) c++;
  }
  rowCount[y] = c;
}

// contiguous runs above threshold
const runs = [];
let start = -1;
for (let y = 0; y < H; y++) {
  if (rowCount[y] > thresh) {
    if (start < 0) start = y;
  } else if (start >= 0) {
    runs.push([start, y - 1]);
    start = -1;
  }
}
if (start >= 0) runs.push([start, H - 1]);

// merge gaps < 30px
const merged = [];
for (const run of runs) {
  if (merged.length && run[0] - merged[merged.length - 1][1] < 30) {
    merged[merged.length - 1][1] = run[1];
  } else {
    merged.push([...run]);
  }
}

const centers = merged.map(([a, b]) => Math.round((a + b) / 2));
console.log(`image=${W}x${H} thresh=${thresh.toFixed(1)}`);
console.log(`bands=${merged.length}`);
console.log(`y-centers=${JSON.stringify(centers)}`);
console.log(`ranges=${JSON.stringify(merged)}`);
