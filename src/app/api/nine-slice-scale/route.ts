import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import { scaleWithNineSlice } from "@/lib/image-backend/nine-slice";
import { newGenerationId } from "@/lib/util/ids";
import {
  ensureDataDirs,
  imagePath as imagePathFor,
  resolveImagePath,
  toRelative,
} from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/nine-slice-scale — 9-slice 방식으로 이미지를 targetW×targetH 로 스케일한다
 * (코너 고정, 엣지/중앙 신축). 결정적 sharp 연산만 사용(codex 호출 없음).
 *
 * Request:
 *   { generationId, insetLeft/Right/Top/Bottom, targetWidth, targetHeight, sessionId? }
 * Response:
 *   { generationId, imagePath, width(=targetWidth), height(=targetHeight) }
 */

type Body = {
  generationId?: string;
  insetLeft?: number;
  insetRight?: number;
  insetTop?: number;
  insetBottom?: number;
  targetWidth?: number;
  targetHeight?: number;
  sessionId?: string | null;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.generationId) {
    return Response.json({ error: "generationId required" }, { status: 400 });
  }
  if (!body.targetWidth || !body.targetHeight) {
    return Response.json({ error: "targetWidth/targetHeight required" }, { status: 400 });
  }

  const gen = getGeneration(body.generationId);
  if (!gen) {
    return Response.json({ error: `generation not found: ${body.generationId}` }, { status: 400 });
  }

  const srcPath = resolveImagePath(gen.image_path);
  try {
    await fs.access(srcPath);
  } catch {
    return Response.json({ error: `source image file not found: ${gen.image_path}` }, { status: 400 });
  }

  const inset = {
    left: body.insetLeft ?? 0,
    right: body.insetRight ?? 0,
    top: body.insetTop ?? 0,
    bottom: body.insetBottom ?? 0,
  };
  const targetWidth = body.targetWidth;
  const targetHeight = body.targetHeight;

  ensureDataDirs();
  const newId = newGenerationId();
  const outPath = imagePathFor(newId);

  let buf: Buffer;
  try {
    buf = await scaleWithNineSlice(srcPath, inset, targetWidth, targetHeight);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("inset exceeds image dimensions")) {
      return Response.json({ error: msg }, { status: 400 });
    }
    return Response.json({ error: `nine-slice scale failed: ${msg}` }, { status: 500 });
  }

  await fs.writeFile(outPath, buf);

  createGeneration({
    id: newId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "nine_slice_scaled",
    backend: "direct",
    prompt: `9-slice 스케일 (${targetWidth}×${targetHeight})`,
    input_image_ids: [body.generationId],
    params: {
      insetLeft: inset.left,
      insetRight: inset.right,
      insetTop: inset.top,
      insetBottom: inset.bottom,
      targetWidth,
      targetHeight,
      sourceId: body.generationId,
    },
    image_path: toRelative(outPath),
    width: targetWidth,
    height: targetHeight,
  });

  return Response.json({
    generationId: newId,
    imagePath: `/api/images/${newId}`,
    width: targetWidth,
    height: targetHeight,
  });
}
