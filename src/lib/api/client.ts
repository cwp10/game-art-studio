/**
 * 클라이언트 측 fetch 래퍼. 클라이언트 컴포넌트에서만 사용.
 */
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { Generation, Message, PromptLibraryItem, Session, StylePreset } from "@/types/db";

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

/**
 * 외부 이미지 파일(사용자 업로드) 을 generation 행으로 저장. dataUrl 은 FileReader 로
 * 변환한 base64. backend='external', kind='text2img' + params.kindHint='external'.
 */
export async function uploadImage(args: {
  dataUrl: string;
  sessionId?: string | null;
  filename?: string;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "image",
      dataUrl: args.dataUrl,
      sessionId: args.sessionId ?? undefined,
      filename: args.filename,
    }),
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(`uploadImage failed: ${error ?? r.statusText}`);
  }
  return (await r.json()) as { generationId: string; width: number; height: number };
}

/**
 * LayerCanvas 가 만든 N(=4)개의 색별 PNG 를 한 번에 generation 행들로 저장.
 * 각 PNG 는 (원본 × 색별 binary mask) 합성 결과.
 */
export async function uploadLayers(
  parentGenerationId: string,
  layers: Array<{ colorLabel: string; dataUrl: string }>,
): Promise<Array<{ generationId: string; colorLabel: string; width: number; height: number }>> {
  const r = await fetch("/api/layers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentGenerationId, layers }),
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(`uploadLayers failed: ${error ?? r.statusText}`);
  }
  const { layers: out } = (await r.json()) as {
    layers: Array<{ generationId: string; colorLabel: string; width: number; height: number }>;
  };
  return out;
}

// ── style presets ───────────────────────────────────────────────────────────
export async function listPresets(): Promise<StylePreset[]> {
  const r = await fetch("/api/presets");
  const { presets } = (await r.json()) as { presets: StylePreset[] };
  return presets;
}

export async function createPreset(input: {
  name: string;
  description?: string;
  prompt_suffix: string;
  negative_suffix?: string;
}): Promise<StylePreset> {
  const r = await fetch("/api/presets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
  return ((await r.json()) as { preset: StylePreset }).preset;
}

export async function updatePreset(id: string, patch: Partial<StylePreset>): Promise<StylePreset> {
  const r = await fetch(`/api/presets/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
  return ((await r.json()) as { preset: StylePreset }).preset;
}

export async function deletePreset(id: string): Promise<void> {
  const r = await fetch(`/api/presets/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
}

// ── prompt library ──────────────────────────────────────────────────────────
export async function listPrompts(opts?: { search?: string; tag?: string }): Promise<PromptLibraryItem[]> {
  const sp = new URLSearchParams();
  if (opts?.search) sp.set("search", opts.search);
  if (opts?.tag) sp.set("tag", opts.tag);
  const r = await fetch(`/api/prompts${sp.toString() ? "?" + sp.toString() : ""}`);
  const { prompts } = (await r.json()) as { prompts: PromptLibraryItem[] };
  return prompts;
}

export async function createPrompt(input: { title: string; body: string; tags?: string[] }): Promise<PromptLibraryItem> {
  const r = await fetch("/api/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
  return ((await r.json()) as { prompt: PromptLibraryItem }).prompt;
}

export async function updatePrompt(
  id: string,
  patch: { title?: string; body?: string; tags?: string[] },
): Promise<PromptLibraryItem> {
  const r = await fetch(`/api/prompts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
  return ((await r.json()) as { prompt: PromptLibraryItem }).prompt;
}

export async function deletePrompt(id: string): Promise<void> {
  const r = await fetch(`/api/prompts/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
}

/** "사용" 액션 — use_count++, last_used_at=now. */
export async function bumpPromptUse(id: string): Promise<void> {
  await fetch(`/api/prompts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ use: true }),
  });
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
