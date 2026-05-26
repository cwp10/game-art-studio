import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { createSseStream, SSE_HEADERS } from "@/lib/sse/stream";
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { MessageBlock } from "@/types/db";
import {
  createSession,
  getSession,
  touchSession,
  renameSession,
} from "@/lib/db/repo/sessions";
import { createMessage, lastClaudeSessionId } from "@/lib/db/repo/messages";
import { getGeneration, linkGeneration } from "@/lib/db/repo/generations";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { newJobId } from "@/lib/util/ids";
import { spawnClaude } from "@/lib/cli/claude-cli";

/**
 * POST /api/chat — SSE 스트림 (M3: Claude → MCP → Codex 체인).
 *
 * 이전 단순 경로(직접 ImageBackend 호출) 는 폐기. 모든 메시지는 Claude CLI 가 받아
 * orchestrator system prompt 에 따라 `generate_image` MCP 도구를 호출하고,
 * 그 MCP 도구가 다시 `codex exec` 로 imagegen 스킬을 발동한다.
 *
 * SSE 이벤트 매핑:
 *  Claude stream-json   →  ChatEvent
 *  ───────────────────     ──────────────────────────────
 *  system/init          →  (Next 가 claude_session_id 만 저장)
 *  assistant.text       →  assistant_text
 *  assistant.tool_use   →  tool_call_started
 *  user.tool_result     →  tool_call_finished
 *  result               →  message_completed
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_CONFIG_PATH = path.join(process.cwd(), "data", "mcp.json");
const SYSTEM_PROMPT_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "prompt",
  "system-orchestrator.md",
);
const MCP_TOOL_NAME = "mcp__imggen__generate_image";

let cachedSystemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (cachedSystemPrompt == null) {
    cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  }
  return cachedSystemPrompt;
}

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }
  if (!body.message || typeof body.message !== "string") {
    return new Response(JSON.stringify({ error: "message required" }), { status: 400 });
  }

  const { stream, send, close, signal } = createSseStream<ChatEvent>();

  runChat(body, send, close, signal, req.signal).catch(err => {
    send({ type: "error", message: (err as Error).message });
    close();
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

async function runChat(
  body: ChatRequest,
  send: (e: ChatEvent) => void,
  close: () => void,
  sseSignal: AbortSignal,
  reqSignal: AbortSignal,
): Promise<void> {
  // 1. 세션 확보
  let sessionId = body.sessionId;
  let isNewSession = false;
  if (sessionId && !getSession(sessionId)) sessionId = undefined;
  if (!sessionId) {
    const titleSeed = body.message.trim().slice(0, 40) || "새 세션";
    sessionId = createSession(titleSeed).id;
    isNewSession = true;
  }

  // 2. user 메시지 기록
  const userMsg = createMessage({
    session_id: sessionId,
    role: "user",
    content: [{ type: "text", text: body.message }],
  });
  send({ type: "session_started", sessionId, messageId: userMsg.id });

  // 3. orchestrator job 기록 (디버깅용)
  const jobId = newJobId();
  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "claude_orchestrate",
    args: { message: body.message },
  });

  // 4. abort 합치기
  const combinedAbort = new AbortController();
  const onAbort = () => combinedAbort.abort();
  sseSignal.addEventListener("abort", onAbort, { once: true });
  reqSignal.addEventListener("abort", onAbort, { once: true });

  // 5. Claude spawn — resume 가능하면 이어붙임
  const resumeId = lastClaudeSessionId(sessionId);
  const handle = spawnClaude({
    systemPrompt: getSystemPrompt(),
    mcpConfigPath: MCP_CONFIG_PATH,
    allowedTools: [MCP_TOOL_NAME],
    resumeSessionId: resumeId,
    userMessage: body.message,
    logPrefix: `claude-${jobId}`,
    signal: combinedAbort.signal,
    cwd: process.cwd(),
  });

  // 6. 이벤트 소비. 종료 시점에 assistant 메시지를 한번에 저장.
  const blocks: MessageBlock[] = [];
  const accumulatedText: string[] = [];
  const generationIds: string[] = [];
  // imggen 외 도구(예: Claude CLI 의 내장 ToolSearch)는 SSE 로 forward 하지 않는다.
  // 우리 UI 가 표시할 의미가 없고, false-alarm 에러 카드를 만들지 않기 위해서.
  const imggenToolUseIds = new Set<string>();
  let claudeSessionId: string | null = null;
  send({ type: "assistant_thinking" });

  try {
    for await (const ev of handle.events) {
      switch (ev.kind) {
        case "session_init":
          claudeSessionId = ev.sessionId;
          break;

        case "assistant_text": {
          accumulatedText.push(ev.text);
          blocks.push({ type: "text", text: ev.text });
          send({ type: "assistant_text", text: ev.text });
          break;
        }

        case "tool_use": {
          // imggen 도구만 UI 에 노출. 그 외(예: Claude CLI 내장 메타 도구) 는 무시.
          if (!ev.name.startsWith("mcp__imggen__")) break;
          imggenToolUseIds.add(ev.toolUseId);
          blocks.push({
            type: "tool_call",
            id: ev.toolUseId,
            name: ev.name,
            args: ev.input,
          });
          send({
            type: "tool_call_started",
            toolCallId: ev.toolUseId,
            name: ev.name,
            args: ev.input,
          });
          break;
        }

        case "tool_result": {
          // 우리 도구의 결과만 처리. 메타 도구는 silent drop.
          if (!imggenToolUseIds.has(ev.toolUseId)) break;
          const { generationId, errorText } = extractGenerationId(ev.content);
          blocks.push({
            type: "tool_result",
            tool_call_id: ev.toolUseId,
            result: ev.content,
          });
          if (generationId) {
            generationIds.push(generationId);
            blocks.push({ type: "image_ref", generation_id: generationId });
            const g = getGeneration(generationId);
            send({
              type: "tool_call_finished",
              toolCallId: ev.toolUseId,
              result: {
                generationId,
                imageUrl: `/api/images/${generationId}`,
                width: g?.width ?? 0,
                height: g?.height ?? 0,
              },
            });
          } else {
            send({
              type: "tool_call_finished",
              toolCallId: ev.toolUseId,
              result: { error: errorText ?? "no generationId in tool result" },
            });
          }
          break;
        }

        case "result":
          if (!claudeSessionId && ev.sessionId) claudeSessionId = ev.sessionId;
          break;

        case "raw":
          // 디버그: 모르는 메시지는 로그 파일에 이미 기록됨. SSE 로는 전달 안 함.
          break;
      }
    }

    const exit = await handle.done;
    if (exit !== 0) {
      throw new Error(`claude exited with code ${exit} (see data/logs/claude-${jobId}-*.log)`);
    }

    // 7. assistant 메시지 영구화 + generation 들 ownership 채우기
    const assistantMsg = createMessage({
      session_id: sessionId,
      role: "assistant",
      content: blocks,
      claude_session_id: claudeSessionId,
    });
    for (const gid of generationIds) {
      linkGeneration(gid, { session_id: sessionId, message_id: assistantMsg.id });
    }

    updateJob(jobId, {
      status: "succeeded",
      result: {
        claudeSessionId,
        assistantMessageId: assistantMsg.id,
        generationIds,
      },
      ended_at: Date.now(),
    });

    send({ type: "message_completed", messageId: assistantMsg.id });

    if (isNewSession) renameSession(sessionId, body.message.trim().slice(0, 40));
    touchSession(sessionId);
  } catch (err) {
    const msg = (err as Error).message;
    updateJob(jobId, { status: "failed", error: msg, ended_at: Date.now() });
    send({ type: "error", message: msg });
    // partial blocks 라도 assistant 메시지로 저장해서 UI 가 빈 답이 안 되게.
    if (blocks.length > 0) {
      const assistantMsg = createMessage({
        session_id: sessionId,
        role: "assistant",
        content: blocks,
        claude_session_id: claudeSessionId,
      });
      for (const gid of generationIds) {
        linkGeneration(gid, { session_id: sessionId, message_id: assistantMsg.id });
      }
    }
  } finally {
    sseSignal.removeEventListener("abort", onAbort);
    reqSignal.removeEventListener("abort", onAbort);
    close();
    // assistant_text 의 합쳐진 본문이 너무 짧으면 무시. 단지 디버그용.
    if (accumulatedText.length === 0) {
      // 의도적 침묵: orchestrator 가 텍스트 없이 도구만 호출했을 가능성.
    }
  }
}

/**
 * MCP 도구의 tool_result content 에서 generationId 를 뽑는다.
 *
 * MCP 서버는 다음 형태로 응답:
 *   content: [{ type: "text", text: "Generated image <id> (...). Show it with image ref id \"<id>\"." }]
 *   structuredContent: { generationId, imagePath, width, height, elapsedMs }
 *
 * Claude 가 우리에게 user/tool_result 로 echo 할 때 content 는 보통 위 content 배열 그대로
 * 또는 string 으로 들어온다. 두 경우 모두 처리.
 */
function extractGenerationId(content: unknown): {
  generationId: string | null;
  errorText: string | null;
} {
  // 1) string 그대로
  if (typeof content === "string") {
    return { generationId: findIdInString(content), errorText: null };
  }
  // 2) array of blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        const id = findIdInString(block);
        if (id) return { generationId: id, errorText: null };
      } else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          const id = findIdInString(b.text);
          if (id) return { generationId: id, errorText: null };
        }
      }
    }
    // 에러 텍스트 회수
    const errParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { text?: string };
        if (typeof b.text === "string") errParts.push(b.text);
      }
    }
    return { generationId: null, errorText: errParts.join(" ") || null };
  }
  return { generationId: null, errorText: null };
}

const GEN_ID_REGEX = /image ref id\s*"([a-z0-9]{16})"/i;
const GEN_ID_FALLBACK = /\b([a-z0-9]{16})\b/;
function findIdInString(s: string): string | null {
  const m1 = s.match(GEN_ID_REGEX);
  if (m1) return m1[1];
  const m2 = s.match(GEN_ID_FALLBACK);
  return m2 ? m2[1] : null;
}
