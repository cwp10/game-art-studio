마지막 업데이트: 2026-06-20 (통합 캔버스 에디터 1단계)

## 프로젝트 개요
game-art-studio — Codex CLI imagegen 백엔드 + Claude CLI 오케스트레이션의 로컬 게임 에셋 이미지 생성기 (Next.js + Electron).

## 완료된 작업

### 통합 캔버스 에디터 1단계 — 2026-06-20
편집·이미지 도구·씬에 추가·레이어 분리를 하나의 "포토샵식 전체전환 레이어 캔버스"로 통합하는 작업의 1단계(결정적/비-AI 부분만).
**동기:** 사용자가 합성·오려내기·크롭·색보정을 이 도구로 끝까지 못 해서 매번 포토샵으로 라운드트립 → 그 이탈을 없애는 게 목표. (DB 근거: composite/resize/filter 실사용, normal_map 0건 등)

**설계 결정(돌아온 사용자가 대안 검토 예정):**
- D1 진입=추가형(결과카드 ⋯ "🎨 캔버스 편집" 신규, 기존 패널 보존, 회귀0). 검증 후 진입점 교체는 차후.
- D2 1단계=결정적만(합성/자유변형/크롭/필터/배경제거1회/드래그정렬/undo). 정밀분리·브러시 영역편집(생성형)은 **2단계 보류**.
- D3 크롭=캔버스 프레이밍(출력 W×H + 레이어 배치, 정밀 마퀴크롭 없음). D4 편집상태=휘발(합친 결과만 카드 저장).

**신규 파일:** `src/components/editor/CanvasEditor.tsx` (950줄 — 전체전환 셸, 자유변형(모서리=크기/노브=회전/변=늘이기), 레이어 레일+드래그정렬, 선택레이어 필터, undo/redo, 에셋피커, 합치기)
**백엔드 확장:** `/api/composite`·`composite-runner.ts`·`composite-layers.ts` — 레이어별 `rotation`(route에서 silently drop되던 버그 수정)·`flipH`·`stretchW/H`·`filters{brightness,saturation,hue,contrast,blur}` 추가. sharp 순서 scale→rotate→flip, contrast는 채널배열 linear로 알파 보존, 신규필드 전부 옵셔널(byte-identical 회귀0).
**배선:** `ChatLayout.tsx`(canvasOpen 상태+canvas_edit 핸들러+inset-0 전체전환 렌더+onRemoveBg), `ImageResultCard.tsx`(canvas_edit 액션), `client.ts`(compositeScene 래퍼), `MessageList.tsx`.
**참고 산출물:** `_workspace/wireframe-canvas-editor.html`(인터랙티브 와이어프레임), `_workspace/contract_canvas-editor.md`(계약), `_workspace/qa_canvas_summary.md`(검증).

