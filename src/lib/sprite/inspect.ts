// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `inspect.py` 이식 — 폐루프 교정의 **측정** 단계.
// 원본: sprite-gen/sprite_gen/inspect.py (Apache-2.0)

/**
 * 생성된 행에서 결정론 신호를 잰다. 판단은 하지 않는다.
 *
 * 정본이 교정 루프를 셋으로 쪼갠 이유가 여기 있다(architecture.md):
 * `inspect` 는 **재기만** 하고, `score` 가 그 리포트만 보고 점수·힌트를 만들고,
 * `correction_loop` 가 최선 후보를 보존하며 재생성한다. 측정과 판단이 한 파일에
 * 섞이면 임계를 바꿀 때마다 측정이 따라 흔들린다.
 *
 * 신호 넷:
 *
 *   - **RGB 히스토그램 교차** — 프레임 사이 색 정체성. 팔레트가 바뀌면 떨어진다.
 *   - **dHash 유사도** — 실루엣 정체성. 프레임마다 다시 그려지면 떨어진다.
 *   - **모션 존재** — 프레임 간 차이의 크기. 0 에 가까우면 정지 화면이다.
 *   - **무게중심 σ** — 알파 무게중심의 흔들림. 재생 시 지터로 보인다.
 *
 * 축소본을 쓰는 두 신호(dHash·모션)는 PIL 의 BILINEAR 로 줄여야 한다. sharp 의
 * 어떤 커널도 PIL 과 안 맞고(실측 maxdiff 7~12), dHash 는 축소본의 인접 픽셀 대소
 * 비교라 1 차이로 비트가 뒤집힌다 — 그래서 `pil-resample.ts` 를 따로 이식했다.
 *
 * **이식 범위**: 정본의 `raw-projection` 폴백(추출된 프레임이 없을 때 raw 스트립을
 * projection 분리로 쪼개 재는 경로)은 `segment.py` 에 의존하는데 그쪽은 미이식이다.
 * 여기서는 추출된 프레임만 잰다.
 */

import { compositeOnWhite, pilResizeBilinear, pilResizeRgba, pilRgbToL } from "@/lib/sprite/pil-resample";

export const HISTOGRAM_BINS = 64;
export const D_HASH_BITS = 64;
export const DEFAULT_HISTOGRAM_MIN = 0.0;
export const DEFAULT_DHASH_MIN = 0.55;
export const DEFAULT_MOTION_MIN = 0.01;

export type Frame = { data: Uint8Array; width: number; height: number };

/** 알파 16 이하는 세지 않는다 — 프린지가 색 정체성을 흐리지 않게. */
export function rgbHistogram(frame: Frame): number[] {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  let total = 0;
  const n = frame.width * frame.height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (frame.data[i + 3] <= 16) continue;
    const index =
      Math.floor(frame.data[i] / 64) * 16 +
      Math.floor(frame.data[i + 1] / 64) * 4 +
      Math.floor(frame.data[i + 2] / 64);
    bins[index] += 1;
    total += 1;
  }
  if (total === 0) return new Array<number>(HISTOGRAM_BINS).fill(0);
  return bins.map(v => v / total);
}

export function histogramIntersection(left: number[], right: number[]): number {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.min(left[i], right[i]);
  return sum;
}

/**
 * 투명 영역을 흰색으로 메운 뒤 9×8 그레이로 줄여 가로 이웃끼리 대소를 비트로 담는다.
 * 알파가 달라도 실루엣이 같으면 같은 해시가 나오게 하려는 것이다.
 *
 * 64비트라 `bigint` 로 다룬다 — number 는 32비트 비트연산이라 위쪽이 잘린다.
 */
export function dhash(frame: Frame): bigint {
  const white = compositeOnWhite(frame.data, frame.width, frame.height);
  const gray = pilRgbToL(white, frame.width, frame.height);
  const small = pilResizeBilinear(gray, frame.width, frame.height, 9, 8, 1);
  // 이 저장소의 tsconfig target 이 ES2017 이라 `0n` 같은 bigint **리터럴**을 못 쓴다.
  // 값 자체는 64비트가 필요하므로(number 비트연산은 32비트에서 잘린다) BigInt()
  // 호출로 만든다. target 을 올리는 건 이 파일 하나를 위해 전역을 건드리는 일이다.
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let value = ZERO;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    const row = y * 9;
    for (let x = 0; x < 8; x++) {
      if (small[row + x] > small[row + x + 1]) value |= ONE << BigInt(bit);
      bit += 1;
    }
  }
  return value;
}

export function dhashSimilarity(left: bigint, right: bigint): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let x = left ^ right;
  let bits = 0;
  while (x !== ZERO) {
    bits += Number(x & ONE);
    x >>= ONE;
  }
  return 1.0 - bits / D_HASH_BITS;
}

