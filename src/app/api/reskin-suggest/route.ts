import { NextRequest } from "next/server";
import { callClaudeSuggest } from "@/lib/util/claude-suggest";

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

[외형 교체 동작 방식]
- 원본의 포즈·실루엣·구도를 유지하면서 색·재질·테마를 교체
- 스프라이트시트인 경우 모든 프레임에 일관된 외형 적용

사용자의 요청에 어울리는 스킨 아이디어 5가지를 제안하세요.

출력 형식: 아래 JSON 배열만 출력. 다른 텍스트·마크다운·설명 절대 없이.
[{"title":"테마 이름","body":"색상·재질·장비 등 핵심 특징 묘사"}]

규칙:
- title: 짧은 테마 이름 (이모지 1개 포함 권장)
- body: 2~3가지 시각 특징을 쉼표로 나열, 1~2줄, 한국어
- 기술 용어·파라미터 언급 금지
- 반드시 유효한 JSON 배열 5개 항목만 출력`,

  b: `당신은 게임 스프라이트 색 교체 전문가입니다.

[색만 변경 동작 방식]
- AI 변경: img2img로 색 팔레트만 교체, 형태는 최대한 유지
- 스프라이트시트인 경우 모든 프레임의 색이 균일하게 바뀜

사용자의 요청에 어울리는 색 팔레트 교체 아이디어 4가지를 제안하세요.

출력 형식: 아래 JSON 배열만 출력. 다른 텍스트·마크다운·설명 절대 없이.
[{"title":"팔레트 이름","body":"색 교체 묘사"}]

규칙:
- title: 짧은 색 테마명 (이모지 1개 포함 권장)
- body: "원래색→바꿀색" 식의 구체적 묘사, 쉼표로 나열, 1~2줄, 한국어
- 색 테마명 표현 가능 (예: 불꽃 계열→얼음 계열)
- 기술 용어·파라미터 언급 금지
- 반드시 유효한 JSON 배열 4개 항목만 출력`,

  c: `당신은 게임 스프라이트 스타일 전이 전문가입니다.

[참조 전이 동작 방식]
- 일반 참조 전이: 원본에 참조 이미지의 화풍·색감·분위기를 입힘
- 캐릭터 오버레이(시트+참조): 베이스 시트의 모든 프레임 포즈에 참조 캐릭터의 외형을 입힘

"추가 지시"는 참조 전이 후 세밀한 보정 방향을 지정하는 문구입니다.
사용자의 요청에 맞는 추가 지시 아이디어 4가지를 제안하세요.

출력 형식: 아래 JSON 배열만 출력. 다른 텍스트·마크다운·설명 절대 없이.
[{"title":"보정 방향","body":"구체적 지시 문구"}]

규칙:
- title: 짧은 방향명 이모지 1개 포함 권장 (1~3단어)
- body: 실제 추가 지시 문구 (1줄, 한국어)
- 전이 강도·색감 보정·분위기 조절·디테일 강화 등 다양한 방향으로 제안
- 기술 용어·파라미터 언급 금지
- 반드시 유효한 JSON 배열 4개 항목만 출력`,
};

type Body = {
  mode?: "a" | "b" | "c";
  question?: string;
  isSheet?: boolean;
  isOverlay?: boolean;
};

export type SkinSuggestion = { title: string; body: string };

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
    // question 은 위에서 이미 500 자로 슬라이스했고 userMessage 는 시스템 컨텍스트를
    // 덧붙인 합성 메시지라 util 단계에서 추가 절단하지 않는다.
    const { array: parsed, raw: suggestion } = await callClaudeSuggest(systemPrompt, userMessage, {
      signal: req.signal,
      maxInputLength: Infinity,
    });
    if (!suggestion) {
      return Response.json({ error: "empty suggestion" }, { status: 502 });
    }

    // mode "a"/"b"/"c": JSON 배열 파싱 시도 → 구조화된 제안 목록 반환
    if (parsed) {
      const suggestions = parsed.filter(
        (x): x is SkinSuggestion =>
          typeof x === "object" && x !== null &&
          typeof (x as SkinSuggestion).title === "string" &&
          typeof (x as SkinSuggestion).body === "string",
      );
      if (suggestions.length > 0) return Response.json({ suggestions });
    }

    return Response.json({ suggestion });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
