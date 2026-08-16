// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `extract.inspect_frames` 이식 — 추출 직후의 프레임별 QA.
// 원본: sprite-gen/sprite_gen/extract.py:2151-2190 (Apache-2.0)

/**
 * 추출된 프레임을 하나씩 재서 **에러**와 **경고**를 낸다.
 *
 * 이 검사가 폐루프(`inspect`/`score`)보다 앞이다. 폐루프는 프레임 사이의 관계
 * (색·실루엣·모션·무게중심)를 보지만, 여기서는 프레임 하나가 그 자체로 쓸 만한지를
 * 본다 — 비었는가, 테두리에 붙었는가, 크로마가 남았는가, 다른 프레임과 크기가
 * 딴판인가.
 *
 * **왜 필요한가**: 이게 없어서 프레임 하나가 5분의 1 크기로 뭉개진 시트가 폐루프
 * 100점을 받았다(2026-08-16). 정본은 같은 base·같은 codex 로 같은 결함을 만나
 * 추출 단계에서 **에러로 멈췄다**:
 *
 *     left_idle: frame 03 has 19744 chroma-adjacent pixels
 *     left_idle: frame 03 is much larger than median (27039 vs 2)
 *
 * 그 뒤 `chroma.mode: "ycbcr"` 로 바꾸니 에러 0·경고 0 으로 통과했다. 즉 이 검사는
 * "크로마 경로가 이 원본에 맞는가" 를 되묻는 자리이기도 하다.
 *
 * 에러와 경고의 구분은 원본 그대로다 — 빈 프레임과 크로마 잔류는 **에러**(행을
 * 차단), 테두리 접촉과 크기 이상치는 **경고**(기록하되 통과).
 */

import { pyRound } from "@/lib/sprite/motion-phase";

export type RGB = readonly [number, number, number];

export type FrameQaThresholds = {
  /** 이보다 불투명 픽셀이 적으면 빈 프레임 (에러). */
  minUsedPixels: number;
  /** 테두리 이 폭 안의 불투명 픽셀을 센다. */
  edgeMargin: number;
  /** 테두리 불투명 픽셀이 이보다 많으면 경고. */
  edgePixelThreshold: number;
  /** 키까지의 RGB 거리가 이 안이면 "크로마 인접" 으로 센다. */
  chromaAdjacentThreshold: number;
  /** 크로마 인접 픽셀이 이보다 많으면 에러. */
  chromaAdjacentPixelThreshold: number;
  /** 중앙값 × 이 비율보다 작으면 경고. */
  smallOutlierRatio: number;
  /** 중앙값 × 이 비율보다 크면 경고. */
  largeOutlierRatio: number;
};

/** 정본 `extract.py` argparse 기본값 그대로. */
export const DEFAULT_FRAME_QA: FrameQaThresholds = {
  minUsedPixels: 400,
  edgeMargin: 2,
  edgePixelThreshold: 24,
  chromaAdjacentThreshold: 150.0,
  chromaAdjacentPixelThreshold: 120,
  smallOutlierRatio: 0.35,
  largeOutlierRatio: 2.75,
};

export type FrameQaRecord = {
  index: number;
  nontransparent_pixels: number;
  bbox: [number, number, number, number] | null;
  edge_pixels: number;
  chroma_adjacent_pixels: number;
};

export type FrameQaResult = {
  errors: string[];
  warnings: string[];
  records: FrameQaRecord[];
};

type Frame = { data: Uint8Array; width: number; height: number };

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** 알파가 0 이 아닌 픽셀 수 (원본 `alpha_nonzero_count` — 히스토그램 1 이상 합). */
function alphaNonzeroCount(f: Frame): number {
  let n = 0;
  for (let p = 0; p < f.width * f.height; p++) if (f.data[p * 4 + 3] > 0) n++;
  return n;
}

/**
 * 테두리 `margin` 폭 안의 불투명 픽셀 수.
 *
 * 원본은 네 변을 각각 crop 해 더하므로 **모서리가 두 번 세어진다** — 그대로 둔다.
 * 임계(24)가 그 셈법 위에서 정해졌다.
 */
function edgeAlphaCount(f: Frame, margin: number): number {
  const { width: w, height: h, data } = f;
  let total = 0;
  const boxes: Array<[number, number, number, number]> = [
    [0, 0, w, margin],
    [0, h - margin, w, h],
    [0, 0, margin, h],
    [w - margin, 0, w, h],
  ];
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        if (data[(y * w + x) * 4 + 3] > 0) total++;
      }
    }
  }
  return total;
}

/** 알파 16 초과이면서 키에 가까운 픽셀 수 — 지워졌어야 할 배경이 남은 양. */
function chromaAdjacentCount(f: Frame, key: RGB, threshold: number): number {
  let count = 0;
  for (let p = 0; p < f.width * f.height; p++) {
    const i = p * 4;
    if (f.data[i + 3] > 16 && colorDistance([f.data[i], f.data[i + 1], f.data[i + 2]], key) <= threshold) {
      count++;
    }
  }
  return count;
}

/** PIL `getbbox()` — 알파가 0 이 아닌 영역의 [left, upper, right, lower]. */
function alphaBBox(f: Frame): [number, number, number, number] | null {
  let x0 = f.width;
  let y0 = f.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (f.data[(y * f.width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * 파이썬 `f"{x:.0f}"` — 은행가 반올림이다. JS `toFixed(0)` 은 half-away-from-zero 라
 * 중앙값이 .5 로 떨어지면 한 칸 어긋난다(실측: 9022.5 → 정본 "9022", toFixed "9023").
 * 경고 문구가 정본과 글자까지 같아야 교차 대조가 성립한다.
 */
function pyFormat0(value: number): string {
  return String(pyRound(value));
}

/** 파이썬 `statistics.median` — 짝수 개면 가운데 둘의 평균. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function inspectFrames(
  frames: Frame[],
  chromaKey: RGB,
  thresholds: FrameQaThresholds = DEFAULT_FRAME_QA,
): FrameQaResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const records: FrameQaRecord[] = [];
  const areas = frames.map(alphaNonzeroCount);
  const frameMedian = median(areas);

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const nontransparent = areas[index];
    const edge = edgeAlphaCount(frame, thresholds.edgeMargin);
    const adjacent = chromaAdjacentCount(frame, chromaKey, thresholds.chromaAdjacentThreshold);
    const bbox = alphaBBox(frame);
    const pad = String(index).padStart(2, "0");
    records.push({
      index,
      nontransparent_pixels: nontransparent,
      bbox,
      edge_pixels: edge,
      chroma_adjacent_pixels: adjacent,
    });
    if (nontransparent < thresholds.minUsedPixels) {
      errors.push(`frame ${pad} is empty or too sparse (${nontransparent} pixels)`);
    }
    if (edge > thresholds.edgePixelThreshold) {
      warnings.push(`frame ${pad} has ${edge} non-transparent edge pixels`);
    }
    if (adjacent > thresholds.chromaAdjacentPixelThreshold) {
      errors.push(`frame ${pad} has ${adjacent} chroma-adjacent pixels`);
    }
    if (frameMedian && nontransparent < frameMedian * thresholds.smallOutlierRatio) {
      warnings.push(
        `frame ${pad} is much smaller than median (${nontransparent} vs ${pyFormat0(frameMedian)})`,
      );
    }
    if (frameMedian && nontransparent > frameMedian * thresholds.largeOutlierRatio) {
      warnings.push(
        `frame ${pad} is much larger than median (${nontransparent} vs ${pyFormat0(frameMedian)})`,
      );
    }
  }
  return { errors, warnings, records };
}
