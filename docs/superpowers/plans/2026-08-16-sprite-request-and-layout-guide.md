# ②단계 — SpriteRequest SSoT · 레이아웃 가이드 · row 프롬프트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 프롬프트 문자열에 흩어져 있던 셀 기하·크로마 키·상태 정의를 하나의 `SpriteRequest`
객체로 모으고, sprite-gen 의 `draw_guide()`·`row_prompt()` 를 이식해 행 생성의 입력 3종
(request · 레이아웃 가이드 PNG · row 프롬프트)을 만든다.

**Architecture:** 순수 모듈 4개(`request.ts`·`chroma-key.ts`·`layout-guide.ts`·`row-prompt.ts`).
DB·MCP·codex 를 모른다. 결정론 코드이므로 sprite-gen 을 기준 구현으로 삼아 **Python 출력과
직접 대조**한다.

**Tech Stack:** TypeScript / sharp (raw buffer) / tsx 수제 테스트 / 검증용 sprite-gen `.venv`

---

## Global Constraints

- 정본 계약은 sprite-gen `SKILL.md` 가 소유한다. leaf 문서와 충돌하면 SKILL.md 가 이긴다.
- Python 런타임 의존을 도입하지 않는다. `.venv` 는 **검증 시점에만** 쓰고 런타임·배포에 없다.
- `chroma.mode` 기본은 `rgb`. `ycbcr`·`alpha-centroid`·`projection`·`kcentroid` 는 옵트인이며
  이 단계 범위 밖이다 (스펙 §1.1).
- 스타일을 프롬프트 텍스트로 재기술하지 않는다. 스타일 SSoT 는 첨부 레퍼런스다.
- 테스트 프레임워크가 없다. `scripts/test-*.ts` + 수제 `check()` 로 쓰고 `package.json` 의
  `test` 에 체이닝한다 (기존 5개와 동일한 규약).
- 기존 상수 이름·값은 sprite-gen 과 동일하게 유지한다. 값을 "개선"하지 않는다.
- 브랜치는 `feat/sprite-request-layout-guide`. `main` 에서 직접 작업하지 않는다.

### 배선(wiring)은 이 단계 범위가 아니다

네 모듈은 만들어두고 **호출부에 연결하지 않는다.** ③앵커 체인·④row 생성이 생성 흐름 자체를
교체하므로, 지금 `spritesheet-handler.ts` 에 배선하면 ④에서 다시 뜯는다. ①의 `base-gate.ts`
가 아직 UI 에 붙지 않은 것과 같은 상태로 둔다.

**이 결정의 리스크**: ①②③ 의 미배선 코드가 누적되어 ④⑤ 전까지 사용자에게 보이는 변화가 없다.
④에서 한꺼번에 통합할 때 인터페이스 불일치가 드러날 수 있다. 각 모듈의 "Produces" 블록을
정확히 유지하는 것이 그 위험의 완화책이다.

---

## 정본 대조로 드러난 스펙 정정 3건

`docs/states-and-frames.md` 를 읽고 확인한 것. 스펙 §6 이 이 문서를 반영하지 않은 상태였다.

### 정정 1 — 프레임 수 기본값이 4다 (스펙에 없던 내용)

| 프레임 수 | 정본 분류 |
|---|---|
| 4 | 단순 동작의 **기본 안정 범위** |
| 5 | 비루프 제스처가 대기 복귀 포즈를 필요로 할 때 허용 |
| 6 | 인간형 one-shot 기본값의 **보수적 상한** |
| 8 | hatch-pet 급 **고급 영역**. 컴팩트 마스코트·로코모션 행·명시적 실험에만 |
| 9, 12 | **기본값이 아니다.** 검증 런에서 중복 몸통·빈 프레임·슬롯 붕괴·추출 실패가 늘었다 |

> 사용자가 9 또는 12 를 요구하면 명시적 실험으로 돌리고 `duplicate-heavy`·`blur/merge`·
> `extract-fail` 을 **정직하게 보고**한다. 정상 통과처럼 다루지 않는다.

### 정정 2 — 상태에 simple / experimental 등급이 있다

- **simple 안정**: `idle`(4f, loop) · `jump`(4f, non-loop) · `attack`(4f, non-loop) ·
  `wave`(4f, non-loop; 마지막 프레임이 의도적으로 1번으로 돌아갈 때만 5f)
- **simple 후보**: `talk` `blink` `bounce` `hurt` `celebrate` `magic_cast` — 허용하지만
  모션 QA 통과 전에는 pass 가 아니다
- **experimental**: `walk` `run` `frontwalk` `45_frontwalk` 및 모든 주기적 이동, 정확한
  발접지 교대·위상 대칭을 요구하는 방향 사이클

> 약한 walk/run 행을 simple MVP 산출물과 **같은 등급으로 조용히 승격하지 마라.**

### 정정 3 — 우리 패널 기본값이 정본의 실험/고급 대역에 있다

`SpriteGenPanel.tsx` 현재 상태:

| 항목 | 우리 현재값 | 정본 |
|---|---|---|
| `frames` 초기값 (215줄) | **8** | 4 |
| `seamlessLoop` 초기값 (216줄) | **true** | idle 만 true |
| 걷기·달리기 힌트 (115~116줄) | 8f / loop true | **experimental** 등급 |
| 공격 힌트 (119줄) | 6f | 4f |
| 점프 힌트 (120줄) | 6f | 4f |
| 시전·마법 힌트 (121줄) | 8f | `magic_cast` 는 simple 후보, 8f 는 고급 대역 |

**이 단계에서 패널을 고치지 않는다.** ②는 순수 모듈만 만들고, 패널 기본값은 스펙 §3.3
UI 체크포인트로 넘긴다 — ④에서 실제 생성 결과를 보고 조정해야 근거가 생긴다. 다만
`classifyState`·`frameCountAdvice` 를 Task 1 에서 만들어 **판정 수단은 먼저 확보**한다.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/lib/sprite/request.ts` (신규) | `SpriteRequest` 타입 · `normalizeCell` · `normalizeStates` · `classifyState` · `frameCountAdvice`. **순수** — sharp·fs 를 import 하지 않는다 |
| `src/lib/sprite/chroma-key.ts` (신규) | 베이스 샘플링 → 소재 픽셀 추출 → 크로마 키 자동 선택. sharp 로 이미지를 읽는다 |
| `src/lib/sprite/layout-guide.ts` (신규) | `draw_guide()` 이식. raw 버퍼에 사각형을 직접 채워 PNG 저장 |
| `src/lib/sprite/row-prompt.ts` (신규) | `row_prompt()` 이식. Prompt Contract 7항목 |
| `src/lib/sprite/base-gate.ts` (수정) | `colorDistance`·`rgbToHex` 를 export 로 승격 (chroma-key.ts 가 재사용) |
| `scripts/test-sprite-request.ts` (신규) | Task 1 테스트 |
| `scripts/test-chroma-key.ts` (신규) | Task 2·3 테스트 |
| `scripts/test-layout-guide.ts` (신규) | Task 4 테스트 — Python 픽셀 대조 |
| `scripts/test-row-prompt.ts` (신규) | Task 5 테스트 |
| `package.json` (수정) | `test` 에 4개 체이닝 |

**스펙 §6.4 로부터의 이탈 1건**: §6.4 는 크로마 키 선택을 `request.ts` 에 둔다. 분리한 이유는
`normalizeCell`·`normalizeStates` 는 순수 함수이고 크로마 선택은 sharp 이미지 IO 를 하기
때문이다. 한 파일에 두면 순수 부분 테스트가 픽스처 이미지를 요구하게 된다.

---

## Task 1: SpriteRequest 타입과 정규화 (순수)

**Files:**
- Create: `src/lib/sprite/request.ts`
- Test: `scripts/test-sprite-request.ts`
- Modify: `package.json:16`

**Interfaces:**
- Consumes: 없음 (이 단계의 첫 모듈)
- Produces:
  - `type CellSpec = { shape: "square"|"rect"; width: number; height: number; safeMarginX: number; safeMarginY: number }`
  - `type StateSpec = { frames: number; fps: number; loop: boolean; action: string }`
  - `type ChromaKeySpec` / `type ChromaTunables` / `type SpriteRequest` (아래 코드 참조)
  - `normalizeCell(raw: RawCell, size?: number, safeMargin?: number|null): CellSpec`
  - `normalizeStates(raw: Record<string, Partial<StateSpec>> | null): Record<string, StateSpec>`
  - `classifyState(state: string): StateClass`
  - `frameCountAdvice(frames: number): FrameAdvice`
  - 상수 `DEFAULT_SAFE_MARGIN_RATIO = 0.094`, `DEFAULT_CELL_SIZE = 256`, `DEFAULT_STATES`

### 참조 원본

- `sprite_gen/prepare.py:515-536` — `normalize_cell`
- `sprite_gen/prepare.py:497-512` — `normalize_states`
- `sprite_gen/prepare.py:30` — `DEFAULT_SAFE_MARGIN_RATIO = 0.094`
- `sprite_gen/prepare.py:32-47` — `DEFAULT_STATES`
- `docs/states-and-frames.md` — 상태 등급과 프레임 수 대역

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-sprite-request.ts`:

```ts
/**
 * ② Task 1 — SpriteRequest 정규화 테스트.
 * 기하 케이스는 sprite-gen `normalize_cell()` 의 동작을 그대로 대조한다.
 */
import {
  normalizeCell,
  normalizeStates,
  classifyState,
  frameCountAdvice,
  DEFAULT_SAFE_MARGIN_RATIO,
} from "@/lib/sprite/request";

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
  check("rect margin 18/19 (축별 내림)", c.safeMarginX === 18 && c.safeMarginY === 19,
    `got ${c.safeMarginX}/${c.safeMarginY}`);
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
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
check("width 0 은 거부", throws(() => normalizeCell({ width: 0, height: 10 })));
check("음수 margin 은 거부", throws(() => normalizeCell({ size: 256 }, 256, -1)));
check("margin*2 >= width 는 거부", throws(() => normalizeCell({ size: 100 }, 100, 50)));
check("margin*2 < width 는 통과", !throws(() => normalizeCell({ size: 100 }, 100, 49)));

console.log("=== normalizeStates ===");
{
  const s = normalizeStates(null);
  check("raw 없으면 DEFAULT_STATES 4종", Object.keys(s).length === 4);
  check("idle 4f/4fps/loop", s.idle.frames === 4 && s.idle.fps === 4 && s.idle.loop === true);
  check("attack 4f/8fps/non-loop", s.attack.frames === 4 && s.attack.fps === 8 && s.attack.loop === false);
  check("jump 4f/8fps/non-loop", s.jump.frames === 4 && s.jump.fps === 8 && s.jump.loop === false);
  check("wave 4f/6fps/non-loop", s.wave.frames === 4 && s.wave.fps === 6 && s.wave.loop === false);
}
{
  // 이탈 1건: sprite-gen 의 loop 폴백은 무조건 true 라 DEFAULT_STATES 의 non-loop 와
  // 어긋난다. 우리는 fps·action 과 같이 DEFAULT_STATES 에서 채운다 (아래 근거 참조).
  const s = normalizeStates({ attack: { frames: 4 } });
  check("loop 생략 시 DEFAULT_STATES 를 따른다 (attack → false)", s.attack.loop === false);
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
check("not-default 는 실패 모드를 근거로 남긴다",
  frameCountAdvice(12).note.includes("duplicate"));

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-sprite-request.ts
```

Expected: `Cannot find module '@/lib/sprite/request'` 로 즉시 실패.

- [ ] **Step 3: `request.ts` 를 구현한다**

```ts
/**
 * SpriteRequest — 스프라이트 런의 숫자형 SSoT.
 *
 * sprite-gen `sprite_gen/prepare.py` 의 normalize_cell / normalize_states 이식.
 * 셀 기하·상태 정의를 프롬프트 문자열에서 매번 재해석하지 않고 한 객체가 소유한다.
 *
 * 이 모듈은 순수하다 — sharp·fs·DB 를 import 하지 않는다. 크로마 키 자동 선택은
 * 이미지 IO 가 필요하므로 chroma-key.ts 가 맡는다.
 */

/** 픽셀 수가 아니라 비율이다 — 9.4% 는 모든 셀 크기에서 같은 상대 여백을 남긴다
 *  (256 → 24px, 128 → 12px). 명시값은 절대값으로 그대로 이긴다. */
export const DEFAULT_SAFE_MARGIN_RATIO = 0.094;
export const DEFAULT_CELL_SIZE = 256;

export type CellSpec = {
  shape: "square" | "rect";
  width: number;
  height: number;
  safeMarginX: number;
  safeMarginY: number;
};

/** normalizeCell 입력. sprite-gen 이 받아주는 별칭 키를 모두 허용한다. */
export type RawCell = {
  size?: number;
  width?: number;
  height?: number;
  cell_width?: number;
  cell_height?: number;
  safe_margin?: number;
  safe_margin_x?: number;
  safe_margin_y?: number;
};

export type StateSpec = { frames: number; fps: number; loop: boolean; action: string };

export type ChromaKeySpec = {
  name: string;
  hex: string;
  rgb: [number, number, number];
  selection: "auto" | "manual" | "fallback";
  score?: number;
  minSubjectDistance?: number;
  selectionReason?: string;
  warning?: string;
};

export type ChromaTunables = {
  mode: "rgb";
  keyThreshold: number;
  unmixReach: number;
  spillMaxFraction: number;
};

/** 추출기가 유효값을 되쓰기 때문에 request 가 튜너블을 소유한다 —
 *  어떤 파라미터가 그 결과를 만들었는지 런마다 기록에 남는다. */
export const DEFAULT_CHROMA_TUNABLES: ChromaTunables = {
  mode: "rgb",
  keyThreshold: 96,
  unmixReach: 4,
  spillMaxFraction: 0.005,
};

export type SpriteRequest = {
  version: 1;
  character: { id: string; description: string; anchorGenerationId: string };
  cell: CellSpec;
  chromaKey: ChromaKeySpec;
  chroma: ChromaTunables;
  states: Record<string, StateSpec>;
};

export const DEFAULT_STATES: Record<string, StateSpec> = {
  idle: { frames: 4, fps: 4, loop: true, action: "subtle breathing and blinking" },
  attack: {
    frames: 4,
    fps: 8,
    loop: false,
    action: "simple windup, strike, recovery attack pose sequence with no detached effects",
  },
  jump: { frames: 4, fps: 8, loop: false, action: "jump arc through body position only" },
  wave: {
    frames: 4,
    fps: 6,
    loop: false,
    action: "friendly hand wave gesture; arm changes clearly while feet stay planted",
  },
};

function pick(...values: Array<number | undefined>): number | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

export function normalizeCell(
  raw: RawCell,
  size: number = DEFAULT_CELL_SIZE,
  safeMargin?: number | null,
): CellSpec {
  const width = Math.trunc(pick(raw.width, raw.cell_width, raw.size, size)!);
  const height = Math.trunc(pick(raw.height, raw.cell_height, raw.size, size)!);
  if (width <= 0 || height <= 0) {
    throw new Error("normalizeCell: cell width and height must be positive");
  }

  const rawMarginX = pick(raw.safe_margin_x, raw.safe_margin, safeMargin ?? undefined);
  const rawMarginY = pick(raw.safe_margin_y, raw.safe_margin, safeMargin ?? undefined);
  // Python int() 는 0 방향 절삭이고 치수는 양수이므로 floor 와 같다.
  const marginX = rawMarginX === undefined ? Math.floor(width * DEFAULT_SAFE_MARGIN_RATIO) : Math.trunc(rawMarginX);
  const marginY = rawMarginY === undefined ? Math.floor(height * DEFAULT_SAFE_MARGIN_RATIO) : Math.trunc(rawMarginY);

  if (marginX < 0 || marginY < 0 || marginX * 2 >= width || marginY * 2 >= height) {
    throw new Error(
      `normalizeCell: safe margins must fit inside the cell (${marginX}x${marginY} in ${width}x${height})`,
    );
  }

  return {
    shape: width === height ? "square" : "rect",
    width,
    height,
    safeMarginX: marginX,
    safeMarginY: marginY,
  };
}

export function normalizeStates(
  raw: Record<string, Partial<StateSpec>> | null,
): Record<string, StateSpec> {
  const source: Record<string, Partial<StateSpec>> = raw ?? DEFAULT_STATES;
  const out: Record<string, StateSpec> = {};
  for (const [state, entry] of Object.entries(source)) {
    const frames = Math.trunc(entry.frames ?? 0);
    if (frames <= 0) throw new Error(`normalizeStates: state '${state}' must have positive frames`);
    const fallback = DEFAULT_STATES[state];
    out[state] = {
      frames,
      fps: Math.trunc(entry.fps ?? fallback?.fps ?? 6),
      // 원본으로부터의 의도적 이탈: prepare.py:509 의 폴백은 무조건 True 라
      // DEFAULT_STATES 의 attack/jump/wave(loop:false) 와 어긋난다. fps·action 이
      // DEFAULT_STATES 를 참조하는 것과 동일하게 맞춘다. 미지 상태에서는 원본과
      // 같이 true 로 떨어진다.
      loop: entry.loop ?? fallback?.loop ?? true,
      action: entry.action ?? fallback?.action ?? state,
    };
  }
  return out;
}

/* --- 상태 등급과 프레임 수 대역 (docs/states-and-frames.md) ------------------ */

export type StateClass = "simple" | "simple-candidate" | "experimental" | "unknown";

const SIMPLE_STATES = new Set(["idle", "jump", "attack", "wave"]);
const SIMPLE_CANDIDATES = new Set(["talk", "blink", "bounce", "hurt", "celebrate", "magic_cast"]);
const EXPERIMENTAL_STATES = new Set(["walk", "run", "frontwalk", "45_frontwalk"]);
const EXPERIMENTAL_PREFIXES = ["running-", "walking-"];

/**
 * 정본은 주기적 이동을 simple MVP 와 같은 등급으로 승격하지 말라고 못박는다.
 * unknown 은 "안전"이 아니라 "정본이 분류하지 않았다"는 뜻이다 — 호출자가 판단한다.
 */
export function classifyState(state: string): StateClass {
  if (SIMPLE_STATES.has(state)) return "simple";
  if (SIMPLE_CANDIDATES.has(state)) return "simple-candidate";
  if (EXPERIMENTAL_STATES.has(state)) return "experimental";
  if (EXPERIMENTAL_PREFIXES.some(p => state.startsWith(p))) return "experimental";
  return "unknown";
}

export type FrameBand =
  | "default"
  | "return-to-idle"
  | "conservative-edge"
  | "advanced"
  | "not-default"
  | "unspecified";

export type FrameAdvice = { band: FrameBand; note: string };

/** 정본이 명시한 대역만 돌려준다. 나머지는 unspecified — 없는 근거를 지어내지 않는다. */
export function frameCountAdvice(frames: number): FrameAdvice {
  switch (frames) {
    case 4:
      return { band: "default", note: "단순 동작의 기본 안정 범위" };
    case 5:
      return { band: "return-to-idle", note: "비루프 제스처가 대기 복귀 포즈를 가질 때만" };
    case 6:
      return { band: "conservative-edge", note: "인간형 one-shot 기본값의 보수적 상한" };
    case 8:
      return {
        band: "advanced",
        note: "hatch-pet 급 고급 영역 — 컴팩트 마스코트·로코모션 행·명시적 실험에만. 추출·모션 QA 통과가 조건",
      };
    case 9:
    case 12:
      return {
        band: "not-default",
        note: "기본값이 아니다 — 검증 런에서 duplicate bodies·빈 프레임·슬롯 붕괴·추출 실패가 늘었다. 명시적 실험으로 돌리고 결과를 정직하게 보고할 것",
      };
    default:
      return { band: "unspecified", note: "정본이 이 프레임 수를 다루지 않는다" };
  }
}
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-sprite-request.ts
```