/** 알파 가중 무게중심. 알파 10 이하는 제외(소프트 매트 프린지). */
export function alphaCentroid(frame: Frame): [number, number] | null {
  let total = 0;
  let wx = 0;
  let wy = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const a = frame.data[(y * frame.width + x) * 4 + 3];
      if (a <= 10) continue;
      total += a;
      wx += x * a;
      wy += y * a;
    }
  }
  if (total === 0) return null;
  return [wx / total, wy / total];
}

/** 이웃 프레임 쌍의 RGBA 절대차 합을 64×64 축소본에서 재고 평균한다. */
export function motionPresence(frames: Frame[]): number {
  if (frames.length < 2) return 0.0;
  const values: number[] = [];
  for (let k = 0; k + 1 < frames.length; k++) {
    // RGBA 축소는 PIL 이 프리멀티플라이 왕복으로 돈다 — pilResizeRgba 가 그 경로다.
    const a = pilResizeRgba(frames[k].data, frames[k].width, frames[k].height, 64, 64);
    const b = pilResizeRgba(frames[k + 1].data, frames[k + 1].width, frames[k + 1].height, 64, 64);
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    values.push(total / (64 * 64 * 4 * 255));
  }
  return values.length > 0 ? mean(values) : 0.0;
}

function mean(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 모집단 표준편차 (파이썬 `statistics.pstdev` — n 으로 나눈다). */
function pstdev(values: number[]): number {
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / values.length);
}

export type SimilaritySummary = {
  histogram_intersection: { min: number; mean: number };
  dhash_similarity: { min: number; mean: number };
  motion_presence: number;
  centroid_sigma: { x: number; y: number };
};

/** 프레임 하나뿐이면 쌍이 없어 유사도는 1.0(=완전히 같다)로 둔다 — 원본과 같다. */
export function similaritySummary(frames: Frame[]): SimilaritySummary {
  const histograms = frames.map(rgbHistogram);
  const hashes = frames.map(dhash);
  const histPairs: number[] = [];
  const dhashPairs: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      histPairs.push(histogramIntersection(histograms[i], histograms[j]));
      dhashPairs.push(dhashSimilarity(hashes[i], hashes[j]));
    }
  }
  const centroids = frames.map(alphaCentroid);
  const xs = centroids.filter((c): c is [number, number] => c !== null).map(c => c[0]);
  const ys = centroids.filter((c): c is [number, number] => c !== null).map(c => c[1]);
  return {
    histogram_intersection: {
      min: histPairs.length > 0 ? Math.min(...histPairs) : 1.0,
      mean: histPairs.length > 0 ? mean(histPairs) : 1.0,
    },
    dhash_similarity: {
      min: dhashPairs.length > 0 ? Math.min(...dhashPairs) : 1.0,
      mean: dhashPairs.length > 0 ? mean(dhashPairs) : 1.0,
    },
    motion_presence: motionPresence(frames),
    centroid_sigma: {
      x: xs.length > 1 ? pstdev(xs) : 0.0,
      y: ys.length > 1 ? pstdev(ys) : 0.0,
    },
  };
}

export type InspectThresholds = {
  histogramMin: number;
  dhashMin: number;
  motionMin: number;
};

export const DEFAULT_INSPECT_THRESHOLDS: InspectThresholds = {
  histogramMin: DEFAULT_HISTOGRAM_MIN,
  dhashMin: DEFAULT_DHASH_MIN,
  motionMin: DEFAULT_MOTION_MIN,
};

/**
 * 행의 역할. 방향 앵커 행은 **모션 임계에서 면제**된다.
 *
 * 정본 이탈이고, 근거는 정본 자신의 프롬프트다. 방향 앵커 행에는
 * *"keep poses minimal (subtle breathing) so a single frame can be cropped as the
 * anchor"* 가 붙는다(prepare.py:707) — 그 행은 앵커로 잘라 쓸 정지에 가까운 포즈가
 * 목적이다. 그런데 정본 score 는 상태를 가리지 않고 `motion < 0.01` 을 경고로
 * 올리므로, 앵커 행은 **고칠 수 없는 경고**를 영구히 받는다. 정본은 CLI 라
 * `--motion-min` 으로 사람이 낮추면 그만이지만 우리 앱에는 그 자리가 없다.
 *
 * 실측(2026-08-16, 같은 런):
 *
 *   down_idle  (앵커 행) 모션 0.0065  실루엣 1.0000  →  85점, 교정해도 85점
 *   down_attack(액션 행) 모션 0.0660  실루엣 0.7656  → 100점
 *
 * 액션 행은 10배 움직이고 만점이다. 파이프라인이 아니라 앵커 행의 성질이다.
 * 그 행에 "더 움직여라" 힌트를 주고 재생성하면 프롬프트가 자기 자신과 싸우고
 * (같은 프롬프트에 minimal 3회 vs visibly progress 1회) codex 비용만 나간다.
 */
