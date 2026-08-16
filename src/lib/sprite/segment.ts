// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `segment.py` 이식 — 투영 프로파일 + DP 최적 절단 프레임 분리 (옵트인).
// 원본: sprite-gen/sprite_gen/segment.py (Apache-2.0), 그 자체가
// perfectpixel-studio `internal/sprite/segment.go`
// (https://github.com/gykim80/perfectpixel-studio, Copyright (c) gykim80, MIT)
// 의 이식이다. OCR 라인/단어 분리에서 쓰는 projection-profile + optimal-cut 기법.

/**
 * 붙어버린 포즈를 갈라 놓는다.
 *
 * 연결요소(connected-components) 추출은 팔·소품이 이웃 프레임과 닿으면 붙은 포즈를
 * 한 덩어리로 합쳐 프레임 분리가 실패한다. 이 모듈은 컬럼별 알파 질량
 * `P[x] = Σ_y α(x,y)` 의 골(gutter)로 자연 포즈 수를 세고, 포즈가 닿아 골이
 * 사라졌을 때는 DP 로 `Σ P[cut] + λ·(width−ideal)²` 최소 컷을 찾아 정확히 기대
 * 프레임 수의 컬럼 세그먼트로 나눈다.
 *
 * ## 통합은 `separateFusedPoses` 하나로 한다
 *
 * 옵트인(`fit.segmentation: "projection"`)일 때만 스트립을 세그먼트 경계에서 갈라
 * 투명 거터를 넣어 재조립한다. 이후의 연결요소 추출·위성 병합 경로는 무변경으로
 * 그대로 동작한다.
 *
 * **기본은 off** — 기존 런의 골든 재현성을 지킨다. 분리가 기대 개수를 못 내면
 * 스트립을 **건드리지 않고** 그 사실을 보고한다. 하류 연결요소 추출이 기존 에러로
 * 관측 가능하게 실패하게 두는 것이지, 조용히 다른 그림을 굽지 않는다.
 */

import { smoothProfile } from "@/lib/sprite/silhouette";

export type RawImage = { data: Uint8Array; width: number; height: number };
/** [start, end) 컬럼 구간. */
export type Span = [number, number];

/**
 * 재조립 시 세그먼트 사이에 넣는 투명 거터 폭(px).
 *
 * 4-연결 flood fill 분리에는 1px 이면 충분하지만, 하류 위성 병합의 근접 판정이
 * 인접 프레임을 물지 않도록 여유를 둔다.
 */
export const GUTTER = 8;

/** 컬럼별 알파 질량 `P[x] = Σ_y α(x,y)`. */
export function projectAlpha(image: RawImage): number[] {
  const { data, width, height } = image;
  const profile = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a) profile[x] += a;
    }
  }
  return profile;
}

/** P 가 eps 를 넘는 연속 구간(포즈). 좁거나 봉우리가 낮은 구간은 잡티로 버린다. */
export function contentRuns(
  profile: number[],
  eps: number,
  peakMin: number,
  minWidth: number,
): Span[] {
  const runs: Span[] = [];
  const length = profile.length;
  let i = 0;
  while (i < length) {
    if (profile[i] <= eps) {
      i += 1;
      continue;
    }
    let j = i;
    let peak = 0;
    while (j < length && profile[j] > eps) {
      if (profile[j] > peak) peak = profile[j];
      j += 1;
    }
    if (j - i >= minWidth && peak >= peakMin) runs.push([i, j]);
    i = j;
  }
  return runs;
}

export function runMass(profile: number[], span: Span): number {
  const [start, end] = span;
  let sum = 0;
  for (let i = start; i < Math.min(end, profile.length); i++) sum += profile[i];
  return sum;
}

/**
 * 최대 런 질량의 `fraction` 미만인 런(원거리 잔여물·잡티)을 제거한다.
 *
 * 연결요소 방식의 "최대 blob 면적 대비 시드 임계값" 가드와 같은 취지다.
 */
export function dropMinorRuns(profile: number[], runs: Span[], fraction: number): Span[] {
  if (runs.length <= 1) return runs;
  const maxMass = Math.max(...runs.map(r => runMass(profile, r)));
  const threshold = maxMass * fraction;
  return runs.filter(r => runMass(profile, r) >= threshold);
}

