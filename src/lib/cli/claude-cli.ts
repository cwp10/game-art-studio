import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR, ensureDataDirs } from "@/lib/util/paths";

/**
 * Claude CLI 어댑터 — `claude -p --output-format stream-json` spawn + stream-json 파서.
 *
 * 책임:
 *  - Claude 를 호출하면서 mcp.json 을 붙여 우리 MCP 서버를 활성화
 *  - stdout 의 줄별 JSON 을 파싱해서 `ClaudeStreamEvent` 콜백으로 흘림
 *  - 첫 `system/init` 이벤트에서 session_id 회수 (DB 에 저장해서 후속 `--resume`)
 *  - stderr 는 통째로 `data/logs/claude-{jobId}.log` 로 drain
 *
 * 의도적으로 단순: 파싱은 알려진 message type 만 다루고, 그 외는 raw 로 passthrough.
 * Claude CLI 의 stream-json 포맷은 Anthropic SDK 메시지를 한 줄씩 JSON 으로 흘리는 방식.
 */

export type ClaudeStreamEvent =
  /** `{type: "system", subtype: "init", session_id, ...}` — 세션 시작. */
  | { kind: "session_init"; sessionId: string; raw: unknown }
  /** assistant 의 텍스트 청크. partial 일 수 있음 (`--include-partial-messages` 면). */
  | { kind: "assistant_text"; text: string; messageId: string | null }
  /** assistant 가 도구를 호출하기 시작. */
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
  /** user 메시지 형태로 echo 되는 도구 결과 (Claude 가 자기 호출 결과를 본 시점). */
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: unknown }
  /** `{type: "result", ...}` — 전체 종료. */
  | { kind: "result"; sessionId: string; raw: unknown }
  /** 알 수 없는 메시지. 디버깅용으로 통과. */
  | { kind: "raw"; raw: unknown };

export type ClaudeSpawnOptions = {
  /** orchestrator system prompt. 짧고 강제적. */
  systemPrompt: string;
  /** mcp.json 경로 (data/mcp.json). */
  mcpConfigPath: string;
  /** 허용 도구 목록. 예: `["mcp__imggen__generate_image"]` */
  allowedTools: string[];
  /** 모델 alias 또는 풀네임. 기본 sonnet. */
  model?: string;
  /** 이전 session_id 가 있으면 --resume + --fork-session 으로 이어붙임. */
  resumeSessionId?: string | null;
  /** 사용자 입력. text/plain 으로 stdin 에 한 번 흘리고 종료. */
  userMessage: string;
  /** 디버깅 로그 파일 prefix. 기본 `claude`. */
  logPrefix?: string;
  /** AbortSignal. abort 되면 SIGTERM → 5s 후 SIGKILL. */
  signal?: AbortSignal;
  /** 작업 디렉토리. 기본 process.cwd(). */
  cwd?: string;
};

export type ClaudeRunHandle = {
  /** 이벤트 스트림. for-await 으로 소비. */
  events: AsyncIterable<ClaudeStreamEvent>;
  /** 종료 promise. resolve = exitCode, reject = spawn 에러. */
  done: Promise<number>;
  /** abort 신호 전달 (외부에서 강제 종료). */
  kill: (signal?: NodeJS.Signals) => void;
};

/**
 * Claude CLI 를 spawn 해서 stream-json 출력을 이벤트로 변환.
 *
 * 호출 시 child 가 즉시 fork 되고, 호출자는 `for await (const e of handle.events)` 로 소비.
 * `done` 은 child 종료(exit code) 를 알리며, 종료 후에도 buffered 이벤트는 끝까지 흘러나간다.
 */
