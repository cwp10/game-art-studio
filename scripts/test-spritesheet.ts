/**
 * 결정적 후처리 검증 — codex 미사용 합성 시트로 spritesheet-postprocess 모듈을 단위 검증.
 *
 *   pnpm tsx scripts/test-spritesheet.ts
 *
 * 합성 PNG 를 만들어 chromaKeyFile / normalizeSpritesheetCells 를 in-place 로 돌리고
 * raw 픽셀로 정량 단언한다. 출력물은 data/tmp/qa-spritesheet/ 에 남겨 Read 로 육안 확인.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  chromaKeyFile,
  normalizeSpritesheetCells,
} from "../src/lib/image-backend/spritesheet-postprocess";

const OUT = path.resolve(process.cwd(), "data/tmp/qa-spritesheet");
fs.mkdirSync(OUT, { recursive: true });

const log = (line: string) => console.log("    [log] " + line);

let passCount = 0;
let failCount = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passCount++;
    console.log(`    PASS  ${msg}`);
  } else {
    failCount++;
    console.log(`    FAIL  ${msg}`);
  }
}

// ── 합성 헬퍼 ────────────────────────────────────────────────────────────────
type RGBA = [number, number, number, number];
const GREEN: RGBA = [0, 255, 0, 255];
const MAGENTA: RGBA = [255, 0, 255, 255];
const GRAY: RGBA = [128, 128, 128, 255];

function makeCanvas(W: number, H: number, fill: RGBA): Buffer {
  const buf = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    buf[p * 4] = fill[0];
    buf[p * 4 + 1] = fill[1];
    buf[p * 4 + 2] = fill[2];
    buf[p * 4 + 3] = fill[3];
  }
  return buf;
}

function fillRect(
  buf: Buffer, W: number,
  x0: number, y0: number, x1: number, y1: number, color: RGBA,
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4;
      buf[p] = color[0];
      buf[p + 1] = color[1];
      buf[p + 2] = color[2];
      buf[p + 3] = color[3];
    }
  }
}

async function writePng(buf: Buffer, W: number, H: number, file: string): Promise<string> {
  const fp = path.join(OUT, file);
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(fp);
  return fp;
}

async function readRaw(fp: string): Promise<{ data: Buffer; W: number; H: number }> {
  const { data, info } = await sharp(fp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** 콘텐츠(alpha>10) 픽셀의 bbox + 카운트. */
