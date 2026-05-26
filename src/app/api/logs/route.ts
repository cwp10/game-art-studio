import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * GET /api/logs — 파일 목록 (mtime DESC).
 * GET /api/logs?file=...&lines=300 — 마지막 N 줄 (text/plain).
 * GET /api/logs?file=...&stream=1 — SSE 로 초기 tail + 새 append 줄 push.
 *   `event: append\ndata: <line>\n\n` 형태. 클라이언트는 EventSource 로 구독.
 *
 * 파일명 SAFE_NAME regex 로 경로 탈출 차단.
 */

const SAFE_NAME = /^[\w.-]+\.log$/;

export async function GET(req: NextRequest) {
  if (!fs.existsSync(LOGS_DIR)) return Response.json({ files: [] });

  const file = req.nextUrl.searchParams.get("file");
  const stream = req.nextUrl.searchParams.get("stream");

  if (file) {
    if (!SAFE_NAME.test(file)) {
      return Response.json({ error: "invalid file name" }, { status: 400 });
    }
    const p = path.join(LOGS_DIR, file);
    if (!fs.existsSync(p)) return Response.json({ error: "not found" }, { status: 404 });

    if (stream === "1") {
      return sseTail(p, req.signal);
    }

    const lines = Math.min(2000, Number(req.nextUrl.searchParams.get("lines") ?? "300"));
    const buf = fs.readFileSync(p, "utf8");
    const all = buf.split("\n");
    const tail = all.slice(-lines).join("\n");
    return new Response(tail, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

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

/**
 * SSE tail — 초기 마지막 300 줄을 'init' 이벤트로 한 번에, 이후 fs.watch 가 size 변화 감지
 * 시 새로 append 된 부분을 'append' 이벤트로 push. 클라이언트 abort 시 watcher 정리.
 *
 * Next 의 RouteHandler context 는 별도 Node child 가 아니라 같은 process 안의 stream.
 * fs.watch 는 macOS/Linux 에서 모두 동작.
 */
function sseTail(filePath: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let lastSize = 0;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data.replace(/\n/g, "\\n")}\n\n`));
      };

      // 1) 초기 tail — 마지막 300 줄.
      try {
        const buf = fs.readFileSync(filePath, "utf8");
        const tail = buf.split("\n").slice(-300).join("\n");
        send("init", tail);
        lastSize = fs.statSync(filePath).size;
      } catch (e) {
        send("error", (e as Error).message);
      }

      // 2) watcher — size 변화 시 새 부분만 read.
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        try {
          const st = fs.statSync(filePath);
          if (st.size <= lastSize) {
            // truncated or no growth.
            if (st.size < lastSize) lastSize = 0;
            return;
          }
          const fd = fs.openSync(filePath, "r");
          try {
            const len = st.size - lastSize;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, lastSize);
            lastSize = st.size;
            send("append", buf.toString("utf8"));
          } finally {
            fs.closeSync(fd);
          }
        } catch (e) {
          send("error", (e as Error).message);
        }
      });

      // 3) 주기 keepalive — 30초마다 ":\n\n" (proxy timeout 방지).
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch { /* closed */ }
      }, 30000);

      // 4) cleanup.
      const cleanup = () => {
        clearInterval(keepalive);
        watcher.close();
        try {
          controller.close();
        } catch { /* already */ }
      };
      signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
