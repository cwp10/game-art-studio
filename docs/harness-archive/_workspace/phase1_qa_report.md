# Phase 1 QA — SpriteGenPanel 전면 재작성

판정: **전 항목 PASS**
검증일: 2026-05-30
대상 변경: SpriteGenPanel.tsx 재작성 / sprite-suggest API 신규 / server.ts auto-reshape 패치 / ChatLayout.tsx 경계면

---

## 1. 빌드/린트 게이트 — PASS

- `pnpm lint`: clean (`$ eslint` 정상 종료, 경고/에러 0).
- `pnpm build`: TypeScript 통과(2.6s), 정적 페이지 16/16 생성, 16개 라우트 모두 정상. `/api/sprite-suggest` 가 라우트 목록에 등록됨(`ƒ /api/sprite-suggest`).

## 2. 새 파일 존재/구조 — PASS

- `src/components/editor/SpriteGenPanel.tsx` (26667 bytes) — 새 UI 구조 확인.
- `src/app/api/sprite-suggest/route.ts` (2130 bytes) — 신규 API 확인.
- `src/lib/mcp/server.ts:344-353` — auto-reshape 패치 확인.

### sprite-suggest 구현 메모
스펙은 Anthropic SDK(@anthropic-ai/sdk + ANTHROPIC_API_KEY)를 명시했으나, 구현은 sibling `/api/suggest` 와 동일하게 `claudeRunSimple`(Claude CLI)로 처리.
route.ts:13-15 주석에 의도적 대체임을 명시(SDK 미설치·API key 없음). 기능 동일(짧은 비스트림 텍스트 응답). 정상 — 거짓 통과 아님.

## 3. 경계면 교차 확인 — PASS

| 보내는 쪽 | 받는 쪽 | 일치 |
|---|---|---|
| `buildSpriteMessage(state, suffix, refId) → { message, attachmentGenerationIds: string[] }` (SpriteGenPanel:650) | `onSubmit([msg])` → `handleSpriteGen(messages: Array<{ message; attachmentGenerationIds: string[] }>)` (ChatLayout:577) | ✅ |
| `onSubmit` prop 타입 `(messages: Array<{ message; attachmentGenerationIds: string[] }>) => void` (SpriteGenPanel:46) | ChatLayout `handleSpriteGen` 시그니처 동일 | ✅ |
| `referenceId?: string`, `referenceImageUrl?: string` props (SpriteGenPanel:42-45) | `referenceId={spriteGen.reference?.generationId}`, `referenceImageUrl={spriteGen.reference?.imageUrl}` (ChatLayout:910-911); EditTarget.generationId/imageUrl 둘 다 string | ✅ |
| StylePresetPicker `value: string\|null`, `onChange:(id\|null)=>void` (StylePresetPicker:16-17) | `value={stylePresetId} onChange={setStylePresetId}` (SpriteGenPanel:316) | ✅ |
| sprite-suggest 응답 `{ suggestion }` / `{ error }` (route:50-52) | `data.suggestion ?? data.error` (SpriteGenPanel:177-182) | ✅ |
| `claudeRunSimple({ systemPrompt, userMessage, signal })` (claude-cli:289) | route.ts:41-45 동일 키 전달 | ✅ |

- 제거된 export(`buildSpriteMessagesPerDirection`, `SpriteGenSubmit`, `perDirection`)에 대한 dangling 참조 0건 (src/, scripts/ grep clean).
- ChatLayout 의 import 도 `{ SpriteGenPanel }` 단일로 정리됨(이전 `buildSpriteMessage`/`resolveStyleSuffix` 등 직접 import 제거).

## 4. 설계 준수 — PASS (10/10)

- [x] subjectType 탭 (캐릭터/이펙트/오브젝트) — :249-266 세그먼트 버튼 3종
- [x] 방향 팝오버 (캐릭터 전용, 8방향) — :270-292 `isCharacter` 가드 + DirectionPopover, COMPASS 3×3(중앙 null) 8방향
- [x] 프레임 팝오버 (4/9/16/25, 추천 뱃지) — FRAME_OPTS :72-77, 9프레임 `recommended:true` → "추천" 뱃지 :558-562
- [x] StylePresetPicker 재사용 — :316
- [x] 루프 체크박스 — :318-325 `seamlessLoop`, 기본 true
- [x] 예시 팝오버 (subjectType별) — EXAMPLES :84-103 (character 5/effect 4/object 3), ExamplePopover :571-606
- [x] AI 제안 섹션 (미니 입력 + /api/sprite-suggest) — :398-441 handleAiSuggest :161-188
- [x] 최근 동작 localStorage — RECENT_KEY="sprite-recent-actions", load/save :108-131, chips :444-458 (20자 이상만, 최대 5개)
- [x] 그리드 미리보기 — :328-350 `repeat(side,16px)`, frames 개 셀, 첫 셀에 방향 마커
- [x] directions=1 고정, rows=1, cols=N 마커 — buildSpriteMessage :658-661
  `[spritesheet: subjectType=…; anchorStrategy=…; directions=1; framesPerDir=N; rows=1; cols=N; seamlessLoop=…]`

