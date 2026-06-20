마지막 업데이트: 2026-06-21 (편집(MaskCanvas)→캔버스 영역편집 통합 완료 + MaskCanvas 은퇴 / ▶다음: Step 3 영속화)

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

**Step 2 완료(생성형 흡수, 2026-06-21):** 편집·이미지·씬·레이어분리 4기능이 한 캔버스로 통합.
- **2a 분리(오려내기):** 선택 레이어에서 부위명(쉼표) 입력 → AI 추출(extractObject, 마스크 없음) → 각각 새 레이어로 추가. onExtract prop.
- **2b 영역 편집(generative fill):** "영역 편집" → 평면 오버레이에서 브러시로 마스크 칠 + 프롬프트 → 그 영역만 재생성, 레이어 교체. 소스해상도 캔버스 #ff0000 → export 검정+빨강(MaskCanvas 포맷), rectRatioPoint 소스픽셀 매핑. onInpaint prop(uploadMask+handleSend).
- ⚠️ 브러시 정밀도/느낌은 헤드리스 검증 불가 — 사용자 인터랙션 테스트 필요(변형 핸들처럼 반복 가능).

**UI 다듬기(2026-06-21, 사용자 피드백 반영, CanvasEditor만):**
- 열 때 첫 레이어 자동 선택(도구 바로 노출). 이동/편집 모드 토글 제거(편집 상시, 줌만).
- 영역 편집을 평면 오버레이 → **메인 캔버스 인라인 브러시**(점-좌표 역변환, 비트맵 회전 없이 정밀). 마스크 캔버스를 레이어 div 안에 두고 CSS가 표시, 포인터만 bbox중심 기준 un-flip→un-rotate→un-scale. 비균일 늘이기 보정으로 **브러시는 화면상 정원**(원본엔 타원 스탬프). 마스크 캔버스 크기는 `inpaintNat`로 선언적 지정(HTML 기본 300 버그 회피).
- 상단 툴바 한 줄: 출력규격 + 변형(반전/리셋) + 생성형 메뉴(배경제거/업스케일/여백제거/영역편집/레이어분리). **메뉴 클릭=즉시 실행 X → 하단 바에서 결정/실행**(단일 `tool` 상태, openTool/closeTool). 우측 레일=레이어+필터.
- 푸터 제거(취소=상단 "대화로 돌아가기"와 중복). **합치기 버튼을 우측 레일 필터 아래 상시 노출**.

**변형 다듬기(2026-06-21):** 핸들 고정크기(selBox 측정→scale 밖 렌더) · 센터 스냅+Shift 직선 · 불투명 슬라이더 레이어행→필터로 · 드래그 정렬 FLIP 애니메이션 · 면 늘리기 반대편 고정 버그 수정(원점=프레임중심→레이어중심) · 면 늘릴 때 캔버스 가장자리 스냅 · 박스 반치수를 그랩위치 근사→selBox 정확값(스냅 오차 제거).

**정리 완료(2026-06-21):** 도달 불가 ImageToolsPanel·SceneComposer 제거(컴포넌트 파일 + ChatLayout image_tools/sceneOpen/add_to_scene/handleImageCrop 배선, MessageList/ImageResultCard Action union). 1102줄 삭제. 편집(MaskCanvas)·레이어분리(LayerCanvas) 결과카드 진입점은 빠른 단일이미지 경로로 유지.

### 편집→캔버스 영역편집 통합 + MaskCanvas 은퇴 완료 — 2026-06-21
편집(MaskCanvas 인페인트)을 캔버스 에디터 "영역편집"으로 합치고 참조 이미지를 이식한 뒤 MaskCanvas를 완전 은퇴. 이미지/씬 통합과 동일 패턴. **사용자 결정: 지우개 + 스트로크 undo 둘 다 포함.** 백엔드 변경 0(참조 인페인트는 백엔드 기존 지원).
- **CanvasEditor.tsx**: `onInpaint` 4-arg화(+`referenceGenerationId?`) · `initialTool?: "inpaint"` prop(마운트 1회 init effect로 `openTool("inpaint", layers[0])` 자동, set-state-in-effect 의도적 disable) · 지우개(brushTool, onBrush*에서 `destination-out`/`source-over` 토글) · 스트로크 undo(onBrushDown 첫 stamp 전 `getImageData` 스냅샷 push 상한30, pop→putImageData, clearBrush/closeTool 리셋) · 참조 picker(하단 바 팝오버, 세션/갤러리 탭, `listGenerations` 재사용, kind!=="mask"+자기 제외) · 하단 바 UI(브러시/지우개 토글·되돌리기·전체지우기·참조). import +Brush/Eraser/Image as ImageIcon.
- **ChatLayout.tsx**: `canvasOpen`에 `initialTool?` 추가 · `handleAction`에 `openCanvas(genId, initialTool?)` 헬퍼 추출(canvas_edit/edit 공유) · `edit: openCanvas(genId,"inpaint")`(기존 openEditPanel("inpaint") 대체) · CanvasEditor 렌더에 `initialTool` + onInpaint 참조 배선(`ref?[genId,ref]:[genId]`) · **MaskCanvas 은퇴**(import·Editing 타입 inpaint 멤버·handleInpaint·renderEditPanel case "inpaint" 제거).
- **ImageResultCard.tsx**: "편집" 버튼 title만 갱신(action "edit" 유지 — 이제 canvas로 라우팅).
- **삭제**: `src/components/editor/MaskCanvas.tsx`.
- **검증(visual-qa PASS)**: tsc 0 / build 성공 / 변경파일 lint 클린(ChatLayout 2 error는 pre-existing — 145 activeSessionIdRef refs, 1299 EmptyState set-state, git stash 베이스라인 HEAD 146/1374에서 확인). 경계면(onInpaint 4-arg·initialTool·참조 순서) 일치 · 진입 사슬(편집→openCanvas→initialTool→init effect→openTool→영역편집 바) 무결 · 나머지 13개 액션 회귀 0 · MaskCanvas 실코드 참조 0(남은 문자열은 포맷/훅 계보 주석뿐).
- ⚠️ **헤드리스 한계**: 브러시/지우개 정밀도·스트로크 undo 체감·참조 첨부 실제 생성은 사용자 인터랙션 테스트 필요(변형 핸들과 동일).
- 산출물: `_workspace/contract_inpaint-merge.md`, `_workspace/fullstack_inpaint-merge_summary.md`, `_workspace/qa_inpaint-merge_summary.md`.

**보완(2026-06-21, CanvasEditor만)**: 통합 시 누락됐던 MaskCanvas의 원클릭 "오브젝트 지우기"를 영역편집 하단 바에 복원. `handleInpaintSubmit`을 `runInpaint(prompt, reference)`로 추출 → 채우기(사용자 프롬프트+참조)와 오브젝트 지우기(고정 `OBJECT_REMOVE_PROMPT`=MaskCanvas와 동일 seamless-background 문구, 참조 없음)가 공유. `brushPainted` 상태로 칠한 마스크 있을 때만 버튼 활성(onBrushDown set, clearBrush/closeTool 리셋). danger 스타일 Trash2 버튼. 검증: tsc 0 / build 성공 / lint 클린.

## ▶ 다음 작업

- **Step 3:** 편집 상태 영속화(DB) → 닫아도 레이어 배치 복원. 현재 휘발.
- **(선택)** 나머지 패널(리스킨·노멀맵·9-slice·버튼상태·스프라이트) UX 일관성(원래 과제).
- **(선택)** 결과카드 "레이어" 버튼도 캔버스 분리와 중복 — 은퇴 검토.

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
