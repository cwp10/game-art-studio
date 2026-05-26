-- image-generator SQLite schema
-- 모든 id 는 nanoid 문자열, timestamp 는 epoch ms (INTEGER).
-- 외부 키 + WAL 모드는 client.ts 에서 활성화.

-- ─── sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- ─── messages ─────────────────────────────────────────────────────────────
-- content 는 JSON 배열: [{type:'text'|'image_ref'|'tool_call'|'tool_result', ...}]
CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content             TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  claude_session_id   TEXT,
  meta                TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ─── generations ──────────────────────────────────────────────────────────
-- 한 번의 이미지 생성/편집 결과. messages 와는 N:1 가능 (한 메시지가 여러 결과를 만들 수 있음).
CREATE TABLE IF NOT EXISTS generations (
  id                TEXT PRIMARY KEY,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL
                    CHECK(kind IN ('text2img','img2img','upscale','remove_bg','inpaint','spritesheet')),
  prompt            TEXT,
  negative_prompt   TEXT,
  preset_id         TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
  input_image_ids   TEXT,                -- JSON 배열 of generation_id
  params            TEXT,                -- JSON: size, quality, n, grid 등
  image_path        TEXT NOT NULL,       -- DATA_DIR 기준 상대경로 (images/{id}.png)
  thumbnail_path    TEXT,
  width             INTEGER,
  height            INTEGER,
  backend           TEXT NOT NULL DEFAULT 'codex_exec'
                    CHECK(backend IN ('codex_exec','codex_pty','external','direct')),
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, created_at DESC);

-- ─── style_presets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS style_presets (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  prompt_suffix     TEXT NOT NULL,
  negative_suffix   TEXT,
  default_params    TEXT,
  is_builtin        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- ─── prompt_library ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompt_library (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  tags          TEXT,                    -- JSON 배열
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_lastused ON prompt_library(last_used_at DESC);

-- ─── jobs ──────────────────────────────────────────────────────────────────
-- CLI spawn 한 잡 추적 (디버깅/재시도).
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,           -- 'claude_orchestrate' | 'codex_image'
  status        TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  args          TEXT,
  result        TEXT,
  error         TEXT,
  work_dir      TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, started_at DESC);
