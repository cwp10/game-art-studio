// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen 픽셀 언페이크 파이프라인 ①단계 이식 — 참 픽셀 격자 검출.
// 원본: sprite-gen/sprite_gen/extract.py:904-1150 (Apache-2.0)

/**
 * 생성물에서 **진짜 픽셀 블록의 크기와 위상**을 잰다.
 *
 * AI 가 그린 "픽셀아트" 는 논리 픽셀 하나가 여러 화면 픽셀을 차지하는 확대본이다.
 * 그 블록 크기(pitch)와 격자 시작 위치(phase)를 알아야 격자 단위로 다시 접어
 * (다운스케일) 진짜 해상도를 복원할 수 있다.
 *
 * ## 왜 런 길이 최빈값이 아니라 엣지-격자선 정렬 점수인가
 *
 * 같은 색 런 길이의 최빈값을 쓰던 구현은 AA 가장자리와 블록 내부 질감이 만드는 2px
 * 런에 지배당해 큰 블록(~16px)을 놓치고 늘 2 를 내놨다. 그 결과 격자 비정렬 축소로
 * 이웃 픽셀이 섞여 뭉개졌다.
 *
 * 지금 방식은 후보 피치 p 와 위상마다 "색 경계가 격자선 ±w 안에 모이는 비율" 에서
 * **우연 기대치**(그 창이 덮는 잉여류 수)/p 를 뺀 점수의 argmax 다. 우연 보정이
 * 없으면 작은 p 가 공짜로 이긴다.
 *
 * ## 피치는 소수이고 축마다 다르다
 *
 * AI 가 그린 블록은 정수로 안 떨어진다(실측 17.24). 정수로 반올림하면 그 오차가 폭
 * 전체에 누적돼 셀 경계가 블록 한가운데를 지난다. 그리고 생성물이 비균등 비율로
 * 리스케일되면 가로/세로 블록 크기가 어긋난다(실측 30.38 / 30.92) — 한 피치를 두
 * 축에 강제하면 한 축이 통째로 미끄러진다(가로 정렬률 11.7% vs 축별 75.7%).
 *
 * 확신이 없으면 `((1,1),(0,0))` 을 내 **스냅하지 않는다** — 조용히 근사하지 않는다.
 */

export type RawImage = { data: Uint8Array; width: number; height: number };
export type Pitch = [number, number];
export type Phase = [number, number];

/**
 * 색 전이 엣지 수 — x 인덱스(세로 엣지)와 y 인덱스(가로 엣지).
 *
 * AA 램프는 참 블록 경계 **근처**에 찍히므로 경계 위치 신호는 안티에일리어싱을
 * 견딘다. 두 축 모두 반대 축을 2칸씩 건너뛰며 훑는다 (원본 그대로 — 임계 96 이
 * 그 샘플링 위에서 정해졌다).
 */
export function edgeHistograms(img: RawImage): {
  colEdges: number[];
  rowEdges: number[];
  width: number;
  height: number;
} {
  const { data, width, height } = img;
  const colEdges = new Array<number>(width).fill(0);
  const rowEdges = new Array<number>(height).fill(0);
  const at = (x: number, y: number): number => (y * width + x) * 4;
  for (let y = 0; y < height; y += 2) {
    for (let x = 1; x < width; x++) {
      const a = at(x, y);
      const b = at(x - 1, y);
      const d =
        Math.abs(data[a] - data[b]) +
        Math.abs(data[a + 1] - data[b + 1]) +
        Math.abs(data[a + 2] - data[b + 2]) +
        Math.abs(data[a + 3] - data[b + 3]);
      if (d > 96) colEdges[x]++;
    }
  }
  for (let x = 0; x < width; x += 2) {
    for (let y = 1; y < height; y++) {
      const a = at(x, y);
      const b = at(x, y - 1);
      const d =
        Math.abs(data[a] - data[b]) +
        Math.abs(data[a + 1] - data[b + 1]) +
        Math.abs(data[a + 2] - data[b + 2]) +
        Math.abs(data[a + 3] - data[b + 3]);
      if (d > 96) rowEdges[y]++;
    }
  }
  return { colEdges, rowEdges, width, height };
}

