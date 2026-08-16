# ③단계 — 방향 앵커 체인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** base 1장에서 방향별 idle 행을 뽑고, 그 행의 **큐레이션 시퀀스 첫 프레임 1장**을
방향 앵커로 확정한 뒤, 이후 모든 액션 행이 base 가 아니라 자기 방향 앵커에서 identity 를
가져오게 하는 체인을 만든다.

**Architecture:** 순수 모듈 3개(`directions.ts`·`generation-plan.ts`·`anchor.ts`) + 이미지
모듈 1개(`anchor-image.ts`) + ②의 `row-prompt.ts` 확장 + DB 기록 함수. 결정론 코드이므로
sprite-gen 을 기준 구현으로 삼아 Python 출력과 직접 대조한다.

**Tech Stack:** TypeScript / sharp / better-sqlite3 / tsx 수제 테스트 / 검증용 sprite-gen `.venv`

---

## Global Constraints

- 정본 계약은 sprite-gen `SKILL.md` 가 소유하고, 이 단계의 시나리오 상세는
  `docs/directional-anchor-workflow.md` 가 소유한다.
- **앵커 = 1장.** 다프레임 idle 행은 유효한 앵커가 아니다.
- **base 은퇴.** 방향 앵커 수락 후 base 를 액션 행 생성에 재부착하지 않는다.
- **No Silent Fallback.** 지정이 사라진 프레임을 가리키면 조용히 기본값으로 돌아가지 않고
  fail-loud 한다. 다만 *pending*(아직 안 뽑음)과 *broken*(사람이 고쳐야 함)은 구분한다.
- 미러 방향은 **생성 생략이 기본**이고, 그 사실을 계약으로 기록한다(조용한 누락이 아니다).
- Python 런타임 의존을 도입하지 않는다. `.venv` 는 검증 시점에만 쓴다.
- 기존 상수·문구를 임의로 다듬지 않는다.
- 브랜치는 `feat/directional-anchor-chain`. `main` 에서 직접 작업하지 않는다.

### 배선은 이 단계에서도 하지 않는다 — 다만 여기가 마지막이다

①②와 같이 순수 모듈 + DB 기록까지만 만들고 `spritesheet-handler.ts`·`SpriteGenPanel`·
`SpriteCanvas` 에 연결하지 않는다. ④가 행 생성 흐름 전체를 교체하기 때문이다.

**③을 끝내면 미배선 코드가 3단계치 쌓인다.** ④는 순수 모듈 추가가 아니라 **통합 단계**로
잡아야 하며, 계획의 첫 Task 가 "①②③ 모듈을 실제 생성 경로에 붙이고 codex 로 1회 왕복"이어야
한다. 그렇게 하지 않으면 인터페이스 불일치가 ⑤⑥까지 미뤄진다.

---

## 정본 대조로 확인한 사실 (계획의 근거)

### 1. 앵커 프레임은 index 0 이 아니다 — 실사고가 근거다

> 기본: `<dir>_<anchor_suffix>` 의 **curated sequence head** — 재생 시퀀스의 첫 인스턴스이며
> **index 0 이 아니다.** 사용자가 앞 프레임을 삭제/재정렬했으면 index 0 은 기각분이다.

`anchor.py` 모듈 독스트링에 사고 기록이 있다 — *"side_idle 이 0·1·2 삭제 후 3부터라 index 0
베이크가 삭제된 미편집 프레임을 앵커로 만들었다"* (2026-07-19).

**우리에게 이 문제가 이미 있다.** [SpriteCanvas.tsx:319](src/components/editor/SpriteCanvas.tsx:319)
가 정확히 큐레이션 시퀀스를 계산한다:

```ts
return ord.filter(origIdx => !excludedFrames.has(origIdx)).map(origIdx => exportFrames[origIdx]);
```

`frameOrder`(재정렬)와 `excludedFrames`(제외)가 이미 있고, 재생·GIF·ZIP 이 전부 이걸 따른다.
그러므로 "index 0 을 앵커로 쓰면 된다"는 **우리 UI 에서도 틀린다.**

### 2. 그런데 우리 큐레이션은 영속되지 않는다 (이 단계의 핵심 결함)

| 항목 | 현재 상태 |
|---|---|
| `frameOrder` | React state. `saveCorrected()`(841줄)가 **시트 PNG 자체를 재배열해** 파괴적으로 반영 |
| `excludedFrames` | React state. **영속되지 않는다** — 미리보기·내보내기 전용 |
| 앵커 지정(pin) | **없다** |

따라서 `resolveAnchor` 의 기본 분기(큐레이션 시퀀스 헤드)는 **오늘 입력 소스가 없다.**
Task 4 가 DB 기록 계약을 먼저 만들고, ④가 `SpriteCanvas` 에서 그 계약에 쓰게 한다.
①의 `lockBaseGeneration` 이 UI 없이 DB 계약만 먼저 만든 것과 같은 형태다.

### 3. 우리 pin 은 원본보다 단순해도 된다 (의도적 축소)

sprite-gen 의 pin 은 `{state, index}` + `state_revision` 이고, 행이 재생성되면 같은 index 가
다른 이미지가 되므로 `pick-stale-generation`·`pick-unverifiable` 두 오류가 필요하다.

**우리 pin 은 `{generationId, index}` 다.** 행을 다시 생성하면 새 `generationId` 가 나오므로
낡은 핀은 정의상 존재하지 않는 행을 가리킨다 — stale 이 `pick-missing` 으로 합쳐진다.
두 오류 코드를 이식하지 않는 이유가 이것이며, *pending / broken* 구분은 그대로 유지한다.

### 4. 방향 어휘가 두 갈래인 것은 중복이 아니다

`row_prompt` 는 방향 요구사항을 **두 경로**로 붙인다. 통합하지 말 것:

| 경로 | 판정 기준 | 문구 |
|---|---|---|
| `direction_prefix_requirements` | `directions` 블록 + `state.startswith(dir + "_")` | facing 잠금 + **앵커 행이냐 액션 행이냐**에 따라 base 기반/앵커 기반 |
| `directional_requirements` | 상태명이 `-(front\|back)-(left\|right)$` 정규식에 맞는지 | 45도 3/4 뷰 잠금, 방향 시트·타깃 앵커 우선순위, left 는 basis 행을 timing 전용으로 |

전자는 `down_walk` 식 접두사 계약, 후자는 `running-front-right` 식 접미사 규약이다.
`DIRECTION_FACING` 에 `front-right` 항목이 **없는** 것도 의도다 — 폴백 문구가 나가고 세부는
후자가 채운다.

### 5. 우리 UI 방향 어휘를 sprite-gen 토큰으로 옮겨야 한다 (이식이 아니라 신규 코드)

[SpriteGenPanel.tsx:23](src/components/editor/SpriteGenPanel.tsx:23) 의 `Direction` 은
`DOWN|LEFT|RIGHT|UP|DOWN-LEFT|DOWN-RIGHT|UP-LEFT|UP-RIGHT|REF` 다. sprite-gen 은
`down|up|side|right|left|down45|up45` + `*-front-right` 계열을 쓴다.

**내부 어휘를 sprite-gen 쪽으로 통일한다** — 그래야 두 이식 함수가 문구 수정 없이 그대로
돈다. 변환은 경계 함수 하나(`toSpriteGenDirection`)가 소유한다. 이 매핑만 이식이 아니라
신규 코드이므로 테스트로 고정한다.

| UI | sprite-gen 토큰 | 근거 |
|---|---|---|
| `DOWN` | `down` | 정면 |
| `UP` | `up` | 뒷모습 |
| `RIGHT` | `right` | 우측 프로필 |
| `LEFT` | `left` | 좌측 프로필 — **미러 기본 후보** |
| `DOWN-RIGHT` | `front-right` | 45도 3/4 정면, 카메라 우측 |
| `DOWN-LEFT` | `front-left` | |
| `UP-RIGHT` | `back-right` | 45도 3/4 후면, 카메라 우측 |
| `UP-LEFT` | `back-left` | |
| `REF` | (방향 계약 없음 → `null`) | 참조 이미지 방향을 그대로 따르는 모드 |

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/lib/sprite/directions.ts` (신규) | `DIRECTION_FACING` · `normalizeDirections` · `directionAnchorStates` · `ensureDirectionAnchors` · `stateDirection` · `toSpriteGenDirection`. **순수** |
| `src/lib/sprite/generation-plan.ts` (신규) | `buildGenerationPlan` — stage1 앵커 / stage2 행 / 미러 생략 계약. **순수** |
| `src/lib/sprite/anchor.ts` (신규) | `CurationRecord` 타입 · `curatedSequence` · `resolveAnchor` · `AnchorUnavailable`. **순수** |
| `src/lib/sprite/anchor-image.ts` (신규) | 셀 크롭 → 콘텐츠 bbox 크롭 → ×8 NEAREST. sharp 사용 |
| `src/lib/sprite/request.ts` (수정) | `SpriteRequest` 에 `directions?: DirectionsSpec` 추가 |
| `src/lib/sprite/row-prompt.ts` (수정) | 방향 요구사항 2경로를 `buildRowPrompt` 에 배선 (②의 유보 해소) |
| `src/lib/db/repo/generations.ts` (수정) | `saveCuration` · `getCuration` · `pinAnchorFrame` · `clearAnchorPick` · `getAnchorPicks` |
| `scripts/test-directions-contract.ts` (신규) | Task 1 |
| `scripts/test-generation-plan.ts` (신규) | Task 2 |
| `scripts/test-row-prompt.ts` (수정) | Task 3 |
| `scripts/test-anchor.ts` (신규) | Task 4·5 |
| `package.json` (수정) | `test` 체이닝 |

**이름 충돌 주의**: `src/lib/image-backend/chroma-key.ts`(키 **제거**)와
`src/lib/sprite/chroma-key.ts`(키 **선택**)가 이미 basename 이 같다. `anchor.ts` 는 새 충돌을
만들지 않지만, import 시 경로를 끝까지 확인할 것.

---

## Task 1: 방향 계약 정규화

**Files:**
- Create: `src/lib/sprite/directions.ts`
- Modify: `src/lib/sprite/request.ts` (타입 추가만)
- Test: `scripts/test-directions-contract.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `StateSpec` (`request.ts`)
- Produces:
  - `type DirectionsSpec = { set: string[]; mirror: Record<string, string>; anchorSuffix: string }`
  - `DIRECTION_FACING: Record<string, string>`
  - `normalizeDirections(raw, states): DirectionsSpec | null`
  - `directionAnchorStates(d: DirectionsSpec): Record<string, string>`
  - `ensureDirectionAnchors(d, states): Record<string, StateSpec>`
  - `stateDirection(state: string, d: DirectionsSpec | null): string | null`
  - `toSpriteGenDirection(ui: string): string | null`

