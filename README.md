# Game Art Studio

개인용 게임 에셋 이미지 생성기. Codex CLI 의 imagegen 스킬을 백엔드로, Claude Code CLI 를 오케스트레이션으로 사용하는 ChatGPT 스타일 단일 채팅 UI.

> EtherAI 튜토리얼의 워크플로(이미지 생성 / 편집 / 스프라이트 / 오케스트레이션)를 참고해 1인 로컬 도구로 재구성한 프로젝트.

---

## 구현된 기능

### 이미지 생성 (MCP 도구 13종)

Claude CLI 가 채팅 한 줄을 받아 MCP 도구를 선택·라우팅하고, Codex CLI → gpt-image(imagegen 2.0) 체인으로 이미지를 생성한다.

| 도구 | 설명 |
|------|------|
| `generate_image` | 자연어 프롬프트 → 단일 이미지 생성 |
| `make_spritesheet` | 캐릭터/오브젝트 스프라이트시트 생성 (방향 수·프레임 수 지정, seamless loop) |
| `make_emote_sheet` | 감정 표현 이모트 시트 생성 |
| `make_tileset` | 타일셋 생성 |
| `generate_normal_map` | 이미지에서 노멀맵 자동 생성 |
| `edit_image` | 이미지 편집 (프롬프트 기반) |
| `upscale_image` | 이미지 업스케일 |
| `resize_image` | 이미지 리사이즈 |
| `remove_background` | 배경 제거 (chroma-key + AI) |
| `inpaint_image` | 마스크 영역 인페인트 |
| `reskin_image` | 색·재질 리스킨 (팔레트 스왑 / 화풍 변환) |
| `composite_scene` | 다층 합성 (레이어 transform + 필터 포함) |
| `apply_sprite_effect` | 스프라이트시트 이펙트 적용 (드롭섀도우·아웃라인·글로우) |

---

### 캔버스 에디터 (`CanvasEditor`)

채팅창 우측 패널을 전환해 열리는 통합 이미지 편집기. `fixed inset-0 z-40` 전체화면.

- **다층 레이어 합성** — 레이어 추가·삭제·재정렬·가시성 토글·불투명도 조절
- **자유변형** — 드래그 이동·핸들 리사이즈·회전·좌우 뒤집기
- **실시간 필터** — 밝기·대비·채도·색조(hue)·블러 (레이어별 독립 적용)
- **배경 제거** — 선택 레이어에 chroma-key + AI 배경 제거
- **크롭(Trim)** — 투명 여백 자동 제거
- **업스케일** — 선택 레이어 고해상도 업스케일 후 레이어 교체
- **영역 편집(인페인트)** — 브러시로 마스크 칠 → 프롬프트 입력 → 해당 영역만 재생성
- **레이어 분리(Extract)** — 마스크 브러시로 부위 선택 → 새 레이어로 추출 (AI 부위 이름 제안 포함)
- **합성(Flatten)** — 전체 레이어를 `/api/composite` 로 한 장으로 굽기 (서버사이드 sharp)
- **Undo/Redo** — 캔버스 스냅샷 기반 실행취소·재실행
- **Zoom/Pan** — 16:10 viewbox, 마우스 휠 줌 + 드래그 패닝

---

### 스프라이트시트 뷰어/에디터 (`SpriteCanvas`)

스프라이트시트 결과 카드에서 열리는 전용 에디터.

- **애니메이션 재생** — FPS 조절(1~30), 재생/정지, 방향별 행 선택 재생
- **방향 시트** — 2/4/8 방향 라벨 자동 인식 (Down·Left·Right·Up 등 게임 관례)
- **Onion Skin** — 앞뒤 프레임 반투명 오버레이
- **앵커 포인트** — 드래그로 기준점 설정 (셀 내 픽셀 좌표로 내보내기)
- **프레임 재정렬** — 드래그 앤 드롭으로 재생 순서 변경
- **프레임 제외** — 특정 프레임 재생·내보내기에서 제외
- **프레임 재생성** — 선택 셀만 `/api/sprite-frame/regenerate` 로 단독 재생성 후 시트에 교체
- **GIF 내보내기** — 선택 프레임 → 애니메이션 GIF (브라우저 캔버스 합성)
- **ZIP 내보내기** — 개별 프레임 PNG 묶음 다운로드
- **Atlas 내보내기** — TexturePacker·Unity·Phaser·Custom 포맷 메타데이터 JSON 생성
- **이펙트 적용** — 드롭섀도우·아웃라인·글로우 (색·불투명도·크기·블러 조절)
- **셀 정규화 후처리** — 서버사이드: 녹색 배경 검출 → chroma-key, 앵커 기준 셀 정렬

