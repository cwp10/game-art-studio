# ④a단계 — 플랜 구동 생성 경로 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** ①②③에서 만든 미배선 모듈들을 하나의 실행기로 엮어, **base 잠금 → 방향 앵커 생성 →
앵커 베이크 → 액션 행 생성** 체인을 codex 로 실제 1회 왕복시키고, 그 결과물을 현재 경로의
결과물과 나란히 비교한다.

**Architecture:** 새 실행기 `run-plan.ts` 가 ③의 `buildGenerationPlan` 순서대로 돈다.
생성 함수를 주입받아 codex 없이도 테스트되고, CLI 드라이버가 실제 codex 로 구동한다.
**기존 `handleMakeSpritesheet` 경로는 건드리지 않는다.**

**Tech Stack:** TypeScript / sharp / better-sqlite3 / codex CLI / tsx

---

## Global Constraints

- 정본 계약은 sprite-gen `SKILL.md`, 시나리오 상세는 각 leaf 문서가 소유한다.
- **앵커 = 1장.** 액션 행에 base 를 재부착하지 않는다 — 런타임으로 검증한다.
- **No Silent Fallback.** 앵커를 못 내면 행을 생성하지 않는다. pending 과 broken 을 구분한다.
- 앵커 ref 는 **파생 캐시**다 — 매 행 생성 직전에 다시 굽는다.
- 미러 방향은 생성하지 않는다(계약으로 기록). 런타임 미러는 후속.
- Python 런타임 의존 없음. 기존 상수·문구를 임의로 다듬지 않는다.
- 브랜치는 `feat/plan-driven-generation`.

---

## 왜 UI 배선이 아니라 CLI 드라이버부터인가

스펙 §8 에 적은 ④ 진입 조건은 UI 배선을 첫 항목으로 뒀다. **순서를 바꾼다.**

지금 가장 값진 것은 "새 파이프라인이 옛것보다 나은 시트를 내는가"의 답이다. 사용자의 원래
문제 진술이 *"우리 파이프라인이 매번 실패했었어"* 였고, ⓪①②③ 세 단계 동안 **codex 를 한 번도
새 경로로 돌리지 않았다.** 결정론 부분은 Python 과 픽셀 대조까지 했지만, 생성 품질은 대조로
알 수 없다.

- 실행기 + CLI 로 먼저 왕복시키면 그 답이 나온다. 좋으면 UI 배선은 기계적이고, 나쁘면
  UI 를 먼저 뜯은 것이 낭비였을 것이다.
- 기존 경로를 그대로 두므로 앱이 깨지지 않는다.

**대가**: 이 단계가 끝나도 사용자 화면은 그대로다. ④b(UI 배선)까지 가야 제품이 바뀐다.

### ④ 를 셋으로 쪼갠다

| | 범위 | 이 계획 |
|---|---|---|
| **④a** | 플랜 실행기 + 앵커 베이크 배선 + CLI + **구/신 경로 비교** | **여기** |
| ④b | `spritesheet-handler` 배선, `SpriteCanvas` 큐레이션 영속, 앵커 핀 UI | 별도 |
| ④c | 상태 앵커 게이트(정본 체크리스트 3), 좌우 쌍 생성 순서, 모션 contact sheet | 별도 |

쪼개는 이유는 ④a 가 단독으로 동작하는 소프트웨어이고, ④b·④c 의 우선순위가 ④a 의 결과에
따라 달라지기 때문이다. 걷기·달리기가 여전히 나쁘면 ④c(모션 참조)가 ④b 보다 급하다.

---

## 정본 대조로 확인한 사실 (이 계획의 근거)

`docs/locomotion-curation.md`·`docs/gen.md`·`docs/curation.md` 를 읽고 확인한 것.

### 1. 정본도 인간형 로코모션을 자동으로 풀지 못한다

> For precise humanoid running today, the most reliable path is **candidate generation plus
> human frame picking.** Generate a few candidate rows, keep the best extracted frames, and let
> the user choose or reorder the 1-based frame sequence. **Do not promise automatic frame-order
> selection yet**; if the row only works after manual picking, record that as the current
> limitation in `qa-notes.md`.

이식이 끝나도 walk/run 이 자동으로 좋아지리라 기대하면 안 된다. **우리 `SpriteCanvas` 의
프레임 제외·재정렬이 곧 이 "human frame picking" 경로다** — 이미 갖고 있는 강점이며, ④b 가
그것을 `selected` 로 영속시키면 정본이 말하는 가장 신뢰할 만한 경로가 완성된다.

### 2. 행 전체가 실패해도 통과로 위장하지 않는다 — 별도 산출물로 남긴다

> When a generated locomotion row contains usable frames but the full row fails motion QA,
> **do not pretend the full row passed** and **do not ask image generation to redraw locked peak
> frames.** Preserve the generated frame truth and make a separate selected-cycle artifact.

selected-cycle 은 `qa/<name>.json` 이 SSoT 이고 소스 상태·1-based 선택 프레임·런타임 0-based
인덱스·delay·**프레임별 SHA-256** 을 기록한다. 이건 ⑥ 범위지만, ④a 의 비교 검증에서
"일부 프레임만 쓸 만하다"가 나올 가능성이 높으므로 **그때 전체 통과로 보고하지 않는다.**

### 3. codex 인자는 이미 정본과 일치한다 (사후 확인)

`gen.md` 의 codex 절과 우리 [codex-exec.ts:516](../../../src/lib/image-backend/codex-exec.ts) 대조:
`--json` · `--sandbox workspace-write` · `--skip-git-repo-check` · `--color never` ·
`--add-dir ~/.codex/generated_images` · `--ephemeral` 없음 — 전부 일치. ⓪이 맞았다.

두 가지가 새로 나왔다:

- **속도 실측**: 4프레임 idle 행에서 codex ~39.0s (grok ~18.4s). 우리 타임아웃 600s 는
  넉넉하다. 방향 앵커 1 + 액션 행 1이면 ~80s 를 예상한다.
- **rollout jsonl 을 추출 후 삭제한다**(`--keep-session` 이 아니면). 우리는 삭제하지 않는다.
  1회 1~1.5MB 이므로 **누적 디스크 이슈**다. ④a 범위 밖이지만 기록해 둔다.

### 4. 큐레이션 필드 중 우리가 안 가진 것

