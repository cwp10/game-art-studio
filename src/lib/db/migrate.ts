import type Database from "better-sqlite3";
import fs from "node:fs";
import { DB_PATH } from "@/lib/util/paths";

/**
 * 스키마 마이그레이션 러너. client.ts 의 init() 에서 db.exec(schemaSql) 직후,
 * seedBuiltinPresets 전에 호출된다.
 *
 * 버저닝은 PRAGMA user_version (number) 으로 관리. 각 마이그레이션은
 * user_version 을 1 증가시키고, 멱등하도록 `if (v < N)` 가드로 1회만 실행한다.
 *
 * 되돌리기 어려운 스키마 변경이므로 v1 실행 전 data/app.db 를 .bak-v1 로 백업한다.
 */
export function runMigrations(db: Database.Database): void {
  const v = db.pragma("user_version", { simple: true }) as number;

  if (v < 1) {
    migrateV1(db);
    db.pragma("user_version = 1");
  }
  if (v < 2) {
    migrateV2(db);
    db.pragma("user_version = 2");
  }
  if (v < 3) {
    migrateV3(db);
    db.pragma("user_version = 3");
  }
}

/**
 * v1: kindHint 우회를 정식 kind enum (mask/layer/external) 으로 정리.
 *
 * 기존 행 매핑:
 *   params.kindHint='mask'     → kind='mask'
 *   params.kindHint='layer'    → kind='layer'
 *   params.kindHint='external' → kind='external'
 *   (그 외)                    → kind 그대로 유지
 * 모든 행에서 params.kindHint 키를 제거 (colorLabel/filename 등 다른 키는 보존).
 *
 * SQLite 는 CHECK 변경에 ALTER 가 불가하므로 테이블 재생성 방식을 쓴다.
 */
function migrateV1(db: Database.Database): void {
  // 마이그레이션이 필요한 시점에 1회 백업. WAL 모드이므로 메인 파일에 WAL 을 먼저 반영.
  // 신규 빈 DB(파일 막 생성, 0행) 도 v<1 이지만, 그 경우엔 백업해도 무해.
  const backupPath = DB_PATH + ".bak-v1";
  if (fs.existsSync(DB_PATH) && !fs.existsSync(backupPath)) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(DB_PATH, backupPath);
  }

  // 테이블 재생성 중에는 FK 를 꺼야 안전 (트랜잭션 밖에서 토글).
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE generations_new (
        id                TEXT PRIMARY KEY,
        session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL
                          CHECK(kind IN ('text2img','img2img','upscale','remove_bg','inpaint','spritesheet','mask','layer','external')),
        prompt            TEXT,
        negative_prompt   TEXT,
        preset_id         TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
        input_image_ids   TEXT,
        params            TEXT,
        image_path        TEXT NOT NULL,
        thumbnail_path    TEXT,
        width             INTEGER,
        height            INTEGER,
        backend           TEXT NOT NULL DEFAULT 'codex_exec'
                          CHECK(backend IN ('codex_exec','codex_pty','external','direct')),
        created_at        INTEGER NOT NULL
      );

      INSERT INTO generations_new
      SELECT id, session_id, message_id,
        CASE json_extract(params,'$.kindHint')
          WHEN 'mask' THEN 'mask'
          WHEN 'layer' THEN 'layer'
          WHEN 'external' THEN 'external'
          ELSE kind END,
        prompt, negative_prompt, preset_id, input_image_ids,
        CASE WHEN params IS NULL THEN NULL ELSE json_remove(params,'$.kindHint') END,
        image_path, thumbnail_path, width, height, backend, created_at
      FROM generations;

      DROP TABLE generations;
      ALTER TABLE generations_new RENAME TO generations;

      CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, created_at DESC);

      COMMIT;
    `);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * v2: generations.kind CHECK 에 'reskin' 추가 (리스킨 도구 결과 kind).
 *
 * SQLite 는 CHECK 변경에 ALTER 가 불가하므로 테이블 재생성 방식. 데이터 변형은
 * 없고 CHECK 제약만 확장하므로 straight copy 한다.
 */
function migrateV2(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE generations_new (
        id                TEXT PRIMARY KEY,
        session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL
                          CHECK(kind IN ('text2img','img2img','upscale','remove_bg','inpaint','spritesheet','mask','layer','external','reskin')),
        prompt            TEXT,
        negative_prompt   TEXT,
        preset_id         TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
        input_image_ids   TEXT,
        params            TEXT,
        image_path        TEXT NOT NULL,
        thumbnail_path    TEXT,
        width             INTEGER,
        height            INTEGER,
        backend           TEXT NOT NULL DEFAULT 'codex_exec'
                          CHECK(backend IN ('codex_exec','codex_pty','external','direct')),
        created_at        INTEGER NOT NULL
      );

      INSERT INTO generations_new
      SELECT id, session_id, message_id, kind, prompt, negative_prompt, preset_id,
        input_image_ids, params, image_path, thumbnail_path, width, height, backend, created_at
      FROM generations;

      DROP TABLE generations;
      ALTER TABLE generations_new RENAME TO generations;

      CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, created_at DESC);

      COMMIT;
    `);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * v3: generations.kind CHECK 에 'resize' 추가 (resize_image 도구 결과 kind).
 *
 * SQLite 는 CHECK 변경에 ALTER 가 불가하므로 테이블 재생성 방식. 데이터 변형은
 * 없고 CHECK 제약만 확장하므로 straight copy 한다.
 */
function migrateV3(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE generations_new (
        id                TEXT PRIMARY KEY,
        session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL
                          CHECK(kind IN ('text2img','img2img','upscale','remove_bg','inpaint','spritesheet','mask','layer','external','reskin','resize')),
        prompt            TEXT,
        negative_prompt   TEXT,
        preset_id         TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
        input_image_ids   TEXT,
        params            TEXT,
        image_path        TEXT NOT NULL,
        thumbnail_path    TEXT,
        width             INTEGER,
        height            INTEGER,
        backend           TEXT NOT NULL DEFAULT 'codex_exec'
                          CHECK(backend IN ('codex_exec','codex_pty','external','direct')),
        created_at        INTEGER NOT NULL
      );

      INSERT INTO generations_new
      SELECT id, session_id, message_id, kind, prompt, negative_prompt, preset_id,
        input_image_ids, params, image_path, thumbnail_path, width, height, backend, created_at
      FROM generations;

      DROP TABLE generations;
      ALTER TABLE generations_new RENAME TO generations;

      CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, created_at DESC);

      COMMIT;
    `);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