---

### 리스킨 패널 (`ReskinPanel`)

선택 이미지의 색·재질을 일괄 교체.

- **팔레트 스왑** — 원본 색→대상 색 매핑 (최대 6쌍)
- **화풍 변환** — 스타일 프롬프트로 전면 reskin (픽셀아트·수채화 등)
- **AI 색 제안** — `/api/reskin-suggest` 로 팔레트 자동 추출 + 대체 색 제안
- **레이어 분리** — 시트 전체 또는 첨부 레이어 기반 리스킨

---

### 9-Slice 에디터 (`NineSliceEditor`)

UI 버튼·패널용 9-슬라이스 처리.

- **인셋 조절** — 상·하·좌·우 inset 픽셀 독립 설정
- **9-Slice 그리드 생성** — `/api/nine-slice` → 3×3 분할 이미지 PNG 생성
- **스케일 미리보기** — `/api/nine-slice-scale` → 목표 해상도로 코너 보존 스케일링
- **Trim** — `/api/nine-slice-trim` → 투명 여백 제거 후 인셋 재계산

---

### 버튼 상태 에디터 (`ButtonStateEditor`)

UI 버튼의 상태별 변형 자동 생성.

- **3개 상태 자동 생성** — Normal·Hover·Pressed (밝기·채도·색조 조합)
- **파라미터 미세 조정** — 각 상태별 밝기·채도·색조 수치 직접 편집
- **추가 생성** — 기존 세트에 새 Normal 이미지를 더해 세트 확장

---

### 노멀맵 패널 (`NormalMapPanel`)

픽셀아트 스프라이트용 노멀맵 생성.

- **자동 생성** — `/api/normal-map` → 원본 이미지에서 노멀맵 PNG 생성
- **강도 조절** — strength 파라미터로 법선 강도 조절

---

### 합성 에디터 (AI 레이어 제안)

`/api/composite-ai` 와 `/api/layer-suggest` 를 통한 AI 보조 합성.

- **레이어 분리 AI 제안** — 선택 영역에서 부위 이름 자동 추출 제안
- **AI 배치 제안** — 여러 에셋을 합성할 때 레이어 순서·위치 AI 추천

---

### 채팅 UI

- **SSE 스트림** — `claude -p --output-format stream-json` 실시간 스트리밍
- **도구 호출 블록 (`ToolCallBlock`)** — MCP 도구 호출 과정을 채팅 안에 인라인 표시
- **이미지 결과 카드 (`ImageResultCard`)** — 생성된 이미지에서 즉시 편집·다운로드·첨부·갤러리 삽입
- **파일 첨부** — 로컬 이미지 첨부 → `/api/upload` 업로드 → 대화에 참조 이미지로 활용
- **세션 관리** — 세션 생성·이름변경·삭제, 좌측 사이드바 목록

---

### 라이브러리

- **갤러리 (`GallerySheet`)** — 전체 생성 이미지 그리드, 프롬프트 검색 + kind 필터(스프라이트/타일셋 등), 첨부·PNG 다운로드
- **비교 시트 (`CompareSheet`)** — 두 이미지 나란히 비교
- **프롬프트 라이브러리 (`PromptLibrarySheet`)** — 재사용 프롬프트 저장·불러오기
- **스타일 프리셋 (`StylePresetPicker`)** — 픽셀아트·수채화 등 스타일 프리셋 선택 → 프롬프트에 자동 삽입
- **로그 패널 (`LogsPanel`)** — Claude/Codex/MCP 실시간 로그 열람

