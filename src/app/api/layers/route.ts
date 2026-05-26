import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import { IMAGES_DIR, ensureDataDirs, imagePath as imagePathFor, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/layers — LayerCanvas 가 그린 N(=4)개의 색별 PNG 를 한 번에 generation 행으로 저장.
 *
 * 각 PNG 는 클라이언트에서 (원본 이미지 × 색별 binary mask) 합성 결과.
 * generation 행 kind 는 `inpaint` 재활용 + params.kindHint='layer' + params.colorLabel=...
 * (스키마의 CHECK enum 변경 회피 — 마스크와 동일 패턴.)
 *
 * body:
 *   { parentGenerationId, layers: [{ colorLabel: "red"|"green"|"blue"|"yellow", dataUrl: "data:image/png;base64,..." }, ...] }
 *
 * 응답:
 *   { layers: [{ generationId, colorLabel, width, height }, ...] }
 */

type LayerInput = { colorLabel?: string; dataUrl?: string };
type LayersBody = { parentGenerationId?: string; layers?: LayerInput[] };

const PNG_PREFIX = "data:image/png;base64,";

export async function POST(req: NextRequest) {
  let body: LayersBody;
  try {
    body = (await req.json()) as LayersBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.parentGenerationId) {
    return Response.json({ error: "parentGenerationId required" }, { status: 400 });
  }
  if (!Array.isArray(body.layers) || body.layers.length === 0) {
    return Response.json({ error: "layers must be a non-empty array" }, { status: 400 });
  }
  for (const [i, l] of body.layers.entries()) {
    if (!l.colorLabel) return Response.json({ error: `layers[${i}].colorLabel required` }, { status: 400 });
    if (!l.dataUrl?.startsWith(PNG_PREFIX)) {
      return Response.json({ error: `layers[${i}].dataUrl must be a PNG base64 data URL` }, { status: 400 });
    }
  }

  const parent = getGeneration(body.parentGenerationId);
  if (!parent) {
    return Response.json({ error: "parent generation not found" }, { status: 404 });
  }

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const out: Array<{ generationId: string; colorLabel: string; width: number; height: number }> = [];
  for (const l of body.layers) {
    const buf = Buffer.from(l.dataUrl!.slice(PNG_PREFIX.length), "base64");
    if (buf.length === 0) {
      return Response.json({ error: `empty PNG body for ${l.colorLabel}` }, { status: 400 });
    }
    const generationId = newGenerationId();
    const destPath = imagePathFor(generationId);
    await fs.writeFile(destPath, buf);
    const meta = await sharp(destPath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const gen = createGeneration({
      id: generationId,
      session_id: parent.session_id,
      message_id: null,
      kind: "inpaint",
      prompt: `layer:${l.colorLabel}`,
      input_image_ids: [parent.id],
      params: { kindHint: "layer", colorLabel: l.colorLabel },
      image_path: toRelative(destPath),
      width,
      height,
      backend: "external",
    });
    out.push({ generationId: gen.id, colorLabel: l.colorLabel!, width, height });
  }

  return Response.json({ layers: out });
}
