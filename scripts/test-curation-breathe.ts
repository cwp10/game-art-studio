/**
 * `stateBreathe` 정규화가 정본 `curation.state_breathe` 와 같은 값·같은 거부를 내는지.
 *
 * 이 모듈의 계약은 "조용히 고치지 않는다" 하나라서, 통과 케이스보다 **거부 케이스가
 * 본체다**. 정본이 실사고로 얻은 규칙(범위 밖·비정수·폐기 키를 깎지 않고 멈춘다)이
 * 이식 과정에서 완화되면 프리뷰와 굽기가 갈린다.
 *
 * 실행: npx tsx scripts/test-curation-breathe.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stateBreathe, CurationBreatheInvalid } from "../src/lib/sprite/curation-breathe";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

if (!existsSync(PY)) {
  console.log("  FAIL 파이썬 venv 없음 — 정본 대조를 못 했습니다");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

/** 정본을 그대로 돌려 결과 또는 SystemExit 메시지를 받는다. */
function canonical(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const out = execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, "/Users/wonpyoung/Developer/workspace/sprite-gen")
from sprite_gen.curation import state_breathe
raw = json.loads(sys.stdin.read())
try:
    print(json.dumps({"ok": True, "value": state_breathe({"states": {"idle": {"breathe": raw}}}, "idle")}))
except SystemExit as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`], { encoding: "utf8", input: JSON.stringify(raw) });
  return JSON.parse(out);
}

/** 우리 구현 — 정본과 같은 모양으로 감싼다. */
function ours(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: stateBreathe({ breathe: raw }, "idle") };
  } catch (e) {
    if (e instanceof CurationBreatheInvalid) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * `exact` 가 false 면 거부 여부와 첫 줄만 본다. 폐기 키 안내는 정본이 자기
 * CLI(`sprite-gen migrate-breathe`)를 안내하는데 우리에겐 그 명령이 없어서 마지막
 * 줄이 정당하게 다르다 — 거부한다는 사실과 어느 키가 걸렸는지가 계약이다.
 */
function compare(label: string, raw: unknown, exact = true): void {
  const c = canonical(raw);
  const o = ours(raw);
  if (c.ok !== o.ok) {
    check(label, false, `정본 ${c.ok ? "통과" : "거부"} vs 우리 ${o.ok ? "통과" : "거부"}: ${
      c.ok ? JSON.stringify(c.value) : c.error} / ${o.ok ? JSON.stringify(o.value) : o.error}`);
    return;
  }
  if (c.ok && o.ok) {
    const same = JSON.stringify(c.value) === JSON.stringify(o.value);
    check(label, same, `${JSON.stringify(o.value)} vs ${JSON.stringify(c.value)}`);
    return;
  }
  const cErr = (c as { error: string }).error;
  const oErr = (o as { error: string }).error;
  const same = exact ? cErr === oErr : cErr.split("\n")[0] === oErr.split("\n")[0];
  check(label, same, `\n    우리: ${oErr}\n    정본: ${cErr}`);
}

console.log("=== 없거나 비어 있는 사이드카 ===");
// 키 부재는 JSON 으로 못 실어보낸다. 정본은 `entry.get("breathe")` 가 None 이 되어
// null 과 같은 경로를 타므로, 아래 null 케이스가 정본 대조를 겸한다.
check("breathe 키 자체가 없으면 null", stateBreathe({}, "idle") === null);
check("entry 가 null 이면 null", stateBreathe(null, "idle") === null);
compare("breathe 가 null", null);
compare("breathe 가 dict 가 아니다 (숫자)", 3);
compare("breathe 가 dict 가 아니다 (리스트)", [1, 2]);
compare("빈 dict 는 기본값", {});

console.log("\n=== 정상 값 ===");
compare("depth/breaths/lag 명시", { depth: 0.08, breaths: 3, lag: 0.2 });
compare("숫자 문자열도 실수로 읽는다", { depth: "0.08", lag: "0.2" });
compare("depth_x = 0 (가로만 끄기)", { depth_x: 0 });
compare("depth_x = null (depth 따름)", { depth_x: null });
compare("depth_x 값", { depth_x: 0.03 });
compare("경계값 하한", { depth: 0.005, breaths: 1, lag: 0.0 });
compare("경계값 상한", { depth: 0.2, breaths: 8, lag: 0.45 });
compare("rigid_row/axis_x/torso_half 정수", { rigid_row: 33, axis_x: 12, torso_half: 9 });
compare("anatomy 캐시 dict 는 그대로 실린다", { anatomy: { rigid_row: 23, width: 64 } });
compare("anatomy 가 dict 가 아니면 null", { anatomy: 5 });

console.log("\n=== 범위 밖은 조용히 깎지 않는다 ===");
compare("depth 상한 초과", { depth: 0.5 });
compare("depth 하한 미만", { depth: 0.001 });
compare("breaths 상한 초과 (12 를 8 로 깎지 않는다)", { breaths: 12 });
compare("breaths 0", { breaths: 0 });
compare("lag 상한 초과", { lag: 1.0 });
compare("lag 음수", { lag: -0.1 });
compare("depth_x 상한 초과", { depth_x: 0.5 });
compare("depth_x 음수", { depth_x: -0.01 });

console.log("\n=== 정수가 아니면 거부한다 ===");
compare("breaths 2.7", { breaths: 2.7 });
compare('breaths "3.5"', { breaths: "3.5" });
compare("rigid_row 2.5", { rigid_row: 2.5 });
compare("axis_x 1.5", { axis_x: 1.5 });
compare("torso_half 0.5", { torso_half: 0.5 });
compare('breaths "4" 는 통과 (정수 문자열)', { breaths: "4" });

console.log("\n=== 형식 오류도 조용히 넘기지 않는다 ===");
compare("depth 가 숫자가 아니다", { depth: "abc" });
compare("depth 가 null", { depth: null });
compare("lag 가 리스트", { lag: [1] });
compare("breaths 가 숫자가 아니다", { breaths: "abc" });

console.log("\n=== 폐기된 분할선 스키마 키 ===");
compare("splits", { splits: [10] }, false);
compare("amplitude", { amplitude: 2 }, false);
compare("subpixel", { subpixel: true }, false);
compare("hold", { hold: 2 }, false);
compare("여러 개는 정렬해서 함께 보고", { hold: 2, amplitude: 2, splits: [1] }, false);

console.log("\n=== 폐기 키 안내에 실제 키 이름이 실린다 ===");
{
  const o = ours({ hold: 2, splits: [1] });
  const msg = o.ok ? "" : o.error;
  check("어느 키가 걸렸는지 보인다", msg.includes("hold") && msg.includes("splits"), msg);
  check("왜 폐기됐는지 보인다", msg.includes("봉투 경계로 대체됐다"), msg);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
