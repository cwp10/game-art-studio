/**
 * 클라이언트 측 fetch 래퍼. 클라이언트 컴포넌트에서만 사용.
 */
import type { UploadResultDTO } from "@/types/api";
import type { ChatEvent, ChatRequest } from "@/types/chat";
import type { Generation, Message, PromptLibraryItem, Session, StylePreset } from "@/types/db";

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/** POST/PATCH/DELETE + JSON body init 보일러플레이트 축약. */
export function jsonFetch(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method,
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ...(signal !== undefined && { signal }),
  });
}

/** not-ok Response 에서 에러 메시지 추출. json 파싱 실패 시 statusText 로 폴백. */
async function extractError(r: Response): Promise<string> {
  const body = await r.json().catch(() => ({})) as { error?: string };
  return body.error ?? r.statusText;
}

/** URLSearchParams 를 URL 에 붙이는 헬퍼. undefined 값은 자동 제외. */
function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

export async function listSessions(opts?: { search?: string }): Promise<Session[]> {
  const r = await fetch(buildUrl("/api/sessions", { search: opts?.search }));
  const { sessions } = (await r.json()) as { sessions: Session[] };
  return sessions;
}

export async function createSession(title?: string): Promise<Session> {
  const r = await jsonFetch("/api/sessions", "POST", { title });
  const { session } = (await r.json()) as { session: Session };
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  await jsonFetch(`/api/sessions/${id}`, "DELETE");
}

export async function renameSession(id: string, title: string): Promise<void> {
  await jsonFetch(`/api/sessions/${id}`, "PATCH", { title });
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
  const r = await jsonFetch("/api/upload", "POST", { kind: "mask", parentGenerationId, dataUrl });
  if (!r.ok) throw new Error(`uploadMask failed: ${await extractError(r)}`);
  const { generationId } = (await r.json()) as UploadResultDTO;
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
  const r = await jsonFetch("/api/upload", "POST", {
    kind: "image",
    dataUrl: args.dataUrl,
    sessionId: args.sessionId ?? undefined,
    filename: args.filename,
  });
  if (!r.ok) throw new Error(`uploadImage failed: ${await extractError(r)}`);
  return (await r.json()) as { generationId: string; width: number; height: number };
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
  const r = await jsonFetch("/api/reskin/recolor", "POST", args);
  if (!r.ok) throw new Error(`recolorImage failed: ${await extractError(r)}`);
  return (await r.json()) as { generationId: string; width: number; height: number };
}

/**
 * 여러 레이어를 한 캔버스에 합성(flatten) — POST /api/composite (sharp). CanvasEditor 가 사용.
 * 레이어별 transform(scale·rotation·flip·stretch)과 filters 를 그대로 전달. 신규 필드는 전부
 * 옵셔널 — 미지정 시 기존 동작과 동일(하위호환). 결과는 kind='composite' generation.
 */
export type CompositeLayerArg = {
  generationId: string;
  opacity?: number; // 0~100
  x?: number; // 출력 캔버스 중앙 기준 px
  y?: number;
  scale?: number; // 1.0 = contain-fit (targetW/H 없을 때만 사용)
  rotation?: number; // 도(°), 시계방향
  flipH?: boolean; // 좌우반전
  stretchW?: number; // 가로 늘이기 배수 (1.0=원본)
  stretchH?: number; // 세로 늘이기 배수 (1.0=원본)
  filters?: {
    brightness?: number; // % (100=중립)
    saturation?: number; // % (100=중립)
    hue?: number; // ° (0=중립)
    contrast?: number; // % (100=중립)
    blur?: number; // px (0=없음)
  };
  targetW?: number; // 출력 픽셀 너비 (WYSIWYG 계산값)
  targetH?: number; // 출력 픽셀 높이
};

export async function compositeScene(args: {
  layers: CompositeLayerArg[];
  sessionId?: string;
  outputWidth?: number;
  outputHeight?: number;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await jsonFetch("/api/composite", "POST", args);
  if (!r.ok) throw new Error(`compositeScene failed: ${await extractError(r)}`);
  return (await r.json()) as { generationId: string; width: number; height: number };
}

/**
 * AI 합성 — POST /api/composite-ai. compositeScene 과 동일하게 레이어를 sharp 로 평탄화한 뒤
 * Codex img2img 로 한 번 더 재생성해 자연스럽게 합성한다. 합성 프롬프트는 서버가 평탄화 이미지를
 * Claude Vision 으로 분석해 자동 생성하므로 prompt 는 보낼 필요가 없다(선택).
 * Codex 실행이 끝날 때까지 블로킹(수십 초). 결과는 최종 img2img generation.
 */
export async function compositeSceneAI(args: {
  layers: CompositeLayerArg[];
  sessionId?: string;
  outputWidth?: number;
  outputHeight?: number;
  prompt?: string;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await jsonFetch("/api/composite-ai", "POST", args);
  if (!r.ok) throw new Error(`compositeSceneAI failed: ${await extractError(r)}`);
  return (await r.json()) as { generationId: string; width: number; height: number };
}

/** 단일 이미지 sharp 필터(여백제거 trim 등) — 결정적. 결과 generation 반환. */
export async function filterImage(args: {
  generationId: string;
  filter: string;
  param?: number;
}): Promise<{ generationId: string; width: number; height: number }> {
  const r = await jsonFetch("/api/filter", "POST", args);
  if (!r.ok) throw new Error(`filterImage failed: ${await extractError(r)}`);
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
  const r = await jsonFetch("/api/suggest", "POST", { input }, signal);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { suggestions: Suggestion[] }).suggestions;
}

/**
 * 이미지를 비전 분석해 외부 t2i 모델(ChatGPT/DALL·E)용 영어 프롬프트를 추출.
 * 저장된 원본 프롬프트와 무관하게 픽셀에서 뽑으므로 업로드 이미지에도 동작. 수 초~수십 초 소요.
 */
export async function describePrompt(generationId: string, signal?: AbortSignal): Promise<string> {
  const r = await jsonFetch("/api/describe", "POST", { generationId }, signal);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { prompt: string }).prompt;
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
  const r = await jsonFetch("/api/presets", "POST", input);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { preset: StylePreset }).preset;
}

