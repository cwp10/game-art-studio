import fs from "node:fs";
import { claudeRunSimple } from "@/lib/cli/claude-cli";
import { extractJsonArray } from "@/lib/util/json-parse";
import { imagePath } from "@/lib/util/paths";

/**
 * suggest 계열 라우트(suggest / sprite-suggest / reskin-suggest / layer-suggest)의
 * 공통 claude 호출 + JSON 배열 추출을 한 곳으로 모은 헬퍼.
 *
 * 의도적으로 작게 유지한다 — 입력 슬라이스 → claudeRunSimple → extractJsonArray 까지만.
 * 라우트별로 다른 부분(아이템 shape 필터, 502 에러 메시지, stripBg, 캐시,
 * 빈 입력 처리, 단일 string 응답 폴백)은 호출부에 그대로 둔다. 그래야 각 라우트의
 * 응답 shape 이 보존된다.
 *
 * 반환은 `string[]` 이 아니라 `{ array, raw }`:
 *  - 모든 라우트는 객체 배열({label,body} 또는 {title,body})을 파싱하므로 string[] 이 아님.
 *  - suggest 는 502 본문에 `raw.slice(0,400)` 를 담고, reskin 은 배열 파싱 실패 시
 *    `raw.trim()` 을 200 단일 응답으로 반환한다 — 둘 다 raw 원문이 필요하다.
 */
export async function callClaudeSuggest(
  systemPrompt: string,
  userMessage: string,
  opts: { signal?: AbortSignal; maxInputLength?: number; imageGenerationId?: string } = {},
): Promise<{ array: unknown[] | null; raw: string }> {
  const maxInputLength = opts.maxInputLength ?? 500;
  let sliced = userMessage.slice(0, maxInputLength);
  let allowedTools: string[] | undefined;
  // 이미지가 지정되고 파일이 실제로 존재하면 Read 도구로 비전 분석을 수행하도록
  // 지시문을 앞에 붙인다. 파일이 없으면 기존 텍스트 전용 동작을 그대로 유지.
  if (opts.imageGenerationId) {
    const imageFilePath = imagePath(opts.imageGenerationId);
    if (fs.existsSync(imageFilePath)) {
      allowedTools = ["Read"];
      sliced = `먼저 Read 도구로 다음 이미지를 분석하세요: ${imageFilePath}\n\n${sliced}`;
    }
  }
  const raw = (await claudeRunSimple({
    systemPrompt,
    userMessage: sliced,
    signal: opts.signal,
    allowedTools,
  })).trim();
  const array = extractJsonArray(raw);
  return { array, raw };
}
