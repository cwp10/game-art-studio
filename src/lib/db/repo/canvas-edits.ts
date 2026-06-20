import { getDb } from "@/lib/db/client";

/**
 * 캔버스 에디터 편집 상태 영속화 repo — 시드 이미지(seedGenerationId) 1장당 1행.
 * state 는 CanvasEditor 의 Snapshot({ layers, canvasSize, selectedLayerId }) 을 불투명 JSON 으로 저장.
 * repo 는 layers 내부 구조를 모르고, generationId 존재 여부만 검사한다(stale 정리).
 */

export type PersistedCanvasState = {
  layers: Array<{ generationId?: string } & Record<string, unknown>>;
  canvasSize: { w: number; h: number };
  selectedLayerId: string | null;
};

type Row = { seed_generation_id: string; state_json: string; updated_at: number };

/**
 * 저장본 조회. state 의 레이어 중 generation 행이 사라진 것은 걸러서 반환(삭제된 이미지 stale 정리).
 * 유효 레이어가 0 이면 null(복원할 게 없음 → 칩 미표시).
 */
export function getCanvasEdit(seedId: string): PersistedCanvasState | null {
  const row = getDb()
    .prepare("SELECT * FROM canvas_edits WHERE seed_generation_id = ?")
    .get(seedId) as Row | undefined;
  if (!row) return null;
  let state: PersistedCanvasState;
  try {
    state = JSON.parse(row.state_json) as PersistedCanvasState;
  } catch {
    return null;
  }
  if (!Array.isArray(state.layers) || state.layers.length === 0) return null;
  const ids = state.layers.map(l => l.generationId).filter((v): v is string => !!v);
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(",");
  const existing = new Set(
    (getDb()
      .prepare(`SELECT id FROM generations WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string }[]).map(r => r.id),
  );
  const layers = state.layers.filter(l => l.generationId && existing.has(l.generationId));
  if (layers.length === 0) return null;
  return { ...state, layers };
}

/** upsert — seed 당 1행 교체. */
export function upsertCanvasEdit(seedId: string, state: PersistedCanvasState): void {
  getDb()
    .prepare(
      `INSERT INTO canvas_edits (seed_generation_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(seed_generation_id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    )
    .run(seedId, JSON.stringify(state), Date.now());
}

export function deleteCanvasEdit(seedId: string): void {
  getDb().prepare("DELETE FROM canvas_edits WHERE seed_generation_id = ?").run(seedId);
}
