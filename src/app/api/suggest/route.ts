import { NextRequest } from "next/server";
import { callClaudeSuggest } from "@/lib/util/claude-suggest";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/suggest { input } → { suggestions: [{label, body}, ...] }
 *
 * 짧은 입력의 맥락을 유추해 서로 다른 3-4개 컨셉 (label + body) 제안. 본문에는
 * 스타일/방향/첨부 포함 X — 사용자가 picker 로 별도 결합.
 *
 * 캐싱: in-memory Map (input trim → suggestions). TTL 24h. 같은 input 반복 시 즉시
 * 응답. dev HMR 시 globalThis 로 cache 유지.
 */

// 단축 system prompt — 1차 ~1KB → ~250자. 응답 토큰 절감 + 빠름.
// 배경(배경/background)은 절대 포함하지 않음 — 서버가 자동으로 투명 배경을 적용함.
const SYSTEM_PROMPT = `이미지가 제공된 경우 Read 도구로 이미지를 직접 분석해 제안에 반영하세요.
한국어 게임 에셋 prompt 제안. JSON 배열만 출력.
[{"label":"<8-15자 한글 제목>","body":"<60-120자 한글 prompt — 주제/주요 시각요소/색감 포함. 스타일·방향·참조·배경은 절대 포함하지 말 것.>"}, ...]
3-4개. 각 컨셉은 mood·theme 다르게. 예 캐릭터 코스튬:
[{"label":"신비한 의식용 코스튬","body":"의상 영웅 신비한 의식용 코스튬, 긴 로브와 장식용 천이 겹겹이 내려오는 성스러운 복장, 빛나는 룬, 보라·금색"},{"label":"모험가 여행 코스튬","body":"의상 모험가 여행 코스튬, 가벼운 재킷과 바지, 주머니·벨트, 낡은 천, 올리브·베이지"}]`;

type Suggestion = { label: string; body: string };

// dev HMR 시 모듈 재평가되어도 cache 유지.
declare global {
  var __suggest_cache: Map<string, { ts: number; suggestions: Suggestion[] }> | undefined;
}
const cache = (globalThis.__suggest_cache ??= new Map());
const TTL_MS = 24 * 60 * 60 * 1000;

type Body = { input?: string; generationId?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const input = body.input?.trim().slice(0, 500);
  if (!input) return Response.json({ error: "input required" }, { status: 400 });

  // 캐시 적중 — 같은 input + TTL 내 → 즉시 응답.
  // 기존 캐시에 배경 키워드가 남아있을 수 있으니 stripBg 로 보정.
  // 첨부 이미지가 있으면 캐시를 건너뛴다 — 같은 텍스트라도 이미지에 따라 제안이 달라져야 함.
  const cached = cache.get(input);
  if (cached && !body.generationId && Date.now() - cached.ts < TTL_MS) {
    const fixed = cached.suggestions.map((s: Suggestion) => ({ label: s.label, body: stripBg(s.body) }));
    return Response.json({ suggestions: fixed, cached: true });
  }

  try {
    const { array: parsed, raw } = await callClaudeSuggest(SYSTEM_PROMPT, input, {
      signal: req.signal,
      imageGenerationId: body.generationId,
    });
    if (!parsed) {
      return Response.json({ error: "claude returned non-array", raw: raw.slice(0, 400) }, { status: 502 });
    }
    const cleaned: Suggestion[] = parsed
      .filter((x): x is Suggestion =>
        !!x && typeof x === "object" && typeof (x as Suggestion).label === "string" && typeof (x as Suggestion).body === "string",
      )
      .map(s => ({ label: s.label.trim(), body: stripBg(s.body.trim()) }))
      .filter(s => s.label && s.body);
    if (cleaned.length === 0) {
      return Response.json({ error: "no valid suggestions", raw: raw.slice(0, 400) }, { status: 502 });
    }
    // 이미지 첨부 결과는 캐시에 쓰지 않는다 — bare input 키로 저장되면 이후 텍스트 전용
    // 요청이 이미지 맥락 제안을 잘못 받게 된다(캐시 오염 방지).
    if (!body.generationId) cache.set(input, { ts: Date.now(), suggestions: cleaned });
    return Response.json({ suggestions: cleaned });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * 제안 프롬프트에서 배경 관련 구절을 제거.
 * 서버(ensureTransparentDefault)가 자동으로 transparent background 를 적용하므로
 * 제안 카드에는 배경 지시가 없어야 깔끔하다.
 * 패턴: ", 투명 배경" / ", 흰 배경" / "transparent background" 등 — 쉼표·공백 포함 제거.
 */
function stripBg(body: string): string {
  return body
    .replace(/,?\s*(투명|흰|하얀)\s*배경/g, "")
    .replace(/,?\s*(transparent|white)\s*background/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

