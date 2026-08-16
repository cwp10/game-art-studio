/**
 * `reroll.ts` 가 정본 `reroll.py` 와 같은 라벨·같은 기록 계약을 지키는지.
 *
 * 정본의 테이크는 파일 사이드카이고 우리 것은 후보 generation 목록이라 저장 형태가
 * 다르다. 그래서 대조는 **라벨 규칙**(정본과 글자까지 같아야 하는 부분)에 집중하고,
 * 기록 계약(멱등·원본 보존·못 찾으면 던지기)은 우리 쪽 계약으로 고정한다.
 *
 * 실행: npx tsx scripts/test-reroll.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  nextRerollLabel,
  assertSafeTakeLabel,
  recordTake,
  ensurePrimaryTake,
  pickTake,
  RerollFailed,
  type RowTake,
} from "../src/lib/sprite/reroll";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";

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

console.log("=== nextRerollLabel: 정본과 같은 라벨 ===");
{
  // 각 케이스는 정본 request 의 takes 목록(라벨만)이다.
  const cases: Array<Array<string | null>> = [
    [],                                       // 처음
    ["reroll1"],                              // 이어서
    ["reroll1", "reroll2"],                   // 연속
    ["reroll2"],                              // 결번 → 1 을 채운다
    ["reroll1", "reroll3"],                   // 중간 결번
    ["reroll1", "reroll2", "reroll3"],
    ["tween_1_2_t0p5"],                       // 리롤이 아닌 라벨은 안 센다
    ["reroll1", "tween_0_1_t0p25", "reroll2"],
    ["reroll10"],                             // 두 자리
    ["reroll01"],                             // 앞자리 0 — 정본 정규식은 \d+ 라 1 로 읽는다
    ["rerollX"],                              // 숫자가 아니면 무시
    ["reroll1x"],                             // fullmatch 라 부분일치 아님
    [null],                                   // 라벨 없는 항목
    ["", "reroll1"],
  ];
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.reroll import next_reroll_label
cases = json.loads(sys.stdin.read())
out = []
for labels in cases:
    req = {"states": {"s": {"takes": [{"label": l} for l in labels]}}}
    out.append(next_reroll_label(req, "s"))
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify(cases) })) as string[];

  cases.forEach((labels, i) => {
    const ours = nextRerollLabel(labels.map(l => ({ label: l })));
    check(`takes=${JSON.stringify(labels)} → ${refs[i]}`, ours === refs[i], `${ours} vs ${refs[i]}`);
  });

  // takes 키 자체가 없는 경우 (정본은 .get("takes") or [])
  const noneRef = execFileSync(PY, ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.reroll import next_reroll_label
print(next_reroll_label({"states": {"s": {}}}, "s"))
`], { encoding: "utf8" }).trim();
  check("takes 키가 없으면 reroll1", nextRerollLabel(undefined) === noneRef && nextRerollLabel(null) === noneRef,
    `${nextRerollLabel(undefined)} vs ${noneRef}`);
}

console.log("\n=== 라벨 안전성 (정본과 같은 거부) ===");
{
  let threw = "";
  try { assertSafeTakeLabel("a/b"); } catch (e) { threw = (e as Error).message; }
  check("슬래시는 거부", threw.includes("filesystem-safe"), threw);
  threw = "";
  try { assertSafeTakeLabel(".hidden"); } catch (e) { threw = (e as Error).message; }
  check("점으로 시작하면 거부", threw.includes("filesystem-safe"), threw);
  let ok = true;
  try { assertSafeTakeLabel("reroll3"); } catch { ok = false; }
  check("정상 라벨은 통과", ok);
}

console.log("\n=== 기록 계약 ===");
{
  const a: RowTake = { label: "primary", generationId: "g0", frames: 4 };
  const b: RowTake = { label: "reroll1", generationId: "g1", frames: 4 };
  const list = recordTake(recordTake([], a), b);
  check("순서대로 쌓인다", JSON.stringify(list.map(t => t.label)) === '["primary","reroll1"]');

  const again = recordTake(list, { label: "reroll1", generationId: "g2", frames: 6 });
  check("같은 라벨은 덮어쓴다 (멱등)",
    again.length === 2 && again[1].generationId === "g2" && again[1].frames === 6,
    JSON.stringify(again));
  check("원본 배열은 건드리지 않는다", list[1].generationId === "g1");

  // 첫 리롤에서 현재 행이 후보로 등재돼야 되돌릴 수 있다.
  const seeded = ensurePrimaryTake([], "gCur", 4);
  check("빈 목록이면 현재 행을 primary 로 넣는다",
    seeded.length === 1 && seeded[0].label === "primary" && seeded[0].generationId === "gCur");
  const noDup = ensurePrimaryTake(seeded, "gCur", 4);
  check("이미 있으면 중복으로 넣지 않는다", noDup.length === 1);
  const front = ensurePrimaryTake([b], "gCur", 4);
  check("맨 앞에 넣는다 (원본이 먼저)", front[0].generationId === "gCur" && front[1].label === "reroll1");
}

console.log("\n=== 후보 고르기 ===");
{
  const takes: RowTake[] = [
    { label: "primary", generationId: "g0", frames: 4 },
    { label: "reroll1", generationId: "g1", frames: 4 },
  ];
  check("라벨로 찾는다", pickTake(takes, "reroll1").generationId === "g1");
  let threw = "";
  try { pickTake(takes, "reroll9"); } catch (e) { threw = e instanceof RerollFailed ? e.message : String(e); }
  check("없으면 던진다 (조용히 현재 행 유지 안 함)",
    threw.includes("reroll9") && threw.includes("primary, reroll1"), threw);
  threw = "";
  try { pickTake([], "x"); } catch (e) { threw = (e as Error).message; }
  check("빈 목록에서도 사유가 보인다", threw.includes("(없음)"), threw);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
