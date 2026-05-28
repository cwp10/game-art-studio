/**
 * 스프라이트시트 결정적 후처리 — sharp + node:fs 만 의존하는 순수 픽셀 모듈.
 *
 * server.ts(MCP) 에서 추출해 codex 미사용 합성 시트로 단위 검증 가능하게 분리.
 * top-level 사이드이펙트 없음(DB·서버 기동 금지) — tsx import 안전.
 *
 * 책임:
 *  - chromaKeyFile: green/magenta 적응형 키잉 + despill + 테두리-connected 배경만 키아웃(본체 보호)
 *  - normalizeSpritesheetCells: 글로벌 컴포넌트 라벨링 → 시트-전역 단일 scale-to-fit
 *    → 앵커 전략별 정렬(feet/hip/center/top, footY 중앙값 robust 보정)
 */
import fs from "node:fs";
import sharp from "sharp";

export type AnchorStrategy = "auto" | "feet" | "hip" | "center" | "top";
export type SubjectType = "character" | "effect";
export type ChromaKeyColor = "green" | "magenta";

type Logger = (line: string) => void;
const noop: Logger = () => {};

/**
 * chroma-key 처리 (in-place). keyColor 에 따라 keyness 정의가 다름:
 *   - green:   keyness = g - max(r,b)   (#00ff00 류)
 *   - magenta: keyness = min(r,b) - g   (#ff00ff 류 — R·B 높고 G 낮음)
 *
 * 처리:
 *   1. 적응형 임계값: 명백한 키 픽셀들의 keyness 분포를 샘플링해 hard-key 임계값을
 *      실제 톤에 맞춰 보수적으로 보정(기본 40 근처에서 제한 범위 내).
 *   2. 본체 보호: 시트 가장자리에서 4-connectivity 로 도달 가능한 키 픽셀(=배경)만
 *      투명화. 캐릭터에 둘러싸인 내부 키색(녹색 옷 안쪽)은 보존.
 *   3. despill: 배경-connected 영역 경계의 fringe 픽셀 키 채널을 탈채도 + 알파 감쇠.
 */
export async function chromaKeyFile(
  filePath: string,
  keyColor: ChromaKeyColor = "green",
  log: Logger = noop,
): Promise<void> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const W = info.width;
  const H = info.height;
  const N = W * H;

  // keyness: 키 색에 가까울수록 큰 양수.
  const keyness = (i: number): number => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return keyColor === "green" ? g - Math.max(r, b) : Math.min(r, b) - g;
  };
  // 키색 dominant 채널이 충분히 밝은지(확실한 키 픽셀 판정 보조).
  const keyChannelBright = (i: number): boolean =>
    keyColor === "green" ? data[i + 1] > 90 : data[i] > 90 && data[i + 2] > 90;

  // 1. 적응형 hard 임계값 — 명백한 키 픽셀(keyness>60)의 중앙값 keyness 를 보고
  //    기본 40 을 [30,50] 범위로 보정. 분포가 약하면 기본 유지(보수적).
  const strong: number[] = [];
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    const k = keyness(i);
    if (k > 60 && keyChannelBright(i)) strong.push(k);
  }
  let hardThresh = 40;
  if (strong.length > N * 0.02) {
    strong.sort((a, b) => a - b);
    const median = strong[Math.floor(strong.length / 2)];
    // 키 톤이 어둡게(낮은 keyness) 그려졌으면 임계값을 약간 낮춰 잔재를 더 잡되,
    // 캐릭터를 먹지 않도록 [30,50] 으로 클램프.
    hardThresh = Math.max(30, Math.min(50, Math.round(median * 0.5)));
  }
  const fringeFloor = 5;
  const fringeSpan = Math.max(10, hardThresh - fringeFloor);

  // 2. hard-key 후보 마스크.
  const isHardKey = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    if (keyness(i) > hardThresh && keyChannelBright(i)) isHardKey[p] = 1;
  }

  // 3. 테두리에서 flood fill(4-conn) → 배경-connected hard-key 만 bgKey=1.
  //    내부에 둘러싸인 키색(녹색 옷 안쪽)은 도달 못 해 보존됨.
  const bgKey = new Uint8Array(N);
  const stack: number[] = [];
  const pushIfKey = (p: number) => {
    if (p >= 0 && p < N && isHardKey[p] === 1 && bgKey[p] === 0) {
      bgKey[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) {
    pushIfKey(x); // top row
    pushIfKey((H - 1) * W + x); // bottom row
  }
  for (let y = 0; y < H; y++) {
    pushIfKey(y * W); // left col
    pushIfKey(y * W + (W - 1)); // right col
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % W;
    if (x > 0) pushIfKey(p - 1);
    if (x < W - 1) pushIfKey(p + 1);
    if (p >= W) pushIfKey(p - W);
    if (p < N - W) pushIfKey(p + W);
  }

  // 4. 적용: 배경-connected hard-key → 투명. 그 경계에 인접한 fringe → despill + 알파 감쇠.
  let keyedOut = 0;
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    if (bgKey[p] === 1) {
      data[i + 3] = 0;
      keyedOut++;
      continue;
    }
    if (data[i + 3] === 0) continue;
    const k = keyness(i);
    if (k <= fringeFloor) continue;
    // fringe 는 배경(bgKey)에 인접한 경우만 처리 — 내부 키색 보존.
    const x = p % W;
    const y = (p - x) / W;
    const nearBg =
      (x > 0 && bgKey[p - 1] === 1) ||
      (x < W - 1 && bgKey[p + 1] === 1) ||
      (y > 0 && bgKey[p - W] === 1) ||
      (y < H - 1 && bgKey[p + W] === 1);
    if (!nearBg) continue;
    // despill: 키 채널을 반대 채널 쪽으로 끌어내림(green→g=max(r,b), magenta→r,b=g).
    if (keyColor === "green") {
      data[i + 1] = Math.max(data[i], data[i + 2]);
    } else {
      data[i] = data[i + 1];
      data[i + 2] = data[i + 1];
    }
    const fade = 1 - Math.min(1, (k - fringeFloor) / fringeSpan);
    data[i + 3] = Math.round(data[i + 3] * fade);
  }

  const tmpPath = filePath + ".chroma.tmp";
  await sharp(data, {
    raw: { width: W, height: H, channels: ch as 1 | 2 | 3 | 4 },
  })
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
  log(`chromaKeyFile(${keyColor}): hardThresh=${hardThresh} keyedOut=${keyedOut}/${N}`);
}

