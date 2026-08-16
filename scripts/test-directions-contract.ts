/**
 * ③ Task 1 — 방향 계약 정규화 테스트.
 * sprite-gen normalize_directions / ensure_direction_anchors 와 대조한다.
 */
import {
  DIRECTION_FACING,
  bareState,
  directionAnchorStates,
  ensureDirectionAnchors,
  normalizeDirections,
  stateDirection,
  toSideSuffix,
  toSpriteGenDirection,
} from "../src/lib/sprite/directions";
import type { StateSpec } from "../src/lib/sprite/request";

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

const S = (frames = 4): StateSpec => ({ frames, fps: 4, loop: true, action: "a" });

console.log("=== normalizeDirections ===");
check("빈 블록은 null (기존 flat 런)", normalizeDirections(null, {}) === null);
check("빈 객체도 null", normalizeDirections({}, {}) === null);
{
  const d = normalizeDirections(
    { set: ["down", "right", "up"], mirror: { left: "right" } },
    { down_idle: S(), right_walk: S(), up_idle: S() },
  );
  check("set 이 그대로 들어온다", d !== null && d.set.join(",") === "down,right,up");
  check("mirror 가 그대로", d !== null && d.mirror.left === "right");
  check("anchorSuffix 기본은 idle", d !== null && d.anchorSuffix === "idle");
}
check("set 이 비면 거부", throws(() => normalizeDirections({ set: [] }, {})));
check(
  "mirror source 가 set 에 없으면 거부",
  throws(() =>
    normalizeDirections({ set: ["down"], mirror: { left: "right" } }, { down_idle: S() }),
  ),
);
check(
  "mirror target 이 생성 방향이면 거부",
  throws(() =>
    normalizeDirections({ set: ["down", "left"], mirror: { left: "down" } }, { down_idle: S() }),
  ),
);
check(
  "방향 접두사 없는 상태는 거부 (fail-loud)",
  throws(() => normalizeDirections({ set: ["down"] }, { walk: S() })),
);
check(
  "접두사가 맞으면 통과",
  !throws(() => normalizeDirections({ set: ["down"] }, { down_walk: S() })),
);
{
  const d = normalizeDirections({ set: ["down"], anchor_suffix: "stand" }, { down_walk: S() });
  check("anchorSuffix 재정의", d !== null && d.anchorSuffix === "stand");
}

console.log("=== directionAnchorStates ===");
{
  const d = normalizeDirections({ set: ["down", "right"] }, { down_walk: S(), right_walk: S() })!;
  const a = directionAnchorStates(d);
  check("<dir>_<suffix> 로 만든다", a.down === "down_idle" && a.right === "right_idle");
}

console.log("=== ensureDirectionAnchors — 앵커 없는 방향 행 생성 금지 ===");
{
  const d = normalizeDirections({ set: ["down", "right"] }, { down_walk: S(8), right_walk: S(8) })!;
  const states = ensureDirectionAnchors(d, { down_walk: S(8), right_walk: S(8) });
  check("빠진 앵커 상태가 합성된다", "down_idle" in states && "right_idle" in states);
  check("합성 앵커는 4프레임", states.down_idle.frames === 4);
  check("합성 앵커는 fps 4 / loop", states.down_idle.fps === 4 && states.down_idle.loop === true);
  check(
    "합성 앵커 action 에 facing 이 들어간다",
    states.down_idle.action.includes("facing the viewer (front view)"),
    states.down_idle.action,
  );
  check(
    "합성 앵커 action 에 canonical 문구",
    states.down_idle.action.includes("canonical direction anchor derived from the base"),
  );
  check(
    "합성 앵커가 앞에 온다 (생성 순서)",
    Object.keys(states)[0] === "down_idle" || Object.keys(states)[0] === "right_idle",
    Object.keys(states).join(","),
  );
  check("기존 행은 보존된다", states.down_walk.frames === 8);
}
{
  const d = normalizeDirections({ set: ["down"] }, { down_idle: S(6) })!;
  const states = ensureDirectionAnchors(d, { down_idle: S(6) });
  check("이미 있는 앵커 상태는 덮어쓰지 않는다", states.down_idle.frames === 6);
}