**검증:** tsc 0 / build exit0 / 변경파일 lint클린 / 합성스모크(alpha보존+byte-identical) / 실제PNG 육안(회전·flip·stretch·filters+투명보존) / 경계면 일치 / 기존 8패널 변경0.
**주의(차후):** flip↔rotate 순서 정합 위해 CanvasEditor 미리보기는 flip을 rotate 뒤 적용(scaleX(-1) 분리)하도록 수정함. baked blur는 sigma=px/2라 CSS 미리보기보다 옅게 보이는 건 정상.
**1차 피드백 반영(2026-06-20, CanvasEditor만 수정 954→1112줄):**
1. 레이어 드래그 정렬 견고화 — `onRailGripDown`에 setPointerCapture + 드래그 행 opacity 피드백.
2. 면(변) 핸들 = 포토샵식 반대편 앵커 — 핸들을 t/b/l/r로 구분, 그랩 변만 이동하고 반대 변 고정(stretchW/H + 레이어 중심 x/y 보정, 회전 로컬축 투영). 모서리는 균일 scale 유지.
3. (#2가 포토샵 기준)
4. 레이어 추가 3경로 — 피커 탭 "이 세션"/"갤러리(전체 listGenerations)" + "⬆ 업로드"(uploadImage) 버튼 + 캔버스 이미지 드롭(dropOver 오버레이). 백엔드 변경 0.
검증: tsc 0 / build exit0 / CanvasEditor lint 클린 / 기존 패널 회귀 0.

**2차 피드백 반영(2026-06-20, CanvasEditor만):**
1. 출력 캔버스에 `overflow-hidden` → 체커보드 아트보드로 클립(합성 출력 outputW/H 크롭과 WYSIWYG). 핸들이 잘리지 않게 선택 레이어 핸들을 클립 밖 오버레이로 분리(숨김 이미지로 박스 크기 맞춤).
2. 커서 기준 휠/트랙패드 줌 추가(`zoomAtPoint`, 네이티브 wheel + passive:false). 기존 우하단 줌 버튼·팬 모드 유지.
검증: tsc 0 / build exit0 / CanvasEditor lint 클린 / 기존 패널 회귀 0.

**3차(추가 반영):** 이동/편집 모드 토글 제거(편집 상시, 줌만 유지) · 선택 레이어 업스케일(AI)·여백제거(trim) 추가로 이미지 도구 슈퍼셋화.

**Step 1 완료(진입점 통합, 2026-06-20):** 결과카드 "이미지"→"캔버스"(canvas_edit), ⋯의 "씬에 추가"·"캔버스 편집" 제거. ImageToolsPanel/SceneComposer는 UI 도달 불가(코드 잔존, 추후 정리). 회귀 0(캔버스가 슈퍼셋이라 기능 손실 없음).

**다음 단계:**
- **Step 2(미진행, 큰 작업):** 편집(인페인트)·레이어 분리를 캔버스 에디터에 생성형 브러시 도구로 흡수(영역 채우기/분리). 브러시 UI + 마스크 업로드 + 비동기 채팅 연동 — 가장 크고 위험.
- **Step 3:** 편집 상태 영속화(DB) → 프로젝트처럼 재오픈.
- **정리:** 도달 불가가 된 ImageToolsPanel/SceneComposer 데드코드 제거(ChatLayout 배선 포함).

### 씬 프리뷰어 Phase 1 — 2026-06-20
여러 생성 이미지를 레이어로 쌓아 게임 화면처럼 미리보고 PNG로 병합하는 기능.

**신규 파일:**
- `src/lib/image-backend/composite-layers.ts` — mergeImages() sharp 합성 (contain-fit + alpha opacity)
- `src/app/api/composite/route.ts` — POST /api/composite
- `src/components/editor/SceneComposer.tsx` — 씬 합성 UI (레이어 스택 + opacity + 해상도 프리셋)

**수정 파일:**
- `src/lib/db/migrate.ts` — migrateV7: 'composite' kind 추가
- `src/lib/db/schema.sql` — kind CHECK 확장
- `src/types/db.ts` — GenerationKind에 'composite' 추가
- `src/components/chat/ChatLayout.tsx` — sceneOpen 상태 + SceneComposer 렌더 + add_to_scene 핸들러
- `src/components/chat/ImageResultCard.tsx` — "씬에 추가" 버튼

### 씬 프리뷰어 Phase 2 — 2026-06-20
SceneComposer 드래그 배치 + SpriteCanvas 알파 이펙트 탭 추가.

**A. SceneComposer 드래그 배치:**
- `SceneLayer` 타입에 `x, y, scale` 추가 (기본: 0, 0, 1.0)
- 레이어 선택 후 프리뷰 캔버스 드래그로 위치 이동
- scale 슬라이더 + 위치·배율 리셋 버튼
- POST /api/composite 요청에 x,y,scale 포함

**B. SpriteCanvas 알파 이펙트 탭:**
- 헤더에 "이펙트" 탭 버튼 추가
- 효과 유형: drop_shadow / outline / glow (알파 마스크 기반, 셀별 처리)
- POST /api/sprite-effect → onSaved로 결과 chat 카드 삽입

**신규 파일:**
- `src/lib/image-backend/sprite-effect.ts` — applySpritesheetEffect() 셀별 이펙트 처리
- `src/app/api/sprite-effect/route.ts` — POST /api/sprite-effect

**수정 파일:**
- `src/lib/image-backend/composite-layers.ts` — x,y,scale + placeWithTransform()
- `src/app/api/composite/route.ts` — CompositeLayerInput에 x?,y?,scale? 추가
- `src/lib/db/migrate.ts` — migrateV8: 'sprite_effect' kind 추가
- `src/lib/db/schema.sql` — kind CHECK 17개
- `src/types/db.ts` — GenerationKind에 'sprite_effect' 추가
- `src/components/editor/SceneComposer.tsx` — 드래그 배치 + scale 슬라이더

### SceneComposer 드래그 버그 수정 — 2026-06-20
- img에 `pointerEvents: "none"` 추가 → 브라우저 네이티브 이미지 드래그가 window.mousemove를 가로채는 문제 차단
- `onPreviewMouseDown`에서 레이어 미선택 시 최상단 레이어 자동 선택 후 드래그 시작 (UX 개선)

### MCP 자연어 연동 — 2026-06-20
Claude CLI에서 자연어로 씬 합성·이펙트 적용 명령 가능.

**신규 파일:**
- `src/lib/image-backend/composite-runner.ts` — runComposite() 공통 오케스트레이터 (라우트·MCP 공유)
- `src/lib/image-backend/sprite-effect-runner.ts` — runSpriteEffect() 공통 오케스트레이터

**수정 파일:**
- `src/lib/mcp/server.ts` — composite_scene / apply_sprite_effect 도구 추가 (SCHEMAS + TOOLS + dispatch)
- `src/app/api/composite/route.ts` — runComposite() 위임으로 리팩터
- `src/app/api/sprite-effect/route.ts` — runSpriteEffect() 위임으로 리팩터

### 9-slice 패널 생성기 — 2026-06-20
UI 패널 이미지를 9조각으로 슬라이싱하거나 타겟 크기로 리사이즈.

**A. 슬라이서 (그리드 미리보기):** 원본 이미지에 슬라이스 경계선 오버레이한 PNG 출력
**B. 리사이저:** 코너 고정 + 엣지/중앙 스트레치로 임의 크기 패널 생성

**신규 파일:**
- `src/lib/image-backend/nine-slice.ts` — makeNineSliceGrid() + scaleWithNineSlice()
- `src/app/api/nine-slice/route.ts` — POST /api/nine-slice (kind='nine_slice')
- `src/app/api/nine-slice-scale/route.ts` — POST /api/nine-slice-scale (kind='nine_slice_scaled')
- `src/components/editor/NineSliceEditor.tsx` — 슬라이스 라인 오버레이 UI + 실시간 미리보기

**수정 파일:**
- `src/lib/db/migrate.ts` — migrateV9: nine_slice / nine_slice_scaled kind 추가
- `src/lib/db/schema.sql` — kind CHECK 19개
- `src/types/db.ts` — GenerationKind 확장
- `src/components/chat/ChatLayout.tsx` — nineSliceOpen 상태 + NineSliceEditor 패널
- `src/components/chat/ImageResultCard.tsx` — "9-slice" 버튼
- `src/components/chat/MessageList.tsx` — open_nine_slice 액션 타입
- `tsconfig.json` — _workspace / _workspace_prev exclude 추가

## 기술 스택
- Next.js (App Router), TypeScript, React
- sharp 0.33 (이미지 합성), better-sqlite3 (WAL), MCP stdio
- DB: generations 테이블 (kind enum v9: 19종 — text2img/img2img/.../composite/sprite_effect/nine_slice/nine_slice_scaled)

## 주요 설계 포인트
- **sharp out-of-bounds**: overlay > base 크기면 throw. scale>1 시 crop-to-visible-window 방식.
- **이펙트 셀 처리**: 각 셀 독립 투명 캔버스에서 effect(아래)+sprite(위) 합성 → 셀 경계 블리딩 방지.
- **MCP 공통 오케스트레이터**: composite-runner / sprite-effect-runner가 라우트·MCP 양쪽에서 동일 계약 공유. HTTP 우회 없이 in-process 호출.
- **Next.js import 패턴**: .js 확장자 금지 (MCP 서버는 ESM node 패턴 유지, Next.js 소스는 확장자 없음).
- **9-slice 리사이즈**: 코너 크기 고정, 엣지 단축 방향 고정, 중앙 양방향 stretch (fit:'fill'). 유효성: left+right < W, top+bottom < H.
- **SceneComposer 드래그**: img에 pointer-events:none → 브라우저 네이티브 이미지 드래그 간섭 차단. 레이어 미선택 시 최상단 자동 선택.

### 버튼 상태 스프라이트 — 2026-06-20
normal/hover/pressed 3종을 각각 별도 generation으로 생성.

**신규 파일:**
- `src/lib/image-backend/button-states.ts` — generateButtonState() (sharp 변환)
- `src/app/api/button-states/route.ts` — POST /api/button-states → { normal, hover, pressed }
- `src/components/editor/ButtonStateEditor.tsx` — 3슬롯 미리보기 + 파라미터 슬라이더 UI

**수정 파일:**
- `src/lib/db/migrate.ts` — migrateV10: 'button_state' kind 추가
- `src/lib/db/schema.sql` — kind CHECK 20종
- `src/types/db.ts` — GenerationKind에 'button_state' 추가
- `src/components/chat/ChatLayout.tsx` — buttonStateOpen 상태 + ButtonStateEditor 패널
- `src/components/chat/ImageResultCard.tsx` — "버튼 상태" 버튼
- `src/components/chat/MessageList.tsx` — open_button_states 액션 타입

**sharp 변환:**
- normal: 원본 그대로
- hover: modulate(brightness: 1.25, saturation: 1.15)
- pressed: modulate(brightness: 0.75, saturation: 0.85) + 95% 축소 중앙 composite

### SceneComposer 회전 기능 — 2026-06-20
SceneLayer에 `rotation: number` (도°, 기본 0) 추가.

**수정 파일:**
- `src/components/editor/SceneComposer.tsx` — SceneLayer 타입에 rotation 추가, setRotation 콜백, resetTransform에 rotation:0 포함, CSS transform에 rotate(), 회전 슬라이더(-180~180°) UI
- `src/lib/image-backend/composite-runner.ts` — CompositeLayerSpec에 rotation? 추가, resolved 배열 전파
- `src/lib/image-backend/composite-layers.ts` — placeWithTransform에 rotation 파라미터, sharp `.rotate(rotation, {background: transparent})` 적용 (resize 전), hasTransform 조건에 rotation !== 0 포함

**구현 방식:**
- CSS 프리뷰: `rotate(${rotation}deg)` — scale 뒤에 적용
- sharp 백엔드: `.rotate()` → `.resize()` 순서. sharp rotate는 바운딩 박스 확장 + 투명 배경 처리 자동.

## 다음 단계
- 향후 옵션: 9-slice 게임엔진 메타데이터 JSON export, 이펙트 탭 확장, 애니메이션 미리보기
