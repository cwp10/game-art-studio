import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, ensureDataDirs } from "@/lib/util/paths";

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
  return db;
}

export function getDb(): DbInstance {
  if (!globalThis.__imggen_db) {
    globalThis.__imggen_db = init();
  }
  return globalThis.__imggen_db;
}
