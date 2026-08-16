# ⓪단계 — codex provider 정합 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codex 가 생성한 이미지를 모델의 파일 저장 협조에 의존하지 않고 세션 rollout jsonl 의 inline base64 에서 직접 회수한다.

**Architecture:** `codex exec --json` 으로 stdout 에 JSON 이벤트 스트림을 받아 session id 와 진행 단계를 얻고, `~/.codex/sessions/**/rollout-*{id}*.jsonl` 에서 `image_generation_*` 레코드의 base64 를 디코딩해 PNG 로 쓴다. 파싱 로직은 순수 함수로 분리해 codex 없이 테스트한다. spawn 골격·타임아웃·로그·후처리는 건드리지 않는다.

**Tech Stack:** TypeScript (Node 20+), `node:child_process` spawn, `node:fs/promises`, sharp(메타데이터만). 테스트는 tsx 스크립트 + 자체 assert — 이 저장소에는 테스트 프레임워크가 없다.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-16-sprite-gen-pipeline-design.md` §4
- 라이선스: 이식 대상은 sprite-gen `sprite_gen/gen/codex_provider.py` (Apache-2.0, Copyright 2026 Alex Kim). 그 파일 자체가 image-gen 스킬(MIT, aldegad/image-gen)에서 포팅된 것이므로 **양쪽 계보를 모두 파일 헤더에 고지**한다.
- 타임아웃은 현행 `CODEX_TIMEOUT_MS = 600_000` 유지 (sprite-gen 은 180초지만 우리는 imagegen 스킬 경유 + 큰 캔버스라 더 느릴 수 있다).
- Windows 경로 유지: `codex.cmd` 대신 node 로 `codex.js` 직접 spawn (`codex-exec.ts:498-507`).
- `env` 에 `NODE_OPTIONS: "--max-old-space-size=8192"` 유지.
- 기존 후처리 경로(`remove_bg`/`layer_extract`/`inpaint`/`img2img` 의 chroma/luma key)는 **변경하지 않는다**. `destPath` 에 PNG 가 놓이기만 하면 그대로 동작한다.
- 커밋 메시지는 한국어 + conventional commits, 본문에 "왜"를 적는다.
- `--ephemeral` 을 절대 추가하지 않는다. rollout jsonl 이 디스크에 남아야 회수가 된다.

### 실제 데이터로 확인된 사실 (2026-08-16, 로컬 `~/.codex/sessions` 실측)

이 계획은 추측이 아니라 아래 실측에 근거한다. 구현 중 다르게 나오면 계획을 고친다.

- 레코드 두 종류가 **같은 base64 를 중복 반환**한다: `image_generation_call`(keys: id, result, revised_prompt, status, type)과 `image_generation_end`(keys: call_id, result, revised_prompt, saved_path, status, type). 한 장만 채택한다.
- **`status` 값이 `"generating"` 이다.** sprite-gen 은 `status != "completed"` 를 에러로 던지지만, 우리 실측 데이터에는 `completed` 가 없다. 그대로 이식하면 **항상 실패한다.** 따라서 status 는 로그에만 남기고 **`result` 존재 여부로 판정**한다.
- `saved_path` 는 실재한다(`~/.codex/generated_images/{session-id}/ig_*.png`). 그래도 쓰지 않는다 — 세션 디렉터리 정리·권한에 영향받지 않는 base64 가 안전하다.
- session id 는 `session_meta` 레코드의 `id` 이며 **파일명에도 들어있다**(`rollout-<ts>-<uuid>.jsonl`).
- `payload.type` 이 없는 레코드가 섞여 있다. 파서는 이를 건너뛰어야 한다(`jq` 로 읽을 때 실제 에러가 났다).
- base64 길이는 약 1.9MB (PNG 약 1.45MB). 문자열 처리 시 메모리를 고려한다.

## File Structure

| 파일 | 책임 |
|------|------|
| `src/lib/image-backend/codex-rollout.ts` (신규) | 순수 파싱 — stdout 에서 session id 추출, rollout jsonl 경로 해석, base64 레코드 수집, PNG 매직 검증 |
| `scripts/test-codex-rollout.ts` (신규) | 위 순수 함수의 단위 테스트. codex 실행 불필요 |
| `src/lib/image-backend/codex-exec.ts` (수정) | 호출 인자, `PROMPT_HEADER`, `inferStage`, 회수 배선 |
| `package.json` (수정) | `test` 스크립트에 새 테스트 추가 |

`codex-rollout.ts` 를 분리하는 이유는 파싱이 codex 실행과 무관한 순수 로직이라 테스트가 가능하기 때문이다. `codex-exec.ts`(696줄)에 더 넣으면 테스트할 수 없다.

---

### Task 1: rollout 파싱 순수 함수

**Files:**
- Create: `src/lib/image-backend/codex-rollout.ts`
- Test: `scripts/test-codex-rollout.ts`
- Modify: `package.json` (test 스크립트)

**Interfaces:**
- Produces:
  - `parseSessionId(stdout: string): string | null`
  - `collectInlineResults(jsonlText: string): { results: string[]; statuses: string[] }`
  - `isPng(buf: Buffer): boolean`
  - `extractStreamErrors(stdout: string): string[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scripts/test-codex-rollout.ts` 생성:

```ts
/**
 * codex rollout 파싱 단위 테스트 — codex 미사용 순수 함수.
 *
 *   pnpm tsx scripts/test-codex-rollout.ts
 *
 * 실제 ~/.codex/sessions 레코드 형태(2026-08-16 실측)를 고정 문자열로 재현해
 * session id 추출 · inline base64 수집 · PNG 매직 검증 · 에러 추출을 단언한다.
 */
import {
  collectInlineResults,
  extractStreamErrors,
  isPng,
  parseSessionId,
} from "../src/lib/image-backend/codex-rollout";

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

// ── parseSessionId ────────────────────────────────────────────────
const SID = "019e6776-0a53-71d1-8be0-ff8172b6d055";

check(
  "thread.started 이벤트에서 session id 추출",
  parseSessionId(`{"type":"thread.started","thread_id":"${SID}"}\n`) === SID,
);

check(
  "구 codex 텍스트 라인에서 session id 추출",
  parseSessionId(`some noise\nsession id: ${SID}\nmore\n`) === SID,
);

check(
  "JSON 과 텍스트가 섞여도 JSON 이 우선",
  parseSessionId(`session id: aaaa\n{"type":"thread.started","thread_id":"${SID}"}\n`) === SID,
);

check("session id 가 없으면 null", parseSessionId("nothing here\n") === null);

check("빈 문자열은 null", parseSessionId("") === null);

// ── collectInlineResults ──────────────────────────────────────────
// 실측 형태: call 과 end 가 같은 base64 를 중복 반환하고 status 는 "generating".
const B64_A = "AAAA";
const B64_B = "BBBB";
const JSONL = [
  `{"payload":{"type":"session_meta","id":"${SID}"}}`,
  `{"payload":{"type":"user_message"}}`,
  // payload.type 이 없는 레코드 — 건너뛰어야 한다
  `{"payload":{"foo":"bar"}}`,
  `{"not_payload":1}`,
  `{"payload":{"type":"image_generation_call","id":"c1","result":"${B64_A}","status":"generating"}}`,
  `{"payload":{"type":"image_generation_end","call_id":"c1","result":"${B64_A}","status":"generating","saved_path":"/tmp/x.png"}}`,
  `{"payload":{"type":"image_generation_end","call_id":"c2","result":"${B64_B}","status":"completed"}}`,
  "",                       // 빈 줄
  "{ not json",             // 깨진 줄 — 건너뛰어야 한다
].join("\n");

const collected = collectInlineResults(JSONL);

check(
  "중복 base64 는 한 번만 수집",
  collected.results.length === 2,
  `got ${collected.results.length}: ${JSON.stringify(collected.results)}`,
);

check("수집 순서 유지", collected.results[0] === B64_A && collected.results[1] === B64_B);

check(
  "status 는 버리지 않고 모은다",
  collected.statuses.includes("generating") && collected.statuses.includes("completed"),
  JSON.stringify(collected.statuses),
);

check("result 없는 레코드는 무시", collectInlineResults(
  `{"payload":{"type":"image_generation_end","status":"generating"}}`,
).results.length === 0);

check("빈 입력은 빈 결과", collectInlineResults("").results.length === 0);

// ── isPng ─────────────────────────────────────────────────────────
check("PNG 매직 통과", isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])));
check("JPEG 매직 거부", isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
check("8바이트 미만 거부", isPng(Buffer.from([0x89, 0x50])));
check("빈 버퍼 거부", isPng(Buffer.alloc(0)));

// ── extractStreamErrors ───────────────────────────────────────────
const ERR_STREAM = [
  `{"type":"thread.started","thread_id":"${SID}"}`,
  `{"type":"turn.failed","message":"unsupported model 'gpt-9'"}`,
  `{"type":"error","message":{"message":"nested detail"}}`,
  `plain noise line`,
].join("\n");

const errs = extractStreamErrors(ERR_STREAM);
check("turn.failed 메시지 추출", errs.some(e => e.includes("unsupported model")), JSON.stringify(errs));
check("중첩 message 추출", errs.some(e => e.includes("nested detail")), JSON.stringify(errs));
check("정상 스트림은 빈 배열", extractStreamErrors(`{"type":"thread.started","thread_id":"${SID}"}`).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-codex-rollout.ts
```
Expected: FAIL — `Cannot find module '../src/lib/image-backend/codex-rollout'`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/lib/image-backend/codex-rollout.ts` 생성:

```ts
/**
 * codex `exec --json` 스트림과 세션 rollout jsonl 파싱.
 *
 * codex 의 image_gen 은 PNG 를 rollout jsonl 안에 base64 로 inline 반환한다.
 * 모델이 보고하는 saved_path 는 신뢰하지 않는다 — 모델이 파일을 옮기거나
 * 이름을 바꾸는 부가 동작에 의존하면 회수가 조용히 실패한다.
 *
 * sprite-gen `sprite_gen/gen/codex_provider.py` (Apache-2.0, Copyright 2026
 * Alex Kim) 에서 이식. 그쪽은 다시 image-gen 스킬(MIT, aldegad/image-gen)
 * 에서 포팅된 것이라 양쪽 계보를 함께 고지한다.
 *
 * sprite-gen 과 다른 점: status 를 실패 판정에 쓰지 않는다. 로컬 실측
 * (2026-08-16)에서 status 가 "generating" 으로만 관측돼, sprite-gen 의
 * `status != "completed" → 에러` 를 그대로 쓰면 항상 실패한다.
 */

/** PNG 시그니처. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** base64 를 실어 나르는 payload.type — codex 버전에 따라 둘 중 하나. 둘 다 정식이다. */
const RESULT_TYPES = new Set(["image_generation_call", "image_generation_end"]);

/** 구 codex 가 텍스트로 출력하던 형태. */
const SID_TEXT_RE = /session id: ([0-9a-f-]+)/g;

/** stdout 에서 세션 id 를 뽑는다. JSON 이벤트가 우선, 없으면 텍스트 라인. */
export function parseSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { thread_id?: unknown };
      if (event && typeof event === "object" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // JSON 이 아닌 줄 — 아래 텍스트 폴백에서 처리
    }
  }
  const hits = [...stdout.matchAll(SID_TEXT_RE)].map(m => m[1]);
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

/**
 * rollout jsonl 본문에서 inline base64 를 수집한다.
 * call/end 두 레코드가 같은 결과를 중복 반환하므로 중복은 제거한다.
 */
export function collectInlineResults(jsonlText: string): {
  results: string[];
  statuses: string[];
} {
  const results: string[] = [];
  const seen = new Set<string>();
  const statuses: string[] = [];

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: { payload?: { type?: unknown; result?: unknown; status?: unknown } };
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (typeof payload.type !== "string" || !RESULT_TYPES.has(payload.type)) continue;
    if (typeof payload.result !== "string" || payload.result.length === 0) continue;

    if (typeof payload.status === "string") statuses.push(payload.status);
    if (seen.has(payload.result)) continue;
    seen.add(payload.result);
    results.push(payload.result);
  }
  return { results, statuses };
}

/** PNG 매직 바이트 확인. */
export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/**
 * `codex exec --json` 스트림에서 사람이 읽을 수 있는 실패 원인을 뽑는다.
 * codex 는 치명적 오류를 turn.failed / error 레코드로 알린다.
 */
export function extractStreamErrors(stdout: string): string[] {
  const msgs: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: unknown; message?: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== "turn.failed" && event?.type !== "error") continue;
    const message = event.message;
    if (typeof message === "string") {
      msgs.push(message);
    } else if (message && typeof message === "object") {
      const nested = (message as { message?: unknown }).message;
      if (typeof nested === "string") msgs.push(nested);
    }
  }
  return msgs;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-codex-rollout.ts
```
Expected: `16 passed, 0 failed`, 종료 코드 0

- [ ] **Step 5: package.json 의 test 에 등록한다**

`package.json` 의 `scripts.test` 를 다음으로 바꾼다:

```json
"test": "tsx scripts/test-classify.ts && tsx scripts/test-directions.ts && tsx scripts/test-sprite-marker.ts && tsx scripts/test-codex-rollout.ts",
```

- [ ] **Step 6: 전체 단위 테스트가 통과하는지 확인한다**

Run:
```bash
pnpm test
```
Expected: 네 스크립트 모두 통과, 종료 코드 0

- [ ] **Step 7: 커밋**

```bash
git add src/lib/image-backend/codex-rollout.ts scripts/test-codex-rollout.ts package.json
git commit -m "feat(codex): rollout jsonl 파싱 순수 함수 추가

codex image_gen 은 PNG 를 세션 rollout jsonl 에 base64 로 inline 반환한다.
모델이 보고하는 saved_path 는 신뢰하지 않는다 — 파일을 옮기는 부가 동작에
의존하면 회수가 조용히 실패한다.

sprite-gen codex_provider.py 에서 이식하되 status 판정은 완화했다.
로컬 실측에서 status 가 \"generating\" 으로만 관측돼, sprite-gen 의
status != completed → 에러 를 그대로 쓰면 항상 실패한다. result 존재로
판정하고 status 는 로그에만 남긴다.

call/end 두 레코드가 같은 base64 를 중복 반환하므로 중복을 제거한다."
```

---

### Task 2: rollout 파일 조회와 PNG 회수

**Files:**
- Modify: `src/lib/image-backend/codex-rollout.ts`
- Modify: `scripts/test-codex-rollout.ts`

**Interfaces:**
- Consumes: Task 1 의 `collectInlineResults`, `isPng`
- Produces:
  - `resolveRolloutPath(sessionId: string, sessionsDir?: string): Promise<string>`
  - `recoverPngFromRollout(sessionId: string, destPath: string, sessionsDir?: string): Promise<{ bytes: number; statuses: string[] }>`

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`scripts/test-codex-rollout.ts` 의 `console.log(\`\n${pass} passed...\`)` 바로 위에 삽입:

```ts
// ── resolveRolloutPath / recoverPngFromRollout ────────────────────
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverPngFromRollout, resolveRolloutPath } from "../src/lib/image-backend/codex-rollout";

const tmpRoot = mkdtempSync(join(tmpdir(), "codex-rollout-test-"));
const sessionsDir = join(tmpRoot, "sessions");
mkdirSync(join(sessionsDir, "2026", "08", "16"), { recursive: true });

// 1×1 투명 PNG 의 base64 (실제 PNG 매직으로 시작한다)
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const rolloutPath = join(
  sessionsDir, "2026", "08", "16",
  `rollout-2026-08-16T00-00-00-${SID}.jsonl`,
);
writeFileSync(rolloutPath, [
  `{"payload":{"type":"session_meta","id":"${SID}"}}`,
  `{"payload":{"type":"image_generation_call","id":"c1","result":"${TINY_PNG_B64}","status":"generating"}}`,
  `{"payload":{"type":"image_generation_end","call_id":"c1","result":"${TINY_PNG_B64}","status":"generating"}}`,
].join("\n"));

const resolved = await resolveRolloutPath(SID, sessionsDir);
check("session id 로 rollout 파일 해석", resolved === rolloutPath, resolved);

let notFound = false;
try {
  await resolveRolloutPath("no-such-session", sessionsDir);
} catch {
  notFound = true;
}
check("없는 session id 는 throw", notFound);

const destPath = join(tmpRoot, "out.png");
const recovered = await recoverPngFromRollout(SID, destPath, sessionsDir);
check("PNG 가 기록됨", isPng(readFileSync(destPath)));
check("바이트 수 반환", recovered.bytes > 0, String(recovered.bytes));
check("status 를 함께 반환", recovered.statuses.includes("generating"));

// result 레코드가 없는 rollout
const emptySid = "0000ffff-0000-0000-0000-000000000000";
writeFileSync(
  join(sessionsDir, "2026", "08", "16", `rollout-2026-08-16T00-00-01-${emptySid}.jsonl`),
  `{"payload":{"type":"user_message"}}`,
);
let noResult = false;
try {
  await recoverPngFromRollout(emptySid, join(tmpRoot, "none.png"), sessionsDir);
} catch (e) {
  noResult = (e as Error).message.includes("image_gen");
}
check("결과 레코드가 없으면 throw", noResult);

rmSync(tmpRoot, { recursive: true, force: true });
```

테스트 스크립트 최상단의 import 블록도 `recoverPngFromRollout`, `resolveRolloutPath` 를 포함하도록 정리한다(중복 import 를 남기지 말 것).

- [ ] **Step 2: 실패를 확인한다**

Run:
```bash
pnpm tsx scripts/test-codex-rollout.ts
```
Expected: FAIL — `resolveRolloutPath is not exported` 또는 `is not a function`

- [ ] **Step 3: 구현을 추가한다**

`src/lib/image-backend/codex-rollout.ts` 끝에 추가 (파일 상단에 import 도 추가):

```ts
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
```

```ts
/** 기본 codex 세션 디렉터리. 테스트는 sessionsDir 를 주입한다. */
function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

/** 디렉터리를 재귀 순회하며 조건에 맞는 파일 경로를 모은다. */
async function walk(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full, match)));
    } else if (match(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * session id 를 담은 rollout jsonl 을 찾는다.
 * 같은 id 로 여러 개가 나오면 mtime 이 가장 최근인 것.
 */
export async function resolveRolloutPath(
  sessionId: string,
  sessionsDir: string = defaultSessionsDir(),
): Promise<string> {
  const hits = await walk(
    sessionsDir,
    name => name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(sessionId),
  );
  if (hits.length === 0) {
    throw new Error(
      `codex: session ${sessionId} 의 rollout jsonl 을 ${sessionsDir} 에서 찾지 못했습니다`,
    );
  }
  if (hits.length === 1) return hits[0];
  const withTime = await Promise.all(
    hits.map(async p => ({ p, mtime: (await stat(p)).mtimeMs })),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].p;
}

/**
 * rollout jsonl 의 inline base64 를 디코딩해 destPath 에 PNG 로 쓴다.
 * 결과가 여러 장이면 마지막(가장 최근 생성)을 채택한다.
 */
export async function recoverPngFromRollout(
  sessionId: string,
  destPath: string,
  sessionsDir: string = defaultSessionsDir(),
): Promise<{ bytes: number; statuses: string[] }> {
  const rolloutPath = await resolveRolloutPath(sessionId, sessionsDir);
  const text = await readFile(rolloutPath, "utf8");
  const { results, statuses } = collectInlineResults(text);

  if (results.length === 0) {
    throw new Error(
      `codex: ${rolloutPath} 에 image_gen 결과 레코드가 없습니다 ` +
        `(모델이 도구를 호출하지 않았을 수 있습니다)`,
    );
  }

  const buf = Buffer.from(results[results.length - 1], "base64");
  if (!isPng(buf)) {
    throw new Error(
      `codex: 디코딩 결과가 PNG 가 아닙니다 (매직 불일치, ${buf.length} bytes) — ` +
        `성공으로 처리하지 않습니다`,
    );
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  return { bytes: buf.length, statuses };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run:
```bash
pnpm tsx scripts/test-codex-rollout.ts
```
Expected: `22 passed, 0 failed`

- [ ] **Step 5: 커밋**

```bash
git add src/lib/image-backend/codex-rollout.ts scripts/test-codex-rollout.ts
git commit -m "feat(codex): rollout jsonl 조회와 base64 PNG 회수

session id 로 ~/.codex/sessions 를 재귀 탐색해 rollout jsonl 을 찾고,
inline base64 를 디코딩해 PNG 로 쓴다. 매직 바이트가 맞지 않으면
성공으로 처리하지 않는다.

sessionsDir 를 주입 가능하게 해 임시 디렉터리로 테스트한다."
```

---

### Task 3: 프롬프트 헤더 교체와 진행 단계 재구성

**Files:**
- Modify: `src/lib/image-backend/codex-exec.ts:38-45` (PROMPT_HEADER)
- Modify: `src/lib/image-backend/codex-exec.ts:400-408` (inferStage)

**Interfaces:**
- Consumes: 없음
- Produces: `inferStage(line: string): "image_generating" | "recovering" | null` — 시그니처 유지, 판정 근거만 교체

**배경 — 이 태스크가 필요한 이유:**
현재 `inferStage` 는 stderr 의 `generated_images` + `find`/`cp ` 문자열에 전적으로 의존한다
(`codex-exec.ts:404-405`). 이는 모델이 파일을 복사하는 동작의 부산물이다. Step 1 에서 파일 저장
지시를 제거하면 **두 단계가 모두 사라져 진행 표시가 "starting" 에서 "done" 으로 점프한다.**
`--json` 스트림의 이벤트로 대체한다.

- [ ] **Step 1: PROMPT_HEADER 를 교체한다**

`codex-exec.ts:38-45` 의 `PROMPT_HEADER` 를 다음으로 바꾼다:

```ts
const PROMPT_HEADER =
  "image_gen 도구를 정확히 1번 호출해 이미지 1장만 생성한다. " +
  "If the prompt is generic, add tasteful composition framing, lighting mood, and style clarity to improve quality. " +
  "파일 저장·셸 명령·코드 작성·경로 보고를 하지 않는다. 생성만 하고 끝낸다. " +
  "Do not run remove_chroma_key.py or any background-removal script — the host pipeline handles all post-processing.\n\n";
```

제거된 것: `"Save the result as ./output.png ..."`, `"Do not create any other files. ... Just produce ./output.png."`
유지된 것: 품질 보정 지시, 배경 제거 스크립트 금지(후처리는 우리가 한다).

- [ ] **Step 2: inferStage 를 JSON 이벤트 기반으로 바꾼다**

`codex-exec.ts:400-408` 을 다음으로 바꾼다:

```ts
/**
 * `codex exec --json` stdout 한 줄을 보고 어떤 단계에 와 있는지 추정.
 *
 * 과거에는 stderr 의 `generated_images` + `find`/`cp ` 문자열을 봤다. 그건 모델이
 * 파일을 복사하는 부가 동작의 부산물이었고, 그 지시를 프롬프트에서 제거하면서
 * 근거가 사라졌다. 이제 프로토콜 이벤트를 직접 읽는다.
 */
function inferStage(
  line: string,
): "image_generating" | "recovering" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let event: { type?: unknown };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const type = typeof event?.type === "string" ? event.type : "";
  if (type === "image_generation_call" || type === "image_generation.started") {
    return "image_generating";
  }
  if (type === "image_generation_end" || type === "turn.completed") {
    return "recovering";
  }
  return null;
}
```

- [ ] **Step 3: 타입 체크가 통과하는지 확인한다**

Run:
```bash
pnpm lint
```
Expected: 에러 없음 (경고는 무방)

- [ ] **Step 4: 커밋**

```bash
git add src/lib/image-backend/codex-exec.ts
git commit -m "refactor(codex): 프롬프트에서 파일 저장 지시 제거, inferStage 를 이벤트 기반으로

codex image_gen 은 PNG 를 rollout jsonl 에 base64 로 반환하므로 모델에게
파일 저장을 시킬 이유가 없다. 부가 작업을 시키면 그 성공 여부에 회수가
의존한다.

부작용으로 inferStage 의 근거가 사라진다 — 기존 판정은 stderr 의
generated_images + find/cp 문자열, 즉 파일 복사 동작의 부산물이었다.
--json 스트림의 image_generation_* 이벤트를 직접 읽도록 교체한다."
```

---

### Task 4: 호출 인자와 회수 경로 배선

**Files:**
- Modify: `src/lib/image-backend/codex-exec.ts:477-488` (args)
- Modify: `src/lib/image-backend/codex-exec.ts:508-513` (spawn env)
- Modify: `src/lib/image-backend/codex-exec.ts:604-634` (회수)

**Interfaces:**
- Consumes: Task 2 의 `recoverPngFromRollout`, Task 1 의 `parseSessionId`·`extractStreamErrors`
- Produces: 없음 (`CodexExecBackend.execute` 시그니처 불변)

- [ ] **Step 1: import 를 추가한다**

`codex-exec.ts` 상단 import 블록에 추가:

```ts
import {
  extractStreamErrors,
  parseSessionId,
  recoverPngFromRollout,
} from "./codex-rollout.js";
```

- [ ] **Step 2: 호출 인자를 교체한다**

`codex-exec.ts:477-488` 의 `args` 를 다음으로 바꾼다:

```ts
    const genDir = path.join(os.homedir(), ".codex", "generated_images");
    const args = [
      "exec",
      "--json",
      "--cd",
      workDir,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--color",
      "never",
      // 기본 쓰기 집합에 없다. 누락 시 image_gen 이 조용히 실패할 수 있다
      // (sprite-gen codex_provider.py 헤더의 관측).
      "--add-dir",
      genDir,
      "-c", `model_reasoning_effort="high"`,
      ...attachedImages.flatMap(p => ["-i", p]),
      ...(attachedImages.length > 0 ? ["--"] : []),
      "-",
    ];
```

`os` import 가 없으면 파일 상단에 `import os from "node:os";` 를 추가한다.

**바꾸지 않는 것**: 프롬프트는 이미 stdin 으로 전달된다(`child.stdin!.end(naturalPrompt)`, `-` sentinel). `--ephemeral` 은 넣지 않는다.

- [ ] **Step 3: spawn env 에서 orchestrator 세션 변수를 제거한다**

`codex-exec.ts:508-513` 의 `spawn(...)` 호출에서 `env` 를 다음으로 바꾼다:

```ts
    // 헤드리스 생성 서브프로세스는 스폰한 에이전트의 세션 정체성을 물려받지 않는다.
    // 우리는 Claude CLI 가 띄운 MCP 서버 안에서 codex 를 다시 spawn 하므로,
    // 세션 환경이 섞이면 추적이 어려워진다. prefix 블랙리스트로 걷어낸다
    // (화이트리스트는 codex 인증·PATH 관련 변수를 빠뜨릴 위험이 있다).
    const ORCHESTRATOR_ENV_PREFIXES = ["CLAUDE_", "CLAUDECODE", "ANTHROPIC_", "MCP_"];
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (ORCHESTRATOR_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
      childEnv[key] = value;
    }
    childEnv.NODE_OPTIONS = "--max-old-space-size=8192";

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      shell: false,
      windowsHide: true,
    });
