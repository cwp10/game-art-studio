import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * GET /api/logs — data/logs/ 의 파일 목록 (mtime DESC).
 * GET /api/logs?file=claude-xxx.log&lines=200 — 특정 파일의 마지막 N 줄 (text/plain).
 *
 * 파일명에 ../ 등 경로 탈출 차단. 개인용 도구라 외부 노출 없지만 안전 가드.
 */

const SAFE_NAME = /^[\w.-]+\.log$/;

export async function GET(req: NextRequest) {
  if (!fs.existsSync(LOGS_DIR)) return Response.json({ files: [] });

  const file = req.nextUrl.searchParams.get("file");
  if (file) {
    if (!SAFE_NAME.test(file)) {
      return Response.json({ error: "invalid file name" }, { status: 400 });
    }
    const p = path.join(LOGS_DIR, file);
    if (!fs.existsSync(p)) return Response.json({ error: "not found" }, { status: 404 });
    const lines = Math.min(2000, Number(req.nextUrl.searchParams.get("lines") ?? "300"));
    const buf = fs.readFileSync(p, "utf8");
    const all = buf.split("\n");
    const tail = all.slice(-lines).join("\n");
    return new Response(tail, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // 파일 목록 + 크기 + mtime
  const entries = fs
    .readdirSync(LOGS_DIR)
    .filter(n => SAFE_NAME.test(n))
    .map(name => {
      const st = fs.statSync(path.join(LOGS_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return Response.json({ files: entries });
}
