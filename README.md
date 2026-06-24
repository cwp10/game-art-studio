# Game Art Studio

개인용 게임 에셋 이미지 생성기. Codex CLI 의 imagegen 스킬을 백엔드로, Claude Code CLI 를 오케스트레이션으로 사용하는 ChatGPT 스타일 단일 채팅 UI.

> EtherAI 튜토리얼의 워크플로(이미지 생성 / 편집 / 스프라이트 / 오케스트레이션)를 참고해 1인 로컬 도구로 재구성한 프로젝트.

## 특징

- **API 키 미사용** — Claude·Codex **구독 한도 안에서만** 동작
- **이미지 엔진** — `codex exec` spawn → imagegen 스킬 자동 발동 → gpt-image (imagegen 2.0)
- **오케스트레이션** — `claude -p --output-format stream-json` + MCP stdio 서버. 채팅 한 줄이
  Claude CLI → MCP 도구 → Codex CLI 체인을 타고 이미지를 만든다.
- **도구 13종** — generate / spritesheet / emote_sheet / tileset / normal_map / edit / upscale /
  resize / remove_bg / inpaint / reskin / composite / sprite_effect (MCP 도구로 노출, Claude 가 라우팅)
- **에디터** — 통합 캔버스(합성 · 자유변형 · 크롭 · 실시간 필터 · 배경제거 · 영역편집(인페인트) ·
  레이어 분리 · 업스케일) · 스프라이트시트(방향/onion/anchor/atlas/이펙트) · 리스킨 · 9-slice · 노멀맵,
  16:10 viewbox + zoom/pan 캔버스
- **라이브러리** — 스타일 프리셋, 프롬프트 라이브러리, 갤러리(검색·필터), 비교 시트
- **저장** — 이미지는 `./data/images/`, 썸네일은 `./data/thumbnails/`(on-demand), 메타는
  SQLite (`./data/app.db`, WAL 모드). 세션 삭제 시 그 세션 이미지 정리, `pnpm cleanup` 으로 누적 정리.
- **UI** — 다크 테마 3-column, 한국어, ChatGPT 스타일 단일 채팅창
- **Electron 셸** — `Game Art Studio.app` 더블클릭으로 실행. Next.js 프로덕션 서버를 자식 프로세스로 spawn, 포트가 열리면 BrowserWindow 로드. `pnpm app` 으로도 실행 가능.
- **로컬 전용** — `127.0.0.1` 바인딩 + `proxy.ts` host 가드, 인증 없음, 외부 트래커 없음

## 사전 조건

- `claude` CLI v2.1.150+ (`claude --version`)
- `codex` CLI v0.128.0+ (`codex --version`), Codex 계정 로그인 (`codex login`)
- Node.js 25+, pnpm 11+

## 실행

```bash
pnpm install
pnpm db:init        # SQLite 스키마 생성 + 마이그레이션 + smoke
pnpm build          # Next.js 프로덕션 빌드 (최초 1회 또는 코드 변경 시)
pnpm app            # Electron 앱 실행 (또는 Game Art Studio.app 더블클릭)
```

개발 서버:

```bash
pnpm dev            # http://127.0.0.1:3000 (브라우저 직접 접근)
```

단독 검증·유지보수용 CLI:

```bash
# Codex imagegen probe (M0 게이트)
pnpm probe

# ImageBackend 단독 이미지 1장 생성
pnpm tsx scripts/gen.ts "a red apple, simple illustration"

# data/ 누적 정리 — 고아 이미지·썸네일, 오래된 로그·jobs·tmp (기본 7일)
pnpm cleanup --dry-run     # 무엇이 지워질지 미리보기
pnpm cleanup               # 실제 정리
pnpm cleanup --days=30     # 보존 기간 조절

# 결정적 게이트 (codex 불필요) — GitHub Actions CI 가 PR 마다 자동 실행 (.github/workflows/ci.yml)
pnpm lint
pnpm test                  # 순수 단위 (분류/방향/마커) — DB·이미지 부수효과 없음
pnpm test:post             # 후처리 결정적 검증 (스프라이트시트/합성) — 로컬 전용
```

