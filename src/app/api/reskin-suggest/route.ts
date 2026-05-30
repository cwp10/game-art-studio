import { NextRequest } from "next/server";
import { claudeRunSimple } from "@/lib/cli/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/reskin-suggest { mode, question, isSheet, isOverlay? } → { suggestion }
 *
 * ReskinPanel 의 [AI 제안] — 모드별 컨텍스트를 반영해 입력 텍스트 초안을 생성한다.
 * - mode a (외형 교체): 포즈 유지 + 색·재질·테마 교체 묘사
 * - mode b (색만 변경): 색 매핑 묘사 (빨강→파랑 식)
 * - mode c (참조 전이 / 캐릭터 오버레이): 추가 지시 초안
 */

const SYSTEM_PROMPTS: Record<"a" | "b" | "c", string> = {
  a: `당신은 게임 스프라이트 리스킨 전문가입니다.
사용자의 요청을 "외형 교체" 입력 텍스트로 변환해주세요.

[외형 교체 동작 방식]
- Claude → reskin_image 도구(img2img): 원본의 포즈·실루엣·구도를 유지하면서 색·재질·테마를 교체
- 스프라이트시트인 경우 모든 프레임에 일관된 외형이 적용됨
- 투명 배경은 자동 유지

출력 규칙:
- 새 스킨의 시각적 특징을 구체적으로: 색상, 재질, 무기, 장비 등
- 2~3가지 핵심 특징을 쉼표로 나열하는 간결한 묘사 (1~2줄)
- 기술 용어·파라미터 절대 언급 금지, 한국어 중심`,

  b: `당신은 게임 스프라이트 색 교체 전문가입니다.
사용자의 요청을 "색만 변경" 입력 텍스트로 변환해주세요.

[색만 변경 동작 방식]
- AI 변경: img2img로 색 팔레트만 교체, 형태는 최대한 유지
- 정밀(픽셀): sharp로 픽셀 직접 색교체, 형태 100% 보존
- 스프라이트시트인 경우 모든 프레임의 색이 균일하게 바뀜

출력 규칙:
- "원래색→바꿀색" 식의 구체적인 색 대응 묘사
- 여러 색을 바꿀 경우 쉼표로 나열 (예: 빨강→파랑, 금장식은 은색으로)
- 색 테마가 있으면 테마명으로도 표현 가능 (예: 불꽃 계열→얼음 계열)
- 1~2줄 이내, 기술 용어 금지, 한국어 중심`,

  c: `당신은 게임 스프라이트 스타일 전이 전문가입니다.
사용자의 요청을 "참조 전이" 추가 지시 텍스트로 변환해주세요.

[참조 전이 동작 방식]
- 일반 참조 전이: 원본에 참조 이미지의 화풍·색감·분위기를 입힘
- 캐릭터 오버레이(시트+참조): 베이스 시트의 모든 프레임 포즈에 참조 캐릭터의 외형을 입힘

추가 지시는 메인 전이 외에 세밀한 보정 방향을 지정하는 짧은 문구입니다.

출력 규칙:
- 전이 강도, 분위기 조절, 색감 보정 등 세부 방향 1~2가지
- 짧고 명확하게 (1줄 이내)
- 기술 용어 금지, 한국어 중심
- 없어도 되는 선택 필드이므로 단순·간결하게`,
};

type Body = {
  mode?: "a" | "b" | "c";
  question?: string;
  isSheet?: boolean;
  isOverlay?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const mode = body.mode ?? "a";
  const question = body.question?.trim().slice(0, 500) || "적합한 내용을 제안해주세요";
  const isSheet = body.isSheet ?? false;
  const isOverlay = body.isOverlay ?? false;

  const systemPrompt = SYSTEM_PROMPTS[mode];
  const userMessage = [
    `요청: ${question}`,
    isSheet && mode !== "b" ? "대상: 스프라이트시트 (모든 프레임에 일관 적용)" : "",
    isOverlay ? "모드: 캐릭터 오버레이 (베이스 시트 포즈 유지, 캐릭터 외형 전이)" : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await claudeRunSimple({
      systemPrompt,
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