### 참조 원본

- `sprite_gen/prepare.py:563-575` — `DIRECTION_FACING`
- `sprite_gen/prepare.py:578-597` — `normalize_directions`
- `sprite_gen/prepare.py:600-617` — `direction_anchor_states` · `ensure_direction_anchors`
- `sprite_gen/prepare.py:620-623` — `state_direction`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-directions-contract.ts`:

```ts
/**
 * ③ Task 1 — 방향 계약 정규화 테스트.
 * sprite-gen normalize_directions / ensure_direction_anchors 와 대조한다.
 */
import {
  DIRECTION_FACING,
  directionAnchorStates,
  ensureDirectionAnchors,
  normalizeDirections,
  stateDirection,
  toSpriteGenDirection,
} from "../src/lib/sprite/directions";
import type { StateSpec } from "../src/lib/sprite/request";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
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
  throws(() => normalizeDirections({ set: ["down"], mirror: { left: "right" } }, { down_idle: S() })),
);
check(
  "mirror target 이 생성 방향이면 거부",
  throws(() => normalizeDirections({ set: ["down", "left"], mirror: { left: "down" } }, { down_idle: S() })),
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
  const d = normalizeDirections({ set: ["down", "right"] }, { down_walk: S() , right_walk: S() })!;
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
  check("합성 앵커 action 에 facing 이 들어간다",
    states.down_idle.action.includes("facing the viewer (front view)"), states.down_idle.action);
  check("합성 앵커 action 에 canonical 문구",
    states.down_idle.action.includes("canonical direction anchor derived from the base"));
  check("합성 앵커가 앞에 온다 (생성 순서)",
    Object.keys(states)[0] === "down_idle" || Object.keys(states)[0] === "right_idle",
    Object.keys(states).join(","));
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
check("up 은 얼굴이 안 보인다고 명시",
  DIRECTION_FACING.up === "facing away from the viewer (back view, no visible face)");
check("side 와 right 는 같은 문구", DIRECTION_FACING.side === DIRECTION_FACING.right);
check("left 는 camera-left", DIRECTION_FACING.left.includes("camera-left"));
check("front-right 항목은 없다 (접미사 경로가 담당)", DIRECTION_FACING["front-right"] === undefined);

console.log("=== toSpriteGenDirection (신규 매핑) ===");
check("DOWN → down", toSpriteGenDirection("DOWN") === "down");
check("UP → up", toSpriteGenDirection("UP") === "up");
check("RIGHT → right", toSpriteGenDirection("RIGHT") === "right");
check("LEFT → left", toSpriteGenDirection("LEFT") === "left");
check("DOWN-RIGHT → front-right", toSpriteGenDirection("DOWN-RIGHT") === "front-right");
check("DOWN-LEFT → front-left", toSpriteGenDirection("DOWN-LEFT") === "front-left");
check("UP-RIGHT → back-right", toSpriteGenDirection("UP-RIGHT") === "back-right");
check("UP-LEFT → back-left", toSpriteGenDirection("UP-LEFT") === "back-left");
check("REF 는 방향 계약 없음", toSpriteGenDirection("REF") === null);
check("모르는 값도 null", toSpriteGenDirection("SIDEWAYS") === null);

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-directions-contract.ts
```

Expected: `Cannot find module '../src/lib/sprite/directions'`.

- [ ] **Step 3: `directions.ts` 를 구현한다**

```ts
/**
 * 방향 계약 — sprite_gen/prepare.py 의 directions 블록 이식.
 *
 * base = down(정면) 기본자세 하나. 방향 앵커(<dir>_<anchorSuffix>)를 base 에서 먼저
 * 뽑고, 각 행은 자기 방향 앵커를 identity 로 생성한다
 * (sprite-gen docs/directional-anchor-workflow.md).
 *
 * 순수 모듈 — sharp·fs·DB 를 모른다.
 */
import type { StateSpec } from "@/lib/sprite/request";

export type DirectionsSpec = {
  set: string[];
  mirror: Record<string, string>;
  anchorSuffix: string;
};

export type RawDirections = {
  set?: unknown[];
  mirror?: Record<string, unknown> | null;
  anchor_suffix?: string;
};

/**
 * 45도 계열(`front-right` 등)이 여기 없는 것은 의도다 — 폴백 문구가 나가고 세부는
 * 상태명 접미사 경로(row-prompt 의 directionalRequirements)가 채운다.
 */
export const DIRECTION_FACING: Record<string, string> = {
  down: "facing the viewer (front view)",
  up: "facing away from the viewer (back view, no visible face)",
  side: "pure side profile view facing camera-right",
  right: "pure side profile view facing camera-right",
  left: "pure side profile view facing camera-left",
  down45: "45-degree three-quarter-front view",
  up45: "45-degree three-quarter-back view",
};

export function facingOf(direction: string): string {
  return DIRECTION_FACING[direction] ?? `facing the ${direction} direction`;
}

/** null = 방향 계약 없음(기존 flat 런). */
export function normalizeDirections(
  raw: RawDirections | null | undefined,
  states: Record<string, unknown>,
): DirectionsSpec | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const set = (raw.set ?? []).map(d => String(d));
  if (set.length === 0) {
    throw new Error("normalizeDirections: directions.set must list at least one direction");
  }
  const mirror: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.mirror ?? {})) mirror[String(k)] = String(v);
  for (const [target, source] of Object.entries(mirror)) {
    if (!set.includes(source)) {
      throw new Error(`normalizeDirections: mirror source '${source}' is not in directions.set`);
    }
    if (set.includes(target)) {
      throw new Error(
        `normalizeDirections: mirror target '${target}' must not also be a generated direction`,
      );
    }
  }
  const anchorSuffix = String(raw.anchor_suffix ?? "idle");
  for (const state of Object.keys(states)) {
    if (!set.some(d => state.startsWith(d + "_"))) {
      throw new Error(
        `normalizeDirections: state '${state}' does not start with a declared direction prefix ` +
          `(${set.join(", ")}) — direction-contract runs name states <direction>_<state>`,
      );
    }
  }
  return { set, mirror, anchorSuffix };
}

/** direction → 앵커 상태명 (`<dir>_<anchorSuffix>`). */
export function directionAnchorStates(directions: DirectionsSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of directions.set) out[d] = `${d}_${directions.anchorSuffix}`;
  return out;
}

/**
 * 방향 앵커 상태가 요청에 없으면 합성해 **앞에** 끼운다 — 앵커 없는 방향 행 생성 금지.
 * 4프레임인 것은 정본의 단순 동작 기본 안정 범위와 같다 (states-and-frames.md).
 */
export function ensureDirectionAnchors(
  directions: DirectionsSpec,
  states: Record<string, StateSpec>,
): Record<string, StateSpec> {
  const synthesized: Record<string, StateSpec> = {};
  for (const [direction, anchor] of Object.entries(directionAnchorStates(directions))) {
    if (anchor in states) continue;
    synthesized[anchor] = {
      frames: 4,
      fps: 4,
      loop: true,
      action: `standing idle, ${facingOf(direction)}; subtle breathing; canonical direction anchor derived from the base`,
    };
  }
  return { ...synthesized, ...states };
}

export function stateDirection(state: string, directions: DirectionsSpec | null): string | null {
  if (!directions) return null;
  return directions.set.find(d => state.startsWith(d + "_")) ?? null;
}

/**
 * UI 방향 어휘 → sprite-gen 토큰. **이식이 아니라 신규 코드다** — 우리 패널의
 * DOWN/UP/LEFT/RIGHT/대각선 8종을 정본 어휘로 옮긴다. 내부를 정본 어휘로 통일해야
 * 이식한 두 요구사항 함수가 문구 수정 없이 돈다.
 *
 * null = 방향 계약을 걸지 않는다(REF 는 참조 이미지의 방향을 그대로 따르는 모드).
 */
const UI_TO_SPRITE_GEN: Record<string, string> = {
  DOWN: "down",
  UP: "up",
  RIGHT: "right",
  LEFT: "left",
  "DOWN-RIGHT": "front-right",
  "DOWN-LEFT": "front-left",
  "UP-RIGHT": "back-right",
  "UP-LEFT": "back-left",
};

export function toSpriteGenDirection(ui: string): string | null {
  return UI_TO_SPRITE_GEN[ui] ?? null;
}
```

`src/lib/sprite/request.ts` 의 `SpriteRequest` 에 필드 하나를 더한다 (import 순환을 피하려면
`DirectionsSpec` 을 `request.ts` 에 정의하고 `directions.ts` 가 재export 하는 편이 낫다 —
구현자가 순환을 만나면 그렇게 바꾼다):

```ts
export type SpriteRequest = {
  version: 1;
  character: { id: string; description: string; anchorGenerationId: string };
  cell: CellSpec;
  chromaKey: ChromaKeySpec;
  chroma: ChromaTunables;
  states: Record<string, StateSpec>;
  /** 방향 계약. 없으면(undefined) 기존 flat 런. */
  directions?: { set: string[]; mirror: Record<string, string>; anchorSuffix: string };
};
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-directions-contract.ts
```

Expected: `40 passed / 0 failed`

- [ ] **Step 5: Python 기준 구현과 교차 확인한다**

```bash
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys, json; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from sprite_gen.prepare import normalize_directions, ensure_direction_anchors, direction_anchor_states
states = {'down_walk': {'frames':8,'fps':8,'loop':True,'action':'a'},
          'right_walk': {'frames':8,'fps':8,'loop':True,'action':'a'}}
