import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import { IMAGES_DIR, ensureDataDirs, imagePath as imagePathFor, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/upload — 클라이언트가 만든/가져온 이미지를 generation 행으로 저장.
 *
 * kind:
 *   "mask"  — 인페인트 마스크. parentGenerationId 필수. lineage 는 input_image_ids.
 *             generations.kind='inpaint' + params.kindHint='mask'.
 *   "image" — 외부 이미지 import (Composer 첨부 / EmptyState 업로드). parent 없음.
 *             generations.kind='text2img' (enum 회피) + params.kindHint='external',
 *             prompt='업로드 이미지', backend='external', sessionId 있으면 연결.
 *
 * body (mask):  { kind:"mask", parentGenerationId, dataUrl }
 * body (image): { kind:"image", dataUrl, sessionId?, filename? }
 *
 * dataUrl 은 `data:image/<png|jpeg|webp>;base64,...`. 응답: { generationId, width, height }.
 */

type UploadBody = {
  kind?: "mask" | "image";
  parentGenerationId?: string;
  sessionId?: string;
  filename?: string;
  dataUrl?: string;
};

const DATAURL_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;

export async function POST(req: NextRequest) {
  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.kind !== "mask" && body.kind !== "image") {
    return Response.json({ error: "kind must be 'mask' or 'image'" }, { status: 400 });
  }
  if (!body.dataUrl || !DATAURL_PREFIX.test(body.dataUrl)) {
    return Response.json({ error: "dataUrl must be image/(png|jpeg|webp) base64" }, { status: 400 });
  }

  // 마스크는 항상 PNG 만 허용 (codex 가 binary mask 로 read).
  if (body.kind === "mask" && !body.dataUrl.startsWith("data:image/png;base64,")) {
    return Response.json({ error: "mask dataUrl must be PNG" }, { status: 400 });
  }

  let parent = null;
  if (body.kind === "mask") {
    if (!body.parentGenerationId) {
      return Response.json({ error: "parentGenerationId required" }, { status: 400 });
    }
    parent = getGeneration(body.parentGenerationId);
    if (!parent) return Response.json({ error: "parent generation not found" }, { status: 404 });
  }

  const base64Idx = body.dataUrl.indexOf(",") + 1;
  const base64Str = body.dataUrl.slice(base64Idx);
  // base64 디코딩 전 크기 추정 (4문자 → 3바이트). Buffer 할당 전에 OOM 방지.
  const MAX_BYTES = 20 * 1024 * 1024; // 20MB
  if (base64Str.length * 0.75 > MAX_BYTES) {
    return Response.json({ error: "이미지 크기 제한 초과 (최대 20MB)" }, { status: 413 });
  }
  const buf = Buffer.from(base64Str, "base64");
  if (buf.length === 0) return Response.json({ error: "empty image body" }, { status: 400 });

  ensureDataDirs();
  const generationId = newGenerationId();
  // 파일은 항상 PNG 로 정규화 (sharp 변환) — 후속 codex 도구가 PNG 가정.
  const destPath = imagePathFor(generationId);
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  // mask 는 PNG 그대로, image 는 sharp 로 png 출력 (jpeg/webp 도 png 로 통일).
  if (body.kind === "mask") {
    await fs.writeFile(destPath, buf);
  } else {
    await sharp(buf).png().toFile(destPath);
  }
  const meta = await sharp(destPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const gen =
    body.kind === "mask"
      ? createGeneration({
          id: generationId,
          session_id: parent!.session_id,
          message_id: null,
          kind: "inpaint",
          prompt: null,
          input_image_ids: [parent!.id],
          params: { kindHint: "mask" },
          image_path: toRelative(destPath),
          width,
          height,
          backend: "external",
        })
      : createGeneration({
          id: generationId,
          session_id: body.sessionId ?? null,
          message_id: null,
          kind: "text2img",
          prompt: body.filename ? `업로드: ${body.filename}` : "업로드 이미지",
          params: { kindHint: "external", filename: body.filename },
          image_path: toRelative(destPath),
          width,
          height,
          backend: "external",
        });

  return Response.json({ generationId: gen.id, width: gen.width, height: gen.height });
}

