import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";
import { type SpriteEffect, type SpriteEffectParams } from "@/lib/image-backend/sprite-effect";
import { runSpriteEffect } from "@/lib/image-backend/sprite-effect-runner";

export const runtime = "nodejs";

/**
 * POST /api/sprite-effect — 스프라이트시트 셀 단위 알파 마스크 이펙트(드롭 섀도우/아웃라인/글로우).
 *
 * Request:
 *   { generationId: string, effect: 'drop_shadow'|'outline'|'glow',
 *     params?: SpriteEffectParams, sessionId?: string, cols?: number, rows?: number }
 *   - generationId 는 kind='spritesheet' 만 허용.
 *   - cols/rows 는 generation.params 에서 우선 읽고, 없으면 request body 에서. 둘 다 없으면 400.
 *
 * Response:
 *   { generationId: string, imagePath: string, width: number, height: number }
 */

const VALID_EFFECTS: SpriteEffect[] = ["drop_shadow", "outline", "glow"];

type SpriteEffectBody = {
  generationId?: string;
  effect?: string;
  params?: SpriteEffectParams;
  sessionId?: string;
  cols?: number;
  rows?: number;
};

export async function POST(req: NextRequest) {
  let body: SpriteEffectBody;
  try {
    body = (await req.json()) as SpriteEffectBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.generationId) {
    return Response.json({ error: "generationId required" }, { status: 400 });
  }
  if (!body.effect || !VALID_EFFECTS.includes(body.effect as SpriteEffect)) {
    return Response.json(
      { error: `effect must be one of: ${VALID_EFFECTS.join(", ")}` },
      { status: 400 },
    );
  }

  // 라우트에 입력 검증(400/404 구분)을 유지 — 관찰 가능한 HTTP 계약.
  // 핵심 실행은 runSpriteEffect 에 위임해 MCP 도구와 동일 계약을 공유한다.
  const gen = getGeneration(body.generationId);
  if (!gen) {
    return Response.json({ error: `generation not found: ${body.generationId}` }, { status: 404 });
  }
  if (gen.kind !== "spritesheet") {
    return Response.json(
      { error: `generation kind must be 'spritesheet', got '${gen.kind}'` },
      { status: 400 },
    );
  }

  // cols/rows: generation.params 우선, 없으면 request body.
  const paramCols = typeof gen.params.cols === "number" ? (gen.params.cols as number) : undefined;
  const paramRows = typeof gen.params.rows === "number" ? (gen.params.rows as number) : undefined;
  const cols = paramCols ?? (typeof body.cols === "number" ? body.cols : undefined);
  const rows = paramRows ?? (typeof body.rows === "number" ? body.rows : undefined);
  if (!cols || !rows) {
    return Response.json(
      { error: "cols/rows not found in generation.params and not provided in body" },
      { status: 400 },
    );
  }

  let result: { generationId: string; imagePath: string; width: number; height: number };
  try {
    result = await runSpriteEffect({
      generationId: body.generationId,
      effect: body.effect as SpriteEffect,
      params: body.params ?? {},
      sessionId: body.sessionId,
      cols: body.cols,
      rows: body.rows,
    });
  } catch (e) {
    return Response.json(
      { error: `sprite effect failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  return Response.json(result);
}