```

- [ ] **Step 4: 회수 경로를 교체한다**

`codex-exec.ts:604-634` 의 "workDir 에서 output.png 찾기" 블록 전체(`onProgress("recovering", ...)` 부터 `await fs.rename(pickedPath, destPath);` 까지)를 다음으로 바꾼다:

```ts
    // rollout jsonl 의 inline base64 에서 회수한다.
    // 모델이 보고하는 saved_path 나 workDir 의 파일은 신뢰하지 않는다 —
    // 그 경로는 모델이 파일을 복사해줄 때만 존재한다.
    onProgress("recovering", "reading rollout");
    const sessionId = parseSessionId(stdoutBuf);
    if (!sessionId) {
      const streamErrors = extractStreamErrors(stdoutBuf);
      const detail = streamErrors.length > 0
        ? streamErrors.join("; ")
        : "(stdout 에 오류 상세 없음)";
      throw new Error(
        `codex: stdout 에서 session id 를 찾지 못했습니다 — ${detail}. See ${logFile}`,
      );
    }

    const destPath = imagePathFor(job.generationId);
    let recovered: { bytes: number; statuses: string[] };
    try {
      recovered = await recoverPngFromRollout(sessionId, destPath);
    } catch (e) {
      throw new Error(`${(e as Error).message}. See ${logFile}`);
    }
    await fs.appendFile(
      logFile,
      `\n# recovered: session=${sessionId} bytes=${recovered.bytes} ` +
        `statuses=${JSON.stringify(recovered.statuses)}`,
    );
