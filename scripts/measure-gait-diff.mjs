/**
 * gait 프레임 차별화 정량 측정 (일회성 QA 도구).
 *
 *   node scripts/measure-gait-diff.mjs <png> <rows> <cols>
 *
 * 각 행에 대해 인접 프레임(셀)의 "하단 1/3"(다리 영역) 실루엣을 비교한다.
 * - 실루엣 = 알파>32 (투명 배경 시트). 알파가 전부 불투명이면 휘도 기반 폴백.
 * - diff 비율 = (두 프레임 마스크 XOR 픽셀 수) / (두 마스크 합집합 픽셀 수).
 *   0 = 완전 동일(near-duplicate), 1 = 완전 상이. 0.10 미만이면 사실상 같은 포즈.
 * 행별 평균 diff 와 프레임쌍별 diff 를 출력. 측면 행 판정에 사용.
 */
import sharp from "sharp";

const [, , png, rowsStr, colsStr] = process.argv;
const rows = Number(rowsStr);
const cols = Number(colsStr);
if (!png || !rows || !cols) {
  console.error("usage: node scripts/measure-gait-diff.mjs <png> <rows> <cols>");
  process.exit(2);
}

const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
const cellW = Math.floor(W / cols);
const cellH = Math.floor(H / rows);

// 시트 전체 알파 분포 — 알파가 의미있게 변하면 알파 마스크, 아니면 휘도 폴백.
let alphaMin = 255, alphaMax = 0;
for (let i = 0; i < W * H; i++) {
  const a = data[i * C + 3];
  if (a < alphaMin) alphaMin = a;
  if (a > alphaMax) alphaMax = a;
}
const useAlpha = alphaMax - alphaMin > 32;

// (cellCol, cellRow) 하단 1/3 영역의 전경 마스크(Uint8Array, 1=전경).
function legMask(col, row) {
  const x0 = col * cellW;
  const y0 = row * cellH + Math.floor((cellH * 2) / 3); // 하단 1/3
  const y1 = row * cellH + cellH;
  const w = cellW;
  const h = y1 - y0;
  const mask = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const px = x0 + xx;
      const py = y0 + yy;
      const idx = (py * W + px) * C;
      const a = data[idx + 3];
      let fg;
      if (useAlpha) {
        fg = a > 32;
      } else {
        // 흰 배경 폴백: 충분히 어두운/채도있는 픽셀을 전경으로.
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
        fg = lum < 235 || maxc - minc > 30;
      }
      mask[yy * w + xx] = fg ? 1 : 0;
    }
  }
  return mask;
}

function maskDiff(m1, m2) {
  let xor = 0, union = 0;
  for (let i = 0; i < m1.length; i++) {
    const a = m1[i], b = m2[i];
    if (a | b) union++;
    if (a ^ b) xor++;
  }
  return union === 0 ? 0 : xor / union;
}

console.log(`[measure] ${png}`);
console.log(`[measure] ${W}x${H}  cell=${cellW}x${cellH}  rows=${rows} cols=${cols}  fg=${useAlpha ? "alpha" : "luma"} (alphaRange ${alphaMin}..${alphaMax})`);

const ROW_LABELS = rows === 4 ? ["DOWN", "LEFT", "RIGHT", "UP"] : rows === 2 ? ["LEFT", "RIGHT"] : null;

for (let r = 0; r < rows; r++) {
  const masks = [];
  for (let c = 0; c < cols; c++) masks.push(legMask(c, r));
  const pairDiffs = [];
  for (let c = 0; c < cols; c++) {
    const next = (c + 1) % cols; // loop: 마지막→첫 프레임도 포함(seamless)
    pairDiffs.push(maskDiff(masks[c], masks[next]));
  }
  const avg = pairDiffs.reduce((s, v) => s + v, 0) / pairDiffs.length;
  const min = Math.min(...pairDiffs);
  const label = ROW_LABELS ? ROW_LABELS[r] : `row${r}`;
  const pairStr = pairDiffs.map((d, c) => `${c + 1}->${((c + 1) % cols) + 1}:${d.toFixed(3)}`).join("  ");
  console.log(`  [${label}] avg=${avg.toFixed(3)} min=${min.toFixed(3)}  | ${pairStr}`);
}
