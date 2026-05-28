/**
 * data/ 누적 데이터 정리.
 *   pnpm cleanup [--days=7] [--dry-run]
 *
 * 정리 대상:
 *   (a) 고아 이미지/썸네일 — DB(generations)에 없는 data/images/*.png, data/thumbnails/*.webp
 *   (b) 오래된 로그 — data/logs/*.log 중 mtime 이 N일 이전인 것. mcp-server.log 는
 *       삭제하지 않고 크기 상한(LOG_CAP) 초과 시 tail 만 남기고 truncate.
 *   (c) 오래된 jobs 행 — 터미널(succeeded/failed/cancelled) + pending 좀비 중 started_at 이 N일 이전
 *   (d) data/tmp/job-* — N일 이전 작업 디렉토리 (tmp-cleanup 재사용)
 *   (e) 파일 없는 generation 행 — image_path 원본이 디스크에 없는 DB 행 + 해당 썸네일
 *
 * --dry-run 이면 아무것도 지우지 않고 건수만 출력.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import {
  IMAGES_DIR,
  THUMBS_DIR,
  LOGS_DIR,
  TMP_DIR,
  resolveImagePath,
  thumbnailPath,
} from "@/lib/util/paths";

const DAY_MS = 24 * 60 * 60 * 1000;
const MCP_LOG = "mcp-server.log";
const LOG_CAP = 5 * 1024 * 1024; // mcp-server.log 가 이보다 크면 truncate
const LOG_KEEP_TAIL = 1024 * 1024; // 남길 tail 바이트

function parseArgs(argv: string[]): { days: number; dry: boolean } {
  let days = 7;
  let dry = false;
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") dry = true;
    else if (a.startsWith("--days=")) {
      const n = Number(a.slice("--days=".length));
      if (Number.isFinite(n) && n >= 0) days = n;
    }
  }
  return { days, dry };
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function main() {
  const { days, dry } = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - days * DAY_MS;
  const db = getDb();
  const tag = dry ? "[dry-run]" : "[cleanup]";
  console.log(`${tag} days=${days} cutoff=${new Date(cutoff).toISOString()}`);

  let freedBytes = 0;

  // ── (a) 고아 이미지/썸네일 ────────────────────────────────────────────────
  const imageFiles = new Set(
    (db.prepare("SELECT image_path FROM generations").all() as { image_path: string }[]).map(r =>
      path.basename(r.image_path),
    ),
  );
  const validIds = new Set(
    (db.prepare("SELECT id FROM generations").all() as { id: string }[]).map(r => r.id),
  );

  let orphanImages = 0;
  for (const name of listFiles(IMAGES_DIR)) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    if (imageFiles.has(name)) continue;
    const p = path.join(IMAGES_DIR, name);
    freedBytes += statSizeQuiet(p);
    orphanImages++;
    if (!dry) fs.rmSync(p, { force: true });
  }

  let orphanThumbs = 0;
  for (const name of listFiles(THUMBS_DIR)) {
    if (!name.toLowerCase().endsWith(".webp")) continue;
    const id = name.slice(0, -".webp".length);
    if (validIds.has(id)) continue;
    const p = path.join(THUMBS_DIR, name);
    freedBytes += statSizeQuiet(p);
    orphanThumbs++;
    if (!dry) fs.rmSync(p, { force: true });
  }

  // ── (b) 오래된 로그 + mcp-server.log truncate ─────────────────────────────
  let oldLogs = 0;
  let truncatedLog = false;
  for (const name of listFiles(LOGS_DIR)) {
    if (!name.endsWith(".log")) continue;
    const p = path.join(LOGS_DIR, name);
    if (name === MCP_LOG) {
      const size = statSizeQuiet(p);
      if (size > LOG_CAP) {
        truncatedLog = true;
        freedBytes += size - LOG_KEEP_TAIL;
        if (!dry) truncateTail(p, LOG_KEEP_TAIL);
      }
      continue;
    }
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) {
        freedBytes += st.size;
        oldLogs++;
        if (!dry) fs.rmSync(p, { force: true });
      }
    } catch {
      /* skip */
    }
  }

  // ── (c) 오래된 jobs 행 ────────────────────────────────────────────────────
  const oldJobsCount = (
    db
      .prepare(
        "SELECT count(*) AS c FROM jobs WHERE started_at < ? AND " +
          "(status IN ('succeeded','failed','cancelled') OR status = 'pending')",
      )
      .get(cutoff) as { c: number }
  ).c;
  if (!dry && oldJobsCount > 0) {
    db.prepare(
      "DELETE FROM jobs WHERE started_at < ? AND " +
        "(status IN ('succeeded','failed','cancelled') OR status = 'pending')",
    ).run(cutoff);
  }

  // ── (d) data/tmp/job-* ────────────────────────────────────────────────────
  let oldTmp = 0;
  for (const name of listFiles(TMP_DIR)) {
    if (!name.startsWith("job-")) continue;
    const p = path.join(TMP_DIR, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        oldTmp++;
        if (!dry) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      /* skip */
    }
  }

  // ── (e) 파일 없는 generation 행 ───────────────────────────────────────────
  // image_path 의 원본이 디스크에 없으면(수동 삭제 등) DB 행 + 썸네일을 정리.
  let deadRows = 0;
  const allGens = db
    .prepare("SELECT id, image_path FROM generations")
    .all() as { id: string; image_path: string }[];
  for (const g of allGens) {
    if (fs.existsSync(resolveImagePath(g.image_path))) continue;
    deadRows++;
    const thumb = thumbnailPath(g.id);
    freedBytes += statSizeQuiet(thumb);
    if (!dry) {
      db.prepare("DELETE FROM generations WHERE id = ?").run(g.id);
      fs.rmSync(thumb, { force: true });
    }
  }

  console.log(`${tag} 고아 이미지: ${orphanImages}개`);
  console.log(`${tag} 고아 썸네일: ${orphanThumbs}개`);
  console.log(`${tag} 파일 없는 generation 행: ${deadRows}개`);
  console.log(`${tag} 오래된 로그: ${oldLogs}개${truncatedLog ? ` + ${MCP_LOG} truncate` : ""}`);
  console.log(`${tag} 오래된 jobs 행: ${oldJobsCount}개`);
  console.log(`${tag} 오래된 tmp/job-* 디렉토리: ${oldTmp}개`);
  console.log(`${tag} ${dry ? "예상 회수" : "회수"} 용량: ~${fmtBytes(freedBytes)}`);
  if (dry) console.log(`${tag} 실제로 지우려면 --dry-run 을 빼고 다시 실행하세요.`);
}

function statSizeQuiet(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 파일의 마지막 keepBytes 만 남기고 앞부분을 잘라낸다 (로그 회전 대용). */
function truncateTail(p: string, keepBytes: number): void {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length <= keepBytes) return;
    const tail = buf.subarray(buf.length - keepBytes);
    const header = Buffer.from(
      `# [cleanup] truncated at ${new Date().toISOString()}, kept last ${keepBytes} bytes\n`,
    );
    fs.writeFileSync(p, Buffer.concat([header, tail]));
  } catch {
    /* skip */
  }
}

main();