d = normalize_directions({'set':['down','right'],'mirror':{'left':'right'}}, states)
print('directions:', d)
print('anchor states:', direction_anchor_states(d))
print('ensured keys:', list(ensure_direction_anchors(d, states).keys()))
print('down_idle:', json.dumps(ensure_direction_anchors(d, states)['down_idle'], ensure_ascii=False))
"
```

Expected: `set`·`mirror`·`anchor_suffix`, 앵커 상태명, **합성 순서(앵커가 앞)**, 그리고
`down_idle` 의 `frames/fps/loop/action` 이 TS 와 일치. `action` 문자열은 **완전 일치**해야
한다 — 프롬프트에 그대로 들어간다.

- [ ] **Step 6: 체이닝하고 커밋**

`package.json` 의 `test` 끝에 `&& tsx scripts/test-directions-contract.ts` 추가.

```bash
git add src/lib/sprite/directions.ts src/lib/sprite/request.ts scripts/test-directions-contract.ts package.json
git commit -m "feat(sprite): 방향 계약 정규화 — 앵커 상태 합성과 UI 어휘 매핑"
```

---

## Task 2: 생성 플랜 빌더

**Files:**
- Create: `src/lib/sprite/generation-plan.ts`
- Test: `scripts/test-generation-plan.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DirectionsSpec`·`directionAnchorStates`·`stateDirection` (Task 1), `SpriteRequest`
- Produces:
  - `type PlanItem = { state: string; role: "direction-anchor" | "action-row"; direction: string; refs: PlanRef[]; note: string }`
  - `type PlanRef = { kind: "base" | "anchor" | "layout-guide"; ref: string }`
  - `type MirroredDirection = { direction: string; mirrorOf: string; note: string }`
  - `type GenerationPlan = { version: 1; kind: "sprite-gen-generation-plan"; order: [{stage:1;name:"direction-anchors";items:PlanItem[]}, {stage:2;name:"action-rows";items:PlanItem[]}]; mirroredDirections: MirroredDirection[] }`
  - `buildGenerationPlan(request: SpriteRequest): GenerationPlan | null`

### 참조 원본

- `sprite_gen/prepare.py:626-691` — `build_generation_plan`

### 원본으로부터의 이탈 2건

1. **refs 가 문자열 경로가 아니라 태그 객체다.** 원본은 run 디렉터리 상대 경로
   (`base-source.*`, `references/anchors/down-anchor-x8.png`)를 쓴다. 우리는 run 디렉터리가
   없고 파일이 `generations.image_path` 로 관리되므로, 플랜은 **무엇을 붙일지의 종류와
   식별자**만 담고 실제 경로 해석은 ④의 배선이 한다. `kind` 를 남겨야 ④에서
   "base 를 액션 행에 붙였는지"를 기계적으로 검증할 수 있다.
2. **`materialize` 커맨드 문자열을 넣지 않는다.** 원본은 워커가 크롭 위치를 판단하지
   못하도록 CLI 커맨드를 굽는다. 우리는 워커가 아니라 같은 프로세스의 함수 호출
   (`bakeAnchorImage`)이라 커맨드가 필요 없다. **대신 "생성 직전 재베이크"라는 파생 캐시
   성질은 `note` 에 남긴다** — 이게 사라지면 편집이 반영 안 된 앵커가 조용히 재사용된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-generation-plan.ts`:

```ts
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
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
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
  down_idle: S(4), right_idle: S(4),
  down_walk: S(8), right_walk: S(8),
};
const plan = buildGenerationPlan(req(states, { set: ["down", "right"], mirror: { left: "right" } }))!;
{
  const s1 = plan.order[0];
  check("stage 1 이름", s1.stage === 1 && s1.name === "direction-anchors");
  check("방향 수만큼 앵커 항목", s1.items.length === 2);
  check("앵커 상태명", s1.items.map(i => i.state).join(",") === "down_idle,right_idle");
  check("role 은 direction-anchor", s1.items.every(i => i.role === "direction-anchor"));
  check("앵커 refs 는 base + 레이아웃 가이드",
    s1.items[0].refs.map(r => r.kind).join(",") === "base,layout-guide");
  check("앵커 note 가 base 은퇴를 못박는다",
    s1.items[0].note.includes("base 는 방향 앵커 생성까지만"));
}

console.log("=== stage 2 — 액션 행 ===");
{
  const s2 = plan.order[1];
  check("stage 2 이름", s2.stage === 2 && s2.name === "action-rows");
  check("앵커 상태는 stage2 에서 빠진다", s2.items.length === 2);
  check("행 상태명", s2.items.map(i => i.state).sort().join(",") === "down_walk,right_walk");
  check("role 은 action-row", s2.items.every(i => i.role === "action-row"));
  check("행 refs 는 앵커 + 레이아웃 가이드 — base 없음",
    s2.items.every(i => i.refs.map(r => r.kind).join(",") === "anchor,layout-guide"));
  check("행 refs 에 base 가 절대 없다", !s2.items.some(i => i.refs.some(r => r.kind === "base")));
  check("앵커 ref 는 자기 방향을 가리킨다",
    s2.items.find(i => i.state === "right_walk")!.refs[0].ref === "right");
  check("행 note 가 파생 캐시 재베이크를 요구한다",
    s2.items[0].note.includes("생성 직전"));
}

console.log("=== 미러 = 생성 생략 계약 ===");
{
  check("미러 방향이 기록된다", plan.mirroredDirections.length === 1);
  const m = plan.mirroredDirections[0];
  check("target/source", m.direction === "left" && m.mirrorOf === "right");
  check("note 가 런타임 미러 기본을 밝힌다", m.note.includes("생성 생략"));
  check("note 가 재생성 시 절차를 준다", m.note.includes("timing/scale"));
  check("미러 방향은 stage 1·2 어디에도 없다",
    !plan.order.some(s => s.items.some(i => i.direction === "left")));
}

console.log("=== 방향 접두사 없는 상태는 stage2 에서 제외 ===");
{
  // normalizeDirections 가 이미 막지만, 플랜 빌더도 방어적으로 건너뛴다.
  const p = buildGenerationPlan({
    ...req({ down_idle: S(4), down_walk: S(8) }, { set: ["down"] }),
    states: { down_idle: S(4), down_walk: S(8), orphan: S(4) },
  })!;
  check("orphan 은 stage2 에 없다",
    !p.order[1].items.some(i => i.state === "orphan"));
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-generation-plan.ts
```

- [ ] **Step 3: `generation-plan.ts` 를 구현한다**

```ts
/**
 * 생성 체인 SSoT — sprite_gen/prepare.py `build_generation_plan()` 이식.
 *
 * 1단계 방향 앵커(base 기반) → 2단계 액션 행(앵커 기반). 미러 방향은 **생성 생략을
 * 명시적으로 기록한다** — 조용한 누락이 아니라 계약이다.
 *
 * refs 는 파일 경로가 아니라 태그 객체다(우리에게 run 디렉터리가 없다). `kind` 를
 * 남기는 목적은 ④에서 "액션 행에 base 를 붙였는지"를 기계적으로 검증하기 위해서다.
 */
import { directionAnchorStates, stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";

export type PlanRef =
  | { kind: "base"; ref: "locked-base" }
  | { kind: "anchor"; ref: string } // ref = direction
  | { kind: "layout-guide"; ref: string }; // ref = state

export type PlanItem = {
  state: string;
  role: "direction-anchor" | "action-row";
  direction: string;
  refs: PlanRef[];
  note: string;
};

export type MirroredDirection = { direction: string; mirrorOf: string; note: string };

export type GenerationPlan = {
  version: 1;
  kind: "sprite-gen-generation-plan";
  order: [
    { stage: 1; name: "direction-anchors"; items: PlanItem[] },
    { stage: 2; name: "action-rows"; items: PlanItem[] },
  ];
  mirroredDirections: MirroredDirection[];
};

const ANCHOR_NOTE =
  "base 는 방향 앵커 생성까지만 identity 소스다 — 앵커 수락 후 행 생성에 base 를 재부착하지 않는다";

const ROW_NOTE =
  "앵커 ref 는 파생 캐시다 — 생성 직전 bakeAnchorImage 로 큐레이션 진실에서 다시 굽는다. " +
  "정적 스냅샷을 재사용하면 사용자가 프레임을 편집·제외한 순간 소리 없이 낡는다";

function mirrorNote(source: string): string {
  return (
    "생성 생략 — 런타임 미러가 기본. 미러로 부족해 재생성할 때는 반대편 행" +
    `(${source} 행)을 timing/scale 참조로만 부착하고, 대상 방향 앵커를 새로 뽑아 identity 로 쓴다`
  );
}

export function buildGenerationPlan(request: SpriteRequest): GenerationPlan | null {
  const directions = request.directions;
  if (!directions) return null;

  const anchors = directionAnchorStates(directions);
  const anchorNames = new Set(Object.values(anchors));

  const stageAnchors: PlanItem[] = directions.set.map(d => ({
    state: anchors[d],
    role: "direction-anchor",
    direction: d,
    refs: [
      { kind: "base", ref: "locked-base" },
      { kind: "layout-guide", ref: anchors[d] },
    ],
    note: ANCHOR_NOTE,
  }));

  const stageRows: PlanItem[] = [];
  for (const state of Object.keys(request.states)) {
    if (anchorNames.has(state)) continue;
    const direction = stateDirection(state, directions);
    if (direction === null) continue;
    stageRows.push({
      state,
      role: "action-row",
      direction,
      refs: [
        { kind: "anchor", ref: direction },
        { kind: "layout-guide", ref: state },
      ],
      note: ROW_NOTE,
    });
  }

  return {
    version: 1,
    kind: "sprite-gen-generation-plan",
    order: [
      { stage: 1, name: "direction-anchors", items: stageAnchors },
      { stage: 2, name: "action-rows", items: stageRows },
    ],
    mirroredDirections: Object.entries(directions.mirror).map(([target, source]) => ({
      direction: target,
      mirrorOf: source,
      note: mirrorNote(source),
    })),
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-generation-plan.ts
```

