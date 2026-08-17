/**
 * `state-name.ts` 의 동작→상태 추론과 프레임 대역 판정.
 *
 * 이 모듈은 정본 이식이 아니라 우리 패널을 위한 다리다(자유 텍스트 동작 하나 →
 * 정본 상태 어휘). 그래서 대조 상대는 정본 코드가 아니라 **정본 문서**다:
 * 상태별 프레임·루프는 `DEFAULT_STATES`(prepare.py 이식본)에서 그대로 읽어야 하고,
 * 대역 판정은 `docs/states-and-frames.md` 의 "Frame Count Guidance" 를 따라야 한다.
 *
 * 실행: npx tsx scripts/test-state-name.ts
 */
import { ACTION_STATE_HINTS, inferActionHint, frameBand } from "../src/lib/sprite/state-name";
import { DEFAULT_STATES } from "../src/lib/sprite/request";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

console.log("\n[1] 정본 상태는 DEFAULT_STATES 값을 그대로 쓴다 (진실을 둘로 두지 않는다)");
for (const state of ["idle", "attack", "jump", "wave"] as const) {
  const hint = ACTION_STATE_HINTS.find(h => h.state === state);
  const spec = DEFAULT_STATES[state];
  check(
    `${state}: frames=${spec.frames} loop=${spec.loop}`,
    hint !== undefined && hint.frames === spec.frames && hint.loop === spec.loop,
    hint ? `힌트 frames=${hint.frames} loop=${hint.loop}` : "힌트 없음",
  );
}

console.log("\n[2] 동작 텍스트 → 상태");
const cases: Array<[string, string | null]> = [
  ["대기 자세", "idle"],
  ["칼을 크게 휘두르는 공격", "attack"],
  ["점프해서 뛰어오르기", "jump"],
  ["손 흔들며 인사", "wave"],
  ["오른쪽으로 걷기", "walk"],
  ["전력으로 달리기", "run"],
  ["마법 시전", "magic_cast"],
  ["피격당해 움찔", "hurt"],
  // 정본에 death 상태가 없다 — 상태명을 지어내지 않고 null 이어야 한다.
  ["쓰러져 사망", null],
  ["요리하기", null],
];
for (const [text, expected] of cases) {
  const hint = inferActionHint(text);
  const got = hint?.state ?? null;
  check(`"${text}" → ${expected ?? "(상태명 없음)"}`, got === expected, `얻음 ${got ?? "null"}`);
}

console.log("\n[3] 정본에 없는 동작은 보수적 상한을 넘지 않는다");
for (const hint of ACTION_STATE_HINTS) {
  const canonicalState = hint.state !== null && hint.state in DEFAULT_STATES;
  if (canonicalState) continue;
  // 로코모션(walk/run)만 8 이 허용된다 — 정본이 "로코모션 행" 대역으로 열어 둔 값.
  const cap = hint.state === "walk" || hint.state === "run" ? 8 : 6;
  check(
    `${hint.state ?? "(무명)"}: frames=${hint.frames} <= ${cap}`,
    hint.frames <= cap,
    `상한 ${cap} 초과`,
  );
}

console.log("\n[4] 프레임 대역 — states-and-frames.md 의 Frame Count Guidance");
const bands: Array<[number, "stable" | "advanced" | "experimental"]> = [
  [4, "stable"],   // 단순 동작의 기본 안정 범위
  [5, "stable"],   // 대기 복귀 포즈가 필요한 비루프 제스처
  [6, "stable"],   // 인간형 one-shot 의 보수적 상한
  [8, "advanced"], // 로코모션 행·명시적 실험 (금지는 아님)
  [9, "experimental"],
  [12, "experimental"],
  [16, "experimental"], // 정본 대역에 아예 없는 값
];
for (const [frames, level] of bands) {
  const band = frameBand(frames);
  check(`${frames}프레임 → ${level}`, band.level === level, `얻음 ${band.level}`);
}
check("stable 은 안내 문구가 없다", frameBand(4).note === null);
check("advanced 는 안내 문구가 있다", typeof frameBand(8).note === "string");
check("experimental 은 안내 문구가 있다", typeof frameBand(12).note === "string");
// 9·12 와 16 은 위험도가 달라 문구도 달라야 한다 — 정본이 16 을 다루지 않는다는 사실이
// 사용자에게 전달되지 않으면 12 와 같은 것으로 읽힌다.
check("16 의 문구는 9·12 와 다르다", frameBand(16).note !== frameBand(12).note);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