Expected: `38 passed / 0 failed`

- [ ] **Step 5: Python 기준 구현과 교차 확인한다**

수제 테스트가 내 이해를 검증할 뿐 원본과의 일치를 보장하지 않는다. 같은 입력을 실제
`normalize_cell()` 에 넣어 비교한다:

```bash
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from sprite_gen.prepare import normalize_cell
for raw, size, sm in [({}, 256, None), ({'size':128}, 128, None), ({'width':192,'height':208}, 256, None), ({}, 256, 40), ({'safe_margin_x':10,'safe_margin_y':30}, 256, None)]:
    print(raw, size, sm, '->', normalize_cell(raw, size, sm))
"
```

Expected: 각 행의 `width`/`height`/`safe_margin_x`/`safe_margin_y`/`shape` 가 Step 4 의
TS 값과 일치. **`size`·`safe_margin` 레거시 키는 우리 `CellSpec` 에 없다** — 정사각이고
margin 이 같을 때만 붙는 JSON 하위호환 필드이고 우리에게는 읽는 쪽이 없다. 이 차이는
의도된 것이며, 스펙 §7 의 "출력 객체 동일" 기준은 **기하 필드 동일**로 읽는다.

- [ ] **Step 6: `package.json` 에 테스트를 체이닝한다**

`package.json:16` 의 `test` 끝에 추가:

```
 && tsx scripts/test-sprite-request.ts
```

- [ ] **Step 7: 커밋**

```bash
git add src/lib/sprite/request.ts scripts/test-sprite-request.ts package.json
git commit -m "feat(sprite): SpriteRequest 정규화 — 비례 safe margin·상태 등급·프레임 대역"
```

---

## Task 2: 베이스 소재 픽셀 샘플링

**Files:**
- Create: `src/lib/sprite/chroma-key.ts`
- Modify: `src/lib/sprite/base-gate.ts` (`colorDistance`·`rgbToHex` export 승격)
- Test: `scripts/test-chroma-key.ts`

**Interfaces:**
- Consumes: `detectBackgroundMode`·`colorDistance`·`rgbToHex`·`BackgroundInfo` (base-gate.ts)
- Produces:
  - `type SampledPixel = [number, number, number]`
  - `backgroundMask(raw: Buffer, w: number, h: number, ch: number, bg: BackgroundInfo): boolean[]`
    — 길이 `w*h`, `true` = 배경
  - `subjectPixels(raw: Buffer, w: number, h: number, ch: number, bg: BackgroundInfo): SampledPixel[]`
  - `sampleReference(filePath: string): Promise<{ pixels: SampledPixel[]; background: BackgroundInfo }>`

### 참조 원본

- `sprite_gen/prepare.py:312-368` — `_background_mask`
- `sprite_gen/prepare.py:371-393` — `_subject_pixels`
- `sprite_gen/prepare.py:396-406` — `analyze_reference`
- `sprite_gen/prepare.py:220-247` — 상수

### 왜 배경을 빼고 세는가

이 파이프라인의 베이스는 **항상 크로마 배경을 달고 있다.** 그 픽셀을 소재로 세면 현재
배경과 일치하는 후보의 `minSubjectDistance` 가 0 에 고정되어, `auto` 는 베이스가 그려진
바로 그 키를 두 번 다시 고를 수 없게 된다 (prepare.py:410-416 주석).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-chroma-key.ts` (Task 2 부분):

```ts
/**
 * ② Task 2·3 — 크로마 키 자동 선택 테스트.
 * 합성 이미지로 배경 제외·스페클 필터·삭제 반경 게이트를 검증한다.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundMask, subjectPixels, sampleReference } from "@/lib/sprite/chroma-key";
import { detectBackgroundMode } from "@/lib/sprite/base-gate";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** w×h RGBA 캔버스를 bg 로 채우고 painter 로 덧그린다. */
function canvas(
  w: number, h: number, bg: [number, number, number],
  painter?: (set: (x: number, y: number, c: [number, number, number]) => void) => void,
): { raw: Buffer; width: number; height: number; channels: number } {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = bg[0]; raw[i * 4 + 1] = bg[1]; raw[i * 4 + 2] = bg[2]; raw[i * 4 + 3] = 255;
  }
  painter?.((x, y, c) => {
    const i = (y * w + x) * 4;
    raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; raw[i + 3] = 255;
  });
  return { raw, width: w, height: h, channels: 4 };
}

console.log("=== backgroundMask — 평면 크로마 배경 ===");
{
  // 64x64 마젠타 배경 + 중앙 20x20 파란 사각형
  const img = canvas(64, 64, [255, 0, 255], set => {
    for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
  });
  const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
  check("배경이 flat 으로 판정", bg.mode === "flat");
  const mask = backgroundMask(img.raw, img.width, img.height, img.channels, bg);
  check("모서리는 배경", mask[0] === true);
  check("사각형 중앙은 소재", mask[32 * 64 + 32] === false);
  const bgCount = mask.filter(Boolean).length;
  // 소재 20x20=400 에서 팽창 2px 이 사방을 갉아먹는다 → 배경은 64*64-400 보다 크다
  check("배경 마스크가 팽창으로 소재를 갉는다", bgCount > 64 * 64 - 400, `bg=${bgCount}`);
}

console.log("=== subjectPixels — 배경 제외와 스페클 필터 ===");
{
  const img = canvas(64, 64, [255, 0, 255], set => {
    for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
    set(10, 10, [233, 7, 202]); // 고립된 스필 스페클 — 제외되어야 한다
  });
  const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
  const px = subjectPixels(img.raw, img.width, img.height, img.channels, bg);
  check("소재 픽셀이 잡힌다", px.length > 0, `n=${px.length}`);
  check("마젠타 배경은 소재에 없다",
    !px.some(p => p[0] > 200 && p[1] < 60 && p[2] > 200));
  check("고립 스페클은 제외된다",
    !px.some(p => p[0] === 233 && p[1] === 7 && p[2] === 202));
  check("모든 소재 픽셀이 파란 사각형 색",
    px.every(p => p[0] === 30 && p[1] === 60 && p[2] === 200));
}

console.log("=== subjectPixels — 근백색 제외 ===");
{
  const img = canvas(64, 64, [255, 0, 255], set => {
    for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [250, 250, 250]);
  });
  const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
  const px = subjectPixels(img.raw, img.width, img.height, img.channels, bg);
  check("전 채널 244 초과는 소재에서 빠진다", px.length === 0, `n=${px.length}`);
}