```

**제거되는 것**: `output.png` 조회, "가장 최근 `.png`" 폴백, `fs.rename`. 폴백은 회수 실패를 조용히 덮어 엉뚱한 이미지를 집어올 수 있다.

**주의**: 아래에 이어지는 후처리 블록(`if (job.kind === "remove_bg")` 이하)은 `destPath` 를 그대로 쓰므로 **변경하지 않는다**.

- [ ] **Step 5: 빌드와 린트가 통과하는지 확인한다**

Run:
```bash
pnpm lint && pnpm tsx -e "import('./src/lib/image-backend/codex-exec.js').then(() => console.log('import ok'))"
```
Expected: 린트 에러 없음, `import ok`

- [ ] **Step 6: 단위 테스트가 여전히 통과하는지 확인한다**

Run:
```bash
pnpm test
```
Expected: 전부 통과

- [ ] **Step 7: 커밋**

```bash
git add src/lib/image-backend/codex-exec.ts
git commit -m "feat(codex): 호출 인자 정합 + rollout base64 회수로 교체

--json(session id 파싱), --color never, --add-dir(누락 시 image_gen 이
조용히 실패할 수 있다)을 추가하고, 회수를 workDir 파일 스캔에서 rollout
jsonl 의 inline base64 디코딩으로 바꾼다.

