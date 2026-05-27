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
      result: { generationId: string; imageUrl: string; width: number; height: number; kind?: string; createdAt?: number } | { error: string };
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
  /** 인페인트 마스크 PNG 의 generationId. 있으면 라우트가 본문에 [mask: <id>] marker 를 prefix
   *  → Claude orchestrator 가 inpaint_image 의 maskGenerationId 로 사용. */
  maskGenerationId?: string;
  /** ×N 배치 생성의 멤버 식별자. 같은 id 의 N 개 요청이 한 그리드로 묶인다.
   *  Claude 메시지 본문은 오염시키지 않고 user 메시지의 meta 로만 저장 → 재로드 시 그룹 복원. */
  batch?: { id: string; index: number; total: number };
};