/**
 * 정수 피치 p 의 축별 점수 = (격자선 ±w 에 모인 엣지 비율) − 우연 기대치.
 *
 * 창 폭 w 는 **모든 p 에 동일하다.** 예전에는 `p >= 8` 에서만 창이 열려 참 피치의
 * 우연 기대치가 3/p 로 부풀었고, 창 없는 약수(p<8)에게 졌다 — k=8,10,12,14 에서
 * 정확히 k/2 를 반환하던 원인이다. 창이 p 를 넘어 잉여류를 중복 합산하지 않도록
 * 잉여류는 **집합으로** 센다.
 */
export function axisIntScore(edges: number[], p: number, w = 1): number {
  let total = 0;
  for (const e of edges) total += e;
  if (total === 0) total = 1;
  let best = 0.0;
  for (let phase = 0; phase < p; phase++) {
    const residues = new Set<number>();
    for (let offset = -w; offset <= w; offset++) {
      residues.add(((phase + offset) % p + p) % p);
    }
    let hit = 0;
    for (const r of residues) {
      for (let i = r; i < edges.length; i += p) hit += edges[i];
    }
    const score = hit / total - residues.size / p;
    if (score > best) best = score;
  }
  return best;
}

/** 한 축만 보고 고른 정수 피치 씨앗. 확신 없으면 1. */
export function axisIntSeed(edges: number[], maxPitch = 48): number {
  let bestPitch = 1;
  let bestScore = 0.1;
  for (let p = 2; p <= maxPitch; p++) {
    const score = axisIntScore(edges, p);
    if (score > bestScore) {
      bestPitch = p;
      bestScore = score;
    }
  }
  return bestPitch;
}

/**
 * 소수 피치 p 에서 최적 위상과 그 점수. 잉여류를 히스토그램으로 접어 O(nnz + p/step).
 *
 * 정수 격자만 볼 수 있던 예전에는 참 피치 17.24 를 17 로 반올림했고, 그 0.24 가
 * 스프라이트 폭을 가로지르며 누적돼(23칸이면 5.5px) 셀 경계가 블록 한가운데를 지났다.
 *
 * 위상은 창의 기하학적 중심이 아니라 **창 안 엣지의 가중 무게중심**이다. 중심을 쓰면
 * 엣지가 한 bin 에 몰린 완전 정렬 격자에서도 위상이 반창(=w) 만큼 밀렸다.
 */
export function axisRefine(
  edges: number[],
  pitch: number,
  w = 1.0,
  binStep = 0.25,
): { score: number; phase: number } {
  let total = 0;
  for (const e of edges) total += e;
  if (total === 0) total = 1;
  const bins = Math.max(4, pyRound(pitch / binStep));
  const hist = new Array<number>(bins).fill(0);
  for (let x = 0; x < edges.length; x++) {
    const count = edges[x];
    if (!count) continue;
    hist[(Math.trunc(((x % pitch) / pitch) * bins) % bins + bins) % bins] += count;
  }
  const span = Math.min(bins, Math.max(1, pyRound(((2 * w) / pitch) * bins) + 1));
  const chance = Math.min(1.0, span / bins);
  const doubled = hist.concat(hist);
  let window = 0;
  for (let i = 0; i < span; i++) window += doubled[i];
  let bestScore = window / total - chance;
  let bestBin = 0;
  for (let start = 1; start < bins; start++) {
    window += doubled[start + span - 1] - doubled[start - 1];
    const score = window / total - chance;
    if (score > bestScore) {
      bestScore = score;
      bestBin = start;
    }
  }
  let weight = 0;
  for (let k = 0; k < span; k++) weight += doubled[bestBin + k];
  let centre: number;
  if (weight) {
    let acc = 0;
    for (let k = 0; k < span; k++) acc += (bestBin + k) * doubled[bestBin + k];
    centre = acc / weight;
  } else {
    centre = bestBin + (span - 1) / 2.0;
  }
  return { score: bestScore, phase: ((centre % bins) / bins) * pitch };
}

