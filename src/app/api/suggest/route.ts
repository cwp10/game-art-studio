import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/suggest { input } → { suggestions: [{label, body}, ...] }
 *
 * 사용자가 입력한 짧은 의도 ("코스튬 그려줘") 의 맥락을 유추해 서로 다른 3-4개 컨셉을
 * 제안. 각 컨셉은 짧은 한국어 라벨 + 풍부한 한국어 본문 (한 줄 prompt).
 *
 * 본문은 그 자체로 이미지 생성에 쓰일 수 있도록 구체적이고 풍부. 스타일/방향/첨부는
 * 사용자가 카드 선택 후 Composer 의 picker 들로 별도 결합 — 본문에는 포함하지 않음.
 */

const SYSTEM_PROMPT = `You generate Korean game asset image prompt suggestions.

The user gives a short Korean intent (often vague). Infer the context and propose
3-4 distinct concept directions. Respond with ONLY a JSON array of objects, each:
  { "label": "<짧은 한국어 제목, 8-15자>", "body": "<풍부한 한국어 본문 prompt, 60-120자>" }

Guidelines for body:
- Concrete and self-contained, single line.
- Include: subject specifics, signature visual elements, color palette, background.
- DO NOT include style (pixel art / watercolor / cel shading 등) — user picks separately.
- DO NOT include camera direction (정면/측면 등) — user picks separately.
- DO NOT include attachment / reference notes — user attaches separately.

Each suggestion should explore a DIFFERENT angle / mood / theme.

Example for input "캐릭터 코스튬 그려줘":
[
  {"label":"신비한 의식용 코스튬","body":"의상 영웅 신비한 의식용 코스튬, 긴 로브와 장식용 천이 겹겹이 내려오는 성스러운 복장, 목걸이와 팔찌에 빛나는 룬 장식, 보라색과 금색, 흰 배경"},
  {"label":"모험가 여행 코스튬","body":"의상 일반 모험가 여행 코스튬, 움직이기 편한 가벼운 재킷과 바지로 구성된 실용적인 복장, 주머니와 벨트가 많고 낡은 천 질감, 올리브색과 베이지색, 흰 배경"}
]

Output ONLY the JSON array — no prose, no markdown fences.`;

type Body = { input?: string };
type Suggestion = { label: string; body: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const input = body.input?.trim();
  if (!input) return Response.json({ error: "input required" }, { status: 400 });

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: input,
      signal: req.signal,
    });
    const parsed = extractJsonArray(raw);
    if (!parsed) {
      return Response.json({ error: "claude returned non-array", raw: raw.slice(0, 400) }, { status: 502 });
    }
    const cleaned: Suggestion[] = parsed
      .filter((x): x is Suggestion =>
        !!x && typeof x === "object" && typeof (x as Suggestion).label === "string" && typeof (x as Suggestion).body === "string",
      )
      .map(s => ({ label: s.label.trim(), body: s.body.trim() }))
      .filter(s => s.label && s.body);
    if (cleaned.length === 0) {
      return Response.json({ error: "no valid suggestions", raw: raw.slice(0, 400) }, { status: 502 });
    }
    return Response.json({ suggestions: cleaned });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
