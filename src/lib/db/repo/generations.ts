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
  opts: { sessionId?: string; kind?: GenerationKind; limit?: number } = {},
): Generation[] {
  const { sessionId, kind, limit = 200 } = opts;
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