이미 ③에서 `selected`/`order` 를 맞췄다. 남은 미이식: `clones`(홀드 프레임),
`transforms`(프레임별 어파인 — 우리 `SpriteCanvas.offsets` 가 dx/dy 부분), `run_revision`,
`pixel_unfake` 2층, `recolor.picked`. **④a 는 이들을 쓰지 않는다.**

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/lib/sprite/build-request.ts` (신규) | 패널 인자 → `SpriteRequest` 조립 (②③ 모듈 사용) |
| `src/lib/sprite/run-plan.ts` (신규) | 플랜 실행기. 생성 함수를 주입받는다 — codex 를 모른다 |
| `scripts/gen-sprite-run.ts` (신규) | CLI 드라이버. 실제 codex 로 구동 |
| `scripts/test-build-request.ts` (신규) | Task 1 |
| `scripts/test-run-plan.ts` (신규) | Task 2·3 (가짜 생성기 주입) |
| `package.json` | `test` 체이닝 + `gen:sprite-run` 스크립트 |

**건드리지 않는 것**: `spritesheet-handler.ts`, `shared.ts`, `SpriteGenPanel.tsx`,
`SpriteCanvas.tsx`. 전부 ④b 다.

---

## Task 1: SpriteRequest 조립기

**Files:**
- Create: `src/lib/sprite/build-request.ts`
- Test: `scripts/test-build-request.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `normalizeCell`·`normalizeStates`·`DEFAULT_CHROMA_TUNABLES` (②),
  `chooseChromaKey` (②), `normalizeDirections`·`ensureDirectionAnchors`·`toSpriteGenDirection` (③)
- Produces:
  - `type PanelInput = { characterId: string; description: string; baseImagePath: string | null; uiDirection: string; frames: number; loop: boolean; actionPrompt: string; stateName?: string; cellSize?: number; mirrorFrom?: string }`
  - `buildSpriteRequest(input: PanelInput): Promise<{ request: SpriteRequest; warnings: string[] }>`

### 설계 결정 3건

1. **상태 이름은 `<direction>_<state>` 로 강제한다.** ③의 `normalizeDirections` 가 접두사를
   요구하기 때문이다. 패널의 `actionPrompt` 는 자연어이므로 상태 **이름**은 별도로 받거나
   (`stateName`) 기본값 `action` 을 쓴다. `down_action` 같은 이름이 된다.
   **정본의 `STATE_REQUIREMENTS` 가 이 이름에 걸리지 않는다**(§8 ③ 구현 결과에 기록). 즉
   로코모션 anti-bobbing 지시가 빠진다 — ④a 의 비교 검증에서 이것이 문제로 드러나는지 본다.

2. **`REF` 방향은 방향 계약 없이 간다.** `toSpriteGenDirection("REF") === null` 이므로
   `directions` 를 만들지 않고 상태 이름도 접두사 없이 쓴다. 이 경우 플랜도 `null` 이라
   실행기가 단일 행 경로로 떨어진다(Task 2).

3. **크로마 키는 base 이미지에서 고른다.** base 가 없으면 `chooseChromaKey(null, "auto")` 가
   마젠타로 폴백하고 경고를 남긴다 — 생성을 막지 않는다(스펙 §6.5).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-build-request.ts`:

```ts
/**
 * ④a Task 1 — SpriteRequest 조립 테스트.
 * 패널 인자에서 ②③ 계약을 만족하는 request 가 나오는지 본다.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpriteRequest } from "../src/lib/sprite/build-request";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

void (async () => {
  const base = {
    characterId: "aurora",
    description: "small fox mage in a crimson cloak",
    baseImagePath: null,
    uiDirection: "DOWN",
    frames: 4,
    loop: true,
    actionPrompt: "subtle breathing idle",
  };

  console.log("=== 방향 계약이 붙는다 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("directions.set 은 down 하나", request.directions?.set.join(",") === "down");
    check("anchorSuffix 는 idle", request.directions?.anchorSuffix === "idle");
    check("상태 이름에 방향 접두사", "down_action" in request.states, Object.keys(request.states).join(","));
    check("앵커 상태가 합성된다", "down_idle" in request.states);
    check("앵커 상태가 앞에 온다", Object.keys(request.states)[0] === "down_idle");
    check("요청 프레임 수가 반영된다", request.states.down_action.frames === 4);
    check("요청 loop 이 반영된다", request.states.down_action.loop === true);
    check("action 은 패널 문구", request.states.down_action.action === "subtle breathing idle");
  }

  console.log("=== 45도 방향 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "DOWN-RIGHT" });
    check("DOWN-RIGHT → front-right", request.directions?.set.join(",") === "front-right");
    check("상태 이름", "front-right_action" in request.states);
  }

  console.log("=== REF 는 방향 계약 없음 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "REF" });
    check("directions 없음", request.directions === undefined);
    check("상태 이름에 접두사 없음", "action" in request.states, Object.keys(request.states).join(","));
  }

  console.log("=== 미러 계약 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "RIGHT", mirrorFrom: "LEFT" });
    check("미러 대상이 기록된다", request.directions?.mirror.left === "right", JSON.stringify(request.directions));
    check("미러 방향은 set 에 없다", !request.directions?.set.includes("left"));
  }

  console.log("=== 셀 기하 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("기본 셀 256 정사각", request.cell.width === 256 && request.cell.height === 256);
    check("비례 margin 24", request.cell.safeMarginX === 24);
    const { request: r2 } = await buildSpriteRequest({ ...base, cellSize: 128 });
    check("cellSize 반영 + 비례 margin 12", r2.cell.width === 128 && r2.cell.safeMarginX === 12);
  }

  console.log("=== 크로마 키 ===");
  {
    const { request, warnings } = await buildSpriteRequest(base);
    check("base 없으면 마젠타 폴백", request.chromaKey.hex === "#FF00FF");
    check("폴백이 경고로 남는다", warnings.some(w => w.includes("chroma")), warnings.join(" | "));
  }
  {
    const dir = await mkdtemp(join(tmpdir(), "req-"));
    try {
      // 흰 배경 + 크림슨 소재 → 마젠타가 아닌 키가 뽑혀야 한다
      const w = 64, h = 64;
      const raw = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) { raw[i*4] = 254; raw[i*4+1] = 254; raw[i*4+2] = 254; raw[i*4+3] = 255; }
      for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
        const o = (y*w+x)*4; raw[o] = 153; raw[o+1] = 12; raw[o+2] = 40;
      }
      const p = join(dir, "base.png");
      await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(p);
      const { request } = await buildSpriteRequest({ ...base, baseImagePath: p });
      check("크림슨 base 에는 마젠타를 안 고른다", request.chromaKey.hex !== "#FF00FF", request.chromaKey.hex);
      check("선택 근거가 기록된다", typeof request.chromaKey.minSubjectDistance === "number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("=== 튜너블 기본값 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("chroma.mode 는 rgb (ycbcr 은 옵트인)", request.chroma.mode === "rgb");
    check("keyThreshold 96", request.chroma.keyThreshold === 96);
  }

  console.log("=== 프레임 수 경고 ===");
  {
    const { warnings } = await buildSpriteRequest({ ...base, frames: 12 });
    check("12프레임은 not-default 경고", warnings.some(w => w.includes("duplicate")), warnings.join(" | "));
  }
  {
    const { warnings } = await buildSpriteRequest({ ...base, frames: 4 });
    check("4프레임은 경고 없음", !warnings.some(w => w.includes("duplicate")));
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-build-request.ts
```

Expected: `Cannot find module '../src/lib/sprite/build-request'`.

- [ ] **Step 3: `build-request.ts` 를 구현한다**

```ts
/**
 * 패널 인자 → SpriteRequest 조립.
 *
 * ②의 셀·상태·크로마 정규화와 ③의 방향 계약을 한 자리에서 엮는다. 이 함수의 출력이
 * 이후 모든 것(가이드·프롬프트·플랜·추출·아틀라스)의 SSoT 다.
 */
