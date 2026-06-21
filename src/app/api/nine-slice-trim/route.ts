import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import { trimWithNineSlice } from "@/lib/image-backend/nine-slice";
import { newGenerationId } from "@/lib/util/ids";
import {
  ensureDataDirs,
  imagePath as imagePathFor,
  resolveImagePath,
  toRelative,
} from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/nine-slice-trim — 9-slice 방식으로 코너/엣지만 남기고 중앙 영역을 2px 로
 * 트림한 최적화 출력을 만든다(코너 고정, 엣지 보존, 중앙 최소화). 결정적 sharp 연산만
 * 사용(codex 호출 없음).
 *
 * Request:
 *   { generationId, insetLeft/Right/Top/Bottom, sessionId? }
 * Response:
 *   { generationId, imagePath, width(=l+2+r), height(=t+2+b) }
 */

type Body = {
  generationId?: string;
  insetLeft?: number;
  insetRight?: number;
  insetTop?: number;
  insetBottom?: number;
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

  ensureDataDirs();
  const newId = newGenerationId();
  const outPath = imagePathFor(newId);

  let buf: Buffer;
  try {
    buf = await trimWithNineSlice(srcPath, inset);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("inset exceeds image dimensions")) {
      return Response.json({ error: msg }, { status: 400 });
    }
    return Response.json({ error: `nine-slice trim failed: ${msg}` }, { status: 500 });
  }

  await fs.writeFile(outPath, buf);

  // 트림 출력 크기 — 중앙을 2px 로 접으므로 (l+2+r)×(t+2+b).
  const width = inset.left + 2 + inset.right;
  const height = inset.top + 2 + inset.bottom;

  createGeneration({
    id: newId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "nine_slice_trimmed",
    backend: "direct",
    prompt: "9-slice 트림",
    input_image_ids: [body.generationId],
    params: {
      insetLeft: inset.left,
      insetRight: inset.right,
      insetTop: inset.top,
      insetBottom: inset.bottom,
      sourceId: body.generationId,
    },
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
