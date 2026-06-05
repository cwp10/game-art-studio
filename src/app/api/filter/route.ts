import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { imagePath, resolveImagePath, toRelative } from "@/lib/util/paths";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json() as { generationId?: string; filter?: string; param?: number };
  const { generationId, filter, param } = body;

  if (!generationId || !filter) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }

  const gen = getGeneration(generationId);
  if (!gen) return NextResponse.json({ error: "not found" }, { status: 404 });

  const srcPath = resolveImagePath(gen.image_path);
  const newId = newGenerationId();
  const outPath = imagePath(newId);

  let pipeline = sharp(srcPath).ensureAlpha();

  if (filter === "sharpen") {
    const sigma = Math.max(0.5, Math.min(5, param ?? 1.5));
    pipeline = pipeline.sharpen({ sigma });
  } else if (filter === "blur") {
    const radius = Math.max(0.3, Math.min(20, param ?? 2));
    pipeline = pipeline.blur(radius);
  } else if (filter === "grayscale") {
    const amount = Math.max(0, Math.min(100, param ?? 100));
    pipeline = pipeline.modulate({ saturation: 1 - amount / 100 });
  } else if (filter === "invert") {
    pipeline = pipeline.negate({ alpha: false });
  } else if (filter === "trim") {
    pipeline = pipeline.trim();
  } else if (filter === "flop") {
    pipeline = pipeline.flop();
  } else if (filter === "flip") {
    pipeline = pipeline.flip();
  } else if (filter === "rotate") {
    const angle = Math.round(param ?? 0) % 360;
    pipeline = pipeline.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  } else if (filter === "median") {
    pipeline = pipeline.median(3);
  } else if (filter === "gamma") {
    const g = Math.max(0.1, Math.min(3, param ?? 1.8));
    pipeline = pipeline.gamma(g);
  } else if (filter === "pixelate") {
    const srcMeta = await sharp(srcPath).metadata();
    const w = srcMeta.width ?? 64;
    const h = srcMeta.height ?? 64;
    const blockSize = Math.max(2, Math.min(32, Math.round(param ?? 8)));
    const smallW = Math.max(1, Math.round(w / blockSize));
    const smallH = Math.max(1, Math.round(h / blockSize));
    pipeline = pipeline
      .resize(smallW, smallH, { kernel: "nearest" })
      .resize(w, h, { kernel: "nearest" });
  } else {
    return NextResponse.json({ error: "unknown filter" }, { status: 400 });
  }

  const meta = await pipeline.png().toFile(outPath);

  const relPath = toRelative(outPath);
  createGeneration({
    id: newId,
    session_id: gen.session_id,
    message_id: null,
    kind: gen.kind,
    prompt: `[${filter}] ${gen.prompt ?? ""}`.trim(),
    input_image_ids: [generationId],
    image_path: relPath,
    width: meta.width,
    height: meta.height,
    backend: "direct",
  });

  return NextResponse.json({ generationId: newId, width: meta.width, height: meta.height });
}
