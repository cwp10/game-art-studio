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
  gridEdges,
  gridRows,
  gridRowSplits,
  gridScoreEdges,
  gridUniformity,
  bestPhase,
  resolveFramePitch,
  type RawImage,
  type Pitch,
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

console.log("\n=== ②단계: 격자선 확정 (gridEdges) ===");
{
  const cases: Array<[number, number, number]> = [
    [100, 8, 0], [100, 8, 2], [100, 8, 4], [100, 8, 6],
    [849, 30.92, 0], [849, 30.92, 12.3],
    [64, 16, 0], [64, 16.0, 15.9], [63, 16, 0],
    [100, 1, 0], [100, 0.5, 0], [7, 8, 0],
    [256, 17.24, 3.1], [256, 17.24, 0],
    [120, 6.0, 5.99], [120, 6.0, 0.01],
  ];
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.extract import _grid_edges
cases = json.loads(sys.stdin.read())
print(json.dumps([_grid_edges(l, p, o) for l, p, o in cases]))
`], { encoding: "utf8", input: JSON.stringify(cases) })) as number[][];
  cases.forEach(([l, p, o], i) => {
    const ours = gridEdges(l, p, o);
    check(`gridEdges(${l}, ${p}, ${o})`, JSON.stringify(ours) === JSON.stringify(refs[i]),
      `${JSON.stringify(ours)} vs ${JSON.stringify(refs[i])}`);
  });
}

console.log("\n=== ②단계: 셀 균일도·위상 실측 (실제 컴포넌트) ===");
{
  // 격자가 실제로 있는 이미지로 재야 의미가 있다 — base 는 피치 8 이다.
  const src = "data/images/euaom92zbh0jrchz.png";
  if (!existsSync(src)) {
    check("base 이미지 없음", false, src);
  } else {
    // 너무 크면 위상 스캔이 오래 걸린다 — 위쪽 일부만 잘라 쓴다.
    const cropPath = join(dir, "base-crop.png");
    await sharp(src).extract({ left: 300, top: 200, width: 240, height: 240 }).png().toFile(cropPath);
    const img = await load(cropPath);

    const ref = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import _grid_rows, _grid_row_splits, _grid_score_edges, _grid_uniformity, _best_phase, _grid_edges, resolve_frame_pitch
im = Image.open(${JSON.stringify(cropPath)}).convert("RGBA")
w, h = im.size
rows = _grid_rows(im)
xs = _grid_edges(w, 8.0, 0.0); ys = _grid_edges(h, 8.0, 0.0)
print(json.dumps({
  "row_counts": [len(p) for p in rows[0][:8]],
  "splits_head": _grid_row_splits(rows[0], xs, w)[:3],
  "score_8_0": _grid_score_edges(rows, w, h, xs, ys),
  "uniformity_8": _grid_uniformity(im, (8.0, 8.0), (0.0, 0.0)),
  "uniformity_6": _grid_uniformity(im, (6.0, 6.0), (0.0, 0.0)),
  "best_phase_8": list(_best_phase(im, (8.0, 8.0))),
  "best_phase_6": list(_best_phase(im, (6.0, 6.0))),
  "rfp": [
    [list(resolve_frame_pitch((12.5, 12.5), (13.0, 13.0))[0]), resolve_frame_pitch((12.5, 12.5), (13.0, 13.0))[1]],
    [list(resolve_frame_pitch((3.0, 3.0), (7.0, 8.86))[0]), resolve_frame_pitch((3.0, 3.0), (7.0, 8.86))[1]],
    [list(resolve_frame_pitch((8.0, 8.0), (1.0, 1.0))[0]), resolve_frame_pitch((8.0, 8.0), (1.0, 1.0))[1]],
    [list(resolve_frame_pitch((8.0, 8.0), (8.86, 8.86))[0]), resolve_frame_pitch((8.0, 8.0), (8.86, 8.86))[1]],
  ],
}))
`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as {
      row_counts: number[]; splits_head: number[][]; score_8_0: number;
      uniformity_8: number; uniformity_6: number;
      best_phase_8: number[]; best_phase_6: number[]; rfp: Array<[number[], boolean]>;
    };

    const rows = gridRows(img);
    check("행별 불투명 픽셀 수",
      ref.row_counts.every((v, i) => rows.rowPos[i].length === v),
      `${rows.rowPos.slice(0, 8).map(p => p.length)} vs ${ref.row_counts}`);
    const xs = gridEdges(img.width, 8.0, 0.0);
    const ys = gridEdges(img.height, 8.0, 0.0);
    const splits = gridRowSplits(rows.rowPos, xs, img.width);
    check("행 분할 색인",
      JSON.stringify(splits.slice(0, 3)) === JSON.stringify(ref.splits_head),
      `${JSON.stringify(splits.slice(0, 3))} vs ${JSON.stringify(ref.splits_head)}`);
    check("셀 균일도 코어 (정수 정확 산술)",
      eq(gridScoreEdges(rows, img.width, img.height, xs, ys), ref.score_8_0, 1e-12),
      `${gridScoreEdges(rows, img.width, img.height, xs, ys)} vs ${ref.score_8_0}`);
    check("gridUniformity 피치 8", eq(gridUniformity(img, [8, 8], [0, 0]), ref.uniformity_8, 1e-12));
    check("gridUniformity 피치 6", eq(gridUniformity(img, [6, 6], [0, 0]), ref.uniformity_6, 1e-12));

    const bp8 = bestPhase(img, [8, 8]);
    check("bestPhase 피치 8 (argmin 동일)",
      eq(bp8[0], ref.best_phase_8[0]) && eq(bp8[1], ref.best_phase_8[1]),
      `${JSON.stringify(bp8)} vs ${JSON.stringify(ref.best_phase_8)}`);
    const bp6 = bestPhase(img, [6, 6]);
    check("bestPhase 피치 6 (argmin 동일)",
      eq(bp6[0], ref.best_phase_6[0]) && eq(bp6[1], ref.best_phase_6[1]),
      `${JSON.stringify(bp6)} vs ${JSON.stringify(ref.best_phase_6)}`);
    console.log(`  (참고) 240x240 크롭 위상 8: ${JSON.stringify(bp8)}, 균일도 ${ref.uniformity_8.toFixed(1)}`);
  }
}

console.log("\n=== ②단계: 피치 패밀리 판정 ===");
{
  const cases: Array<[Pitch, Pitch]> = [
    [[12.5, 12.5], [13.0, 13.0]],   // 4% — own 채택 (눈 반쪽 실사고)
    [[3.0, 3.0], [7.0, 8.86]],      // 붕괴 — 합의 채택
    [[8.0, 8.0], [1.0, 1.0]],       // 합의가 확신 없음 — own
    [[8.0, 8.0], [8.86, 8.86]],     // 10.75% — 패밀리 밖
  ];
  const refJson = execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.extract import resolve_frame_pitch
cases = json.loads(sys.stdin.read())
out = []
for own, con in cases:
    p, o = resolve_frame_pitch(tuple(own), tuple(con))
    out.append([list(p), o])
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify(cases) });
  const refs = JSON.parse(refJson) as Array<[number[], boolean]>;
  cases.forEach(([own, con], i) => {
    const [p, outlier] = resolveFramePitch(own, con);
    check(`resolveFramePitch(${JSON.stringify(own)}, ${JSON.stringify(con)})`,
      JSON.stringify(p) === JSON.stringify(refs[i][0]) && outlier === refs[i][1],
      `${JSON.stringify([p, outlier])} vs ${JSON.stringify(refs[i])}`);
  });
}

void readdirSync;
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
