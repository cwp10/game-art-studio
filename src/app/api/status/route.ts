import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type ToolStatus = { ok: boolean; version?: string; error?: string };

const IS_WIN = process.platform === "win32";

function checkCLI(cmd: string, args: string[], timeoutMs = 5000): Promise<ToolStatus> {
  return new Promise(resolve => {
    let out = "";
    let timedOut = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: IS_WIN, windowsHide: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });

    child.on("error", err => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message.includes("ENOENT") ? "not found" : err.message });
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        const version = out.split("\n")[0].trim();
        resolve({ ok: true, version: version || undefined });
      } else {
        resolve({ ok: false, error: `exit ${code}` });
      }
    });
  });
}

function checkMCP(timeoutMs = 8000): Promise<ToolStatus> {
  return new Promise(resolve => {
    const initMsg = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "status-check", version: "1.0" } },
    }) + "\n";

    let out = "";
    let timedOut = false;

    const cwd = process.cwd();
    const compiledServer = path.join(cwd, ".next", "mcp-server.js");
    const tsServer = path.join(cwd, "src", "lib", "mcp", "server.ts");
    const useCompiled = fs.existsSync(compiledServer);

    const spawnArgs = useCompiled
      ? [process.execPath, [compiledServer]]
      : [process.execPath, ["--import", "tsx", tsServer]];

    const child = spawn(
      spawnArgs[0] as string,
      spawnArgs[1] as string[],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          IMAGEGEN_DATA_DIR: process.env.IMAGEGEN_DATA_DIR ?? path.join(cwd, "data"),
          NODE_OPTIONS: "--max-old-space-size=4096",
        },
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      try {
        const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "");
        if (parsed?.result?.serverInfo) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          if (!timedOut) resolve({ ok: true, version: parsed.result.serverInfo.version });
        }
      } catch {
        // wait for more data
      }
    });

    child.on("error", err => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (!timedOut && !out.includes("serverInfo")) {
        resolve({ ok: false, error: "server exited" });
      }
    });

    child.stdin.write(initMsg);
    child.stdin.end();
  });
}

export async function GET() {
  const [claude, codex, mcp] = await Promise.all([
    checkCLI("claude", ["--version"]),
    checkCLI("codex", ["--version"]),
    checkMCP(),
  ]);

  const allOk = claude.ok && codex.ok && mcp.ok;
  return Response.json({ claude, codex, mcp }, { status: allOk ? 200 : 207 });
}
