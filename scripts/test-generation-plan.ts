/**
 * ③ Task 2 — 생성 플랜 SSoT 테스트.
 * stage1 앵커(base 기반) → stage2 행(앵커 기반) → 미러 생략 계약.
 */
import { buildGenerationPlan } from "../src/lib/sprite/generation-plan";
import { normalizeDirections } from "../src/lib/sprite/directions";
import {
  DEFAULT_CHROMA_TUNABLES,
  normalizeCell,
  type SpriteRequest,
  type StateSpec,
} from "../src/lib/sprite/request";

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

const S = (frames = 8): StateSpec => ({ frames, fps: 8, loop: true, action: "a" });

function req(states: Record<string, StateSpec>, rawDirs: object | null): SpriteRequest {
  const directions = normalizeDirections(rawDirs, states);
  return {
    version: 1,
    character: { id: "aurora", description: "d", anchorGenerationId: "gen_base" },
    cell: normalizeCell({}),
    chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
    chroma: DEFAULT_CHROMA_TUNABLES,
    states,
    ...(directions ? { directions } : {}),
  };
}

console.log("=== 방향 계약 없으면 플랜도 없다 ===");
check("flat 런은 null", buildGenerationPlan(req({ idle: S(4) }, null)) === null);

console.log("=== stage 1 — 방향 앵커 ===");
const states = {
  down_idle: S(4),
  right_idle: S(4),
  down_walk: S(8),
  right_walk: S(8),
};
const plan = buildGenerationPlan(req(states, { set: ["down", "right"], mirror: { left: "right" } }))!;
{
  const s1 = plan.order[0];
  check("stage 1 이름", s1.stage === 1 && s1.name === "direction-anchors");
  check("방향 수만큼 앵커 항목", s1.items.length === 2);
  check("앵커 상태명", s1.items.map(i => i.state).join(",") === "down_idle,right_idle");
  check("role 은 direction-anchor", s1.items.every(i => i.role === "direction-anchor"));
  check(
    "앵커 refs 는 base + 레이아웃 가이드",
    s1.items[0].refs.map(r => r.kind).join(",") === "base,layout-guide",
  );
  check(
    "앵커 note 가 base 은퇴를 못박는다",
    s1.items[0].note.includes("base 는 방향 앵커 생성까지만"),
  );
}

console.log("=== stage 2 — 액션 행 ===");
{
  const s2 = plan.order[1];
  check("stage 2 이름", s2.stage === 2 && s2.name === "action-rows");
  check("앵커 상태는 stage2 에서 빠진다", s2.items.length === 2);
  check("행 상태명", s2.items.map(i => i.state).sort().join(",") === "down_walk,right_walk");
  check("role 은 action-row", s2.items.every(i => i.role === "action-row"));
  check(
    "행 refs 는 앵커 + 레이아웃 가이드 — base 없음",
    s2.items.every(i => i.refs.map(r => r.kind).join(",") === "anchor,layout-guide"),
  );
  check("행 refs 에 base 가 절대 없다", !s2.items.some(i => i.refs.some(r => r.kind === "base")));
  check(
    "앵커 ref 는 자기 방향을 가리킨다",
    s2.items.find(i => i.state === "right_walk")!.refs[0].ref === "right",
  );
  check("행 note 가 파생 캐시 재베이크를 요구한다", s2.items[0].note.includes("생성 직전"));
}

console.log("=== 미러 = 생성 생략 계약 ===");
{
  check("미러 방향이 기록된다", plan.mirroredDirections.length === 1);
  const m = plan.mirroredDirections[0];
  check("target/source", m.direction === "left" && m.mirrorOf === "right");
  check("note 가 런타임 미러 기본을 밝힌다", m.note.includes("생성 생략"));
  check("note 가 재생성 시 절차를 준다", m.note.includes("timing/scale"));
  check(
    "미러 방향은 stage 1·2 어디에도 없다",
    !plan.order.some(s => s.items.some(i => i.direction === "left")),
  );
}

console.log("=== 방향 접두사 없는 상태는 stage2 에서 제외 ===");
{
  // normalizeDirections 가 이미 막지만, 플랜 빌더도 방어적으로 건너뛴다.
  const base = req({ down_idle: S(4), down_walk: S(8) }, { set: ["down"] });
  const p = buildGenerationPlan({
    ...base,
    states: { down_idle: S(4), down_walk: S(8), orphan: S(4) },
  })!;
  check("orphan 은 stage2 에 없다", !p.order[1].items.some(i => i.state === "orphan"));
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
