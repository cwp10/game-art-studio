/**
 * DB 초기화 + 스모크 테스트.
 *   pnpm db:init
 *
 * 스키마는 client.ts 가 매 호출마다 IF NOT EXISTS 로 보장하므로,
 * 이 스크립트의 진짜 역할은 (1) WAL 파일 생성 (2) 한 행을 만들어보고 (3) 다시 지워 동작 확인.
 */

import { getDb } from "@/lib/db/client";
import { createSession, getSession, deleteSession } from "@/lib/db/repo/sessions";
import { DB_PATH } from "@/lib/util/paths";

function main() {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  console.log("[init-db] DB path:", DB_PATH);
  console.log("[init-db] tables:", tables.map(t => t.name).join(", "));

  // smoke
  const s = createSession("__smoke__");
  const fetched = getSession(s.id);
  if (!fetched) throw new Error("smoke: getSession returned null");
  deleteSession(s.id);
  console.log("[init-db] smoke ok (create→get→delete)");
}

main();