console.log("=== stateDirection ===");
{
  const d = normalizeDirections({ set: ["down", "down45"] }, { down_walk: S() })!;
  check("접두사로 방향을 찾는다", stateDirection("down_walk", d) === "down");
  check("긴 접두사도 정확히", stateDirection("down45_walk", d) === "down45");
  check("접두사 없으면 null", stateDirection("walk", d) === null);
  check("directions 없으면 항상 null", stateDirection("down_walk", null) === null);
}

console.log("=== DIRECTION_FACING ===");
check("down", DIRECTION_FACING.down === "facing the viewer (front view)");
check(
  "up 은 얼굴이 안 보인다고 명시",
  DIRECTION_FACING.up === "facing away from the viewer (back view, no visible face)",
);
check("side 와 right 는 같은 문구", DIRECTION_FACING.side === DIRECTION_FACING.right);
check("left 는 camera-left", DIRECTION_FACING.left.includes("camera-left"));
check("front-right 항목은 없다 (접미사 경로가 담당)", DIRECTION_FACING["front-right"] === undefined);

console.log("=== toSpriteGenDirection (신규 매핑) ===");
check("DOWN → down", toSpriteGenDirection("DOWN") === "down");
check("UP → up", toSpriteGenDirection("UP") === "up");
check("RIGHT → right", toSpriteGenDirection("RIGHT") === "right");
check("LEFT → left", toSpriteGenDirection("LEFT") === "left");
// 대각선은 정본이 등록해 둔 45도 토큰(down45/up45)으로 간다. 좌/우는 방향이 아니라
// **상태명 접미사**가 진다 — 그래야 directionalRequirements 의 3/4 뷰 잠금이 발화한다.
check("DOWN-RIGHT → down45", toSpriteGenDirection("DOWN-RIGHT") === "down45");
check("DOWN-LEFT → down45 (앵커를 공유)", toSpriteGenDirection("DOWN-LEFT") === "down45");
check("UP-RIGHT → up45", toSpriteGenDirection("UP-RIGHT") === "up45");
check("UP-LEFT → up45 (앵커를 공유)", toSpriteGenDirection("UP-LEFT") === "up45");
check("down45 는 정본 DIRECTION_FACING 에 있다", DIRECTION_FACING.down45 !== undefined);
check("up45 도 있다", DIRECTION_FACING.up45 !== undefined);

check("DOWN-RIGHT 접미사", toSideSuffix("DOWN-RIGHT") === "-front-right");
check("DOWN-LEFT 접미사", toSideSuffix("DOWN-LEFT") === "-front-left");
check("UP-RIGHT 접미사", toSideSuffix("UP-RIGHT") === "-back-right");
check("UP-LEFT 접미사", toSideSuffix("UP-LEFT") === "-back-left");
check("4방위는 접미사 없음", toSideSuffix("DOWN") === "" && toSideSuffix("RIGHT") === "");
check("REF 는 방향 계약 없음", toSpriteGenDirection("REF") === null);
check("모르는 값도 null", toSpriteGenDirection("SIDEWAYS") === null);

console.log("=== bareState — 방향 접두사 제거 ===");
{
  const dirs = normalizeDirections({ set: ["down", "front-right"] }, {
    down_run: { frames: 8, fps: 8, loop: true, action: "a" },
    down_idle: { frames: 4, fps: 4, loop: true, action: "a" },
    "front-right_walk": { frames: 8, fps: 6, loop: true, action: "a" },
  })!;
  check("down_run → run", bareState("down_run", dirs) === "run");
  check("front-right_walk → walk", bareState("front-right_walk", dirs) === "walk");
  check("방향 계약 없으면 그대로", bareState("down_run", null) === "down_run");
  check("set 에 없는 방향은 그대로", bareState("up_run", dirs) === "up_run");
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
