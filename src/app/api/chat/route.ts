import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createSseStream, SSE_HEADERS } from "@/lib/sse/stream";
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { GenerationKind, MessageBlock } from "@/types/db";
import {
  createSession,
  getSession,
  touchSession,
  renameSession,
} from "@/lib/db/repo/sessions";
import { createMessage, lastClaudeSessionId } from "@/lib/db/repo/messages";
import { getGeneration, linkGeneration, createGeneration } from "@/lib/db/repo/generations";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { newJobId, newGenerationId } from "@/lib/util/ids";
import { spawnClaude, checkClaudeAvailable } from "@/lib/cli/claude-cli";
import { tailProgress } from "@/lib/cli/progress-tail";
import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { DATA_DIR, IMAGES_DIR, imagePath, toRelative } from "@/lib/util/paths";
import { parseIntent, type CodexIntent } from "@/lib/codex-orchestrator";

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
const APP_CONFIG_PATH = path.join(DATA_DIR, "config.json");

/**
 * data/config.json 의 orchestrator 설정. 파일 없거나 파싱 실패 시 Claude 기본값.
 * StatusButton 토글이 PATCH /api/config 로 쓴 값을 chat/route 가 이 함수로 읽어 분기.
 */
function readOrchestratorConfig(): "claude" | "codex" {
  try {
    const raw = fs.readFileSync(APP_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { orchestrator?: unknown };
    return cfg.orchestrator === "codex" ? "codex" : "claude";
  } catch {
    return "claude";
  }
}
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
  "mcp__imggen__reskin_image",
  "mcp__imggen__make_emote_sheet",
  "mcp__imggen__make_tileset",
  "mcp__imggen__generate_normal_map",
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

/**
 * 세션 제목 — 선행 directive/attachment 마커([spritesheet: ...], [reference: ...],
 * [mask: ...])를 벗겨 자연어 앞부분만 쓴다. 패널 생성 메시지가 마커로 시작해도
 * 사이드바 제목이 "[spritesheet: subjectTy..." 로 더러워지지 않게.
 */
function deriveSessionTitle(message: string): string {
  const cleaned = message.replace(/^(?:\s*\[[^\]]*\]\s*)+/, "").trim();
  return (cleaned || message.trim()).slice(0, 40) || "새 세션";
}

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.message || typeof body.message !== "string") {
    return Response.json({ error: "message required" }, { status: 400 });
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
    const titleSeed = deriveSessionTitle(body.message);
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
  // extractObject — Claude 가 inpaint_image 의 extractObject=true 로 사용.
  // 마스크가 있으면 마스크 영역 오브젝트를, 없으면 prompt 의 부위 이름을 투명 배경으로 추출.
  if (body.extractObject === true) markers.push(`[extract]`);
  const messageText = markers.length ? markers.join(" ") + "\n" + body.message : body.message;
  const userMsg = createMessage({
    session_id: sessionId,
    role: "user",
    content: [{ type: "text", text: messageText }],
    // 배치 멤버면 그룹 정보를 meta 로만 저장(본문 미오염). 재로드 시 그리드 복원에 사용.
    meta: body.batch ? { batch: body.batch } : null,
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

  // 5. 오케스트레이터 분기.
  //    - config 가 "codex" 면 Claude 체크 없이 바로 Codex 직접 모드(주 경로).
  //    - "claude" 면 가용성 확인 후, 미연결 시에만 Codex 로 자동 폴백.
  const orchestrator = readOrchestratorConfig();
  if (orchestrator === "codex" || !(await checkClaudeAvailable())) {
    // Claude 모드인데 미연결이라 폴백한 경우에만 안내 메시지를 붙인다(intent 무관 1줄).
    const autoFallback = orchestrator === "claude";
    try {
      await runChatCodexDirect({
        body, send, sessionId, isNewSession, jobId, messageText,
        autoFallback, signal: combinedAbort.signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      updateJob(jobId, { status: "failed", error: msg, ended_at: Date.now() });
      send({ type: "error", message: msg });
    } finally {
      sseSignal.removeEventListener("abort", onAbort);
      reqSignal.removeEventListener("abort", onAbort);
      close();
    }
    return;
  }

  // 6. Claude spawn — resume 가능하면 이어붙임
  let resumeId: string | null = lastClaudeSessionId(sessionId);
  const spawnOpts = {
    systemPrompt: getSystemPrompt(),
    mcpConfigPath: MCP_CONFIG_PATH,
    allowedTools: MCP_TOOL_NAMES,
    userMessage: messageText,
    logPrefix: `claude-${jobId}`,
    signal: combinedAbort.signal,
    cwd: process.cwd(),
  };

  // 7. 이벤트 소비. 종료 시점에 assistant 메시지를 한번에 저장.
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
    // resume 세션이 만료된 경우(이벤트 없이 exit 1) 새 세션으로 재시도.
    spawnLoop: for (let attempt = 0; attempt <= 1; attempt++) {
      const handle = spawnClaude({ ...spawnOpts, resumeSessionId: resumeId });
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
                kind: g?.kind,
                createdAt: g?.created_at,
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

        case "result": {
          if (!claudeSessionId && ev.sessionId) claudeSessionId = ev.sessionId;
          // result_type이 network_error 등 비정상이면 즉시 에러로 처리.
          const raw = ev.raw as Record<string, unknown>;
          const resultType = typeof raw?.result_type === "string" ? raw.result_type : null;
          if (resultType && resultType !== "success") {
            throw new Error(`claude ${resultType}`);
          }
          break;
        }

        case "raw":
          // 디버그: 모르는 메시지는 로그 파일에 이미 기록됨. SSE 로는 전달 안 함.
          break;
      }
    }

      const exit = await handle.done;
      if (exit !== 0) {
        // resume 세션 만료로 즉시 실패한 경우: 새 세션으로 재시도
        if (attempt === 0 && resumeId && !claudeSessionId && blocks.length === 0) {
          resumeId = null;
          continue spawnLoop;
        }
        throw new Error(`claude exited with code ${exit} (see data/logs/claude-${jobId}-*.log)`);
      }
      break spawnLoop;
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

    if (isNewSession) renameSession(sessionId, deriveSessionTitle(body.message));
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
  // 1) string 그대로 — 두 가지 형태를 처리:
  //    a) 텍스트: "Generated image ... Show it with image ref id \"<id>\"."
  //    b) JSON 직렬화된 structuredContent: '{"generationId":"<id>","imagePath":...}'
  //       (Claude CLI 2.x 가 structuredContent 를 JSON string 으로 content 에 담는 경우)
  if (typeof content === "string") {
    const idFromText = findIdInString(content);
    if (idFromText) return { generationId: idFromText, errorText: null };
    // JSON string fallback
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed && typeof parsed.generationId === "string" && /^[a-z0-9]{16}$/.test(parsed.generationId)) {
        return { generationId: parsed.generationId, errorText: null };
      }
    } catch { /* not JSON */ }
    return { generationId: null, errorText: content.slice(0, 200) || null };
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

/**
 * Claude CLI 없이 CodexExecBackend 를 직접 호출하는 경로.
 *
 * codex-orchestrator 의 parseIntent() 로 메시지를 도구 호출 명세로 해석한 뒤, 11개 도구를
 * MCP 서버와 동일한 흐름(job → backend.execute / sharp → generation 행)으로 실행한다.
 * generate_normal_map·resize_image 는 sharp 결정적 처리(codex 미경유), 나머지는 backend.execute.
 *
 * config.orchestrator==="codex" 면 주 경로, "claude" 인데 미연결이면 자동 폴백(autoFallback).
 * SSE 이벤트 포맷은 일반 경로와 동일 — 클라이언트가 차이를 몰라도 된다.
 */
async function runChatCodexDirect(opts: {
  body: ChatRequest;
  send: (e: ChatEvent) => void;
  sessionId: string;
  isNewSession: boolean;
  jobId: string;
  messageText: string;
  autoFallback: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { send, sessionId, isNewSession, jobId, messageText, autoFallback, signal } = opts;
  const toolCallId = `codex_${jobId}`;

  send({ type: "assistant_thinking" });
  // Claude 모드 자동 폴백일 때만 안내 1줄. Codex 주 모드는 정상 모드라 안내 없음.
  if (autoFallback) {
    send({ type: "assistant_text", text: "(Claude CLI 연결 안 됨 — Codex 모드로 전환합니다)\n" });
  }

  const intent = parseIntent(messageText);
  const toolDisplayName = `mcp__imggen__${intent.tool}`;

  // 입력 generationId → 디스크 절대 경로. 없거나 못 찾으면 null.
  const resolveImagePath = (generationId?: string): string | null => {
    if (!generationId) return null;
    const gen = getGeneration(generationId);
    return gen ? path.join(DATA_DIR, gen.image_path) : null;
  };

  // 참조 입력이 필요한 도구인데 첨부가 없으면 안내 후 종료.
  const needsInput: CodexIntent["tool"][] = [
    "edit_image", "upscale_image", "resize_image", "remove_background",
    "inpaint_image", "reskin_image", "generate_normal_map", "make_emote_sheet",
  ];
  if (needsInput.includes(intent.tool) && !intent.args.inputGenerationId) {
    send({ type: "assistant_text", text: "참조 이미지가 필요합니다. 결과 카드의 [참조] 버튼이나 업로드로 이미지를 먼저 첨부해 주세요." });
    updateJob(jobId, { status: "failed", error: "input image required", ended_at: Date.now() });
    return;
  }

  send({ type: "tool_call_started", toolCallId, name: toolDisplayName, args: intent.args });

  // ── 실행: sharp 전용(normal_map/resize) vs backend.execute ────────────────
  let outcome: { generationId: string; width: number; height: number; createdAt: number; kind: GenerationKind };
  try {
    if (intent.tool === "resize_image") {
      outcome = await runDirectResize({ sessionId, inputGenerationId: intent.args.inputGenerationId!, targetSize: intent.args.targetSize ?? 512 });
    } else if (intent.tool === "generate_normal_map") {
      outcome = await runDirectNormalMap({ sessionId, inputGenerationId: intent.args.inputGenerationId!, strength: intent.args.strength });
    } else {
      outcome = await runDirectBackendJob({ send, sessionId, toolCallId, intent, resolveImagePath, signal });
    }
  } catch (err) {
    send({ type: "tool_call_finished", toolCallId, result: { error: (err as Error).message } });
    throw err;
  }

  // ── assistant 메시지 영속화 + generation ownership ────────────────────────
  let assistantMsgId: string | null = null;
  try {
    const assistantMsg = createMessage({
      session_id: sessionId,
      role: "assistant",
      content: [
        { type: "tool_call", id: toolCallId, name: toolDisplayName, args: intent.args },
        { type: "tool_result", tool_call_id: toolCallId, result: `Generated via Codex. image ref id "${outcome.generationId}".` },
        { type: "image_ref", generation_id: outcome.generationId },
      ],
      claude_session_id: null,
    });
    linkGeneration(outcome.generationId, { session_id: sessionId, message_id: assistantMsg.id });
    updateJob(jobId, {
      status: "succeeded",
      result: { generationId: outcome.generationId, assistantMessageId: assistantMsg.id, generationIds: [outcome.generationId], codexDirect: true },
      ended_at: Date.now(),
    });
    assistantMsgId = assistantMsg.id;
  } catch (dbErr) {
    // DB 마무리 실패 — 이미지는 생성됐으므로 카드는 표시. 잡은 오류 로그만 남기고 계속.
    updateJob(jobId, { status: "failed", error: (dbErr as Error).message, ended_at: Date.now() });
  }

  // tool_call_finished: DB 성공/실패 무관하게 항상 전송 — 이미지 카드 표시
  send({
    type: "tool_call_finished",
    toolCallId,
    result: {
      generationId: outcome.generationId,
      imageUrl: `/api/images/${outcome.generationId}`,
      width: outcome.width,
      height: outcome.height,
      kind: outcome.kind,
      createdAt: outcome.createdAt,
    },
  });

  if (assistantMsgId) {
    send({ type: "message_completed", messageId: assistantMsgId });
    if (isNewSession) renameSession(sessionId, deriveSessionTitle(messageText));
    touchSession(sessionId);
  }
}

/** intent.tool → backend.execute 용 (kind, storeKind) 매핑. */
function codexJobKind(tool: CodexIntent["tool"], extractObject?: boolean): { kind: GenerationKind; storeKind: GenerationKind } {
  switch (tool) {
    case "generate_image": return { kind: "text2img", storeKind: "text2img" };
    case "make_spritesheet": return { kind: "spritesheet", storeKind: "spritesheet" };
    case "make_emote_sheet": return { kind: "emote_sheet", storeKind: "emote_sheet" };
    case "make_tileset": return { kind: "tileset", storeKind: "tileset" };
    case "edit_image": return { kind: "img2img", storeKind: "img2img" };
    case "upscale_image": return { kind: "upscale", storeKind: "upscale" };
    case "remove_background": return { kind: "remove_bg", storeKind: "remove_bg" };
    case "reskin_image": return { kind: "reskin", storeKind: "reskin" };
    case "inpaint_image":
      return extractObject
        ? { kind: "layer_extract", storeKind: "layer_extract" }
        : { kind: "inpaint", storeKind: "inpaint" };
    default:
      throw new Error(`codexJobKind: unsupported tool '${tool}'`);
  }
}

/**
 * codex 백엔드로 이미지 생성하는 공통 실행기. 입력 경로 조립 → ImageJob → backend.execute →
 * generation 행 작성. 스프라이트시트/리스킨의 무거운 후처리(normalize/chroma-key)는 MCP 서버
 * 전용이므로 여기선 backend 의 1차 결과를 그대로 사용(Codex 모드 best-effort).
 */
async function runDirectBackendJob(opts: {
  send: (e: ChatEvent) => void;
  sessionId: string;
  toolCallId: string;
  intent: CodexIntent;
  resolveImagePath: (id?: string) => string | null;
  signal: AbortSignal;
}): Promise<{ generationId: string; width: number; height: number; createdAt: number; kind: GenerationKind }> {
  const { send, sessionId, toolCallId, intent, resolveImagePath, signal } = opts;
  const { kind, storeKind } = codexJobKind(intent.tool, intent.args.extractObject);

  // 입력 이미지 경로 조립 — reskin(c) 은 [base, styleRef], inpaint(mask) 은 [원본, 마스크].
  const inputImagePaths: string[] = [];
  const inputGenerationIds: string[] = [];
  const basePath = resolveImagePath(intent.args.inputGenerationId);
  if (basePath) {
    inputImagePaths.push(basePath);
    inputGenerationIds.push(intent.args.inputGenerationId!);
  }
  let styleRefPath: string | undefined;
  if (intent.tool === "reskin_image" && intent.args.styleReferenceId) {
    const p = resolveImagePath(intent.args.styleReferenceId);
    if (p) {
      styleRefPath = p;
      inputImagePaths.push(p);
      inputGenerationIds.push(intent.args.styleReferenceId);
    }
  } else if (intent.tool === "inpaint_image" && intent.args.maskGenerationId) {
    const p = resolveImagePath(intent.args.maskGenerationId);
    if (p) {
      inputImagePaths.push(p);
      inputGenerationIds.push(intent.args.maskGenerationId);
    }
  }

  const params: Record<string, unknown> = {};
  if (intent.tool === "make_spritesheet") {
    params.seamlessLoop = intent.args.seamlessLoop === true;
    if (intent.args.subjectType) params.subjectType = intent.args.subjectType;
    if (intent.args.rows) params.rows = intent.args.rows;
    if (intent.args.cols) params.cols = intent.args.cols;
  }
  if (intent.tool === "reskin_image") {
    params.mode = styleRefPath ? "style_ref" : intent.args.paletteOnly ? "palette" : "appearance";
  }

  const prompt = intent.args.prompt ?? "";
  const innerJobId = newJobId();
  const generationId = newGenerationId();

  createJob({
    id: innerJobId,
    session_id: sessionId,
    kind: "codex_image",
    args: { tool: intent.tool, prompt, kind, generationId, inputGenerationIds, viaMcp: false },
  });

  const job: ImageJob = {
    id: innerJobId,
    generationId,
    kind,
    prompt,
    inputImagePaths: inputImagePaths.length ? inputImagePaths : undefined,
    styleRefPath,
    paletteOnly: intent.args.paletteOnly,
    params: Object.keys(params).length ? params : undefined,
  };

  const backend = await selectImageBackend();
  let result: Awaited<ReturnType<typeof backend.execute>>;
  try {
    result = await backend.execute(job, (stage, detail) => {
      send({ type: "tool_call_progress", toolCallId, stage, detail });
    }, signal);
  } catch (err) {
    updateJob(innerJobId, { status: "failed", error: (err as Error).message, ended_at: Date.now() });
    throw err;
  }

  const gen = createGeneration({
    id: generationId,
    session_id: sessionId,
    message_id: null,
    kind: storeKind,
    prompt,
    input_image_ids: inputGenerationIds,
    params: Object.keys(params).length ? params : undefined,
    image_path: toRelative(result.imagePath),
    width: result.width,
    height: result.height,
    backend: "codex_exec",
  });
  updateJob(innerJobId, { status: "succeeded", result: { generationId, elapsedMs: result.elapsedMs }, ended_at: Date.now() });

  return { generationId: gen.id, width: result.width, height: result.height, createdAt: gen.created_at, kind: storeKind };
}

/**
 * sharp lanczos 결정적 리사이즈 (codex 미경유). MCP server.ts runResizeTool 과 동일 로직.
 * 긴 변 기준 비율 유지(fit:inside), 알파 보존.
 */
async function runDirectResize(opts: {
  sessionId: string;
  inputGenerationId: string;
  targetSize: number;
}): Promise<{ generationId: string; width: number; height: number; createdAt: number; kind: GenerationKind }> {
  const inputGen = getGeneration(opts.inputGenerationId);
  if (!inputGen) throw new Error(`generation not found: ${opts.inputGenerationId}`);
  const inputPath = path.join(DATA_DIR, inputGen.image_path);

  const generationId = newGenerationId();
  const jobId = newJobId();
  const destPath = imagePath(generationId);

  createJob({
    id: jobId,
    session_id: opts.sessionId,
    kind: "codex_image",
    args: { tool: "resize_image", inputGenerationId: opts.inputGenerationId, targetSize: opts.targetSize, generationId, viaMcp: false },
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const startedAt = performance.now();
  const info = await sharp(inputPath)
    .resize(opts.targetSize, opts.targetSize, { kernel: "lanczos3", fit: "inside" })
    .png()
    .toFile(destPath);
  const elapsedMs = Math.round(performance.now() - startedAt);

  const gen = createGeneration({
    id: generationId,
    session_id: opts.sessionId,
    message_id: null,
    kind: "resize",
    prompt: `Resize longest side to ${opts.targetSize}px (→ ${info.width}×${info.height}, aspect preserved)`,
    input_image_ids: [opts.inputGenerationId],
    image_path: toRelative(destPath),
    width: info.width,
    height: info.height,
    backend: "direct",
  });
  updateJob(jobId, { status: "succeeded", result: { generationId: gen.id, elapsedMs }, ended_at: Date.now() });

  return { generationId: gen.id, width: info.width, height: info.height, createdAt: gen.created_at, kind: "resize" };
}

/**
 * sharp Sobel 기반 노멀맵 생성 (codex 미경유). MCP server.ts generate_normal_map 과 동일 로직.
 * RGB 인코딩: R=X기울기, G=Y기울기, B=255. 알파 채널 보존.
 */
async function runDirectNormalMap(opts: {
  sessionId: string;
  inputGenerationId: string;
  strength?: number;
}): Promise<{ generationId: string; width: number; height: number; createdAt: number; kind: GenerationKind }> {
  const inputGen = getGeneration(opts.inputGenerationId);
  if (!inputGen) throw new Error(`generation not found: ${opts.inputGenerationId}`);
  const inputPath = path.join(DATA_DIR, inputGen.image_path);
  const strength = typeof opts.strength === "number" ? Math.max(0.5, Math.min(2.0, opts.strength)) : 1.0;

  const generationId = newGenerationId();
  const jobId = newJobId();
  const outPath = imagePath(generationId);

  createJob({
    id: jobId,
    session_id: opts.sessionId,
    kind: "codex_image",
    args: { tool: "generate_normal_map", inputGenerationId: opts.inputGenerationId, generationId, viaMcp: false },
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const startedAt = performance.now();

  const meta = await sharp(inputPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("generate_normal_map: 이미지 크기 읽기 실패");

  const hasAlpha = meta.hasAlpha ?? false;
  let alphaBuf: Buffer | null = null;
  if (hasAlpha) {
    alphaBuf = await sharp(inputPath).extractChannel("alpha").raw().toBuffer();
  }

  const base = sharp(inputPath).flatten({ background: { r: 128, g: 128, b: 128 } }).greyscale();
  const scale = Math.round(1.0 / strength);
  const k = strength;
  const [rBuf, gBuf] = await Promise.all([
    base.clone().convolve({ width: 3, height: 3, kernel: [-k, 0, k, -2 * k, 0, 2 * k, -k, 0, k].map(Math.round), scale, offset: 128 }).raw().toBuffer(),
    base.clone().convolve({ width: 3, height: 3, kernel: [-k, -2 * k, -k, 0, 0, 0, k, 2 * k, k].map(Math.round), scale, offset: 128 }).raw().toBuffer(),
  ]);

  const pixels = width * height;
  const channels = hasAlpha ? 4 : 3;
  const out = Buffer.alloc(pixels * channels, 0);
  for (let i = 0; i < pixels; i++) {
    const alpha = alphaBuf ? alphaBuf[i] : 255;
    if (alpha < 10) {
      out[i * channels] = 128; out[i * channels + 1] = 128; out[i * channels + 2] = 255;
    } else {
      out[i * channels] = rBuf[i]; out[i * channels + 1] = gBuf[i]; out[i * channels + 2] = 255;
    }
    if (channels === 4) out[i * channels + 3] = alpha;
  }

  await sharp(out, { raw: { width, height, channels } }).png().toFile(outPath);
  const elapsedMs = Math.round(performance.now() - startedAt);

  const gen = createGeneration({
    id: generationId,
    session_id: opts.sessionId,
    message_id: null,
    kind: "normal_map",
    prompt: `Normal map from ${opts.inputGenerationId} (strength=${strength})`,
    input_image_ids: [opts.inputGenerationId],
    image_path: toRelative(outPath),
    width,
    height,
    backend: "direct",
  });
  updateJob(jobId, { status: "succeeded", result: { generationId: gen.id, elapsedMs }, ended_at: Date.now() });

  return { generationId: gen.id, width, height, createdAt: gen.created_at, kind: "normal_map" };
}
