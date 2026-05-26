import type { ChatEvent } from "@/types/chat";

/**
 * SSE 인코딩 헬퍼. fetch 의 ReadableStream<Uint8Array> 형태로 응답.
 *
 * 사용:
 *   const { stream, send, close } = createSseStream<ChatEvent>();
 *   send({ type: 'session_started', ... });
 *   ...
 *   close();
 *   return new Response(stream, { headers: SSE_HEADERS });
 */

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export type SseHandle<T> = {
  stream: ReadableStream<Uint8Array>;
  send: (event: T) => void;
  close: () => void;
  /** 클라이언트가 연결을 끊었는지 감지 (라우트가 spawn 한 child 를 cancel 할 때 사용). */
  signal: AbortSignal;
};

export function createSseStream<T = ChatEvent>(): SseHandle<T> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // 클라이언트가 끊음
      closed = true;
      abortController.abort();
    },
  });

  function send(event: T): void {
    if (closed || !controller) return;
    const data = JSON.stringify(event);
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  }

  function close(): void {
    if (closed || !controller) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
  }

  return { stream, send, close, signal: abortController.signal };
}
