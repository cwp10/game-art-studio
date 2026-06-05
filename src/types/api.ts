/**
 * API 응답 DTO 계층 — Next API 라우트가 클라이언트에 돌려주는 JSON shape.
 *
 * DB 행 타입(`@/types/db`)과 분리한다: DB 컬럼명(snake_case)·내부 경로(image_path)는
 * 노출하지 않고, 클라이언트가 쓰는 camelCase·imageUrl 형태만 계약으로 둔다.
 * 라우트와 client.ts 양쪽이 이 타입을 공유한다.
 */

/** /api/generations/:id 응답 shape — client.ts getGeneration 이 소비. */
export type GenerationDTO = {
  id: string;
  imageUrl: string;
  prompt: string | null;
  kind: string;
  width: number | null;
  height: number | null;
  sessionId: string | null;
  createdAt: string;
  inputImageIds: string[] | null;
  params: Record<string, unknown> | null;
};

/** /api/upload 응답 (마스크 업로드 등 generationId 만 돌려주는 경로). */
export type UploadResultDTO = { generationId: string };

/** /api/sessions 단일 항목. */
export type SessionDTO = { id: string; name: string | null; createdAt: string };

/** /api/sessions/:id/messages 단일 항목. */
export type MessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