/** 런 폭의 중앙값 (전형적 단일 포즈 폭 추정). 파이썬처럼 짝수면 위쪽을 쓴다. */
export function medianRunWidth(runs: Span[]): number {
  if (runs.length === 0) return 0;
  const widths = runs.map(([s, e]) => e - s).sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

/**
 * `[start, end)` 구간에서 prominence(돌출도) 기준의 강한 봉우리(=포즈) 컬럼.
 *
 * 후보는 런 최대값의 45% 이상인 국소 최대이고, 더 높은 봉우리와의 사이 골이 충분히
 * 깊어야(자기 높이의 62% 미만으로 내려가야) 별개 포즈로 인정된다.
 */
export function posePeaks(profile: number[], start: number, end: number): number[] {
  if (end - start < 3) return [Math.floor((start + end) / 2)];
  let runMax = -Infinity;
  for (let i = start; i < end; i++) if (profile[i] > runMax) runMax = profile[i];
  if (runMax <= 0) return [Math.floor((start + end) / 2)];
  const candidates: number[] = [];
  for (let x = start + 1; x < end - 1; x++) {
    if (profile[x] >= profile[x - 1] && profile[x] > profile[x + 1] && profile[x] >= 0.45 * runMax) {
      candidates.push(x);
    }
  }
  if (candidates.length === 0) return [Math.floor((start + end) / 2)];
  const keep: number[] = [];
  for (const peak of candidates) {
    let prominent = true;
    for (const other of candidates) {
      // 자기보다 높은 봉우리에 대해서만 골 깊이를 검사한다.
      if (other === peak || profile[other] < profile[peak]) continue;
      const lo = peak < other ? peak : other;
      const hi = peak < other ? other : peak;
      let valley = Infinity;
      for (let i = lo; i <= hi; i++) if (profile[i] < valley) valley = profile[i];
      if (valley > 0.62 * profile[peak]) {
        // 사이 골이 얕다 → 같은 포즈의 일부
        prominent = false;
        break;
      }
    }
    if (prominent) keep.push(peak);
  }
  return keep.length > 0 ? keep : [candidates[0]];
}

/**
 * `[x0, x1)` 구간을 정확히 count 개 세그먼트로 나누는 count-1 개 컷 컬럼.
 *
 * 비용 = `Σ P[cut]`(질량이 적은 곳을 자르는 게 저렴) + 폭 정규화(이상폭에서 벗어날수록
 * 벌점). 닿아 있는 포즈를 강제로 기대 개수로 분리할 때 쓴다.
 */
export function dpNCut(profile: number[], x0: number, x1: number, count: number): number[] | null {
  if (count <= 1 || x1 - x0 < count) return null;
  const width = x1 - x0;
  const ideal = width / count;
  const minWidth = Math.max(2, Math.trunc(ideal * 0.45));
  const lam = 0.0015; // 폭 정규화 가중 (질량 비용 대비)
  const infinity = 1e18;

  const cuts = count - 1;
  const cost: number[][] = [];
  const previous: number[][] = [];
  for (let k = 0; k <= cuts; k++) {
    cost.push(new Array<number>(x1 + 1).fill(infinity));
    previous.push(new Array<number>(x1 + 1).fill(-1));
  }
  cost[0][x0] = 0; // 가상 시작 경계
  for (let k = 1; k <= cuts; k++) {
    const lo = x0 + (k - 1) * minWidth;
    const priorRow = cost[k - 1];
    const row = cost[k];
    const back = previous[k];
    for (let x = x0 + k * minWidth; x <= x1 - (cuts - k + 1) * minWidth; x++) {
      let best = infinity;
      let bestPrevious = -1;
      const mass = profile[x];
      for (let xp = lo; xp <= x - minWidth; xp++) {
        const base = priorRow[xp];
        if (base >= 1e17) continue;
        const deviation = x - xp - ideal;
        const candidate = base + mass + lam * deviation * deviation;
        if (candidate < best) {
          best = candidate;
          bestPrevious = xp;
        }
      }
      row[x] = best;
      back[x] = bestPrevious;
    }
  }
  let bestEnd = -1;
  let bestCost = infinity;
  for (let x = x0 + cuts * minWidth; x <= x1 - minWidth; x++) {
    const deviation = x1 - x - ideal;
    const candidate = cost[cuts][x] + lam * deviation * deviation;
    if (candidate < bestCost) {
      bestCost = candidate;
      bestEnd = x;
    }
  }
  if (bestEnd < 0) return null;
  const output = new Array<number>(cuts).fill(0);
  let x = bestEnd;
  for (let k = cuts; k >= 1; k--) {
    output[k - 1] = x;
    x = previous[k][x];
    if (x < 0) return null;
  }
  return output;
}

/** `[start, end)` 를 DP 최소 절단으로 count 개로 나눈다 (실패 시 균등 분할). */
export function splitRange(profile: number[], start: number, end: number, count: number): Span[] {
  if (count <= 1 || end - start < count) return [[start, end]];
  const cuts = dpNCut(profile, start, end, count);
  if (cuts !== null && cuts.length === count - 1) {
    const spans: Span[] = [];
    let anchor = start;
    for (const cut of cuts) {
      spans.push([anchor, cut]);
      anchor = cut;
    }
    spans.push([anchor, end]);
    return spans;
  }
  const spans: Span[] = [];
  for (let i = 0; i < count; i++) {
    spans.push([
      start + Math.floor(((end - start) * i) / count),
      start + Math.floor(((end - start) * (i + 1)) / count),
    ]);
  }
  return spans;
}

/**
 * 스트립을 expected 개 컬럼 세그먼트로 나눈다 → (세그먼트, 자연 포즈 수).
 *
 * 자연 포즈 수(강제 복구 전 추정치)가 expected 와 같으면 골 중심에서 깔끔히 잘리고,
 * 아니면 DP 로 expected 개를 강제 분할한다. 강제 분할이 불가능하면(폭 부족) 추정
 * 세그먼트를 그대로 낸다 — 호출자가 개수 불일치를 관측 가능하게 처리한다.
 */
export function segmentStrip(
  image: RawImage,
  expected: number,
): { segments: Span[]; natural: number } {
  const width = image.width;
  if (width === 0 || expected < 1) return { segments: [], natural: 0 };
  const raw = projectAlpha(image);
  const window = Math.max(3, Math.floor(width / 220));
  const profile = smoothProfile(raw, window);
  // 스프레드로 max 를 잡으면 폭이 큰 스트립에서 인자 한도를 넘는다.
  let peakMax = 0;
  for (const v of profile) if (v > peakMax) peakMax = v;
  if (peakMax <= 0) return { segments: [], natural: 0 };
  const eps = 0.045 * peakMax;
  const peakMin = 0.18 * peakMax;
  const minRun = Math.max(4, Math.floor(width / 100));
  let runs = contentRuns(profile, eps, peakMin, minRun);
  runs = dropMinorRuns(profile, runs, 0.2);
  if (runs.length === 0) return { segments: [], natural: 0 };

  // 런마다 "토르소 봉우리" 수로 포즈 수를 추정하되 런 폭으로 상한을 둔다. 봉우리는
  // "어디서 자를지", 폭은 "몇 개로 자를지" 를 정한다: 발차기처럼 한 포즈가 토르소+뻗은
  // 다리로 두 봉우리를 만들어도, 런 폭이 단일 포즈 폭(중앙값)이면 1개로 묶어 과분할을
  // 막는다. 닿아 넓어진 런만 그만큼 쪼갠다.
  const med = medianRunWidth(runs);
  let widthTotal = 0;
  for (const [s, e] of runs) widthTotal += e - s;
  const segments: Span[] = [];
  for (const [start, end] of runs) {
    let peakCount = posePeaks(profile, start, end).length;
    if (runs.length > 1 && med > 0) {
      const maxByWidth = Math.max(1, Math.trunc((end - start) / med + 0.5));
      if (peakCount > maxByWidth) peakCount = maxByWidth;
      // 포즈 사이 간격이 거의 없어(overlapping) 봉우리가 1개뿐이지만 런 폭이 평균 포즈
      // 폭의 1.45배 이상이면 강제로 2개로 의심한다.
      if (peakCount === 1 && end - start > med * 1.45) peakCount = 2;
    }
    if (peakCount <= 1) segments.push([start, end]);
    else segments.push(...splitRange(profile, start, end, peakCount));
  }

  const natural = segments.length;
  // 강제 복구: 감지된 수가 기대와 다르고 전체 콘텐츠 폭이 기대 개수의 최소 폭을
  // 감당할 수 있다면 전체 스트립을 DP 로 expected 개 분할한다. AI 가 포즈를 거터 없이
  // 완전히 붙여 그리는 경우를 방어한다.
  if (
    natural !== expected &&
    widthTotal / expected >= 16 &&
    Math.floor(width / expected) >= 16
  ) {
    return { segments: splitRange(profile, 0, width, expected), natural };
  }
  return { segments, natural };
}

/**
 * 스트립 전체를 타일링하는 expected-1 개 컷 컬럼. 실패 시 `boundaries: null`.
 *
 * 세그먼트 사이 골은 골 중심에서 자르고, DP 컷(인접 세그먼트가 경계를 공유)은 그
 * 컬럼을 그대로 쓴다. 경계 밖 콘텐츠(잡티로 버려진 런)도 어느 한 슬라이스에 남도록
 * 전체 폭을 타일링한다 — 버릴지는 하류 위성 병합이 판단한다.
 */
export function segmentBoundaries(
  image: RawImage,
  expected: number,
): { boundaries: number[] | null; natural: number } {
  const { segments, natural } = segmentStrip(image, expected);
  if (segments.length !== expected) return { boundaries: null, natural };
  const boundaries: number[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    boundaries.push(Math.floor((segments[i][1] + segments[i + 1][0]) / 2));
  }
  const width = image.width;
  if (boundaries.some(c => !(c > 0 && c < width))) return { boundaries: null, natural };
  for (let i = 0; i + 1 < boundaries.length; i++) {
    if (boundaries[i + 1] <= boundaries[i]) return { boundaries: null, natural };
  }
  return { boundaries, natural };
}

export type SegmentationMode = "components" | "projection";

/** 분리 모드의 SSoT 는 sprite-request `fit.segmentation` 이고, 호출자 인자는 명시 override 만. */
export function resolveSegmentation(
  fit: { segmentation?: string } | null | undefined,
  override?: string | null,
): string {
  if (override) return String(override).toLowerCase();
  return String(fit?.segmentation ?? "components").toLowerCase();
}

export type SeparateResult = {
  strip: RawImage;
  /** 스트립을 실제로 갈랐는가. false 면 `strip` 은 입력 그대로다. */
  applied: boolean;
  /** 강제 복구 전 자연 포즈 수 (모드가 꺼져 있으면 undefined). */
  natural?: number;
  boundaries?: number[];
  /** 관측용 한 줄. 정본은 stderr 로 찍지만 우리는 호출자가 경고로 싣는다. */
  note?: string;
};

/**
 * 옵트인 융착 포즈 분리 훅 — 활성일 때만 스트립을 갈라 거터를 넣어 재조립한다.
 *
 * 분리가 기대 개수를 못 내면 스트립을 **건드리지 않고** 그 사실을 note 로 낸다.
 * 하류 연결요소 추출이 기존 에러로 관측 가능하게 실패한다 (No Silent Fallback).
 */
export function separateFusedPoses(
  strip: RawImage,
  frameCount: number,
  opts: {
    fit?: { segmentation?: string } | null;
    override?: string | null;
    label?: string;
  } = {},
): SeparateResult {
  const label = opts.label ?? "strip";
  if (resolveSegmentation(opts.fit, opts.override) !== "projection") {
    return { strip, applied: false };
  }
  const { boundaries, natural } = segmentBoundaries(strip, frameCount);
  if (boundaries === null) {
    return {
      strip,
      applied: false,
      natural,
      note:
        `[segment] ${label}: projection segmentation found ${natural} pose(s) ` +
        `for expected ${frameCount} — strip left untouched`,
    };
  }
  const { width, height } = strip;
  const edges = [0, ...boundaries, width];
  const widths: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) widths.push(edges[i + 1] - edges[i]);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + GUTTER * (widths.length + 1);
  const rebuilt: RawImage = {
    data: new Uint8Array(totalWidth * height * 4),
    width: totalWidth,
    height,
  };
  let x = GUTTER;
  for (let i = 0; i < widths.length; i++) {
    const src0 = edges[i];
    const w = widths[i];
    for (let y = 0; y < height; y++) {
      const s = (y * width + src0) * 4;
      rebuilt.data.set(strip.data.subarray(s, s + w * 4), (y * totalWidth + x) * 4);
    }
    x += w + GUTTER;
  }
  const forced = natural !== frameCount ? ", DP-forced" : "";
  return {
    strip: rebuilt,
    applied: true,
    natural,
    boundaries,
    note:
      `[segment] ${label}: projection split at columns [${boundaries.join(", ")}] ` +
      `(natural poses=${natural}${forced})`,
  };
}
