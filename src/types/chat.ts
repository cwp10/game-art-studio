/**
 * /api/chat 의 SSE 이벤트 계약. 클라이언트·서버 모두 이 타입에 맞춰야 함.
 */

export type ChatEvent =
  | { type: "session_started"; sessionId: string; messageId: string }
  | { type: "assistant_thinking"; text?: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_call_progress"; toolCallId: string; stage: string; detail?: string }
  | {
      type: "tool_call_finished";
      toolCallId: string;
      result: { generationId: string; imageUrl: string; width: number; height: number } | { error: string };
    }
  | { type: "assistant_text"; text: string }
  | { type: "message_completed"; messageId: string }
  | { type: "error"; message: string };

export type ChatRequest = {
  /** 없으면 새 세션 자동 생성. */
  sessionId?: string;
  /** 사용자가 입력한 자연어. */
  message: string;
  /** 첨부 이미지 generationId 목록 (img2img/inpaint 등). */
  attachmentGenerationIds?: string[];
};
