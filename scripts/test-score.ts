/**
 * score 이식 테스트 — 정본 `score_inspection` 과 **리포트 JSON 전체**를 대조한다.
 *
 * 점수 하나가 아니라 통째로 비교하는 이유: 힌트 문구는 그대로 다음 생성 프롬프트에
 * 얹히는 지시문이라 한 글자만 달라도 모델이 받는 지시가 달라지고, candidate_rank 는
 * correction_loop 가 후보를 고르는 기준이라 순위가 뒤집히면 다른 결과가 남는다.
 *
 * 사용법: pnpm tsx scripts/test-score.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { InspectReport } from "../src/lib/sprite/inspect";
import { scoreInspection } from "../src/lib/sprite/score";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const CANON = "/Users/wonpyoung/Developer/workspace/sprite-gen";

function mk(rows: Array<Partial<{ state: string; expected: number; found: number; errs: string[]; warns: string[]; hist: number; dh: number; motion: number }>>, thresholds = { histogram_min: 0.0, dhash_min: 0.55, motion_min: 0.01 }): InspectReport {
  return {
    ok: true, engine: "component-row", kind: "sprite-gen-inspect-report",
    states: rows.map(r => r.state ?? "s"), thresholds,
    rows: rows.map(r => ({
      state: r.state ?? "s", source: "frames" as const,
      expected_frames: r.expected ?? 4, found_frames: r.found ?? 4,
      metrics: { histogram_intersection: { min: r.hist ?? 1, mean: r.hist ?? 1 },
                 dhash_similarity: { min: r.dh ?? 1, mean: r.dh ?? 1 },
                 motion_presence: r.motion ?? 0.5, centroid_sigma: { x: 0, y: 0 } },
      ok: (r.errs ?? []).length === 0, errors: r.errs ?? [], warnings: r.warns ?? [],
    })),
    errors: rows.flatMap(r => r.errs ?? []), warnings: rows.flatMap(r => r.warns ?? []),
  };
}

const cases: Array<[string, InspectReport]> = [
  ["완전 통과", mk([{ state: "down_idle" }])],
  ["프레임 수 불일치", mk([{ state: "down_idle", expected: 4, found: 3, errs: ["down_idle: expected 4 frame(s), inspect found 3"] }])],
  ["실루엣 드리프트", mk([{ state: "down_attack", dh: 0.4, warns: ["down_attack: dHash silhouette similarity is low (0.400 < 0.550)"] }])],
  ["정지 화면", mk([{ state: "down_idle", motion: 0.001, warns: ["down_idle: motion presence is too low (0.0010 < 0.0100)"] }])],
  ["히스토그램 임계 켬", mk([{ state: "down_idle", hist: 0.5 }], { histogram_min: 0.8, dhash_min: 0.55, motion_min: 0.01 })],
  ["크로마 잔류 힌트", mk([{ state: "s", warns: ["s: chroma-adjacent pixels remain"] }])],
  ["엣지 힌트", mk([{ state: "s", warns: ["s: content touches edge"] }])],
  ["격자 힌트", mk([{ state: "s", warns: ["s: pitch unstable"] }])],
  ["여러 행 평균", mk([{ state: "a" }, { state: "b", found: 3, expected: 4, errs: ["e"] }, { state: "c", dh: 0.2 }])],
  ["빈 리포트", mk([])],
];

let pass = 0, fail = 0;
if (!existsSync(PY)) {
  console.log("  FAIL 정본 대조 미실행 — 파이썬 venv 없음");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}
for (const [name, report] of cases) {
  const ours = scoreInspection(report);
  const out = execFileSync(PY, ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(CANON)})
from sprite_gen.score import score_inspection
print(json.dumps(score_inspection(json.loads(sys.stdin.read()))))
`], { encoding: "utf8", input: JSON.stringify(report) });
  const ref = JSON.parse(out) as Record<string, unknown>;
  delete ref.source_report;
  const oursNorm = JSON.parse(JSON.stringify(ours)) as Record<string, unknown>;
  const same = JSON.stringify(oursNorm) === JSON.stringify(ref);
  if (same) { pass++; console.log(`  OK   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`    ours=${JSON.stringify(oursNorm).slice(0, 240)}`);
    console.log(`    ref =${JSON.stringify(ref).slice(0, 240)}`);
  }
}
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
