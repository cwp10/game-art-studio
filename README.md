# SpriteForge

개인용 게임 에셋 이미지 생성기. Codex CLI 의 imagegen 스킬을 백엔드로, Claude Code CLI 를 오케스트레이션으로 사용하는 ChatGPT 스타일 단일 채팅 UI.

> EtherAI 튜토리얼의 워크플로(이미지 생성 / 편집 / 스프라이트 / 오케스트레이션)를 참고해 1인 로컬 도구로 재구성한 프로젝트.

## 특징

- **API 키 미사용** — Claude·Codex **구독 한도 안에서만** 동작
- **이미지 엔진** — `codex exec` spawn → imagegen 스킬 자동 발동 → gpt-image (imagegen 2.0)
- **오케스트레이션** (M3 예정) — `claude -p --output-format stream-json` + MCP 도구
- **저장** — 이미지는 `./data/images/`, 메타는 SQLite (`./data/app.db`, WAL 모드)
- **UI** — 다크 테마 3-column, 한국어, ChatGPT 스타일 단일 채팅창
- **로컬 전용** — `127.0.0.1` 바인딩, 인증 없음, 외부 트래커 없음

## 사전 조건

- `claude` CLI v2.1.150+ (`claude --version`)
- `codex` CLI v0.128.0+ (`codex --version`), Codex 계정 로그인 (`codex login`)
- Node.js 25+, pnpm 11+

## 실행

```bash
pnpm install
pnpm db:init        # SQLite 스키마 생성 + smoke
pnpm dev            # http://127.0.0.1:3000
```

단독 검증용 CLI:

```bash
# Codex imagegen probe (M0 게이트)
pnpm probe

# ImageBackend 단독 이미지 1장 생성
pnpm tsx scripts/gen.ts "a red apple, simple illustration"
```

## 디렉토리

```
src/
├── app/                  # Next.js App Router
│   ├── api/{chat,sessions,generations,images}/...
│   ├── page.tsx          # ChatLayout
│   └── globals.css       # 다크 팔레트
├── components/chat/      # ChatLayout / MessageList / Composer / ToolCallBlock / ImageResultCard
├── lib/
│   ├── db/               # better-sqlite3 클라이언트 + repo
│   ├── image-backend/    # ImageBackend 인터페이스 + codex-exec 어댑터
│   ├── sse/              # SSE 스트림 헬퍼
│   ├── api/              # 클라이언트 fetch 래퍼
│   └── util/             # paths, ids
└── types/
scripts/
├── probe-codex-imagegen.mjs   # M0 검증
├── gen.ts                     # CLI 헬퍼
└── init-db.ts                 # DB 초기화
data/                          # gitignored 런타임
├── app.db (+ -wal/-shm)
├── images/{generation_id}.png
├── thumbnails/
├── tmp/job-{id}/              # Codex 작업공간
└── logs/codex-{job_id}.log
```

## 진행 상태

```
✅ M0  Codex imagegen probe        — `codex exec` 자동 발동 검증 (66s, 1254×1254)
✅ M1  ImageBackend 단독 검증       — scripts/gen.ts 동작
✅ M2  최소 채팅 UI (Claude 미도입)  — SSE 7개 이벤트 시퀀스 정확, E2E 통과
⬜ M3  Claude CLI + MCP 오케스트레이션 — 프롬프트 정제 / 도구 라우팅
⬜ M4  편집·스프라이트 도구 확장      — edit/upscale/remove_bg/inpaint/spritesheet
⬜ M5  프롬프트 라이브러리 / 스타일 프리셋
⬜ M6  갤러리·검색·다듬기
```

자세한 설계는 `~/.claude/plans/https-www-aetherforgeai-com-ko-tutorial-breezy-puffin.md` 참고.

## 의식적 트레이드오프

CLI spawn 체인 (`/api/chat` → Claude CLI → MCP → Codex CLI) 은 SDK 직접 호출 대비 **5배 느리고** 토큰을 더 씁니다. 그럼에도 채택한 이유는:

1. 두 에이전트 CLI 가 협업하는 형태를 직접 경험·학습하기 위해
2. **구독 한도 안에서만** 쓰면 비용은 0 (개인용)
3. latency 만 감수하면 됨

`ImageBackend` 인터페이스로 분리되어 있어 SDK 직접 호출 경로로 언제든 교체 가능.
