import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getGeneration } from "@/lib/db/repo/generations";
import { resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gen = getGeneration(id);
  if (!gen) return new Response("not found", { status: 404 });

  const filePath = resolveImagePath(gen.image_path);

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
