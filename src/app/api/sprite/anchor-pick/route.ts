import { NextRequest } from "next/server";
import {
  clearAnchorPick,
  getAnchorPicks,
  getGeneration,
  getLockedBase,
  lockBaseGeneration,
  pinAnchorFrame,
} from "@/lib/db/repo/generations";

export const runtime = "nodejs";

/**
 * POST /api/sprite/anchor-pick — 방향 앵커 프레임 지정(핀).
 *
 * 지정이 없으면 앵커는 그 방향 앵커 행(`<dir>_idle`)의 **큐레이션 시퀀스 첫 인스턴스**다
 * (index 0 이 아니다). 지정은 그 기본값을 이긴다 — 가장 좋은 facing 포즈가 늘 idle
 * 시퀀스 안에 있지는 않기 때문에, 같은 방향이면 다른 행의 프레임도 지정할 수 있다.
 *
 * 사라진 프레임을 가리키는 지정은 생성 시 **fail-loud** 다(조용한 기본값 복귀 금지).
 *
 * body: { atlasGenerationId, direction, state, index }  — 지정
 *       { atlasGenerationId, direction, clear: true }   — 해제
 * 응답: { ok: true, picks: { <direction>: { generationId, index } } }
 */

type Body = {
  atlasGenerationId?: string;
  direction?: string;
  state?: string;
  index?: number;
  clear?: boolean;
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const { atlasGenerationId: atlasId, direction } = body;
  if (!atlasId || !direction) {
    return Response.json({ error: "atlasGenerationId 와 direction 이 필요합니다" }, { status: 400 });
  }
  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });
  const sessionId = atlas.session_id;

  if (body.clear) {
    clearAnchorPick(sessionId, direction);
    return Response.json({ ok: true, picks: getAnchorPicks(sessionId) });
  }

  const rowIds = atlas.params?.rowGenerationIds as Record<string, string> | undefined;
  if (!rowIds || !body.state || !rowIds[body.state]) {
    return Response.json({ error: `상태 '${body.state}' 의 행 generation 을 찾을 수 없습니다` }, { status: 400 });
  }
  if (typeof body.index !== "number" || body.index < 0) {
    return Response.json({ error: "index 가 필요합니다" }, { status: 400 });
  }

  // 지정은 잠긴 base 에 얹힌다(스코프당 1장). 잠금이 풀려 있으면 아틀라스가 아는
  // 자기 base 로 다시 잠근다 — 사용자가 핀을 누를 때 무관한 상태 때문에 실패하면 안 된다.
  if (!getLockedBase(sessionId)) {
    const baseId = atlas.input_image_ids?.[0];
    if (!baseId || !getGeneration(baseId)) {
      return Response.json(
        { error: "이 시트의 base generation 을 찾을 수 없어 앵커를 지정할 수 없습니다" },
        { status: 400 },
      );
    }
    lockBaseGeneration(baseId, sessionId);
  }

  try {
    pinAnchorFrame(sessionId, direction, { generationId: rowIds[body.state], index: body.index });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true, picks: getAnchorPicks(sessionId) });
}

/** GET /api/sprite/anchor-pick?atlasGenerationId=... — 현재 지정 조회. */
export async function GET(req: NextRequest) {
  const atlasId = req.nextUrl.searchParams.get("atlasGenerationId");
  if (!atlasId) return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });
  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });
  return Response.json({ ok: true, picks: getAnchorPicks(atlas.session_id) });
}
