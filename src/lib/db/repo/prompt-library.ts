import { getDb } from "@/lib/db/client";
import { newPromptId } from "@/lib/util/ids";
import type { PromptLibraryItem } from "@/types/db";

type Row = {
  id: string;
  title: string;
  body: string;
  tags: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToItem(r: Row): PromptLibraryItem {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    use_count: r.use_count,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 검색 + tag 필터 + 정렬. limit 기본 200. */
export function listPrompts(opts: { search?: string; tag?: string; limit?: number } = {}): PromptLibraryItem[] {
  const { search, tag, limit = 200 } = opts;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (search?.trim()) {
    where.push("(title LIKE ? OR body LIKE ?)");
    const q = `%${search.trim()}%`;
    params.push(q, q);
  }
  if (tag?.trim()) {
    // tags 는 JSON 배열 문자열. 단순 LIKE 로 "tag" 포함 검사 (개인용 도구 — 충돌 위험 무시).
    where.push("tags LIKE ?");
    params.push(`%"${tag.trim()}"%`);
  }
  const sql = `SELECT * FROM prompt_library ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  } ORDER BY use_count DESC, last_used_at DESC, created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as Row[];
  return rows.map(rowToItem);
}

export function getPrompt(id: string): PromptLibraryItem | null {
  const row = getDb().prepare("SELECT * FROM prompt_library WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToItem(row) : null;
}

export function createPrompt(input: {
  id?: string;
  title: string;
  body: string;
  tags?: string[];
}): PromptLibraryItem {
  const now = Date.now();
  const id = input.id ?? newPromptId();
  getDb()
    .prepare(
      `INSERT INTO prompt_library
       (id, title, body, tags, use_count, last_used_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(id, input.title, input.body, JSON.stringify(input.tags ?? []), now, now);
  return getPrompt(id)!;
}

export function updatePrompt(
  id: string,
  patch: Partial<Pick<PromptLibraryItem, "title" | "body" | "tags">>,
): PromptLibraryItem | null {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.title !== undefined) { fields.push("title = ?"); values.push(patch.title); }
  if (patch.body !== undefined) { fields.push("body = ?"); values.push(patch.body); }
  if (patch.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(patch.tags)); }
  if (!fields.length) return getPrompt(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb().prepare(`UPDATE prompt_library SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getPrompt(id);
}

export function deletePrompt(id: string): void {
  getDb().prepare("DELETE FROM prompt_library WHERE id = ?").run(id);
}

/** [▶ 사용] 클릭 시 호출 — use_count++, last_used_at=now. */
export function bumpPromptUse(id: string): void {
  getDb()
    .prepare("UPDATE prompt_library SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
    .run(Date.now(), id);
}
