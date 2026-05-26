/**
 * 클라이언트 측 fetch 래퍼. 클라이언트 컴포넌트에서만 사용.
 */
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { Generation, Message, Session } from "@/types/db";

export async function listSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  const { sessions } = (await r.json()) as { sessions: Session[] };
  return sessions;
}

export async function createSession(title?: string): Promise<Session> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const { session } = (await r.json()) as { session: Session };
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
}

export async function listMessages(sessionId: string): Promise<Message[]> {
  const r = await fetch(`/api/sessions/${sessionId}/messages`);
  const { messages } = (await r.json()) as { messages: Message[] };
  return messages;
}

/**
 * 캔버스에서 만든 마스크 PNG 를 generation 행으로 저장. PR-B 의 MaskCanvas 가 사용.
 * dataUrl 은 `canvas.toDataURL("image/png")` 결과 그대로.
 */
export async function uploadMask(parentGenerationId: string, dataUrl: string): Promise<string> {
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "mask", parentGenerationId, dataUrl }),
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(`uploadMask failed: ${error ?? r.statusText}`);
  }
  const { generationId } = (await r.json()) as { generationId: string };
  return generationId;
}

export async function listGenerations(sessionId?: string): Promise<Generation[]> {
  const url = sessionId ? `/api/generations?sessionId=${encodeURIComponent(sessionId)}` : "/api/generations";
  const r = await fetch(url);
  const { generations } = (await r.json()) as { generations: Generation[] };
  return generations;
}

/**
 * /api/chat 의 SSE 를 fetch 의 ReadableStream 으로 받아 한 줄씩 ChatEvent 로 디스패치.
 *
 * AbortSignal 지원 — 클라이언트에서 취소하면 서버가 spawned codex 도 정리하도록 라우트가 처리.
 */
export async function streamChat(
  body: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.body) throw new Error("no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 는 이벤트가 두 개의 개행으로 구분
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = raw.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine.slice(5).trim()) as ChatEvent;
        onEvent(event);
      } catch (e) {
        console.error("[sse parse]", e, raw);
      }
    }
  }
}
