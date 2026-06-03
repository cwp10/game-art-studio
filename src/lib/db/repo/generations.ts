import { getDb } from "@/lib/db/client";
import { newGenerationId } from "@/lib/util/ids";
import type { Generation, GenerationBackend, GenerationKind } from "@/types/db";

type GenerationRow = {
  id: string;
  session_id: string | null;
  message_id: string | null;
  kind: GenerationKind;
  prompt: string | null;
  negative_prompt: string | null;
  preset_id: string | null;
  input_image_ids: string | null;
  params: string | null;
  image_path: string;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  backend: GenerationBackend;
  created_at: number;
};

function rowToGeneration(r: GenerationRow): Generation {
  return {
    id: r.id,
    session_id: r.session_id,
    message_id: r.message_id,
    kind: r.kind,
    prompt: r.prompt,
    negative_prompt: r.negative_prompt,
    preset_id: r.preset_id,
    input_image_ids: r.input_image_ids ? (JSON.parse(r.input_image_ids) as string[]) : [],
    params: r.params ? (JSON.parse(r.params) as Record<string, unknown>) : {},
    image_path: r.image_path,
    thumbnail_path: r.thumbnail_path,
    width: r.width,
    height: r.height,
    backend: r.backend,
    created_at: r.created_at,
  };
}

export function createGeneration(input: {
  id?: string;
  session_id: string | null;
  message_id: string | null;
  kind: GenerationKind;
  prompt: string | null;
  negative_prompt?: string | null;
  preset_id?: string | null;
  input_image_ids?: string[];
  params?: Record<string, unknown>;
  image_path: string;
  thumbnail_path?: string | null;
  width?: number | null;
  height?: number | null;
  backend?: GenerationBackend;
}): Generation {
  const gen: Generation = {
    id: input.id ?? newGenerationId(),
    session_id: input.session_id,
    message_id: input.message_id,
    kind: input.kind,
    prompt: input.prompt,
    negative_prompt: input.negative_prompt ?? null,
    preset_id: input.preset_id ?? null,
    input_image_ids: input.input_image_ids ?? [],
    params: input.params ?? {},
    image_path: input.image_path,
    thumbnail_path: input.thumbnail_path ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    backend: input.backend ?? "codex_exec",
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO generations
       (id, session_id, message_id, kind, prompt, negative_prompt, preset_id, input_image_ids,
        params, image_path, thumbnail_path, width, height, backend, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      gen.id,
      gen.session_id,
      gen.message_id,
      gen.kind,
      gen.prompt,
      gen.negative_prompt,
      gen.preset_id,
      JSON.stringify(gen.input_image_ids),
      JSON.stringify(gen.params),
      gen.image_path,
      gen.thumbnail_path,
      gen.width,
      gen.height,
      gen.backend,
      gen.created_at,
    );
  return gen;
}

export function getGeneration(id: string): Generation | null {
  const row = getDb().prepare("SELECT * FROM generations WHERE id = ?").get(id) as
    | GenerationRow
    | undefined;
  return row ? rowToGeneration(row) : null;
}

export function listGenerations(
  opts: { sessionId?: string; kind?: GenerationKind; limit?: number; search?: string } = {},
): Generation[] {
  const { sessionId, kind, limit = 200, search } = opts;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (sessionId) {
    where.push("session_id = ?");
    params.push(sessionId);
  }
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  if (search?.trim()) {
    where.push("prompt LIKE ?");
    params.push(`%${search.trim()}%`);
  }
  // 갤러리는 마스크/레이어 행이 노이즈 — 기본적으로 제외 (idx_generations_kind 활용).
  // 별도 옵션으로 보고 싶으면 sessionId 또는 kind 필터 명시 시. external 은 제외하지 않음.
  if (!sessionId && !kind) {
    where.push("kind NOT IN ('mask','layer')");
  }
  const sql = `SELECT * FROM generations ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  } ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = getDb()
    .prepare(sql)
    .all(...params) as GenerationRow[];
  return rows.map(rowToGeneration);
}

export function deleteGeneration(id: string): void {
  getDb().prepare("DELETE FROM generations WHERE id = ?").run(id);
}

/**
 * 세션 ZIP 내보내기용: 한 세션의 모든 생성 이미지를 created_at ASC 정렬로 조회.
 * 내부 작업용 행(mask/layer)은 제외하고, limit 없이 전부 반환한다.
 * (listGenerations 는 sessionId 지정 시 mask/layer 필터를 건너뛰고 DESC·LIMIT 200 이라 부적합.)
 */
export function listSessionImagesForExport(sessionId: string): Generation[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM generations
       WHERE session_id = ? AND kind NOT IN ('mask','layer')
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as GenerationRow[];
  return rows.map(rowToGeneration);
}

/**
 * 후처리(업스케일/리사이즈/normalize)로 파일 치수가 바뀌면 DB width/height 를 동기화.
 * runImageTool 이 생성 시점 크기를 기록하므로, make_spritesheet 의 업스케일 후 호출 필요.
 */
export function setGenerationDimensions(id: string, width: number, height: number): void {
  getDb()
    .prepare("UPDATE generations SET width = ?, height = ? WHERE id = ?")
    .run(width, height, id);
}

/**
 * MCP 서버가 만든 generation 행을 사후에 세션·메시지에 연결.
 * Claude orchestrator 경로에서 사용: MCP 도구는 sessionId 를 모르기 때문에
 * 결과 도착 후 Next 라우트가 ownership 을 채워준다.
 */
export function linkGeneration(
  id: string,
  patch: { session_id?: string | null; message_id?: string | null },
): void {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (patch.session_id !== undefined) {
    fields.push("session_id = ?");
    values.push(patch.session_id);
  }
  if (patch.message_id !== undefined) {
    fields.push("message_id = ?");
    values.push(patch.message_id);
  }
  if (!fields.length) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE generations SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}
