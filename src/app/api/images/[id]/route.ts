import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getGeneration } from "@/lib/db/repo/generations";
import { DATA_DIR } from "@/lib/util/paths";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gen = getGeneration(id);
  if (!gen) return new Response("not found", { status: 404 });

  // image_path 가 DATA_DIR 기준 상대인지 절대인지 보고 처리
  const filePath = path.isAbsolute(gen.image_path)
    ? gen.image_path
    : path.join(DATA_DIR, gen.image_path);

  try {
    const st = await stat(filePath);
    const nodeStream = createReadStream(filePath);
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(st.size),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new Response("file missing", { status: 410 });
  }
}