output.png 없으면 최신 .png 폴백을 제거했다. 이 폴백은 회수 실패를 조용히
덮어 엉뚱한 이미지를 결과로 반환할 수 있었다. 이제 실패가 실패로 드러난다.

env 는 prefix 블랙리스트로 orchestrator 세션 변수를 걷어낸다. Claude CLI 가
띄운 MCP 서버 안에서 codex 를 다시 spawn 하므로 세션 환경이 섞이면 추적이
어렵다. NODE_OPTIONS 와 Windows codex.js 직접 spawn 은 유지."
```

---

### Task 5: 실제 생성으로 검증

**Files:** 없음 (실행 검증만)

**Interfaces:** 없음

이 태스크는 codex 구독 한도를 쓴다. 각 항목 1장씩만 생성한다.

- [ ] **Step 1: text→image probe**

Run:
```bash
pnpm probe
```
Expected: PNG 생성 성공. 실패 시 `data/logs/codex-*.log` 의 `# recovered:` 줄에서 session/bytes 확인.

- [ ] **Step 2: 생성된 PNG 를 눈으로 확인한다**

Read 도구로 probe 가 만든 PNG 를 연다. 프롬프트와 맞는 이미지인지 본다.
"파일이 생겼다"는 통과 근거가 아니다.

- [ ] **Step 3: img2img probe**