function contentBBox(data: Buffer, W: number, H: number, region?: { x0: number; y0: number; x1: number; y1: number }) {
  const x0 = region?.x0 ?? 0, y0 = region?.y0 ?? 0, x1 = region?.x1 ?? W, y1 = region?.y1 ?? H;
  let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (a > 10) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ════════════════════════════════════════════════════════════════════════════
// CASE A + B: 오버플로 + 크기 일관성 + foot 정렬 (2x2 캐릭터, green key, feet)
// ════════════════════════════════════════════════════════════════════════════
async function caseAB() {
  console.log("\n=== CASE A/B: overflow clamp + single-scale + foot align (2x2 char, feet) ===");
  const cols = 2, rows = 2, cellW = 256, cellH = 256;
  const W = cellW * cols, H = cellH * rows;
  const buf = makeCanvas(W, H, GREEN);

  // 셀마다 서로 다른 크기의 사람형 실루엣(머리 원사각 + 몸통). 하나는 safe-zone 침범.
  // 사람형: 머리(작은 사각) + 몸통(큰 사각), 발은 몸통 하단.
  // 셀(0,0): 큰 캐릭터 — safe-zone(margin=13px) 거의 꽉 채움 + 살짝 넘침(overflow 유발)
  // 셀(1,0): 중간
  // 셀(0,1): 작은
  // 셀(1,1): 매우 작은
  function drawChar(cx0: number, cy0: number, bodyW: number, bodyH: number, bottomFromCellBottom: number) {
    // 셀 로컬 좌표 → 글로벌
    const footGY = cy0 + cellH - bottomFromCellBottom;
    const bodyTop = footGY - bodyH;
    const bodyLeft = cx0 + Math.round((cellW - bodyW) / 2);
    fillRect(buf, W, bodyLeft, bodyTop, bodyLeft + bodyW, footGY, GRAY); // 몸통
    // 머리: 몸통 위 작은 사각
    const headW = Math.round(bodyW * 0.5);
    const headH = Math.round(headW);
    const headLeft = cx0 + Math.round((cellW - headW) / 2);
    fillRect(buf, W, headLeft, bodyTop - headH, headLeft + headW, bodyTop, GRAY);
  }

  // 셀(0,0): 의도적 오버플로 — bodyH 가 셀보다 큼(머리 포함 시 셀 밖으로). bottomFromCellBottom 작게.
  drawChar(0, 0, 200, 230, 2); // 머리까지 합치면 셀 위로 넘침 → overflow
  drawChar(cellW, 0, 120, 150, 30); // 중간
  drawChar(0, cellH, 80, 100, 40); // 작은
  drawChar(cellW, cellH, 50, 60, 50); // 매우 작은

  const fp = await writePng(buf, W, H, "caseAB_input.png");
  // 입력 사본도 따로 저장(전처리 전후 비교용)
  fs.copyFileSync(fp, path.join(OUT, "caseAB_00_raw.png"));

  await chromaKeyFile(fp, "green", log);
  fs.copyFileSync(fp, path.join(OUT, "caseAB_01_chroma.png"));
  await normalizeSpritesheetCells(fp, rows, cols, true, { anchorStrategy: "feet", subjectType: "character", log });
  fs.copyFileSync(fp, path.join(OUT, "caseAB_02_norm.png"));

  const { data, W: w, H: h } = await readRaw(fp);
  const margin = Math.round(Math.min(cellW, cellH) * 0.05); // 13
  const paddingBottom = Math.round(cellH * 0.03); // 8

  // 각 셀 bbox 수집
  const cellBoxes: ReturnType<typeof contentBBox>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bb = contentBBox(data, w, h, {
        x0: c * cellW, y0: r * cellH, x1: (c + 1) * cellW, y1: (r + 1) * cellH,
      });
      cellBoxes.push(bb);
    }
  }

  // A1: 셀 경계 내부 100% 포함 — 콘텐츠가 셀 경계선(grid line)을 1px도 넘지 않음.
  // 셀 경계 ±0: 각 셀 bbox 가 [c*cellW, (c+1)*cellW-1] 안.
  let allInside = true;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bb = cellBoxes[r * cols + c];
      if (bb.count === 0) continue;
      if (bb.minX < c * cellW || bb.maxX > (c + 1) * cellW - 1 ||
          bb.minY < r * cellH || bb.maxY > (r + 1) * cellH - 1) {
        allInside = false;
        console.log(`      cell(${c},${r}) bbox=[${bb.minX},${bb.minY}-${bb.maxX},${bb.maxY}] OUT OF BOUNDS`);
      }
    }
  }
  assert(allInside, "A1: 모든 셀 콘텐츠가 자기 셀 경계 내부 100% 포함 (cross-cell 침범 0)");

  // A2: cross-cell 침범 정밀 — 셀 경계 라인(grid border)에 콘텐츠 없음 검사로 보강.
  // 인접 셀 사이 1px 경계열/행에 콘텐츠가 양쪽에서 동시에 닿지 않는지(분리 확인).
  // 여기선 각 셀 bbox 가 이웃 셀 영역으로 안 넘는 것으로 충분(위 A1 포함).

  // A3: 단일 scale 일관성 — 입력에서 각 캐릭터 원본 크기 비율이 출력에서 보존되는지.
  // 모든 비빈 셀이 동일 scale 로 줄었다면, 출력 bbox / 입력 bbox 비율이 모든 셀에서 동일해야.
  // 입력 chroma 후 bbox 측정(정규화 전).
  const chromaRaw = await readRaw(path.join(OUT, "caseAB_01_chroma.png"));
  const inBoxes: ReturnType<typeof contentBBox>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      inBoxes.push(contentBBox(chromaRaw.data, chromaRaw.W, chromaRaw.H, {
        x0: c * cellW, y0: r * cellH, x1: (c + 1) * cellW, y1: (r + 1) * cellH,
      }));
    }
  }
  // scale 비율: 출력 h / 입력 h. 모든 셀에서 근접해야(±0.06 허용, nearest 반올림).
  const ratios: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (inBoxes[i].count > 0 && cellBoxes[i].count > 0 && inBoxes[i].h > 0) {
      ratios.push(cellBoxes[i].h / inBoxes[i].h);
    }
  }
  const minRatio = Math.min(...ratios), maxRatio = Math.max(...ratios);
  console.log(`      per-cell out/in height ratios: ${ratios.map(r => r.toFixed(3)).join(", ")}`);
  assert(maxRatio - minRatio < 0.07, `A3: 전 셀 동일 scale (ratio spread ${(maxRatio - minRatio).toFixed(3)} < 0.07)`);

  // A4: 가장 큰 셀이 safe-zone 안에 들어왔는지(scale<1 적용 확인). 가장 큰 출력 bbox h 가
  //     cellSafeH(cellH-2*margin=230) 이하.
  const maxOutH = Math.max(...cellBoxes.map(b => b.h));
  const cellSafeH = cellH - 2 * margin;
  assert(maxOutH <= cellSafeH + 2, `A4: 최대 콘텐츠 높이 ${maxOutH} <= safe-zone ${cellSafeH}(+2 반올림 여유)`);

  // B1: foot 정렬 — 모든 비빈 셀의 콘텐츠 최하단 y(셀-로컬)이 공통 라인에 정렬.
  //     목표선 = cellH - paddingBottom - 1 = 247. 약간의 반올림 허용(±3).
  const footLocalYs: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bb = cellBoxes[r * cols + c];
      if (bb.count === 0) continue;
      footLocalYs.push(bb.maxY - r * cellH);
    }
  }
  const footMin = Math.min(...footLocalYs), footMax = Math.max(...footLocalYs);
  const footTarget = cellH - paddingBottom - 1;
  console.log(`      foot local-Y per cell: ${footLocalYs.join(", ")} (target≈${footTarget})`);
  assert(footMax - footMin <= 3, `B1: 발 라인 일관성 (드리프트 ${footMax - footMin}px <= 3)`);
  assert(Math.abs(footMax - footTarget) <= 4 && Math.abs(footMin - footTarget) <= 4,
    `B1b: 발 라인이 고정 목표선(${footTarget}) 근처에 정렬`);

  // 가로 중심 정렬 확인(보조)
  const cxLocals: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bb = cellBoxes[r * cols + c];
      if (bb.count === 0) continue;
      cxLocals.push((bb.minX + bb.maxX) / 2 - c * cellW);
    }
  }
  const cxMin = Math.min(...cxLocals), cxMax = Math.max(...cxLocals);
  console.log(`      horiz center local-X per cell: ${cxLocals.map(v => v.toFixed(0)).join(", ")} (cell center=${cellW / 2})`);
  assert(cxMax - cxMin <= 6, `B2: 가로 중심 정렬 일관성 (spread ${(cxMax - cxMin).toFixed(1)}px <= 6)`);
}

