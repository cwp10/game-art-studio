/**
 * ② Task 1 — SpriteRequest 정규화 테스트.
 * 기하 케이스는 sprite-gen `normalize_cell()` 의 동작을 그대로 대조한다.
 */
import {
  normalizeCell,
  normalizeStates,
  classifyState,
  frameCountAdvice,
  isLocomotionState,
  DEFAULT_SAFE_MARGIN_RATIO,
} from "../src/lib/sprite/request";
import { inferActionHint } from "../src/lib/sprite/state-name";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log("=== normalizeCell — 비례 margin ===");
{
  const c = normalizeCell({});
  check("기본 셀은 정사각 256", c.width === 256 && c.height === 256 && c.shape === "square");
  check("256 의 9.4% 내림 = 24", c.safeMarginX === 24 && c.safeMarginY === 24, `got ${c.safeMarginX}`);
}
{
  const c = normalizeCell({ size: 128 });
  check("128 → margin 12", c.safeMarginX === 12 && c.safeMarginY === 12, `got ${c.safeMarginX}`);
}
{
  // 192*0.094 = 18.048 → 18, 208*0.094 = 19.552 → 19. 축마다 따로 계산된다.
  const c = normalizeCell({ width: 192, height: 208 });
  check("rect 192x208 → shape rect", c.shape === "rect");
  check(
    "rect margin 18/19 (축별 내림)",
    c.safeMarginX === 18 && c.safeMarginY === 19,
    `got ${c.safeMarginX}/${c.safeMarginY}`,
  );
}
{
  const c = normalizeCell({ size: 256 }, 256, 40);
  check("명시 margin 은 절대값으로 비례를 이긴다", c.safeMarginX === 40 && c.safeMarginY === 40);
}
{
  const c = normalizeCell({ safe_margin_x: 10, safe_margin_y: 30 });
  check("축별 명시 margin", c.safeMarginX === 10 && c.safeMarginY === 30);
}
{
  const c = normalizeCell({ safe_margin: 0 });
  check("margin 0 은 유효하다 (falsy 여도 명시값)", c.safeMarginX === 0 && c.safeMarginY === 0);
}
check("비례 상수는 0.094", DEFAULT_SAFE_MARGIN_RATIO === 0.094);

console.log("=== normalizeCell — 검증 실패 ===");
check("width 0 은 거부", throws(() => normalizeCell({ width: 0, height: 10 })));
check("음수 margin 은 거부", throws(() => normalizeCell({ size: 256 }, 256, -1)));
check("margin*2 >= width 는 거부", throws(() => normalizeCell({ size: 100 }, 100, 50)));
check("margin*2 < width 는 통과", !throws(() => normalizeCell({ size: 100 }, 100, 49)));

console.log("=== normalizeStates ===");
{
  const s = normalizeStates(null);
  check("raw 없으면 DEFAULT_STATES 4종", Object.keys(s).length === 4);
  check("idle 4f/4fps/loop", s.idle.frames === 4 && s.idle.fps === 4 && s.idle.loop === true);
  check(
    "attack 4f/8fps/non-loop",
    s.attack.frames === 4 && s.attack.fps === 8 && s.attack.loop === false,
  );
  check("jump 4f/8fps/non-loop", s.jump.frames === 4 && s.jump.fps === 8 && s.jump.loop === false);
  check("wave 4f/6fps/non-loop", s.wave.frames === 4 && s.wave.fps === 6 && s.wave.loop === false);
}
{
  // 원본 그대로: loop 폴백은 무조건 true (prepare.py:509). DEFAULT_STATES 의
  // attack.loop=false 와 어긋나 보이지만 loop 은 UX 가 항상 명시로 넘긴다.
  const s = normalizeStates({ attack: { frames: 4 } });
  check("loop 폴백은 원본과 같이 true", s.attack.loop === true);
  check("fps 생략 시 DEFAULT_STATES (attack → 8)", s.attack.fps === 8);
  check("action 생략 시 DEFAULT_STATES", s.attack.action.includes("windup"));
}
{
  const s = normalizeStates({ dodge: { frames: 5 } });
  check("미지 상태의 fps 폴백은 6", s.dodge.fps === 6);
  check("미지 상태의 action 폴백은 상태명", s.dodge.action === "dodge");
  check("미지 상태의 loop 폴백은 true", s.dodge.loop === true);
}
check("frames 0 은 거부", throws(() => normalizeStates({ idle: { frames: 0 } })));
check("frames 음수는 거부", throws(() => normalizeStates({ idle: { frames: -2 } })));
{
  const s = normalizeStates({ idle: { frames: 6, loop: false } });
  check("명시값이 기본값을 이긴다", s.idle.frames === 6 && s.idle.loop === false);
}

