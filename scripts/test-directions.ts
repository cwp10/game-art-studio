/**
 * Phase 3A 결정적 방향 검증 — codex 미사용 순수 함수 단위 테스트.
 *
 *   pnpm tsx scripts/test-directions.ts
 *
 * spritesheet-classify 의 directionLabels / buildDirectionPrompt / Directions 를
 * 직접 import 해 방향 라벨 순서(2/4/8)·행 라인·framesPerDir 반영·단일방향 빈문자열을 단언.
 * 라벨 순서(확정): 2=LEFT/RIGHT, 4=DOWN/LEFT/RIGHT/UP,
 *   8=시계방향(DOWN, DOWN-LEFT, LEFT, UP-LEFT, UP, UP-RIGHT, RIGHT, DOWN-RIGHT).
 */
import {
  directionLabels,
  buildDirectionPrompt,
  isLocomotion,
  buildGaitPrompt,
  type Directions,
} from "../src/lib/mcp/spritesheet-classify";

let passCount = 0;
let failCount = 0;

function check(label: string, cond: boolean) {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${label}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${label}`);
  }
}

function eqArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

console.log("── directionLabels: 순서·길이 정확성 ──");
check("directionLabels(1) = [] (단일 방향, 라벨 없음)", eqArr(directionLabels(1), []));
check("directionLabels(2) = [LEFT, RIGHT]", eqArr(directionLabels(2), ["LEFT", "RIGHT"]));
check(
  "directionLabels(4) = [DOWN.., LEFT, RIGHT, UP..]",
  eqArr(directionLabels(4), [
    "DOWN (toward viewer)",
    "LEFT",
    "RIGHT",
    "UP (away from viewer)",
  ]),
);
check(
  "directionLabels(8) = 시계방향 8개 정확",
  eqArr(directionLabels(8), [
    "DOWN (toward viewer)",
    "DOWN-LEFT",
    "LEFT",
    "UP-LEFT",
    "UP (away from viewer)",
    "UP-RIGHT",
    "RIGHT",
    "DOWN-RIGHT",
  ]),
);
// 길이 단언(행 수 = 방향 수)
check("len(2)=2 / len(4)=4 / len(8)=8", directionLabels(2).length === 2 && directionLabels(4).length === 4 && directionLabels(8).length === 8);

console.log("── buildDirectionPrompt(4, 6): 핵심 문구·행 라인·framesPerDir ──");
const p46 = buildDirectionPrompt(4, 6);
check('"DIRECTIONAL sheet" 문구 포함', p46.includes("DIRECTIONAL sheet"));
check('framesPerDir=6 반영 ("6-frame action cycle")', p46.includes("6-frame action cycle"));
check('Row 1 (top) facing DOWN 라인', p46.includes("Row 1 (top): character facing DOWN (toward viewer)."));
check('Row 2 facing LEFT 라인 (no "(top)")', p46.includes("Row 2: character facing LEFT.") && !p46.includes("Row 2 (top)"));
check('Row 3 facing RIGHT 라인', p46.includes("Row 3: character facing RIGHT."));
check('Row 4 facing UP 라인', p46.includes("Row 4: character facing UP (away from viewer)."));
check('"only the viewing angle differs" 일관성 문구', p46.includes("only the viewing angle differs"));
// 행 라인이 정확히 4개(방향 수와 일치)인지 — "Row " 토큰 카운트
{
  const rowCount = (p46.match(/Row \d+/g) ?? []).length;
  check(`Row 라인 정확히 4개 (got ${rowCount})`, rowCount === 4);
}

console.log("── buildDirectionPrompt(1, n) = '' (단일 방향) ──");
check("buildDirectionPrompt(1, 6) === ''", buildDirectionPrompt(1, 6) === "");
check("buildDirectionPrompt(1, 1) === ''", buildDirectionPrompt(1, 1) === "");

console.log("── 경계: n=2 / n=8 행 수·라벨 일치 ──");
{
  const p2 = buildDirectionPrompt(2, 8);
  const rowCount2 = (p2.match(/Row \d+/g) ?? []).length;
  check(`n=2: Row 라인 2개 (got ${rowCount2})`, rowCount2 === 2);
  check("n=2: Row 1 (top) LEFT", p2.includes("Row 1 (top): character facing LEFT."));
  check("n=2: Row 2 RIGHT", p2.includes("Row 2: character facing RIGHT."));
  check("n=2: framesPerDir=8 반영", p2.includes("8-frame action cycle"));
}
{
  const p8 = buildDirectionPrompt(8, 4);
  const rowCount8 = (p8.match(/Row \d+/g) ?? []).length;
  check(`n=8: Row 라인 8개 (got ${rowCount8})`, rowCount8 === 8);
  // 시계방향 순서 — Row 인덱스별 라벨 정확
  const labels8 = directionLabels(8);
  const allRowsOk = labels8.every((lbl, i) => {
    const prefix = i === 0 ? `Row 1 (top): character facing ${lbl}.` : `Row ${i + 1}: character facing ${lbl}.`;
    return p8.includes(prefix);
  });
  check("n=8: 8개 행 라인이 시계방향 라벨 순서대로 정확", allRowsOk);
  check("n=8: framesPerDir=4 반영", p8.includes("4-frame action cycle"));
}

console.log("── isLocomotion: 보행 키워드 감지 ──");
check('"기사 걷기" → true', isLocomotion("기사 걷기"));
check('"warrior walk cycle" → true', isLocomotion("warrior walk cycle"));
check('"좀비 달리기" → true', isLocomotion("좀비 달리기"));
check('"running soldier" → true', isLocomotion("running soldier"));
check('"마법사 공격" → false (보행 아님)', !isLocomotion("마법사 공격"));
check('"idle 대기" → false', !isLocomotion("idle 대기"));

console.log("── buildGaitPrompt: 프레임수 인지 + scissor + 행 일관성 ──");
{
  const g6 = buildGaitPrompt(6, true);
  check('gait(6): "WALK/RUN GAIT" 헤더', g6.includes("WALK/RUN GAIT"));
  check('gait(6): "ONE full walk cycle"', g6.includes("ONE full walk cycle"));
  check('gait(6): N=6 반영 ("these 6 frames")', g6.includes("these 6 frames"));
  // contact mirror 프레임 = floor(6/2)+1 = 4
  check('gait(6): mid-cycle contact = F4 (mirror of F1)', g6.includes("F4 CONTACT (mirror of F1)"));
  check('gait(6): F1 contact 명시', g6.includes("F1 CONTACT"));
  check('gait(6): SCISSOR 측면 지시', g6.includes("SCISSOR"));
  check('gait(6): near-duplicate 금지 강제', g6.includes("near-duplicate"));
  check('gait(6): WIDE stride 강제', g6.includes("WIDE apart"));
  check('gait(6): directions=true → 행 일관성 문구', g6.includes("Every row uses this SAME 6-frame per-frame leg choreography"));
}
{
  const g8 = buildGaitPrompt(8, false);
  check('gait(8): N=8 반영', g8.includes("these 8 frames"));
  // contact mirror = floor(8/2)+1 = 5
  check('gait(8): mid-cycle contact = F5 (mirror of F1)', g8.includes("F5 CONTACT (mirror of F1)"));
  check('gait(8): directions=false → 행 일관성 문구 없음', !g8.includes("Every row uses this SAME"));
}
{
  const g4 = buildGaitPrompt(4, true);
  // contact mirror = floor(4/2)+1 = 3
  check('gait(4): mid-cycle contact = F3 (mirror of F1)', g4.includes("F3 CONTACT (mirror of F1)"));
}

console.log("── Directions 타입 가드(컴파일 단언): 1|2|4|8 만 허용 ──");
{
  // 타입 레벨 단언 — 런타임 no-op. tsc --noEmit 가 이 할당을 검증.
  const valid: Directions[] = [1, 2, 4, 8];
  check(`Directions 유효값 4종 ([${valid.join(",")}])`, valid.length === 4);
}

console.log(
  `\n방향 테스트: ${passCount} PASS / ${failCount} FAIL (총 ${passCount + failCount})`,
);
process.exit(failCount === 0 ? 0 : 1);
