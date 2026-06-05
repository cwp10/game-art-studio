import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";
import { extractJsonArray } from "@/lib/util/json-parse";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/sprite-suggest { question, subjectType, direction?, frames, seamlessLoop } → { suggestion }
 *
 * SpriteGenPanel 의 [AI 제안] — 사용자가 원하는 동작을 자유 질문하면 스프라이트
 * 애니메이션 동작 묘사를 한국어 2-3문장으로 생성한다. 스트리밍 없는 단순 JSON.
 */

const SYSTEM_PROMPT = `당신은 게임 스프라이트 애니메이션 전문가입니다.
사용자가 요청하는 동작을 이미지 생성 AI(GPT-image)에 전달할 동작 묘사 텍스트로 작성해주세요.

[프로젝트 시트 구조 — 반드시 고려]
- 모든 시트는 게임표준 그리드(짝수 장축): 6프레임=2×3, 8=2×4, 12=4×3, 16=4×4
- 캐릭터: anchorStrategy=feet (발이 기준선에 고정, 머리 위치 변동 가능)
- 이펙트·오브젝트: anchorStrategy=center (중앙 고정)
- 배경: 투명(transparent background) 고정
- seamlessLoop=true 일 때: 마지막 프레임이 자연스럽게 첫 프레임으로 이어지는 동작만 제안

[프레임 수 → 동작 복잡도 가이드]
- 6프레임(2×3): 간단한 1사이클 동작 (단순 공격, 빠른 이펙트)
- 8프레임(2×4): 기본 보행·공격 사이클 — 게임 표준
- 12프레임(4×3): 복잡한 콤보·긴 모션 (달리기→슬라이딩 등)
- 16프레임(4×4): 시네마틱 수준 복합 모션

[피사체별 묘사 규칙]
- character: 발 기준 고정. 방향(facing)에 따른 몸 전환, 팔·다리 움직임 중심으로 묘사
- effect: 파티클 확산·소멸 방향, 색상 변화, 빛 번짐 흐름 중심으로 묘사
- object: Y축·Z축 회전, 반짝임, 뚜껑 열림 등 오브젝트 고유 물리 묘사

출력 형식: 아래 JSON 배열만 출력. 다른 텍스트·마크다운·설명 절대 없이.
[{"title":"동작 이름","body":"동작 묘사 2~3문장"}]

규칙:
- title: 짧은 동작명 (이모지 1개 권장, 1~3단어)
- body: 동작 흐름·몸 움직임·속도감·포즈 전환을 구체적으로 묘사, 2~3문장 산문체, 한국어
- 프레임 수·rows·cols 같은 기술 파라미터는 언급 금지
- 서로 다른 난이도·리듬·스타일의 아이디어 4가지 제안
- 반드시 유효한 JSON 배열 4개 항목만 출력`;

type Suggestion = { title: string; body: string };

type Body = {
  question?: string;
  subjectType?: string;
  /** effect 탭일 때 어떤 컨텍스트(character|object)의 이펙트인지. */
  contextType?: string;
  /** 참조 이미지의 생성 프롬프트 — 이펙트 탭에서 캐릭터/오브젝트 특성 추론에 사용. */
  referencePrompt?: string;
  direction?: string;
  frames?: number;
  seamlessLoop?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const question = body.question?.trim().slice(0, 500);
  if (!question) return Response.json({ error: "question required" }, { status: 400 });

  const subjectType = body.subjectType ?? "character";
  const contextType = body.contextType; // "character" | "object" — effect 탭일 때만 전달됨
  const referencePrompt = body.referencePrompt?.trim().slice(0, 300);
  const direction = body.direction ?? "없음";
  const frames = body.frames ?? 8;
  const seamlessLoop = body.seamlessLoop ?? true;

  const frameGuide: Record<number, string> = {
    6: "2×3 (간단한 1사이클)",
    8: "2×4 (기본 게임표준 사이클)",
    12: "4×3 (복잡한 복합 모션)",
    16: "4×4 (시네마틱 수준)",
  };

  const contextHint =
    subjectType === "effect" && contextType
      ? contextType === "character"
        ? "캐릭터에 어울리는 이펙트 (공격·마법·힐·방어 계열 고려)"
        : "오브젝트에 어울리는 이펙트 (획득·파괴·상호작용 계열 고려)"
      : "";

  // referencePrompt 로 캐릭터/오브젝트의 구체적 특성 추론
  const referenceHint =
    subjectType === "effect" && referencePrompt
      ? `참조 ${contextType === "object" ? "오브젝트" : "캐릭터"} 설명: ${referencePrompt}`
      : "";

  const userMessage = [
    `요청: ${question}`,
    `타입: ${subjectType}`,
    contextHint,
    referenceHint,
    subjectType === "character" ? `방향: ${direction}` : "",
    `그리드: ${frames}프레임 ${frameGuide[frames] ?? ""}`,
    `seamlessLoop: ${seamlessLoop ? "켜짐 (첫·끝 프레임이 자연스럽게 이어져야 함)" : "꺼짐"}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      signal: req.signal,
    });
    const text = raw.trim();
    if (!text) return Response.json({ error: "empty suggestion" }, { status: 502 });

    const parsed = extractJsonArray(text);
    if (parsed) {
      const suggestions = parsed.filter(
        (x): x is Suggestion =>
          typeof x === "object" && x !== null &&
          typeof (x as Suggestion).title === "string" &&
          typeof (x as Suggestion).body === "string",
      );
      if (suggestions.length > 0) return Response.json({ suggestions });
    }
    return Response.json({ error: "응답 파싱 실패" }, { status: 502 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
