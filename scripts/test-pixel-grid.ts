/**
 * `pixel-grid.ts` (픽셀 언페이크 ①단계) 가 정본과 같은 격자를 재는지.
 *
 * 이 단계가 틀리면 뒤의 모든 것이 틀린다 — 피치가 반으로 붕괴하면 논리 픽셀 수가
 * 두 배가 되고, 위상이 반 칸 밀리면 셀 경계가 블록 한가운데를 지나 디테일이 두 칸에
 * 반씩 걸린다. 그래서 **소수점까지 같은 값**을 요구한다.
 *
 * 실행: npx tsx scripts/test-pixel-grid.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  edgeHistograms,
  axisIntScore,
  axisIntSeed,
  axisRefine,
  detectPixelPitch,
  detectPixelGrid,
  type RawImage,
} from "../src/lib/sprite/pixel-grid";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const dir = mkdtempSync(join(tmpdir(), "pxgrid-"));

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

if (!existsSync(PY)) {
  console.log("  FAIL 파이썬 venv 없음 — 정본 대조를 못 했습니다");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

void (async () => {

async function load(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** 정본을 그대로 돌려 중간 산출까지 받는다. */
function canonical(path: string): {
  col_sum: number; row_sum: number; col_head: number[]; row_head: number[];
  combined: number; seed_col: number; seed_row: number;
  score_col: number[]; refine_col: [number, number][];
  pitch: [number, number]; phase: [number, number];
} {
  return JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import (_edge_histograms, _axis_int_score, _axis_int_seed,
                                _axis_refine, detect_pixel_pitch, detect_pixel_grid)
im = Image.open(${JSON.stringify(path)}).convert("RGBA")
col, row, w, h = _edge_histograms(im)
(px, py), (ax, ay) = detect_pixel_grid(im)
print(json.dumps({
  "col_sum": sum(col), "row_sum": sum(row),
  "col_head": col[:16], "row_head": row[:16],
  "combined": detect_pixel_pitch(im),
  "seed_col": _axis_int_seed(col), "seed_row": _axis_int_seed(row),
  "score_col": [_axis_int_score(col, p) for p in (2, 3, 5, 8, 11, 13, 16, 24)],
  "refine_col": [list(_axis_refine(col, p)) for p in (4.0, 7.5, 11.25, 16.0, 17.24)],
  "pitch": [px, py], "phase": [ax, ay],
}))
`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

const eq = (a: number, b: number, tol = 1e-9): boolean =>
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// 실제 프레임 — 크기·픽셀 밀도가 다른 것들을 고른다.
const CANDIDATES = [
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png",
  "data/sprite-runs/sprite-1786910676578/frames-down45_idle/frame-0.png",
  "data/sprite-runs/sprite-1786868942478/frames-down_idle/frame-1.png",
  "data/images/8bw0d8mv2bg3sf0g.png",
  "data/images/3z7aifhwwfq2siwo.png",
].filter(existsSync);

if (CANDIDATES.length === 0) {
  check("실제 프레임 없음", false);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(1);
}

for (const src of CANDIDATES) {
  const name = src.split("/").slice(-2).join("/");
  console.log(`\n=== ${name} ===`);
  const img = await load(src);
  const ref = canonical(src);

  const { colEdges, rowEdges } = edgeHistograms(img);
  let colSum = 0; for (const e of colEdges) colSum += e;
  let rowSum = 0; for (const e of rowEdges) rowSum += e;
  check(`${name}: 엣지 히스토그램 합`, colSum === ref.col_sum && rowSum === ref.row_sum,
    `${colSum}/${rowSum} vs ${ref.col_sum}/${ref.row_sum}`);
  check(`${name}: 엣지 히스토그램 앞 16칸`,
    ref.col_head.every((v, i) => colEdges[i] === v) && ref.row_head.every((v, i) => rowEdges[i] === v));

  check(`${name}: 정수 점수 8종`,
    [2, 3, 5, 8, 11, 13, 16, 24].every((p, i) => eq(axisIntScore(colEdges, p), ref.score_col[i])),
    JSON.stringify([2, 3, 5, 8, 11, 13, 16, 24].map(p => axisIntScore(colEdges, p))) + " vs " + JSON.stringify(ref.score_col));
  check(`${name}: 소수 정밀화 5종 (점수·위상)`,
    [4.0, 7.5, 11.25, 16.0, 17.24].every((p, i) => {
      const r = axisRefine(colEdges, p);
      return eq(r.score, ref.refine_col[i][0]) && eq(r.phase, ref.refine_col[i][1]);
    }),
    JSON.stringify([4.0, 7.5, 11.25, 16.0, 17.24].map(p => { const r = axisRefine(colEdges, p); return [r.score, r.phase]; }))
    + " vs " + JSON.stringify(ref.refine_col));

  check(`${name}: 축 씨앗`,
    axisIntSeed(colEdges) === ref.seed_col && axisIntSeed(rowEdges) === ref.seed_row,
    `${axisIntSeed(colEdges)}/${axisIntSeed(rowEdges)} vs ${ref.seed_col}/${ref.seed_row}`);
  check(`${name}: 합산 정수 피치`, detectPixelPitch(img) === ref.combined,
    `${detectPixelPitch(img)} vs ${ref.combined}`);

  const g = detectPixelGrid(img);
  check(`${name}: 피치 (소수)`,
    eq(g.pitch[0], ref.pitch[0]) && eq(g.pitch[1], ref.pitch[1]),
    `${g.pitch.map(v => v.toFixed(4)).join("x")} vs ${ref.pitch.map(v => v.toFixed(4)).join("x")}`);
  check(`${name}: 위상 (소수)`,
    eq(g.phase[0], ref.phase[0]) && eq(g.phase[1], ref.phase[1]),
    `${g.phase.map(v => v.toFixed(4)).join(",")} vs ${ref.phase.map(v => v.toFixed(4)).join(",")}`);
  console.log(`  (참고) 피치 ${g.pitch.map(v => v.toFixed(2)).join(" x ")}, 위상 ${g.phase.map(v => v.toFixed(2)).join(", ")}`);
}

console.log("\n=== 합성 정답 격자 (피치를 아는 이미지) ===");
{
  // 정확히 k 픽셀 블록으로 그린 그림에서 k 를 되찾아야 한다. 정본 주석이 못박은
  // 회귀(k=8,10,12,14 에서 k/2 를 반환하던 버그)를 여기서 고정한다.
  for (const k of [4, 8, 10, 12, 14, 16]) {
    const logicalW = 24, logicalH = 24;
    const W = logicalW * k, H = logicalH * k;
    const buf = Buffer.alloc(W * H * 4);
    let s = 987654321;
    const cells: number[][] = [];
    for (let ly = 0; ly < logicalH; ly++) {
      const row: number[] = [];
      for (let lx = 0; lx < logicalW; lx++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        row.push((s >> 16) & 255);
      }
      cells.push(row);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = cells[Math.floor(y / k)][Math.floor(x / k)];
        const i = (y * W + x) * 4;
        buf[i] = v; buf[i + 1] = (v * 3) & 255; buf[i + 2] = (v * 7) & 255; buf[i + 3] = 255;
      }
    }
    const p = join(dir, `grid-${k}.png`);
    await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
    const img = await load(p);
    const ref = canonical(p);
    const g = detectPixelGrid(img);
    check(`k=${k} 블록: 정본과 같은 피치`,
      eq(g.pitch[0], ref.pitch[0]) && eq(g.pitch[1], ref.pitch[1]),
      `${g.pitch.map(v => v.toFixed(2)).join("x")} vs ${ref.pitch.map(v => v.toFixed(2)).join("x")}`);
    check(`k=${k} 블록: 참값 k 를 되찾는다 (약수로 안 무너진다)`,
      Math.abs(g.pitch[0] - k) < 0.6 && Math.abs(g.pitch[1] - k) < 0.6,
      `${g.pitch.map(v => v.toFixed(2)).join("x")} vs 참값 ${k}`);
  }
}

console.log("\n=== 격자가 없으면 스냅하지 않는다 ===");
{
  // 매끈한 그라디언트에는 블록 구조가 없다 — 1.0 으로 관측 가능하게 포기해야 한다.
  const W = 96, H = 96;
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      buf[i] = Math.round((x / W) * 255); buf[i + 1] = Math.round((y / H) * 255);
      buf[i + 2] = 128; buf[i + 3] = 255;
    }
  }
  const p = join(dir, "gradient.png");
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
  const img = await load(p);
  const ref = canonical(p);
  const g = detectPixelGrid(img);
  check("그라디언트: 정본과 같은 판정",
    eq(g.pitch[0], ref.pitch[0]) && eq(g.pitch[1], ref.pitch[1]),
    `${JSON.stringify(g.pitch)} vs ${JSON.stringify(ref.pitch)}`);
  console.log(`  (참고) 그라디언트 피치 ${JSON.stringify(g.pitch)} — 1.0 이면 스냅 안 함`);
}

void readdirSync;
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
