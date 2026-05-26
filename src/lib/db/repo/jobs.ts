import { getDb } from "@/lib/db/client";
import type { Job, JobStatus } from "@/types/db";

export function createJob(input: {
  id: string;
  session_id: string | null;
  kind: "claude_orchestrate" | "codex_image";
  args?: Record<string, unknown> | null;
  work_dir?: string | null;
}): Job {
  const job: Job = {
    id: input.id,
    session_id: input.session_id,
    kind: input.kind,
    status: "pending",
    args: input.args ?? null,
    result: null,
    error: null,
    work_dir: input.work_dir ?? null,
    started_at: Date.now(),
    ended_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO jobs (id, session_id, kind, status, args, work_dir, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      job.session_id,
      job.kind,
      job.status,
      job.args ? JSON.stringify(job.args) : null,
      job.work_dir,
      job.started_at,
    );
  return job;
}

export function updateJob(
  id: string,
  patch: {
    status?: JobStatus;
    result?: Record<string, unknown> | null;
    error?: string | null;
    ended_at?: number | null;
  },
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.result !== undefined) {
    fields.push("result = ?");
    values.push(patch.result ? JSON.stringify(patch.result) : null);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (patch.ended_at !== undefined) {
    fields.push("ended_at = ?");
    values.push(patch.ended_at);
  }
  if (!fields.length) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}
