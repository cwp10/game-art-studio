import { getDb } from "@/lib/db/client";
import { newSessionId } from "@/lib/util/ids";
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

export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