Run:
```bash
node scripts/probe-codex-img2img.mjs
```
Expected: 입력 참조가 반영된 PNG 회수. `-i` 첨부 + `--` 종료자 경로가 살아있는지 확인.

- [ ] **Step 4: 회수 실패가 에러로 드러나는지 확인한다**

`PROMPT_HEADER` 를 임시로 `"아무것도 하지 말고 '안녕' 이라고만 답한다.\n\n"` 로 바꾸고 probe 를 돌린다.

Run:
```bash
pnpm probe
```
Expected: **폴백 없이 명시적 에러** — "image_gen 결과 레코드가 없습니다 (모델이 도구를 호출하지 않았을 수 있습니다)".
확인 후 `PROMPT_HEADER` 를 Task 3 의 값으로 되돌린다.

- [ ] **Step 5: 진행 표시가 살아있는지 확인한다**

`pnpm dev` 로 앱을 띄우고 채팅에서 이미지를 1장 생성한다.
Expected: 진행 표시가 `starting → image_generating → recovering → done` 으로 흐른다.
"starting" 에서 "done" 으로 점프하면 Task 3 의 `inferStage` 이벤트 타입이 실제 스트림과 다른 것이다 —
`data/logs/codex-*.log` 의 stdout 섹션에서 실제 `type` 값을 확인해 맞춘다.