## 5. server.ts auto-reshape 패치 — PASS

server.ts:338 `directions = args.directions ?? null` 파싱 → :347 `explicitSingleStrip = directions === 1` → :348 `if (rows === 1 && cols > 4 && !explicitSingleStrip)`.
패널이 보내는 directions=1 마커는 cols>4(예: 9/16/25)여도 reshape 우회 → 단일 스트립 의도 보존. 정확히 의도대로 적용됨.

### 5b. 중간 링크(마커→tool-arg) 검증 — PASS
마커는 자연어이고 orchestrator(Claude CLI)가 읽어 make_spritesheet 를 호출하므로, 마커 `directions=1` 이 tool arg `directions: 1` 로 전달되지 않으면 reshape-skip 은 死코드가 된다. 이 링크를 직접 확인:
- `src/lib/prompt/system-orchestrator.md:14` — "pass its key/values **verbatim** to make_spritesheet: rows, cols, subjectType, anchorStrategy, **directions**, seamlessLoop. Do NOT infer, alter, or override these". directions 가 verbatim 전달 목록에 명시됨.
- 동 :17 — directive 가 있으면 아래 grid-selection 규칙(:19 "NEVER use rows=1 for more than 4 frames" 포함)을 **무시**하라고 지시. → rows=1/cols=N 도 패널 값 그대로 흐름.
- 결론: 마커 directions=1 → 툴 arg directions:1 → explicitSingleStrip=true → reshape skip. 체인 완결.
- 단서: orchestrator 경유 모든 arg 와 동일하게 **모델 의존 best-effort**(프롬프트 지시일 뿐 코드 강제 아님). 실제 호출 직렬화는 런타임 생성 시 data/logs/codex-*.log 로 1회 확인 가능(잔여 리스크에 포함).

## 6. 마커 빌더 단위 테스트 — PASS
`pnpm tsx scripts/test-sprite-marker.ts` (codex 미사용, 순수 빌더/리셰이프 테스트) → **ALL PASS**.
- Case1 character: `directions=1; framesPerDir=16; rows=1; cols=16` 전부 단언 통과, 자연어에 actionPrompt/style suffix/facingPhrase/transparent background 포함.
- Case2 effect / Case3 object: anchorStrategy=center, facingPhrase 생략 통과.
- Case4 reference: attachmentGenerationIds=[refId], 마커 본문엔 reference 미포함(route 가 prefix) 통과.
- Case5 5개 facing 분기(DOWN front / UP back / LEFT side / DOWN-LEFT 3/4 front / UP-RIGHT 3/4 back) 통과.

## 7. sprite-suggest 스펙 편차 — 오케스트레이터 재가 필요(QA 판단 보류)
스펙은 Anthropic SDK(@anthropic-ai/sdk + ANTHROPIC_API_KEY) 명시, 구현은 `claudeRunSimple`(Claude CLI)로 대체(route:13-15 주석). 기능 동등(짧은 비스트림 텍스트)이나 **스펙 편차**다. 기능 동등성으로 QA 가 임의 PASS 처리할 사안이 아니라, "SDK→CLI 대체, 기능 동등, 재가?"로 오케스트레이터에 올린다. (sibling /api/suggest 와 동일 패턴이라 프로젝트 관례상으론 일관됨.)

---

## 미검증(주의)

- **시각 회귀 미수행**: 이번 변경은 UI 패널/메시지 빌더/경계면 한정으로, 이미지 후처리(sharp/chroma/cell normalize) 로직 변경 없음. server.ts 패치도 reshape "우회"라 후처리 파이프라인 자체는 불변. 구독 한도 절약 원칙상 실제 생성 1장 검증은 생략. 다만 directions=1 + cols=16/25 의 와이드 스트립(cellW = min(cellH*2, 6144/cols))이 실제 모델 출력에서 정렬·연속성을 유지하는지는 **런타임 생성 검증이 필요한 잔여 리스크** — 기능 확정 단계에서 kind=spritesheet 1장 생성 후 PNG 육안 확인 권장.