Expected: `21 passed / 0 failed`

- [ ] **Step 5: Python 플랜과 구조 대조**

경로 필드는 다르므로(위 이탈 1) **구조**를 본다: stage 순서·항목 수·상태명·방향·
미러 항목이 같아야 한다.

```bash
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys, json; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from sprite_gen.prepare import build_generation_plan, normalize_directions, normalize_cell
states = {k: {'frames':8,'fps':8,'loop':True,'action':'a'} for k in ['down_idle','right_idle','down_walk','right_walk']}
req = {'states': states, 'cell': normalize_cell({},256,None),
       'directions': normalize_directions({'set':['down','right'],'mirror':{'left':'right'}}, states)}
p = build_generation_plan(req)
print(json.dumps({'stage1': [i['state'] for i in p['order'][0]['items']],
                  'stage2': [i['state'] for i in p['order'][1]['items']],
                  'stage2_dirs': [i['direction'] for i in p['order'][1]['items']],
                  'mirrored': [(m['direction'], m['mirror_of']) for m in p['mirrored_directions']]}, indent=2))
"
```

Expected: `stage1 = [down_idle, right_idle]`, `stage2 = [down_walk, right_walk]`,
`stage2_dirs = [down, right]`, `mirrored = [[left, right]]` 이 TS 와 일치.

- [ ] **Step 6: 체이닝하고 커밋**

```bash
git add src/lib/sprite/generation-plan.ts scripts/test-generation-plan.ts package.json
git commit -m "feat(sprite): 생성 플랜 SSoT — 앵커 먼저·행은 앵커 기반·미러는 생략 계약"
```

---

## Task 3: 방향 프롬프트 잠금 (②의 유보 해소)

**Files:**
- Modify: `src/lib/sprite/row-prompt.ts`
- Modify: `scripts/test-row-prompt.ts`

**Interfaces:**
- Consumes: `DirectionsSpec`·`directionAnchorStates`·`stateDirection`·`facingOf` (Task 1)
- Produces:
  - `directionalParts(state: string): { depth: "front"|"back"; side: "left"|"right" } | null`
  - `directionalRequirements(state: string): string[]`
  - `directionPrefixRequirements(request: SpriteRequest, state: string): string[]`
  - `buildRowPrompt` 는 시그니처가 바뀌지 않는다 — `request.directions` 를 스스로 읽는다

### 참조 원본