- [ ] **Step 6: 소요 시간을 기록한다**

로그의 `elapsedMs` 를 확인해 스펙 §4.1 의 타임아웃 재조정 근거로 남긴다.
sprite-gen 은 180초인데 우리는 600초로 두고 있다.

- [ ] **Step 7: 검증 결과를 커밋 메시지로 남긴다**

코드 변경이 없으면 커밋하지 않는다. Step 5 에서 이벤트 타입을 고쳤다면:

```bash
git add src/lib/image-backend/codex-exec.ts
git commit -m "fix(codex): inferStage 이벤트 타입을 실제 스트림에 맞춤

Task 5 검증에서 관측한 실제 --json 이벤트 타입으로 교정."
```

---

## Self-Review

**스펙 커버리지** (§4 대비):

| 스펙 항목 | 태스크 |
|---|---|
| §4.1 호출 인자 (`--json`·`--color never`·`--add-dir`) | Task 4 Step 2 |
| §4.1 env prefix 블랙리스트 | Task 4 Step 3 |
| §4.1 타임아웃 600초 유지 + 실측 | Global Constraints, Task 5 Step 6 |
| §4.2 프롬프트 헤더에서 파일 저장 지시 삭제 | Task 3 Step 1 |
| §4.3 session id 파싱 | Task 1 |
| §4.3 rollout 조회 + base64 디코딩 + PNG 검증 | Task 2 |
| §4.3 폴백 제거 | Task 4 Step 4 |
| §4.4 에러 처리 (session id 실패, rollout 없음, 결과 없음) | Task 1·2·4 |
| §4.5 검증 (probe, 실패 검출, img2img, 회귀) | Task 5 |

