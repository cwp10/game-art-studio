import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { jobDir as jobDirFor } from "@/lib/util/paths";

/**
 * MCP 도구의 `data/tmp/job-{id}/progress.jsonl` 을 polling 으로 tail.
 *
 * 왜 polling 인가:
 *  - MCP 서버는 Claude CLI 가 별도 프로세스로 spawn 하므로 Next 라우트와 IPC 가 없다.
 *  - MCP 도구는 stage 마다 progress.jsonl 에 한 줄 append, Next 는 그 파일을 읽어 forward.
 *  - macOS fs.watch 는 missed events 가 잦아서 단순 mtime+size polling 이 더 robust.
 *
 * 어떻게 jobId 를 찾는가:
 *  - Claude 의 tool_use input 에는 jobId 가 없다 (Claude 가 만들지 않음).
 *  - 라우트가 tool_use 이벤트 받자마자 이 헬퍼를 시작.
 *  - jobs 테이블에서 `started_at > turnStartTime` 인 가장 최근 codex_image 행을 polling 으로 찾는다.
 *  - 한 turn 에 한 도구 호출만 강제되므로 race 없음.
 *
 * 어떻게 끝나는가:
 *  - 호출자가 tool_result 받으면 `.stop()` 호출.
 *  - 도구가 죽거나 progress.jsonl 이 안 만들어지면 자연스럽게 idle (stop 시점까지 spinner).
 */

export type ProgressEvent = { stage: string; detail?: string; ts: number };

type Handle = {
  stop: () => void;
  /** debugging — 발견한 jobId (없으면 null). */
  readonly jobId: string | null;
};

export function tailProgress(opts: {
  /** 라우트가 이 turn 시작 시점(epoch ms). 그 이후 created 된 job 만 후보. */
  turnStartTime: number;
  onEvent: (ev: ProgressEvent) => void;
  /** 기본 200ms. */
  pollIntervalMs?: number;
}): Handle {
  const pollMs = opts.pollIntervalMs ?? 200;
  let stopped = false;
  let foundJobId: string | null = null;
  let readOffset = 0;
  let lineBuf = "";
  let timer: NodeJS.Timeout | null = null;

  /** progress.jsonl 의 새 내용을 동기로 한 번 읽고 onEvent 로 forward. */
  function drainOnce(): void {
    if (!foundJobId) return;
    const filePath = path.join(jobDirFor(foundJobId), "progress.jsonl");
    try {
      const st = fs.statSync(filePath);
      if (st.size <= readOffset) return;
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(st.size - readOffset);
      fs.readSync(fd, buf, 0, buf.length, readOffset);
      fs.closeSync(fd);
      readOffset = st.size;
      lineBuf += buf.toString("utf8");
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { stage?: unknown; detail?: unknown; ts?: unknown };
          if (typeof obj.stage === "string") {
            opts.onEvent({
              stage: obj.stage,
              detail: typeof obj.detail === "string" ? obj.detail : undefined,
              ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
            });
          }
        } catch {
          // 깨진 줄은 무시
        }
      }
    } catch {
      // progress.jsonl 아직 없음
    }
  }

  function tick(): void {
    if (stopped) return;

    if (!foundJobId) {
      try {
        const row = getDb()
          .prepare(
            "SELECT id FROM jobs WHERE kind = 'codex_image' AND started_at > ? " +
              "ORDER BY started_at DESC LIMIT 1",
          )
          .get(opts.turnStartTime) as { id: string } | undefined;
        if (row) foundJobId = row.id;
      } catch {
        // DB busy / locked — 다음 tick 에서 다시 시도
      }
    }

    drainOnce();

    if (!stopped) timer = setTimeout(tick, pollMs);
  }
  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // tool_result 와 progress.jsonl 의 마지막 줄 append 가 거의 동시에 발생하는
      // race 가 있다 (stop 시점에 polling cycle 사이에 들어온 줄이 누락). 마지막 한 번
      // 동기 drain 으로 남은 줄(보통 recovering / done)도 forward.
      drainOnce();
    },
    get jobId() {
      return foundJobId;
    },
  };
}
