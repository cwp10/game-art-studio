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
import { tailProgress } from "@/lib/cli/progress-tail";

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
/**
 * Claude 에게 노출할 imggen MCP 도구들. Claude CLI 의 --allowedTools 는 정확한 이름을
 * 필요로 하므로 도구 추가 시 여기 함께 등록해야 한다 (그러지 않으면 도구 호출이 거부됨).
 */
const MCP_TOOL_NAMES = [
  "mcp__imggen__generate_image",
  "mcp__imggen__make_spritesheet",
  "mcp__imggen__edit_image",
  "mcp__imggen__upscale_image",
  "mcp__imggen__resize_image",
  "mcp__imggen__remove_background",
  "mcp__imggen__inpaint_image",
];

let cachedSystemPrompt: string | null = null;
let cachedSystemPromptMtime = 0;
function getSystemPrompt(): string {
  try {
    const mtime = fs.statSync(SYSTEM_PROMPT_PATH).mtimeMs;
    if (cachedSystemPrompt == null || mtime !== cachedSystemPromptMtime) {
      cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
      cachedSystemPromptMtime = mtime;
    }
  } catch {
    if (!cachedSystemPrompt) throw new Error(`system prompt not found: ${SYSTEM_PROMPT_PATH}`);
  }
  return cachedSystemPrompt!;
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

  // 2. user 메시지 기록.
  //    첨부 generation 이 있으면 메시지 본문에 marker 를 prefix 해서 Claude 가
  //    inputGenerationId / maskGenerationId 로 사용할 수 있게 한다. DB 에 저장되는
  //    본문도 동일 — 후속 리로드 시 채팅창에 그대로 보이지만 marker 는 사용자에게도
  //    정직한 표기.
  const attachIds = (body.attachmentGenerationIds ?? []).filter(id => !!getGeneration(id));
  const maskId =
    body.maskGenerationId && getGeneration(body.maskGenerationId) ? body.maskGenerationId : null;
  const markers: string[] = [];
  for (const id of attachIds) markers.push(`[reference: ${id}]`);
  if (maskId) markers.push(`[mask: ${maskId}]`);
  const messageText = markers.length ? markers.join(" ") + "\n" + body.message : body.message;
  const userMsg = createMessage({
    session_id: sessionId,
    role: "user",
    content: [{ type: "text", text: messageText }],
  });
  send({ type: "session_started", sessionId, messageId: userMsg.id });

  // 3. orchestrator job 기록 (디버깅용)
  const jobId = newJobId();
  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "claude_orchestrate",
    args: { message: messageText, attachIds, maskId },
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
    allowedTools: MCP_TOOL_NAMES,
    resumeSessionId: resumeId,
    userMessage: messageText,
    logPrefix: `claude-${jobId}`,
    signal: combinedAbort.signal,
    cwd: process.cwd(),
  });

  // 6. 이벤트 소비. 종료 시점에 assistant 메시지를 한번에 저장.
  const turnStartTime = Date.now();
  const blocks: MessageBlock[] = [];
  const accumulatedText: string[] = [];
  const generationIds: string[] = [];
  // imggen 외 도구(예: Claude CLI 의 내장 ToolSearch)는 SSE 로 forward 하지 않는다.
  // 우리 UI 가 표시할 의미가 없고, false-alarm 에러 카드를 만들지 않기 위해서.
  const imggenToolUseIds = new Set<string>();
  // 각 imggen tool_use 마다 progress.jsonl tail 핸들. tool_result 또는 finally 에서 stop.
  const progressTails = new Map<string, ReturnType<typeof tailProgress>>();
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
          // MCP 도구가 별도 프로세스라 stage 를 직접 못 받음.
          // jobs 테이블에서 새 codex_image 행을 polling 으로 찾고 그 progress.jsonl 을 tail.
          const tail = tailProgress({
            turnStartTime,
            onEvent: ({ stage, detail }) => {
              send({ type: "tool_call_progress", toolCallId: ev.toolUseId, stage, detail });
            },
          });
          progressTails.set(ev.toolUseId, tail);
          break;
        }

        case "tool_result": {
          // 우리 도구의 결과만 처리. 메타 도구는 silent drop.
          if (!imggenToolUseIds.has(ev.toolUseId)) break;
          progressTails.get(ev.toolUseId)?.stop();
          progressTails.delete(ev.toolUseId);
          // 디버그: tool_result content 원형 로그 (generationId 파싱 실패 분석용)
          // structuredContent 가 content 로 에코되면 object 형태로 올 수 있음.
          let rawContentDbg: string;
          try { rawContentDbg = JSON.stringify(ev.content).slice(0, 300); } catch { rawContentDbg = String(ev.content); }
          console.log(`[route] tool_result toolUseId=${ev.toolUseId} content=${rawContentDbg}`);
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
    // 남은 progress tail 정리 (도구 응답이 안 와도 leak 안 되게)
    for (const tail of progressTails.values()) tail.stop();
    progressTails.clear();
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
 * Claude CLI 버전에 따라 structuredContent 를 content 자리에 object 로 에코하는 경우도
 * 방어 처리 (case 3).
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
  // 3) structuredContent 가 content 로 에코된 경우 — { generationId: "<id>", ... }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    // structuredContent 에 직접 generationId 가 있는 경우
    if (typeof obj.generationId === "string" && /^[a-z0-9]{16}$/.test(obj.generationId)) {
      return { generationId: obj.generationId, errorText: null };
    }
    // { content: [...] } 로 한 번 더 감싸진 경우
    if (Array.isArray(obj.content)) {
      return extractGenerationId(obj.content);
    }
  }
  return { generationId: null, errorText: null };
}

// MCP 서버는 항상 `Show it with image ref id "<id>".` 형태로 응답하므로
// 이 패턴으로만 추출. 느슨한 fallback 정규식은 오탐(에러 메시지 내 16자 문자열) 위험.
const GEN_ID_REGEX = /image ref id\s*"([a-z0-9]{16})"/i;
function findIdInString(s: string): string | null {
  return s.match(GEN_ID_REGEX)?.[1] ?? null;
}