**스펙과 달라진 것 두 가지** — 스펙을 이 계획에 맞춰 고쳐야 한다:

1. **§4.1 "프롬프트를 positional 에서 stdin 으로"는 불필요하다.** 이미 stdin 이다
   (`codex-exec.ts:473-474`, `514`). 스펙이 현행 코드를 잘못 읽었다.
2. **§4 "inferStage 진행 추론은 그대로 두고"는 틀렸다.** `inferStage` 는 `generated_images` +
   `find`/`cp ` 문자열에 의존하므로 파일 저장 지시를 제거하면 함께 깨진다. Task 3 이 이를 다룬다.

**스펙에 없던 제약 하나** — `status` 판정 완화. 로컬 실측에서 `"generating"` 만 관측돼
sprite-gen 의 `status != "completed" → 에러` 를 그대로 쓰면 항상 실패한다. Task 1 에서
`result` 존재로 판정하도록 바꿨고 근거를 주석에 남겼다.

**타입 일관성**: `parseSessionId`·`collectInlineResults`·`isPng`·`extractStreamErrors`·
`resolveRolloutPath`·`recoverPngFromRollout` 의 이름과 시그니처가 Task 1·2 정의와 Task 4
사용처에서 일치한다. `inferStage` 반환 타입은 기존과 동일하게 유지해 호출부
(`codex-exec.ts:550`, `568`)를 고치지 않아도 된다.
