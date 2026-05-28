/**
 * 클라이언트 측 fetch 래퍼. 클라이언트 컴포넌트에서만 사용.
 */
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { Generation, Message, PromptLibraryItem, Session, StylePreset } from "@/types/db";

export async function listSessions(opts?: { search?: string }): Promise<Session[]> {
  const sp = new URLSearchParams();
  if (opts?.search) sp.set("search", opts.search);
  const r = await fetch(`/api/sessions${sp.toString() ? "?" + sp.toString() : ""}`);
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

export async function renameSession(id: string, title: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function listMessages(sessionId: string, signal?: AbortSignal): Promise<Message[]> {
  const r = await fetch(`/api/sessions/${sessionId}/messages`, { signal });
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
 * 변환한 base64. backend='external', kind='external'.
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
  layers: Array<{ colorLabel: string; name?: string; dataUrl: string }>,
): Promise<
  Array<{ generationId: string; colorLabel: string; name?: string; width: number; height: number }>
> {
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
    layers: Array<{
      generationId: string;
      colorLabel: string;
      name?: string;
      width: number;
      height: number;
    }>;
  };
  return out;
}

/**
 * 결정적 색교체(리스킨 정밀 모드) — codex 없이 sharp 로 픽셀 단위 색 매핑.
 * 형태 100% 보존. 결과는 kind='reskin' generation.
 */
export async function recolorImage(args: {
  parentGenerationId: string;
  mappings: Array<{ from: string; to: string; tolerance?: number }>;
  includeGrays?: boolean;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await fetch("/api/reskin/recolor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(`recolorImage failed: ${error ?? r.statusText}`);
  }
  return (await r.json()) as { generationId: string; width: number; height: number };
}

export type Suggestion = { label: string; body: string };

/**
 * 짧은 의도 → 게임 에셋 prompt 후보 3-4개. Claude 가 맥락 유추해서 라벨 + 본문
 * 형태로 제안. 30~60초 + 구독 한도 소모.
 *
 * 본문은 스타일/방향/첨부 미포함 — 사용자가 카드 선택 후 별도 picker 로 결합.
 */
export async function suggestPrompts(input: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const r = await fetch("/api/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal,
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(error ?? r.statusText);
  }
  return ((await r.json()) as { suggestions: Suggestion[] }).suggestions;
}

/**
 * 레이어 분리용 "분리 가능한 부위" 라벨 4-6개 제안. generation 의 생성 prompt 를 보고
 * Claude 가 추론 (이미지 vision 아님). LayerCanvas 의 부위명 chip 에 사용.
 *
 * 실패 시 빈 배열 반환 — UI 가 graceful 하게 처리 (throw 안 함).
 */
export async function suggestLayerParts(generationId: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const r = await fetch("/api/layer-parts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId }),
      signal,
    });
    if (!r.ok) return [];
    return ((await r.json()) as { parts?: string[] }).parts ?? [];
  } catch {
    return [];
  }
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

/** 단일 generation 조회 — params(스프라이트 그리드/방향/앵커 등) 포함. 없으면 null. */
export async function getGeneration(id: string): Promise<{
  id: string;
  kind: string;
  params: Record<string, unknown>;
  width: number | null;
  height: number | null;
  imageUrl: string;
} | null> {
  const r = await fetch(`/api/generations/${id}`);
  if (!r.ok) return null;
  return (await r.json()) as {
    id: string;
    kind: string;
    params: Record<string, unknown>;
    width: number | null;
    height: number | null;
    imageUrl: string;
  };
}

/**
 * SpriteCanvas 가 보정한 스프라이트시트 PNG 를 새 generation(kind='spritesheet')으로 저장.
 * 원본 보존(비파괴) — 보정본은 별도 행. params(rows/cols/anchor/directions 등)를 보존해
 * 재오픈·.json export 가 동작. parentGenerationId 는 lineage(input_image_ids) 기록.
 */
export async function uploadSpritesheet(args: {
  dataUrl: string;
  parentGenerationId?: string;
  sessionId?: string | null;
  params?: Record<string, unknown>;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "spritesheet",
      dataUrl: args.dataUrl,
      parentGenerationId: args.parentGenerationId,
      sessionId: args.sessionId ?? undefined,
      params: args.params,
    }),
  });
  if (!r.ok) {
    const { error } = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(`uploadSpritesheet failed: ${error ?? r.statusText}`);
  }
  return (await r.json()) as { generationId: string; width: number; height: number };
}

export async function listGenerations(opts?: { sessionId?: string; kind?: string; search?: string; limit?: number }): Promise<Generation[]> {
  const sp = new URLSearchParams();
  if (opts?.sessionId) sp.set("sessionId", opts.sessionId);
  if (opts?.kind) sp.set("kind", opts.kind);
  if (opts?.search) sp.set("search", opts.search);
  if (opts?.limit) sp.set("limit", String(opts.limit));
  const r = await fetch(`/api/generations${sp.toString() ? "?" + sp.toString() : ""}`);
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