- `sprite_gen/prepare.py:694-713` — `direction_prefix_requirements`
- `sprite_gen/prepare.py:716-743` — `directional_parts` · `directional_requirements`
- `sprite_gen/prepare.py:859-868` — `row_prompt` 의 합성 순서 (**접두사 → 접미사 → STATE_REQUIREMENTS**)

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-row-prompt.ts` 의 마지막 `console.log(\`\n${passed}...\`)` 직전에 삽입:

```ts
console.log("=== 방향 접두사 잠금 (directions 블록) ===");
{
  const directions = { set: ["down", "right"], mirror: { left: "right" }, anchorSuffix: "idle" };
  const dirReq = { ...request, directions };
  const anchorRow = buildRowPrompt(dirReq, "down_idle", { frames: 4, fps: 4, loop: true, action: "idle" });
  const actionRow = buildRowPrompt(dirReq, "down_walk", { frames: 8, fps: 8, loop: true, action: "walk" });

  check("facing 잠금이 붙는다", /Lock the whole row to facing the viewer \(front view\)/.test(anchorRow));
  check("평균화 금지 문구", /Do not average it into a different facing/.test(anchorRow));
  check("앵커 행은 CANONICAL DIRECTION ANCHOR 로 선언된다",
    /This row is the CANONICAL DIRECTION ANCHOR/.test(anchorRow));
  check("앵커 행은 base 에서 identity 를 가져오라고 한다",
    /derive identity from the attached base image/.test(anchorRow));
  check("앵커 행은 포즈를 최소로 요구한다", /keep poses minimal/.test(anchorRow));
  check("액션 행은 앵커에서 identity", /Derive identity from the attached accepted direction anchor/.test(actionRow));
  check("액션 행은 base 사용을 금지한다", /not from any base character image/.test(actionRow));
  check("액션 행에 CANONICAL 선언이 없다", !/CANONICAL DIRECTION ANCHOR/.test(actionRow));
  check("directions 없으면 접두사 블록도 없다", !/Lock the whole row to/.test(p));
}

console.log("=== 45도 접미사 잠금 (directions 블록 없이도 동작) ===");
{
  const fr = buildRowPrompt(request, "running-front-right", { frames: 8, fps: 8, loop: true, action: "run" });
  check("3/4 정면 + camera-right 잠금",
    /Lock the whole row to a 45-degree three-quarter-front view facing camera-right and slightly toward the viewer/.test(fr));
  check("정면·후면·순수 측면으로 평균화 금지",
    /Do not average this into a straight front, straight back, or pure side-view sprite/.test(fr));
  check("타깃 방향 앵커가 최우선 facing 근거",
    /its facing direction is authoritative and overrides any paired-row reference/.test(fr));
  check("방향 시트는 facing 전용", /use it as the direction SSoT for facing only/.test(fr));
  check("right 에는 basis 행 조항이 없다", !/basis row is attached/.test(fr));

  const fl = buildRowPrompt(request, "running-front-left", { frames: 8, fps: 8, loop: true, action: "run" });
  check("left 는 3/4 정면 camera-left", /facing camera-left and slightly toward the viewer/.test(fl));
  check("left 에는 basis 행을 timing 전용으로 쓰라는 조항이 붙는다",
    /use it only for timing, scale, and pose-family consistency; change the facing to camera-left/.test(fl));

  const br = buildRowPrompt(request, "working-back-right", { frames: 6, fps: 6, loop: true, action: "work" });
  check("back 은 3/4 후면 + away from the viewer",
    /three-quarter-back view facing camera-right and slightly away from the viewer/.test(br));

  check("접미사가 없으면 블록도 없다", !/45-degree three-quarter/.test(p));
}

console.log("=== 합성 순서 — 접두사 → 접미사 → STATE_REQUIREMENTS ===");
{
  const directions = { set: ["down"], mirror: {}, anchorSuffix: "idle" };
  const both = buildRowPrompt(
    { ...request, directions },
    "down_walk",
    { frames: 8, fps: 8, loop: true, action: "walk" },
  );
  const iPrefix = both.indexOf("Lock the whole row to facing the viewer");
  const iState = both.indexOf("Show locomotion through body, arm, leg");
  check("접두사 항목이 STATE_REQUIREMENTS 보다 앞", iPrefix > -1 && iState > iPrefix,
    `prefix=${iPrefix} state=${iState}`);
}
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-row-prompt.ts
```

Expected: 방향 관련 단언들이 FAIL.

- [ ] **Step 3: `row-prompt.ts` 를 확장한다**

파일 상단 import 에 추가:

```ts
import { directionAnchorStates, facingOf, stateDirection } from "@/lib/sprite/directions";
```

`buildRowPrompt` 위에 두 함수를 추가한다:

```ts
/** 방향 계약 런의 방향 잠금 — 앵커 행은 base 기반, 일반 행은 앵커 기반. */
export function directionPrefixRequirements(request: SpriteRequest, state: string): string[] {
  const directions = request.directions ?? null;
  const direction = stateDirection(state, directions);
  if (direction === null || directions === null) return [];
  const requirements = [
    `Lock the whole row to ${facingOf(direction)}. Do not average it into a different facing.`,
  ];
  if (state === directionAnchorStates(directions)[direction]) {
    requirements.push(
      "This row is the CANONICAL DIRECTION ANCHOR for this facing: derive identity from the " +
        "attached base image, change only the facing/orientation, and keep poses minimal " +
        "(subtle breathing) so a single frame can be cropped as the anchor.",
    );
  } else {
    requirements.push(
      "Derive identity from the attached accepted direction anchor for this facing, " +
        "not from any base character image.",
    );
  }
  return requirements;
}

export function directionalParts(
  state: string,
): { depth: "front" | "back"; side: "left" | "right" } | null {
  const m = /-(front|back)-(left|right)$/.exec(state);
  if (!m) return null;
  return { depth: m[1] as "front" | "back", side: m[2] as "left" | "right" };
}

/** 상태명 접미사(`-front-right` 등)로 판정하는 45도 잠금. directions 블록과 독립이다. */
export function directionalRequirements(state: string): string[] {
  const parts = directionalParts(state);
  if (!parts) return [];
  const { depth, side } = parts;
  const toward = depth === "front" ? "toward the viewer" : "away from the viewer";
  const bodyView = depth === "front" ? "three-quarter-front" : "three-quarter-back";
  const cameraSide = `camera-${side}`;
  const oppositeSide = side === "right" ? "left" : "right";
  const requirements = [
    `Lock the whole row to a 45-degree ${bodyView} view facing ${cameraSide} and slightly ${toward}.`,
    "Do not average this into a straight front, straight back, or pure side-view sprite.",
    `Make ${cameraSide} readable through face/body orientation, hair silhouette, shoulder overlap, hand/foot placement, and prop angle.`,
    "If a 4-direction reference sheet is attached, use it as the direction SSoT for facing only; do not copy its pose or state.",
    "If a single target-direction anchor is attached, its facing direction is authoritative and overrides any paired-row reference.",
  ];
  if (side === "left") {
    requirements.push(
      `If a generated ${depth}-${oppositeSide} basis row is attached, use it only for timing, scale, and pose-family consistency; change the facing to camera-left.`,
    );
  }
  return requirements;
}
```

`buildRowPrompt` 안의 `stateRequirements` 계산을 원본 합성 순서로 바꾼다
(`prepare.py:859-863`):

```ts
  const stateRequirements = [
    ...directionPrefixRequirements(request, state),
    ...directionalRequirements(state),
    ...(STATE_REQUIREMENTS[state] ?? []),
  ];
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-row-prompt.ts
```

- [ ] **Step 5: Python 프롬프트와 diff 로 대조한다**

②에서 attack 은 공백 1줄 외 완전 일치를 확인했다. 이번엔 **방향 상태 4종**으로 확인한다.

```bash
SP=/private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad
for ST in down_idle down_walk running-front-right running-front-left; do
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from sprite_gen.prepare import row_prompt, normalize_cell, normalize_directions, STYLE_DEFAULT
states = {'down_idle': {'frames':4}, 'down_walk': {'frames':8}, 'running-front-right': {'frames':8}, 'running-front-left': {'frames':8}}
req = {'cell': normalize_cell({},256,None), 'chroma_key': {'name':'green','hex':'#00FF00','rgb':[0,255,0]},
       'character': {'id':'aurora','description':'d'}, 'style': STYLE_DEFAULT,
       'directions': normalize_directions({'set':['down'],'mirror':{}}, {'down_idle':{},'down_walk':{}}) if '$ST'.startswith('down') else None}
print(row_prompt(req, '$ST', {'frames':8,'fps':8,'loop':True,'action':'a'}))
" > $SP/r3-$ST.txt
  # TS 쪽도 같은 입력으로 뽑아 $SP/m3-$ST.txt 에 저장 (Task 2 Step 5 의 스크립트 패턴 재사용)
  printf "%-24s " "$ST"
  diff -B -q $SP/r3-$ST.txt $SP/m3-$ST.txt >/dev/null && echo "일치" || { echo "차이:"; diff -B $SP/r3-$ST.txt $SP/m3-$ST.txt | head -10; }
done
```

Expected: 4종 모두 공백 외 차이 없음. **차이가 나면 멈춘다** — 방향 문구는 facing 잠금의
전부이므로 한 줄이라도 빠지면 행이 다른 방향으로 평균화된다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/sprite/row-prompt.ts scripts/test-row-prompt.ts
git commit -m "feat(sprite): row 프롬프트 방향 잠금 — 접두사 계약과 45도 접미사 규약"
```

---

## Task 4: 큐레이션 기록과 앵커 해석

**Files:**
- Create: `src/lib/sprite/anchor.ts`
- Modify: `src/lib/db/repo/generations.ts`
- Test: `scripts/test-anchor.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DirectionsSpec`·`directionAnchorStates`·`stateDirection` (Task 1), `SpriteRequest`
- Produces:
  - `type CurationRecord = { order: number[]; excluded: number[] }`
  - `type AnchorPick = { generationId: string; index: number }`
  - `type AnchorContext = { request: SpriteRequest; picks: Record<string, AnchorPick>; rows: Record<string, { generationId: string; frameCount: number; curation: CurationRecord | null }> }`
  - `class AnchorUnavailable extends Error { kind: string; pending: boolean }`
  - `curatedSequence(frameCount: number, curation: CurationRecord | null): number[]`
  - `resolveAnchor(ctx: AnchorContext, direction: string): { direction: string; state: string; index: number; source: "picked" | "default" }`
  - DB: `saveCuration(generationId, CurationRecord)` · `getCuration(generationId)` ·
    `pinAnchorFrame(sessionId, direction, AnchorPick)` · `clearAnchorPick(sessionId, direction)` ·
    `getAnchorPicks(sessionId)`

### 저장 위치 — 새 테이블을 만들지 않는다

- **큐레이션**은 그 행의 `generations.params.curation` 에 둔다. 큐레이션은 행 하나의 속성이고
  행이 재생성되면 새 `generationId` 와 함께 자연히 폐기된다.
- **앵커 지정(pin)**은 스코프당 1개인 **잠긴 base 의** `params.anchorPicks[direction]` 에 둔다.
  ①이 "base 는 스코프당 딱 1장"을 이미 강제했으므로(`lockBaseGeneration`), run 스코프
  메타데이터를 걸 자리로 base 가 유일하게 안정적이다.

  **대안이었던 것**: `sprite_runs` 테이블 신설. 마이그레이션 + schema.sql + types/db.ts
  3중 동기화 비용이 들고(CLAUDE.md), ③ 시점엔 run 개념을 쓰는 코드가 없어 미뤘다.
  ④에서 run 이 실체를 가지면 그때 옮긴다.

### pending 과 broken 을 가른다

| kind | 분류 | 뜻 |
|---|---|---|
| `no-anchor-row` | **pending** | 그 방향의 앵커 행이 아직 요청에 없다 |
| `row-not-generated` | **pending** | 앵커 행을 아직 생성하지 않았다 — stage 1 진행 중의 정상 구간 |
| `unknown-direction` | broken | 생성 방향 목록에 없는 방향 |
| `empty-sequence` | broken | 큐레이션이 프레임을 전부 제외했다 |
| `pick-unknown-generation` | broken | 지정이 이 런에 없는 generation 을 가리킨다 |
| `pick-wrong-direction` | broken | 다른 방향의 프레임을 지정했다 |
| `pick-missing` | broken | 지정한 인덱스가 큐레이션 시퀀스에 없다(제외됐다) |

**pending 을 오류색으로 칠하면 안 된다** — 작업 중간 런에 빨간 경고가 뜬다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-anchor.ts` (Task 4 부분):

```ts
/**
 * ③ Task 4·5 — 앵커 해석과 베이크 테스트.
 *
 * 핵심 단언: 큐레이션 시퀀스 헤드는 **index 0 이 아니다**. 앞 프레임을 제외/재정렬하면
 * 앵커가 따라 움직여야 한다 (sprite-gen 2026-07-19 실사고).
 */
import {
  AnchorUnavailable,
  curatedSequence,
  resolveAnchor,
  type AnchorContext,
} from "../src/lib/sprite/anchor";
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
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
function kindOf(fn: () => unknown): string {
  try { fn(); return "(no throw)"; }
  catch (e) { return e instanceof AnchorUnavailable ? e.kind : `(${String(e)})`; }
}

console.log("=== curatedSequence ===");
check("큐레이션 없으면 0..n-1", curatedSequence(4, null).join(",") === "0,1,2,3");
check("제외를 뺀다", curatedSequence(4, { order: [0, 1, 2, 3], excluded: [0, 1] }).join(",") === "2,3");
check("재정렬을 따른다", curatedSequence(4, { order: [3, 2, 1, 0], excluded: [] }).join(",") === "3,2,1,0");
check("재정렬 + 제외", curatedSequence(4, { order: [3, 2, 1, 0], excluded: [3] }).join(",") === "2,1,0");
check("order 길이가 안 맞으면 무시하고 원본 순서",
  curatedSequence(4, { order: [1, 0], excluded: [] }).join(",") === "0,1,2,3");
check("전부 제외면 빈 배열", curatedSequence(2, { order: [0, 1], excluded: [0, 1] }).length === 0);

const S = (frames = 4): StateSpec => ({ frames, fps: 4, loop: true, action: "a" });

function ctx(opts: {
  rows?: AnchorContext["rows"];
  picks?: AnchorContext["picks"];
  states?: Record<string, StateSpec>;
} = {}): AnchorContext {
  const states = opts.states ?? { down_idle: S(4), down_walk: S(8) };
  const directions = normalizeDirections({ set: ["down"], mirror: { left: "down" } }, states)!;
  const request: SpriteRequest = {
    version: 1,
    character: { id: "a", description: "d", anchorGenerationId: "gen_base" },
    cell: normalizeCell({}),
    chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
    chroma: DEFAULT_CHROMA_TUNABLES,
    states,
    directions,
  };
  return { request, picks: opts.picks ?? {}, rows: opts.rows ?? {} };
}

console.log("=== resolveAnchor — 기본 경로 (큐레이션 시퀀스 헤드) ===");
{
  const c = ctx({ rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } } });
  const a = resolveAnchor(c, "down");
  check("큐레이션 없으면 index 0", a.index === 0 && a.state === "down_idle" && a.source === "default");
}
{
  // 실사고 재현: 0·1·2 를 제외했으면 앵커는 3 이다. index 0 이면 삭제된 프레임이 identity 가 된다.
  const c = ctx({
    rows: { down_idle: { generationId: "g1", frameCount: 4, curation: { order: [0, 1, 2, 3], excluded: [0, 1, 2] } } },
  });
  check("앞 프레임을 제외하면 앵커가 따라 움직인다 (index 0 아님)", resolveAnchor(c, "down").index === 3);
}
{
  const c = ctx({
    rows: { down_idle: { generationId: "g1", frameCount: 4, curation: { order: [2, 0, 1, 3], excluded: [] } } },
  });
  check("재정렬하면 시퀀스 헤드가 앵커", resolveAnchor(c, "down").index === 2);
}

console.log("=== resolveAnchor — pending (오류색 금지) ===");
{
  const c = ctx({ rows: {} });
  check("앵커 행 미생성은 row-not-generated", kindOf(() => resolveAnchor(c, "down")) === "row-not-generated");
  try { resolveAnchor(c, "down"); } catch (e) {
    check("row-not-generated 는 pending", e instanceof AnchorUnavailable && e.pending === true);
  }
}
{
  const c = ctx({ states: { down_walk: S(8) }, rows: {} });
  check("앵커 상태 자체가 없으면 no-anchor-row", kindOf(() => resolveAnchor(c, "down")) === "no-anchor-row");
  try { resolveAnchor(c, "down"); } catch (e) {
    check("no-anchor-row 도 pending", e instanceof AnchorUnavailable && e.pending === true);
  }
}

console.log("=== resolveAnchor — broken ===");
{
  const c = ctx({ rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } } });
  check("생성 목록에 없는 방향", kindOf(() => resolveAnchor(c, "up")) === "unknown-direction");
  try { resolveAnchor(c, "up"); } catch (e) {
    check("unknown-direction 은 broken", e instanceof AnchorUnavailable && e.pending === false);
  }
}
{
  const c = ctx({
    rows: { down_idle: { generationId: "g1", frameCount: 2, curation: { order: [0, 1], excluded: [0, 1] } } },
  });
  check("전부 제외하면 empty-sequence", kindOf(() => resolveAnchor(c, "down")) === "empty-sequence");
}

console.log("=== resolveAnchor — 지정(pin) ===");
{
  const c = ctx({
    rows: {
      down_idle: { generationId: "g1", frameCount: 4, curation: null },
      down_walk: { generationId: "g2", frameCount: 8, curation: null },
    },
    picks: { down: { generationId: "g2", index: 5 } },
  });
  const a = resolveAnchor(c, "down");
  check("지정이 기본값을 이긴다", a.source === "picked" && a.state === "down_walk" && a.index === 5);
}
{
  // 정본: 시퀀스에 없는 후보 프레임도 지정 가능 — 단 살아 있어야 한다.
  const c = ctx({
    rows: { down_idle: { generationId: "g1", frameCount: 4, curation: { order: [0, 1, 2, 3], excluded: [1] } } },
    picks: { down: { generationId: "g1", index: 1 } },
  });
  check("제외된 프레임 지정은 pick-missing", kindOf(() => resolveAnchor(c, "down")) === "pick-missing");
}
{
  const c = ctx({
    rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } },
    picks: { down: { generationId: "gone", index: 0 } },
  });
  check("사라진 generation 지정은 pick-unknown-generation",
    kindOf(() => resolveAnchor(c, "down")) === "pick-unknown-generation");
  check("조용한 폴백이 아니다 (기본값으로 돌아가지 않는다)",
    kindOf(() => resolveAnchor(c, "down")) !== "(no throw)");
}
{
  const states = { down_idle: S(4), down_walk: S(8), right_idle: S(4) };
  const directions = normalizeDirections({ set: ["down", "right"], mirror: {} }, states)!;
  const c: AnchorContext = {
    request: {
      version: 1, character: { id: "a", description: "d", anchorGenerationId: "gb" },
      cell: normalizeCell({}), chroma: DEFAULT_CHROMA_TUNABLES,
      chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
      states, directions,
    },
    picks: { down: { generationId: "gr", index: 0 } },
    rows: {
      down_idle: { generationId: "g1", frameCount: 4, curation: null },
      right_idle: { generationId: "gr", frameCount: 4, curation: null },
    },
  };
  check("다른 방향 프레임 지정은 pick-wrong-direction",
    kindOf(() => resolveAnchor(c, "down")) === "pick-wrong-direction");
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-anchor.ts
```

- [ ] **Step 3: `anchor.ts` 를 구현한다**

```ts
/**
 * 방향 앵커 = 사람이 승인한 **단 한 장** — sprite_gen/anchor.py 이식.
 *
 *     지정(pin)  >  그 방향 앵커 행의 큐레이션 시퀀스 첫 인스턴스
 *
 * 두 번째가 기본값이다(명시 기본값 — 폴백이 아니다). index 0 이 아니라 **시퀀스 첫
 * 인스턴스**인 이유: 사용자가 앞 프레임을 제외/재정렬했으면 index 0 은 기각분이다
 * (sprite-gen 실사고 2026-07-19 — side_idle 이 0·1·2 제외 후 3부터라 index 0 베이크가
 * 제외된 프레임을 앵커로 만들었다).
 *
 * 사라진 프레임을 가리키는 지정은 fail-loud 다 — 조용히 기본값으로 되돌리면
 * "지정했는데 왜 안 먹지"를 사용자가 영원히 못 본다 (No Silent Fallback).
 */
import { directionAnchorStates, stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";

/** 표시 순서와 제외 집합. SpriteCanvas 의 frameOrder/excludedFrames 와 같은 뜻이다. */
export type CurationRecord = { order: number[]; excluded: number[] };

/**
 * 앵커 지정. sprite-gen 은 `{state, index}` + `state_revision` 을 쓰지만 우리는
 * `generationId` 를 쓴다 — 행을 다시 생성하면 새 id 가 나오므로 낡은 지정은 정의상
 * 존재하지 않는 행을 가리킨다. 원본의 pick-stale-generation·pick-unverifiable 이
 * pick-unknown-generation 하나로 합쳐지는 이유다.
 */
export type AnchorPick = { generationId: string; index: number };

export type AnchorRow = {
  generationId: string;
  frameCount: number;
  curation: CurationRecord | null;
};

export type AnchorContext = {
  request: SpriteRequest;
  /** direction → 지정 */
  picks: Record<string, AnchorPick>;
  /** state → 생성된 행 */
  rows: Record<string, AnchorRow>;
};

/**
 * 앵커를 지금 낼 수 없다. `kind` 가 **"아직"(pending)** 과 **"깨졌다"(broken)** 를 가른다.
 * 두 상태는 사용자에게 전혀 다른 뜻이다 — pending 은 생성이 거기까지 안 온 정상 구간이고,
 * broken 은 사람이 고쳐야 하는 것이다. 이 구분이 없으면 뷰가 멀쩡한 작업 중간 런에
 * 빨간 오류를 띄운다.
 */
export class AnchorUnavailable extends Error {
  static readonly PENDING_KINDS = new Set(["no-anchor-row", "row-not-generated"]);
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "AnchorUnavailable";
    this.kind = kind;
  }

  get pending(): boolean {
    return AnchorUnavailable.PENDING_KINDS.has(this.kind);
  }
}

/** 재생·내보내기가 따르는 그 순서. order 길이가 프레임 수와 다르면 원본 순서로 본다. */
export function curatedSequence(frameCount: number, curation: CurationRecord | null): number[] {
  const natural = Array.from({ length: frameCount }, (_, i) => i);
  if (!curation) return natural;
  const order = curation.order.length === frameCount ? curation.order : natural;
  const excluded = new Set(curation.excluded);
  return order.filter(i => !excluded.has(i));
}

export function resolveAnchor(
  ctx: AnchorContext,
  direction: string,
): { direction: string; state: string; index: number; source: "picked" | "default" } {
  const directions = ctx.request.directions ?? null;
  if (!directions || !directions.set.includes(direction)) {
    throw new AnchorUnavailable(
      "unknown-direction",
      `anchor: '${direction}' is not a generated direction (${directions?.set.join(", ") || "run has no directions block"})`,
    );
  }

  const pick = ctx.picks[direction];
  if (pick) {
    const entry = Object.entries(ctx.rows).find(([, r]) => r.generationId === pick.generationId);
    if (!entry) {
      throw new AnchorUnavailable(
        "pick-unknown-generation",
        `anchor: pinned anchor frame ${pick.generationId}#${pick.index} is not a row of this run ` +
          `(the row was regenerated or removed) — re-pick the anchor frame`,
      );
    }
    const [state, row] = entry;
    const owner = stateDirection(state, directions);
    if (owner !== direction) {
      throw new AnchorUnavailable(
        "pick-wrong-direction",
        `anchor: pinned frame ${state}#${pick.index} belongs to direction '${owner}', not '${direction}' — an anchor owns its own facing`,
      );
    }
    if (!curatedSequence(row.frameCount, row.curation).includes(pick.index)) {
      throw new AnchorUnavailable(
        "pick-missing",
        `anchor: pinned anchor frame ${state}#${pick.index} is not in the curated sequence ` +
          `(excluded, or out of range) — re-pick the anchor frame`,
      );
    }
    return { direction, state, index: pick.index, source: "picked" };
  }

  const state = directionAnchorStates(directions)[direction];
  if (!(state in ctx.request.states)) {
    throw new AnchorUnavailable(
      "no-anchor-row",
      `anchor: direction '${direction}' has no anchor row '${state}' and no pinned anchor frame — declare/generate the anchor row, or pin a frame of this direction`,
    );
  }
  const row = ctx.rows[state];
  if (!row) {
    throw new AnchorUnavailable(
      "row-not-generated",
      `anchor: anchor row '${state}' has not been generated yet`,
    );
  }
  const ordered = curatedSequence(row.frameCount, row.curation);
  if (ordered.length === 0) {
    throw new AnchorUnavailable(
      "empty-sequence",
      `anchor: '${state}' has an empty curated sequence — nothing to use as the direction anchor (restore a frame, or pin one explicitly)`,
    );
  }
  return { direction, state, index: ordered[0], source: "default" };
}
```

- [ ] **Step 4: DB 기록 함수를 추가한다**

`src/lib/db/repo/generations.ts` 끝에 추가. ①의 `lockBaseGeneration` 바로 아래에 둔다.

```ts
/**
 * 행의 큐레이션(표시 순서·제외)을 저장한다.
 *
 * 앵커는 사람이 화면에서 승인한 모습이어야 하므로, 앵커 해석이 이 기록을 읽는다.
 * 이 값이 없으면 resolveAnchor 는 index 0 을 앵커로 삼는데, 사용자가 앞 프레임을
 * 제외한 런에서 그것은 기각분이다 (sprite-gen 실사고 2026-07-19).
 */
