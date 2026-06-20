import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import { makeNineSliceGrid } from "@/lib/image-backend/nine-slice";
import { newGenerationId } from "@/lib/util/ids";
import {
  ensureDataDirs,
  imagePath as imagePathFor,
  resolveImagePath,
  toRelative,
} from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/nine-slice — 이미지를 inset 기준 9-slice 그리드로 시각화한다(원본 크기 유지 +
 * 슬라이스 경계선). 결정적 sharp 연산만 사용(codex 호출 없음).
 *
 * Request:
 *   { generationId: string, insetLeft/Right/Top/Bottom: number, sessionId?: string|null }
 * Response:
 *   { generationId: string, imagePath: string, width: number, height: number }
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
    buf = await makeNineSliceGrid(srcPath, inset);
  } catch (e) {
    const msg = (e as Error).message;
    // inset 검증 실패는 입력 오류(400).
    if (msg.includes("inset exceeds image dimensions")) {
      return Response.json({ error: msg }, { status: 400 });
    }
    return Response.json({ error: `nine-slice failed: ${msg}` }, { status: 500 });
  }

  await fs.writeFile(outPath, buf);

  // 원본 크기 — DB 값이 비어있을 수 있으므로 실제 파일 메타데이터에서 읽는다.
  const srcMeta = await sharp(srcPath).metadata();
  const width = srcMeta.width ?? gen.width ?? 0;
  const height = srcMeta.height ?? gen.height ?? 0;

  createGeneration({
    id: newId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "nine_slice",
    backend: "direct",
    prompt: "9-slice 그리드",
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
