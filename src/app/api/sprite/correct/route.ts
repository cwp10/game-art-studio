import { NextRequest } from "next/server";

import { getGeneration } from "@/lib/db/repo/generations";

/**
 * 교정 재생성 **메시지**를 만든다. 생성 자체는 하지 않는다.
 *
 * 왜 메시지만 만드는가: 재생성은 기존 채팅 경로(오케스트레이터 → MCP →
 * plan-driven)를 그대로 타야 한다. 여기서 codex 를 따로 부르면 같은 일을 하는
 * 두 번째 경로가 생기고, 둘이 갈리는 순간 어느 쪽이 진짜인지 알 수 없게 된다.
 *
 * 마커 조립을 서버가 맡는 이유는 재료가 서버에만 있기 때문이다 — base generation
 * id 는 아틀라스의 `input_image_ids` 에, 격자·루프는 `params` 에 있다. UI 가
 * 마커 형식을 알 필요는 없다.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { atlasGenerationId?: string };
  const atlasId = body.atlasGenerationId;
  if (!atlasId) {
    return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });
  }
  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });

  const params = atlas.params as Record<string, unknown> | undefined;
  if (!params?.planDriven) {
    return Response.json(
      { error: "플랜 구동 시트가 아닙니다 — 교정 재생성은 component-row 엔진 산출물에만 적용됩니다" },
      { status: 400 },
    );
  }
  const inspect = params.inspect as { ok: boolean; hints: string[] } | null | undefined;
  if (!inspect || inspect.hints.length === 0) {
    return Response.json(
      { error: "이 시트에는 교정 힌트가 없습니다 — 자동 검사를 통과했거나 검사 이전 산출물입니다" },
      { status: 400 },
    );
  }

  const baseId = atlas.input_image_ids?.[0];
  if (!baseId) {
    return Response.json(
      { error: "이 시트의 base generation 을 찾을 수 없습니다 — 참조 없이 만들어진 시트입니다" },
      { status: 400 },
    );
  }

  const rows = Number(params.rows ?? 0) || 1;
  const cols = Number(params.cols ?? 0) || 1;
  const request = params.request as
    | { states?: Record<string, { action?: string; loop?: boolean }> }
    | undefined;
  const firstState = Object.values(request?.states ?? {})[0];
  const action = firstState?.action ?? (atlas.prompt || "동작");
  const loop = firstState?.loop === true;

  // 패널이 쓰는 것과 같은 지시문 형식. `[correct: id]` 만 추가된다.
  //
  // `[reference: ...]` 는 여기서 넣지 않는다 — 마커의 단일 소유자는 `/api/chat` 이고,
  // 그쪽이 `attachmentGenerationIds` 마다 마커를 붙인다. 양쪽이 다 넣으면 같은 참조가
  // 본문에 두 번 남아 재로드 시 첨부 칩이 중복 key 로 렌더된다(실제로 그랬다).
  const message =
    `[spritesheet: subjectType=character; anchorStrategy=feet; rows=${rows}; cols=${cols}; ` +
    `directions=1; facing=REF; seamlessLoop=${loop}]\n` +
    `[correct: ${atlasId}]\n` +
    action;

  return Response.json({
    ok: true,
    message,
    attachmentGenerationIds: [baseId],
    hintCount: inspect.hints.length,
  });
}
