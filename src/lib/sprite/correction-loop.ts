// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `correction_loop.py` 이식 — 폐루프 교정의 **재생성** 단계.
// 원본: sprite-gen/sprite_gen/correction_loop.py (Apache-2.0)

/**
 * inspect → score → 힌트 → 재생성을 **횟수 제한을 두고** 돈다.
 *
 * 이 루프가 지키는 성질 둘:
 *
 *   1. **최선 후보를 잃지 않는다.** 재생성이 더 나빠질 수 있으므로 매 시도의 점수를
 *      비교해 가장 좋은 것을 따로 보존한다. 마지막 시도가 최선이라는 보장이 없다.
 *   2. **무한히 돌지 않는다.** `maxPasses` 로 상한을 두고, 통과해도 `minAttempts`
 *      전에는 멈추지 않는다(첫 판이 운 좋게 통과하는 것을 방지).
 *
 * 후보 비교는 `(candidate_rank, overall_score)` 사전식이다 — 원본이 파이썬 튜플
 * 비교로 쓴 것을 그대로 옮겼다. rank 가 먼저인 이유는 그것이 "프레임을 몇 장
 * 제대로 찾았나" 를 담기 때문이다: 점수가 조금 높아도 프레임이 모자란 후보를
 * 이기게 하면 안 된다.
 *
 * **우리 구조로의 이탈**: 원본은 run 디렉터리 위에서 돌고 재생성을 외부
 * `--provider-command` 로 위임한다(문자열 템플릿 + subprocess). 우리는 MCP 핸들러
 * 안에서 codex 를 직접 부르므로 그 자리를 콜백으로 바꿨다. 반복 제어·후보 선택·
 * 종료 조건은 원본 그대로다.
 */

import {
  inspectStates,
  type Frame,
  type InspectReport,
  type InspectThresholds,
  DEFAULT_INSPECT_THRESHOLDS,
} from "@/lib/sprite/inspect";
import { scoreInspection, type ScoreReport } from "@/lib/sprite/score";

export const DEFAULT_MAX_PASSES = 3;
export const DEFAULT_MIN_ATTEMPTS = 1;
export const DEFAULT_PASS_SCORE = 90.0;

/** 한 후보 = 상태별 추출 프레임. */
export type Candidate = Array<{ state: string; expected: number; frames: Frame[] }>;

export type AttemptRecord = {
  attempt: number;
  ok: boolean;
  overall_score: number;
  candidate_rank: number;
  inspect: InspectReport;
  score: ScoreReport;
};

export type CorrectionLoopResult = {
  ok: boolean;
  kind: "sprite-gen-correction-loop-report";
  dry_run: boolean;
  min_attempts: number;
  max_passes: number;
  attempts: AttemptRecord[];
  /** 최선 후보의 시도 번호. 마지막 시도가 아닐 수 있다. */
  best_attempt: number;
  best: AttemptRecord;
};

/**
 * 힌트를 받아 다시 만든 후보를 돌려준다. `null` 을 주면 재생성이 불가능하다는
 * 뜻이고, 루프는 거기서 멈춘다(원본은 provider 실패를 SystemExit 로 올린다 —
 * 우리 쪽은 호출자가 왜 멈췄는지 결과로 볼 수 있게 한다).
 */
export type RegenerateFn = (attempt: number, hints: string[]) => Promise<Candidate | null>;

export async function runCorrectionLoop(opts: {
  initial: Candidate;
  regenerate?: RegenerateFn;
  maxPasses?: number;
  minAttempts?: number;
  passScore?: number;
  thresholds?: InspectThresholds;
  /** 매 시도 직후 호출 — 리포트를 파일이나 로그로 남길 자리. */
  onAttempt?: (record: AttemptRecord) => void | Promise<void>;
}): Promise<CorrectionLoopResult> {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  const minAttempts = opts.minAttempts ?? DEFAULT_MIN_ATTEMPTS;
  const passScore = opts.passScore ?? DEFAULT_PASS_SCORE;
  const thresholds = opts.thresholds ?? DEFAULT_INSPECT_THRESHOLDS;
  if (maxPasses < 1) throw new Error("maxPasses 는 1 이상이어야 합니다");
  if (minAttempts < 1 || minAttempts > maxPasses) {
    throw new Error("minAttempts 는 1 이상 maxPasses 이하여야 합니다");
  }
  const dryRun = !opts.regenerate;

  const attempts: AttemptRecord[] = [];
  let best: AttemptRecord | null = null;
  let current: Candidate = opts.initial;

  for (let attempt = 1; attempt <= maxPasses; attempt++) {
    const inspect = inspectStates(current, thresholds);
    const score = scoreInspection(inspect);
    const record: AttemptRecord = {
      attempt,
      ok: score.ok,
      overall_score: score.overall_score,
      candidate_rank: score.candidate_rank,
      inspect,
      score,
    };
    attempts.push(record);
    await opts.onAttempt?.(record);

    // 사전식 비교: rank 가 먼저, 같으면 점수.
    if (
      best === null ||
      record.candidate_rank > best.candidate_rank ||
      (record.candidate_rank === best.candidate_rank && record.overall_score > best.overall_score)
    ) {
      best = record;
    }

    if (attempt >= minAttempts && score.ok && score.overall_score >= passScore) break;
    if (attempt === maxPasses) break;
    if (dryRun) break;

    const next = await (opts.regenerate as RegenerateFn)(attempt + 1, score.hints);
    if (next === null) break;
    current = next;
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: attempts.length > 0 && last.ok && last.overall_score >= passScore,
    kind: "sprite-gen-correction-loop-report",
    dry_run: dryRun,
    min_attempts: minAttempts,
    max_passes: maxPasses,
    attempts,
    best_attempt: (best as AttemptRecord).attempt,
    best: best as AttemptRecord,
  };
}

/** 힌트를 원본 `correction-hints.txt` 와 같은 형식으로 — 재생성 프롬프트에 얹는 몸통. */
export function formatHints(hints: string[]): string {
  const body =
    hints.length > 0
      ? hints.map(h => `- ${h}`).join("\n")
      : "- No correction hint; candidate passed.";
  return body + "\n";
}
