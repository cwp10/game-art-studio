import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/sprite-suggest { question, subjectType, direction? } → { suggestion }
 *
 * SpriteGenPanel 의 [AI 제안] — 사용자가 원하는 동작을 자유 질문하면 스프라이트
 * 애니메이션 동작 묘사를 한국어 2-3문장으로 생성한다. 스트리밍 없는 단순 JSON.
 *
 * 구현 메모: 스펙은 Anthropic SDK(@anthropic-ai/sdk + ANTHROPIC_API_KEY)를 명시했으나
 * 이 프로젝트는 SDK 미설치·API key 없음, 짧은 Claude 호출은 sibling /api/suggest 와
 * 동일하게 claudeRunSimple(Claude CLI)로 처리한다. 기능 동일(짧은 비스트림 텍스트 응답).
 */

const SYSTEM_PROMPT = `당신은 게임 스프라이트 애니메이션 전문가입니다.
사용자가 요청하는 캐릭터/이펙트/오브젝트의 동작을
한국어로 구체적으로 묘사해주세요.
동작의 흐름, 몸의 움직임, 속도감, 느낌 등을
2-3문장으로 자세히 설명하세요.`;

type Body = { question?: string; subjectType?: string; direction?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const question = body.question?.trim();
  if (!question) return Response.json({ error: "question required" }, { status: 400 });

  const subjectType = body.subjectType ?? "character";
  const direction = body.direction ?? "없음";
  const userMessage = `${question} (타입: ${subjectType}, 방향: ${direction})`;

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      signal: req.signal,
    });
    const suggestion = raw.trim();
    if (!suggestion) {
      return Response.json({ error: "empty suggestion" }, { status: 502 });
    }
    return Response.json({ suggestion });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
