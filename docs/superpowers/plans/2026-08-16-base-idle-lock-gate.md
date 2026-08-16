# ①단계 — base idle 잠금 게이트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** base idle 후보 이미지를 결정론적 기준으로 검사해 통과한 1장을 base로 확정하고, 이후 단계가 그것을 identity 원천으로 조회할 수 있게 한다.

**Architecture:** 검사는 sharp raw 버퍼 위의 순수 함수다 — 합성 이미지로 codex 없이 테스트한다. 확정은 `generations.params` 에 역할 표식을 남기는 방식으로, 새 DB kind 를 만들지 않는다. UI 는 스펙 §3.3 방침에 따라 이 단계에서 만들지 않는다.

**Tech Stack:** TypeScript, sharp(raw 픽셀 접근), better-sqlite3. 테스트는 tsx 스크립트 + 자체 assert.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md` §5
- 이식 원본: sprite-gen `sprite_gen/prepare.py` `detect_reference_background`
  (Apache-2.0, Copyright 2026 Alex Kim). 파일 헤더에 고지한다.
- **정본 상수를 그대로 쓴다**: `BACKGROUND_TOLERANCE = 48.0`,
  `BACKGROUND_MIN_OPAQUE_BORDER = 0.25`, `BACKGROUND_BORDER_COVERAGE = 0.75`.
  색거리는 유클리드 RGB(`extract.py:30`).
- sharp raw 접근은 기존 패턴을 따른다:
  `sharp(p).toColorspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })`
  (`chroma-key.ts:300` 선례).
- **UI 를 만들지 않는다.** 스펙 §3.3 — 파이프라인 구현 후 드러나는 요구를 별도로 다룬다.
- 커밋 메시지는 한국어 + conventional commits, 본문에 "왜"를 적는다.

### 이 단계에서 자동화하지 않는 것 (정본의 잠금 기준 6가지 중)

정본 기준 전부를 코드로 판정할 수는 없다. 무엇이 사람 몫인지 명시한다.

| # | 기준 | 이 계획 |
|---|------|---------|
| 1 | 전신, 잘린 곳 없음 | **자동** — 피사체 bbox 가 캔버스 가장자리에 닿는지 |
| 2 | 최종 비율·스타일이 이미 맞을 것 | **사람** — 자동화하지 않는다 |
| 3 | 픽셀아트 런이면 베이스가 진짜 픽셀아트 | **부분 자동** — AA 반투명 가장자리 비율만. 균일 블록 피치 실측은 ⑤(추출)에서 피치 검출을 포팅한 뒤 붙인다 |
| 4 | 캐릭터시트와 정체성 일치 | **사람** |
| 5 | 단일 명확한 대기 포즈·카메라 방향·작은 크기 실루엣 | **사람** — "읽히는 실루엣"의 결정론적 정의가 없다 |
| 6 | 평면 크로마 배경 (또는 쉽게 키잉 가능) | **자동** — 테두리 링 분석으로 flat/transparent/heterogeneous 판정 |

게이트는 자동 항목을 판정해 보여주고, 최종 y/n 은 사람이 누른다. **자동 검사가 전부 통과해도
잠금이 자동으로 되지는 않는다.**

## File Structure

| 파일 | 책임 |
|------|------|
| `src/lib/sprite/base-gate.ts` (신규) | 잠금 기준 자동 검사 — 배경 모드, AA 비율, 피사체 bbox, 통합 판정 |
| `scripts/test-base-gate.ts` (신규) | 합성 이미지로 위 함수 단위 테스트 |
| `src/lib/db/repo/generations.ts` (수정) | base 역할 표식 읽기·쓰기 |
| `package.json` (수정) | `test` 스크립트에 등록 |

`src/lib/sprite/` 는 스펙 §6.4 가 정한 ② 의 모듈 위치다. ① 의 게이트도 같은 디렉터리에 둔다 —
둘 다 "스프라이트 파이프라인의 순수 로직"이고 DB·MCP·codex 를 모른다.

---

### Task 1: 배경 모드 판정

**Files:**
- Create: `src/lib/sprite/base-gate.ts`
- Test: `scripts/test-base-gate.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `type BackgroundInfo = { mode: "flat"; hex: string; rgb: [number, number, number]; opaqueBorderFraction: number; borderCoverage: number } | { mode: "transparent"; opaqueBorderFraction: number } | { mode: "heterogeneous"; opaqueBorderFraction: number; borderCoverage: number }`
  - `detectBackgroundMode(raw: Buffer, width: number, height: number, channels: number): BackgroundInfo`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-base-gate.ts` 생성:

```ts
/**
 * base 잠금 게이트 단위 테스트 — codex 미사용, 합성 이미지로 판정한다.
 *
 *   pnpm tsx scripts/test-base-gate.ts
 */
