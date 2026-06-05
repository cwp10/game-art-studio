import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { imagePath, resolveImagePath, toRelative } from "@/lib/util/paths";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    generationId?: string;
    srcX?: number; srcY?: number; srcW?: number; srcH?: number;
    targetW?: number; targetH?: number;
    opacity?: number;
  };
  const { generationId, srcX = 0, srcY = 0, srcW, srcH, targetW, targetH, opacity = 100 } = body;

  if (!generationId || !srcW || !srcH || !targetW || !targetH || srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }

  const gen = getGeneration(generationId);
  if (!gen) return NextResponse.json({ error: "not found" }, { status: 404 });

  const srcPath = resolveImagePath(gen.image_path);
  const srcMeta = await sharp(srcPath).metadata();
  const imgW = srcMeta.width ?? 1;
  const imgH = srcMeta.height ?? 1;

  const outW = Math.max(1, targetW);
  const outH = Math.max(1, targetH);

  // 클라이언트에서 이미 [0, imgW] × [0, imgH] 로 clamping 되어 오므로 단순 extract + resize
  const left = Math.max(0, Math.min(Math.round(srcX), imgW - 1));
  const top  = Math.max(0, Math.min(Math.round(srcY), imgH - 1));
  const extractW = Math.max(1, Math.min(Math.round(srcW), imgW - left));
  const extractH = Math.max(1, Math.min(Math.round(srcH), imgH - top));

  const newId = newGenerationId();
  const outPath = imagePath(newId);

  await sharp(srcPath)
    .extract({ left, top, width: extractW, height: extractH })
    .resize(outW, outH, { fit: "fill" })
    .png()
    .toFile(outPath);

  // Apply opacity as absolute target: normalize current average alpha → target %.
  // factor = targetAvg / currentAvg → no change when slider matches current state.
  {
    const targetAvg = (Math.max(0, Math.min(100, opacity)) / 100) * 255;
    const { data, info } = await sharp(outPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let totalAlpha = 0;
    for (let i = 3; i < data.length; i += 4) totalAlpha += data[i];
    const currentAvg = totalAlpha / (info.width * info.height);
    if (currentAvg > 0.5 && Math.abs(targetAvg - currentAvg) > 0.5) {
      const factor = targetAvg / currentAvg;
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.min(255, Math.max(0, Math.round(data[i] * factor)));
      }
      await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toFile(outPath);
    }
  }

  const relPath = toRelative(outPath);
  createGeneration({
    id: newId,
    session_id: gen.session_id,
    message_id: null,
    kind: "resize",
    prompt: gen.prompt ? `[crop] ${gen.prompt}` : "[crop]",
    input_image_ids: [generationId],
    image_path: relPath,
    width: outW,
    height: outH,
    backend: "direct",
  });

  return NextResponse.json({ generationId: newId, width: outW, height: outH });
}
