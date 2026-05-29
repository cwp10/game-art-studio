# Fix 2 — 방향별 개별 생성 옵션 (gait 품질↑)

## 왜
4방향 한 장 시트는 한 번에 24포즈를 그려 프레임 차별화가 희석돼 측면 걷기 발 교차가 약함.
단일 방향(directions=1) 집중 생성은 발 교차가 확연히 좋음(측면 인접프레임 diff 0.62 vs 0.44).
사용자가 측면 보행 품질을 원하면 방향을 따로 생성하도록 패널에 토글 추가.

## 변경 파일 (경로:라인)

### src/components/editor/SpriteGenPanel.tsx
- `:7` — `directionLabels`, `Directions` import 추가(`@/lib/mcp/spritesheet-classify`).
- `SpriteGenSubmit` 타입에 `perDirection?: boolean` 추가(effectFrames 다음).
- `useState perDirection`(기본 false) + `canPerDirection = isCharacter && directions > 1` 파생값.
- `submit()` payload 에 `perDirection: canPerDirection && perDirection` 포함(게이팅 — 조건 불충족 시 항상 false).
- 캐릭터 옵션 블록 하단(VFX danger 노트 뒤)에 체크박스 토글 추가 — `canPerDirection` 일 때만 렌더.
- `buildSpriteMessagesPerDirection()` 신규 export + `facingPhrase()` 헬퍼 추가.
- `buildSpriteMessage()`(단일 경로)는 무수정 — 기존 회귀 0.

### src/components/chat/ChatLayout.tsx
- `:15-19` import 에 `buildSpriteMessagesPerDirection` 추가.
- `handleSpriteGen`(~579): perDirection 분기 추가(아래 흐름).

### scripts/test-sprite-marker.ts
- import 에 `buildSpriteMessagesPerDirection` 추가.
- Case 6(4방향 perDirection), Case 7(2방향 + referenceId) 추가. Case 1~5 기존 회귀 유지.

## perDirection 토글 노출 조건
- `subjectType === "character" && directions > 1` (= `canPerDirection`).
- directions=1 또는 effect 면 숨김(무의미). UI 체크박스 라벨 "방향별로 따로 생성 (품질↑)",
  힌트 "각 방향을 따로 생성해 발 교차 품질↑ ({directions}장 생성)".
- 토글이 숨겨졌을 때 submit 은 perDirection=false 강제(canPerDirection 게이팅).

## buildSpriteMessagesPerDirection 시그니처
```ts
export function buildSpriteMessagesPerDirection(
  payload: SpriteGenSubmit,
  stylePresetSuffix?: string | null,
): Array<{ message: string; attachmentGenerationIds: string[] }>
```
- `directionLabels(payload.directions)` 로 N개 방향. 각 방향 1개 메시지.
- 마커: `[spritesheet: subjectType=character; anchorStrategy=<a>; directions=1; framesPerDir=<f>; rows=1; cols=<f>; seamlessLoop=<s>]`
  (단일 방향·단일 행 — 백엔드가 cols>4 면 auto-reshape 처리).
- 자연어: `lookupPhrase`(액션) + `facingPhrase(label)` + description + style suffix + 배경.
- attachmentGenerationIds: referenceId 있으면 매 방향에 동일 첨부.
- labels 비면(directions=1) 단일 `buildSpriteMessage` 폴백(방어 — 부모가 진입 게이팅).

### facingPhrase 매핑 (directionLabels 라벨 → 자연어)
- DOWN → "facing DOWN (front view)" / UP → "facing UP (back view)"
- LEFT → "facing LEFT (side view)" / RIGHT → "facing RIGHT (side view)"
- DOWN-* → "facing <라벨> (3/4 front view)" / UP-* → "facing <라벨> (3/4 back view)" (8방향 대응)

### 메시지 예시 (4방향, walk, framesPerDir=6, anchorStrategy=feet, seamlessLoop=true, style="pixel art 16-bit")
4개 메시지, directive 는 모두 동일:
`[spritesheet: subjectType=character; anchorStrategy=feet; directions=1; framesPerDir=6; rows=1; cols=6; seamlessLoop=true]`
자연어만 facing 다름:
1. `캐릭터 walking 모션 스프라이트 시트, facing DOWN (front view), 파란 갑옷 기사, pixel art 16-bit, transparent background`
2. `... facing LEFT (side view) ...`
3. `... facing RIGHT (side view) ...`
4. `... facing UP (back view) ...`

## handleSpriteGen 순차 흐름
```ts
setSpriteGen(null);
const suffix = await resolveStyleSuffix(payload.stylePresetId);
if (payload.perDirection && payload.subjectType === "character" && payload.directions > 1) {
  const msgs = buildSpriteMessagesPerDirection(payload, suffix);
  for (const m of msgs) await handleSend(m.message, { attachmentGenerationIds: m.attachmentGenerationIds });
  return;
}
const { message, attachmentGenerationIds } = buildSpriteMessage(payload, suffix);
handleSend(message, { attachmentGenerationIds });
```
- 순차 await = layer-split(~610) 와 동일한 검증된 패턴. 각 방향 완료 후 다음이라 `state.generating` 충돌 없음.
- 각 방향이 별도 결과 카드로 chat 타임라인에 누적. 한 장 스티칭은 범위 밖(코드 주석 명시).

## 경계면 영향
- shape 변경: `SpriteGenSubmit` 에 optional `perDirection` 추가 — 패널(생산자)·ChatLayout `handleSpriteGen`(소비자) 양쪽만 사용. 기존 호출부 무영향(optional).
- 마커 키 이름(subjectType/anchorStrategy/directions/framesPerDir/rows/cols/seamlessLoop)은
  make_spritesheet 입력명과 정확히 일치 — 백엔드 무변경. 단일 방향 마커는 백엔드의 검증된
  directions=1 + cols>4 auto-reshape 경로 재사용(c01a39e gait 프롬프트 reshape 정합).
- MCP structuredContent / generations.kind enum / chat SSE 이벤트 변경 없음.

## 회귀 체크
- buildSpriteMessage(단일) 무수정 → Case 1~5 PASS(회귀 0).
- perDirection 미사용/effect/directions=1 → 기존 단일 경로(canPerDirection 게이팅으로 false).
- npx tsc --noEmit / pnpm lint / pnpm build / test-sprite-marker(Case 1~7) 전부 통과.

## visual-qa 포인트
- 패널: 캐릭터+다방향(2/4/8)일 때만 토글 노출, directions=1 전환·effect 전환 시 숨김 확인.
- 토글 ON + 생성 → N개 결과 카드가 chat 에 순차 누적되는지(4방향=4장). 각 카드가 단일방향
  시트(auto-reshape 그리드, 예 6프레임→2×3)인지.
- 측면(LEFT/RIGHT) 카드의 발 교차(scissor)가 한 장 시트보다 확연히 나은지 육안 검사.
- 실제 codex 생성은 비용 크니 1회 흐름만(4방향=codex 4회 spawn). 단일 경로(토글 OFF) 회귀 0 확인.