export function saveCuration(
  generationId: string,
  curation: { order: number[]; excluded: number[] },
): void {
  const db = getDb();
  const row = db.prepare("SELECT params FROM generations WHERE id = ?").get(generationId) as
    | { params: string | null }
    | undefined;
  if (!row) throw new Error(`saveCuration: generation ${generationId} 이(가) 없습니다`);
  const params = row.params ? (JSON.parse(row.params) as Record<string, unknown>) : {};
  params.curation = { order: curation.order, excluded: curation.excluded };
  db.prepare("UPDATE generations SET params = ? WHERE id = ?").run(
    JSON.stringify(params),
    generationId,
  );
}

export function getCuration(
  generationId: string,
): { order: number[]; excluded: number[] } | null {
  const gen = getGeneration(generationId);
  const c = gen?.params?.curation as { order?: number[]; excluded?: number[] } | undefined;
  if (!c || !Array.isArray(c.order) || !Array.isArray(c.excluded)) return null;
  return { order: c.order, excluded: c.excluded };
}

/**
 * 방향 앵커 프레임을 지정한다.
 *
 * 저장 위치가 잠긴 base 인 이유: 지정은 run 스코프 메타데이터인데 우리에게 run 테이블이
 * 없다. ①이 "base 는 스코프당 딱 1장"을 강제하므로 base 가 유일하게 안정적인 자리다.
 * ④에서 run 이 실체를 가지면 옮긴다.
 */
