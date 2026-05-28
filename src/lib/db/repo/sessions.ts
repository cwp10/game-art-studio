import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { newSessionId } from "@/lib/util/ids";
import { DATA_DIR, thumbnailPath } from "@/lib/util/paths";
import type { Session } from "@/types/db";

type SessionRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
};

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    archived: r.archived as 0 | 1,
  };
}

export function createSession(title = "새 세션"): Session {
  const now = Date.now();
  const session: Session = {
    id: newSessionId(),
    title,
    created_at: now,
    updated_at: now,
    archived: 0,
  };
  getDb()
    .prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?)",
    )
    .run(session.id, session.title, session.created_at, session.updated_at, session.archived);
  return session;
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(opts: { limit?: number; includeArchived?: boolean; search?: string } = {}): Session[] {
  const { limit = 200, includeArchived = false, search } = opts;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!includeArchived) where.push("archived = 0");
  if (search?.trim()) {
    where.push("title LIKE ?");
    params.push(`%${search.trim()}%`);
  }
  const sql = `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as SessionRow[];
  return rows.map(rowToSession);
}

export function touchSession(id: string): void {
  getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function renameSession(id: string, title: string): void {
  getDb()
    .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, Date.now(), id);
}

/** image_path(상대/절대) → 절대경로. ENOENT 무시 unlink. */
function unlinkQuiet(p: string): void {
  fs.rmSync(p, { force: true });
}

/**
 * 세션 삭제 + 그 세션 generation 의 이미지·썸네일 파일 정리 (cascade).
 *
 * messages 는 FK ON DELETE CASCADE 로 자동 삭제. generations 는 ON DELETE SET NULL
 * 이라 세션을 먼저 지우면 session_id 가 끊겨 더는 못 찾으므로, 삭제 전에 수집한다.
 *
 * "참조 안 된 것만 삭제": 다른 generation(이 세션 밖)이 input_image_ids 로 그 id 를
 * 참조하면 파일·행을 모두 보존한다(FK 가 session_id 만 NULL 로). 행을 지우면
 * /api/images 가 서빙 못 하므로, 참조된 것은 행과 파일을 함께 남겨 일관성을 유지.
 */
export function deleteSession(id: string): void {
  const db = getDb();
  const gens = db
    .prepare("SELECT id, image_path, thumbnail_path FROM generations WHERE session_id = ?")
    .all(id) as { id: string; image_path: string; thumbnail_path: string | null }[];

  // 이 세션 밖의 generation 이 input_image_ids 로 참조하는 id → 보존.
  // session_id IS NOT ? 는 NULL(고아)·타세션 모두 포함, 같은 세션 형제는 제외.
  const referenced = new Set<string>();
  const refStmt = db.prepare(
    "SELECT 1 FROM generations WHERE input_image_ids LIKE ? AND session_id IS NOT ? LIMIT 1",
  );
  for (const g of gens) {
    if (refStmt.get(`%"${g.id}"%`, id)) referenced.add(g.id);
  }

  const toDelete = gens.filter(g => !referenced.has(g.id));
  db.transaction(() => {
    const del = db.prepare("DELETE FROM generations WHERE id = ?");
    for (const g of toDelete) del.run(g.id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  })();

  // 행 삭제가 커밋된 뒤 파일 정리 (fs 는 트랜잭션 밖).
  for (const g of toDelete) {
    const abs = path.isAbsolute(g.image_path) ? g.image_path : path.join(DATA_DIR, g.image_path);
    unlinkQuiet(abs);
    unlinkQuiet(thumbnailPath(g.id)); // on-demand 썸네일 캐시
    if (g.thumbnail_path) {
      const tabs = path.isAbsolute(g.thumbnail_path)
        ? g.thumbnail_path
        : path.join(DATA_DIR, g.thumbnail_path);
      unlinkQuiet(tabs);
    }
  }
}
