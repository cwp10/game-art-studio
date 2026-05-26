import { NextRequest } from "next/server";
import { createSseStream, SSE_HEADERS } from "@/lib/sse/stream";
import type { ChatEvent, ChatRequest } from "@/types/chat";
import { createSession, getSession, touchSession, renameSession } from "@/lib/db/repo/sessions";
import { createMessage } from "@/lib/db/repo/messages";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { newGenerationId, newId, newJobId } from "@/lib/util/ids";
import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { DATA_DIR, toRelative } from "@/lib/util/paths";
import path from "node:path";

/**
 * POST /api/chat — SSE 스트림.
 *
 * 이번 단계(M1·M2)는 Claude CLI 미도입 단순 경로:
 *   메시지 → 그대로 ImageBackend.execute 호출 → 결과 카드.
 *
 * Claude CLI orchestrator 도입(M3)은 이 라우트 안에서 ImageBackend 호출 자리를
 * Claude→MCP→ImageBackend 체인으로 바꿔 끼우는 형태.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // 워커 루프는 비동기로 실행. await 하지 않음 (stream 을 즉시 반환).
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
  if (sessionId) {
    const existing = getSession(sessionId);
    if (!existing) {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const titleSeed = body.message.trim().slice(0, 40) || "새 세션";
    const s = createSession(titleSeed);
    sessionId = s.id;
    isNewSession = true;
  }

  // 2. user 메시지 기록
  const userMsg = createMessage({
    session_id: sessionId,
    role: "user",
    content: [{ type: "text", text: body.message }],
  });
  send({ type: "session_started", sessionId, messageId: userMsg.id });

  // 3. (이번 단계엔 Claude orchestration 없이) 바로 tool call 송출
  const toolCallId = newId(10);
  const generationId = newGenerationId();
  const jobId = newJobId();
  const kind: ImageJob["kind"] = inferKind(body.message);

  // 입력 이미지 첨부 (img2img/inpaint)
  const inputImagePaths: string[] = [];
  if (body.attachmentGenerationIds?.length) {
    for (const gid of body.attachmentGenerationIds) {
      const g = getGeneration(gid);
      if (g) inputImagePaths.push(path.join(DATA_DIR, g.image_path));
    }
  }

  send({
    type: "tool_call_started",
    toolCallId,
    name: kind === "text2img" ? "generate_image" : kind,
    args: { prompt: body.message, kind, attachmentCount: inputImagePaths.length },
  });

  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "codex_image",
    args: { prompt: body.message, kind, generationId },
    work_dir: null,
  });

  // 합쳐진 abort 핸들 (클라이언트가 SSE 를 끊거나 Next 가 요청을 abort 하면 둘 다 트리거)
  const combinedAbort = new AbortController();
  const onAbort = () => combinedAbort.abort();
  sseSignal.addEventListener("abort", onAbort, { once: true });
  reqSignal.addEventListener("abort", onAbort, { once: true });

  try {
    const backend = await selectImageBackend();
    const result = await backend.execute(
      { id: jobId, generationId, kind, prompt: body.message, inputImagePaths },
      (stage, detail) => {
        send({ type: "tool_call_progress", toolCallId, stage, detail });
      },
      combinedAbort.signal,
    );

    // 4. generation 영구화
    const gen = createGeneration({
      id: generationId,
      session_id: sessionId,
      message_id: userMsg.id,
      kind,
      prompt: body.message,
      input_image_ids: body.attachmentGenerationIds ?? [],
      params: {},
      image_path: toRelative(result.imagePath),
      width: result.width,
      height: result.height,
      backend: "codex_exec",
    });
    updateJob(jobId, {
      status: "succeeded",
      result: { generationId: gen.id, elapsedMs: result.elapsedMs },
      ended_at: Date.now(),
    });

    // 5. assistant 메시지 기록 (image_ref 블록)
    const assistantMsg = createMessage({
      session_id: sessionId,
      role: "assistant",
      content: [
        { type: "tool_call", id: toolCallId, name: kind, args: { prompt: body.message } },
        { type: "tool_result", tool_call_id: toolCallId, result: { generationId: gen.id } },
        { type: "image_ref", generation_id: gen.id },
      ],
    });

    send({
      type: "tool_call_finished",
      toolCallId,
      result: {
        generationId: gen.id,
        imageUrl: `/api/images/${gen.id}`,
        width: gen.width ?? 0,
        height: gen.height ?? 0,
      },
    });
    send({ type: "message_completed", messageId: assistantMsg.id });

    // 새 세션이면 첫 메시지를 title 로 채택 (이미 createSession 에서 시드됐지만 명시)
    if (isNewSession) renameSession(sessionId, body.message.trim().slice(0, 40));
    touchSession(sessionId);
  } catch (err) {
    const msg = (err as Error).message;
    updateJob(jobId, { status: "failed", error: msg, ended_at: Date.now() });
    send({ type: "tool_call_finished", toolCallId, result: { error: msg } });
    send({ type: "error", message: msg });
  } finally {
    sseSignal.removeEventListener("abort", onAbort);
    reqSignal.removeEventListener("abort", onAbort);
    close();
  }
}

/** 단순 휴리스틱: 메시지 내용 보고 kind 추정. M3 이후 Claude 가 결정하게 바뀜. */
function inferKind(message: string): ImageJob["kind"] {
  const m = message.toLowerCase();
  if (m.includes("스프라이트") || m.includes("sprite") || m.includes("4x4") || m.includes("8x8"))
    return "spritesheet";
  return "text2img";
}
