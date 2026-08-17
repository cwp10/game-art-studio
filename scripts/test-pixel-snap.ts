/**
 * `pixel-snap.ts` (픽셀 언페이크 ③단계) 가 정본과 **픽셀 동일**한 논리 프레임을 내는지.
 *
 * 이 단계가 최종 산출물을 만든다 — 셀 지배색 하나가 어긋나면 눈이 사라지고, 절단선이
 * 한 칸 밀리면 디테일이 두 칸에 반씩 걸린다. 그래서 중간 산출(경계 질량·스냅된 절단선)
 * 부터 최종 프레임 바이트까지 전부 대조한다.
 *
 * 실행: npx tsx scripts/test-pixel-snap.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPixelGrid, gridEdges, bestPhase, type RawImage } from "../src/lib/sprite/pixel-grid";
import {
  dominantBlockColor,
  boundaryMass,
  refineEdgesToBoundaries,
  snapByEdges,
  gridSnapDownscale,
  kcentroidDownscale,
} from "../src/lib/sprite/pixel-snap";
import { pixelUnfakeOptions, conformRowLogical } from "../src/lib/sprite/pixel-unfake";
type RawImageBuf = { data: Buffer; width: number; height: number };

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const dir = mkdtempSync(join(tmpdir(), "pxsnap-"));

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

console.log("=== 셀 지배색 (2-means) ===");
{
  // 정수 산술이라 완전 일치를 요구한다. 동점·detail_bias 경계를 함께 태운다.
  const cases: Array<[number[][], boolean]> = [
    [[[10, 20, 30]], false],
    [[[10, 20, 30], [200, 200, 200]], false],
    [[[10, 20, 30], [200, 200, 200]], true],
    [[[0, 0, 0], [0, 0, 0], [255, 255, 255]], true],
    [[[0, 0, 0], [255, 255, 255], [255, 255, 255]], true],
    [[[0, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255]], true],
    [[[5, 5, 5], [6, 6, 6], [250, 250, 250], [251, 251, 251], [252, 252, 252]], true],
    [[[5, 5, 5], [6, 6, 6], [250, 250, 250], [251, 251, 251], [252, 252, 252]], false],
    [[[120, 130, 140], [121, 131, 141], [119, 129, 139]], false],
    [[[30, 40, 50], [200, 210, 220], [31, 41, 51], [201, 211, 221]], true],
  ];
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.extract import _dominant_block_color
cases = json.loads(sys.stdin.read())
out = []
for px, bias in cases:
    opaque = [tuple(p) + (255,) for p in px]
    out.append(list(_dominant_block_color(opaque, bias)))
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify(cases) })) as number[][];
  cases.forEach(([px, bias], i) => {
    const ours = dominantBlockColor(px.map(p => [p[0], p[1], p[2]]), bias);
    check(`지배색 n=${px.length} bias=${bias}`,
      JSON.stringify(ours) === JSON.stringify(refs[i]),
      `${JSON.stringify(ours)} vs ${JSON.stringify(refs[i])}`);
  });
}

// ── 실제 격자가 있는 이미지로 전 구간 대조 ──────────────────────────
const SRC = "data/images/euaom92zbh0jrchz.png";
if (!existsSync(SRC)) {
  check("base 이미지 없음", false, SRC);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(1);
}

// 전체는 위상 스캔이 오래 걸린다 — 격자가 살아 있는 크롭으로 잰다.
const CROPS: Array<[string, { left: number; top: number; width: number; height: number }]> = [
  ["몸통", { left: 300, top: 400, width: 320, height: 320 }],
  ["머리", { left: 400, top: 150, width: 240, height: 240 }],
];

for (const [name, box] of CROPS) {
  console.log(`\n=== ${name} 크롭 ${box.width}x${box.height} ===`);
  const p = join(dir, `crop-${name}.png`);
  await sharp(SRC).extract(box).png().toFile(p);
  const img = await load(p);
  const g = detectPixelGrid(img);
  console.log(`  (검출) 피치 ${g.pitch.map(v => v.toFixed(2)).join(" x ")}`);

  const ref = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import (detect_pixel_grid, _boundary_mass, _grid_edges,
                                refine_edges_to_boundaries, _best_phase)
im = Image.open(${JSON.stringify(p)}).convert("RGBA")
(px, py), _ = detect_pixel_grid(im)
col, row = _boundary_mass(im)
ph = _best_phase(im, (px, py))
xs = _grid_edges(im.width, px, ph[0]); ys = _grid_edges(im.height, py, ph[1])
rxs, rys = refine_edges_to_boundaries(im, xs, ys, (px, py))
print(json.dumps({
  "pitch": [px, py], "phase": list(ph),
  "col_sum": sum(col), "row_sum": sum(row), "col_head": col[:20],
  "xs": xs, "ys": ys, "rxs": rxs, "rys": rys,
}))
`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as {
    pitch: number[]; phase: number[]; col_sum: number; row_sum: number; col_head: number[];
    xs: number[]; ys: number[]; rxs: number[]; rys: number[];
  };

  const bm = boundaryMass(img);
  let colSum = 0; for (const v of bm.col) colSum += v;
  let rowSum = 0; for (const v of bm.row) rowSum += v;
  check(`${name}: 경계 질량 합`, colSum === ref.col_sum && rowSum === ref.row_sum,
    `${colSum}/${rowSum} vs ${ref.col_sum}/${ref.row_sum}`);
  check(`${name}: 경계 질량 앞 20칸`, ref.col_head.every((v, i) => bm.col[i] === v));

  const ph = bestPhase(img, g.pitch);
  check(`${name}: 실측 위상 동일`,
    Math.abs(ph[0] - ref.phase[0]) < 1e-9 && Math.abs(ph[1] - ref.phase[1]) < 1e-9,
    `${JSON.stringify(ph)} vs ${JSON.stringify(ref.phase)}`);

  const xs = gridEdges(img.width, g.pitch[0], ph[0]);
  const ys = gridEdges(img.height, g.pitch[1], ph[1]);
  check(`${name}: 등간격 절단선`,
    JSON.stringify(xs) === JSON.stringify(ref.xs) && JSON.stringify(ys) === JSON.stringify(ref.ys),
    `${JSON.stringify(xs)} vs ${JSON.stringify(ref.xs)}`);

  const refined = refineEdgesToBoundaries(img, xs, ys, g.pitch);
  check(`${name}: 경계 스냅된 절단선`,
    JSON.stringify(refined.xs) === JSON.stringify(ref.rxs) &&
    JSON.stringify(refined.ys) === JSON.stringify(ref.rys),
    `${JSON.stringify(refined.xs)} vs ${JSON.stringify(ref.rxs)}`);

  // 최종 논리 프레임 — 바이트 동일
  for (const bias of [false, true]) {
    const outBin = join(dir, `snap-${name}-${bias}.bin`);
    const meta = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import snap_by_edges
im = Image.open(${JSON.stringify(p)}).convert("RGBA")
out = snap_by_edges(im, ${JSON.stringify(ref.rxs)}, ${JSON.stringify(ref.rys)}, ${bias ? "True" : "False"})
np.array(out).tofile(${JSON.stringify(outBin)})
print(json.dumps({"size": list(out.size)}))
`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as { size: number[] };
    const ours = snapByEdges(img, refined.xs, refined.ys, bias);
    check(`${name}: 논리 프레임 크기 (bias=${bias})`,
      ours.width === meta.size[0] && ours.height === meta.size[1],
      `${ours.width}x${ours.height} vs ${meta.size.join("x")}`);
    const refBytes = new Uint8Array(readFileSync(outBin));
    let diff = 0;
    for (let i = 0; i < Math.min(refBytes.length, ours.data.length); i++) {
      if (refBytes[i] !== ours.data[i]) diff++;
    }
    check(`${name}: 논리 프레임 **픽셀 동일** (bias=${bias})`,
      refBytes.length === ours.data.length && diff === 0,
      `${diff}/${refBytes.length} 바이트 불일치`);
  }

  // gridSnapDownscale 진입점도 같은 결과여야 한다 (경계 스냅 없이 등간격).
  const plainBin = join(dir, `plain-${name}.bin`);
  execFileSync(PY, ["-c", `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import grid_snap_downscale
im = Image.open(${JSON.stringify(p)}).convert("RGBA")
out = grid_snap_downscale(im, (${ref.pitch[0]}, ${ref.pitch[1]}), False, (${ref.phase[0]}, ${ref.phase[1]}))
np.array(out).tofile(${JSON.stringify(plainBin)})
`], { maxBuffer: 64 * 1024 * 1024 });
  const plain = gridSnapDownscale(img, g.pitch, false, ph);
  const plainRef = new Uint8Array(readFileSync(plainBin));
  let pd = 0;
  for (let i = 0; i < Math.min(plainRef.length, plain.data.length); i++) {
    if (plainRef[i] !== plain.data[i]) pd++;
  }
  check(`${name}: gridSnapDownscale 픽셀 동일`,
    plainRef.length === plain.data.length && pd === 0,
    `${pd}/${plainRef.length} 바이트 불일치`);
  console.log(`  (결과) ${img.width}x${img.height} → 논리 ${plain.width}x${plain.height}`);

  // 눈으로 볼 수 있게 남긴다 (8배 확대).
  await sharp(Buffer.from(plain.data), { raw: { width: plain.width, height: plain.height, channels: 4 } })
    .resize(plain.width * 8, plain.height * 8, { kernel: "nearest" })
    .png().toFile(join(dir, `logical-${name}.png`));
}

console.log("\n=== 추출 옵션 파생 (배율 식의 소유자는 한 곳) ===");
{
  const cell = { shape: "square" as const, width: 256, height: 256, safeMarginX: 24, safeMarginY: 24 };
  const mk = (fit?: Record<string, unknown>) => ({ cell, fit } as unknown as Parameters<typeof pixelUnfakeOptions>[0]);

  check("꺼져 있으면 아무것도 안 붙는다", JSON.stringify(pixelUnfakeOptions(mk())) === "{}");
  check("fit 은 있지만 pixel_unfake 가 없으면 꺼짐",
    JSON.stringify(pixelUnfakeOptions(mk({ segmentation: "projection" }))) === "{}");

  const on = pixelUnfakeOptions(mk({ pixel_unfake: true }));
  check("켜면 배율 1x, 논리 256 (logical_height 생략 = 셀 높이)",
    on.pixelUnfake?.scale === 1 && on.pixelUnfake?.logicalHeight === 256 && on.pixelUnfake?.logicalWidth === 256,
    JSON.stringify(on));
  check("detailBias 기본 true", on.pixelUnfake?.detailBias === true);

  const chunky = pixelUnfakeOptions(mk({ pixel_unfake: true, logical_height: 64 }));
  check("logical_height 64 → 배율 4x", chunky.pixelUnfake?.scale === 4 && chunky.pixelUnfake?.logicalHeight === 64,
    JSON.stringify(chunky));

  // 셀 높이의 약수가 아니면 정수 배율이 선언을 무효화한다 (정본이 경고로 관측시키는 지점).
  const invalid = pixelUnfakeOptions(mk({ pixel_unfake: true, logical_height: 48 }));
  check("약수가 아닌 선언은 배율 5x 로 접힌다 (선언 무효)",
    invalid.pixelUnfake?.scale === 5 && invalid.pixelUnfake?.logicalHeight === 51,
    JSON.stringify(invalid));

  const noBias = pixelUnfakeOptions(mk({ pixel_unfake: true, detail_bias: false }));
  check("detail_bias 명시 false 가 전달된다", noBias.pixelUnfake?.detailBias === false);
}

console.log("\n=== kCentroid 축소: 정본과 픽셀 동일 ===");
{
  const p2 = join(dir, "crop-몸통.png");
  const img = await load(p2);
  for (const [tw, th, bias] of [[41, 41, false], [41, 41, true], [24, 24, true], [70, 33, false]] as Array<[number, number, boolean]>) {
    const outBin = join(dir, `kc-${tw}-${th}-${bias}.bin`);
    const meta = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import _kcentroid_downscale
im = Image.open(${JSON.stringify(p2)}).convert("RGBA")
out = _kcentroid_downscale(im, ${tw}, ${th}, ${bias ? "True" : "False"})
np.array(out).tofile(${JSON.stringify(outBin)})
print(json.dumps({"size": list(out.size)}))
`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as { size: number[] };
    const ours = kcentroidDownscale(img, tw, th, bias);
    const ref = new Uint8Array(readFileSync(outBin));
    let diff = 0;
    for (let i = 0; i < Math.min(ref.length, ours.data.length); i++) if (ref[i] !== ours.data[i]) diff++;
    check(`kCentroid ${img.width}x${img.height} → ${tw}x${th} bias=${bias} 픽셀 동일`,
      ours.width === meta.size[0] && ours.height === meta.size[1] &&
      ref.length === ours.data.length && diff === 0,
      `${diff}/${ref.length} 바이트 불일치`);
  }
}

console.log("\n=== 행 크기 통일 (conformRowLogical) ===");
{
  const mk = (w: number, h: number, v: number): RawImageBuf => {
    const data = Buffer.alloc(w * h * 4);
    for (let p3 = 0; p3 < w * h; p3++) {
      data[p3 * 4] = v; data[p3 * 4 + 1] = v; data[p3 * 4 + 2] = v; data[p3 * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  };
  // 규격 안이면 축소하지 않는다.
  const small = conformRowLogical([mk(40, 60, 100), mk(50, 55, 120)], 256, 256);
  check("규격 안이면 축소 안 함", small.conformed === false && small.scale === 1);
  check("알파는 이진화된다", small.frames.every(f => f.data[3] === 255));

  // 넘으면 **행에서 가장 큰 프레임 기준 한 배율**을 전부에 건다.
  const big = conformRowLogical([mk(300, 200, 100), mk(150, 100, 120)], 256, 256);
  check("규격을 넘으면 축소한다", big.conformed === true);
  check("배율이 최대 프레임 기준", Math.abs(big.scale - 256 / 300) < 1e-9, String(big.scale));
  check("두 프레임이 같은 배율로 줄었다",
    big.frames[0].width <= 256 && big.frames[0].height <= 256 &&
    Math.abs(big.frames[1].width / 150 - big.frames[0].width / 300) < 0.02,
    `${big.frames[0].width}x${big.frames[0].height}, ${big.frames[1].width}x${big.frames[1].height}`);
}

console.log(`\n${pass} passed / ${fail} failed`);
console.log(`(논리 프레임 확대본: ${dir})`);
process.exit(fail === 0 ? 0 : 1);
})();
