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

  // trim은 별도 처리 — trimOffsetLeft/Top을 추출해 클라이언트에 반환.
  if (filter === "trim") {
    const meta = await sharp(srcPath).ensureAlpha().trim().png().toFile(outPath);
    const relPath = toRelative(outPath);
    createGeneration({
      id: newId,
      session_id: gen.session_id,
      message_id: null,
      kind: gen.kind,
      prompt: `[trim] ${gen.prompt ?? ""}`.trim(),
      input_image_ids: [generationId],
      image_path: relPath,
      width: meta.width,
      height: meta.height,
      backend: "direct",
    });
    return NextResponse.json({
      generationId: newId,
      width: meta.width,
      height: meta.height,
      trimOffsetLeft: meta.trimOffsetLeft ?? 0,
      trimOffsetTop: meta.trimOffsetTop ?? 0,
    });
  }

  let pipeline = sharp(srcPath).ensureAlpha();

  if (filter === "flop") {
    pipeline = pipeline.flop();
  } else if (filter === "rotate") {
    const angle = Math.round(param ?? 0) % 360;
    pipeline = pipeline.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
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
