import { NextRequest } from "next/server";
import { createReadStream, renameSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { getGeneration } from "@/lib/db/repo/generations";
import { DATA_DIR, THUMBS_DIR, ensureDataDirs, thumbnailPath } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * GET /api/thumbnails/[id] — 갤러리 그리드용 경량 썸네일.
 *
 * data/thumbnails/{id}.webp 에 longest-side 256 webp 를 lazy 생성·캐시·서빙한다.
 * 캐시가 있으면 그대로 서빙(재생성 X). 원본이 없으면 410. 기존 generation 들도
 * backfill 없이 첫 요청 때 생성된다. 썸네일 파일은 cleanup 스크립트의 고아 정리 대상.
 */
const THUMB_LONGEST = 256;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gen = getGeneration(id);
  if (!gen) return new Response("not found", { status: 404 });

  const thumbPath = thumbnailPath(id);

  // 캐시 히트 → 그대로 서빙.
  try {
    const st = await stat(thumbPath);
    return serve(thumbPath, st.size);
  } catch {
    /* 캐시 미스 → 아래에서 생성 */
  }

  const srcPath = path.isAbsolute(gen.image_path)
    ? gen.image_path
    : path.join(DATA_DIR, gen.image_path);
  try {
    await stat(srcPath);
  } catch {
    return new Response("file missing", { status: 410 });
  }

  ensureDataDirs();
  const tmp = path.join(THUMBS_DIR, `${id}.webp.tmp`);
  try {
    await sharp(srcPath)
      .resize(THUMB_LONGEST, THUMB_LONGEST, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(tmp);
    renameSync(tmp, thumbPath);
  } catch (e) {
    return new Response(`thumbnail failed: ${(e as Error).message}`, { status: 500 });
  }

  const st = await stat(thumbPath);
  return serve(thumbPath, st.size);
}

function serve(filePath: string, size: number): Response {
  const nodeStream = createReadStream(filePath);
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