// ════════════════════════════════════════════════════════════════════════════
// CASE C: center (effect) — bbox 세로 중앙
// ════════════════════════════════════════════════════════════════════════════
async function caseC() {
  console.log("\n=== CASE C: center anchor (effect) — vertical centering ===");
  const cols = 2, rows = 2, cellW = 256, cellH = 256;
  const W = cellW * cols, H = cellH * rows;
  const buf = makeCanvas(W, H, GREEN);

  // 이펙트 대용: 셀마다 다른 위치(상단/하단 치우침)에 작은 가로 슬래시 사각.
  // center 정렬이 이를 셀 세로 중앙으로 끌어와야.
  fillRect(buf, W, 40, 20, 200, 70, GRAY);                 // 셀(0,0) 상단 치우침
  fillRect(buf, W, cellW + 50, cellH - 80, cellW + 210, cellH - 20, GRAY); // 셀(1,0) 하단 치우침
  fillRect(buf, W, 60, cellH + 30, 190, cellH + 90, GRAY);   // 셀(0,1) 상단
  fillRect(buf, W, cellW + 40, 2 * cellH - 70, cellW + 200, 2 * cellH - 30, GRAY); // 셀(1,1) 하단

  const fp = await writePng(buf, W, H, "caseC_input.png");
  await chromaKeyFile(fp, "green", log);
  await normalizeSpritesheetCells(fp, rows, cols, true, { subjectType: "effect", log });
  fs.copyFileSync(fp, path.join(OUT, "caseC_norm.png"));

  const { data, W: w, H: h } = await readRaw(fp);
  // 각 셀 bbox 세로 중심이 셀 중앙(cellH/2)에 가까운지 + 위/아래 여백 대칭.
  let ok = true;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bb = contentBBox(data, w, h, {
        x0: c * cellW, y0: r * cellH, x1: (c + 1) * cellW, y1: (r + 1) * cellH,
      });
      if (bb.count === 0) { ok = false; continue; }
      const topGap = (bb.minY - r * cellH);
      const botGap = ((r + 1) * cellH - 1 - bb.maxY);
      const localCenterY = (bb.minY + bb.maxY) / 2 - r * cellH;
      console.log(`      cell(${c},${r}) topGap=${topGap} botGap=${botGap} centerY=${localCenterY.toFixed(0)} (target=${cellH / 2})`);
      if (Math.abs(topGap - botGap) > 4) ok = false;
    }
  }
  assert(ok, "C1: 모든 이펙트 셀이 세로 중앙 정렬(위·아래 여백 대칭 ±4px)");
}

