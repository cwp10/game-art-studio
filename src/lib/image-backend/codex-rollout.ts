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