import sharp from "sharp";
import { detectBackgroundMode } from "../src/lib/sprite/base-gate";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** RGBA 원시 버퍼를 만든다. paint(x,y) 가 [r,g,b,a] 를 돌려준다. */
function makeRaw(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): { raw: Buffer; width: number; height: number; channels: number } {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  return { raw, width, height, channels: 4 };
}

const SIZE = 32;

// ── flat: 순수 마젠타 배경 + 중앙 피사체 ──────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) =>
    x > 10 && x < 21 && y > 10 && y < 21 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("평면 마젠타 배경 → flat", bg.mode === "flat", bg.mode);
  if (bg.mode === "flat") {
    check("배경색 복원", bg.hex.toLowerCase() === "#ff00ff", bg.hex);
    check("테두리 커버리지 1.0", bg.borderCoverage === 1, String(bg.borderCoverage));
  }
}

// ── flat: 코덱 지터가 낀 배경 (±8 흔들림) ─────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) => {
    if (x > 10 && x < 21 && y > 10 && y < 21) return [20, 40, 200, 255];
    const jitter = ((x + y) % 3) - 1; // -1..1
    return [255, Math.max(0, 4 + jitter), 255, 255];
  });
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("지터가 있어도 flat 으로 판정", bg.mode === "flat", bg.mode);
}

// ── transparent: 테두리가 거의 투명 ───────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) =>
    x > 10 && x < 21 && y > 10 && y < 21 ? [20, 40, 200, 255] : [0, 0, 0, 0],
  );
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("투명 테두리 → transparent", bg.mode === "transparent", bg.mode);
}

// ── heterogeneous: 테두리가 그라디언트 ────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) => [
    Math.round((x / (SIZE - 1)) * 255),
    Math.round((y / (SIZE - 1)) * 255),
    128,
    255,
  ]);
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("그라디언트 테두리 → heterogeneous", bg.mode === "heterogeneous", bg.mode);
}

// ── 경계: 1×1 이미지도 죽지 않는다 ────────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(1, 1, () => [255, 0, 255, 255]);
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("1×1 이미지 처리", bg.mode === "flat", bg.mode);
}

