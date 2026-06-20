import { NextRequest } from "next/server";
import {
  deleteCanvasEdit,
  getCanvasEdit,
  upsertCanvasEdit,
  type PersistedCanvasState,
} from "@/lib/db/repo/canvas-edits";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ seedId: string }> };

/** GET: 시드별 저장된 캔버스 편집 상태(stale 레이어 필터됨). 없으면 state: null. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { seedId } = await ctx.params;
  return Response.json({ state: getCanvasEdit(seedId) });
}

/** POST: 자동 저장 — { state } 를 upsert. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { seedId } = await ctx.params;
  let body: { state?: PersistedCanvasState };
  try {
    body = (await req.json()) as { state?: PersistedCanvasState };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.state || !Array.isArray(body.state.layers)) {
    return Response.json({ error: "state required" }, { status: 400 });
  }
  upsertCanvasEdit(seedId, body.state);
  return Response.json({ ok: true });
}

/** DELETE: "처음부터" — 저장본 제거. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { seedId } = await ctx.params;
  deleteCanvasEdit(seedId);
  return Response.json({ ok: true });
}