/**
 * 두 축 합산 정수 피치 — 격자 확신이 없으면 1(스냅 안 함)로 관측 가능하게 떨어진다.
 *
 * 단순 argmax 로 충분하다: 참 피치의 약수(p=7 vs 14)는 우연 기대치 |잉여류|/p 가 커서
 * 자동으로 밀린다. 최고점이 문턱(0.2) 미만이면 격자 확신 없음이다.
 */
export function detectPixelPitch(img: RawImage, maxPitch = 48): number {
  const { colEdges, rowEdges } = edgeHistograms(img);
  let bestPitch = 1;
  let bestScore = 0.2;
  for (let p = 2; p <= maxPitch; p++) {
    const score = axisIntScore(colEdges, p) + axisIntScore(rowEdges, p);
    if (score > bestScore) {
      bestPitch = p;
      bestScore = score;
    }
  }
  return bestPitch;
}

/** 참 픽셀 격자 = ((가로 피치, 세로 피치), (가로 위상, 세로 위상)). 전부 소수. */
export function detectPixelGrid(
  img: RawImage,
  maxPitch = 48,
): { pitch: Pitch; phase: Phase } {
  const combined = detectPixelPitch(img, maxPitch);
  if (combined <= 1) return { pitch: [1.0, 1.0], phase: [0.0, 0.0] };
  const { colEdges, rowEdges } = edgeHistograms(img);

  const halfSpan = 0.75;
  const step = 0.02;
  const span = pyRound(halfSpan / step);

  const refine = (edges: number[]): [number, number] => {
    // 씨앗 후보 = 축별 씨앗 + 두 축 합산 씨앗.
    // - 축별만 쓰면: 한 축의 정수 검출이 노이즈에 흔들려 약수(참 17.24 → 씨앗 9)로 빠진다.
    // - 합산만 쓰면: 가로 24 / 세로 30 처럼 축마다 블록이 다른 그림에서 한 축의 참값이
    //   ±0.75 정밀화 창 밖에 놓인다.
    const axisSeed = axisIntSeed(edges, maxPitch);
    const candidates = new Set<number>();
    for (const s of [axisSeed, combined]) if (s >= 2) candidates.add(s);
    if (candidates.size === 0) return [1.0, 0.0];
    // 정수 씨앗은 참 피치의 정수배를 집을 수 있다(참 16.5 → 씨앗 33). 그래서 씨앗의
    // 약수들도 후보로 함께 정밀화하고 점수로 고른다.
    const seedSet = new Set(candidates);
    for (const s of candidates) {
      for (const d of [2, 3]) {
        if (s / d >= 2.0) seedSet.add(s / d);
      }
    }
    const seeds = [...seedSet].sort((a, b) => a - b);
    let bestScore = -1.0;
    let bestPitch = Math.max(...candidates);
    let bestPhase = 0.0;
    for (const centre of seeds) {
      // centre 자체가 반드시 샘플에 들어가도록 대칭으로 훑는다 (예전엔 15.99/16.01 만
      // 봐서 정확히 정수인 격자에서도 소수로 빗나갔다).
      for (let i = -span; i <= span; i++) {
        const pitch = centre + i * step;
        if (pitch < 2.0 || pitch > maxPitch) continue;
        const { score, phase } = axisRefine(edges, pitch);
        if (score > bestScore + 1e-9) {
          bestScore = score;
          bestPitch = pitch;
          bestPhase = phase;
        }
      }
    }
    return [bestPitch, bestPhase];
  };

  const [colPitch, phaseX] = refine(colEdges);
  const [rowPitch, phaseY] = refine(rowEdges);
  let pitchX = colPitch;
  let pitchY = rowPitch;

  // 축별 피치는 서로 크게 다를 수 없다 — 비균등 리스케일이어도 실측 차이는 2% 수준이다.
  // 한 축이 다른 축의 1.5배를 넘게 벗어나면 그 축의 검출이 무너진 것이다(엣지가 적은
  // 축에서 참 피치의 약수가 이겨 3.00 이 나왔다, 참값 9). 엣지 총량이 많은 축을 신뢰해
  // 양쪽에 쓴다 — 조용히 고치지 않고 축 하나를 버렸음이 값에 드러난다.
  const lo = Math.min(pitchX, pitchY);
  const hi = Math.max(pitchX, pitchY);
  if (lo >= 2.0 && hi / lo > 1.5) {
    let colSum = 0;
    for (const e of colEdges) colSum += e;
    let rowSum = 0;
    for (const e of rowEdges) rowSum += e;
    if (colSum >= rowSum) pitchY = pitchX;
    else pitchX = pitchY;
  }

  return { pitch: [pitchX, pitchY], phase: [phaseX, phaseY] };
}