/** auto → subjectType 기반 구체 전략. character=feet, effect=center. */
function resolveAnchor(strategy: AnchorStrategy, subjectType: SubjectType): Exclude<AnchorStrategy, "auto"> {
  if (strategy !== "auto") return strategy;
  return subjectType === "effect" ? "center" : "feet";
}

/**
 * 스프라이트 시트 후처리 (글로벌 connected components + 시트-전역 단일 scale-to-fit):
 *   패스1(측정/추출): 비빈 셀별 keep-union bbox + footY/hipY/headTopY/mainCenterX 수집,
 *                     maxBbW/maxBbH 누적.
 *   패스2(단일 scale): scale=min(1, cellSafeW/maxBbW, cellSafeH/maxBbH). scale<1 이면
 *                     모든 셀 콘텐츠를 같은 scale 로 축소(nearest, 픽셀아트 보호).
 *   패스3(배치): 앵커 전략별 세로 정렬(feet/hip/top 은 footY/hipY/headTopY 의 cell-local
 *               중앙값을 robust 보정에만 사용, 목표선은 고정선). center 는 셀별 bbox 중앙.
 */
export async function normalizeSpritesheetCells(
  filePath: string,
  rows: number,
  cols: number,
  wantsTransparent: boolean,
  opts: { anchorStrategy?: AnchorStrategy; subjectType?: SubjectType; log?: Logger } = {},
): Promise<void> {
  const log = opts.log ?? noop;
  const subjectType: SubjectType = opts.subjectType ?? "character";
  const anchor = resolveAnchor(opts.anchorStrategy ?? "auto", subjectType);

  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const N = W * H;
  const paddingBottom = Math.round(cellH * 0.03);
  const margin = Math.round(Math.min(cellW, cellH) * 0.05);

  const isContent = (i: number) => {
    if (wantsTransparent) return data[i + 3] > 10;
    return !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
  };

  // 1. 시트 전체 마스크
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (isContent(i * ch)) mask[i] = 1;
  }

  // 2. 글로벌 4-connectivity 라벨링
  const labels = new Int32Array(N);
  const sizes: number[] = [0];
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    labels[start] = next;
    let size = 0;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0 && mask[p - 1] === 1 && labels[p - 1] === 0) {
        labels[p - 1] = next;
        stack.push(p - 1);
      }
      if (x < W - 1 && mask[p + 1] === 1 && labels[p + 1] === 0) {
        labels[p + 1] = next;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - W] === 1 && labels[p - W] === 0) {
        labels[p - W] = next;
        stack.push(p - W);
      }
      if (y < H - 1 && mask[p + W] === 1 && labels[p + W] === 0) {
        labels[p + W] = next;
        stack.push(p + W);
      }
    }
    sizes.push(size);
    next++;
  }
  if (sizes.length <= 1) {
    log(`normalizeSpritesheetCells: empty sheet, skipping`);
    return;
  }

  // 3. 컴포넌트별 픽셀 인덱스 + bbox + 셀별 픽셀 카운트
  const compPixels: number[][] = Array.from({ length: sizes.length }, () => []);
  const compCellCount: Map<number, number>[] = Array.from({ length: sizes.length }, () => new Map());
  const compMinX = new Int32Array(sizes.length).fill(W);
  const compMinY = new Int32Array(sizes.length).fill(H);
  const compMaxX = new Int32Array(sizes.length).fill(-1);
  const compMaxY = new Int32Array(sizes.length).fill(-1);
  for (let i = 0; i < N; i++) {
    const l = labels[i];
    if (l === 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    compPixels[l].push(i);
    if (x < compMinX[l]) compMinX[l] = x;
    if (y < compMinY[l]) compMinY[l] = y;
    if (x > compMaxX[l]) compMaxX[l] = x;
    if (y > compMaxY[l]) compMaxY[l] = y;
    const ci = Math.floor(y / cellH) * cols + Math.floor(x / cellW);
    compCellCount[l].set(ci, (compCellCount[l].get(ci) ?? 0) + 1);
  }

  // 4. 각 컴포넌트 → 가장 많은 픽셀이 있는 셀에 할당
  const labelsPerCell = new Map<number, number[]>();
  for (let l = 1; l < sizes.length; l++) {
    let maxCount = 0;
    let assigned = 0;
    for (const [ci, count] of compCellCount[l]) {
      if (count > maxCount) {
        maxCount = count;
        assigned = ci;
      }
    }
    if (!labelsPerCell.has(assigned)) labelsPerCell.set(assigned, []);
    labelsPerCell.get(assigned)!.push(l);
  }

  // ── 패스 1: 측정·추출 ──────────────────────────────────────────────────────
  // 비빈 셀별 추출 콘텐츠(bbBuf) + 정렬 기준점(글로벌 좌표)을 모으고 max bbox 누적.
  type Cell = {
    bbBuf: Buffer;
    bbW: number;
    bbH: number;
    bMinX: number;
    bMinY: number;
    footY: number; // 본체 발 라인 (글로벌 y)
    headTopY: number; // 본체 머리 라인 (글로벌 y) = 메인 컴포넌트 minY
    mainCenterX: number; // 본체 가로 무게중심 (글로벌 x)
    cellX0: number;
    cellY0: number;
  };
  const cells: Cell[] = [];
  let maxBbW = 1;
  let maxBbH = 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellIdx = r * cols + c;
      const cellX0 = c * cellW;
      const cellY0 = r * cellH;
      const assigned = labelsPerCell.get(cellIdx);
      if (!assigned || assigned.length === 0) continue;

      // 메인 = 가장 큰 컴포넌트
      let mainLabel = assigned[0];
      let maxSize = sizes[mainLabel];
      for (const l of assigned) {
        if (sizes[l] > maxSize) {
          maxSize = sizes[l];
          mainLabel = l;
        }
      }

      // 메인 bbox + margin (글로벌 좌표)
      const exMinX = compMinX[mainLabel] - margin;
      const exMinY = compMinY[mainLabel] - margin;
      const exMaxX = compMaxX[mainLabel] + margin;
      const exMaxY = compMaxY[mainLabel] + margin;

      // 보존할 컴포넌트
      const minKeep = Math.max(4, Math.floor(maxSize * 0.1));
      const keep: number[] = [mainLabel];
      for (const l of assigned) {
        if (l === mainLabel) continue;
        if (sizes[l] >= minKeep) {
          keep.push(l);
          continue;
        }
        let sx = 0, sy = 0;
        for (const idx of compPixels[l]) {
          sx += idx % W;
          sy += Math.floor(idx / W);
        }
        const cxg = sx / compPixels[l].length;
        const cyg = sy / compPixels[l].length;
        const inMainBox = cxg >= exMinX && cxg <= exMaxX && cyg >= exMinY && cyg <= exMaxY;
        const inSafeZone =
          cxg >= cellX0 + margin && cxg <= cellX0 + cellW - margin &&
          cyg >= cellY0 + margin && cyg <= cellY0 + cellH - margin;
        if (inMainBox || inSafeZone) keep.push(l);
      }

      // 보존 컴포넌트의 union bbox (글로벌)
      let bMinX = W, bMinY = H, bMaxX = -1, bMaxY = -1;
      for (const l of keep) {
        if (compMinX[l] < bMinX) bMinX = compMinX[l];
        if (compMinY[l] < bMinY) bMinY = compMinY[l];
        if (compMaxX[l] > bMaxX) bMaxX = compMaxX[l];
        if (compMaxY[l] > bMaxY) bMaxY = compMaxY[l];
      }
      if (bMaxX < 0) continue;

      const keepSet = new Set(keep);
      const bbW = bMaxX - bMinX + 1;
      const bbH = bMaxY - bMinY + 1;
      const bbBuf = Buffer.alloc(bbW * bbH * 4);
      for (let y = 0; y < bbH; y++) {
        for (let x = 0; x < bbW; x++) {
          const gx = bMinX + x;
          const gy = bMinY + y;
          const li = gy * W + gx;
          const di = (y * bbW + x) * 4;
          if (mask[li] === 0 || !keepSet.has(labels[li])) {
            bbBuf[di + 3] = 0;
            continue;
          }
          const gi = li * ch;
          bbBuf[di] = data[gi];
          bbBuf[di + 1] = data[gi + 1];
          bbBuf[di + 2] = data[gi + 2];
          bbBuf[di + 3] = ch === 4 ? data[gi + 3] : 255;
        }
      }

      // Shape-aware 본체 추출 — 메인 컴포넌트의 y행별 픽셀 분포.
      const rowCounts = new Int32Array(H);
      const rowSumX = new Float64Array(H);
      for (const idx of compPixels[mainLabel]) {
        const px = idx % W;
        const py = Math.floor(idx / W);
        rowCounts[py]++;
        rowSumX[py] += px;
      }
      let rowMax = 0;
      for (let y = compMinY[mainLabel]; y <= compMaxY[mainLabel]; y++) {
        if (rowCounts[y] > rowMax) rowMax = rowCounts[y];
      }
      const bodyThreshold = Math.max(2, Math.floor(rowMax * 0.25));

      let footY = compMaxY[mainLabel];
      let bodySumX = 0;
      let bodyCount = 0;
      for (let y = compMaxY[mainLabel]; y >= compMinY[mainLabel]; y--) {
        if (rowCounts[y] >= bodyThreshold) {
          if (bodyCount === 0) footY = y;
          bodySumX += rowSumX[y];
          bodyCount += rowCounts[y];
        }
      }
      const mainCenterX = bodyCount > 0
        ? bodySumX / bodyCount
        : compPixels[mainLabel].reduce((s, idx) => s + (idx % W), 0) / compPixels[mainLabel].length;

      cells.push({
        bbBuf,
        bbW,
        bbH,
        bMinX,
        bMinY,
        footY,
        headTopY: compMinY[mainLabel],
        mainCenterX,
        cellX0,
        cellY0,
      });
      if (bbW > maxBbW) maxBbW = bbW;
      if (bbH > maxBbH) maxBbH = bbH;
    }
  }

  if (cells.length === 0) {
    log(`normalizeSpritesheetCells: no non-empty cells, skipping`);
    return;
  }

  // ── 패스 2: 시트-전역 단일 scale ────────────────────────────────────────────
  const cellSafeW = cellW - 2 * margin;
  const cellSafeH = cellH - 2 * margin;
  const scale = Math.min(1, cellSafeW / maxBbW, cellSafeH / maxBbH);
  if (scale < 0.5) {
    log(
      `normalizeSpritesheetCells: WARNING scale=${scale.toFixed(3)} < 0.5 — ` +
        `모델이 셀보다 크게 그려 강한 축소 발생(프롬프트 미준수 신호). maxBb=${maxBbW}x${maxBbH} safe=${cellSafeW}x${cellSafeH}`,
    );
  }

  // ── 패스 2.5: 정렬 기준선 robust 보정 (feet/hip/top) ───────────────────────
  // 목표선은 고정선(⑧ upfront 피벗과 일치)이지만, 검출이 중앙값에서 크게 벗어난
  // 셀은 이상치로 보고 그 셀만 중앙값으로 폴백 — upfront 피벗과 일치 유지.
  type AlignKind = "feet" | "hip" | "center" | "top";
  const alignKind: AlignKind = anchor;

  // 각 셀의 정렬 기준점(scale 반영된 layer-local offset)을 산출.
  const refOff = (cell: Cell): number => {
    // layer-local(축소 전) 기준 → scale 곱.
    if (alignKind === "feet") return (cell.footY - cell.bMinY) * scale;
    if (alignKind === "top") return (cell.headTopY - cell.bMinY) * scale;
    if (alignKind === "hip") {
      const hipLocal = (cell.footY - (cell.footY - cell.headTopY) * 0.45) - cell.bMinY;
      return hipLocal * scale;
    }
    // center 는 layer 세로 중앙
    return (cell.bbH * scale) / 2;
  };

  // cell-local 정렬선(= cellY0 기준 목표 y) 중앙값 — 이상치 거부에만 사용.
  // 목표선 자체는 고정선이라 export 피벗과 일치.
  const localLines = cells.map(cell => {
    const sH = Math.round(cell.bbH * scale);
    if (alignKind === "feet" || alignKind === "hip") {
      // 기준점이 셀 안에서 놓일 위치 = cellH - paddingBottom - 1 - (footTail)
      // 여기서는 검출 일관성 판단용으로 desiredTop+refOff 의 cell-local 값을 모은다.
      return cellH - paddingBottom - 1; // 고정 목표(feet/hip 공통 발-기준)
    }
    if (alignKind === "top") return margin;
    return Math.round((cellH - sH) / 2);
  });
  const sortedLines = [...localLines].sort((a, b) => a - b);
  const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];

  // ── 패스 3: 배치 ────────────────────────────────────────────────────────────
  type Layer = { input: Buffer; top: number; left: number };
  const layers: Layer[] = [];

  for (const cell of cells) {
    const sW = Math.max(1, Math.round(cell.bbW * scale));
    const sH = Math.max(1, Math.round(cell.bbH * scale));

    let buf = cell.bbBuf;
    if (scale < 1) {
      buf = await sharp(cell.bbBuf, { raw: { width: cell.bbW, height: cell.bbH, channels: 4 } })
        .resize(sW, sH, { kernel: "nearest", fit: "fill" })
        .raw()
        .toBuffer();
    }
    const layerPng = await sharp(buf, { raw: { width: sW, height: sH, channels: 4 } })
      .png()
      .toBuffer();

    // 가로: 본체 무게중심 x 를 셀 가로 중심에 (scale 반영)
    const scaledCenterX = (cell.mainCenterX - cell.bMinX) * scale;
    const desiredLeft = Math.round(cell.cellX0 + cellW / 2 - scaledCenterX);

    // 세로: 전략별 목표선(고정) + scale 반영 기준점.
    let desiredTop: number;
    if (alignKind === "center") {
      desiredTop = Math.round(cell.cellY0 + (cellH - sH) / 2);
    } else {
      // feet/hip → 발 기준선(cellH - paddingBottom - 1), top → margin.
      // hip 은 기준점이 hipY 라 발보다 위에 정렬 → 콘텐츠가 셀 위로 올라감.
      const targetLocal = alignKind === "top" ? margin : cellH - paddingBottom - 1;
      const off = refOff(cell);
      // 검출 이상치 거부: 본 셀 목표 local 선이 중앙값에서 cellH*0.25 이상 벗어나면
      // 중앙값으로 폴백(noise 한 footY 가 캐릭터를 들쭉날쭉하게 만드는 것 방지).
      const safeTargetLocal =
        Math.abs(targetLocal - medianLine) > cellH * 0.25 ? medianLine : targetLocal;
      desiredTop = Math.round(cell.cellY0 + safeTargetLocal - off);
    }

    const left = Math.max(cell.cellX0, Math.min(cell.cellX0 + cellW - sW, desiredLeft));
    const top = Math.max(cell.cellY0, Math.min(cell.cellY0 + cellH - sH, desiredTop));
    layers.push({ input: layerPng, top, left });
  }

  // 빈 캔버스 위에 모두 합성 (배경: 투명 또는 흰)
  const bg = wantsTransparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : { r: 255, g: 255, b: 255, alpha: 1 };
  const tmpPath = filePath + ".norm.tmp";
  await sharp({
    create: { width: W, height: H, channels: 4, background: bg },
  })
    .composite(layers)
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
  log(
    `normalizeSpritesheetCells: ${cols}x${rows} cells, anchor=${alignKind} scale=${scale.toFixed(3)} ` +
      `${layers.length} non-empty (maxBb=${maxBbW}x${maxBbH})`,
  );
}
