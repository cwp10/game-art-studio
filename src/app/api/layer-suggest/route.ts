import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 120;

const SYSTEM_PROMPT = `당신은 게임 스프라이트 레이어 분리 전문가입니다.
이미지에서 분리할 부위 세트 아이디어 4가지를 제안하세요.

출력 형식: 아래 JSON 배열만 출력. 다른 텍스트·마크다운·설명 절대 없이.
[{"title":"세트 이름","body":"부위1, 부위2, 부위3"}]

규칙:
- title: 짧은 세트 이름 (이모지 1개 포함 권장)
- body: 한국어 부위 이름, 쉼표로 구분, 3~8개 이내
- 캐릭터: 머리/얼굴/몸통/팔/다리/무기/방패 등 게임 스프라이트 용어
- 각 세트는 서로 다른 세분화 수준이나 목적을 가져야 함
- 반드시 유효한 JSON 배열 4개 항목만 출력`;

type Suggestion = { title: string; body: string };

export async function POST(req: NextRequest) {
  let question = "게임 캐릭터 스프라이트의 부위를 제안해주세요";
  try {
    const body = (await req.json()) as { question?: string };
    if (body.question?.trim()) question = body.question.trim().slice(0, 300);
  } catch { /* 빈 body 허용 */ }

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `요청: ${question}`,
      signal: req.signal,
    });
    const text = raw.trim();
    if (!text) return Response.json({ error: "empty suggestion" }, { status: 502 });

    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as unknown[];
        const suggestions = parsed.filter(
          (x): x is Suggestion =>
            typeof x === "object" && x !== null &&
            typeof (x as Suggestion).title === "string" &&
            typeof (x as Suggestion).body === "string",
        );
        if (suggestions.length > 0) return Response.json({ suggestions });
      } catch { /* fall through */ }
    }
    return Response.json({ error: "응답 파싱 실패" }, { status: 502 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
