import { NextRequest } from "next/server";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import {
  IMAGES_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  toRelative,
  resolveImagePath,
} from "@/lib/util/paths";
import { mergeImages } from "@/lib/image-backend/composite-layers";
import fs from "node:fs/promises";

export const runtime = "nodejs";

/**
 * POST /api/composite — 씬 프리뷰어. N 개 generation 레이어를 단일 PNG 로 합성해 generation 행으로 저장.
 *
 * Request:
 *   { layers: [{ generationId: string, opacity: number }], sessionId?: string,
 *     outputWidth?: number, outputHeight?: number }
 *   - layers 는 입력 순서대로 합성(배열[0]=최하단). opacity 0~100.
 *   - outputWidth/outputHeight 미지정 시 첫 레이어 이미지의 실제 크기로 폴백.
 *
 * Response:
 *   { generationId: string, imagePath: string, width: number, height: number }
 */

type CompositeLayerInput = {
  generationId?: string;
  opacity?: number;
  x?: number;
  y?: number;
  scale?: number;
};
type CompositeBody = {
  layers?: CompositeLayerInput[];
  sessionId?: string;
  outputWidth?: number;
  outputHeight?: number;
};

export async function POST(req: NextRequest) {
  let body: CompositeBody;
  try {
    body = (await req.json()) as CompositeBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!Array.isArray(body.layers) || body.layers.length === 0) {
    return Response.json({ error: "layers must be a non-empty array" }, { status: 400 });
  }

  const resolved: {
    imagePath: string;
    opacity: number;
    generationId: string;
    x?: number;
    y?: number;
    scale?: number;
  }[] = [];
  for (const [i, l] of body.layers.entries()) {
    if (!l.generationId) {
      return Response.json({ error: `layers[${i}].generationId required` }, { status: 400 });
    }
    const gen = getGeneration(l.generationId);
    if (!gen) {
      return Response.json({ error: `generation not found: ${l.generationId}` }, { status: 404 });
    }
    const opacity = typeof l.opacity === "number" ? l.opacity : 100;
    resolved.push({
      imagePath: resolveImagePath(gen.image_path),
      opacity,
      generationId: l.generationId,
      x: typeof l.x === "number" ? l.x : undefined,
      y: typeof l.y === "number" ? l.y : undefined,
      scale: typeof l.scale === "number" ? l.scale : undefined,
    });
  }

  let outputWidth = body.outputWidth;
  let outputHeight = body.outputHeight;
  if (!outputWidth || !outputHeight) {
    const meta = await sharp(resolved[0].imagePath).metadata();
    outputWidth = meta.width ?? 0;
    outputHeight = meta.height ?? 0;
  }
  if (!outputWidth || !outputHeight) {
    return Response.json({ error: "could not determine output dimensions" }, { status: 400 });
  }

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const newId = newGenerationId();
  const outPath = imagePathFor(newId);
  const { width, height } = await mergeImages({
    layers: resolved.map((r) => ({
      imagePath: r.imagePath,
      opacity: r.opacity,
      x: r.x,
      y: r.y,
      scale: r.scale,
    })),
    outputWidth,
    outputHeight,
    outPath,
  });

  createGeneration({
    id: newId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "composite",
    backend: "direct",
    prompt: `씬 합성 (${body.layers.length}개 레이어)`,
    input_image_ids: resolved.map((r) => r.generationId),
    params: { layers: body.layers, outputWidth, outputHeight },
    image_path: toRelative(outPath),
    width,
    height,
  });

  return Response.json({
    generationId: newId,
    imagePath: `/api/images/${newId}`,
    width,
    height,
  });
}