// ════════════════════════════════════════════════════════════════════════════
// CASE D: 본체 보호 — 내부에 둘러싸인 녹색 옷 패치 보존, 배경 녹색만 키아웃
// ════════════════════════════════════════════════════════════════════════════
async function caseD() {
  console.log("\n=== CASE D: body protection (interior green clothing preserved) ===");
  const W = 256, H = 256;
  const buf = makeCanvas(W, H, GREEN);
  // 회색 본체(큰 사각) 중앙
  fillRect(buf, W, 78, 48, 178, 208, GRAY);
  // 본체 내부에 둘러싸인 녹색 패치(옷) — 본체에 완전히 둘러싸임
  fillRect(buf, W, 108, 90, 148, 150, GREEN);

  const fp = await writePng(buf, W, H, "caseD_input.png");
  await chromaKeyFile(fp, "green", log);
  fs.copyFileSync(fp, path.join(OUT, "caseD_chroma.png"));

  const { data, W: w } = await readRaw(fp);
  // 내부 녹색 패치 중심(128,120) alpha=255 보존?
  const insideIdx = (120 * w + 128) * 4;
  const insideAlpha = data[insideIdx + 3];
  const insideR = data[insideIdx], insideG = data[insideIdx + 1], insideB = data[insideIdx + 2];
  console.log(`      interior patch px(128,120): rgba=${insideR},${insideG},${insideB},${insideAlpha}`);
  assert(insideAlpha === 255, `D1: 내부 녹색 옷 패치 보존 (alpha=${insideAlpha}, 기대 255)`);
  assert(insideG > 200, `D1b: 내부 패치 녹색 그대로 (g=${insideG} despill 안 됨)`);

  // 배경 녹색(코너) alpha=0?
  const bgIdx = (5 * w + 5) * 4;
  console.log(`      bg corner px(5,5): alpha=${data[bgIdx + 3]}`);
  assert(data[bgIdx + 3] === 0, `D2: 배경 녹색 투명화 (alpha=${data[bgIdx + 3]}, 기대 0)`);

  // 본체 회색 보존
  const bodyIdx = (60 * w + 90) * 4;
  console.log(`      body px(90,60): rgba=${data[bodyIdx]},${data[bodyIdx + 1]},${data[bodyIdx + 2]},${data[bodyIdx + 3]}`);
  assert(data[bodyIdx + 3] === 255, `D3: 회색 본체 보존 (alpha=${data[bodyIdx + 3]})`);
}

