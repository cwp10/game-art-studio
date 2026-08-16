/**
 * codex rollout 파싱 단위 테스트 — codex 미사용 순수 함수.
 *
 *   pnpm tsx scripts/test-codex-rollout.ts
 *
 * 실제 ~/.codex/sessions 레코드 형태(2026-08-16 실측)를 고정 문자열로 재현해
 * session id 추출 · inline base64 수집 · PNG 매직 검증 · 에러 추출을 단언한다.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectInlineResults,
  extractStreamErrors,
  isPng,
  parseSessionId,
  recoverPngFromRollout,
  resolveRolloutPath,
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
  "", // 빈 줄
  "{ not json", // 깨진 줄 — 건너뛰어야 한다
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

check(
  "result 없는 레코드는 무시",
  collectInlineResults(`{"payload":{"type":"image_generation_end","status":"generating"}}`)
    .results.length === 0,
);

check("빈 입력은 빈 결과", collectInlineResults("").results.length === 0);

// ── isPng ─────────────────────────────────────────────────────────
check("PNG 매직 통과", isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])));
check("JPEG 매직 거부", !isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
check("8바이트 미만 거부", !isPng(Buffer.from([0x89, 0x50])));
check("빈 버퍼 거부", !isPng(Buffer.alloc(0)));

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
check(
  "정상 스트림은 빈 배열",
  extractStreamErrors(`{"type":"thread.started","thread_id":"${SID}"}`).length === 0,
);

// ── resolveRolloutPath / recoverPngFromRollout ────────────────────
// 파일 IO 가 필요한 구간. package.json 에 type:module 이 없어 top-level await 를
// 쓸 수 없으므로 async IIFE 안에서 실행하고 집계도 여기서 낸다.
void (async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "codex-rollout-test-"));
  const sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(join(sessionsDir, "2026", "08", "16"), { recursive: true });

  // 1×1 투명 PNG 의 base64 (실제 PNG 매직으로 시작한다)
  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  const rolloutPath = join(
    sessionsDir,
    "2026",
    "08",
    "16",
    `rollout-2026-08-16T00-00-00-${SID}.jsonl`,
  );
  writeFileSync(
    rolloutPath,
    [
      `{"payload":{"type":"session_meta","id":"${SID}"}}`,
      `{"payload":{"type":"image_generation_call","id":"c1","result":"${TINY_PNG_B64}","status":"generating"}}`,
      `{"payload":{"type":"image_generation_end","call_id":"c1","result":"${TINY_PNG_B64}","status":"generating"}}`,
    ].join("\n"),
  );

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
