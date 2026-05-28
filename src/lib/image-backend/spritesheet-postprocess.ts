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
  // 셀 면적(px) — enclosed 포켓 키아웃 임계 기준. 시트는 cellW*cellH, 단일 이미지는 미지정(전체).
  cellArea?: number,
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

  // 3.5. enclosed 키 포켓 키아웃 — 테두리에서 도달 못 한 hard-key(다리 사이 등) 중
  //   "셀 대비 작은" 컴포넌트만 배경 bleed 로 보고 추가 투명화. 큰 내부 키색(녹색 옷·
  //   슬라임 본체)은 보존(CASE D/E 회귀 금지). 다리 사이 포켓은 셀의 <1% 수준인 반면
  //   옷 패치는 셀의 수% 이상이라 셀 면적 비율로 구분된다.
  {
    // 셀 면적 미지정 시 전체 이미지를 한 셀로 간주(단일 이미지 경로 보수적 처리).
    const cellPx = cellArea && cellArea > 0 ? cellArea : N;
    const pocketCap = Math.max(48, Math.round(cellPx * 0.02)); // 셀의 2% 미만 = 포켓
    const visited = new Uint8Array(N);
    const cstk: number[] = [];
    for (let s = 0; s < N; s++) {
      if (isHardKey[s] !== 1 || bgKey[s] === 1 || visited[s] === 1) continue;
      visited[s] = 1;
      const comp: number[] = [s];
      cstk.length = 0;
      cstk.push(s);
      while (cstk.length > 0) {
        const p = cstk.pop()!;
        const x = p % W;
        const tryp = (q: number) => {
          if (q >= 0 && q < N && isHardKey[q] === 1 && bgKey[q] === 0 && visited[q] === 0) {
            visited[q] = 1;
            comp.push(q);
            cstk.push(q);
          }
        };
        if (x > 0) tryp(p - 1);
        if (x < W - 1) tryp(p + 1);
        if (p >= W) tryp(p - W);
        if (p < N - W) tryp(p + W);
      }
      if (comp.length < pocketCap) {
        for (const p of comp) bgKey[p] = 1; // 작은 포켓 → 배경으로 흡수
      }
    }
  }

  // 3.6. bgKey 까지의 거리장(BFS, 반경 DESPILL_RADIUS 까지만). despill 존을 배경 경계
  //   1px → N px feather 로 확대해 다크 엣지 2~3px 안쪽 녹색 halo 까지 잡되, 내부 깊은
  //   키색(옷·본체)은 거리 > 반경이라 영향 없음(CASE D 보존).
  const DESPILL_RADIUS = 3;
  const bgDist = new Uint8Array(N).fill(255);
  {
    const bfs: number[] = [];
    for (let p = 0; p < N; p++) {
      if (bgKey[p] === 1) {
        bgDist[p] = 0;
        bfs.push(p);
      }
    }
    let head = 0;
    while (head < bfs.length) {
      const p = bfs[head++];
      const d = bgDist[p];
      if (d >= DESPILL_RADIUS) continue;
      const x = p % W;
      const relax = (q: number) => {
        if (q >= 0 && q < N && bgDist[q] > d + 1) {
          bgDist[q] = d + 1;
          bfs.push(q);
        }
      };
      if (x > 0) relax(p - 1);
      if (x < W - 1) relax(p + 1);
      if (p >= W) relax(p - W);
      if (p < N - W) relax(p + W);
    }
  }

  // 4. 적용: 배경-connected hard-key → 투명. 배경 경계 DESPILL_RADIUS 이내 fringe → despill + 알파 감쇠.
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
    // fringe 는 배경(bgKey)에서 반경 이내일 때만 처리 — 내부 깊은 키색 보존.
    if (bgDist[p] > DESPILL_RADIUS) continue;
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

/**
 * 참조 이미지의 본체(콘텐츠 픽셀)가 녹색 우세인지 판정 (결정적·side-effect 없음).
 * WHY: 캐릭터 자체가 녹색(녹색 슬라임 등)이면 기본 green chroma-key 가 본체를 같이
 *   키아웃하므로, 호출측이 magenta 키로 폴백하도록 신호를 준다. 참조 캐릭터가 녹색일 때만
 *   true 가 되도록 보수적으로(콘텐츠의 35% 이상이 녹색) 판정 — 녹색 악센트 정도론 false.
 *
 * 판정식: 콘텐츠 픽셀(알파>10, 알파 없으면 흰 배경 아닌 픽셀)별 greenness = g - max(r,b).
 *   greenness > 40 && g > 90 인 픽셀을 "녹색 픽셀" 로 카운트, 콘텐츠 대비 비율 ≥ 0.35 → true.
 *   분석은 폭 256 으로 다운샘플(정확도 충분, 비용↓).
 */
export async function isGreenDominant(filePath: string, log: Logger = noop): Promise<boolean> {
  const { data, info } = await sharp(filePath)
    .resize(256, undefined, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const N = info.width * info.height;
  const hasAlpha = ch === 4;

  let content = 0;
  let green = 0;
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // 콘텐츠 픽셀: 알파>10, 알파 없으면 흰 배경 제외.
    const isContent = hasAlpha ? data[i + 3] > 10 : !(r > 240 && g > 240 && b > 240);
    if (!isContent) continue;
    content++;
    if (g - Math.max(r, b) > 40 && g > 90) green++;
  }
  if (content === 0) return false; // 빈/투명 이미지
  const ratio = green / content;
  log(`isGreenDominant: green=${green}/${content} ratio=${ratio.toFixed(3)}`);
  return ratio >= 0.35;
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

  // ── 정렬 기준점 산출 ──────────────────────────────────────────────────────
  // 각 셀의 본체 기준점(footY/hipY/headTopY)을 전략별 셀-로컬 고정 목표선에 맞춰
  // 배치한다. 목표선이 고정값이라 모든 셀이 동일 라인에 정렬되고 ⑧ upfront 피벗과 일치.
  type AlignKind = "feet" | "hip" | "center" | "top";
  const alignKind: AlignKind = anchor;

  // 각 셀의 정렬 기준점(scale 반영된 layer-local offset).
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
      desiredTop = Math.round(cell.cellY0 + targetLocal - refOff(cell));
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