console.log("=== sampleReference — 파일 경로 경유 ===");
{
  const dir = await mkdtemp(join(tmpdir(), "chroma-"));
  try {
    const p = join(dir, "base.png");
    const img = canvas(64, 64, [255, 0, 255], set => {
      for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
    });
    await sharp(img.raw, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(p);
    const r = await sampleReference(p);
    check("파일에서 소재 픽셀을 뽑는다", r.pixels.length > 0);
    check("배경 모드가 함께 온다", r.background.mode === "flat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
{
  const r = await sampleReference("/nonexistent/path/base.png");
  check("없는 파일은 absent 로 떨어진다", r.background.mode === "absent" && r.pixels.length === 0);
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-chroma-key.ts
```

Expected: `Cannot find module '@/lib/sprite/chroma-key'`.

- [ ] **Step 3: `base-gate.ts` 의 두 함수를 export 로 승격한다**

`src/lib/sprite/base-gate.ts:36` 와 `:43` 의 선언 앞에 `export` 를 붙인다:

```ts
export function colorDistance(
```

```ts
export function rgbToHex(rgb: readonly [number, number, number]): string {
```

또한 `BackgroundInfo` 에 `absent` 모드가 없으면 추가한다 — `analyze_reference` 가
"참조 없음"을 이 값으로 표현한다. `base-gate.ts:25` 의 유니온을 확인하고, 없으면:

```ts
export type BackgroundInfo =
  | { mode: "absent" }
  | /* 기존 항목들 그대로 */;
```

> `inspectBaseImage` 는 항상 실재 파일을 받으므로 `absent` 를 만들지 않는다. 기존 분기에
> 영향이 없는지 `pnpm exec tsx scripts/test-base-gate.ts` 로 확인한다.

- [ ] **Step 4: `chroma-key.ts` 의 샘플링 부분을 구현한다**

```ts
/**
 * 크로마 키 자동 선택 — sprite_gen/prepare.py 의 소재 샘플링과 후보 점수화 이식.
 *
 * 목적은 전체의 1% 미만인 작지만 결정적인 특징(눈, 보석, 귀 램프)이 추출 시점에
 * **조용히 삭제되지 않게** 하는 것이다.
 */
import sharp from "sharp";
import { colorDistance, detectBackgroundMode, type BackgroundInfo } from "@/lib/sprite/base-gate";

/** NEAREST 로 샘플링한다 — 이웃을 평균내는 필터는 베이스에 없던 색을 만들어내고,
 *  그 색은 전부 크로마 배경과 소재 사이의 선 위에 앉는다. 후보 점수화가 절대
 *  봐서는 안 되는 영역이다. 256px 는 128px 이면 뭉개질 작은 특징(눈·보석)을 남긴다. */
const REFERENCE_SAMPLE_SIZE = 256;

const BACKGROUND_TOLERANCE = 48.0;
const ALPHA_TRANSPARENT_MAX = 16;

/** 소재는 배경에 대해 ~1-2px 안티에일리어싱된다. 그 블렌드 픽셀은 소재가 아니라
 *  배경 오염이므로 마스크를 키워 띠를 삼킨다. */
const BACKGROUND_EDGE_DILATION = 2;

/** 키 색 영역이 소재에 둘러싸여 있으면 애매하다 — 실루엣을 뚫고 배경이 보이는
 *  구멍일 수도, 작가가 키 색조로 그린 소재일 수도 있다. 구멍은 평면 채움이라
 *  거의 전부가 정확한 배경색에 앉고, 그린 소재는 음영을 가져 퍼진다. */
const BACKGROUND_FLAT_TOLERANCE = 16.0;
const ENCLOSED_FLAT_FRACTION = 0.6;

/** 생성 이미지는 실루엣 안쪽에 고립된 스필·압축 스페클을 가진다(머리카락 틈의
 *  외톨이 (233,7,202) 하나). 픽셀 하나는 특징이 아니고, 그것을 세면 최근접 픽셀
 *  안전 게이트가 스페클에 지배된다. 자기 색의 영역에 속한 픽셀만 남긴다. */
const SPECKLE_NEIGHBOR_TOLERANCE = 40.0;
const SPECKLE_MIN_SIMILAR_NEIGHBORS = 3;

const NEIGHBORS_4: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBORS_8: Array<[number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

export type SampledPixel = [number, number, number];

function rgbAt(raw: Buffer, i: number, ch: number): SampledPixel {
  const o = i * ch;
  return [raw[o], raw[o + 1], raw[o + 2]];
}

function alphaAt(raw: Buffer, i: number, ch: number): number {
  return ch >= 4 ? raw[i * ch + 3] : 255;
}

export function backgroundMask(
  raw: Buffer, width: number, height: number, channels: number, background: BackgroundInfo,
): boolean[] {
  const n = width * height;
  const transparent = new Array<boolean>(n);
  for (let i = 0; i < n; i++) transparent[i] = alphaAt(raw, i, channels) <= ALPHA_TRANSPARENT_MAX;
  const mask = transparent.slice();

  if (background.mode === "flat") {
    const key = background.rgb;
    const near = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
      near[i] = transparent[i] || colorDistance(rgbAt(raw, i, channels), key) <= BACKGROUND_TOLERANCE;
    }
    const visited = new Array<boolean>(n).fill(false);
    for (let start = 0; start < n; start++) {
      if (!near[start] || visited[start]) continue;
      visited[start] = true;
      const queue: number[] = [start];
      const component: number[] = [];
      let grounded = false;
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        component.push(i);
        const x = i % width;
        const y = (i / width) | 0;
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1 || transparent[i]) grounded = true;
        for (const [dx, dy] of NEIGHBORS_8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          if (near[j] && !visited[j]) { visited[j] = true; queue.push(j); }
        }
      }
      if (!grounded) {
        let flat = 0;
        for (const i of component) {
          if (colorDistance(rgbAt(raw, i, channels), key) <= BACKGROUND_FLAT_TOLERANCE) flat++;
        }
        // 그린 키 색조 소재는 소재로 남긴다 — 그래야 삭제 반경 게이트가 그것을
        // 지울 키를 거부할 수 있다 (v1.10.1 키 틴트 보호).
        if (flat / component.length < ENCLOSED_FLAT_FRACTION) continue;
      }
      for (const i of component) mask[i] = true;
    }
  }

  for (let pass = 0; pass < BACKGROUND_EDGE_DILATION; pass++) {
    const grown: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask[i]) continue;
      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of NEIGHBORS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (mask[ny * width + nx]) { grown.push(i); break; }
      }
    }
    for (const i of grown) mask[i] = true;
  }
  return mask;
}

export function subjectPixels(
  raw: Buffer, width: number, height: number, channels: number, background: BackgroundInfo,
): SampledPixel[] {
  const n = width * height;
  const mask = backgroundMask(raw, width, height, channels, background);
  const candidate = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const c = rgbAt(raw, i, channels);
    candidate[i] = !mask[i] && !(c[0] > 244 && c[1] > 244 && c[2] > 244);
  }

  const out: SampledPixel[] = [];
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) continue;
    const color = rgbAt(raw, i, channels);
    const x = i % width;
    const y = (i / width) | 0;
    let similar = 0;
    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx;
      if (candidate[j] && colorDistance(rgbAt(raw, j, channels), color) <= SPECKLE_NEIGHBOR_TOLERANCE) {
        similar++;
      }
    }
    if (similar >= SPECKLE_MIN_SIMILAR_NEIGHBORS) out.push(color);
  }
  return out;
}

