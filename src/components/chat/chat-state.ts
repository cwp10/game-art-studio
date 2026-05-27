/**
 * 채팅 화면 상태 모델. ChatLayout 의 useReducer 가 다룸.
 *
 * 메시지/도구호출/결과를 별도 시퀀스로 저장하지 않고, 단일 `items` 배열에 시간 순으로 append.
 * 한 사용자 입력 → user item → assistant container (tool calls + image refs + text) 의 흐름.
 */

import type { ChatEvent } from "@/types/chat";
import type { Message, MessageBlock, Session } from "@/types/db";

export type ToolCallState = {
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "succeeded" | "failed";
  progress: Array<{ stage: string; detail?: string }>;
  result?: { generationId: string; imageUrl: string; width: number; height: number; kind?: string; createdAt?: number };
  error?: string;
};

/** 화면에 그리는 단위. user message / assistant turn / suggestions 그리드. */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      toolCalls: ToolCallState[];
      text?: string;
      finished: boolean;
    }
  | {
      /** LLM 이 만들어준 prompt 후보 카드 그리드. 사용자가 카드 클릭 → Composer prefill. */
      kind: "suggestions";
      id: string;
      pending: boolean; // 응답 대기 중
      items: Array<{ label: string; body: string }>;
      pickedBody?: string;
      error?: string;
    }
  | {
      /** ×N 배치 생성 — 같은 프롬프트로 N장을 순차 생성해 한 그리드로 모음.
       *  results 는 순차로 append (성공/에러 슬롯). user 메시지 meta.batch 로 영속화되어
       *  세션 재로드 시 messagesToItems 가 그리드를 복원한다. */
      kind: "batch";
      id: string;
      prompt: string;
      total: number;
      /** 취소/완료/재로드로 더 이상 슬롯이 추가되지 않는 상태. true 면 MessageList 가
       *  남은 빈 슬롯에 스피너를 그리지 않고 현재 results 만 렌더. */
      stopped?: boolean;
      results: Array<
        { generationId: string; imageUrl: string; width: number; height: number } | { error: string }
      >;
    };

export type ChatState = {
  sessions: Session[];
  activeSessionId: string | null;
  items: ChatItem[];
  generating: boolean;
};

export type ChatAction =
  | { type: "set_sessions"; sessions: Session[] }
  | { type: "set_active"; sessionId: string | null }
  | { type: "rename_session"; id: string; title: string }
  | { type: "load_messages"; messages: Message[] }
  | { type: "user_send"; tempId: string; text: string }
  | { type: "batch_start"; userTempId: string; text: string; batchId: string; total: number }
  | {
      type: "batch_result";
      batchId: string;
      result:
        | { generationId: string; imageUrl: string; width: number; height: number }
        | { error: string };
    }
  | { type: "batch_stopped"; batchId: string }
  | { type: "set_generating"; generating: boolean }
  | { type: "sse"; event: ChatEvent }
  | {
      type: "external_upload";
      tempId: string;
      filename: string;
      generationId: string;
      width: number;
      height: number;
    }
  | { type: "suggestions_requested"; userTempId: string; suggestId: string; text: string }
  | { type: "suggestions_received"; suggestId: string; items: Array<{ label: string; body: string }> }
  | { type: "suggestions_failed"; suggestId: string; error: string }
  | { type: "suggestion_picked"; suggestId: string; body: string }
  | { type: "reset_items" };

export const initialState: ChatState = {
  sessions: [],
  activeSessionId: null,
  items: [],
  generating: false,
};

/**
 * tool_result 의 result 페이로드를 일반화. object 면 그대로, string 이면 JSON.parse 시도.
 * MCP SDK 가 structuredContent 를 직렬화해 text 블록으로 흘리는 경우 string 으로 들어온다.
 */
