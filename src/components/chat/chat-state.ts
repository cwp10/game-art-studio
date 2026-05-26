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
  result?: { generationId: string; imageUrl: string; width: number; height: number };
  error?: string;
};

/** 화면에 그리는 단위. user message / assistant turn / 진행 중 turn. */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      toolCalls: ToolCallState[];
      text?: string;
      finished: boolean;
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
  | { type: "load_messages"; messages: Message[] }
  | { type: "user_send"; tempId: string; text: string }
  | { type: "set_generating"; generating: boolean }
  | { type: "sse"; event: ChatEvent }
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

/** 히스토리 메시지(DB) 를 화면 ChatItem 으로 변환. */
function messagesToItems(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  let currentAssistant: Extract<ChatItem, { kind: "assistant" }> | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      if (currentAssistant) {
        items.push(currentAssistant);
        currentAssistant = null;
      }
      const text = m.content.find((b): b is Extract<MessageBlock, { type: "text" }> => b.type === "text")?.text ?? "";
      items.push({ kind: "user", id: m.id, text });
    } else if (m.role === "assistant") {
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
    case "set_generating":
      return { ...state, generating: action.generating };
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
