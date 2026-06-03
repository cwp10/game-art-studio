import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { listSessionImagesForExport } from "@/lib/db/repo/generations";
import { getSession } from "@/lib/db/repo/sessions";
import { resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return new Response("sessionId required", { status: 400 });

  const session = getSession(sessionId);
  if (!session) return new Response("session not found", { status: 404 });

  const gens = listSessionImagesForExport(sessionId);

  const zip = new JSZip();
  let index = 0;
  for (const g of gens) {
    const abs = resolveImagePath(g.image_path);
    // 원본 파일이 사라진(수동 삭제 등) 행은 건너뜀 — 한 장 누락이 전체 export 를 깨지 않도록.
    if (!existsSync(abs)) continue;
    index += 1;
    const name = `${String(index).padStart(3, "0")}_${g.kind}_${g.id}.png`;
    zip.file(name, await readFile(abs));
  }

  const buf = await zip.generateAsync({ type: "arraybuffer" });
  return new Response(buf, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="session-${sessionId}.zip"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
