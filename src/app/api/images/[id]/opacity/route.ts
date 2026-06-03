import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getGeneration } from "@/lib/db/repo/generations";
import { resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const gen = getGeneration(id);
  if (!gen) return NextResponse.json({ error: "not found" }, { status: 404 });

  const srcPath = resolveImagePath(gen.image_path);

  try {
    const { data, info } = await sharp(srcPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let totalAlpha = 0;
    const pixelCount = info.width * info.height;
    for (let i = 3; i < data.length; i += 4) {
      totalAlpha += data[i];
    }
    const opacity = Math.round((totalAlpha / pixelCount / 255) * 100);
    return NextResponse.json({ opacity });
  } catch {
    return NextResponse.json({ opacity: 100 });
  }
}