export function pinAnchorFrame(
  sessionId: string | null,
  direction: string,
  pick: { generationId: string; index: number },
): void {
  const base = getLockedBase(sessionId);
  if (!base) throw new Error("pinAnchorFrame: 잠긴 base 가 없습니다 — 먼저 base 를 잠그세요");
  const params = { ...base.params };
  const picks = { ...((params.anchorPicks as Record<string, unknown>) ?? {}) };
  picks[direction] = { generationId: pick.generationId, index: pick.index };
  params.anchorPicks = picks;
  getDb()
    .prepare("UPDATE generations SET params = ? WHERE id = ?")
    .run(JSON.stringify(params), base.id);
}

export function clearAnchorPick(sessionId: string | null, direction: string): void {
  const base = getLockedBase(sessionId);
  if (!base) return;
  const params = { ...base.params };
  const picks = { ...((params.anchorPicks as Record<string, unknown>) ?? {}) };
  delete picks[direction];
  params.anchorPicks = picks;
  getDb()
    .prepare("UPDATE generations SET params = ? WHERE id = ?")
    .run(JSON.stringify(params), base.id);
}

export function getAnchorPicks(
  sessionId: string | null,
): Record<string, { generationId: string; index: number }> {
  const base = getLockedBase(sessionId);
  const picks = base?.params?.anchorPicks as
    | Record<string, { generationId?: string; index?: number }>
    | undefined;
  if (!picks) return {};
  const out: Record<string, { generationId: string; index: number }> = {};
  for (const [dir, p] of Object.entries(picks)) {
    if (typeof p?.generationId === "string" && typeof p?.index === "number") {
      out[dir] = { generationId: p.generationId, index: p.index };
    }
  }
  return out;
}
```

DB 테스트를 `scripts/test-anchor.ts` 에 추가한다 — `test-base-gate.ts` 가 임시 DB 를
세우는 방식을 그대로 따른다(그 파일의 DB 셋업 블록을 읽고 같은 패턴을 쓸 것):

```ts
console.log("=== DB — 큐레이션과 지정 ===");
// saveCuration → getCuration 왕복, pinAnchorFrame → getAnchorPicks 왕복,
// clearAnchorPick 이 그 방향만 지우는지, base 없이 pin 하면 throw 하는지를 단언한다.
```

- [ ] **Step 5: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-anchor.ts
```

- [ ] **Step 6: 체이닝하고 커밋**

```bash
git add src/lib/sprite/anchor.ts src/lib/db/repo/generations.ts scripts/test-anchor.ts package.json
git commit -m "feat(sprite): 앵커 해석 — 큐레이션 시퀀스 헤드와 pending/broken 구분"
```

---

## Task 5: 앵커 이미지 베이크

**Files:**
- Create: `src/lib/sprite/anchor-image.ts`
- Modify: `scripts/test-anchor.ts`

**Interfaces:**
- Consumes: `CellSpec` (②), `resolveAnchor` (Task 4)
- Produces:
  - `ANCHOR_SCALE = 8` · `CONTENT_ALPHA_FLOOR = 40`
  - `contentBBox(raw, w, h, channels, floor?): BBox | null`
  - `bakeAnchorImage(opts: { sheetPath: string; cell: CellSpec; cols: number; index: number; destPath: string; scale?: number }): Promise<{ contentSize: [number, number]; width: number; height: number }>`

### 참조 원본

- `sprite_gen/anchor.py:39-40` — `ANCHOR_SCALE = 8` · `CONTENT_ALPHA_FLOOR = 40`
- `sprite_gen/anchor.py:260-279` — `anchor_image` (콘텐츠 bbox 크롭 → ×8 NEAREST)

### 원본으로부터의 이탈 1건 — 프레임 소스

원본 `bake_frame` 은 **이미 추출된 프레임 파일**을 읽고 픽셀 편집·변형·pixel-unfake
재양자화를 다시 적용한다. 우리는 그 편집 레이어가 없고 내용 기반 추출은 ⑤ 범위다.

**이 단계에서는 시트 PNG + 셀 기하 + 인덱스로 셀을 잘라 쓴다** (`sharp.extract`). 지금
파이프라인이 하는 것과 같은 기하 크롭이며, ⑤의 내용 기반 추출은 그 정제다. ⑤ 이후
`bakeAnchorImage` 의 입력을 추출된 프레임으로 바꾸면 되고, 콘텐츠 bbox·×8 로직은 그대로다.

### ×8 확대의 목적

픽셀 데이터를 바꾸지 않는다. 작은 셀 스프라이트를 image_gen 이 읽을 수 있게 키우기만 한다.
**NEAREST 여야 한다** — 보간하면 도트 경계가 흐려져 레퍼런스의 픽셀 밀도가 왜곡되고,
그것이 곧 생성 행의 스타일이 된다(②의 스타일 SSoT 원칙).

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-anchor.ts` 에 추가:

```ts
console.log("=== contentBBox ===");
{
  // 32x32 투명 캔버스 중앙 8x8 불투명
  const w = 32, h = 32;
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 12; y < 20; y++) for (let x = 10; x < 18; x++) {
    const o = (y * w + x) * 4;
    raw[o] = 200; raw[o + 1] = 100; raw[o + 2] = 50; raw[o + 3] = 255;
  }
  const box = contentBBox(raw, w, h, 4)!;
  check("bbox 가 콘텐츠를 정확히 감싼다",
    box.x0 === 10 && box.y0 === 12 && box.x1 === 17 && box.y1 === 19,
    JSON.stringify(box));
}
{
  // 알파 39 는 콘텐츠가 아니다 (프린지). 40 부터 콘텐츠.
  const w = 8, h = 8;
  const raw = Buffer.alloc(w * h * 4);
  const set = (x: number, y: number, a: number) => { raw[(y * w + x) * 4 + 3] = a; };
  set(1, 1, 39); set(4, 4, 40);
  const box = contentBBox(raw, w, h, 4)!;
  check("알파 39 는 제외, 40 은 포함",
    box.x0 === 4 && box.y0 === 4 && box.x1 === 4 && box.y1 === 4, JSON.stringify(box));
}
{
  const raw = Buffer.alloc(4 * 4 * 4);
  check("전부 투명이면 null", contentBBox(raw, 4, 4, 4) === null);
}

