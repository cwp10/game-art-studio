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

## 깨지기 쉬운 계약 (한쪽 바꾸면 반대쪽도)

1. **MCP `structuredContent` ↔ ImageResultCard**
   `{generationId, imagePath:"/api/images/{id}", width, height, elapsedMs}`. 필드명/타입을 바꾸면 ImageResultCard와 chat-state 양쪽을 함께 수정.
2. **generations.kind CHECK enum ↔ upload/layers의 kindHint 우회**
   schema의 kind는 `text2img/img2img/upscale/remove_bg/inpaint/spritesheet`로 제한. upload(외부 이미지/마스크)·layers(색별 레이어)는 enum에 없는 종류라 `inpaint`/`text2img` + `params.kindHint`로 우회한다. 새 종류 추가 시 enum을 늘릴지 kindHint를 쓸지 일관되게 결정.
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
- editor(SpriteCanvas/LayerCanvas/MaskCanvas)는 클라이언트 캔버스 작업 — gif.js·JSZip은 브라우저 전용(`/gif.worker.js` postinstall 복사). 서버 후처리와 혼동 금지.

## 변경 후 필수 절차

1. MCP 도구 입력/출력 계약을 바꾸려면 → **pipeline-engineer와 먼저 합의**(후처리 소유자).
2. 경계면 shape을 바꿨다면 변경 요약에 "어느 shape이 바뀌어 어느 반대편을 같이 고쳤는지" 명시 → **visual-qa에 교차 검증 요청**.
3. 풀스택 변경은 visual-qa에 `pnpm build`·`pnpm lint` 게이트 요청.
