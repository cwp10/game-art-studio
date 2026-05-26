import type { GenerationKind } from "@/types/db";

/**
 * ImageBackend — 이미지 생성/편집의 백엔드 추상화.
 *
 * 구현체:
 *  - codex-exec.ts  (메인, M0 에서 검증된 경로): `codex exec` spawn → imagegen 스킬 자동 발동
 *  - direct.ts      (선택적 폴백): OpenAI SDK 직접 호출 (API 키 있을 때만)
 *
 * 호출자는 인터페이스만 보고 사용. 백엔드 스위치는 `selectImageBackend()` 가 환경에 따라.
 */

export type ImageBackendKind = "codex_exec" | "direct";

export type ImageJob = {
  /** jobs.id 와 동일 (트레이스용). */
  id: string;
  /** 결과 PNG 의 generation id. 파일명은 `data/images/{generationId}.png`. */
  generationId: string;
  kind: GenerationKind;
  prompt: string;
  /** img2img/inpaint 등의 입력 이미지 절대 경로. */
  inputImagePaths?: string[];
  /** size/quality 등 기타 파라미터 (현재 v1 에선 자연어 prompt 에 녹임). */
  params?: Record<string, unknown>;
};

export type ImageBackendStage =
  | "starting"
  | "skill_loading"
  | "image_generating"
  | "recovering"
  | "done";

export type ProgressCallback = (stage: ImageBackendStage, detail?: string) => void;

export type ImageResult = {
  /** 최종 PNG 의 절대 경로 (`data/images/{generationId}.png`). */
  imagePath: string;
  width: number;
  height: number;
  elapsedMs: number;
  /** 디버깅·로깅용. */
  rawStdoutTail?: string;
};

export interface ImageBackend {
  readonly kind: ImageBackendKind;
  execute(job: ImageJob, onProgress: ProgressCallback, signal?: AbortSignal): Promise<ImageResult>;
}

/** 환경에 따라 적절한 백엔드 선택. M0 결과로 항상 codex_exec. */
export async function selectImageBackend(): Promise<ImageBackend> {
  const { CodexExecBackend } = await import("./codex-exec");
  return new CodexExecBackend();
}
