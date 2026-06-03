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
    let visibleCount = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 10) { // 투명 배경(anti-aliasing 포함) 제외
        totalAlpha += data[i];
        visibleCount++;
      }
    }
    // 불투명 픽셀이 없으면(완전 투명 이미지) 100% 반환
    const opacity = visibleCount > 0
      ? Math.round((totalAlpha / visibleCount / 255) * 100)
      : 100;
    return NextResponse.json({ opacity });
  } catch {
    return NextResponse.json({ opacity: 100 });
  }
}
