// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `score.py` 이식 — 폐루프 교정의 **판단** 단계.
// 원본: sprite-gen/sprite_gen/score.py (Apache-2.0)

/**
 * inspect 리포트만 보고 점수와 교정 힌트를 만든다. 이미지를 다시 열지 않는다.
 *
 * 정본이 측정과 판단을 갈라놓은 이유가 여기서 드러난다 — 이 파일은 리포트라는
 * **데이터 하나만** 입력으로 받으므로, 임계를 바꾸거나 힌트 문구를 고쳐도 측정이
 * 흔들리지 않고, 반대로 새 신호를 재기 시작해도 채점 규칙은 그대로다.
 *
 * 힌트는 그대로 다음 생성의 프롬프트에 얹히는 **영어 지시문**이다. 우리 UI 문구를
 * 한국어로 쓴다고 여기까지 번역하면 안 된다 — 받는 쪽이 이미지 모델이다.
 */

import { pyRound } from "@/lib/sprite/motion-phase";
import type { InspectReport, InspectRow } from "@/lib/sprite/inspect";

/** 순서를 보존하는 중복 제거 (원본 `_unique`). */
function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/** Python `round(x, 2)`. 소수 둘째 자리에서 은행가 반올림. */
function round2(value: number): number {
  return pyRound(value * 100) / 100;
}

export type ScoreRow = {
  state: string;
  score: number;
  candidate_rank: number;
  expected_frames: number;
  found_frames: number;
  errors: string[];
  warnings: string[];
  hints: string[];
};

export type ScoreReport = {
  ok: boolean;
  kind: "sprite-gen-score-report";
  overall_score: number;
  candidate_rank: number;
  rows: ScoreRow[];
  hints: string[];
};

function hintsForRow(row: InspectRow, histogramMin: number, dhashMin: number): string[] {
  const state = row.state;
  const expected = row.expected_frames;
  const found = row.found_frames;
  const metrics = row.metrics;
  const hints: string[] = [];

  if (found !== expected) {
    hints.push(
      `${state}: The previous strip was read as ${found} pose(s), but the request requires exactly ` +
        `${expected}. Regenerate as exactly ${expected} full-body poses in ${expected} equal invisible ` +
        "horizontal slots. Keep clear gutters between poses; no limbs, props, shadows, or effects may cross a slot boundary.",
    );
  }
  const histMin = metrics?.histogram_intersection.min ?? 1.0;
  if (histogramMin > 0 && histMin < histogramMin) {
    hints.push(
      `${state}: Frame-to-frame color identity drift was detected (RGB histogram similarity ${histMin.toFixed(3)}). ` +
        "Copy the accepted anchor palette, outfit colors, hair color, face markings, and outline weight in every pose.",
    );
  }
  const rowDhashMin = metrics?.dhash_similarity.min ?? 1.0;
  if (rowDhashMin < dhashMin) {
    hints.push(
      `${state}: Silhouette drift was detected (dHash similarity ${rowDhashMin.toFixed(3)}). ` +
        "Keep the same body proportions and camera angle; only change the limb motion needed for this action.",
    );
  }
  const motion = metrics?.motion_presence ?? 1.0;
  if (motion < 0.01 && expected > 1) {
    hints.push(
      `${state}: Adjacent frames are too similar (motion presence ${motion.toFixed(4)}). ` +
        "Make the action visibly progress across the row while preserving the same character identity and foot baseline.",
    );
  }
  // 추출 쪽 메시지에서 유형을 읽어 지시문을 붙인다. 원본과 같이 **첫 매치만** 쓴다.
  for (const message of [...row.errors, ...row.warnings]) {
    if (message.includes("chroma-adjacent")) {
      hints.push(
        `${state}: Visible chroma residue remained after extraction. Use a flat clean chroma background and keep key-colored pixels away from the character.`,
      );
    } else if (message.includes("edge")) {
      hints.push(
        `${state}: Sprite content touched the frame edge. Leave the requested safe margin around every full-body pose.`,
      );
    } else if (
      message.includes("pitch") ||
      message.includes("runlen") ||
      message.includes("grid")
    ) {
      hints.push(
        `${state}: Pixel-grid pitch instability was detected. Regenerate with a clearer true low-resolution pixel grid, or rerun extraction with the runlen crosscheck visible and review the before/after grid proof.`,
      );
    }
  }
  return hints;
}

/**
 * 리포트를 채점한다.
 *
 * `ok` 는 **모든 행이 90점 이상이고 에러가 없을 때만** 참이다. 경고는 점수를 깎지만
 * 그 자체로 실패는 아니다 — 정본의 구분을 그대로 옮겼다.
 *
 * `candidate_rank` 는 재생성 후보끼리 비교할 때 쓴다(찾은 프레임 수를 가장 크게
 * 치고 에러·경고로 깎는다). `correction_loop` 가 최선 후보를 고를 때의 기준이다.
 */
export function scoreInspection(report: InspectReport): ScoreReport {
  const histogramMin = report.thresholds.histogram_min;
  const dhashMin = report.thresholds.dhash_min;
  const rows: ScoreRow[] = [];
  const hints: string[] = [];

  for (const row of report.rows) {
    const expected = row.expected_frames;
    const found = row.found_frames;
    const errors = [...row.errors];
    const warnings = [...row.warnings];
    const metrics = row.metrics;
    let score = 100.0;
    if (found !== expected) score -= 35 + 10 * Math.abs(found - expected);
    score -= 13 * errors.length;
    score -= 3 * warnings.length;
    if ((metrics?.motion_presence ?? 1.0) < 0.01 && expected > 1) score -= 12;
    if ((metrics?.dhash_similarity.min ?? 1.0) < dhashMin) score -= 10;
    if (histogramMin > 0 && (metrics?.histogram_intersection.min ?? 1.0) < histogramMin) {
      score -= 10;
    }
    score = Math.max(0.0, Math.min(100.0, score));
    const rowHints = unique(hintsForRow(row, histogramMin, dhashMin));
    hints.push(...rowHints);
    rows.push({
      state: row.state,
      score: round2(score),
      candidate_rank: found * 100 - errors.length * 10 - warnings.length,
      expected_frames: expected,
      found_frames: found,
      errors,
      warnings,
      hints: rowHints,
    });
  }

  const scores = rows.map(r => r.score);
  return {
    ok: rows.length > 0 && rows.every(r => r.score >= 90 && r.errors.length === 0),
    kind: "sprite-gen-score-report",
    overall_score:
      scores.length > 0 ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0.0,
    candidate_rank: rows.reduce((a, r) => a + r.candidate_rank, 0),
    rows,
    hints: unique(hints),
  };
}