console.log("=== classifyState (states-and-frames.md) ===");
check("idle 은 simple", classifyState("idle") === "simple");
check("attack 은 simple", classifyState("attack") === "simple");
check("jump 은 simple", classifyState("jump") === "simple");
check("wave 는 simple", classifyState("wave") === "simple");
check("magic_cast 는 simple 후보", classifyState("magic_cast") === "simple-candidate");
check("hurt 는 simple 후보", classifyState("hurt") === "simple-candidate");
check("walk 는 experimental", classifyState("walk") === "experimental");
check("run 은 experimental", classifyState("run") === "experimental");
check("frontwalk 는 experimental", classifyState("frontwalk") === "experimental");
check("45_frontwalk 는 experimental", classifyState("45_frontwalk") === "experimental");
check("running-front-right 는 experimental", classifyState("running-front-right") === "experimental");
check("walking-back-left 는 experimental", classifyState("walking-back-left") === "experimental");
check("모르는 상태는 unknown", classifyState("zzz_custom") === "unknown");

console.log("=== frameCountAdvice ===");
check("4 는 default", frameCountAdvice(4).band === "default");
check("5 는 return-to-idle", frameCountAdvice(5).band === "return-to-idle");
check("6 는 conservative-edge", frameCountAdvice(6).band === "conservative-edge");
check("8 은 advanced", frameCountAdvice(8).band === "advanced");
check("9 는 not-default", frameCountAdvice(9).band === "not-default");
check("12 는 not-default", frameCountAdvice(12).band === "not-default");
check("7 은 unspecified (정본이 다루지 않는다)", frameCountAdvice(7).band === "unspecified");
check("not-default 는 실패 모드를 근거로 남긴다", frameCountAdvice(12).note.includes("duplicate"));

console.log("=== isLocomotionState (prepare.py:state_motion_phases 멤버십) ===");
check("run", isLocomotionState("run"));
check("walk", isLocomotionState("walk"));
check("running-right", isLocomotionState("running-right"));
check("running-left", isLocomotionState("running-left"));
check("running-front-right", isLocomotionState("running-front-right"));
check("walking-back-left", isLocomotionState("walking-back-left"));
check("idle 은 아니다", !isLocomotionState("idle"));
check("attack 은 아니다", !isLocomotionState("attack"));
// 정본 멤버십에 없다 — frontwalk 은 classifyState 에서 experimental 이지만
// state_motion_phases 의 집합에는 들어 있지 않다. 없는 근거를 지어내지 않는다.
check("frontwalk 은 정본 멤버십에 없다", !isLocomotionState("frontwalk"));
check("방향 접두사가 붙은 채로는 안 잡힌다 — bareState 를 먼저 써야 한다", !isLocomotionState("down_run"));

console.log("=== inferActionHint — 동작 텍스트 → 정본 상태명 ===");
check("걷기 → walk", inferActionHint("걷기 애니메이션")?.state === "walk");
check("달리기 → run", inferActionHint("달리기 사이클")?.state === "run");
check("running → run", inferActionHint("a running cycle")?.state === "run");
check("대기 → idle", inferActionHint("대기 호흡")?.state === "idle");
check("공격 → attack", inferActionHint("칼로 공격")?.state === "attack");
check("점프 → jump", inferActionHint("점프 동작")?.state === "jump");
check("인사 → wave", inferActionHint("손 흔들며 인사")?.state === "wave");
check("피격 → hurt", inferActionHint("피격 경직")?.state === "hurt");
check("시전 → magic_cast", inferActionHint("마법 시전")?.state === "magic_cast");
check("정본에 없는 사망은 상태명 없음", inferActionHint("사망 연출")?.state === null);
check("매칭 없으면 null", inferActionHint("지팡이를 빙글빙글 돌린다") === null);

console.log("=== 힌트의 프레임·루프가 정본 대역 안이다 ===");
check("idle 은 4프레임 루프", inferActionHint("idle")?.frames === 4 && inferActionHint("idle")?.loop === true);
check("attack 은 4프레임 비루프", inferActionHint("attack")?.frames === 4 && inferActionHint("attack")?.loop === false);
check("jump 는 4프레임 비루프", inferActionHint("jump")?.frames === 4);
check("wave 는 4프레임 비루프", inferActionHint("wave")?.frames === 4 && inferActionHint("wave")?.loop === false);
check("로코모션만 8프레임(정본 로코모션 행 대역)", inferActionHint("run")?.frames === 8);
check("magic_cast 는 상한 6 이하", (inferActionHint("magic")?.frames ?? 99) <= 6);

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
