import { NextRequest } from "next/server";
import {
  getCuration,
  getGeneration,
  saveCuration,
} from "@/lib/db/repo/generations";

export const runtime = "nodejs";

/**
 * POST /api/sprite/curation — 플랜 구동 시트의 큐레이션(재생 시퀀스) 영속.
 *
 * 정본 `curation.json` 은 **비파괴 사이드카**다 — 원본 프레임 PNG 를 절대 고치지 않고
 * 사람의 선택만 기록한다. `selected` 가 권위 필드이고(재생 순서의 0-based 인덱스),
 * `order` 는 표시 전용이라 해석이 무시한다.
 *
 * 저장 위치는 **상태별 행 generation** 이다(아틀라스가 아니라). 앵커 해석
 * (`resolveAnchor`)이 그 행의 큐레이션 시퀀스 첫 인스턴스를 앵커로 삼기 때문이다 —
 * index 0 이 아니다. 사용자가 앞 프레임을 제외하면 앵커가 따라 움직여야 한다.
 *
 * body: { atlasGenerationId, curationByState: { <state>: { selected: number[], order?: number[] } } }
 * 응답: { ok: true, saved: { <state>: { selected, order? } } }
 */

type Body = {
  atlasGenerationId?: string;
  curationByState?: Record<string, { selected?: number[]; order?: number[] }>;
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const atlasId = body.atlasGenerationId;
  if (!atlasId) return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });

  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });

  const rowIds = atlas.params?.rowGenerationIds as Record<string, string> | undefined;
  if (!rowIds) {
    return Response.json(
      { error: "플랜 구동 시트가 아닙니다 (rowGenerationIds 없음)" },
      { status: 400 },
    );
  }

  const saved: Record<string, { selected: number[]; order?: number[] }> = {};
  for (const [state, curation] of Object.entries(body.curationByState ?? {})) {
    const rowId = rowIds[state];
    if (!rowId) continue;
    const selected = Array.isArray(curation.selected) ? curation.selected : [];
    const order = Array.isArray(curation.order) ? curation.order : undefined;
    saveCuration(rowId, { selected, ...(order ? { order } : {}) });
    saved[state] = getCuration(rowId) ?? { selected };
  }

  return Response.json({ ok: true, saved });
}

/** GET /api/sprite/curation?atlasGenerationId=... — 상태별 저장된 큐레이션 조회. */
export async function GET(req: NextRequest) {
  const atlasId = req.nextUrl.searchParams.get("atlasGenerationId");
  if (!atlasId) return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });
  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });
  const rowIds = (atlas.params?.rowGenerationIds as Record<string, string> | undefined) ?? {};
  const out: Record<string, { selected: number[]; order?: number[] } | null> = {};
  for (const [state, rowId] of Object.entries(rowIds)) out[state] = getCuration(rowId);
  return Response.json({ ok: true, curation: out });
}