/** 파이썬 `round()` — 은행가 반올림. `bins`·`span` 계산이 정확히 이 규칙 위에 선다. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// ── ②단계: 격자선 확정과 위상 실측 ──────────────────────────────────

/**
 * 소수 피치를 **정수 픽셀 경계**로 확정한다.
 *
 * 두 경우를 가른다. 판정 기준은 body 가 피치의 정수배에 얼마나 가까운가다.
 *
 * 1. 정수배에 가까우면(잔차 ≤ 블록의 1/4) body 를 셀 개수로 **등분**한다. 피치 측정의
 *    미세오차(16.00 을 15.96 으로 재는 것)를 흡수해 격자가 딱 떨어진다.
 * 2. 정수배가 아니면 `lead + i·pitch` 를 직접 곱하고 자투리는 마지막 셀이 흡수한다.
 *    스프라이트 bbox 는 AA 프린지 때문에 블록의 정수배가 아닐 수 있다(실사고: 849px =
 *    27.46 블록). 이때 등분하면 셀 폭이 참 블록보다 0.52px 씩 어긋나 오른쪽 끝에서 반
 *    블록이 밀리고 얼굴이 부서졌다.
 *
 * 어느 쪽이든 피치를 **누적 덧셈하지 않으므로** 부동소수 오차가 쌓이지 않는다.
 */
export function gridEdges(length: number, pitch: number, offset: number): number[] {
  if (pitch <= 1.0) return [0, length];
  // 선행 부분셀은 스프라이트가 블록 중간에서 시작할 때만 의미가 있다. 컴포넌트는 bbox 로
  // 잘려 블록 경계에서 시작하므로 서브픽셀 오프셋(위상 추정 노이즈)은 0 으로 스냅한다.
  const rawLead = ((offset % pitch) + pitch) % pitch;
  const lead = rawLead < pitch * 0.25 || rawLead > pitch * 0.75 ? 0 : pyRound(rawLead);
  const body = length - lead;
  if (body <= 0) return [0, length];
  const ratio = body / pitch;
  const cells = Math.max(1, pyRound(ratio));
  const integral = Math.abs(ratio - cells) <= 0.25;
  const edges: number[] = lead === 0 ? [0] : [0, lead];
  for (let i = 1; i < cells; i++) {
    const e = lead + pyRound(integral ? (body * i) / cells : i * pitch);
    if (edges[edges.length - 1] < e && e < length) edges.push(e);
  }
  if (edges[edges.length - 1] !== length) edges.push(length);
  return edges;
}

/**
 * 행별 불투명 픽셀 색인 — (행별 x 오름차순, 그 픽셀들의 RGB 를 이어붙인 바이트).
 *
 * 채점은 셀 안의 불투명 픽셀만 본다. 격자 위상이 바뀌어도 이 색인은 그대로이므로
 * 컴포넌트당 한 번만 만들어 위상 스캔 전체가 공유한다.
 */
export type GridRows = { rowPos: number[][]; rowRgb: Uint8Array[] };

