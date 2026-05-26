import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, ensureDataDirs } from "@/lib/util/paths";
import { cleanupTmpJobs } from "@/lib/util/tmp-cleanup";
import { seedBuiltinPresets } from "./seed-presets";

/**
 * better-sqlite3 싱글톤.
 *
 * - WAL 모드 필수: MCP 서버 프로세스와 Next 프로세스가 같은 DB 를 공유함
 * - foreign_keys = ON: ON DELETE CASCADE 활용
 * - busy_timeout: 동시 쓰기 경합 시 자동 재시도 (밀리초)
 *
 * Next 의 dev 모드 HMR 에서 모듈이 여러 번 평가되어도 같은 connection 을 재사용하도록 globalThis 캐싱.
 */

type DbInstance = Database.Database;

const SCHEMA_PATH = path.join(process.cwd(), "src/lib/db/schema.sql");

declare global {
  // eslint-disable-next-line no-var
  var __imggen_db: DbInstance | undefined;
}

function init(): DbInstance {
  ensureDataDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // 스키마는 IF NOT EXISTS 라 매번 안전하게 실행 가능.
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  // builtin style preset seed — name UNIQUE + INSERT OR IGNORE 라 멱등.
  // 사용자가 builtin 의 prompt_suffix 를 수정하면 보존됨.
  seedBuiltinPresets(db);
  // tmp/job-* 24시간 이상 된 디렉토리 정리 — 멱등, 실패 시 throw 안 함.
  const { removed } = cleanupTmpJobs();
  if (removed > 0) console.log(`[db init] cleaned ${removed} old tmp/job-* dirs`);
  return db;
}

export function getDb(): DbInstance {
  if (!globalThis.__imggen_db) {
    globalThis.__imggen_db = init();
  }
  return globalThis.__imggen_db;
}