import { chooseChromaKey } from "@/lib/sprite/chroma-key";
import {
  ensureDirectionAnchors,
  normalizeDirections,
  toSpriteGenDirection,
} from "@/lib/sprite/directions";
import {
  DEFAULT_CHROMA_TUNABLES,
  DEFAULT_CELL_SIZE,
  frameCountAdvice,
  normalizeCell,
  normalizeStates,
  type SpriteRequest,
  type StateSpec,
} from "@/lib/sprite/request";

export type PanelInput = {
  characterId: string;
  description: string;
  /** 잠긴 base 의 파일 경로. null 이면 크로마 키가 마젠타로 폴백한다. */
  baseImagePath: string | null;
  /** SpriteGenPanel 의 Direction 값 (DOWN/UP/... /REF). */
  uiDirection: string;
  frames: number;
  loop: boolean;
  actionPrompt: string;
  /** 상태 이름(방향 접두사 제외). 기본 "action". */
  stateName?: string;
  cellSize?: number;
  /** 런타임 미러로 커버할 UI 방향. 생성하지 않고 계약으로만 기록한다. */
  mirrorFrom?: string;
};

const DEFAULT_STATE_NAME = "action";

/** 프레임 수에서 파생하지 않는다 — 정본은 상태별 고정값을 쓴다. 미지 상태는 6. */
const DEFAULT_FPS = 6;

