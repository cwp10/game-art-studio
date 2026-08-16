---
name: fullstack-boundary-dev
description: image-generator의 풀스택 경계면(Next.js API 라우트, MCP 도구 스키마, SQLite repo/schema, SSE 스트림, React chat/editor 컴포넌트)을 구현·수정할 때 사용. API 추가/수정, DB 마이그레이션, chat SSE 이벤트, MCP 도구 입출력 계약, ImageResultCard·Composer·SpriteCanvas 등 컴포넌트, fetch 래퍼 작업에 반드시 사용. "API 라우트", "DB 스키마", "SSE", "컴포넌트", "경계면 정합성" 작업에 적용.
---

# Fullstack Boundary Dev

React → API → MCP → codex → SQLite를 가로지르는 경계면을 정합성 있게 수정하기 위한 가이드. fullstack-engineer가 사용한다.

## 경계면 지도 (데이터가 흐르는 길)

```
React(components) ⇄ lib/api/client.ts ⇄ app/api/* (Next)
                                          ⇄ Claude CLI(spawn) ⇄ MCP server.ts ⇄ codex
                                          ⇄ SQLite(WAL) ⇆ MCP server.ts(별도 프로세스)
```

**Next와 MCP 서버는 별도 프로세스이며 WAL로 같은 `data/app.db`를 공유한다.** 한쪽에서 쓴 행을 다른 쪽이 읽는다.

## 핵심 파일 지도

### API 라우트 (`src/app/api/`)
button-states, canvas-edit/[seedId], chat, cleanup, composite, composite-ai, config, describe, export, filter, generations, generations/[id], images/[id], images/[id]/opacity, layer-suggest, logs, nine-slice, nine-slice-scale, nine-slice-trim, normal-map, presets, presets/[id], prompts, prompts/[id], reskin/recolor, reskin-suggest, sessions, sessions/[id], sessions/[id]/gallery-insert, sessions/[id]/messages, sprite-effect, sprite-frame/regenerate, sprite-suggest, status, suggest, thumbnails/[id], upload

### React 컴포넌트 (`src/components/`)
**chat:** ChatLayout, Composer, ImageResultCard, MessageList, SessionList, StatusButton, ToolCallBlock, chat-state.ts, useStreamChat.ts(SSE 스트림 소비 훅)  
**editor:**
- `CanvasEditor.tsx` — 전체전환 레이어 캔버스 (~3,100줄). 자유변형(모서리=크기/노브=회전/변=비균일 늘이기), 레이어 레일+드래그정렬, 선택레이어 필터(픽셀화 포함), undo/redo, 에셋피커, 합치기, 인페인트 마스크(브러시 전용)·올가미 액션(누끼/복제/이동). 구 SceneComposer/LayerCanvas/MaskCanvas 역할을 흡수한 단일 캔버스. **브라우저 전용**: 외부 변형 수학(local 좌표 투영). CSS filter로 라이브 미리보기 → composite API로 확정.
- `SpriteCanvas.tsx` — 스프라이트시트 뷰어·셀 편집·어니언 스킨·프레임 재생성 UI
- `SpriteGenPanel.tsx` — 스프라이트 생성 패널 (`buildSpriteMessage` 포함)
- `NineSliceEditor.tsx` — 9-slice 슬라이스 라인 오버레이 UI
- `ButtonStateEditor.tsx` — 버튼 상태 3슬롯 미리보기
- `ReskinPanel.tsx` — 리스킨 파라미터 UI
- `NormalMapPanel.tsx` — 노멀 맵 생성 UI
- `useZoomPan.tsx` — 캔버스 줌/팬 공용 훅
- `AiSuggestControls.tsx`, `ImageToolsPanel.tsx`, `PanelFooter.tsx`

### 클라이언트 래퍼 (`src/lib/api/client.ts`)
`compositeScene`, `uploadImage`, `getGeneration` 등 fetch 래퍼. CanvasEditor는 직접 fetch 대신 이 래퍼를 사용.

### CLI (`src/lib/cli/`)
`claude-cli.ts` — Claude CLI spawn, `progress-tail.ts` — progress.jsonl tail

### Electron 셸 (`electron/`)
`main.js` — 데스크톱 창 관리·splash·spawn 창 숨김(Windows headless), `preload.js`. 패키징: `pnpm dist:mac` / `dist:win` (electron-builder → `dist/`, lint 제외 대상).

### DB (`src/lib/db/`)
`client.ts`(싱글톤 WAL), `schema.sql`(IF NOT EXISTS 멱등), `migrate.ts`(v1~v11), repo 모듈들

## 깨지기 쉬운 계약 (한쪽 바꾸면 반대쪽도)

