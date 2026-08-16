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