export async function buildSpriteRequest(
  input: PanelInput,
): Promise<{ request: SpriteRequest; warnings: string[] }> {
  const warnings: string[] = [];

  const direction = toSpriteGenDirection(input.uiDirection);
  const bareState = input.stateName ?? DEFAULT_STATE_NAME;
  const stateName = direction === null ? bareState : `${direction}_${bareState}`;

  const advice = frameCountAdvice(input.frames);
  if (advice.band === "not-default" || advice.band === "advanced") {
    warnings.push(`frames=${input.frames} (${advice.band}): ${advice.note}`);
  }

  const requested: Record<string, Partial<StateSpec>> = {
    [stateName]: {
      frames: input.frames,
      fps: DEFAULT_FPS,
      loop: input.loop,
      action: input.actionPrompt,
    },
  };

  let states = normalizeStates(requested);
  let directions: SpriteRequest["directions"];
  if (direction !== null) {
    const mirrorTarget = input.mirrorFrom ? toSpriteGenDirection(input.mirrorFrom) : null;
    directions =
      normalizeDirections(
        {
          set: [direction],
          ...(mirrorTarget && mirrorTarget !== direction
            ? { mirror: { [mirrorTarget]: direction } }
            : {}),
        },
        states,
      ) ?? undefined;
    if (directions) states = ensureDirectionAnchors(directions, states);
  }

  const chromaKey = await chooseChromaKey(input.baseImagePath, "auto");
  if (chromaKey.selection === "fallback") {
    warnings.push(`chroma key fallback: ${chromaKey.selectionReason ?? "unknown reason"}`);
  }
  if (chromaKey.warning) warnings.push(`chroma key: ${chromaKey.warning}`);

  return {
    request: {
      version: 1,
      character: {
        id: input.characterId,
        description: input.description,
        // ③의 resolveAnchor 가 실제 앵커를 정한다. 여기서는 base 를 가리켜 둔다.
        anchorGenerationId: "",
      },
      cell: normalizeCell({ size: input.cellSize ?? DEFAULT_CELL_SIZE }),
      chromaKey,
      chroma: DEFAULT_CHROMA_TUNABLES,
      states,
      ...(directions ? { directions } : {}),
    },
    warnings,
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-build-request.ts
```

Expected: `20 passed / 0 failed`

- [ ] **Step 5: 체이닝하고 커밋**

`package.json` `test` 끝에 `&& tsx scripts/test-build-request.ts`.

```bash
git add src/lib/sprite/build-request.ts scripts/test-build-request.ts package.json
git commit -m "feat(sprite): 패널 인자에서 SpriteRequest 조립"
```

---

## Task 2: 플랜 실행기 골격

**Files:**
- Create: `src/lib/sprite/run-plan.ts`
- Test: `scripts/test-run-plan.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildGenerationPlan`·`PlanItem`·`PlanRef` (③), `renderLayoutGuide` (②),
  `buildRowPrompt` (②③), `resolveAnchor`·`AnchorUnavailable` (③), `bakeAnchorImage` (③)
- Produces:
  - `type GenerateFn = (spec: { state: string; prompt: string; inputPaths: string[]; role: PlanItem["role"] }) => Promise<{ generationId: string; imagePath: string; width: number; height: number }>`
  - `type RunPlanDeps = { generate: GenerateFn; workDir: string; lockedBasePath: string | null; log: (m: string) => void }`
  - `type RunPlanResult = { rows: Record<string, { generationId: string; imagePath: string; frameCount: number }>; anchors: Record<string, { path: string; state: string; index: number; source: string }>; skippedMirrors: MirroredDirection[]; warnings: string[] }`
  - `runSpritePlan(request: SpriteRequest, deps: RunPlanDeps): Promise<RunPlanResult>`

### 생성 함수를 주입받는 이유

실행기가 codex 를 직접 부르면 테스트가 codex 를 요구한다. 순서·ref 계약·앵커 베이크 시점은
결정론이므로 가짜 생성기로 전부 검증할 수 있고, 실제 codex 는 Task 4 의 CLI 가 주입한다.
①②③이 순수 함수를 고집한 것과 같은 이유다.

### ref 계약을 런타임에 검증한다

플랜의 `PlanRef.kind` 를 실제 첨부 경로와 대조한다. **액션 행에 base 경로가 들어가면 throw.**
정본이 이 규칙을 세 번 반복하고(체인 그림 / 체크리스트 5 / Anchor lock), 어긴 결과가
정체성 드리프트이므로 주석이 아니라 코드로 막는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-run-plan.ts`:

```ts
/**
 * ④a Task 2·3 — 플랜 실행기 테스트. 가짜 생성기를 주입해 codex 없이 검증한다.
 *
 * 확인 대상: stage 순서 · 액션 행에 base 금지 · 앵커 베이크 시점 · 미러 생략 · 실패 전파.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpriteRequest } from "../src/lib/sprite/build-request";
import { runSpritePlan, type GenerateFn } from "../src/lib/sprite/run-plan";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** frames 칸짜리 가로 시트를 만든다. 각 셀 중앙에 불투명 사각형(알파 있음). */
async function fakeSheet(dest: string, frames: number, cell: number): Promise<void> {
  const w = frames * cell;
  const raw = Buffer.alloc(w * cell * 4);
  for (let f = 0; f < frames; f++) {
    for (let y = cell / 4; y < (cell * 3) / 4; y++) {
      for (let x = f * cell + cell / 4; x < f * cell + (cell * 3) / 4; x++) {
        const o = (y * w + x) * 4;
        raw[o] = 200; raw[o + 1] = 100; raw[o + 2] = 50; raw[o + 3] = 255;
      }
    }
  }
  await sharp(raw, { raw: { width: w, height: cell, channels: 4 } }).png().toFile(dest);
}

void (async () => {
  const dir = await mkdtemp(join(tmpdir(), "runplan-"));
  try {
    const { request } = await buildSpriteRequest({
      characterId: "aurora",
      description: "small fox mage",
      baseImagePath: null,
      uiDirection: "DOWN",
      frames: 4,
      loop: true,
      actionPrompt: "walk cycle",
    });

    const calls: Array<{ state: string; role: string; inputPaths: string[] }> = [];
    const generate: GenerateFn = async spec => {
      calls.push({ state: spec.state, role: spec.role, inputPaths: [...spec.inputPaths] });
      const out = join(dir, `${spec.state}.png`);
      const frames = request.states[spec.state].frames;
      await fakeSheet(out, frames, request.cell.width);
      return { generationId: `gen_${spec.state}`, imagePath: out, width: frames * request.cell.width, height: request.cell.height };
    };

    const basePath = join(dir, "base.png");
    await fakeSheet(basePath, 1, request.cell.width);

    const result = await runSpritePlan(request, {
      generate, workDir: dir, lockedBasePath: basePath, log: () => {},
    });

    console.log("=== 생성 순서 ===");
    check("두 번 생성한다 (앵커 1 + 행 1)", calls.length === 2, `${calls.length}`);
    check("앵커가 먼저", calls[0].state === "down_idle" && calls[0].role === "direction-anchor");
    check("행이 나중", calls[1].state === "down_action" && calls[1].role === "action-row");

    console.log("=== ref 계약 ===");
    check("앵커 행에 base 가 붙는다", calls[0].inputPaths.includes(basePath));
    check("액션 행에 base 가 없다", !calls[1].inputPaths.includes(basePath));
    check("액션 행에 앵커 파일이 붙는다",
      calls[1].inputPaths.some(p => p.includes("anchor")), calls[1].inputPaths.join(","));
    check("두 호출 다 레이아웃 가이드가 붙는다",
      calls.every(c => c.inputPaths.some(p => p.includes("guide"))));
    check("가이드가 마지막 (정본 ref 순서: 앵커 → 가이드)",
      calls[1].inputPaths[calls[1].inputPaths.length - 1].includes("guide"));

    console.log("=== 결과 ===");
    check("행 두 개가 기록된다", Object.keys(result.rows).length === 2);
    check("프레임 수가 기록된다", result.rows.down_action.frameCount === 4);
    check("앵커가 기록된다", result.anchors.down !== undefined);
    check("앵커 source 는 default", result.anchors.down.source === "default");
    check("앵커 index 는 0 (큐레이션 없음)", result.anchors.down.index === 0);

    console.log("=== 미러는 생성하지 않는다 ===");
    {
      const { request: mreq } = await buildSpriteRequest({
        characterId: "a", description: "d", baseImagePath: null,
        uiDirection: "RIGHT", frames: 4, loop: true, actionPrompt: "walk", mirrorFrom: "LEFT",
      });
      const mcalls: string[] = [];
      const r = await runSpritePlan(mreq, {
        generate: async spec => {
          mcalls.push(spec.state);
          const out = join(dir, `m-${spec.state}.png`);
          await fakeSheet(out, mreq.states[spec.state].frames, mreq.cell.width);
          return { generationId: `g_${spec.state}`, imagePath: out, width: 1, height: 1 };
        },
        workDir: dir, lockedBasePath: basePath, log: () => {},
      });
      check("left 는 생성하지 않는다", !mcalls.some(s => s.startsWith("left")), mcalls.join(","));
      check("미러가 계약으로 기록된다", r.skippedMirrors.some(m => m.direction === "left"));
    }

    console.log("=== 방향 계약 없는 런 (REF) ===");
    {
      const { request: freq } = await buildSpriteRequest({
        characterId: "a", description: "d", baseImagePath: null,
        uiDirection: "REF", frames: 4, loop: true, actionPrompt: "walk",
      });
      const fcalls: string[] = [];
      const r = await runSpritePlan(freq, {
        generate: async spec => {
          fcalls.push(spec.state);
          const out = join(dir, `f-${spec.state}.png`);
          await fakeSheet(out, freq.states[spec.state].frames, freq.cell.width);
          return { generationId: `g_${spec.state}`, imagePath: out, width: 1, height: 1 };
        },
        workDir: dir, lockedBasePath: basePath, log: () => {},
      });
      check("단일 행만 생성", fcalls.length === 1 && fcalls[0] === "action", fcalls.join(","));
      check("앵커 없음", Object.keys(r.anchors).length === 0);
      check("base 가 붙는다 (앵커가 없으므로)", r.rows.action !== undefined);
    }

    console.log("=== 실패 전파 ===");
    {
      let threw = "";
      try {
        await runSpritePlan(request, {
          generate: async () => { throw new Error("codex 실패"); },
          workDir: dir, lockedBasePath: basePath, log: () => {},
        });
      } catch (e) { threw = String(e); }
      check("생성 실패는 전파된다 (조용히 계속하지 않는다)", threw.includes("codex 실패"), threw);
    }
    {
      // 앵커 행이 프레임 0개로 나오면 액션 행을 생성하지 않는다.
      let threw = "";
      const empty = join(dir, "empty.png");
      await sharp({ create: { width: 4, height: 4, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } }).png().toFile(empty);
      try {
        await runSpritePlan(request, {
          generate: async () => ({ generationId: "g", imagePath: empty, width: 4, height: 4 }),
          workDir: dir, lockedBasePath: basePath, log: () => {},
        });
      } catch (e) { threw = String(e); }
      check("앵커를 못 내면 행을 생성하지 않는다", threw.length > 0, threw);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm exec tsx scripts/test-run-plan.ts
```

- [ ] **Step 3: `run-plan.ts` 를 구현한다**

```ts
/**
 * 플랜 실행기 — ③의 buildGenerationPlan 순서대로 생성을 몬다.
 *
 *   stage 1: base → 방향 앵커 행
 *   (앵커 베이크 — 큐레이션 진실에서, 매 행 생성 직전에)
 *   stage 2: 앵커 → 액션 행    ← base 는 여기 붙지 않는다
 *
 * 생성 함수를 주입받으므로 codex 를 모른다. 순서·ref 계약·베이크 시점이 결정론이라
 * 가짜 생성기로 전부 검증된다.
 */
import { join } from "node:path";
import sharp from "sharp";
import {
  AnchorUnavailable,
  resolveAnchor,
  type AnchorContext,
  type AnchorRow,
} from "@/lib/sprite/anchor";
import { bakeAnchorImage } from "@/lib/sprite/anchor-image";
import {
  buildGenerationPlan,
  type MirroredDirection,
  type PlanItem,
} from "@/lib/sprite/generation-plan";
import { renderLayoutGuide } from "@/lib/sprite/layout-guide";
import { buildRowPrompt } from "@/lib/sprite/row-prompt";
import type { SpriteRequest } from "@/lib/sprite/request";

export type GenerateFn = (spec: {
  state: string;
  prompt: string;
  inputPaths: string[];
  role: PlanItem["role"];
}) => Promise<{ generationId: string; imagePath: string; width: number; height: number }>;

export type RunPlanDeps = {
  generate: GenerateFn;
  /** 가이드·앵커 파일을 쓸 디렉터리. */
  workDir: string;
  /** 잠긴 base 의 파일 경로. 방향 앵커 행에만 붙는다. */
  lockedBasePath: string | null;
  log: (message: string) => void;
};

export type RunPlanResult = {
  rows: Record<string, { generationId: string; imagePath: string; frameCount: number }>;
  anchors: Record<string, { path: string; state: string; index: number; source: string }>;
  skippedMirrors: MirroredDirection[];
  warnings: string[];
};

/** 액션 행에 base 가 붙었는지 기계적으로 검증한다 — 주석이 아니라 코드로 막는다. */
function assertNoBase(item: PlanItem, inputPaths: string[], basePath: string | null): void {
  if (item.role !== "action-row" || !basePath) return;
  if (inputPaths.includes(basePath)) {
    throw new Error(
      `runSpritePlan: 액션 행 '${item.state}' 에 base 가 첨부됐다 — ` +
        `base 는 방향 앵커 생성까지만 identity 소스다 (${item.note})`,
    );
  }
}

export async function runSpritePlan(
  request: SpriteRequest,
  deps: RunPlanDeps,
): Promise<RunPlanResult> {
  const result: RunPlanResult = { rows: {}, anchors: {}, skippedMirrors: [], warnings: [] };
  const plan = buildGenerationPlan(request);

  // 방향 계약이 없으면(REF 런) 단일 행 경로 — base 를 그대로 identity 로 쓴다.
  if (!plan) {
    for (const [state, entry] of Object.entries(request.states)) {
      const guide = join(deps.workDir, `guide-${state}.png`);
      await renderLayoutGuide(guide, entry.frames, request.cell);
      const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
      const gen = await deps.generate({
        state,
        prompt: buildRowPrompt(request, state, entry),
        inputPaths,
        role: "action-row",
      });
      result.rows[state] = {
        generationId: gen.generationId,
        imagePath: gen.imagePath,
        frameCount: entry.frames,
      };
    }
    result.warnings.push("방향 계약 없는 런 — 앵커 체인을 쓰지 않는다(REF 모드)");
    return result;
  }

  result.skippedMirrors = plan.mirroredDirections;
  for (const m of plan.mirroredDirections) deps.log(`미러 생략: ${m.direction} ← ${m.mirrorOf}`);

  // ── stage 1: 방향 앵커 행 ────────────────────────────────────────────────
  for (const item of plan.order[0].items) {
    const entry = request.states[item.state];
    const guide = join(deps.workDir, `guide-${item.state}.png`);
    await renderLayoutGuide(guide, entry.frames, request.cell);
    const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
    deps.log(`stage1 ${item.state}: refs=${inputPaths.length}`);
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry),
      inputPaths,
      role: item.role,
    });
    result.rows[item.state] = {
      generationId: gen.generationId,
      imagePath: gen.imagePath,
      frameCount: entry.frames,
    };
  }

  // ── stage 2: 액션 행 ────────────────────────────────────────────────────
  for (const item of plan.order[1].items) {
    const entry = request.states[item.state];

    // 앵커 ref 는 파생 캐시다 — 매 행 생성 직전에 다시 굽는다.
    const anchorRows: Record<string, AnchorRow> = {};
    for (const [state, row] of Object.entries(result.rows)) {
      anchorRows[state] = { generationId: row.generationId, frameCount: row.frameCount, curation: null };
    }
    const ctx: AnchorContext = { request, picks: {}, rows: anchorRows };
    let resolved;
    try {
      resolved = resolveAnchor(ctx, item.direction);
    } catch (e) {
      if (e instanceof AnchorUnavailable) {
        throw new Error(
          `runSpritePlan: '${item.state}' 의 앵커를 낼 수 없다 (${e.kind}${e.pending ? ", pending" : ""}) — ${e.message}`,
        );
      }
      throw e;
    }
    const anchorRow = result.rows[resolved.state];
    const anchorPath = join(deps.workDir, `anchor-${item.direction}-x8.png`);
    const baked = await bakeAnchorImage({
      sheetPath: anchorRow.imagePath,
      cell: request.cell,
      cols: anchorRow.frameCount,
      index: resolved.index,
      destPath: anchorPath,
    });
    if (!baked.sourceHasAlpha) {
      result.warnings.push(
        `앵커 '${item.direction}': 원본에 알파가 없어 콘텐츠 크롭이 셀 전체가 됐다 ` +
          `(크로마 배경이 남아 있다 — 추출 단계 이후에야 유효하다)`,
      );
    }
    result.anchors[item.direction] = {
      path: anchorPath,
      state: resolved.state,
      index: resolved.index,
      source: resolved.source,
    };

    const guide = join(deps.workDir, `guide-${item.state}.png`);
    await renderLayoutGuide(guide, entry.frames, request.cell);
    // 정본 ref 순서: 타깃 방향 앵커 → (모션 참조) → 레이아웃 가이드
    const inputPaths = [anchorPath, guide];
    assertNoBase(item, inputPaths, deps.lockedBasePath);
    deps.log(`stage2 ${item.state}: anchor=${resolved.state}#${resolved.index} (${resolved.source})`);
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry),
      inputPaths,
      role: item.role,
    });
    result.rows[item.state] = {
      generationId: gen.generationId,
      imagePath: gen.imagePath,
      frameCount: entry.frames,
    };
  }

  return result;
}