## 디렉토리

```
src/
├── app/                  # Next.js App Router
│   ├── api/              # chat, sessions, generations, images, thumbnails, presets, prompts,
│   │                     #   canvas-edit, composite, composite-ai, nine-slice(-scale/-trim),
│   │                     #   sprite-effect, sprite-frame, sprite-suggest, reskin(-suggest), button-states,
│   │                     #   normal-map, layer-suggest, suggest, filter, describe, export,
│   │                     #   upload, logs, status, config, cleanup
│   ├── page.tsx          # ChatLayout
│   └── globals.css       # 다크 팔레트
├── proxy.ts              # 로컬 전용 host 가드 (/api/*)
├── components/
│   ├── chat/             # ChatLayout / MessageList / Composer / ToolCallBlock / ImageResultCard / SessionList / StatusButton / chat-state / useStreamChat
│   ├── editor/           # CanvasEditor / SpriteCanvas / SpriteGenPanel / ReskinPanel / NineSliceEditor / ButtonStateEditor / NormalMapPanel / ImageToolsPanel / useZoomPan
│   └── library/          # GallerySheet / CompareSheet / PromptLibrarySheet / StylePresetPicker / LogsPanel
├── lib/
│   ├── db/               # better-sqlite3 클라이언트 + repo + schema.sql + migrate
│   ├── image-backend/    # ImageBackend 인터페이스 + codex-exec 어댑터 + 스프라이트시트 후처리 + recolor
│   ├── mcp/              # MCP stdio 서버 (도구 13종) + handlers + 스프라이트시트 분류
│   ├── cli/              # Claude CLI 어댑터 (stream-json) + progress tail
│   ├── prompt/           # system-orchestrator.md
│   ├── sse/              # SSE 스트림 헬퍼
│   ├── api/              # 클라이언트 fetch 래퍼
│   └── util/             # paths, ids, tmp-cleanup
└── types/
scripts/
├── probe-codex-imagegen.mjs   # M0 검증 (img2img/inpaint probe 도 동봉)
├── gen.ts                     # CLI 헬퍼
├── init-db.ts                 # DB 초기화 + 마이그레이션
├── cleanup.ts                 # data/ 누적 정리
└── test-*.ts                  # 스프라이트시트/분류/방향 단독 테스트
electron/
├── main.js               # Electron 메인 프로세스 (Next 서버 spawn + BrowserWindow)
├── splash.html           # 로딩 스플래시
└── icon.png              # 독 아이콘
icon-assets/              # 앱 아이콘 소스 (gitignore 권장)
├── Game Art Studio.icon/    # 아이콘 툴 프로젝트
└── icon-source-foreground.png
Game Art Studio.app/         # macOS 앱 번들 (더블클릭 실행)
data/                     # gitignored 런타임
├── app.db (+ -wal/-shm)
├── mcp.json                   # MCP 서버 설정 (Claude CLI 가 읽음)
├── images/{generation_id}.png
├── thumbnails/{generation_id}.webp   # 갤러리용, on-demand 생성
├── templates/                 # 스프라이트 그리드 템플릿 캐시
├── tmp/job-{id}/              # Codex 작업공간 (성공 시 삭제, 실패 시 보존)
└── logs/{claude,codex,mcp}-*.log
```


## 의식적 트레이드오프

CLI spawn 체인 (`/api/chat` → Claude CLI → MCP → Codex CLI) 은 SDK 직접 호출 대비 **5배 느리고** 토큰을 더 씁니다. 그럼에도 채택한 이유는:

1. 두 에이전트 CLI 가 협업하는 형태를 직접 경험·학습하기 위해
2. **구독 한도 안에서만** 쓰면 비용은 0 (개인용)
3. latency 만 감수하면 됨

`ImageBackend` 인터페이스로 분리되어 있어 SDK 직접 호출 경로로 언제든 교체 가능.
