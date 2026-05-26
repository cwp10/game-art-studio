import fs from "node:fs";
import path from "node:path";
import { TMP_DIR } from "@/lib/util/paths";

/**
 * data/tmp/job-* 디렉토리 중 mtime 이 maxAgeMs 이전인 것을 삭제. 멱등, 동기.
 *
 * codex job 의 work_dir 는 보통 짧게 사용되고 generation 행이 만들어진 뒤 보존 의미 없음.
 * dev 중 100+ 개 누적되어 disk 차오르는 것 방지. 기본 24시간.
 *
 * db client init 시 호출. 실패 시 throw 안 함 (cleanup 실패가 앱 부팅 막으면 안 됨).
 */
export function cleanupTmpJobs(maxAgeMs = 24 * 60 * 60 * 1000): { removed: number } {
  let removed = 0;
  try {
    if (!fs.existsSync(TMP_DIR)) return { removed };
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_DIR)) {
      if (!name.startsWith("job-")) continue;
      const p = path.join(TMP_DIR, name);
      try {
        const st = fs.statSync(p);
        if (!st.isDirectory()) continue;
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // 개별 디렉토리 실패는 무시 — 다음 cleanup 에서 재시도.
      }
    }
  } catch {
    // 전체 실패도 무시.
  }
  return { removed };
}
