/**
 * `gait-order.ts` — 비전 판정 응답의 계약.
 *
 * 이 모듈은 정본 이식이 아니라 우리가 추가한 도구다. 그래서 대조 상대는 정본 코드가
 * 아니라 **정본이 그은 선**이다: 자동 프레임 순서 선택을 약속하지 말 것, 모션 실패는
 * 재타이밍이 아니라 행 재생성으로 고칠 것. 그 선을 지키는 장치가 `regenerate` 판정이고,
 * 여기 테스트는 그것이 조용히 순서 제안으로 둔갑하지 않는지를 본다.
 *
 * 실행: npx tsx scripts/test-gait-order.ts
 */
import {
  parseGaitOrder,
  isNoOpSuggestion,
  gaitOrderPrompt,
  GaitOrderInvalid,
} from "../src/lib/sprite/gait-order";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}
function rejects(label: string, raw: string, frameCount: number, expect: string): void {
  try {
    parseGaitOrder(raw, frameCount);
    check(label, false, "거부하지 않았다");
  } catch (e) {
    const msg = String(e);
    check(label, e instanceof GaitOrderInvalid && msg.includes(expect), msg);
  }
}

console.log("\n[1] 정상 판정");
{
  const s = parseGaitOrder('{"verdict":"reorder","order":[1,3,5,7,2,4,6,8],"drop":[],"reason":"좌우 교대가 격간으로 놓여 있습니다"}', 8);
  check("verdict", s.verdict === "reorder");
  check("order 가 0-based 로 낮춰진다", JSON.stringify(s.order) === "[0,2,4,6,1,3,5,7]", JSON.stringify(s.order));
  check("drop 은 빈 배열", s.drop.length === 0);
  check("reason 이 실린다", s.reason.includes("좌우 교대"));
}
{
  const s = parseGaitOrder('{"verdict":"drop-then-reorder","order":[1,2,3],"drop":[4],"reason":"4번은 3번과 거의 같은 그림입니다"}', 4);
  check("drop-then-reorder", s.verdict === "drop-then-reorder");
  check("drop 도 0-based", JSON.stringify(s.drop) === "[3]", JSON.stringify(s.drop));
}

console.log("\n[2] regenerate — 정본이 그은 선");
{
  // 모델이 관성으로 순서를 채워 보내도 버려야 한다. 남기면 UI 가 "이대로 바꾸면 된다" 로 읽힌다.
  const s = parseGaitOrder('{"verdict":"regenerate","order":[1,2,3,4],"drop":[],"reason":"모든 프레임에서 같은 다리가 앞입니다"}', 4);
  check("regenerate 는 order 를 버린다", s.order.length === 0, JSON.stringify(s.order));
  check("regenerate 는 drop 도 버린다", s.drop.length === 0);
  check("근거는 남는다", s.reason.includes("같은 다리"));
}

console.log("\n[3] 응답 형태를 견딘다");
{
  const s = parseGaitOrder('```json\n{"verdict":"reorder","order":[2,1],"drop":[],"reason":"뒤집혀 있습니다"}\n```', 2);
  check("코드펜스", JSON.stringify(s.order) === "[1,0]");
}
{
  const s = parseGaitOrder('판정 결과입니다.\n{"verdict":"reorder","order":[2,1],"drop":[],"reason":"뒤집혀 있습니다"}\n이상입니다.', 2);
  check("앞뒤 군더더기 문장", JSON.stringify(s.order) === "[1,0]");
}

console.log("\n[4] 조용히 고치지 않고 거부한다");
rejects("JSON 이 아예 없음", "재배열하면 됩니다", 4, "찾을 수 없습니다");
rejects("알 수 없는 판정", '{"verdict":"maybe","order":[1],"drop":[],"reason":"음"}', 1, "알 수 없는 판정");
rejects("근거 없음", '{"verdict":"reorder","order":[1,2],"drop":[],"reason":""}', 2, "reason 이 비었습니다");
rejects("범위 밖 번호", '{"verdict":"reorder","order":[1,2,9],"drop":[],"reason":"ㅇ"}', 3, "범위를 벗어납니다");
rejects("0 번(1-based 위반)", '{"verdict":"reorder","order":[0,1],"drop":[],"reason":"ㅇ"}', 2, "범위를 벗어납니다");
rejects("중복 번호", '{"verdict":"reorder","order":[1,1,2],"drop":[],"reason":"ㅇ"}', 3, "두 번 나옵니다");
rejects("order 와 drop 에 동시 등장", '{"verdict":"drop-then-reorder","order":[1,2],"drop":[2],"reason":"ㅇ"}', 2, "동시에");
rejects("reorder 인데 drop 이 있다", '{"verdict":"reorder","order":[1],"drop":[2],"reason":"ㅇ"}', 2, "'drop-then-reorder' 여야");
rejects("drop-then-reorder 인데 drop 이 없다", '{"verdict":"drop-then-reorder","order":[1,2],"drop":[],"reason":"ㅇ"}', 2, "drop 이 비었습니다");
// 언급되지 않은 프레임이 있으면 사람이 그것을 어떻게 할지 정한 적이 없다.
rejects("빠진 프레임", '{"verdict":"reorder","order":[1,2],"drop":[],"reason":"ㅇ"}', 4, "언급되지 않은");
rejects("정수 아닌 번호", '{"verdict":"reorder","order":[1.5,2],"drop":[],"reason":"ㅇ"}', 2, "정수가 아닌");
rejects("order 가 배열이 아님", '{"verdict":"reorder","order":"1,2","drop":[],"reason":"ㅇ"}', 2, "배열이 아닙니다");
rejects("판정이 reorder 인데 order 가 빔", '{"verdict":"reorder","order":[],"drop":[],"reason":"ㅇ"}', 2, "order 가 비었습니다");

console.log("\n[5] 현재 순서와 같은 제안은 채택할 것이 없다");
{
  const same = parseGaitOrder('{"verdict":"reorder","order":[1,2,3,4],"drop":[],"reason":"이미 맞습니다"}', 4);
  check("항등 제안을 알아본다", isNoOpSuggestion(same, 4));
  const moved = parseGaitOrder('{"verdict":"reorder","order":[2,1,3,4],"drop":[],"reason":"두 칸 뒤집힘"}', 4);
  check("바뀐 제안은 항등이 아니다", !isNoOpSuggestion(moved, 4));
  const regen = parseGaitOrder('{"verdict":"regenerate","order":[],"drop":[],"reason":"교대 없음"}', 4);
  check("regenerate 는 항등이 아니다", !isNoOpSuggestion(regen, 4));
}

console.log("\n[6] 지시문이 세 판정을 다 말한다");
{
  const p = gaitOrderPrompt("down45_running-front-right", 8);
  check("행 이름이 들어간다", p.includes("down45_running-front-right"));
  check("프레임 수가 들어간다", p.includes("8"));
  for (const v of ["reorder", "drop-then-reorder", "regenerate"]) {
    check(`판정 '${v}' 를 설명한다`, p.includes(v));
  }
  // 이 문장이 빠지면 모델이 고칠 수 없는 행에도 순서를 지어낸다.
  check("지어내지 말라고 못박는다", p.includes("Do NOT invent"));
  check("1-based 라고 못박는다", p.includes("1-based"));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