function parseToolResult(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** user 메시지의 meta.batch 를 안전하게 추출. 형태 불일치 시 null. */
function readBatchMeta(
  meta: Record<string, unknown> | null,
): { id: string; index: number; total: number } | null {
  if (!meta || typeof meta !== "object") return null;
  const b = (meta as { batch?: unknown }).batch;
  if (!b || typeof b !== "object") return null;
  const { id, index, total } = b as { id?: unknown; index?: unknown; total?: unknown };
  if (typeof id === "string" && typeof index === "number" && typeof total === "number") {
    return { id, index, total };
  }
  return null;
}

/** batch 멤버 assistant 메시지에서 단일 이미지 결과 1개를 회수. */
function extractImageResult(
  m: Message,
): { generationId: string; imageUrl: string; width: number; height: number } | { error: string } | null {
  for (const b of m.content) {
    if (b.type === "tool_result") {
      const tr = b as Extract<MessageBlock, { type: "tool_result" }>;
      const parsed = parseToolResult(tr.result);
      if (parsed && typeof parsed.generationId === "string") {
        return {
          generationId: parsed.generationId,
          imageUrl: `/api/images/${parsed.generationId}`,
          width: typeof parsed.width === "number" ? parsed.width : 0,
          height: typeof parsed.height === "number" ? parsed.height : 0,
        };
      }
    } else if (b.type === "image_ref") {
      const ir = b as Extract<MessageBlock, { type: "image_ref" }>;
      return {
        generationId: ir.generation_id,
        imageUrl: `/api/images/${ir.generation_id}`,
        width: 0,
        height: 0,
      };
    }
  }
  return null;
}

/** 히스토리 메시지(DB) 를 화면 ChatItem 으로 변환. */
function messagesToItems(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  let currentAssistant: Extract<ChatItem, { kind: "assistant" }> | null = null;
  // batchId → 이미 items 에 push 된 batch 그리드 참조. 바로 다음 assistant 가 결과를 채운다.
  const batches = new Map<string, Extract<ChatItem, { kind: "batch" }>>();
  let pendingBatch: Extract<ChatItem, { kind: "batch" }> | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      if (currentAssistant) {
        items.push(currentAssistant);
        currentAssistant = null;
      }
      const text = m.content.find((b): b is Extract<MessageBlock, { type: "text" }> => b.type === "text")?.text ?? "";
      const batch = readBatchMeta(m.meta);
      if (batch) {
        // 같은 batchId 의 첫 멤버에서만 user 버블 + batch 그리드를 한 번 emit.
        let bi = batches.get(batch.id);
        if (!bi) {
          items.push({ kind: "user", id: m.id, text });
          bi = { kind: "batch", id: batch.id, prompt: text, total: batch.total, stopped: true, results: [] };
          batches.set(batch.id, bi);
          items.push(bi);
        }
        pendingBatch = bi; // 다음 assistant 결과가 이 그리드로 들어간다
      } else {
        items.push({ kind: "user", id: m.id, text });
        pendingBatch = null;
      }
    } else if (m.role === "assistant") {
      // 직전 user 가 batch 멤버면 결과를 그리드에 채우고 별도 assistant 아이템은 만들지 않는다.
      if (pendingBatch) {
        const r = extractImageResult(m);
        pendingBatch.results.push(r ?? { error: "결과를 받지 못했어요." });
        pendingBatch = null;
        continue;
      }
      currentAssistant = { kind: "assistant", id: m.id, toolCalls: [], finished: true };
      for (const b of m.content) {
        if (b.type === "tool_call") {
          const tc = b as Extract<MessageBlock, { type: "tool_call" }>;
          currentAssistant.toolCalls.push({
            toolCallId: tc.id,
            name: tc.name,
            args: tc.args,
            status: "succeeded",
            progress: [{ stage: "done" }],
          });
        } else if (b.type === "tool_result") {
          const tr = b as Extract<MessageBlock, { type: "tool_result" }>;
          const owner = currentAssistant.toolCalls.find(c => c.toolCallId === tr.tool_call_id);
          if (owner) {
            // tr.result 는 MCP 응답에 따라 (a) {generationId, width, height, ...} object
            // 또는 (b) MCP SDK 가 structuredContent 를 직렬화한 JSON 문자열로 들어온다.
            // 두 케이스 모두 동일하게 풀어 width/height 도 함께 회수.
            const parsed = parseToolResult(tr.result);
            if (parsed && typeof parsed.generationId === "string") {
              owner.result = {
                generationId: parsed.generationId,
                imageUrl: `/api/images/${parsed.generationId}`,
                width: typeof parsed.width === "number" ? parsed.width : 0,
                height: typeof parsed.height === "number" ? parsed.height : 0,
                // API enrichment 으로 채운 블록 kind 우선, 없으면 result 내 kind(신규 생성).
                kind: tr.kind ?? (typeof parsed.kind === "string" ? parsed.kind : undefined),
                createdAt: tr.createdAt ?? (typeof parsed.createdAt === "number" ? parsed.createdAt : undefined),
              };
            }
          }
        } else if (b.type === "image_ref") {
          // 이미 tool_result 에 generationId 가 있으면 중복. 둘 다 처리.
          const ir = b as Extract<MessageBlock, { type: "image_ref" }>;
          const last = currentAssistant.toolCalls[currentAssistant.toolCalls.length - 1];
          if (last && !last.result) {
            last.result = {
              generationId: ir.generation_id,
              imageUrl: `/api/images/${ir.generation_id}`,
              width: 0,
              height: 0,
            };
          }
        } else if (b.type === "text") {
          currentAssistant.text = b.text;
        }
      }
    }
  }
  if (currentAssistant) items.push(currentAssistant);
  return items;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "set_sessions":
      return { ...state, sessions: action.sessions };
    case "rename_session":
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.id === action.id ? { ...s, title: action.title } : s,
        ),
      };
    case "set_active":
      return { ...state, activeSessionId: action.sessionId, items: [], generating: false };
    case "load_messages":
      return { ...state, items: messagesToItems(action.messages) };
    case "user_send":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: action.tempId, text: action.text },
          { kind: "assistant", id: "__pending__", toolCalls: [], finished: false },
        ],
        generating: true,
      };
    case "batch_start":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: action.userTempId, text: action.text },
          { kind: "batch", id: action.batchId, prompt: action.text, total: action.total, results: [] },
        ],
        generating: true,
      };
    case "batch_result":
      return {
        ...state,
        items: state.items.map(it =>
          it.kind === "batch" && it.id === action.batchId
            ? { ...it, results: [...it.results, action.result] }
            : it,
        ),
      };
    case "batch_stopped":
      return {
        ...state,
        items: state.items.map(it =>
          it.kind === "batch" && it.id === action.batchId ? { ...it, stopped: true } : it,
        ),
      };
    case "set_generating":
      return { ...state, generating: action.generating };
    case "suggestions_requested":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: action.userTempId, text: action.text },
          { kind: "suggestions", id: action.suggestId, pending: true, items: [] },
        ],
      };
    case "suggestions_received":
      return {
        ...state,
        items: state.items.map(it =>
          it.kind === "suggestions" && it.id === action.suggestId
            ? { ...it, pending: false, items: action.items }
            : it,
        ),
      };
    case "suggestions_failed":
      return {
        ...state,
        items: state.items.map(it =>
          it.kind === "suggestions" && it.id === action.suggestId
            ? { ...it, pending: false, error: action.error }
            : it,
        ),
      };
    case "suggestion_picked":
      return {
        ...state,
        items: state.items.map(it =>
          it.kind === "suggestions" && it.id === action.suggestId
            ? { ...it, pickedBody: action.body }
            : it,
        ),
      };
    case "external_upload": {
      // 가짜 assistant turn — toolCall 1개를 succeeded 로 채워 결과 카드 흐름 재사용.
      const fakeToolCallId = "ext-" + action.generationId;
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: action.tempId, text: `🖼 업로드: ${action.filename}` },
          {
            kind: "assistant",
            id: "ext-msg-" + action.generationId,
            finished: true,
            toolCalls: [
              {
                toolCallId: fakeToolCallId,
                name: "upload_image",
                args: { filename: action.filename },
                status: "succeeded",
                progress: [{ stage: "done" }],
                result: {
                  generationId: action.generationId,
                  imageUrl: `/api/images/${action.generationId}`,
                  width: action.width,
                  height: action.height,
                },
              },
            ],
          },
        ],
      };
    }
    case "reset_items":
      return { ...state, items: [], generating: false };
    case "sse": {
      const ev = action.event;
      const items = [...state.items];
      const lastIdx = items.length - 1;
      if (lastIdx < 0 || items[lastIdx].kind !== "assistant") return state;
      const assistant = { ...(items[lastIdx] as Extract<ChatItem, { kind: "assistant" }>) };

      switch (ev.type) {
        case "session_started":
          return {
            ...state,
            activeSessionId: ev.sessionId,
            // user 메시지 id 를 실제 값으로 교체
            items: items.map((it, i) =>
              i === lastIdx - 1 && it.kind === "user" ? { ...it, id: ev.messageId } : it,
            ),
          };
        case "tool_call_started":
          assistant.toolCalls = [
            ...assistant.toolCalls,
            {
              toolCallId: ev.toolCallId,
              name: ev.name,
              args: ev.args,
              status: "running",
              progress: [],
            },
          ];
          break;
        case "tool_call_progress": {
          assistant.toolCalls = assistant.toolCalls.map(tc =>
            tc.toolCallId === ev.toolCallId
              ? {
                  ...tc,
                  progress: [...tc.progress, { stage: ev.stage, detail: ev.detail }],
                }
              : tc,
          );
          break;
        }
        case "tool_call_finished": {
          assistant.toolCalls = assistant.toolCalls.map(tc => {
            if (tc.toolCallId !== ev.toolCallId) return tc;
            const result = ev.result;
            if ("error" in result) {
              return { ...tc, status: "failed", error: result.error };
            }
            return {
              ...tc,
              status: "succeeded",
              result,
            };
          });
          break;
        }
        case "assistant_text":
          assistant.text = (assistant.text ?? "") + ev.text;
          break;
        case "message_completed":
          assistant.id = ev.messageId;
          assistant.finished = true;
          items[lastIdx] = assistant;
          return { ...state, items, generating: false };
        case "error":
          assistant.finished = true;
          // 채팅에 명시적 에러 텍스트 — MessageList 가 빨간색으로 렌더.
          assistant.text = `⚠️ ${ev.message || "오류가 발생했어요."}`;
          // 진행 중이던 toolCall 들은 failed 로 마킹.
          assistant.toolCalls = assistant.toolCalls.map(tc =>
            tc.status === "running" ? { ...tc, status: "failed", error: ev.message } : tc,
          );
          items[lastIdx] = assistant;
          return { ...state, items, generating: false };
        default:
          break;
      }
      items[lastIdx] = assistant;
      return { ...state, items };
    }
    default:
      return state;
  }
}
