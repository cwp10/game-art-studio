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
export type SubjectType = "character" | "effect" | "object";
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
): Promise<number> {
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
    // magenta 키는 배경이 순수 #ff00ff(keyness≈255)이므로 임계값을 높게 유지해야
    // 자주색/보라색 캐릭터 픽셀(keyness 80-130)을 실수로 키아웃하지 않는다.
    // green 키는 기존 [30,50] 유지.
    const [thMin, thMax] = keyColor === "magenta" ? [120, 200] : [30, 50];
    hardThresh = Math.max(thMin, Math.min(thMax, Math.round(median * 0.5)));
  }
  const fringeFloor = 2;
  const fringeSpan = Math.max(8, Math.round((hardThresh - fringeFloor) * 0.6));

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
  const DESPILL_RADIUS = 8; // 5→8: 실루엣 경계 6px+ 떨어진 fringe 녹색 잔재까지 흡수
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
    // magenta despill: G 채널이 높으면 진짜 자주색/보라색 캐릭터 픽셀이므로 스킵.
    // 마젠타 스필은 G≈0-20, 자주색 캐릭터는 G≈30-80 으로 구분 가능.
    if (keyColor === "green") {
      data[i + 1] = Math.max(data[i], data[i + 2]);
      if (data[i + 1] > 0) data[i + 1] = Math.max(0, data[i + 1] - 2);
    } else {
      if (data[i + 1] > 40) continue; // G 높음 → 자주색 캐릭터, despill 스킵
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
  return keyedOut;
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

/** detectFill 반환 — 모델이 실제로 그린 그리드 충족도 측정 결과. */
export type FillStats = {
  rowBands: number; // 모델이 그린 가로(행) 밴드 수
  minColBandsPerRow: number; // 행들 중 최소 열 밴드 수 (0 = 빈 행 존재)
  filledCells: number; // 유의미 컴포넌트가 채운 (행밴드×열밴드) 셀의 총 개수
  expected: number; // rows*cols (기대치)
  complete: boolean; // 모든 행이 cols 개 밴드를 가질 때 true
};

/**
 * 빈 셀 감지 — chroma-key 후(투명 배경) 시트에서 모델이 실제로 그린 행/열 밴드를 측정한다.
 *
 * WHY: rowCountRule/colCountRule + 적응형 후처리가 있어도 모델이 가끔 그리드를 덜 채운다
 *   (예: 8×12 요청에 7행×11열만). 적응형 후처리는 "내부 구멍"만 메우지 normalize 전에
 *   모델이 덜 그린 개수 자체는 못 채운다. 이 함수로 충족 여부를 측정해 재시도를 트리거한다.
 *
 * 측정(고정 그리드 다수결이 아니라 콘텐츠 밴드 기준 — 모델 표류 때문):
 *   1. 비배경(alpha>10) 픽셀을 4-connectivity 로 라벨링, 셀 면적의 1% 이상인 유의미
 *      컴포넌트만 채택(키잉 잔재·노이즈 스펙 배제 — normalizeSpritesheetCells 4a 와 동일 임계).
 *   2. 컴포넌트 y-중심을 정렬해 간격>cellH*0.5 이면 새 행 밴드(적응형 4b 와 동일 갭).
 *   3. 각 행 밴드 안에서 x-중심을 정렬해 간격>cellW*0.5 이면 새 열 밴드(적응형 4c 와 동일 갭).
 *
 * 반환: { rowBands, minColBandsPerRow, filledCells, expected, complete }.
 *   complete = rowBands===rows && 모든 행이 cols 개 밴드를 가질 때.
 *
 * NOTE: alpha 채널이 없는(흰 배경) 시트는 흰색 아닌 픽셀을 콘텐츠로 본다.
 */
export async function detectFill(
  filePath: string,
  rows: number,
  cols: number,
  log: Logger = noop,
): Promise<FillStats> {
  const expected = rows * cols;
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

  // chroma-key 후엔 알파>10 이 콘텐츠. 흰 배경 시트(알파 없음→ensureAlpha 로 255)는 흰색 제외.
  const isContent = (i: number) =>
    data[i + 3] > 10 && !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);

  // 1. 비배경 마스크 → 4-connectivity 컴포넌트 라벨링(normalize 패스2 와 동일 구조).
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (isContent(i * ch)) mask[i] = 1;
  }
  const labels = new Int32Array(N);
  const sizes: number[] = [0];
  const sumX: number[] = [0];
  const sumY: number[] = [0];
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    labels[start] = next;
    let size = 0, sx = 0, sy = 0;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      size++;
      sx += x;
      sy += y;
      if (x > 0 && mask[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = next; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && mask[p - W] === 1 && labels[p - W] === 0) { labels[p - W] = next; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] === 1 && labels[p + W] === 0) { labels[p + W] = next; stack.push(p + W); }
    }
    sizes.push(size);
    sumX.push(sx);
    sumY.push(sy);
    next++;
  }

  // 유의미 컴포넌트(셀 면적의 1% 이상)만 — normalizeSpritesheetCells 4a 의 substantialPx 와 동일.
  const substantialPx = cellW * cellH * 0.01;
  const comps: { cx: number; cy: number }[] = [];
  for (let l = 1; l < sizes.length; l++) {
    if (sizes[l] < substantialPx) continue;
    comps.push({ cx: sumX[l] / sizes[l], cy: sumY[l] / sizes[l] });
  }
  if (comps.length === 0) {
    log(`detectFill: empty sheet — 0/${expected} cells`);
    return { rowBands: 0, minColBandsPerRow: 0, filledCells: 0, expected, complete: false };
  }

  // 2. 행 밴드: y-중심 정렬 → 갭>cellH*0.5 분할(적응형 4b 와 동일 갭).
  const rowGap = cellH * 0.5;
  const colGap = cellW * 0.5;
  const byCy = [...comps].sort((a, b) => a.cy - b.cy);
  const bands: { cx: number; cy: number }[][] = [[byCy[0]]];
  for (let i = 1; i < byCy.length; i++) {
    if (byCy[i].cy - byCy[i - 1].cy > rowGap) bands.push([]);
    bands[bands.length - 1].push(byCy[i]);
  }

  // 3. 각 행 밴드 안 열 밴드: x-중심 정렬 → 갭>cellW*0.5 분할(적응형 4c 와 동일 갭).
  let minColBandsPerRow = Infinity;
  let filledCells = 0;
  const perRow: number[] = [];
  for (const band of bands) {
    const byCx = [...band].sort((a, b) => a.cx - b.cx);
    let colBands = 1;
    for (let i = 1; i < byCx.length; i++) {
      if (byCx[i].cx - byCx[i - 1].cx > colGap) colBands++;
    }
    // 한 행이 cols 보다 많이 분할되는 경우(과분할)는 cols 로 클램프 — 충족도 측정엔 상한 cols.
    const counted = Math.min(cols, colBands);
    perRow.push(colBands);
    filledCells += counted;
    if (counted < minColBandsPerRow) minColBandsPerRow = counted;
  }
  if (!Number.isFinite(minColBandsPerRow)) minColBandsPerRow = 0;

  const rowBands = bands.length;
  const complete = rowBands >= rows && perRow.every((cb) => cb >= cols);
  log(
    `detectFill: rowBands=${rowBands}/${rows} colBandsPerRow=[${perRow.join(",")}] ` +
      `filledCells=${filledCells}/${expected} complete=${complete}`,
  );
  return { rowBands, minColBandsPerRow, filledCells, expected, complete };
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

  // 4. 각 컴포넌트 → 셀 할당. 기본은 다수결 고정 그리드 셀.
  //   단, 모델이 캐릭터를 고정 그리드선에 안 맞추고 세로/가로로 표류시켜 그리면 어떤 그리드
  //   행/열이 0개가 되어 통째로 빈다(빈 행/빈 열 버그). 그 표류가 감지될 때만(내부 빈 행/열)
  //   row(4a/4b)·col(4c) 을 콘텐츠 밴드 기준으로 재배정한다. well-behaved 시트는 다수결 유지.
  type Comp = { l: number; row: number; col: number; cy: number; cx: number };
  const comps: Comp[] = [];
  for (let l = 1; l < sizes.length; l++) {
    let maxCount = 0;
    let majCell = 0;
    for (const [ci, count] of compCellCount[l]) {
      if (count > maxCount) {
        maxCount = count;
        majCell = ci;
      }
    }
    comps.push({
      l,
      row: Math.floor(majCell / cols),
      col: majCell % cols,
      cy: (compMinY[l] + compMaxY[l]) / 2,
      cx: (compMinX[l] + compMaxX[l]) / 2,
    });
  }

  // 4a. 빈 "내부" 그리드 행 탐지 — 콘텐츠가 있는 행들 사이에 끼어 비어버린 행(=표류로 인한
  //   빈 행 버그의 서명). 검출·재배정은 "유의미한" 컴포넌트(셀 면적의 1% 이상)만 기준으로
  //   한다. 작은 노이즈 스펙(키잉 잔재 수십 px)이 어떤 행에 떨어져 빈 행을 가리거나 밴드
  //   경계를 흔들지 않도록(노이즈는 패스1 keep 필터에서 어차피 탈락).
  const substantialPx = (cellW * cellH) * 0.01;
  const substantial = comps.filter((c) => sizes[c.l] >= substantialPx);
  const rowHasContent = new Array(rows).fill(false);
  for (const c of substantial) rowHasContent[c.row] = true;
  let firstFilled = -1, lastFilled = -1;
  for (let r = 0; r < rows; r++) {
    if (rowHasContent[r]) {
      if (firstFilled < 0) firstFilled = r;
      lastFilled = r;
    }
  }
  let hasInteriorEmptyRow = false;
  for (let r = firstFilled; r >= 0 && r <= lastFilled; r++) {
    if (!rowHasContent[r]) hasInteriorEmptyRow = true;
  }

  // 4b. 재배정(필요 시만): 유의미 컴포넌트 y-중심을 정렬해 인접 간격이 bandGap(셀 높이의
  //   절반)보다 크면 새 밴드로 분리(그리디 갭 분할). 표류해도 밴드는 콘텐츠를 따라가므로
  //   빈 밴드가 안 생김. 밴드 순서를 그대로 row 0..n-1 에 채우고, 밴드 수가 rows 보다 적으면
  //   남는 행은 빈 채로 둔다(억지로 채우지 않음). 밴드 수가 rows 초과(과분할)면 마지막 행으로
  //   클램프. 노이즈 스펙은 y-중심 기준 가장 가까운 밴드의 row 를 따라간다.
  if (hasInteriorEmptyRow && substantial.length > 0) {
    const sortedByCy = [...substantial].sort((a, b) => a.cy - b.cy);
    const bandGap = cellH * 0.5;
    const bandRowByCy: { cy: number; row: number }[] = [];
    let band = 0;
    sortedByCy[0].row = 0;
    bandRowByCy.push({ cy: sortedByCy[0].cy, row: 0 });
    for (let i = 1; i < sortedByCy.length; i++) {
      if (sortedByCy[i].cy - sortedByCy[i - 1].cy > bandGap) band++;
      const row = Math.min(rows - 1, band);
      sortedByCy[i].row = row;
      bandRowByCy.push({ cy: sortedByCy[i].cy, row });
    }
    // 노이즈(비-유의미) 컴포넌트는 가장 가까운 유의미 컴포넌트의 row 로.
    for (const c of comps) {
      if (sizes[c.l] >= substantialPx) continue;
      let best = bandRowByCy[0].row, bestD = Infinity;
      for (const b of bandRowByCy) {
        const d = Math.abs(b.cy - c.cy);
        if (d < bestD) { bestD = d; best = b.row; }
      }
      c.row = best;
    }
    log(
      `normalizeSpritesheetCells: interior empty row detected → row-band re-cluster ` +
        `(${band + 1} bands, rows=${rows}, bandGap=${Math.round(bandGap)})`,
    );
  }

  // 4c. col 재배정 — 4a/4b 의 row 대칭판. 모델이 캐릭터를 가로로도 표류시켜(좌우로 벌려)
  //   그리면 어떤 그리드 열이 0개가 되어 통째로 빈다(중앙 빈 열 버그). row 와 동일하게
  //   "유의미 컴포넌트 사이에 낀 빈 그리드 열" 이 있을 때만 발동하고, well-behaved 시트·
  //   effect(center 앵커)는 기존 col 다수결을 유지한다.
  //
  //   행그룹 내 독립 정렬을 택한 이유: 캐릭터 그리드는 행마다 x-정렬이 미세하게 다르다
  //   (망토 펼침·자세 차이). 전역 x-중심으로 묶으면 행별 갭 위치 차이가 서로 메워져
  //   빈 열을 가린다(실측: 시트-전역 프로파일은 12밴드처럼 보이나 행별로는 11밴드 + 중앙 갭).
  //   행그룹 내 갭 분할이 각 행의 실제 콘텐츠 열을 충실히 따라가 더 견고하다.
  if (cols > 1) {
    // 4b 가 row 를 바꿨을 수 있으니, 현재 row 값으로 행 그룹을 묶는다.
    const rowGroups = new Map<number, Comp[]>();
    for (const c of substantial) {
      if (!rowGroups.has(c.row)) rowGroups.set(c.row, []);
      rowGroups.get(c.row)!.push(c);
    }
    // col 갭 임계: 셀 폭의 절반(row 가 cellH*0.5 인 것과 대칭). 인접 캐릭터 x-중심 간격은
    //   ~cellW 라 항상 초과 → 캐릭터마다 개별 밴드. 좁은 다중 컴포넌트(머리/몸통 분리 등)는
    //   이미 패스1 에서 한 셀로 묶이고, 여기 substantial 은 보통 셀당 1개라 과분할 위험 낮음.
    const colGap = cellW * 0.5;
    let firedAnyCol = false;
    let totalColBands = 0;
    for (const [, group] of rowGroups) {
      if (group.length < 2) continue;
      const sortedByCx = [...group].sort((a, b) => a.cx - b.cx);
      // 이 행의 콘텐츠 grid-col 점유 → 콘텐츠 열 사이에 낀 빈 grid-col 이 있을 때만 발동.
      const colHasContent = new Array(cols).fill(false);
      for (const c of group) colHasContent[c.col] = true;
      let firstC = -1, lastC = -1;
      for (let cc = 0; cc < cols; cc++) {
        if (colHasContent[cc]) { if (firstC < 0) firstC = cc; lastC = cc; }
      }
      let interiorEmptyCol = false;
      for (let cc = firstC; cc >= 0 && cc <= lastC; cc++) {
        if (!colHasContent[cc]) interiorEmptyCol = true;
      }
      if (!interiorEmptyCol) continue; // 이 행은 well-behaved → 기존 col 유지

      // 갭 분할로 col 밴드 → col 0..n-1 재배정(밴드 수<cols 면 끝 열을 빈 채로, >cols 면 클램프).
      let cband = 0;
      const bandColByCx: { cx: number; col: number }[] = [];
      sortedByCx[0].col = 0;
      bandColByCx.push({ cx: sortedByCx[0].cx, col: 0 });
      for (let i = 1; i < sortedByCx.length; i++) {
        if (sortedByCx[i].cx - sortedByCx[i - 1].cx > colGap) cband++;
        const col = Math.min(cols - 1, cband);
        sortedByCx[i].col = col;
        bandColByCx.push({ cx: sortedByCx[i].cx, col });
      }
      // 이 행의 노이즈(비-유의미) 컴포넌트는 x-중심 기준 가장 가까운 밴드의 col 로.
      for (const c of comps) {
        if (c.row !== group[0].row) continue;
        if (sizes[c.l] >= substantialPx) continue;
        let best = bandColByCx[0].col, bestD = Infinity;
        for (const b of bandColByCx) {
          const d = Math.abs(b.cx - c.cx);
          if (d < bestD) { bestD = d; best = b.col; }
        }
        c.col = best;
      }
      firedAnyCol = true;
      totalColBands += cband + 1;
    }
    if (firedAnyCol) {
      log(
        `normalizeSpritesheetCells: interior empty col detected → per-row col-band re-cluster ` +
          `(cols=${cols}, colGap=${Math.round(colGap)}, ~${totalColBands} bands total)`,
      );
    }
  }

  const labelsPerCell = new Map<number, number[]>();
  for (const comp of comps) {
    const cellIdx = comp.row * cols + comp.col;
    if (!labelsPerCell.has(cellIdx)) labelsPerCell.set(cellIdx, []);
    labelsPerCell.get(cellIdx)!.push(comp.l);
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

  // 잔재 필터 (캐릭터 시트 전용): 다른 셀 캐릭터에서 셀 경계를 넘어 흘러내린
  // 발·다리 파편은 bbH 가 최대 높이의 50% 미만. 이런 셀은 빈 셀로 처리한다.
  if (subjectType === "character" && cells.length >= 2) {
    const heightThreshold = maxBbH * 0.5;
    const filtered = cells.filter(c => c.bbH >= heightThreshold);
    const discarded = cells.length - filtered.length;
    if (discarded > 0) {
      cells.splice(0, cells.length, ...filtered);
      log(`normalizeSpritesheetCells: discarded ${discarded} remnant cells (bbH < 50% of maxBbH=${maxBbH})`);
    }
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

/**
 * corner flood-fill 배경 제거 폴백 (in-place).
 * chromaKeyFile keyedOut=0 이후 호출. 이미지 4개 코너 픽셀을 샘플링해 단색 배경인지 판정,
 * 맞으면 테두리에서 4-connectivity flood-fill 로 배경을 투명화한다.
 *
 * 동작 조건:
 *   - 4개 코너(각 3x3 평균)가 서로 CORNER_UNIFORM_TOL 이내 → 단색 배경으로 판정
 *   - 판정 실패 시 0 반환(이미지 미변경)
 *
 * WHY: 모델이 green/magenta 대신 어두운(검정) 배경을 생성할 때 chroma-key가 동작하지 않음.
 *   corner 기반으로 배경색을 자동 감지해 단색이면 제거.
 */
export async function fallbackBgRemove(
  filePath: string,
  log: Logger = noop,
): Promise<number> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const W = info.width;
  const H = info.height;
  const N = W * H;

  // 코너 3x3 평균 색상 샘플링
  const SAMPLE_R = 2; // 5x5 영역
  const sampleCorner = (cx: number, cy: number): [number, number, number] => {
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let dy = -SAMPLE_R; dy <= SAMPLE_R; dy++) {
      for (let dx = -SAMPLE_R; dx <= SAMPLE_R; dx++) {
        const x = Math.min(Math.max(cx + dx, 0), W - 1);
        const y = Math.min(Math.max(cy + dy, 0), H - 1);
        const i = (y * W + x) * ch;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        cnt++;
      }
    }
    return [Math.round(r / cnt), Math.round(g / cnt), Math.round(b / cnt)];
  };

  const corners: [number, number, number][] = [
    sampleCorner(0, 0),
    sampleCorner(W - 1, 0),
    sampleCorner(0, H - 1),
    sampleCorner(W - 1, H - 1),
  ];

  // 코너 균일도 체크: 평균 대비 최대 채널 합 편차
  const avgR = corners.reduce((s, c) => s + c[0], 0) / 4;
  const avgG = corners.reduce((s, c) => s + c[1], 0) / 4;
  const avgB = corners.reduce((s, c) => s + c[2], 0) / 4;
  const CORNER_UNIFORM_TOL = 40;
  const maxCornerDiff = Math.max(
    ...corners.map(
      (c) => Math.abs(c[0] - avgR) + Math.abs(c[1] - avgG) + Math.abs(c[2] - avgB),
    ),
  );
  if (maxCornerDiff > CORNER_UNIFORM_TOL) {
    log(`fallbackBgRemove: corners not uniform (maxDiff=${maxCornerDiff}), skip`);
    return 0;
  }

  const bgR = Math.round(avgR);
  const bgG = Math.round(avgG);
  const bgB = Math.round(avgB);

  // 색상 허용 오차 — 배경이 어두울수록 타이트하게(캐릭터 보호)
  const brightness = (bgR + bgG + bgB) / 3;
  // 매우 어둡거나 밝으면 20, 중간이면 28
  const FILL_TOL = brightness < 40 || brightness > 220 ? 20 : 28;

  const inTol = (p: number): boolean => {
    const i = p * ch;
    if (data[i + 3] === 0) return false; // 이미 투명
    return (
      Math.abs(data[i] - bgR) <= FILL_TOL &&
      Math.abs(data[i + 1] - bgG) <= FILL_TOL &&
      Math.abs(data[i + 2] - bgB) <= FILL_TOL
    );
  };

  // 테두리에서 flood-fill (4-conn BFS)
  const visited = new Uint8Array(N);
  const queue: number[] = [];
  const enqueue = (p: number) => {
    if (p >= 0 && p < N && visited[p] === 0 && inTol(p)) {
      visited[p] = 1;
      queue.push(p);
    }
  };
  for (let x = 0; x < W; x++) { enqueue(x); enqueue((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { enqueue(y * W); enqueue(y * W + (W - 1)); }

  let removed = 0;
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++];
    data[p * ch + 3] = 0;
    removed++;
    const x = p % W;
    if (x > 0) enqueue(p - 1);
    if (x < W - 1) enqueue(p + 1);
    if (p >= W) enqueue(p - W);
    if (p < N - W) enqueue(p + W);
  }

  if (removed === 0) {
    log(`fallbackBgRemove: no pixels matched bg(${bgR},${bgG},${bgB}) tol=${FILL_TOL}`);
    return 0;
  }

  const tmpPath = filePath + ".fallback.tmp";
  await sharp(data, {
    raw: { width: W, height: H, channels: ch as 1 | 2 | 3 | 4 },
  })
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
  log(
    `fallbackBgRemove: bg=(${bgR},${bgG},${bgB}) tol=${FILL_TOL} removed=${removed}/${N}`,
  );
  return removed;
}