// sharp 가 실제로 같은 레이아웃을 주는지 한 번 확인 (raw 규약 고정)
void (async () => {
  const png = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const { data, info } = await sharp(png)
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bg = detectBackgroundMode(data, info.width, info.height, info.channels);
  check("sharp raw 버퍼와 호환", bg.mode === "flat", `${bg.mode} ch=${info.channels}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: FAIL — `Cannot find module '../src/lib/sprite/base-gate'`

- [ ] **Step 3: 구현을 쓴다**

`src/lib/sprite/base-gate.ts` 생성:

```ts
/**
 * base idle 잠금 게이트 — 결정론적 검사.
 *
 * 정본(SKILL.md "Base Lock Gate")의 잠금 기준 6가지 중 코드로 판정 가능한 것만
 * 다룬다. 최종 y/n 은 사람이 누른다. 자동 검사가 전부 통과해도 잠금이 자동으로
 * 되지는 않는다 — 비율·스타일 적합성과 캐릭터 정체성은 사람 몫이다.
 *
 * 배경 판정은 sprite-gen `sprite_gen/prepare.py` `detect_reference_background`
 * (Apache-2.0, Copyright 2026 Alex Kim) 의 이식이다. 상수와 판정 순서를 그대로
 * 따른다 — 값을 바꾸면 원본과 다른 결과가 나온다.
 */

/** 배경으로 인정할 테두리 색 거리(유클리드 RGB). */
const BACKGROUND_TOLERANCE = 48.0;
/** 테두리 링에서 불투명 픽셀이 이 비율 미만이면 투명 배경으로 본다. */
const BACKGROUND_MIN_OPAQUE_BORDER = 0.25;
/** 최다 색이 테두리를 이만큼 덮어야 평면으로 인정한다. */
const BACKGROUND_BORDER_COVERAGE = 0.75;
/** 알파가 이 값 이하이면 투명 취급. */
const ALPHA_TRANSPARENT_MAX = 16;

export type BackgroundInfo =
  | {
      mode: "flat";
      hex: string;
      rgb: [number, number, number];
      opaqueBorderFraction: number;
      borderCoverage: number;
    }
  | { mode: "transparent"; opaqueBorderFraction: number }
  | { mode: "heterogeneous"; opaqueBorderFraction: number; borderCoverage: number };

function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

/** 테두리 링 좌표. 2px 미만 변은 전체 픽셀을 링으로 본다. */
function borderCoordinates(width: number, height: number): Array<[number, number]> {
  if (width < 2 || height < 2) {
    const all: Array<[number, number]> = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) all.push([x, y]);
    return all;
  }
  const ring: Array<[number, number]> = [];
  for (let x = 0; x < width; x++) ring.push([x, 0], [x, height - 1]);
  for (let y = 1; y < height - 1; y++) ring.push([0, y], [width - 1, y]);
  return ring;
}

/**
 * 테두리 링으로 base 의 배경을 분류한다. 관측 가능한 세 모드를 돌려준다.
 * flat 만 배경색을 싣는다.
 */
export function detectBackgroundMode(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): BackgroundInfo {
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * width + x) * channels;
    return [raw[i], raw[i + 1], raw[i + 2], channels >= 4 ? raw[i + 3] : 255];
  };

  const ring = borderCoordinates(width, height);
  const opaque = ring.filter(([x, y]) => at(x, y)[3] > ALPHA_TRANSPARENT_MAX);
  const opaqueBorderFraction = ring.length > 0 ? opaque.length / ring.length : 0;

  if (opaqueBorderFraction < BACKGROUND_MIN_OPAQUE_BORDER) {
    return {
      mode: "transparent",
      opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
    };
  }

  // 16단계 버킷으로 양자화해 PNG/코덱 지터를 견딘 뒤, 최다 버킷의 평균으로 실제 색을 복원.
  const buckets = new Map<string, Array<[number, number, number]>>();
  for (const [x, y] of opaque) {
    const [r, g, b] = at(x, y);
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const list = buckets.get(key);
    if (list) list.push([r, g, b]);
    else buckets.set(key, [[r, g, b]]);
  }
  let members: Array<[number, number, number]> = [];
  for (const list of buckets.values()) if (list.length > members.length) members = list;

  const background: [number, number, number] = [
    Math.round(members.reduce((s, m) => s + m[0], 0) / members.length),
    Math.round(members.reduce((s, m) => s + m[1], 0) / members.length),
    Math.round(members.reduce((s, m) => s + m[2], 0) / members.length),
  ];

  const within = opaque.filter(([x, y]) => {
    const [r, g, b] = at(x, y);
    return colorDistance([r, g, b], background) <= BACKGROUND_TOLERANCE;
  }).length;
  const borderCoverage = within / opaque.length;

  if (borderCoverage < BACKGROUND_BORDER_COVERAGE) {
    return {
      mode: "heterogeneous",
      opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
      borderCoverage: Math.round(borderCoverage * 1000) / 1000,
    };
  }

  return {
    mode: "flat",
    hex: rgbToHex(background),
    rgb: background,
    opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
    borderCoverage: Math.round(borderCoverage * 1000) / 1000,
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: `6 passed, 0 failed`

- [ ] **Step 5: package.json 에 등록한다**

`scripts.test` 끝에 ` && tsx scripts/test-base-gate.ts` 를 덧붙인다:

```json
"test": "tsx scripts/test-classify.ts && tsx scripts/test-directions.ts && tsx scripts/test-sprite-marker.ts && tsx scripts/test-codex-rollout.ts && tsx scripts/test-base-gate.ts",
```

- [ ] **Step 6: 전체 테스트를 돌린다**

Run:
```bash
pnpm test
```
Expected: 다섯 스크립트 모두 통과

- [ ] **Step 7: 커밋**

```bash
git add src/lib/sprite/base-gate.ts scripts/test-base-gate.ts package.json
git commit -m "feat(sprite): base 배경 모드 판정 — flat/transparent/heterogeneous

정본 SKILL.md 의 잠금 기준 6번(평면 크로마 배경)을 코드로 판정한다.
sprite-gen prepare.py detect_reference_background 의 이식이며 상수
(TOLERANCE 48.0 / MIN_OPAQUE_BORDER 0.25 / BORDER_COVERAGE 0.75)와 판정
순서를 그대로 따른다.

테두리 색을 16단계 버킷으로 양자화한 뒤 최다 버킷의 평균으로 배경색을
복원한다. PNG/코덱 지터가 껴도 평면 배경이 평면으로 판정되게 하려는 것이다."
```

---

### Task 2: AA 비율과 피사체 bbox

**Files:**
- Modify: `src/lib/sprite/base-gate.ts`
- Modify: `scripts/test-base-gate.ts`

**Interfaces:**
- Consumes: Task 1 의 `BackgroundInfo`, `detectBackgroundMode`
- Produces:
  - `softAlphaFraction(raw: Buffer, width: number, height: number, channels: number): number`
  - `subjectBBox(raw, width, height, channels, background: BackgroundInfo): { x0: number; y0: number; x1: number; y1: number } | null`
  - `touchesEdge(bbox, width, height): boolean`

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-base-gate.ts` 의 `void (async () => {` 블록 **앞**에 삽입하고, 상단 import 에
`softAlphaFraction`, `subjectBBox`, `touchesEdge` 를 추가한다:

```ts
// ── softAlphaFraction ─────────────────────────────────────────────
{
  // 전부 불투명 → 0
  const opaque = makeRaw(16, 16, () => [10, 20, 30, 255]);
  check(
    "반투명 없음 → 0",
    softAlphaFraction(opaque.raw, opaque.width, opaque.height, opaque.channels) === 0,
  );

  // 절반이 알파 128 → 0.5
  const half = makeRaw(16, 16, (x) => [10, 20, 30, x < 8 ? 128 : 255]);
  check(
    "절반 반투명 → 0.5",
    Math.abs(softAlphaFraction(half.raw, half.width, half.height, half.channels) - 0.5) < 1e-9,
  );

  // 완전 투명은 반투명이 아니다
  const cut = makeRaw(16, 16, (x) => [10, 20, 30, x < 8 ? 0 : 255]);
  check(
    "완전 투명은 세지 않는다",
    softAlphaFraction(cut.raw, cut.width, cut.height, cut.channels) === 0,
  );
}

// ── subjectBBox / touchesEdge ─────────────────────────────────────
{
  // flat 마젠타 배경 + 중앙 사각형 (10..20)
  const img = makeRaw(32, 32, (x, y) =>
    x >= 10 && x <= 20 && y >= 10 && y <= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
  const box = subjectBBox(img.raw, img.width, img.height, img.channels, bg);
  check("피사체 bbox 검출", box !== null);
  if (box) {
    check(
      "bbox 좌표 정확",
      box.x0 === 10 && box.y0 === 10 && box.x1 === 20 && box.y1 === 20,
      JSON.stringify(box),
    );
    check("가장자리에 닿지 않음", !touchesEdge(box, img.width, img.height));
  }

  // 가장자리까지 꽉 찬 피사체
  const full = makeRaw(32, 32, (x, y) =>
    x >= 0 && x <= 20 && y >= 10 && y <= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const fullBg = detectBackgroundMode(full.raw, full.width, full.height, full.channels);
  const fullBox = subjectBBox(full.raw, full.width, full.height, full.channels, fullBg);
  check("잘린 피사체는 가장자리에 닿음", fullBox !== null && touchesEdge(fullBox, 32, 32));

  // 투명 배경에서도 동작
  const trans = makeRaw(32, 32, (x, y) =>
    x >= 12 && x <= 18 && y >= 12 && y <= 18 ? [20, 40, 200, 255] : [0, 0, 0, 0],
  );
  const transBg = detectBackgroundMode(trans.raw, trans.width, trans.height, trans.channels);
  const transBox = subjectBBox(trans.raw, trans.width, trans.height, trans.channels, transBg);
  check(
    "투명 배경에서 bbox 검출",
    transBox !== null && transBox.x0 === 12 && transBox.x1 === 18,
    JSON.stringify(transBox),
  );

  // 피사체가 없으면 null
  const empty = makeRaw(16, 16, () => [255, 0, 255, 255]);
  const emptyBg = detectBackgroundMode(empty.raw, empty.width, empty.height, empty.channels);
  check(
    "피사체 없으면 null",
    subjectBBox(empty.raw, empty.width, empty.height, empty.channels, emptyBg) === null,
  );
}
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: FAIL — `softAlphaFraction is not a function`

- [ ] **Step 3: 구현을 추가한다**

`src/lib/sprite/base-gate.ts` 끝에 추가:

```ts
/**
 * 반투명(안티앨리어싱) 픽셀 비율. 완전 투명(alpha=0)은 세지 않는다 —
 * 그건 잘라낸 배경이지 AA 가장자리가 아니다.
 *
 * 정본의 잠금 기준 3번은 "균일 블록 피치가 실측되고 AA 반투명 가장자리가
 * 없을 것"이다. 피치 실측은 ⑤(추출)에서 검출기를 포팅한 뒤 붙인다. 여기서는
 * AA 쪽만 본다 — 진짜 픽셀아트는 이 값이 0 에 가깝다.
 */
export function softAlphaFraction(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  if (channels < 4) return 0;
  const total = width * height;
  if (total === 0) return 0;
  let soft = 0;
  for (let i = 0; i < total; i++) {
    const a = raw[i * channels + 3];
    if (a > 0 && a < 255) soft++;
  }
  return soft / total;
}

export type BBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * 배경이 아닌 픽셀의 경계 상자. 배경 판정은 detectBackgroundMode 결과를 따른다:
 * flat 이면 그 색과의 거리로, 그 외에는 알파로만 가른다.
 * (heterogeneous 는 배경색을 특정할 수 없으므로 알파 기준으로 떨어진다 —
 *  불투명 그라디언트 배경에서는 bbox 가 캔버스 전체가 되고, 그건 잠금 기준 1번을
 *  실패시키는 관측 가능한 결과다.)
 */
export function subjectBBox(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  background: BackgroundInfo,
): BBox | null {
  const key = background.mode === "flat" ? background.rgb : null;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const a = channels >= 4 ? raw[i + 3] : 255;
      if (a <= ALPHA_TRANSPARENT_MAX) continue;
      if (key && colorDistance([raw[i], raw[i + 1], raw[i + 2]], key) <= BACKGROUND_TOLERANCE) {
        continue;
      }
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** bbox 가 캔버스 가장자리에 닿으면 잘렸을 가능성이 있다(잠금 기준 1번). */
export function touchesEdge(bbox: BBox, width: number, height: number): boolean {
  return bbox.x0 === 0 || bbox.y0 === 0 || bbox.x1 === width - 1 || bbox.y1 === height - 1;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: `14 passed, 0 failed`

- [ ] **Step 5: 커밋**

```bash
git add src/lib/sprite/base-gate.ts scripts/test-base-gate.ts
git commit -m "feat(sprite): AA 반투명 비율과 피사체 bbox 검사

잠금 기준 1번(전신·비잘림)은 피사체 bbox 가 캔버스 가장자리에 닿는지로,
3번(픽셀아트 여부)은 AA 반투명 픽셀 비율로 근사한다.

완전 투명(alpha=0)은 반투명으로 세지 않는다 — 잘라낸 배경이지 AA 가장자리가
아니다. 균일 블록 피치 실측은 ⑤ 에서 검출기를 포팅한 뒤 붙인다."
```

---

### Task 3: 통합 게이트 판정

**Files:**
- Modify: `src/lib/sprite/base-gate.ts`
- Modify: `scripts/test-base-gate.ts`

**Interfaces:**
- Consumes: Task 1·2 전부
- Produces:
  - `type BaseCheck = { id: "background" | "fullBody" | "pixelArt"; ok: boolean; detail: string }`
  - `type BaseInspection = { checks: BaseCheck[]; autoPass: boolean; background: BackgroundInfo; softAlpha: number; bbox: BBox | null; width: number; height: number }`
  - `inspectBaseImage(filePath: string, opts?: { pixelArt?: boolean }): Promise<BaseInspection>`

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-base-gate.ts` 의 async IIFE **안**, `console.log` 집계 바로 앞에 삽입하고
상단 import 에 `inspectBaseImage` 를 추가한다:

```ts
  // ── inspectBaseImage (파일 경로 기반) ───────────────────────────
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "base-gate-test-"));

  // 통과 케이스: 평면 마젠타 배경 + 잘리지 않은 중앙 피사체, AA 없음
  const goodPath = join(tmp, "good.png");
  await sharp(
    makeRaw(64, 64, (x, y) =>
      x >= 20 && x <= 43 && y >= 20 && y <= 43 ? [20, 40, 200, 255] : [255, 0, 255, 255],
    ).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png()
    .toFile(goodPath);

  const good = await inspectBaseImage(goodPath);
  check("통과 케이스 autoPass", good.autoPass, JSON.stringify(good.checks));
  check("검사 3종 보고", good.checks.length === 3, String(good.checks.length));
  check("치수 보고", good.width === 64 && good.height === 64);

  // 실패 케이스: 피사체가 가장자리까지 잘림
  const croppedPath = join(tmp, "cropped.png");
  await sharp(
    makeRaw(64, 64, (x, y) => (y >= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255])).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png()
    .toFile(croppedPath);

  const cropped = await inspectBaseImage(croppedPath);
  check("잘린 피사체는 autoPass 실패", !cropped.autoPass);
  check(
    "실패 항목이 fullBody",
    cropped.checks.find(c => c.id === "fullBody")?.ok === false,
    JSON.stringify(cropped.checks),
  );

  // pixelArt 옵션: AA 가 있으면 실패
  const aaPath = join(tmp, "aa.png");
  await sharp(
    makeRaw(64, 64, (x, y) => {
      const inside = x >= 20 && x <= 43 && y >= 20 && y <= 43;
      const edge = x === 19 || x === 44 || y === 19 || y === 44;
      if (edge) return [20, 40, 200, 128];
      return inside ? [20, 40, 200, 255] : [255, 0, 255, 255];
    }).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png()
    .toFile(aaPath);

  const aa = await inspectBaseImage(aaPath, { pixelArt: true });
  check(
    "픽셀아트 런에서 AA 가장자리는 실패",
    aa.checks.find(c => c.id === "pixelArt")?.ok === false,
    JSON.stringify(aa.checks),
  );

  const aaOff = await inspectBaseImage(aaPath);
  check(
    "픽셀아트 런이 아니면 AA 는 통과",
    aaOff.checks.find(c => c.id === "pixelArt")?.ok === true,
  );

  rmSync(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: FAIL — `inspectBaseImage is not a function`

- [ ] **Step 3: 구현을 추가한다**

`src/lib/sprite/base-gate.ts` 상단에 import 를 추가:

```ts
import sharp from "sharp";
```

파일 끝에 추가:

```ts
/** 픽셀아트 런에서 허용할 AA 반투명 비율 상한. 진짜 도트는 0 에 가깝다. */
const PIXEL_ART_SOFT_ALPHA_MAX = 0.02;

export type BaseCheck = {
  id: "background" | "fullBody" | "pixelArt";
  ok: boolean;
  detail: string;
};

export type BaseInspection = {
  checks: BaseCheck[];
  /** 자동 검사가 전부 통과했는가. **잠금은 아니다** — 최종 y/n 은 사람이 누른다. */
  autoPass: boolean;
  background: BackgroundInfo;
  softAlpha: number;
  bbox: BBox | null;
  width: number;
  height: number;
};

/**
 * base 후보 이미지를 잠금 기준으로 검사한다.
 *
 * 자동 판정은 3가지뿐이다(기준 1·3·6). 비율·스타일 적합성(2), 캐릭터 정체성(4),
 * 실루엣 가독성(5)은 사람 몫이라 여기서 다루지 않는다. autoPass 가 true 라도
 * 잠금이 자동으로 되지 않는다.
 */
export async function inspectBaseImage(
  filePath: string,
  opts?: { pixelArt?: boolean },
): Promise<BaseInspection> {
  const { data, info } = await sharp(filePath)
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const background = detectBackgroundMode(data, width, height, channels);
  const softAlpha = softAlphaFraction(data, width, height, channels);
  const bbox = subjectBBox(data, width, height, channels, background);

  const checks: BaseCheck[] = [];

  // 기준 6 — 평면 크로마 배경 (또는 쉽게 키잉 가능한 투명 배경)
  checks.push({
    id: "background",
    ok: background.mode === "flat" || background.mode === "transparent",
    detail:
      background.mode === "flat"
        ? `평면 배경 ${background.hex} (테두리 ${Math.round(background.borderCoverage * 100)}%)`
        : background.mode === "transparent"
          ? "투명 배경"
          : `테두리가 평면이 아님 (최다 색이 ${Math.round(background.borderCoverage * 100)}%만 덮음)`,
  });

  // 기준 1 — 전신, 잘린 곳 없음
  checks.push({
    id: "fullBody",
    ok: bbox !== null && !touchesEdge(bbox, width, height),
    detail:
      bbox === null
        ? "피사체를 찾지 못함"
        : touchesEdge(bbox, width, height)
          ? `피사체가 캔버스 가장자리에 닿음 (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1})`
          : `여백 확보 (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1})`,
  });

  // 기준 3 — 픽셀아트 런일 때만 강제. 균일 블록 피치 실측은 ⑤ 에서 추가한다.
  const pixelArtOk = !opts?.pixelArt || softAlpha <= PIXEL_ART_SOFT_ALPHA_MAX;
  checks.push({
    id: "pixelArt",
    ok: pixelArtOk,
    detail: opts?.pixelArt
      ? `AA 반투명 ${(softAlpha * 100).toFixed(2)}% (상한 ${PIXEL_ART_SOFT_ALPHA_MAX * 100}%)`
      : `픽셀아트 런 아님 — 검사 생략 (AA ${(softAlpha * 100).toFixed(2)}%)`,
  });

  return {
    checks,
    autoPass: checks.every(c => c.ok),
    background,
    softAlpha,
    bbox,
    width,
    height,
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: `21 passed, 0 failed`

- [ ] **Step 5: 타입·린트 확인**

Run:
```bash
pnpm tsc --noEmit && pnpm lint
```
Expected: 타입 에러 0, 린트 에러 0

- [ ] **Step 6: 커밋**

```bash
git add src/lib/sprite/base-gate.ts scripts/test-base-gate.ts
git commit -m "feat(sprite): base 후보 통합 검사 inspectBaseImage

잠금 기준 6가지 중 코드로 판정 가능한 3가지(배경·전신·픽셀아트)를 묶어
검사 결과와 근거 문자열을 돌려준다.

autoPass 는 '자동 검사가 전부 통과'라는 뜻이지 잠금이 아니다. 비율·스타일
적합성, 캐릭터 정체성, 실루엣 가독성은 결정론적 정의가 없어 사람 몫으로
남긴다 — 정본도 '나중에 고친다' 를 통과로 치지 않는다."
```

---

### Task 4: base 확정 저장과 조회

**Files:**
- Modify: `src/lib/db/repo/generations.ts`
- Modify: `scripts/test-base-gate.ts`

**Interfaces:**
- Consumes: 없음 (DB 계층)
- Produces:
  - `lockBaseGeneration(generationId: string, sessionId: string | null): void`
  - `getLockedBase(sessionId: string | null): Generation | null`

**설계 결정 — 새 DB kind 를 만들지 않는다:**
base 는 `text2img` 로 생성된 평범한 generation 이고, "base 로 잠겼다"는 것은 kind 를 대체하는
성질이 아니라 **부가 역할**이다. `params` JSON 에 표식을 남긴다.

이는 폐기된 `kindHint` 우회와 다르다. `kindHint` 는 CHECK enum 에 없는 kind 를 params 로
**대체**하던 것이고(migrate.ts v1 이 정식 enum 으로 정리), 여기서는 kind 가 이미 정확하다.
새 kind 를 추가하면 `migrate.ts` + `schema.sql` + `types/db.ts` 3중 동기화 비용이 든다
(CLAUDE.md 참조).

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-base-gate.ts` 의 `rmSync(tmp, ...)` 바로 앞에 삽입하고 상단 import 에 추가:

```ts
import { createGeneration, getLockedBase, lockBaseGeneration } from "../src/lib/db/repo/generations";
import { newGenerationId } from "../src/lib/util/ids";
```

```ts
  // ── base 잠금 저장·조회 ─────────────────────────────────────────
  const genId = newGenerationId();
  createGeneration({
    id: genId,
    session_id: null,
    message_id: null,
    kind: "text2img",
    prompt: "base idle candidate",
    image_path: "data/images/dummy.png",
    params: { source: "test" },
  });

  check("잠금 전에는 조회 결과 없음", getLockedBase(null) === null);

  lockBaseGeneration(genId, null);
  const locked = getLockedBase(null);
  check("잠금 후 조회됨", locked?.id === genId, locked?.id ?? "null");
  check(
    "기존 params 를 보존",
    (locked?.params as Record<string, unknown> | undefined)?.source === "test",
    JSON.stringify(locked?.params),
  );

  // 두 번째 base 를 잠그면 그것이 현재 base 가 된다
  const genId2 = newGenerationId();
  createGeneration({
    id: genId2,
    session_id: null,
    message_id: null,
    kind: "text2img",
    prompt: "second base",
    image_path: "data/images/dummy2.png",
    params: null,
  });
  lockBaseGeneration(genId2, null);
  check("가장 최근 잠금이 현재 base", getLockedBase(null)?.id === genId2);
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: FAIL — `lockBaseGeneration is not a function`

- [ ] **Step 3: 구현을 추가한다**

`src/lib/db/repo/generations.ts` 끝에 추가 (파일의 기존 import·헬퍼 이름을 그대로 쓴다 —
구현 전에 파일을 읽고 `getDb`·`rowToGeneration`·`Generation` 의 실제 이름을 확인할 것):

```ts
/**
 * generation 을 base idle 로 잠근다.
 *
 * 새 DB kind 를 만들지 않고 params 에 역할 표식을 남긴다. base 는 text2img 로
 * 생성된 평범한 generation 이고 "base 로 잠겼다"는 kind 를 대체하는 성질이 아니라
 * 부가 역할이기 때문이다. (폐기된 kindHint 우회와 다르다 — 그건 CHECK enum 에 없는
 * kind 를 params 로 대체하던 것이고, 여기서는 kind 가 이미 정확하다.)
 */
export function lockBaseGeneration(generationId: string, sessionId: string | null): void {
  const db = getDb();
  const row = db
    .prepare("SELECT params FROM generations WHERE id = ?")
    .get(generationId) as { params: string | null } | undefined;
  if (!row) throw new Error(`lockBaseGeneration: generation ${generationId} 이(가) 없습니다`);

  const params = row.params ? (JSON.parse(row.params) as Record<string, unknown>) : {};
  params.spriteRole = "base";
  params.baseLockedAt = Date.now();
  if (sessionId !== null) params.baseLockedSession = sessionId;

  db.prepare("UPDATE generations SET params = ? WHERE id = ?").run(
    JSON.stringify(params),
    generationId,
  );
}

/**
 * 현재 잠긴 base 를 돌려준다. 같은 세션에서 여러 번 잠갔으면 가장 최근 것.
 * sessionId 가 null 이면 세션에 묶이지 않은 잠금을 본다.
 */
export function getLockedBase(sessionId: string | null): Generation | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM generations
        WHERE json_extract(params, '$.spriteRole') = 'base'
          AND (? IS NULL OR json_extract(params, '$.baseLockedSession') = ?)
        ORDER BY json_extract(params, '$.baseLockedAt') DESC
        LIMIT 1`,
    )
    .get(sessionId, sessionId) as Record<string, unknown> | undefined;
  return row ? rowToGeneration(row) : null;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-base-gate.ts
```
Expected: `26 passed, 0 failed`

- [ ] **Step 5: 게이트 3종을 돌린다**

Run:
```bash
pnpm tsc --noEmit && pnpm test && pnpm lint
```
Expected: 타입 에러 0, 전체 테스트 통과, 린트 에러 0

- [ ] **Step 6: 커밋**

```bash
git add src/lib/db/repo/generations.ts scripts/test-base-gate.ts
git commit -m "feat(db): base idle 잠금 저장·조회

generations.params 에 spriteRole='base' 표식을 남긴다. 새 kind 를 만들지
않는 이유는 base 가 text2img 로 생성된 평범한 generation 이고 '잠겼다'는
kind 를 대체하는 성질이 아니라 부가 역할이기 때문이다. 새 kind 는
migrate.ts + schema.sql + types/db.ts 3중 동기화 비용이 든다.

폐기된 kindHint 우회와는 다르다 — 그건 CHECK enum 에 없는 kind 를 params 로
대체하던 것이고, 여기서는 kind 가 이미 정확하다."
```

---

### Task 5: 실제 이미지로 게이트 검증

**Files:** 없음 (실행 검증만)

codex 를 새로 호출하지 않는다. ⓪ 검증에서 만든 이미지를 재사용한다.

- [ ] **Step 1: 통과해야 할 이미지로 검사한다**

⓪ 검증에서 만든 흰 배경 사과(`data/images/6cob7vnnnar1w3yd.png`)로 확인한다.
실제 파일명은 `ls -t data/images/*.png | head -3` 으로 찾는다.

```bash
pnpm tsx -e "
import('./src/lib/sprite/base-gate').then(async m => {
  const r = await m.inspectBaseImage(process.argv[1]);
  console.log(JSON.stringify({ autoPass: r.autoPass, checks: r.checks, bg: r.background }, null, 2));
});
" <이미지경로>
```

Expected: 흰 배경은 `flat` 로 잡히고, 사과가 캔버스 가장자리에 닿지 않으므로 `fullBody` 통과.
**결과를 그대로 기록한다** — `heterogeneous` 로 나오면 실제 생성물의 배경이 평면이 아니라는
뜻이고, 그건 ② 에서 크로마 키를 지정해야 하는 근거가 된다.

- [ ] **Step 2: 판정이 의심스러우면 이미지를 눈으로 본다**

Read 도구로 이미지를 열어 판정과 대조한다. 자동 검사가 사람 눈과 어긋나면 그 사실을
기록한다 — 임계값이 우리 생성물에 맞지 않는다는 신호다.

- [ ] **Step 3: 결과를 스펙에 반영한다**

Step 1~2 에서 임계값 조정이 필요하다고 드러나면 스펙 §5.2 에 실측값을 적고, 조정은 별도
커밋으로 남긴다. 조정이 필요 없으면 기록만 남기고 커밋하지 않는다.

---

## Self-Review

**스펙 커버리지** (§5 대비):

| 스펙 항목 | 태스크 |
|---|---|
| §5.1 게이트의 성격(차단형, y/n) | Task 3 — `autoPass` 는 잠금이 아님을 타입·주석·커밋에 명시 |
| §5.2 잠금 기준 6가지 중 자동 검사 가능한 것 | Task 1(기준 6) · Task 2(기준 1·3) · Task 3(통합) |
| §5.2 자동화하지 않는 것 | Global Constraints 표에 명시 |
| §5.3 소유권 규칙 | 이 단계 범위 밖 — base 은퇴는 ③④ 에서 일어난다 |
| §5.4 저장 구조 결정 | Task 4 — params 표식, 근거를 커밋 메시지에 |
| §5.5 UI | **의도적으로 제외** — §3.3 방침 |

**스펙과 달라지는 것 하나** — §5.2 는 잠금 기준 5(실루엣 가독성)를 "부분 자동"으로 적었으나,
축소 후 대비를 재는 결정론적 정의가 없어 **사람 몫으로 옮겼다.** 구현 후 스펙을 고쳐야 한다.

**미검증 가정 하나** — 픽셀아트 판정을 AA 비율만으로 근사한다. 정본은 "균일 블록 피치가
실측될 것"을 함께 요구하므로 이 검사는 **불완전하다.** 고해상 가짜-도트(1024px 생성물)는 AA 가
적어도 피치가 균일하지 않을 수 있는데, 지금 코드는 그것을 통과시킨다. ⑤ 에서 피치 검출기를
포팅한 뒤 이 검사에 붙여야 한다 — Task 3 주석과 §10 미해결에 남긴다.

**타입 일관성**: `BackgroundInfo`·`BBox`·`BaseCheck`·`BaseInspection` 이 Task 1~3 정의와 Task 4
테스트 사용처에서 일치한다. `detectBackgroundMode` 는 `(raw, width, height, channels)` 순서를
Task 1~3 전체에서 동일하게 쓴다.

**구현 전 확인이 필요한 것**: Task 4 는 `src/lib/db/repo/generations.ts` 의 기존
`getDb`·`rowToGeneration`·`Generation` 이름을 그대로 쓴다고 가정한다. 구현 전에 그 파일을 읽고
실제 이름을 확인할 것 — 다르면 맞춰 쓴다.