---

### 저장 & 데이터

- **이미지** — `./data/images/{generation_id}.png`
- **썸네일** — `./data/thumbnails/{generation_id}.webp` (on-demand 생성, 갤러리용)
- **메타데이터** — SQLite (`./data/app.db`, WAL 모드) — sessions, generations, prompts, presets, jobs 테이블
- **정리** — 세션 삭제 시 해당 세션 이미지 자동 정리, `pnpm cleanup` 으로 고아 파일·오래된 로그 일괄 정리

---

### 인프라

- **API 키 미사용** — Claude·Codex 구독 한도 안에서만 동작
- **이미지 엔진** — `codex exec` spawn → imagegen 스킬 자동 발동 → gpt-image (imagegen 2.0)
- **오케스트레이션** — `claude -p --output-format stream-json` + MCP stdio 서버
- **Electron 셸** — `Game Art Studio.app` 더블클릭 실행. Next.js 프로덕션 서버를 자식 프로세스로 spawn
- **로컬 전용** — `127.0.0.1` 바인딩 + `proxy.ts` host 가드, 인증 없음, 외부 트래커 없음
- **UI** — 다크 테마 3-column, 한국어

---

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

## 배포 빌드 (Electron 패키징)

`electron-builder`로 패키징하면 Next.js 서버를 내장한 단독 실행 앱을 만든다.  
빌드 결과는 `dist/` 하위에 생성되며 `.gitignore` 처리되어 있다.

### 사전 조건 (빌드 머신 공통)

| 항목 | 최소 버전 | 비고 |
|------|-----------|------|
| Node.js | 20+ | `node -v` |
| pnpm | 10+ | `pnpm -v` |
| `@openai/codex` 전역 설치 | 최신 | `npm i -g @openai/codex` |
| `claude` CLI | 2.1.150+ | Anthropic Claude Code CLI |

> Codex · Claude 각각의 계정 로그인(`codex login`, `claude login`)이 먼저 되어 있어야 한다.

---

### macOS 빌드

```bash
pnpm dist:mac
# 내부 흐름: pnpm build → electron-builder --mac
```

출력: `dist/mac/Game Art Studio.app`

```bash
# 실행
open "dist/mac/Game Art Studio.app"
# 또는 Finder에서 더블클릭
```

> **주의** — `icon-assets/AppIcon.icns` 가 없으면 기본 Electron 아이콘으로 패키징된다.  
> `pnpm run gen-icon` (또는 `scripts/gen-app-icon-foreground.mjs`) 로 아이콘을 먼저 생성하거나 수동 배치 후 빌드할 것.

---

### Windows 빌드

```bash
pnpm dist:win
# 내부 흐름: pnpm build → electron-builder --win --x64
```

출력: `dist\win-unpacked\Game Art Studio.exe`

```bash
# 실행 (PowerShell)
& "dist\win-unpacked\Game Art Studio.exe"
```

**Windows 특이사항:**

- Electron 앱 구동 시 `%APPDATA%\npm` 과 `%LOCALAPPDATA%\pnpm` 이 `PATH` 에 자동 추가된다 (`electron/main.js`).
- `codex exec` 는 `shell: false` 로 `node.exe`를 직접 spawn해 cmd.exe 경유 프롬프트 파싱 문제를 우회한다.  
  `@openai/codex` 가 **전역(`npm i -g`)으로** 설치되어 있어야 앱이 해당 경로를 찾을 수 있다.
- `pnpm` 으로 전역 설치한 경우 `%LOCALAPPDATA%\pnpm` 에서 탐색한다.

---

### 빌드 스크립트 요약

| 명령 | 동작 |
|------|------|
| `pnpm build` | Next.js 프로덕션 빌드 + MCP 서버 번들 |
| `pnpm dist:mac` | 빌드 → macOS 앱 번들 생성 |
| `pnpm dist:win` | 빌드 → Windows EXE 디렉토리 생성 |
| `pnpm pack:mac` | 빌드 없이 electron-builder macOS 패키징만 |
| `pnpm pack:win` | 빌드 없이 electron-builder Windows 패키징만 |

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
