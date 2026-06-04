import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/util/paths";

/**
 * GET/PATCH /api/config — 앱 런타임 설정 (data/config.json).
 *
 * 현재 키:
 *  - orchestrator: "claude" | "codex"
 *    Claude CLI 오케스트레이션을 쓸지, Codex 규칙기반 직접 모드를 쓸지 결정.
 *    chat/route.ts 의 readOrchestratorConfig() 가 같은 파일을 읽어 분기한다.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

type Orchestrator = "claude" | "codex";
type AppConfig = { orchestrator: Orchestrator };

function readConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as Partial<AppConfig>;
    return { orchestrator: cfg.orchestrator === "codex" ? "codex" : "claude" };
  } catch {
    return { orchestrator: "claude" };
  }
}

export async function GET() {
  return Response.json(readConfig());
}

export async function PATCH(req: Request) {
  let body: Partial<AppConfig>;
  try {
    body = (await req.json()) as Partial<AppConfig>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const next = readConfig();
  if (body.orchestrator === "claude" || body.orchestrator === "codex") {
    next.orchestrator = body.orchestrator;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return Response.json(next);
}
