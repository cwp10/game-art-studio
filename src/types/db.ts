/** DB 행 모양. JSON 컬럼은 repo 에서 parse 한 형태로 노출. */

export type Session = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: 0 | 1;
};

export type MessageRole = "user" | "assistant" | "tool" | "system";

/** messages.content 의 element. Claude 의 메시지 구조와 호환. */
export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "image_ref"; generation_id: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  // kind 는 영속 필드가 아니라, 메시지 로드 시 API 가 해당 generation 의 실제 kind 로
  // 채워 넣는 enrichment 용(레거시 메시지의 result 에 kind 가 없을 때 보강).
  | { type: "tool_result"; tool_call_id: string; result: unknown; kind?: string; createdAt?: number };

export type Message = {
  id: string;
  session_id: string;
  role: MessageRole;
  content: MessageBlock[]; // JSON 컬럼 — repo 에서 parse 됨
  created_at: number;
  claude_session_id: string | null;
  meta: Record<string, unknown> | null;
};

export type GenerationKind =
  | "text2img"
  | "img2img"
  | "upscale"
  | "remove_bg"
  | "inpaint"
  | "spritesheet"
  | "mask"
  | "layer"
  | "reskin"
  | "resize"
  | "external"
  | "emote_sheet"
  | "tileset"
  | "normal_map";

export type GenerationBackend = "codex_exec" | "codex_pty" | "external" | "direct";

export type Generation = {
  id: string;
  session_id: string | null;
  message_id: string | null;
  kind: GenerationKind;
  prompt: string | null;
  negative_prompt: string | null;
  preset_id: string | null;
  input_image_ids: string[]; // JSON
  params: Record<string, unknown>; // JSON
  image_path: string; // DATA_DIR 기준 상대
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  backend: GenerationBackend;
  created_at: number;
};

export type StylePreset = {
  id: string;
  name: string;
  description: string | null;
  prompt_suffix: string;
  negative_suffix: string | null;
  default_params: Record<string, unknown> | null;
  is_builtin: 0 | 1;
  created_at: number;
  updated_at: number;
};

export type PromptLibraryItem = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type Job = {
  id: string;
  session_id: string | null;
  kind: "claude_orchestrate" | "codex_image";
  status: JobStatus;
  args: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  work_dir: string | null;
  started_at: number;
  ended_at: number | null;
};
