import { NextRequest } from "next/server";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import {
  IMAGES_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  toRelative,
  resolveImagePath,
} from "@/lib/util/paths";
import {
  applySpritesheetEffect,
  type SpriteEffect,
  type SpriteEffectParams,
} from "@/lib/image-backend/sprite-effect";
import fs from "node:fs/promises";

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

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const newId = newGenerationId();
  const outPath = imagePathFor(newId);
  const effectParams = body.params ?? {};

  let result: { width: number; height: number };
  try {
    result = await applySpritesheetEffect({
      inputPath: resolveImagePath(gen.image_path),
      effect: body.effect as SpriteEffect,
      effectParams,
      cols,
      rows,
      outPath,
    });
  } catch (e) {
    return Response.json(
      { error: `sprite effect failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  createGeneration({
    id: newId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "sprite_effect",
    backend: "direct",
    prompt: `스프라이트 이펙트 (${body.effect})`,
    input_image_ids: [body.generationId],
    params: { effect: body.effect, effectParams, cols, rows },
    image_path: toRelative(outPath),
    width: result.width,
    height: result.height,
  });

  return Response.json({
    generationId: newId,
    imagePath: `/api/images/${newId}`,
    width: result.width,
    height: result.height,
  });
}