export type RowRole = "direction-anchor" | "action-row";

export type InspectRow = {
  state: string;
  role?: RowRole;
  source: "frames" | "missing";
  expected_frames: number;
  found_frames: number;
  metrics: SimilaritySummary | null;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 경고가 아닌 기록(임계 면제 사유 등). 점수에 영향을 주지 않는다. */
  notes?: string[];
};

export type InspectReport = {
  ok: boolean;
  engine: "component-row";
  kind: "sprite-gen-inspect-report";
  states: string[];
  thresholds: { histogram_min: number; dhash_min: number; motion_min: number };
  rows: InspectRow[];
  errors: string[];
  warnings: string[];
};

/**
 * 상태별 추출 프레임을 재서 리포트를 만든다.
 *
 * 경고 문구는 정본과 같은 형식이다 — `score` 가 문구가 아니라 metrics 를 보지만,
 * 사람이 읽는 자리(모션 QA)에 그대로 나가므로 표현을 갈라놓지 않는다.
 */
export function inspectStates(
  input: Array<{ state: string; expected: number; frames: Frame[]; role?: RowRole }>,
  thresholds: InspectThresholds = DEFAULT_INSPECT_THRESHOLDS,
): InspectReport {
  const rows: InspectRow[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const { state, expected, frames, role } of input) {
    if (frames.length === 0) {
      const row: InspectRow = {
        state,
        role,
        source: "missing",
        expected_frames: expected,
        found_frames: 0,
        metrics: null,
        ok: false,
        errors: [`${state}: missing extracted frames`],
        warnings: [],
      };
      rows.push(row);
      errors.push(...row.errors);
      continue;
    }
    const found = frames.length;
    const rowErrors: string[] = [];
    const rowWarnings: string[] = [];
    /** 경고가 아닌 기록 — 점수에 영향을 주지 않는다. */
    const rowNotes: string[] = [];
    if (found !== expected) {
      rowErrors.push(`${state}: expected ${expected} frame(s), inspect found ${found}`);
    }
    const metrics = similaritySummary(frames);
    if (
      thresholds.histogramMin > 0 &&
      metrics.histogram_intersection.min < thresholds.histogramMin
    ) {
      rowWarnings.push(
        `${state}: RGB histogram identity similarity is low ` +
          `(${metrics.histogram_intersection.min.toFixed(3)} < ${thresholds.histogramMin.toFixed(3)})`,
      );
    }
    if (metrics.dhash_similarity.min < thresholds.dhashMin) {
      rowWarnings.push(
        `${state}: dHash silhouette similarity is low ` +
          `(${metrics.dhash_similarity.min.toFixed(3)} < ${thresholds.dhashMin.toFixed(3)})`,
      );
    }
    // 앵커 행은 모션 임계에서 면제한다(RowRole 주석 참고). 면제 사실은 남긴다 —
    // 조용히 빼면 "이 행은 왜 경고가 없나" 를 나중에 못 짚는다.
    if (role === "direction-anchor") {
      if (metrics.motion_presence < thresholds.motionMin) {
        rowNotes.push(
          `${state}: motion ${metrics.motion_presence.toFixed(4)} — 방향 앵커 행이라 ` +
            `모션 임계(${thresholds.motionMin.toFixed(4)})를 적용하지 않았습니다. ` +
            "이 행은 앵커로 잘라 쓸 최소 동작이 목적입니다",
        );
      }
    } else if (metrics.motion_presence < thresholds.motionMin) {
      rowWarnings.push(
        `${state}: motion presence is too low ` +
          `(${metrics.motion_presence.toFixed(4)} < ${thresholds.motionMin.toFixed(4)})`,
      );
    }
    rows.push({
      state,
      role,
      source: "frames",
      ...(rowNotes.length > 0 ? { notes: rowNotes } : {}),
      expected_frames: expected,
      found_frames: found,
      metrics,
      ok: rowErrors.length === 0,
      errors: rowErrors,
      warnings: rowWarnings,
    });
    errors.push(...rowErrors);
    warnings.push(...rowWarnings);
  }

  return {
    ok: errors.length === 0,
    engine: "component-row",
    kind: "sprite-gen-inspect-report",
    states: input.map(i => i.state),
    thresholds: {
      histogram_min: thresholds.histogramMin,
      dhash_min: thresholds.dhashMin,
      motion_min: thresholds.motionMin,
    },
    rows,
    errors,
    warnings,
  };
}
