import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";
import { getGeneration } from "@/lib/db/repo/generations";
import { extractJsonArray } from "@/lib/util/json-parse";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/layer-parts { generationId } → { parts: string[] }
 *
 * 레이어 분리용 "분리 가능한 부위" 라벨 제안. 이미지 vision 불가(구독 CLI) — generation 의
 * 생성 prompt 텍스트만 보고 Claude 가 부위 라벨 4-6개를 추론한다. 자동 마스킹 아님 —
 * 사용자는 여전히 수동 페인팅, AI 는 라벨 이름만 제안.
 *
 * 캐싱: in-memory Map (generationId → parts). TTL 24h. dev HMR 시 globalThis 로 유지.
 * prompt 가 없거나 빈 generation 이면 generic fallback parts 반환.
 */

const SYSTEM_PROMPT = `게임 캐릭터 설명을 받아 레이어 분리에 쓸 '분리 가능한 부위' 4-6개를 짧은 한글 라벨(2-6자)로. JSON 문자열 배열만 출력. 예 ["머리","얼굴","로브","지팡이","손"]`;

const FALLBACK_PARTS = ["머리", "얼굴", "몸통", "팔", "다리"];

// dev HMR 시 모듈 재평가되어도 cache 유지.
declare global {
  var __layer_parts_cache: Map<string, { ts: number; parts: string[] }> | undefined;
}
const cache = (globalThis.__layer_parts_cache ??= new Map());
const TTL_MS = 24 * 60 * 60 * 1000;

type Body = { generationId?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const generationId = body.generationId?.trim();
  if (!generationId) return Response.json({ error: "generationId required" }, { status: 400 });

  // 캐시 적중 — 같은 generationId + TTL 내 → 즉시 응답.
  const cached = cache.get(generationId);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return Response.json({ parts: cached.parts, cached: true });
  }

  const prompt = getGeneration(generationId)?.prompt?.trim();
  // prompt 없거나 빈 generation (업로드/마스크 등) → generic fallback.
  if (!prompt) return Response.json({ parts: FALLBACK_PARTS, fallback: true });

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: prompt,
      signal: req.signal,
    });
    const parsed = extractJsonArray(raw);
    const cleaned = parsed
      ? parsed.filter((x): x is string => typeof x === "string").map(s => s.trim()).filter(Boolean)
      : [];
    // 파싱 실패 / 빈 결과 → fallback (UI graceful).
    const parts = cleaned.length > 0 ? cleaned : FALLBACK_PARTS;
    if (cleaned.length > 0) cache.set(generationId, { ts: Date.now(), parts });
    return Response.json({ parts, ...(cleaned.length === 0 ? { fallback: true } : {}) });
  } catch (e) {
    // claude CLI 오류여도 UI 는 fallback 라벨로 진행.
    return Response.json({ parts: FALLBACK_PARTS, fallback: true, error: (e as Error).message });
  }
}