console.log("=== bakeAnchorImage ===");
{
  const dir = await mkdtemp(join(tmpdir(), "anchor-"));
  try {
    // 4셀 가로 시트(각 32x32). 셀 2 에만 8x8 콘텐츠를 둔다.
    const cols = 4, cw = 32, ch = 32;
    const raw = Buffer.alloc(cols * cw * ch * 4);
    for (let y = 12; y < 20; y++) for (let x = 2 * cw + 10; x < 2 * cw + 18; x++) {
      const o = (y * cols * cw + x) * 4;
      raw[o] = 200; raw[o + 1] = 100; raw[o + 2] = 50; raw[o + 3] = 255;
    }
    const sheet = join(dir, "row.png");
    await sharp(raw, { raw: { width: cols * cw, height: ch, channels: 4 } }).png().toFile(sheet);

    const dest = join(dir, "anchor.png");
    const r = await bakeAnchorImage({
      sheetPath: sheet, cell: normalizeCell({ size: 32 }), cols, index: 2, destPath: dest,
    });
    check("콘텐츠 크기 8x8", r.contentSize[0] === 8 && r.contentSize[1] === 8, JSON.stringify(r.contentSize));
    check("×8 확대 = 64x64", r.width === 64 && r.height === 64);
    const meta = await sharp(dest).metadata();
    check("파일 치수가 일치", meta.width === 64 && meta.height === 64);

    // NEAREST 검증: 확대 결과에 원본에 없던 중간색이 없어야 한다.
    const out = await sharp(dest).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let interpolated = 0;
    for (let i = 0; i < out.info.width * out.info.height; i++) {
      const o = i * out.info.channels;
      const opaque = out.data[o + 3] === 255;
      const exact = out.data[o] === 200 && out.data[o + 1] === 100 && out.data[o + 2] === 50;
      if (opaque && !exact) interpolated++;
    }
    check("NEAREST — 보간된 중간색이 없다", interpolated === 0, `${interpolated} px`);

    let threw = false;
    try {
      await bakeAnchorImage({
        sheetPath: sheet, cell: normalizeCell({ size: 32 }), cols, index: 0, destPath: join(dir, "x.png"),
      });
    } catch { threw = true; }
    check("빈 셀은 empty-content 로 실패한다 (조용히 빈 이미지를 내지 않는다)", threw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-anchor.ts
```

- [ ] **Step 3: `anchor-image.ts` 를 구현한다**

```ts
/**
 * 앵커 ref 이미지 베이크 — sprite_gen/anchor.py `anchor_image()` 이식.
 *
 * 셀 크롭 → 콘텐츠 bbox 크롭 → ×8 NEAREST 확대. 픽셀 데이터는 그대로이고, 작은 셀
 * 스프라이트를 image_gen 이 읽을 수 있게 키우기만 한다. 보간하면 도트 경계가 흐려져
 * 레퍼런스의 픽셀 밀도가 왜곡되고, 그것이 곧 생성 행의 스타일이 된다.
 *
 * **파생 캐시다** — 생성 직전마다 큐레이션 진실에서 다시 굽고 그 자리를 덮어쓴다.
 * 정적 스냅샷을 재사용하면 사용자가 프레임을 편집·제외한 순간 소리 없이 낡고, 이후
 * 생성 행 전부가 옛 정체성을 물려받는다 (sprite-gen 실사고 2026-07-19).
 */
import sharp from "sharp";
import { AnchorUnavailable } from "@/lib/sprite/anchor";
import type { CellSpec } from "@/lib/sprite/request";

export const ANCHOR_SCALE = 8;
/** 콘텐츠 crop 기준 — 프린지 알파를 콘텐츠로 세지 않는다. */
export const CONTENT_ALPHA_FLOOR = 40;

export type BBox = { x0: number; y0: number; x1: number; y1: number };

export function contentBBox(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  floor: number = CONTENT_ALPHA_FLOOR,
): BBox | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = channels >= 4 ? raw[(y * width + x) * channels + 3] : 255;
      if (a < floor) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export async function bakeAnchorImage(opts: {
  sheetPath: string;
  cell: CellSpec;
  cols: number;
  index: number;
  destPath: string;
  scale?: number;
}): Promise<{ contentSize: [number, number]; width: number; height: number }> {
  const scale = opts.scale ?? ANCHOR_SCALE;
  const col = opts.index % opts.cols;
  const row = Math.floor(opts.index / opts.cols);

  const cellBuf = await sharp(opts.sheetPath)
    .extract({
      left: col * opts.cell.width,
      top: row * opts.cell.height,
      width: opts.cell.width,
      height: opts.cell.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const box = contentBBox(cellBuf.data, cellBuf.info.width, cellBuf.info.height, cellBuf.info.channels);
  if (!box) {
    throw new AnchorUnavailable(
      "empty-content",
      `anchor: baked anchor frame #${opts.index} is empty (no visible pixels)`,
    );
  }
  const cw = box.x1 - box.x0 + 1;
  const chh = box.y1 - box.y0 + 1;

  await sharp(cellBuf.data, {
    raw: {
      width: cellBuf.info.width,
      height: cellBuf.info.height,
      channels: cellBuf.info.channels as 1 | 2 | 3 | 4,
    },
  })
    .extract({ left: box.x0, top: box.y0, width: cw, height: chh })
    .resize(cw * scale, chh * scale, { kernel: "nearest" })
    .png()
    .toFile(opts.destPath);

  return { contentSize: [cw, chh], width: cw * scale, height: chh * scale };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-anchor.ts
```

- [ ] **Step 5: 실제 생성물로 검증한다 (합성 이미지로 끝내지 않는다)**

①에서 만든 실제 codex 생성 PNG(사과)를 4셀 시트로 취급해 베이크한다. 없으면
`pnpm exec tsx scripts/gen.ts --kind=text2img --prompt="..."` 로 하나 만든다.

```bash
SP=/private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad
# 실제 PNG 하나를 1셀 시트로 두고 index 0 을 베이크해 결과를 눈으로 본다
```

확인할 것:
1. 콘텐츠 bbox 가 피사체를 자르지 않는가 (①의 `subjectBBox` 결과와 비교)
2. **codex PNG 는 `channels: 3, hasAlpha: false` 다** — `ensureAlpha()` 가 전부 255 로
   채우므로 `contentBBox` 가 **셀 전체**를 돌려준다. 즉 크로마 배경이 살아 있는 raw
   생성물에서는 콘텐츠 크롭이 무의미하다. ①의 AA 검사와 같은 함정이다.
   → **이 사실을 실측으로 확인하고 결과를 보고에 적는다.** 알파 있는 입력(추출 후)에서만
   유효하다는 뜻이며, ⑤ 이후 정상 동작한다. 조용히 통과시키지 말 것.
3. ×8 결과가 도트 경계를 유지하는가

- [ ] **Step 6: 커밋**

```bash
git add src/lib/sprite/anchor-image.ts scripts/test-anchor.ts
git commit -m "feat(sprite): 앵커 이미지 베이크 — 콘텐츠 크롭과 x8 NEAREST"
```

---

## Task 6: 스펙 갱신과 전체 회귀

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md`

- [ ] **Step 1: 스펙 §8 의 ③ 절을 구현 결과로 갱신한다**

- 헤더 상태 줄을 "⓪①②③ 구현 완료"로
- 위 "정본 대조로 확인한 사실" 5건 중 **1·2·3·5** 를 §8 ③ 절에 옮긴다(4는 §6.3 프롬프트
  절이 적절하다). 특히 **큐레이션 미영속**은 ④의 전제 조건이므로 굵게 남긴다.
- Task 5 Step 5 의 실측 결과(알파 없는 raw 생성물에서 콘텐츠 크롭이 무의미하다는 것)를
  §7 검증표에 한 줄 추가

- [ ] **Step 2: ④의 진입 조건을 스펙에 명시한다**

§8 에 다음을 적는다 — ④ 계획을 쓸 때 이 목록이 Task 1 이 된다.

```
④는 통합 단계다. 첫 Task 는 반드시 다음이어야 한다:
1. SpriteCanvas 가 frameOrder/excludedFrames 를 saveCuration 으로 영속
2. 앵커 지정 UI (프레임 카드의 핀) → pinAnchorFrame
3. spritesheet-handler 가 buildGenerationPlan 순서대로 생성 (stage1 → stage2)
4. 액션 행 refs 에 base 가 없음을 런타임 검증 (PlanRef.kind 로 기계 확인)
5. codex 실왕복 1회 — 방향 앵커 1장 + 액션 행 1개
```

- [ ] **Step 3: 전체 테스트**

```bash
pnpm test
```

Expected: 기존 9개 + 신규 3개(`test-directions-contract`·`test-generation-plan`·`test-anchor`)
전부 통과. `test-row-prompt` 는 방향 단언이 늘어난 상태로 통과.

- [ ] **Step 4: 타입·린트 게이트**

```bash
pnpm exec tsc --noEmit && pnpm lint
```

Expected: 오류 0 (기존 경고 5건은 그대로).

- [ ] **Step 5: 커밋과 브랜치 마무리**

```bash
git add docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md
git commit -m "docs(spec): ③ 정본 대조 반영 — 앵커 규칙·큐레이션 미영속·④ 진입 조건"
```

**REQUIRED SUB-SKILL:** superpowers:finishing-a-development-branch

---

## 이 계획이 다루지 않는 것 (의도적)

| 항목 | 어디로 | 이유 |
|---|---|---|
| `SpriteCanvas` 가 큐레이션을 저장 | ④ | UI 배선. 계약(DB 함수)만 ③에서 만든다 |
| 앵커 지정 UI (핀 버튼) | ④ | 위와 같음 |
| `spritesheet-handler` 를 플랜 순서로 구동 | ④ | 생성 흐름 교체 그 자체 |
| 좌우 쌍 생성 순서 (basis 먼저 → paired 에 부착) | ④ | 실제 생성 없이 검증 불가. 프롬프트 조항은 ③에 있다 |
| 런타임 미러 실행 | ⑥ | 아틀라스·매니페스트가 미러 플래그를 노출해야 한다 |
| 내용 기반 프레임 추출 | ⑤ | ③은 기하 셀 크롭으로 간다 |
| 픽셀 편집 반영 (원본 `bake_frame` 의 편집 레이어) | 범위 밖 | 우리에게 그 레이어가 없다 |
| `state anchor`(비로코모션 상태 앵커) 게이트 | ④ | 정본 체크리스트 3번. 액션 행 생성과 함께 다뤄야 한다 |
| 비대칭 identity 게이트 QA | ⑥ | 정본 체크리스트 4번. 판정이 시각 QA다 |

## 자체 점검 결과

- **정본 커버리지**: 체크리스트 0(입력 게이트)=UI/④ · 1(base idle)=①완료 ·
  2(방향 게이트)=Task 1·4·5 · 3(상태 앵커)=④ · 4(비대칭)=Task 3 의 프롬프트 조항까지,
  QA 는 ⑥ · 5(행 생성 게이트)=Task 2 의 refs 계약 · 6(좌우 게이트)=Task 3 프롬프트 +
  ④ 생성 순서 · 7(QA 게이트)=⑥.
  **미커버 1건**: 체크리스트 3의 상태 앵커는 ③에 넣지 않았다 — 방향 앵커와 별개 개념이고
  액션 행 생성이 있어야 검증된다. ④ 진입 조건에 넣지 않았으므로 **④ 계획을 쓸 때 잊지 말 것**.
- **플레이스홀더**: Task 3 Step 5 의 TS 출력 스크립트와 Task 4 Step 4 의 DB 테스트 블록이
  "같은 패턴을 쓸 것"으로 남아 있다. 각각 Task 2 Step 5, `scripts/test-base-gate.ts` 라는
  구체적 참조 대상이 있으므로 구현자가 그것을 읽고 쓴다.
- **타입 일관성**: `DirectionsSpec`(Task 1) ↔ `SpriteRequest.directions`(Task 1) ↔
  `buildGenerationPlan`(Task 2) ↔ `AnchorContext.request`(Task 4) 가 같은 shape 를 쓴다.
  `CellSpec`(②) ↔ `bakeAnchorImage.cell`(Task 5) 도 동일. `AnchorUnavailable` 은 Task 4 가
  정의하고 Task 5 가 `empty-content` 로 재사용한다 — **`empty-content` 는 PENDING_KINDS 에
  없으므로 broken 이다.** 의도한 분류다(빈 프레임은 사람이 고쳐야 한다).
