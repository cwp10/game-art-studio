import { NextRequest } from "next/server";
import sharp from "sharp";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import { ensureDataDirs, imagePath as imagePathFor, resolveImagePath, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/normal-map
 * Body: { generationId: string, strength?: number }  (strength 0.5–2.0, 기본 1.0)
 * Response: { newGenerationId, imageUrl, width, height, elapsedMs }
 *
 * MCP generate_normal_map 과 동일한 Sobel 합성 로직을 직접 실행한다 (codex/Claude 불필요).
 * 투명 영역을 중간 회색으로 flatten → greyscale → X/Y Sobel → RGB 조합.
 */
export async function POST(req: NextRequest) {
  let body: { generationId?: string; strength?: number };
  try {
    body = (await req.json()) as { generationId?: string; strength?: number };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const { generationId, strength: rawStrength = 1.0 } = body;
  if (!generationId) return Response.json({ error: "generationId required" }, { status: 400 });

  const strength = Math.max(0.5, Math.min(2.0, rawStrength));

  const source = getGeneration(generationId);
  if (!source) return Response.json({ error: "generation not found" }, { status: 404 });

  ensureDataDirs();
  const inputPath = resolveImagePath(source.image_path);
  const newGenId = newGenerationId();
  const outPath = imagePathFor(newGenId);
  const startedAt = performance.now();

  const meta = await sharp(inputPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return Response.json({ error: "이미지 크기 읽기 실패" }, { status: 422 });

  const hasAlpha = meta.hasAlpha ?? false;
  let alphaBuf: Buffer | null = null;
  if (hasAlpha) {
    alphaBuf = await sharp(inputPath).extractChannel("alpha").raw().toBuffer();
  }

  const base = sharp(inputPath).flatten({ background: { r: 128, g: 128, b: 128 } }).greyscale();
  const scale = Math.round(1.0 / strength);
  const k = strength;

  const [rBuf, gBuf] = await Promise.all([
    base.clone()
      .convolve({ width: 3, height: 3, kernel: [-k, 0, k, -2 * k, 0, 2 * k, -k, 0, k].map(Math.round), scale, offset: 128 })
      .raw().toBuffer(),
    base.clone()
      .convolve({ width: 3, height: 3, kernel: [-k, -2 * k, -k, 0, 0, 0, k, 2 * k, k].map(Math.round), scale, offset: 128 })
      .raw().toBuffer(),
  ]);

  const pixels = width * height;
  const channels = hasAlpha ? 4 : 3;
  const out = Buffer.alloc(pixels * channels, 0);
  for (let i = 0; i < pixels; i++) {
    const alpha = alphaBuf ? alphaBuf[i] : 255;
    if (alpha < 10) {
      out[i * channels]     = 128;
      out[i * channels + 1] = 128;
      out[i * channels + 2] = 255;
    } else {
      out[i * channels]     = rBuf[i]!;
      out[i * channels + 1] = gBuf[i]!;
      out[i * channels + 2] = 255;
    }
    if (channels === 4) out[i * channels + 3] = alpha;
  }

  await sharp(out, { raw: { width, height, channels } }).png().toFile(outPath);

  const elapsedMs = Math.round(performance.now() - startedAt);

  const gen = createGeneration({
    id: newGenId,
    session_id: source.session_id,
    message_id: null,
    kind: "normal_map",
    prompt: `Normal map from ${generationId} (strength=${strength})`,
    input_image_ids: [generationId],
    image_path: toRelative(outPath),
    width,
    height,
    backend: "direct",
  });

  return Response.json({ newGenerationId: gen.id, imageUrl: `/api/images/${gen.id}`, width, height, elapsedMs });
}
