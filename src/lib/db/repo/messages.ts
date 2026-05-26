import { getDb } from "@/lib/db/client";
import { newMessageId } from "@/lib/util/ids";
import type { Message, MessageBlock, MessageRole } from "@/types/db";

type MessageRow = {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: number;
  claude_session_id: string | null;
  meta: string | null;
};

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: JSON.parse(r.content) as MessageBlock[],
    created_at: r.created_at,
    claude_session_id: r.claude_session_id,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
  };
}

export function createMessage(input: {
  session_id: string;
  role: MessageRole;
  content: MessageBlock[];
  claude_session_id?: string | null;
  meta?: Record<string, unknown> | null;
}): Message {
  const msg: Message = {
    id: newMessageId(),
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    created_at: Date.now(),
    claude_session_id: input.claude_session_id ?? null,
    meta: input.meta ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, claude_session_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.id,
      msg.session_id,
      msg.role,
      JSON.stringify(msg.content),
      msg.created_at,
      msg.claude_session_id,
      msg.meta ? JSON.stringify(msg.meta) : null,
    );
  return msg;
}

export function listMessages(sessionId: string): Message[] {
  const rows = getDb()
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as MessageRow[];
  return rows.map(rowToMessage);
}

/** session 의 가장 최근 assistant 메시지에 기록된 claude_session_id (없으면 null). resume 용. */
export function lastClaudeSessionId(sessionId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT claude_session_id FROM messages
       WHERE session_id = ? AND claude_session_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}