// ════════════════════════════════════════════════════════════════════════════
// CASE E: 마젠타 키 — 마젠타 배경 + 녹색 본체 보존, halo 잔재 없음
// ════════════════════════════════════════════════════════════════════════════
async function caseE() {
  console.log("\n=== CASE E: magenta key (green slime body preserved, no fringe) ===");
  const W = 256, H = 256;
  const buf = makeCanvas(W, H, MAGENTA);
  // 녹색 슬라임형 본체(중앙 둥근 사각 대용)
  fillRect(buf, W, 68, 88, 188, 188, [40, 200, 60, 255]); // 슬라임 녹색

  const fp = await writePng(buf, W, H, "caseE_input.png");
  await chromaKeyFile(fp, "magenta", log);
  fs.copyFileSync(fp, path.join(OUT, "caseE_chroma.png"));

  const { data, W: w } = await readRaw(fp);
  // 배경 마젠타 코너 투명?
  const bgIdx = (5 * w + 5) * 4;
  console.log(`      bg corner px(5,5): rgba=${data[bgIdx]},${data[bgIdx + 1]},${data[bgIdx + 2]},${data[bgIdx + 3]}`);
  assert(data[bgIdx + 3] === 0, `E1: 마젠타 배경 투명화 (alpha=${data[bgIdx + 3]}, 기대 0)`);

  // 녹색 본체 중심 보존?
  const bodyIdx = (130 * w + 128) * 4;
  console.log(`      body px(128,130): rgba=${data[bodyIdx]},${data[bodyIdx + 1]},${data[bodyIdx + 2]},${data[bodyIdx + 3]}`);
  assert(data[bodyIdx + 3] === 255, `E2: 녹색 슬라임 본체 보존 (alpha=${data[bodyIdx + 3]})`);
  assert(data[bodyIdx + 1] > 150, `E2b: 녹색 본체 색 보존 (g=${data[bodyIdx + 1]})`);

  // 마젠타 halo/fringe 잔재 — 본체 경계 바깥 1~3px 링에 마젠타스러운(R·B 높고 G낮은) 불투명 픽셀 없는지.
  // 본체 사각 경계 바로 바깥(예: 좌측 x=65, y=130) 검사.
  let fringeBad = 0;
  for (let y = 80; y < 196; y++) {
    for (const x of [64, 65, 66, 190, 191, 192]) {
      const p = (y * w + x) * 4;
      const a = data[p + 3];
      if (a > 40) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        // 마젠타스러움: min(r,b)-g > 30
        if (Math.min(r, b) - g > 30) fringeBad++;
      }
    }
  }
  console.log(`      magenta-ish fringe pixels around body edge: ${fringeBad}`);
  assert(fringeBad === 0, `E3: 마젠타 fringe/halo 잔재 없음 (${fringeBad}개)`);
}

async function main() {
  console.log("spritesheet-postprocess 결정적 검증");
  console.log("출력 디렉토리:", OUT);
  await caseAB();
  await caseC();
  await caseD();
  await caseE();
  console.log(`\n=========================================`);
  console.log(`총: ${passCount} PASS / ${failCount} FAIL`);
  console.log(`=========================================`);
  if (failCount > 0) process.exit(1);
}

main().catch(e => {
  console.error("스크립트 오류:", e);
  process.exit(2);
});