export function gridRows(component: RawImage): GridRows {
  const { data, width: w, height: h } = component;
  const rowPos: number[][] = [];
  const rowRgb: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const pos: number[] = [];
    for (let x = 0; x < w; x++) {
      // 알파 128 = 이 파이프라인 전역의 불투명 판정 관례다.
      if (data[(y * w + x) * 4 + 3] >= 128) pos.push(x);
    }
    const rgb = new Uint8Array(pos.length * 3);
    for (let i = 0; i < pos.length; i++) {
      const s = (y * w + pos[i]) * 4;
      rgb[i * 3] = data[s];
      rgb[i * 3 + 1] = data[s + 1];
      rgb[i * 3 + 2] = data[s + 2];
    }
    rowPos.push(pos);
    rowRgb.push(rgb);
  }
  return { rowPos, rowRgb };
}

/** `bisect_left` — 정렬된 배열에서 value 이상이 처음 나오는 위치. */
function bisectLeft(arr: number[], value: number, lo: number): number {
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 행마다 x 절단선이 압축 색인의 어느 인덱스에 떨어지는지 (셀 픽셀 슬라이스 경계).
 *
 * x 분할은 몇 종 안 되는데 격자는 수십 종이라, 분할별로 한 번 구해 두면 셀마다
 * 이분 탐색을 다시 돌리지 않는다.
 */
export function gridRowSplits(rowPos: number[][], xs: readonly number[], w: number): number[][] {
  const cuts = xs.map(e => Math.min(e, w));
  return rowPos.map(pos => {
    let lo = 0;
    const idx: number[] = [];
    for (const cut of cuts) {
      lo = bisectLeft(pos, cut, lo);
      idx.push(lo);
    }
    return idx;
  });
}

/**
 * 격자 가설의 셀 내부 색 편차 — 낮을수록 진짜 격자. 불투명 픽셀만, 셀 크기 가중.
 *
 * **정수 정확 산술이다.** 셀 편차를 float 로 누적하지 않는다. 셀의 한 채널 값 `v` 와
 * 평균 `m = s/n` 에 대해 `Σ(v − m) = 0` 이므로 평균 아래/위의 절대편차 합이 같고,
 *
 *     Σ|v − m| = 2·(m·C_lo − S_lo)      (C_lo, S_lo = v ≤ ⌊m⌋ 의 개수·합)
 *
 * 양변에 `n` 을 곱하면 `n·Σ|v − m| = 2·(s·C_lo − n·S_lo)` 로 전부 정수다. 부동소수는
 * 셀당 나눗셈 한 번과 누적에만 남는다.
 *
 * 동점 처리(strict `<`)와 순회 순서가 정본과 같아야 argmin 이 일치한다.
 */
export function gridScoreEdges(
  rows: GridRows,
  w: number,
  h: number,
  xs: readonly number[],
  ys: readonly number[],
  splits?: number[][],
): number {
  const { rowPos, rowRgb } = rows;
  const sp = splits ?? gridRowSplits(rowPos, xs, w);
  let totalDev = 0.0;
  let totalN = 0;
  const ncol = xs.length - 1;
  for (let yi = 0; yi < ys.length - 1; yi++) {
    const yEnd = Math.min(ys[yi + 1], h);
    for (let xi = 0; xi < ncol; xi++) {
      // 셀 픽셀을 모은다 (행별 압축 색인의 슬라이스).
      let n = 0;
      for (let y = ys[yi]; y < yEnd; y++) n += sp[y][xi + 1] - sp[y][xi];
      if (n < 2) continue;
      let t = 0;
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let y = ys[yi]; y < yEnd; y++) {
          const rgb = rowRgb[y];
          const lo = sp[y][xi];
          const hi = sp[y][xi + 1];
          for (let i = lo; i < hi; i++) s += rgb[i * 3 + k];
        }
        const floorMean = Math.floor(s / n);
        let cLo = 0;
        let sLo = 0;
        for (let y = ys[yi]; y < yEnd; y++) {
          const rgb = rowRgb[y];
          const lo = sp[y][xi];
          const hi = sp[y][xi + 1];
          for (let i = lo; i < hi; i++) {
            const v = rgb[i * 3 + k];
            if (v <= floorMean) {
              cLo++;
              sLo += v;
            }
          }
        }
        t += s * cLo - n * sLo;
      }
      // `2 *` 는 위 대칭성(평균 아래 합 = 위 합)의 계수다.
      totalDev += (2 * t) / n;
      totalN += n;
    }
  }
  return totalN ? totalDev / totalN : 1e9;
}

