/**
 * generate_normal_map 핸들러.
 *
 * Sharp Sobel 필터 기반 결정적 노멀맵 생성 — Codex 호출 없음(1초 이내).
 * RGB 인코딩: R=X기울기, G=Y기울기, B=255. 알파 채널은 보존.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createGeneration, getGeneration } from "../../db/repo/generations.js";
import { createJob, updateJob } from "../../db/repo/jobs.js";
import { DATA_DIR, IMAGES_DIR, imagePath as imagePathFor, toRelative } from "../../util/paths.js";
import {
  newImageIds,
  requireString,
  type HandlerContext,
  type HandlerExtra,
  type ToolResponse,
} from "./shared.js";

export async function handleGenerateNormalMap(
  args: Record<string, unknown>,
  _extra: HandlerExtra,
  ctx: HandlerContext,
): Promise<ToolResponse> {
  const { sessionId, log } = ctx;
  const inputId = requireString(args.inputGenerationId, "inputGenerationId");
  const strength = typeof args.strength === "number"
    ? Math.max(0.5, Math.min(2.0, args.strength))
    : 1.0;

  const inputGen = getGeneration(inputId);
  if (!inputGen) throw new Error(`generate_normal_map: generation ${inputId} 없음`);

  const inputPath = path.join(DATA_DIR, inputGen.image_path);
  const { generationId, jobId } = newImageIds();
  const outPath = imagePathFor(generationId);

  log(
    `generate_normal_map start job=${jobId} gen=${generationId} ` +
      `input=${inputId} strength=${strength} session=${sessionId}`,
  );
  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "codex_image",
    args: { tool: "generate_normal_map", inputGenerationId: inputId, generationId, viaMcp: true },
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const startedAt = performance.now();

  // 메타 읽기
  const meta = await sharp(inputPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("generate_normal_map: 이미지 크기 읽기 실패");

  // 알파 채널 보존용: 원본 알파 추출
  const hasAlpha = meta.hasAlpha ?? false;
  let alphaBuf: Buffer | null = null;
  if (hasAlpha) {
    alphaBuf = await sharp(inputPath)
      .extractChannel("alpha")
      .raw()
      .toBuffer();
  }

  // 투명 영역을 중간 회색(128)으로 flatten 후 greyscale → Sobel
  const base = sharp(inputPath).flatten({ background: { r: 128, g: 128, b: 128 } }).greyscale();

  const scale = Math.round(1.0 / strength);
  const k = strength;

  const [rBuf, gBuf] = await Promise.all([
    base.clone()
      .convolve({
        width: 3, height: 3,
        kernel: [-k, 0, k, -2 * k, 0, 2 * k, -k, 0, k].map(Math.round),
        scale: scale,
        offset: 128,
      })
      .raw().toBuffer(),
    base.clone()
      .convolve({
        width: 3, height: 3,
        kernel: [-k, -2 * k, -k, 0, 0, 0, k, 2 * k, k].map(Math.round),
        scale: scale,
        offset: 128,
      })
      .raw().toBuffer(),
  ]);

  // RGB 채널 조합: R=X기울기, G=Y기울기, B=255
  const pixels = width * height;
  const channels = hasAlpha ? 4 : 3;
  const out = Buffer.alloc(pixels * channels, 0);
  for (let i = 0; i < pixels; i++) {
    const alpha = alphaBuf ? alphaBuf[i] : 255;
    if (alpha < 10) {
      // 완전 투명 픽셀 → flat normal (128,128,255)
      out[i * channels]     = 128;
      out[i * channels + 1] = 128;
      out[i * channels + 2] = 255;
    } else {
      out[i * channels]     = rBuf[i];
      out[i * channels + 1] = gBuf[i];
      out[i * channels + 2] = 255;
    }
    if (channels === 4) out[i * channels + 3] = alpha;
  }

  await sharp(out, { raw: { width, height, channels } })
    .png()
    .toFile(outPath);

  const elapsedMs = Math.round(performance.now() - startedAt);

  const gen = createGeneration({
    id: generationId,
    session_id: sessionId,
    message_id: null,
    kind: "normal_map",
    prompt: `Normal map from ${inputId} (strength=${strength})`,
    input_image_ids: [inputId],
    image_path: toRelative(outPath),
    thumbnail_path: null,
    width,
    height,
    backend: "direct",
  });
  updateJob(jobId, {
    status: "succeeded",
    result: { generationId: gen.id, elapsedMs },
    ended_at: Date.now(),
  });

  log(`generate_normal_map done job=${jobId} gen=${gen.id} ${width}x${height} ${elapsedMs}ms`);

  return {
    content: [
      {
        type: "text",
        text: `노멀맵 생성 완료: ${width}×${height}, ${(elapsedMs / 1000).toFixed(1)}s. ` +
          `Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width,
      height,
      elapsedMs,
    },
  };
}