export function spawnClaude(opts: ClaudeSpawnOptions): ClaudeRunHandle {
  ensureDataDirs();
  const logId = opts.logPrefix ?? "claude";
  const logFile = path.join(LOGS_DIR, `${logId}-${Date.now()}.log`);

  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose", // stream-json 모드는 verbose 필요 (CLI 요구)
    "--mcp-config",
    opts.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    opts.allowedTools.join(","),
    "--system-prompt",
    opts.systemPrompt,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    opts.model ?? "sonnet",
    // `--no-session-persistence` 는 의도적으로 사용하지 않는다 — 그 플래그를 켜면
    // session_id 가 디스크에 저장되지 않아 후속 turn 의 `--resume` 이 실패한다.
    // 로컬 개인용 도구라 disk 잔존은 무해.
  ];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId, "--fork-session");
  }
  // user message 는 마지막 positional argument.
  args.push(opts.userMessage);

  const child = spawn("claude", args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;

  // 로그 파일에 args 기록
  fs.writeFileSync(logFile, `# claude args:\n${JSON.stringify(args, null, 2)}\n\n# stderr:\n`);
  stderr.on("data", chunk => {
    fs.appendFileSync(logFile, chunk);
  });

  // abort 연결
  if (opts.signal) {
    if (opts.signal.aborted) {
      child.kill("SIGTERM");
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 5000).unref();
        },
        { once: true },
      );
    }
  }

  // stdout 라인 버퍼링 + JSON 파싱.
  const queue: ClaudeStreamEvent[] = [];
  const resolvers: ((v: IteratorResult<ClaudeStreamEvent>) => void)[] = [];
  let streamDone = false;
  let lineBuf = "";

  function emit(ev: ClaudeStreamEvent): void {
    const r = resolvers.shift();
    if (r) r({ value: ev, done: false });
    else queue.push(ev);
  }
  function emitDone(): void {
    streamDone = true;
    while (resolvers.length) {
      resolvers.shift()!({ value: undefined as unknown as ClaudeStreamEvent, done: true });
    }
  }

  stdout.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fs.appendFileSync(logFile, `\n[unparsed stdout line] ${line}\n`);
        continue;
      }
      for (const ev of normalize(parsed)) emit(ev);
    }
  });
  stdout.on("end", () => {
    if (lineBuf.trim()) {
      try {
        const parsed = JSON.parse(lineBuf.trim());
        for (const ev of normalize(parsed)) emit(ev);
      } catch {
        /* drop */
      }
    }
  });

  const done = new Promise<number>((resolve, reject) => {
    child.once("error", err => {
      fs.appendFileSync(logFile, `\n# spawn error:\n${(err as Error).stack ?? String(err)}\n`);
      emitDone();
      reject(err);
    });
    child.once("exit", code => {
      fs.appendFileSync(logFile, `\n# exit code: ${code}\n`);
      emitDone();
      resolve(code ?? -1);
    });
  });

  const events: AsyncIterable<ClaudeStreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ClaudeStreamEvent>> {
          if (queue.length) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (streamDone) {
            return Promise.resolve({
              value: undefined as unknown as ClaudeStreamEvent,
              done: true,
            });
          }
          return new Promise(resolve => resolvers.push(resolve));
        },
      };
    },
  };

  return {
    events,
    done,
    kill: (sig = "SIGTERM" as NodeJS.Signals) => child.kill(sig),
  };
}

type RawAssistantBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown };

type RawUserBlock =
  | { type: "text"; text?: string }
  | { type: "tool_result"; tool_use_id?: string; is_error?: boolean; content?: unknown };

/**
 * stream-json 한 줄을 우리 이벤트 0개 이상으로 변환.
 * 알려진 모양만 다루고 나머지는 `raw` 로 통과.
 */
function normalize(parsed: unknown): ClaudeStreamEvent[] {
  if (!parsed || typeof parsed !== "object") return [{ kind: "raw", raw: parsed }];
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "system" && obj.subtype === "init") {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";
    return sessionId ? [{ kind: "session_init", sessionId, raw: obj }] : [{ kind: "raw", raw: obj }];
  }

  if (type === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { id?: string; content?: RawAssistantBlock[] };
    const messageId = typeof msg.id === "string" ? msg.id : null;
    const out: ClaudeStreamEvent[] = [];
    for (const block of msg.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({ kind: "assistant_text", text: block.text, messageId });
      } else if (block?.type === "tool_use") {
        out.push({
          kind: "tool_use",
          toolUseId: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          input: block.input ?? {},
        });
      }
    }
    return out.length ? out : [{ kind: "raw", raw: obj }];
  }

  if (type === "user" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { content?: RawUserBlock[] };
    const out: ClaudeStreamEvent[] = [];
    for (const block of msg.content ?? []) {
      if (block?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          isError: !!block.is_error,
          content: block.content,
        });
      }
    }
    return out.length ? out : [{ kind: "raw", raw: obj }];
  }

  if (type === "result") {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";
    return [{ kind: "result", sessionId, raw: obj }];
  }

  return [{ kind: "raw", raw: obj }];
}

/**
 * 단순 1-turn 호출. stream-json 없이 plain text 응답을 통째로 받아 반환.
 *
 * 도구 / MCP 없이 가벼운 prompt 후보 생성에 사용. spawnClaude (full orchestrator)
 * 와 분리한 이유: stream-json 인프라가 무겁고, mcp.json 도 필요 없는 단일 호출.
 */
export function claudeRunSimple(opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  signal?: AbortSignal;
  /** 허용 도구. 지정 시 --allowedTools + bypassPermissions 로 도구 사용 활성화(예: ["Read"] 비전 분석). */
  allowedTools?: string[];
  /** 작업 디렉토리. 기본 process.cwd(). */
  cwd?: string;
}): Promise<string> {
  ensureDataDirs();
  const args = ["-p", "--system-prompt", opts.systemPrompt, "--model", opts.model ?? "sonnet"];
  if (opts.allowedTools?.length) {
    // 도구를 쓰려면 권한 게이트를 통과해야 함 — 로컬 개인용이라 bypass(orchestrator 와 동일 정책).
    args.push("--allowedTools", opts.allowedTools.join(","), "--permission-mode", "bypassPermissions");
  }
  // user message 는 마지막 positional argument.
  args.push(opts.userMessage);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => (stdout += c.toString("utf8")));
    child.stderr.on("data", c => (stderr += c.toString("utf8")));
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);
    child.on("error", err => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", code => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