export async function updatePreset(id: string, patch: Partial<StylePreset>): Promise<StylePreset> {
  const r = await jsonFetch(`/api/presets/${id}`, "PATCH", patch);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { preset: StylePreset }).preset;
}

export async function deletePreset(id: string): Promise<void> {
  const r = await jsonFetch(`/api/presets/${id}`, "DELETE");
  if (!r.ok) throw new Error(await extractError(r));
}

// ── prompt library ──────────────────────────────────────────────────────────
export async function listPrompts(opts?: { search?: string; tag?: string }): Promise<PromptLibraryItem[]> {
  const r = await fetch(buildUrl("/api/prompts", { search: opts?.search, tag: opts?.tag }));
  const { prompts } = (await r.json()) as { prompts: PromptLibraryItem[] };
  return prompts;
}

export async function createPrompt(input: { title: string; body: string; tags?: string[] }): Promise<PromptLibraryItem> {
  const r = await jsonFetch("/api/prompts", "POST", input);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { prompt: PromptLibraryItem }).prompt;
}

export async function updatePrompt(
  id: string,
  patch: { title?: string; body?: string; tags?: string[] },
): Promise<PromptLibraryItem> {
  const r = await jsonFetch(`/api/prompts/${id}`, "PATCH", patch);
  if (!r.ok) throw new Error(await extractError(r));
  return ((await r.json()) as { prompt: PromptLibraryItem }).prompt;
}

export async function deletePrompt(id: string): Promise<void> {
  const r = await jsonFetch(`/api/prompts/${id}`, "DELETE");
  if (!r.ok) throw new Error(await extractError(r));
}

/** "사용" 액션 — use_count++, last_used_at=now. */
export async function bumpPromptUse(id: string): Promise<void> {
  await jsonFetch(`/api/prompts/${id}`, "PATCH", { use: true });
}

/** 단일 generation 조회 — params(스프라이트 그리드/방향/앵커 등) 포함. 없으면 null. */
export async function getGeneration(id: string): Promise<{
  id: string;
  kind: string;
  prompt: string | null;
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
    prompt: string | null;
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
  const r = await jsonFetch("/api/upload", "POST", {
    kind: "spritesheet",
    dataUrl: args.dataUrl,
    parentGenerationId: args.parentGenerationId,
    sessionId: args.sessionId ?? undefined,
    params: args.params,
  });
  if (!r.ok) throw new Error(`uploadSpritesheet failed: ${await extractError(r)}`);
  return (await r.json()) as { generationId: string; width: number; height: number };
}

export async function removeGeneration(id: string): Promise<void> {
  await jsonFetch(`/api/generations/${id}`, "DELETE");
}

export async function galleryInsert(sessionId: string, generationId: string): Promise<void> {
  await jsonFetch(`/api/sessions/${sessionId}/gallery-insert`, "POST", { generationId });
}

export async function listGenerations(opts?: { sessionId?: string; kind?: string; search?: string; limit?: number }): Promise<Generation[]> {
  const r = await fetch(buildUrl("/api/generations", {
    sessionId: opts?.sessionId,
    kind: opts?.kind,
    search: opts?.search,
    limit: opts?.limit,
  }));
  const { generations } = (await r.json()) as { generations: Generation[] };
  return generations;
}

/** 캔버스 에디터 편집 상태 — CanvasEditor 의 Snapshot 과 동형(layers 는 불투명). */
export type PersistedCanvasState = {
  layers: unknown[];
  canvasSize: { w: number; h: number };
  selectedLayerId: string | null;
};

/** 시드별 저장된 캔버스 편집 상태(없거나 모든 레이어 stale 면 null). */
export async function getCanvasEdit(seedId: string): Promise<PersistedCanvasState | null> {
  const r = await fetch(`/api/canvas-edit/${seedId}`);
  if (!r.ok) return null;
  const { state } = (await r.json()) as { state: PersistedCanvasState | null };
  return state;
}

/** 자동 저장 — fire-and-forget(실패해도 편집 흐름 막지 않음). */
export async function saveCanvasEdit(seedId: string, state: PersistedCanvasState): Promise<void> {
  await jsonFetch(`/api/canvas-edit/${seedId}`, "POST", { state });
}

/** "처음부터" — 저장본 제거. */
export async function clearCanvasEdit(seedId: string): Promise<void> {
  await jsonFetch(`/api/canvas-edit/${seedId}`, "DELETE");
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
  const response = await jsonFetch("/api/chat", "POST", body, signal);
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
