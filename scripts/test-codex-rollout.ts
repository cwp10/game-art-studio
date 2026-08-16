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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