/** 시트 PNG 에서 실제 프레임 수를 추정한다 (셀 폭 기준). Task 3 에서 쓴다. */
export async function inferFrameCount(sheetPath: string, cellWidth: number): Promise<number> {
  const meta = await sharp(sheetPath).metadata();
  return Math.max(1, Math.round((meta.width ?? cellWidth) / cellWidth));
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
pnpm exec tsx scripts/test-run-plan.ts
```

Expected: `22 passed / 0 failed`

- [ ] **Step 5: 체이닝하고 커밋**

```bash
git add src/lib/sprite/run-plan.ts scripts/test-run-plan.ts package.json
git commit -m "feat(sprite): 플랜 실행기 — 앵커 먼저·행은 앵커만·base 첨부를 런타임 차단"
```

---

## Task 3: 실제 프레임 수로 앵커를 해석한다

**Files:**
- Modify: `src/lib/sprite/run-plan.ts`
- Modify: `scripts/test-run-plan.ts`

### 왜 별도 Task 인가

Task 2 는 `frameCount` 를 **요청값**(`entry.frames`)으로 쓴다. 그런데 정본 계약의 핵심은
*"모델이 요청한 프레임 수를 안 지킬 수 있다"* 이고, sprite-gen 은 프레임 수 미달 시 행을
**차단**한다(스펙 §2). 요청값을 믿고 앵커 인덱스를 해석하면 실제보다 많은 프레임을 가정해
엉뚱한 셀을 크롭한다.

⑤의 내용 기반 추출이 붙기 전까지는 **셀 폭 기준 추정**이 우리가 가진 최선이다.

- [ ] **Step 1: 실패하는 테스트를 추가한다**

```ts
console.log("=== 실제 프레임 수를 쓴다 ===");
{
  // 4프레임을 요청했는데 모델이 3칸짜리를 냈다 — 요청값이 아니라 실측을 써야 한다.
  const short = join(dir, "short.png");
  await fakeSheet(short, 3, request.cell.width);
  const r = await runSpritePlan(request, {
    generate: async () => ({ generationId: "g", imagePath: short, width: 3 * request.cell.width, height: request.cell.width }),
    workDir: dir, lockedBasePath: basePath, log: () => {},
  });
  check("실측 프레임 수가 기록된다", r.rows.down_idle.frameCount === 3, `${r.rows.down_idle.frameCount}`);
  check("프레임 수 미달이 경고로 남는다",
    r.warnings.some(w => w.includes("frames")), r.warnings.join(" | "));
}
```

- [ ] **Step 2: 실패를 확인하고 구현한다**

`runSpritePlan` 의 두 곳(`stage1`·`stage2` 의 `result.rows[...] = ...`)에서 `frameCount` 를
`await inferFrameCount(gen.imagePath, request.cell.width)` 로 바꾸고, 요청값과 다르면 경고를
남긴다:

```ts
    const actual = await inferFrameCount(gen.imagePath, request.cell.width);
    if (actual !== entry.frames) {
      result.warnings.push(
        `'${item.state}': ${entry.frames} frames 요청했는데 ${actual} 칸이 나왔다 — ` +
          `앵커 인덱스와 추출은 실측값을 따른다`,
      );
    }
    result.rows[item.state] = {
      generationId: gen.generationId,
      imagePath: gen.imagePath,
      frameCount: actual,
    };
```

> **차단하지 않는 이유**: 정본은 프레임 수 미달 시 행을 차단하지만, 그 판정은 내용 기반
> 추출(⑤)이 있어야 정확하다. 셀 폭 추정만으로 차단하면 정상 행을 막을 수 있다. ④a 는
> 경고로 드러내고, 차단은 ⑤에서 넣는다. **이 유예를 스펙에 기록한다.**

- [ ] **Step 3: 테스트 통과 확인 후 커밋**

```bash
pnpm exec tsx scripts/test-run-plan.ts
git add src/lib/sprite/run-plan.ts scripts/test-run-plan.ts
git commit -m "fix(sprite): 앵커 해석에 요청값이 아니라 실측 프레임 수를 쓴다"
```

---

## Task 4: CLI 드라이버 — 실제 codex 왕복

**Files:**
- Create: `scripts/gen-sprite-run.ts`
- Modify: `package.json` (`gen:sprite-run` 스크립트)

**Interfaces:**
- Consumes: `buildSpriteRequest` (Task 1), `runSpritePlan` (Task 2·3),
  `runImageTool` (`src/lib/mcp/handlers/shared.ts`), `lockBaseGeneration`·`getLockedBase` (①)

### `runImageTool` 를 생성 함수로 감싼다

`runImageTool` 은 `structuredContent.{generationId,imagePath,width,height}` 를 돌려주고
`overrideInputPaths` 로 첨부 순서를 완전히 제어할 수 있다 — 플랜의 ref 순서를 그대로
넘기기에 맞다. `imagePath` 는 `/api/images/<id>` 형태이므로 **파일 경로로 바꿔야 한다**
(`loadGenerationWithPath` 참조).

- [ ] **Step 1: 드라이버를 쓴다**

`scripts/gen-sprite-run.ts`:

```ts
/**
 * ④a — 플랜 구동 생성 CLI. 실제 codex 를 부른다.
 *
 *   pnpm gen:sprite-run --base=<generationId> --dir=DOWN --frames=4 --action="walk cycle"
 *
 * base 가 잠겨 있지 않으면 --base 로 준 generation 을 잠근다(①). 결과 파일과 경고를
 * 그대로 찍는다 — 조용한 성공/실패가 없어야 한다.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildSpriteRequest } from "../src/lib/sprite/build-request";
import { runSpritePlan, type GenerateFn } from "../src/lib/sprite/run-plan";
import {
  getLockedBase,
  lockBaseGeneration,
} from "../src/lib/db/repo/generations";
import { loadGenerationWithPath, runImageTool } from "../src/lib/mcp/handlers/shared";

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name}= 이 필요합니다`);
}

void (async () => {
  const baseId = arg("base");
  const uiDirection = arg("dir", "DOWN");
  const frames = Number(arg("frames", "4"));
  const actionPrompt = arg("action");
  const characterId = arg("character", "run");
  const description = arg("description", "");

  // ① base 잠금 — 잠겨 있지 않으면 잠근다.
  if (getLockedBase(null)?.id !== baseId) {
    lockBaseGeneration(baseId, null);
    console.log(`base 잠금: ${baseId}`);
  }
  const { filePath: basePath } = loadGenerationWithPath(baseId);

  const workDir = join(process.cwd(), "data", "sprite-runs", `${characterId}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  console.log(`작업 디렉터리: ${workDir}`);

  const { request, warnings } = await buildSpriteRequest({
    characterId, description, baseImagePath: basePath,
    uiDirection, frames, loop: true, actionPrompt,
  });
  for (const w of warnings) console.log(`  경고: ${w}`);
  console.log(`크로마 키: ${request.chromaKey.name} ${request.chromaKey.hex} (${request.chromaKey.selection})`);
  console.log(`상태: ${Object.keys(request.states).join(", ")}`);

  const generate: GenerateFn = async spec => {
    const t0 = Date.now();
    console.log(`\n생성 ${spec.state} (${spec.role}) refs=${spec.inputPaths.length}`);
    const res = await runImageTool({
      name: "sprite_row",
      kind: "spritesheet",
      prompt: spec.prompt,
      inputGenerationIds: [],
      overrideInputPaths: spec.inputPaths,
      params: { state: spec.state, role: spec.role, planDriven: true },
      sessionId: null,
    });
    const s = res.structuredContent;
    const { filePath } = loadGenerationWithPath(s.generationId);
    console.log(`  → ${s.generationId} ${s.width}x${s.height} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { generationId: s.generationId, imagePath: filePath, width: s.width, height: s.height };
  };

  const result = await runSpritePlan(request, {
    generate, workDir, lockedBasePath: basePath, log: m => console.log(`  ${m}`),
  });

  console.log("\n=== 결과 ===");
  for (const [state, row] of Object.entries(result.rows)) {
    console.log(`  ${state}: ${row.generationId} frames=${row.frameCount}`);
  }
  for (const [dir, a] of Object.entries(result.anchors)) {
    console.log(`  앵커 ${dir}: ${a.state}#${a.index} (${a.source}) → ${a.path}`);
  }
  for (const m of result.skippedMirrors) console.log(`  미러 생략: ${m.direction} ← ${m.mirrorOf}`);
  for (const w of result.warnings) console.log(`  경고: ${w}`);
})();
```

`package.json` 에 추가:

```
"gen:sprite-run": "tsx scripts/gen-sprite-run.ts",
```

- [ ] **Step 2: base 를 하나 만든다 (없으면)**

```bash
pnpm exec tsx scripts/gen.ts --kind=text2img --prompt="a small fox mage in a crimson cloak, standing idle facing the viewer, full body, flat pure magenta #FF00FF background, game sprite"
```

출력의 generation id 를 받아 ①의 게이트로 검사한다:

```bash
pnpm exec tsx -e "import('./src/lib/sprite/base-gate').then(async m => console.log(await m.inspectBaseImage(process.argv[1])))" data/images/<id>.png
```

`autoPass: false` 면 **다시 생성한다** — 약한 base 는 모든 행을 오염시킨다(①의 차단 게이트).

- [ ] **Step 3: 실제 왕복 1회**

```bash
pnpm gen:sprite-run --base=<generationId> --dir=DOWN --frames=4 --action="subtle walk cycle, alternating foot contacts" --character=aurora --description="small fox mage in a crimson cloak"
```

Expected: 두 번 생성(`down_idle` → `down_action`), 총 ~80초. 출력에서 확인할 것:

1. **stage 순서** — `down_idle` 이 먼저, `down_action` 이 나중
2. **앵커 해석** — `앵커 down: down_idle#0 (default)`
3. **경고** — `sourceHasAlpha=false` 경고가 뜨는지(뜰 것이다: raw 는 크로마 배경이다)
4. **프레임 수** — 실측이 4인지, 아니면 경고가 뜨는지

- [ ] **Step 4: 산출물을 눈으로 본다**

`down_idle`·`down_action` 두 시트와 `anchor-down-x8.png` 를 확인한다.

**여기서 판단할 것**:
- 앵커 이미지가 실제로 단일 포즈인가 (셀 크롭이 맞았는가)
- 액션 행의 정체성이 앵커와 일치하는가
- 프레임이 슬롯마다 하나씩 들어갔는가, 가이드 박스가 그려지지 않았는가

- [ ] **Step 5: 커밋**

```bash
git add scripts/gen-sprite-run.ts package.json
git commit -m "feat(sprite): 플랜 구동 생성 CLI — 실제 codex 왕복"
```

---

## Task 5: 구/신 경로 비교 — 이 이식의 근거

**Files:**
- Create: `docs/superpowers/notes/2026-08-16-pipeline-comparison.md`

이 Task 가 ④a 의 목적이다. 앞의 넷은 여기에 도달하기 위한 것이다.

- [ ] **Step 1: 같은 조건으로 구 경로를 돌린다**

현재 경로(`handleMakeSpritesheet`)를 같은 캐릭터·동작·프레임 수로 돌린다. 앱 UI 로 돌리거나
`scripts/qa-mcp-spritesheet.mjs` 를 쓴다(그 스크립트의 인자를 먼저 읽을 것).

- [ ] **Step 2: 네 축으로 나란히 비교한다**

사용자가 처음 제시한 실패 네 가지가 그대로 축이다(스펙 §1):

| 축 | 무엇을 보는가 |
|---|---|
| 배경 제거 품질 | 크로마 잔여, 가장자리 헤일로, 소재색 손실 |
| 프레임 분할·정렬 | 슬롯마다 포즈 1개, 이웃 침범, 잘림, 중심 정렬 |
| 프레임 간 일관성 | 정체성 드리프트(얼굴·색·비율·소품), 좌우 특징 뒤집힘 |
| 애니메이션 질 | 포즈 변화가 읽히는가, 루프 이음매, 제자리 흔들림 |

`scripts/measure-gait-diff.mjs`(인접 프레임 하단 1/3 실루엣 diff)로 "제자리 흔들림"은
정량 측정한다.

- [ ] **Step 3: 결과를 문서에 적는다 — 나쁜 결과도 그대로**

`docs/superpowers/notes/2026-08-16-pipeline-comparison.md` 에 축별 판정과 근거 이미지 경로를
남긴다. **신 경로가 진 축이 있으면 그렇게 적는다.** 정본이 반복하는 원칙이다:

> Report the state as failed or experimental rather than silently falling back.

walk/run 은 정본이 **experimental** 로 분류하며, 정본 자신도 *"the most reliable path is
candidate generation plus human frame picking"* 이라고 적는다. 신 경로에서도 로코모션이
자동으로 좋아지지 않을 가능성이 높다 — 그 경우 **"실패"가 아니라 "정본과 같은 한계"** 로
기록하고, ④b(사람이 프레임을 고르는 경로의 영속)가 그 답이라는 점을 적는다.

- [ ] **Step 4: 다음 단계 우선순위를 결정한다**

비교 결과가 ④b 와 ④c 의 순서를 정한다:

- 정체성·배경·분할이 좋아졌고 로코모션만 약하다 → **④c(모션 참조·좌우 쌍) 우선**
- 전반적으로 좋아졌다 → **④b(UI 배선) 우선** — 사용자가 쓸 수 있게 하는 것이 급하다
- 나빠진 축이 있다 → 그 원인을 먼저 찾는다. 배선하지 않는다

- [ ] **Step 5: 커밋**

```bash
git add docs/superpowers/notes/2026-08-16-pipeline-comparison.md
git commit -m "docs(qa): 구/신 파이프라인 4축 비교 결과"
```

---

## Task 6: 스펙 갱신과 게이트

- [ ] **Step 1: 스펙 §8 의 ④ 절을 갱신한다**

- ④를 ④a/④b/④c 로 쪼갠 것과 그 이유
- CLI 우선 순서로 바꾼 것과 그 이유(생성 품질은 대조로 알 수 없다)
- Task 3 의 유예: 프레임 수 미달을 ④a 는 경고로만 두고 차단은 ⑤에서
- Task 5 의 비교 결과 요약과 그것이 정한 다음 우선순위

- [ ] **Step 2: §11 에 읽은 문서를 추가한다**

`locomotion-curation.md`(④) — motion-phase 실험, 수동 selected-cycle, 클린 GIF 불변식.

- [ ] **Step 3: 전체 게이트**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

Expected: 신규 2개 포함 전부 통과, 타입 오류 0, 린트 오류 0(기존 경고 5건 유지).

- [ ] **Step 4: 커밋과 브랜치 마무리**

**REQUIRED SUB-SKILL:** superpowers:finishing-a-development-branch

---

## 이 계획이 다루지 않는 것

| 항목 | 어디로 | 이유 |
|---|---|---|
| `spritesheet-handler` 배선 | ④b | 비교 결과가 우선순위를 정한다 |
| `SpriteCanvas` 큐레이션 영속 (`saveCuration`) | ④b | 정본의 "human frame picking" 경로 |
| 앵커 핀 UI (`pinAnchorFrame`) | ④b | |
| 패널 기본값 8→4 (§6.1.1) | ④b | 실측 근거가 ④a 에서 나온다 |
| 상태 앵커 게이트 (정본 체크리스트 3) | ④c | 비로코모션 상태용. 생성 1회 추가 |
| 좌우 쌍 생성 순서 (basis → paired) | ④c | 두 방향 이상 요청이 있어야 의미 |
| 모션 contact sheet / motion-phase 가이드 | ④c | 로코모션이 약할 때의 답 |
| 프레임 수 미달 **차단** | ⑤ | 내용 기반 추출이 있어야 정확하다 |
| 3패스 크로마 알파 정리 | ⑤ | |
| selected-cycle 산출물 (`qa/<name>.json`) | ⑥ | |
| rollout jsonl 정리 (1회 1~1.5MB 누적) | 별건 | ⓪의 부작용. 기록만 |

## 자체 점검 결과

- **스펙 커버리지**: §8 ④ 절의 "각 행 = 자기 방향 앵커 + 레이아웃 가이드, base 금지" →
  Task 2 의 `assertNoBase`. "체인 참조 계획이 기본" → Task 2 의 플랜 구동.
  "로코모션 좌우 순서" → ④c 로 명시 이관.
- **플레이스홀더**: Task 5 Step 1 이 `qa-mcp-spritesheet.mjs` 의 인자를 "먼저 읽을 것"으로
  남겼다 — 그 스크립트가 실재하고 구 경로를 돌리는 유일한 CLI 이므로 구현자가 읽고 쓴다.
- **타입 일관성**: `PanelInput`(Task 1) → `SpriteRequest`(②③) → `RunPlanDeps`(Task 2) →
  `GenerateFn` 반환(`{generationId, imagePath, width, height}`)이 `runImageTool` 의
  `structuredContent` 와 필드명이 같다. 단 `imagePath` 는 **URL 이 아니라 파일 경로**여야
  하므로 Task 4 가 `loadGenerationWithPath` 로 변환한다 — 이 변환을 빠뜨리면 sharp 가
  파일을 못 찾는다.
- **미해결 1건**: `runImageTool` 의 `kind: "spritesheet"` 가 `buildNaturalPrompt` 에서
  어떤 프롬프트 헤더를 붙이는지 확인하지 않았다. ⓪이 헤더를 바꿨으므로 방향 프롬프트와
  충돌하지 않는지 Task 4 Step 3 의 실왕복에서 봐야 한다.