1. **MCP `structuredContent` ↔ ImageResultCard**
   `{generationId, imagePath:"/api/images/{id}", width, height, elapsedMs}` — 원천 타입은 `src/lib/mcp/handlers/shared.ts`의 `ToolResponse`. 필드명/타입을 바꾸면 ImageResultCard와 chat-state 양쪽을 함께 수정.
2. **generations.kind CHECK enum ↔ 새 kind 추가**
   schema.sql 의 kind CHECK 는 20종을 허용한다: `text2img/img2img/upscale/remove_bg/inpaint/spritesheet/mask/layer/external/reskin/resize/emote_sheet/tileset/normal_map/layer_extract/composite/sprite_effect/nine_slice/nine_slice_scaled/button_state`.
   **새 kind 는 enum 을 늘려서 추가한다.** 과거 `params.kindHint` 로 우회하던 패턴은 `migrate.ts` v1 이 정식 enum(mask/layer/external)으로 정리했으므로 되살리지 않는다 — 현재 `kindHint` 는 migrate.ts 의 과거 데이터 변환 코드에만 남아 있다.
   SQLite 는 CHECK 를 ALTER 로 못 바꾼다. 새 kind 추가는 `migrate.ts` 에 테이블 재생성 마이그레이션(v2~v11 이 전부 이 패턴)을 더한다.
   **최종 CHECK 를 결정하는 것은 항상 migrate.ts 의 마지막 마이그레이션이다.** 신규 DB 도 `user_version` 0 에서 시작하므로 `client.ts` 의 `init()` 이 schema.sql 을 실행한 직후 v1~v11 을 전부 돌린다 — schema.sql 의 CHECK 는 그 직후 덮어써지는 초기 골격일 뿐이다.
   따라서 필수는 `migrate.ts` + `src/types/db.ts` 유니온(타입 체크는 별도 경로) 두 곳이고, `schema.sql` 은 런타임에 영향이 없어도 **같이 맞춰라** — 안 맞으면 그 파일만 읽고 허용 kind 를 오해한다.
3. **chat stream-json 이벤트 ↔ chat-state items 모델**
   chat/route가 Claude CLI의 stream-json을 ChatEvent(assistant_text / tool_call_started / tool_call_finished / message_completed)로 매핑하고, chat-state.ts의 단일 `items` 배열이 이를 소비한다. 이벤트를 추가하면 reducer도 함께.
4. **progress.jsonl ↔ tailProgress()**
   MCP가 `data/tmp/job-{id}/progress.jsonl`에 stage를 append, chat/route가 forward-polling으로 tail해 진행 표시. stage 이름 변경은 양쪽 동기화.

## API 라우트 패턴 (src/app/api/)

- chat: POST SSE 메인 오케스트레이션. images/[id]: PNG ReadStream(404/410). generations: GET 목록 필터. upload/layers: dataUrl→generation 행. suggest: claude 짧은 호출 + 캐시. logs: tail/SSE, SAFE_NAME 경로 탈출 차단.
- sessions/presets/prompts: 표준 REST(GET·POST, [id] GET·PATCH·DELETE).

## DB 패턴 (src/lib/db/)

- `client.ts` 싱글톤(globalThis 캐싱), WAL + foreign_keys + busy_timeout 5s. init마다 schema.sql 재실행(IF NOT EXISTS) → 멱등 마이그레이션 유지.
- repo 모듈은 테이블별 CRUD. id는 nanoid, timestamp는 epoch ms.
- 스키마 변경 시: schema.sql의 IF NOT EXISTS 멱등성을 깨지 않기. 컬럼 추가는 ALTER를 init 경로에 안전하게.

## React 패턴 (src/components/)

- chat-state.ts의 단일 `items` 배열이 상태 모델의 중심. ChatLayout이 useReducer + 오버레이/핫키 관리.
- editor(CanvasEditor/SpriteCanvas)는 클라이언트 캔버스 작업 — gif.js·JSZip은 브라우저 전용(`/gif.worker.js` postinstall 복사). 서버 후처리와 혼동 금지.

## 변경 후 필수 절차

1. MCP 도구 입력/출력 계약 변경 시 → `_workspace/` 요약에 변경된 shape을 명시한다. 오케스트레이터가 pipeline-engineer와 조율한다.
2. 경계면 shape을 바꿨다면 변경 요약에 "어느 shape이 바뀌어 어느 반대편을 같이 고쳤는지" 명시 → 오케스트레이터가 visual-qa를 스폰해 교차 검증한다.
3. 풀스택 변경은 `_workspace/` 요약에 `pnpm build`·`pnpm lint` 게이트 검증 항목을 명시한다.
