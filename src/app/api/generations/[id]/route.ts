import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";

export const runtime = "nodejs";

/**
 * GET /api/generations/[id] — 단일 generation 조회.
 *
 * SpriteCanvas 가 마운트 시 params(rows/cols/cellW/cellH/directions/anchor/fps 등)를
 * source-of-truth 로 가져오기 위해 사용. 미래 재사용(에디터·재오픈) 대비 generic 단일 조회.
 *
 * 응답: { id, kind, params, width, height, imageUrl:'/api/images/<id>' }. 없으면 404.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gen = getGeneration(id);
  if (!gen) return Response.json({ error: "generation not found" }, { status: 404 });
  return Response.json({
    id: gen.id,
    kind: gen.kind,
    params: gen.params,
    width: gen.width,
    height: gen.height,
    imageUrl: `/api/images/${gen.id}`,
  });
}
