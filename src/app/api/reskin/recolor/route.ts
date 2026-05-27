import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { recolorImage, type ColorMapping } from "@/lib/image-backend/recolor";
import { newGenerationId } from "@/lib/util/ids";
import { DATA_DIR, IMAGES_DIR, ensureDataDirs, imagePath as imagePathFor, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/reskin/recolor — 결정적 색교체(리스킨 모드 b 정밀 경로).
 *
 * codex 를 쓰지 않고 sharp 로 픽셀 단위 색교체(형태 100% 보존). ReskinPanel 의 정밀
 * 서브모드가 자동 추출 팔레트→타깃 매핑을 보내 호출한다. 결과는 kind='reskin' generation.
 *
 * body:
 *   { parentGenerationId, mappings: [{ from:"#rrggbb", to:"#rrggbb", tolerance? }], includeGrays? }
 * 응답:
 *   { generationId, width, height }
 */

type RecolorBody = {
  parentGenerationId?: string;
  mappings?: ColorMapping[];
  includeGrays?: boolean;
};

export async function POST(req: NextRequest) {
  let body: RecolorBody;
  try {
    body = (await req.json()) as RecolorBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.parentGenerationId) {
    return Response.json({ error: "parentGenerationId required" }, { status: 400 });
  }
  if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
    return Response.json({ error: "mappings must be a non-empty array" }, { status: 400 });
  }
  for (const [i, m] of body.mappings.entries()) {
    if (typeof m?.from !== "string" || typeof m?.to !== "string") {
      return Response.json({ error: `mappings[${i}] requires from/to hex strings` }, { status: 400 });
    }
  }

  const parent = getGeneration(body.parentGenerationId);
  if (!parent) {
    return Response.json({ error: "parent generation not found" }, { status: 404 });
  }

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const srcPath = path.join(DATA_DIR, parent.image_path);
  const srcBuf = await fs.readFile(srcPath);
  const outBuf = await recolorImage(srcBuf, body.mappings, { includeGrays: body.includeGrays === true });

  const generationId = newGenerationId();
  const destPath = imagePathFor(generationId);
  await fs.writeFile(destPath, outBuf);
  const meta = await sharp(destPath).metadata();
  const width = meta.width ?? parent.width ?? 0;
  const height = meta.height ?? parent.height ?? 0;

  const gen = createGeneration({
    id: generationId,
    session_id: parent.session_id,
    message_id: null,
    kind: "reskin",
    prompt: "정밀 색교체",
    input_image_ids: [parent.id],
    params: { mode: "palette_precise", mappings: body.mappings, includeGrays: body.includeGrays === true },
    image_path: toRelative(destPath),
    width,
    height,
    backend: "external",
  });

  return Response.json({ generationId: gen.id, width: gen.width, height: gen.height });
}