/** 단발 채점 — 피치 중재의 진단용. 위상 스캔은 `bestPhase` 가 코어를 직접 부른다. */
export function gridUniformity(component: RawImage, pitch: Pitch, phase: Phase): number {
  const w = component.width;
  const h = component.height;
  const rows = gridRows(component);
  const xs = gridEdges(w, pitch[0], phase[0]);
  const ys = gridEdges(h, pitch[1], phase[1]);
  return gridScoreEdges(rows, w, h, xs, ys);
}

/**
 * 주어진 피치에서 셀 균일도가 최선인 위상 (축별 8단계 탐색 — 결정론).
 *
 * 히스토그램 위상(`axisRefine` 반환값)을 그대로 쓰면 안 된다. 그건 1차원 신호의
 * 근사라 참 위상에서 **반 칸까지 밀린다**(실측: 피치 13.00 에서 검출 2.02 vs 실측 8.12).
 * 절단선 보정은 ±pitch/3 창 안에서만 당기므로 그 크기의 오차는 구조적으로 복구되지
 * 않고, 눈 4행이 3행으로 병합됐다.
 *
 * `(xs, ys)` 정수 경계로 메모이즈한다 — 8단계 위상 스캔은 `gridEdges` 의 정수 스냅
 * 때문에 서로 다른 위상이 **같은 경계로 자주 붕괴**한다. 같은 경계 → 같은 값이므로
 * 캐시는 정확하다.
 */
export function bestPhase(component: RawImage, pitch: Pitch): Phase {
  let best: Phase = [0.0, 0.0];
  let bestScore: number | null = null;
  const steps = 8;
  const rows = gridRows(component);
  const w = component.width;
  const h = component.height;
  const cache = new Map<string, number>();
  const splitCache = new Map<string, number[][]>();
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const phase: Phase = [(pitch[0] * i) / steps, (pitch[1] * j) / steps];
      const xs = gridEdges(w, pitch[0], phase[0]);
      const ys = gridEdges(h, pitch[1], phase[1]);
      const xk = xs.join(",");
      const key = `${xk}|${ys.join(",")}`;
      let score = cache.get(key);
      if (score === undefined) {
        let splits = splitCache.get(xk);
        if (splits === undefined) {
          splits = gridRowSplits(rows.rowPos, xs, w);
          splitCache.set(xk, splits);
        }
        score = gridScoreEdges(rows, w, h, xs, ys, splits);
        cache.set(key, score);
      }
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        best = phase;
      }
    }
  }
  return best;
}

/** 프레임 자체 검출 피치를 합의 피치의 '패밀리' 안에서만 채택한다. */
export const PITCH_FAMILY_RATIO = 1.1;

/**
 * 프레임 자체 검출 피치의 채택 판정 — 합의 '피치 패밀리' 밖이면 오검출 가드.
 *
 * 같은 스트립 안에서 참 피치의 프레임 간 편차는 측정 노이즈 수준(수 %)이다 — 합의
 * 13.00 vs 자체 12.50(4%) 실사고에서는 own 이 진실이었고 합의 강제가 눈을 반쪽 냈다.
 * 반면 하모닉/붕괴 오검출은 ×2/×3 급으로 벗어나 행 전체를 붕괴시킨다. 두 실사고 사이
 * 어디에도 참값이 없는 10%(비율 1.1)를 경계로 가른다.
 *
 * 반환: `[채택 피치, 패밀리-밖 outlier 여부]`. 폴백 사실은 호출부가 경고로 남긴다.
 */
export function resolveFramePitch(own: Pitch, consensus: Pitch): [Pitch, boolean] {
  const [ownX, ownY] = own;
  const [cx, cy] = consensus;
  if (Math.min(cx, cy) < 2.0) return [own, false];
  const ratio = Math.max(ownX / cx, cx / ownX, ownY / cy, cy / ownY);
  if (ratio > PITCH_FAMILY_RATIO) return [consensus, true];
  return [own, false];
}