export async function sampleReference(
  filePath: string,
): Promise<{ pixels: SampledPixel[]; background: BackgroundInfo }> {
  let data: Buffer;
  let info: sharp.OutputInfo;
  try {
    const out = await sharp(filePath)
      .resize(REFERENCE_SAMPLE_SIZE, REFERENCE_SAMPLE_SIZE, {
        fit: "inside",
        withoutEnlargement: true,
        kernel: "nearest",
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = out.data;
    info = out.info;
  } catch {
    return { pixels: [], background: { mode: "absent" } };
  }
  const background = detectBackgroundMode(data, info.width, info.height, info.channels);
  const pixels = subjectPixels(data, info.width, info.height, info.channels, background);
  return { pixels, background };
}
```

- [ ] **Step 5: 테스트를 실행해 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-chroma-key.ts && pnpm exec tsx scripts/test-base-gate.ts
```

Expected: 신규 테스트 전부 통과, `test-base-gate.ts` 30 passed 유지 (export 승격 회귀 확인).

- [ ] **Step 6: 커밋**

```bash
git add src/lib/sprite/chroma-key.ts src/lib/sprite/base-gate.ts scripts/test-chroma-key.ts
git commit -m "feat(sprite): 베이스 소재 픽셀 샘플링 — 배경 제외·팽창·스페클 필터"
```

---

## Task 3: 크로마 키 자동 선택

**Files:**
- Modify: `src/lib/sprite/chroma-key.ts`
- Modify: `scripts/test-chroma-key.ts`
- Modify: `package.json:16`

**Interfaces:**
- Consumes: `sampleReference`·`SampledPixel` (Task 2), `ChromaKeySpec` (Task 1)
- Produces:
  - `CHROMA_CANDIDATES: ReadonlyArray<[string, string]>`
  - `MIN_SUBJECT_KEY_DISTANCE = 96.0`
  - `chooseChromaKey(referencePath: string|null, requested: string): Promise<ChromaKeySpec & { candidates?: ChromaCandidate[]; background?: BackgroundInfo }>`
  - `type ChromaCandidate = { name: string; hex: string; score: number; minSubjectDistance: number; clearsEraseRadius: boolean }`

### 참조 원본

- `sprite_gen/prepare.py:420-494` — `choose_chroma_key`
- `sprite_gen/prepare.py:197-202` — `CHROMA_CANDIDATES` (**순서가 선호도다**)
- `sprite_gen/prepare.py:249-252` — `MIN_SUBJECT_KEY_DISTANCE = 96.0`

### 점수화가 두 단계인 이유

1차 점수는 **1퍼센타일 거리**다. 그런데 그 지표는 1% 미만의 특징(눈·보석·귀 램프)을
무시한다 — 최근접 소재 픽셀이 여전히 삭제 반경 안인데도 키가 "안전"해 보일 수 있다.
그래서 **최근접 픽셀이 반경을 벗어나는 후보만** 먼저 고르고, 그런 후보가 하나도 없을
때만 경고와 함께 원래 순위로 떨어진다.

`MIN_SUBJECT_KEY_DISTANCE = 96` 은 추출기의 `--key-threshold` 기본값을 그대로 반영한다.
이 반경 안의 소재 픽셀은 추출 시점에 위치와 무관하게 삭제된다.

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-chroma-key.ts` 의 `console.log("\n${passed}...")` 직전에 삽입:

```ts
console.log("=== chooseChromaKey — 수동 지정 ===");
{
  const k = await chooseChromaKey(null, "#00FF00");
  check("수동 지정은 그대로 통과", k.hex === "#00FF00" && k.selection === "manual");
  check("후보 목록의 이름을 되찾는다", k.name === "green");
  const m = await chooseChromaKey(null, "#123456");
  check("후보에 없는 색은 manual 이름", m.name === "manual");
  let threw = false;
  try { await chooseChromaKey(null, "not-a-color"); } catch { threw = true; }
  check("잘못된 헥스는 거부", threw);
}

console.log("=== chooseChromaKey — 참조 없음 폴백 ===");
{
  const k = await chooseChromaKey(null, "auto");
  check("참조 없으면 마젠타 폴백", k.hex === "#FF00FF" && k.selection === "fallback");
  check("폴백 사유가 남는다", (k.selectionReason ?? "").includes("no base reference"));
}

console.log("=== chooseChromaKey — 소재색에서 먼 키를 고른다 ===");
{
  const dir = await mkdtemp(join(tmpdir(), "chroma-auto-"));
  try {
    // 흰 배경 + 진한 크림슨 소재. 마젠타는 R 이 높아 크림슨과 인접 → 그린이 안전.
    const p = join(dir, "crimson.png");
    const img = canvas(64, 64, [254, 254, 254], set => {
      for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) set(x, y, [153, 12, 40]);
    });
    await sharp(img.raw, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(p);
    const k = await chooseChromaKey(p, "auto");
    check("크림슨 소재에는 마젠타를 고르지 않는다", k.hex !== "#FF00FF", `got ${k.hex}`);
    check("selection 은 auto", k.selection === "auto");
    check("후보 4종이 모두 기록된다", (k.candidates ?? []).length === 4);
    check("근거가 기록된다", typeof k.score === "number" && typeof k.minSubjectDistance === "number");
    const magenta = (k.candidates ?? []).find(c => c.name === "magenta");
    check("마젠타의 삭제 반경 통과 여부가 기록된다", magenta !== undefined && typeof magenta.clearsEraseRadius === "boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("=== chooseChromaKey — 어떤 후보도 안전하지 않으면 경고 ===");
{
  const dir = await mkdtemp(join(tmpdir(), "chroma-warn-"));
  try {
    // 흰 배경 + 네 후보에 모두 인접한 소재를 깐다: 마젠타·그린·시안·블루 각각의
    // 근처 색을 한 덩어리씩 그려 어느 키도 반경을 벗어나지 못하게 한다.
    const p = join(dir, "rainbow.png");
    const blobs: Array<[number, [number, number, number]]> = [
      [4, [250, 10, 250]], [20, [10, 250, 10]], [36, [10, 250, 250]], [52, [10, 77, 250]],
    ];
    const img = canvas(64, 64, [254, 254, 254], set => {
      for (const [ox, c] of blobs) {
        for (let y = 24; y < 40; y++) for (let x = ox; x < ox + 10; x++) set(x, y, c);
      }
    });
    await sharp(img.raw, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(p);
    const k = await chooseChromaKey(p, "auto");
    check("안전한 후보가 없으면 경고가 붙는다", typeof k.warning === "string" && k.warning.length > 0,
      `warning=${k.warning}`);
    check("경고가 있어도 키는 선택된다", k.hex.length === 7);
    check("사유가 반경 미통과를 밝힌다",
      (k.selectionReason ?? "").includes("no candidate clears"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

파일 상단 import 에 추가:

```ts
import { backgroundMask, subjectPixels, sampleReference, chooseChromaKey } from "@/lib/sprite/chroma-key";
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-chroma-key.ts
```

Expected: `chooseChromaKey is not a function` 또는 import 실패.

- [ ] **Step 3: `chooseChromaKey` 를 구현한다**

`src/lib/sprite/chroma-key.ts` 하단에 추가:

```ts
/** 순서가 선호도다 — 점수가 동률이면 앞선 후보가 이긴다. */
export const CHROMA_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ["magenta", "#FF00FF"],
  ["green", "#00FF00"],
  ["cyan", "#00FFFF"],
  ["blue", "#004DFF"],
];

/** 추출기 `--key-threshold` 기본값의 거울. 이 반경 안의 소재 픽셀은 추출 시점에
 *  위치와 무관하게 삭제되므로, 최근접 소재 픽셀이 이 안에 들어오는 키는 그 특징을
 *  지운다. */
export const MIN_SUBJECT_KEY_DISTANCE = 96.0;

export type ChromaCandidate = {
  name: string;
  hex: string;
  score: number;
  minSubjectDistance: number;
  clearsEraseRadius: boolean;
};

export type ChromaSelection = ChromaKeySpec & {
  candidates?: ChromaCandidate[];
  background?: BackgroundInfo;
};

function parseHexColor(value: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`chooseChromaKey: invalid chroma key color: ${value}; expected #RRGGBB`);
  }
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export async function chooseChromaKey(
  referencePath: string | null,
  requested: string,
): Promise<ChromaSelection> {
  if (requested.toLowerCase() !== "auto") {
    const rgb = parseHexColor(requested);
    const hex = rgbToHex(rgb);
    const known = CHROMA_CANDIDATES.find(([, candidateHex]) => candidateHex === hex);
    return { name: known ? known[0] : "manual", hex, rgb, selection: "manual" };
  }

  const { pixels, background } =
    referencePath === null
      ? { pixels: [] as SampledPixel[], background: { mode: "absent" } as BackgroundInfo }
      : await sampleReference(referencePath);

  if (pixels.length === 0) {
    const rgb = parseHexColor("#FF00FF");
    const reason =
      background.mode === "absent"
        ? "no base reference to sample"
        : "the base reference yielded no subject pixels once its background was excluded";
    return {
      name: "magenta", hex: "#FF00FF", rgb, selection: "fallback",
      background, selectionReason: reason,
    };
  }

  const scored = CHROMA_CANDIDATES.map(([name, hex], preferenceIndex) => {
    const rgb = parseHexColor(hex);
    const distances = pixels.map(p => colorDistance(rgb, p)).sort((a, b) => a - b);
    // Python: int(len * 0.01) 을 [0, len-1] 로 클램프
    const idx = Math.max(0, Math.min(distances.length - 1, Math.trunc(distances.length * 0.01)));
    return {
      score: distances[idx],
      minDistance: distances[0],
      preference: -preferenceIndex,
      name,
      rgb,
    };
  });

  // score → minDistance → preference 순의 사전식 최대. Python 의 튜플 max 와 같다.
  function better(a: typeof scored[number], b: typeof scored[number]): boolean {
    if (a.score !== b.score) return a.score > b.score;
    if (a.minDistance !== b.minDistance) return a.minDistance > b.minDistance;
    return a.preference > b.preference;
  }
  const safe = scored.filter(e => e.minDistance > MIN_SUBJECT_KEY_DISTANCE);
  const pool = safe.length > 0 ? safe : scored;
  const winner = pool.reduce((best, e) => (better(e, best) ? e : best), pool[0]);

  const selection: ChromaSelection = {
    name: winner.name,
    hex: rgbToHex(winner.rgb),
    rgb: winner.rgb,
    selection: "auto",
    score: round2(winner.score),
    minSubjectDistance: round2(winner.minDistance),
    background,
    candidates: scored.map(e => ({
      name: e.name,
      hex: rgbToHex(e.rgb),
      score: round2(e.score),
      minSubjectDistance: round2(e.minDistance),
      clearsEraseRadius: e.minDistance > MIN_SUBJECT_KEY_DISTANCE,
    })),
    selectionReason:
      safe.length > 0
        ? `highest 1st-percentile subject distance among the ${safe.length} candidate(s) clearing the ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)} erase radius`
        : `no candidate clears the ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)} erase radius; ranked by 1st-percentile subject distance alone`,
  };

  if (winner.minDistance <= MIN_SUBJECT_KEY_DISTANCE) {
    selection.warning =
      `nearest subject pixel is ${winner.minDistance.toFixed(1)} from ${winner.name} ` +
      `(<= ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)}); that feature will be erased at extraction — ` +
      `recolor it or force a different chroma key`;
  }
  return selection;
}
```

파일 상단 import 에 `rgbToHex` 와 `ChromaKeySpec` 추가:

```ts
import { colorDistance, detectBackgroundMode, rgbToHex, type BackgroundInfo } from "@/lib/sprite/base-gate";
import type { ChromaKeySpec } from "@/lib/sprite/request";
```

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-chroma-key.ts
```

Expected: 전부 통과.

- [ ] **Step 5: Python 기준 구현과 교차 확인한다**

Task 3 의 크림슨 케이스를 실제 `choose_chroma_key()` 에 넣어 승자와 후보 점수를 비교한다.
테스트가 만든 PNG 를 남기도록 임시로 경로를 고정한 뒤:

```bash
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys, json; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from pathlib import Path
from sprite_gen.prepare import choose_chroma_key
print(json.dumps(choose_chroma_key(Path('/tmp/crimson.png'), 'auto'), indent=2))
"
```

Expected: `name`·`score`·`min_subject_distance` 와 `candidates[].min_subject_distance`
가 TS 출력과 일치. **불일치하면 멈추고 원인을 찾는다** — 리샘플 커널 차이(sharp `nearest`
vs PIL `thumbnail(NEAREST)`)가 유력한 후보이며, 그 경우 차이의 크기를 기록하고 판정
(승자 이름)이 같은지를 통과 기준으로 삼는다.

> `thumbnail()` 은 `fit: inside` + 축소 전용이라 sharp 의
> `resize(256,256,{fit:'inside',withoutEnlargement:true})` 와 의미가 같다. 다만 PIL 은
> 축소 배율이 클 때 내부적으로 `reduce()` 를 먼저 걸 수 있어 정수배가 아닌 축소에서
> 픽셀이 어긋날 수 있다.

- [ ] **Step 6: `package.json` 에 테스트를 체이닝하고 커밋한다**

`package.json:16` 의 `test` 끝에 `&& tsx scripts/test-chroma-key.ts` 추가.

```bash
git add src/lib/sprite/chroma-key.ts scripts/test-chroma-key.ts package.json
git commit -m "feat(sprite): 크로마 키 자동 선택 — 삭제 반경 게이트와 근거 기록"
```

---

## Task 4: 레이아웃 가이드 렌더러

**Files:**
- Create: `src/lib/sprite/layout-guide.ts`
- Test: `scripts/test-layout-guide.ts`
- Modify: `package.json:16`

**Interfaces:**
- Consumes: `CellSpec` (Task 1)
- Produces:
  - `renderLayoutGuideBuffer(frames: number, cell: CellSpec): { raw: Buffer; width: number; height: number }`
    — RGB(3채널) raw 버퍼
  - `renderLayoutGuide(destPath: string, frames: number, cell: CellSpec): Promise<{ width: number; height: number }>`

### 스펙 §6.2 로부터의 이탈: SVG 가 아니라 raw 버퍼

스펙은 "SVG 문자열을 조립해 sharp 로 래스터화"라고 적었다. **바꾼다.** 통과 기준이
"Python 출력과 PNG 픽셀 동일"인데, SVG 스트로크는 경로 중심 정렬이라 PIL 의 안쪽 정렬
사각형과 반픽셀씩 어긋나고 래스터라이저 AA 가 경계에 회색을 남긴다. 축 정렬 사각형을
raw 버퍼에 직접 채우면 AA 자체가 없어 픽셀 동일이 정의상 보장된다. 도형이 사각형과
수직선뿐이라 SVG 로 얻을 이득도 없다.

### PIL 그리기 의미 (정확히 재현할 것)

- `draw.rectangle((x0,y0,x1,y1), outline=C, width=W)` — 경계 **안쪽으로** W픽셀 띠.
  좌표는 **양끝 포함**이다.
- `draw.line((x,y0,x,y1), fill=C, width=1)` — `y0..y1` **양끝 포함** 수직선.
- 그리는 순서가 곧 겹침 우선순위다: 바깥 테두리 → safe 사각형 → 중앙선.

### 원본의 비대칭 하나 (그대로 옮긴다)

`prepare.py:840` 의 중앙선 y 범위는 `safe_margin_y` ~ `height - safe_margin_y` 인데,
safe 사각형의 아래 변은 `height - 1 - safe_margin_y` 다. 중앙선이 safe 사각형보다 **1px
아래로 더 내려간다.** 의도인지 오프바이원인지는 원본 주석에 없다. 픽셀 동일이 기준이므로
**그대로 재현하고 주석으로 남긴다.**

- [ ] **Step 1: Python 기준 PNG 를 먼저 만든다**

```bash
mkdir -p /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/guide-ref
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from pathlib import Path
from sprite_gen.prepare import draw_guide, normalize_cell
out = Path('/private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/guide-ref')
for label, raw, size, sm, frames in [
    ('sq256-f4', {}, 256, None, 4),
    ('sq128-f6', {'size':128}, 128, None, 6),
    ('rect192x208-f4', {'width':192,'height':208}, 256, None, 4),
    ('sq256-m40-f8', {}, 256, 40, 8),
]:
    cell = normalize_cell(raw, size, sm)
    draw_guide(out / f'{label}.png', 'idle', frames, cell)
    print(label, cell)
"
ls -la /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/guide-ref
```

Expected: 4개 PNG 생성. 이 파일들이 Step 3 테스트의 기준이다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`scripts/test-layout-guide.ts`:

```ts
/**
 * ② Task 4 — 레이아웃 가이드 픽셀 대조.
 *
 * 기준 PNG 는 sprite-gen `draw_guide()` 가 만든다 (계획 Task 4 Step 1).
 * 기준이 없으면 테스트는 SKIP 하고 성공으로 치지 않는다 — 조용한 통과를 막는다.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderLayoutGuideBuffer } from "@/lib/sprite/layout-guide";
import { normalizeCell } from "@/lib/sprite/request";

const REF_DIR = process.env.GUIDE_REF_DIR ?? "";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("=== 기하 (기준 PNG 없이도 검증 가능) ===");
{
  const cell = normalizeCell({});
  const g = renderLayoutGuideBuffer(4, cell);
  check("캔버스는 frames*cellW x cellH", g.width === 1024 && g.height === 256);
  check("RGB 3채널", g.raw.length === 1024 * 256 * 3);
  const at = (x: number, y: number) => {
    const o = (y * g.width + x) * 3;
    return `#${[g.raw[o], g.raw[o + 1], g.raw[o + 2]].map(v => v.toString(16).padStart(2, "0")).join("")}`;
  };
  check("배경은 #f6f6f6", at(140, 140) === "#f6f6f6", at(140, 140));
  check("셀 좌상단은 테두리 #333333", at(0, 0) === "#333333", at(0, 0));
  check("테두리 두께 3 — x=2 는 테두리", at(2, 128) === "#333333", at(2, 128));
  check("테두리 두께 3 — x=3 은 배경", at(3, 128) === "#f6f6f6", at(3, 128));
  check("safe 사각형 좌변 #2f80ed", at(24, 128) === "#2f80ed", at(24, 128));
  check("safe 두께 2 — x=25 도 safe", at(25, 128) === "#2f80ed", at(25, 128));
  check("safe 두께 2 — x=26 은 배경", at(26, 128) === "#f6f6f6", at(26, 128));
  check("중앙선 #b8c8e8", at(128, 128) === "#b8c8e8", at(128, 128));
  // 원본의 비대칭: safe 아래변은 y=231, 중앙선은 y=232 까지 내려간다.
  check("중앙선이 safe 아래변보다 1px 더 내려간다", at(128, 232) === "#b8c8e8", at(128, 232));
  check("y=233 은 배경", at(128, 233) === "#f6f6f6", at(128, 233));
  check("두 번째 셀의 좌테두리", at(256, 128) === "#333333", at(256, 128));
}

console.log("=== Python 기준 PNG 픽셀 대조 ===");
const CASES: Array<[string, Parameters<typeof normalizeCell>, number]> = [
  ["sq256-f4", [{}, 256, null], 4],
  ["sq128-f6", [{ size: 128 }, 128, null], 6],
  ["rect192x208-f4", [{ width: 192, height: 208 }, 256, null], 4],
  ["sq256-m40-f8", [{}, 256, 40], 8],
];
if (!REF_DIR) {
  console.log("  SKIP  GUIDE_REF_DIR 미설정 — Python 기준 대조를 건너뛴다");
  skipped += CASES.length;
} else {
  for (const [label, cellArgs, frames] of CASES) {
    const refPath = join(REF_DIR, `${label}.png`);
    if (!existsSync(refPath)) {
      console.log(`  SKIP  ${label} — 기준 PNG 없음 (${refPath})`);
      skipped++;
      continue;
    }
    const cell = normalizeCell(...cellArgs);
    const mine = renderLayoutGuideBuffer(frames, cell);
    const ref = await sharp(refPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (ref.info.width !== mine.width || ref.info.height !== mine.height) {
      check(`${label} 치수 일치`, false, `ref ${ref.info.width}x${ref.info.height} vs ${mine.width}x${mine.height}`);
      continue;
    }
    let diff = 0;
    let firstDiff = "";
    for (let i = 0; i < ref.data.length; i++) {
      if (ref.data[i] !== mine.raw[i]) {
        if (diff === 0) {
          const px = (i / 3) | 0;
          firstDiff = `첫 차이 (${px % mine.width},${(px / mine.width) | 0}) ref=${ref.data[i]} mine=${mine.raw[i]}`;
        }
        diff++;
      }
    }
    check(`${label} 픽셀 동일`, diff === 0, `${diff} bytes 불일치; ${firstDiff}`);
  }
}

console.log(`\n${passed} passed / ${failed} failed / ${skipped} skipped`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: 테스트를 실행해 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-layout-guide.ts
```

Expected: `Cannot find module '@/lib/sprite/layout-guide'`.

- [ ] **Step 4: `layout-guide.ts` 를 구현한다**

```ts
/**
 * 레이아웃 가이드 — sprite_gen/prepare.py `draw_guide()` 이식.
 *
 * 모델에게 프레임 개수·슬롯 간격·중앙 정렬·안전 여백을 보여주는 첨부 이미지다.
 * 프롬프트 문구보다 첨부 이미지를 강하게 따르는 성질을 이용한다.
 *
 * SVG 가 아니라 raw 버퍼에 직접 채운다: 통과 기준이 Python 출력과의 픽셀 동일인데
 * SVG 스트로크는 경로 중심 정렬이라 PIL 의 안쪽 정렬 사각형과 어긋나고 래스터라이저
 * AA 가 경계에 회색을 남긴다. 도형이 축 정렬 사각형과 수직선뿐이라 SVG 의 이득도 없다.
 */
import sharp from "sharp";

const BACKGROUND: RGB = [0xf6, 0xf6, 0xf6];
const CELL_BORDER: RGB = [0x33, 0x33, 0x33];
const SAFE_BORDER: RGB = [0x2f, 0x80, 0xed];
const CENTER_LINE: RGB = [0xb8, 0xc8, 0xe8];

const CELL_BORDER_WIDTH = 3;
const SAFE_BORDER_WIDTH = 2;

type RGB = readonly [number, number, number];

type Canvas = { raw: Buffer; width: number; height: number };

function fillRect(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: RGB): void {
  const xa = Math.max(0, x0);
  const xb = Math.min(c.width - 1, x1);
  const ya = Math.max(0, y0);
  const yb = Math.min(c.height - 1, y1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const o = (y * c.width + x) * 3;
      c.raw[o] = color[0];
      c.raw[o + 1] = color[1];
      c.raw[o + 2] = color[2];
    }
  }
}

/**
 * PIL `draw.rectangle(..., outline, width)` 의 재현.
 * 좌표는 양끝 포함이고 띠는 경계 **안쪽으로** width 픽셀 자란다.
 */
function strokeRect(
  c: Canvas, x0: number, y0: number, x1: number, y1: number, color: RGB, width: number,
): void {
  fillRect(c, x0, y0, x1, y0 + width - 1, color); // top
  fillRect(c, x0, y1 - width + 1, x1, y1, color); // bottom
  fillRect(c, x0, y0, x0 + width - 1, y1, color); // left
  fillRect(c, x1 - width + 1, y0, x1, y1, color); // right
}

export type GuideCell = {
  width: number;
  height: number;
  safeMarginX: number;
  safeMarginY: number;
};

export function renderLayoutGuideBuffer(frames: number, cell: GuideCell): Canvas {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`renderLayoutGuide: frames must be a positive integer (got ${frames})`);
  }
  const cellWidth = cell.width;
  const cellHeight = cell.height;
  const marginX = cell.safeMarginX;
  const marginY = cell.safeMarginY;

  const width = frames * cellWidth;
  const height = cellHeight;
  const canvas: Canvas = { raw: Buffer.alloc(width * height * 3), width, height };
  fillRect(canvas, 0, 0, width - 1, height - 1, BACKGROUND);

  for (let index = 0; index < frames; index++) {
    const left = index * cellWidth;
    const right = left + cellWidth - 1;
    strokeRect(canvas, left, 0, right, height - 1, CELL_BORDER, CELL_BORDER_WIDTH);
    strokeRect(
      canvas,
      left + marginX, marginY, right - marginX, height - 1 - marginY,
      SAFE_BORDER, SAFE_BORDER_WIDTH,
    );
    // 원본의 비대칭을 그대로 옮긴다: 세로선은 marginY ~ height-marginY 인데 safe
    // 사각형의 아래 변은 height-1-marginY 라, 선이 1px 더 내려간다 (prepare.py:840).
    // 의도인지 오프바이원인지는 원본에 근거가 없다. 픽셀 동일이 기준이라 유지한다.
    const centerX = left + Math.floor(cellWidth / 2);
    fillRect(canvas, centerX, marginY, centerX, height - marginY, CENTER_LINE);
  }
  return canvas;
}

export async function renderLayoutGuide(
  destPath: string, frames: number, cell: GuideCell,
): Promise<{ width: number; height: number }> {
  const g = renderLayoutGuideBuffer(frames, cell);
  await sharp(g.raw, { raw: { width: g.width, height: g.height, channels: 3 } })
    .png()
    .toFile(destPath);
  return { width: g.width, height: g.height };
}
```

- [ ] **Step 5: 기하 테스트를 실행한다**

```bash
pnpm exec tsx scripts/test-layout-guide.ts
```

Expected: 기하 12건 통과, Python 대조 4건 SKIP.

- [ ] **Step 6: Python 기준과 픽셀 대조한다 (이 Task 의 실제 통과 기준)**

```bash
GUIDE_REF_DIR=/private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/guide-ref pnpm exec tsx scripts/test-layout-guide.ts
```

Expected: `16 passed / 0 failed / 0 skipped`.

**불일치하면 멈춘다.** 테스트가 첫 차이 좌표와 양쪽 값을 찍으므로 그것으로 진단한다.
가장 가능성 높은 원인 순서: (a) `strokeRect` 의 변 순서·겹침, (b) 중앙선 y 범위,
(c) PNG 색공간/감마 메타 — `removeAlpha()` 만으로 부족하면 `.toColourspace('srgb')` 를
양쪽에 건다.

- [ ] **Step 7: `package.json` 에 체이닝하고 커밋한다**

`test` 에 `&& tsx scripts/test-layout-guide.ts` 추가. (기준 PNG 없이 돌면 기하만
검사하고 SKIP 을 보고한다 — CI 에서 조용히 통과하지 않도록 SKIP 개수를 출력한다.)

```bash
git add src/lib/sprite/layout-guide.ts scripts/test-layout-guide.ts package.json
git commit -m "feat(sprite): 레이아웃 가이드 렌더러 — draw_guide 픽셀 동일 이식"
```

---

## Task 5: row 프롬프트 빌더

**Files:**
- Create: `src/lib/sprite/row-prompt.ts`
- Test: `scripts/test-row-prompt.ts`
- Modify: `package.json:16`

**Interfaces:**
- Consumes: `SpriteRequest`·`StateSpec`·`CellSpec`·`classifyState` (Task 1)
- Produces:
  - `STYLE_DEFAULT: string`
  - `TRANSPARENCY_ARTIFACT_RULES: readonly string[]`
  - `STATE_REQUIREMENTS: Record<string, readonly string[]>`
  - `buildRowPrompt(request: SpriteRequest, state: string, entry: StateSpec): string`

### 참조 원본

- `sprite_gen/prepare.py:850-939` — `row_prompt`
- `sprite_gen/prepare.py:49-60` — `STYLE_DEFAULT` (**주석까지 읽을 것**)
- `sprite_gen/prepare.py:62-69` — `TRANSPARENCY_ARTIFACT_RULES`
- `sprite_gen/prepare.py:71-127` — `STATE_REQUIREMENTS`

### 기존 `buildSpritePrompt` 는 이 단계에서 지우지 않는다

`shared.ts` 의 `walkCycleRule`·`singleDirWalkDir`·`actionAnimRule` 등은 정본 원칙에
어긋나지만(스펙 §6.3), **지금 지우면 현재 생성 경로가 즉시 깨진다.** ④가 행 생성을
교체할 때 함께 제거한다. 이 Task 는 새 빌더를 **추가**만 한다.

### 스타일은 텍스트로 재기술하지 않는다 — 단 `STYLE_DEFAULT` 는 예외가 아니다

`STYLE_DEFAULT` 도 텍스트지만 체형·등신·볼살·아웃라인 굵기를 **서술하지 않는다.**
"첨부 레퍼런스를 정확히 따르라" + 금지선만 담는다. 원본 주석에 사고 기록이 있다
(2026-07-05: 기본값의 "compact chibi/chunky/thick outline" 조항이 슬림 베이스를 계속
뭉툭하게 되돌렸다). **이 문자열에 형용사를 더하지 마라.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-row-prompt.ts`:

```ts
/**
 * ② Task 5 — row 프롬프트 Prompt Contract 검증.
 *
 * 문자열 완전 일치는 요구하지 않는다 (스펙 §7). 검사하는 것은 7항목의 존재와
 * request 값의 정확한 주입, 그리고 정본이 금지한 것이 들어가지 않았는지다.
 */
import { buildRowPrompt, STYLE_DEFAULT, TRANSPARENCY_ARTIFACT_RULES } from "@/lib/sprite/row-prompt";
import { normalizeCell, normalizeStates, DEFAULT_CHROMA_TUNABLES, type SpriteRequest } from "@/lib/sprite/request";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const request: SpriteRequest = {
  version: 1,
  character: { id: "aurora", description: "small fox mage in a crimson cloak", anchorGenerationId: "gen_x" },
  cell: normalizeCell({}),
  chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
  chroma: DEFAULT_CHROMA_TUNABLES,
  states: normalizeStates(null),
};

const p = buildRowPrompt(request, "attack", request.states.attack);

console.log("=== Prompt Contract 7항목 ===");
check("1. 정확한 프레임 수", /Exactly 4 full-body frames/.test(p), "");
check("2. 슬롯마다 완전한 전신 포즈 하나", /exactly one complete full-body pose/.test(p));
check("3. safe margin 수치", p.includes("24 px horizontal") && p.includes("24 px vertical"));
check("4. 모든 프레임에 동일한 잠긴 앵커 정체성", /anchors own character identity/.test(p));
check("5. 모션 전용 행 책임", /This row owns motion only/.test(p));
check("6. 평면 크로마 배경", p.includes("#00FF00") && /perfectly flat pure green/.test(p));
check("7. 금지 목록 — 가이드 박스", /Do not reproduce the layout guide/.test(p));
check("7. 금지 목록 — 그림자·글로우·스미어", /shadows/.test(p) && /glows/.test(p) && /smears/.test(p));
check("7. 금지 목록 — 텍스트·UI·프레임 번호", /frame numbers/.test(p) && /UI panels/.test(p));
check("7. 금지 목록 — 분리된 이펙트", /Do not draw detached effects/.test(p));

console.log("=== request 값 주입 ===");
check("캐릭터 id", p.includes("`aurora`"));
check("캐릭터 서술", p.includes("small fox mage in a crimson cloak"));
check("상태명", p.includes("`attack`"));
check("action 서술", p.includes("simple windup, strike, recovery"));
check("셀 치수", p.includes("256x256"));
{
  const rect = buildRowPrompt(
    { ...request, cell: normalizeCell({ width: 192, height: 208 }) },
    "idle", request.states.idle,
  );
  check("rect 셀도 치수가 반영된다", rect.includes("192x208"));
  check("rect 셀의 축별 margin", rect.includes("18 px horizontal") && rect.includes("19 px vertical"));
}
{
  const six = buildRowPrompt(request, "idle", { ...request.states.idle, frames: 6 });
  check("프레임 수는 entry 에서 온다", /Exactly 6 full-body frames/.test(six));
}

console.log("=== 상태별 요구사항 ===");
{
  const walk = buildRowPrompt(request, "walk", { frames: 8, fps: 8, loop: true, action: "walk cycle" });
  check("walk 는 상태별 요구사항이 붙는다", /State-specific requirements/.test(walk));
  check("walk 요구사항 — 제자리 흔들림 금지", /instead of repeated standing or static bobbing/.test(walk));
  check("attack 은 상태별 블록이 없다", !/State-specific requirements/.test(p));
}

console.log("=== 스타일 SSoT ===");
check("STYLE_DEFAULT 가 프롬프트에 들어간다", p.includes(STYLE_DEFAULT));
check("STYLE_DEFAULT 는 레퍼런스 추종을 요구한다", /match the attached base\/anchor reference image EXACTLY/.test(STYLE_DEFAULT));
for (const banned of ["chibi", "chunky", "thick outline", "head-to-body", "등신"]) {
  check(`STYLE_DEFAULT 가 체형을 재기술하지 않는다 — '${banned}' 없음`,
    !STYLE_DEFAULT.toLowerCase().includes(banned.toLowerCase()));
}
check("투명·아티팩트 규칙 6종이 모두 들어간다",
  TRANSPARENCY_ARTIFACT_RULES.every(r => p.includes(r)),
  `${TRANSPARENCY_ARTIFACT_RULES.length} rules`);

console.log("=== 크로마 인접색 금지 ===");
check("소재에 키 색을 쓰지 말라는 지시", /Do not use #00FF00, pure green, or chroma-adjacent colors/.test(p));

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-row-prompt.ts
```

Expected: `Cannot find module '@/lib/sprite/row-prompt'`.

- [ ] **Step 3: `row-prompt.ts` 를 구현한다**

`sprite_gen/prepare.py:850-939` 를 그대로 옮긴다. 아래 골격에 원본 문자열을 채운다 —
**원문을 임의로 다듬지 마라.** 각 문단은 검증 런에서 굳어진 문구다.

```ts
/**
 * row 프롬프트 — sprite_gen/prepare.py `row_prompt()` 이식.
 *
 * 스타일 SSoT 는 첨부 레퍼런스다. 이 빌더는 모션 서술과 레이아웃·크로마 규칙만 담고
 * 체형·비율·아웃라인 굵기를 텍스트로 재기술하지 않는다 (docs/pixel-unfake.md).
 */
import type { SpriteRequest, StateSpec } from "@/lib/sprite/request";

/** 기본값은 레퍼런스 추종 + 금지선만. 2026-07-05 사고 기록: 기본값에 있던
 *  "compact chibi/chunky/thick outline" 조항이 슬림 베이스를 계속 뭉툭하게
 *  되돌렸다. 이 문자열에 체형 형용사를 더하지 마라. */
export const STYLE_DEFAULT =
  "match the attached base/anchor reference image EXACTLY: same pixel density " +
  "(logical pixel block size), same body proportions, same outline weight, same " +
  "palette, same shading style, same level of detail. Do not restyle, do not " +
  "change proportions, do not add or remove detail density. Avoid polished " +
  "illustration, painterly rendering, anime key art, 3D render, vector app-icon " +
  "polish, glossy lighting, soft gradients, and anti-aliased high-detail edges.";

export const TRANSPARENCY_ARTIFACT_RULES: readonly string[] = [
  /* prepare.py:62-69 의 6개 문자열을 그대로 */
];

export const STATE_REQUIREMENTS: Record<string, readonly string[]> = {
  /* prepare.py:71-127 을 그대로. 최소한 running-*, run, walk, frontwalk,
     45_frontwalk, wave 를 포함한다 */
};

export function buildRowPrompt(
  request: SpriteRequest, state: string, entry: StateSpec,
): string {
  const { cell, chromaKey, character } = request;
  const frames = entry.frames;
  const runtimeSize = `${cell.width}x${cell.height}`;

  const stateRequirements = STATE_REQUIREMENTS[state] ?? [];
  const stateRequirementText = stateRequirements.length
    ? "\n\nState-specific requirements:\n" + stateRequirements.map(r => `- ${r}`).join("\n")
    : "";
  const transparencyText = TRANSPARENCY_ARTIFACT_RULES.map(r => `- ${r}`).join("\n");

  const referenceContract = /* prepare.py:886-892 그대로 */ "";

  return `Create a single horizontal sprite strip for the game character \`${character.id}\` in the state \`${state}\`.

${referenceContract}

Character: ${character.description || character.id}.
Style contract: ${STYLE_DEFAULT}.

Use this prompt as an authoritative sprite-production spec. Do not expand it into a polished illustration, painterly character image, anime key art, 3D render, vector mascot, glossy app icon, realistic portrait, or marketing artwork.

Animation action: ${entry.action}.

Anchor lock:
${/* prepare.py:911-918 의 7개 불릿 그대로 */ ""}
${stateRequirementText}

Transparency and artifact rules:
${transparencyText}

Layout requirements:
- Exactly ${frames} full-body frames, left to right, in one horizontal row.
${/* prepare.py:927-937 의 나머지 불릿 그대로. ${frames}·${runtimeSize}·
     ${chromaKey.name}·${chromaKey.hex}·${cell.safeMarginX}·${cell.safeMarginY} 를 주입 */ ""}

Output only the sprite strip image.`;
}
```

**옮기지 않는 것 2가지 (근거를 함께 남길 것):**

1. `motion_phase_guides` 관련 블록 (prepare.py:869-883) — 8프레임 로코모션 전용
   옵트인이고 스펙 §6.2 가 ② 범위에서 제외했다.
2. `direction_prefix_requirements` / `directional_requirements` (prepare.py:860-861) —
   방향 앵커 계약에 속하므로 ③에서 함께 이식한다. `STATE_REQUIREMENTS` 만 지금 넣는다.

`character.base_image` 분기(prepare.py:893-898)도 제외한다 — 우리는 ①에서 base 를
잠그고 ③에서 앵커를 만들므로 "pre-idle 단순 런" 경로가 없다.

- [ ] **Step 4: 테스트를 실행해 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-row-prompt.ts
```

Expected: 전부 통과.

- [ ] **Step 5: Python 기준 프롬프트와 항목 대조한다**

```bash
/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python -c "
import sys; sys.path.insert(0, '/Users/wonpyoung/Developer/workspace/sprite-gen')
from sprite_gen.prepare import row_prompt, normalize_cell, normalize_states, STYLE_DEFAULT
req = {
  'cell': normalize_cell({}, 256, None),
  'chroma_key': {'name':'green','hex':'#00FF00','rgb':[0,255,0]},
  'character': {'id':'aurora','description':'small fox mage in a crimson cloak'},
  'style': STYLE_DEFAULT,
}
states = normalize_states(None)
print(row_prompt(req, 'attack', states['attack']))
" > /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/row-ref.txt
wc -l /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/row-ref.txt
```

그 다음 우리 출력을 같은 위치에 뽑아 `diff` 로 **누락된 줄이 없는지** 본다:

```bash
pnpm exec tsx -e "
import { buildRowPrompt } from './src/lib/sprite/row-prompt';
import { normalizeCell, normalizeStates, DEFAULT_CHROMA_TUNABLES } from './src/lib/sprite/request';
const s = normalizeStates(null);
console.log(buildRowPrompt({
  version: 1,
  character: { id: 'aurora', description: 'small fox mage in a crimson cloak', anchorGenerationId: 'x' },
  cell: normalizeCell({}), chroma: DEFAULT_CHROMA_TUNABLES,
  chromaKey: { name: 'green', hex: '#00FF00', rgb: [0,255,0], selection: 'auto' },
  states: s,
}, 'attack', s.attack));
" > /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/row-mine.txt
diff /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/row-ref.txt /private/tmp/claude-501/-Users-wonpyoung-Developer-workspace-game-art-studio/03e316ff-6f2c-4cb8-8f99-d291b359b4a2/scratchpad/row-mine.txt
```

Expected: 차이는 위에서 **의도적으로 제외한 항목뿐**이어야 한다. 예상 못 한 누락이
나오면 채운다. `diff` 출력을 커밋 메시지나 보고에 요약한다.

- [ ] **Step 6: `package.json` 에 체이닝하고 커밋한다**

`test` 에 `&& tsx scripts/test-row-prompt.ts` 추가.

```bash
git add src/lib/sprite/row-prompt.ts scripts/test-row-prompt.ts package.json
git commit -m "feat(sprite): row 프롬프트 빌더 — Prompt Contract 7항목 이식"
```

---

## Task 6: 스펙 갱신과 전체 회귀

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md`

- [ ] **Step 1: 스펙 §6 에 정정 3건을 반영한다**

이 계획서 상단 "정본 대조로 드러난 스펙 정정 3건"을 스펙 §6.1 뒤에 §6.1.1 로 옮긴다.
§6.6 표에는 `states[s].fps` 의 출처를 "기본값 (프레임 수에서 파생)"에서
"`DEFAULT_STATES` 의 상태별 값, 미지 상태는 6"으로 고친다 — 프레임 수에서 파생한다는
서술은 근거가 없었다.

- [ ] **Step 2: 스펙 §7 의 ② 통과 기준을 실측으로 갱신한다**

- `normalizeCell` 행: "출력 객체 동일" → "기하 필드 동일 (레거시 `size`·`safe_margin`
  키는 이식하지 않음)"
- 레이아웃 가이드 행: 렌더 방식이 SVG 가 아니라 raw 버퍼임을 명시하고 근거를 한 줄로
- ② 배선이 이 단계 범위가 아님을 §8 후속 단계 개요에 명시

- [ ] **Step 3: 전체 테스트를 돌린다**

```bash
pnpm test
```

Expected: 기존 5개 + 신규 4개 전부 통과. 실패하면 멈춘다.

- [ ] **Step 4: 타입·린트 게이트**

```bash
pnpm exec tsc --noEmit && pnpm lint
```

Expected: 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md
git commit -m "docs(spec): ② 정본 대조 반영 — 프레임 대역·상태 등급·렌더 방식 정정"
```

- [ ] **Step 6: 브랜치 마무리**

**REQUIRED SUB-SKILL:** superpowers:finishing-a-development-branch

---

## 이 계획이 다루지 않는 것 (의도적)

| 항목 | 어디로 |
|---|---|
| 모듈을 `spritesheet-handler.ts` 에 배선 | ④ (행 생성이 흐름을 교체한다) |
| 기존 `buildSpritePrompt` 거대 지시문 제거 | ④ (지금 지우면 현재 경로가 깨진다) |
| `generateGridTemplate` 를 레이아웃 가이드로 대체 | ④ (호출부가 함께 이동해야 한다) |
| 방향 앵커 상태 요구사항 (`direction_prefix_requirements`) | ③ |
| `motion_phase_guides` | ⑥ (`pose-reference.ts` 와 통합 방식을 함께 결정) |
| 패널 기본값 8프레임 → 4 조정 | 스펙 §3.3 UI 체크포인트 (④ 이후 실측 근거로) |
| 다중 상태 입력 UI | 스펙 §3.3 (② 이후 실제 필요성 확인) |
| 3패스 크로마 알파 정리 (추출 측) | ⑤ |

## 자체 점검 결과

- **스펙 커버리지**: §6.1(request/크로마 키) → Task 1·3, §6.2(가이드) → Task 4,
  §6.3(프롬프트) → Task 5, §6.4(경계) → 파일 구조, §6.5(에러) → Task 1 검증·Task 3
  폴백·Task 4 throw, §6.6(UI) → 다루지 않음(위 표에 명시).
  **미커버 1건**: §6.5 의 "셀 치수 검증 실패(codex 캔버스 한계 초과) → throw" 는
  `frames × cellW` 한계값을 아직 모른다. ⓪ 검증에서 codex 출력이 ~1024px 급 고정으로
  나왔을 뿐 입력 한계는 측정하지 않았다. **④에서 실측 후 넣는다** — 모르는 상수를
  지어내지 않는다.
- **플레이스홀더**: Task 5 Step 3 에 `/* prepare.py:NN-NN 그대로 */` 주석이 남아 있다.
  이것은 미완성이 아니라 **원문을 임의 편집하지 말라는 지시**다. 구현자는 해당 줄
  범위를 읽어 그대로 옮긴다.
- **타입 일관성**: `CellSpec`(Task 1)이 Task 4 의 `GuideCell` 을 구조적으로 만족하는지
  확인 — `width`·`height`·`safeMarginX`·`safeMarginY` 4필드가 일치한다. `ChromaKeySpec`
  은 Task 1 에서 정의하고 Task 3 이 확장한다.
