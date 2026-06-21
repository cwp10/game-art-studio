마지막 업데이트: 2026-06-21 (Opus 전체 분석 기반 코드 품질 수정 8건 완료 / ▶다음: 없음 — 필요 시 SKILL.md 30행 수동 삭제)

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

**진입점 단일화 + 원본크기 기본(2026-06-21, 사용자 요청)**: 결과카드 "편집"(edit/initialTool 직진입) 버튼 제거, "캔버스"(canvas_edit) 버튼을 "편집"으로 리네임(Edit3 아이콘) → 진입은 일반 캔버스 1개로 통일. 직진입용 `initialTool` 기계(prop·init effect·openCanvas 인자·canvasOpen 필드·Action union "edit"·ImageResultCard Wand2 import) 전부 죽은 코드라 정리. **캔버스 진입 시 출력 규격 기본값=시드 원본 이미지 크기**(마운트 effect로 `setCustomSize(naturalW/H)`, 프리셋 0 "자유"가 customSize 따름). 하단 도구 바 살짝 띄움(bottom-4→bottom-6). 검증: tsc 0 / build 성공 / 변경파일 lint 클린(ChatLayout 2 error는 기존). 4파일(CanvasEditor·ChatLayout·ImageResultCard·MessageList).

### 레이어 분리(LayerCanvas)→캔버스 통합 + 은퇴 완료 — 2026-06-21
MaskCanvas 통합과 동일 패턴. 캔버스 "레이어 분리"가 텍스트 추출만 있었는데 **풀 패리티**로 확장(사용자 결정). 백엔드 변경 0.
- **CanvasEditor**: extract 도구에 `extractMode: "text"|"brush"` 서브모드. **브러시 기반 추출**(인페인트 브러시 인프라 brushCanvasRef·onBrush*·screenToSource·inpaintNat·undo·eraser·brushPainted 그대로 재사용 — 브러시 캔버스 렌더 조건 `inpaint || (extract && brush)`, openTool이 extract에도 inpaintNat 로드). autoRestore 토글(가려진 부위 복원 on/off), AI 부위 제안(/api/layer-suggest, AiSuggestDropdown placement="bottom"). 브러시 컨트롤을 `brushControls` JSX 변수로 추출해 영역편집·extract-brush 공유. `onExtract` 3-arg(+autoRestore), 신규 `onExtractBrush` prop. handleExtractBrush는 closeTool **뒤** 선언(TDZ 회피). import +Tags, +AiSuggest*.
- **AiSuggestControls**: `AiSuggestDropdown`에 backward-compatible `placement?:"top"|"bottom"`(기본 top, 하단 바용 위로 열기). 기존 Reskin/SpriteGen 영향 0.
- **ChatLayout**: onExtract autoRestore 배선 + onExtractBrush(uploadMask+maskGenerationId+extractObject). **LayerCanvas 은퇴**(import·Editing "layer"모드·handleLayerSplit·handleLayerBrush·layerResults·render case·layer_split 핸들러/union 제거).
- **ImageResultCard/MessageList**: "레이어" 버튼+layer_split union 제거(Layers import 정리). **삭제**: LayerCanvas.tsx.
- 검증(visual-qa PASS): tsc 0 / build 성공 / 변경파일 lint 클린(ChatLayout 2 error는 기존 140/1215). 경계면 3종 prop 일치, layer 실코드 잔존 0(남은 "LayerCanvas"는 route/useZoomPan/client.ts 주석). 헤드리스 한계: 브러시 추출 정밀도·AI 제안·autoRestore 결과는 사용자 테스트 필요.
- 산출물: `_workspace/contract_layer-merge.md`, `_workspace/qa_layer-merge_summary.md`.

### Step 3 — 캔버스 편집 상태 영속화 완료 (자동저장 + 수동복원, Option B) — 2026-06-21
사용자 결정 ②번: 자동 저장은 하되 열 때는 깨끗하게 시작 + "이전 편집 이어서" 칩으로 수동 복원(놀람 방지).
- 키 `seedGenerationId`(카드 1장당 캔버스 1개). 저장=Snapshot(layers/canvasSize/selectedLayerId) 디바운스 800ms + 언마운트 flush. **건드리지 않은 시드 단일 레이어 기본 상태는 저장 안 함**(`isPristineSeedLayer` 게이트, canvasSize는 size-init 자동변경 때문에 판단 제외) → 편집 안 한 이미지엔 저장본/칩 안 생김.
- 복원: 진입 시 저장본 불러와 **자동 적용 X**, 캔버스 상단 칩. [이어서]=applySnap+프리셋자유, [처음부터]=폐기(clearCanvasEdit), [✕]=이번만 숨김. stale 레이어(삭제된 generation)는 GET에서 서버 필터, 전부 stale면 칩 미표시. 시드 삭제 시 FK CASCADE.
- 신규: `schema.sql` canvas_edits 테이블(마이그레이션 불필요 — IF NOT EXISTS) · `repo/canvas-edits.ts` · `api/canvas-edit/[seedId]/route.ts`(GET/POST/DELETE) · client 래퍼 3종. CanvasEditor: isPristineSeedLayer 헬퍼 + restorable/restoreDismissed 상태 + 로드/자동저장/flush effect + 복원 칩.
- 검증(visual-qa PASS): tsc 0 / 신규·변경 lint 클린 / build 성공(+라우트 등록) / DB 스모크 6/6(upsert 교체·FK CASCADE·stale 필터). 헤드리스 한계: 실제 저장→재오픈→복원 라운드트립은 브라우저 인터랙션 필요.
- 산출물: `_workspace/contract_canvas-persist.md`, `_workspace/qa_canvas-persist_summary.md`.

### 패널 UX 일관성 감사 + 저위험 수정 — 2026-06-21
감사 결과 패널들은 이미 구조적으로 일관(동일 래퍼 `fixed inset-y-0 right-0 w-2/3`·헤더 `h-12 max-w-[880px]`·헤더 X 닫기·색 토큰). 남은 저위험 cosmetic 8건 수정:
1. **체커보드 수렴** — 인라인 `repeating-conic-gradient`(#222/#333·#1a1a1a/#3a3a3a, 10~16px 파편) 11곳 → 기존 `.checkerboard` 클래스(globals.css:70, #1a1a1a/#2a2a2a 16px)로 통일. ReskinPanel(4)·NormalMap(2)·NineSlice·ButtonState·SpriteGen·SpriteCanvas(2).
2. 결과카드 노멀맵 아이콘 Map→Layers(패널과 정합, Map import 제거).
3. NormalMapPanel 헤더 닫기 버튼 `title="닫기"` 추가(6패널 정합).
4. ✕ prefix 통일 — NineSlice "취소"→"✕ 취소", ButtonState "{닫기/취소}"→"✕ {닫기/취소}"(조건부 의미는 보존).
5. SpriteCanvas 스피너 RefreshCw→Loader2 2곳(다수파 수렴, +Loader2 import, RefreshCw는 "자동 정렬"에서 유지).
6. SpriteCanvas 이펙트 버튼 h-8→h-9(primary 높이 통일).
7. ReskinPanel PanelFooter `busyLabel="생성 중…"`(generic "실행 중…"→생성 작업 문구, SpriteGen과 정합).
8. 결과카드 sprite_split 라벨 "스프라이트"→"시트 분할"(make_sheet "시트 만들기"와 페어).
- 보존(의도된 차이): ButtonState 조건부 닫기/취소, PanelFooter "■ 생성 취소", 작업별 busy 문구, CanvasEditor full-takeover.
- 검증: tsc 0 / build 성공 / 변경파일 새 lint 에러 0(SpriteGenPanel 225/237/275 set-state는 기존, git stash로 확인). 감사 보고서는 general-purpose 에이전트.
- ⚠️ 헤드리스 한계: 체커보드/스피너 등 시각 변화는 육안 확인 필요(특히 SpriteCanvas 셀그리드/프리뷰 배경).

**전체화면 통일(2026-06-21, 사용자 요청)**: 우측 2/3 패널들을 캔버스 에디터처럼 전체화면으로 — "편집 중엔 대화창 불필요". ChatLayout 래퍼 4곳 `fixed inset-y-0 right-0 w-2/3`→`fixed inset-0 z-40`(renderEditPanel/spriteGen/nineSlice/buttonState). 패널 루트는 모두 `aside h-full flex-1 bg-bg-panel`(불투명)라 전체 덮음. 이제 무의미해진 대화 column 1/3 narrowing 제거(`editorPanelOpen?"w-1/3":"flex-1"`→상시 `flex-1`, editorPanelOpen은 SessionList 숨김에 계속 사용). editorPanelOpen에 canvasOpen 이미 포함돼 캔버스도 동일하게 동작했음. 검증: tsc 0 / build 성공 / lint 기존 2건만.
- ⚠️ 패널 내부 콘텐츠는 `mx-auto max-w-[880px]` 중앙정렬 유지 → 와이드 화면에서 좌우 여백 넓음(sparse). 콘텐츠 폭 확장은 패널별 레이아웃 손봐야 해 별도 과제(육안 확인 후 결정).

**전체화면 후속 — 콘텐츠 폭 확장 + 푸터 통일(2026-06-21, 사용자 "둘 다")**:
- **A 폭 확장**: 전 편집 패널 + PanelFooter의 `max-w-[880px]`→`max-w-[1200px]`(헤더·본문·푸터·에러 함께 넓어져 정렬 유지). 전체화면 좌우 여백 축소. Composer(채팅 입력)·CompareSheet(비교 모달)는 편집 패널 아니라 880 유지.
- **B 푸터 통일**: 감사 재평가 결과 수제 푸터 4개 중 **ButtonStateEditor만** PanelFooter(2버튼)에 맞음 → 전환(PanelFooter에 `closeLabel?` prop 추가, 기본 "취소", 하위호환 → ButtonState의 닫기/취소 조건부 보존). **NormalMap(닫기·저장·채팅추가·생성 4버튼)·NineSlice(취소·그리드미리보기·리사이즈 2-submit)·SpriteCanvas(다중 액션)는 다중 액션 푸터라 커스텀 유지가 정당**(통일 불가가 결론).
- 검증: tsc 0 / build 성공 / 변경파일 lint 클린.
- ⚠️ 1200px 폭·ButtonState 푸터는 육안 확인 필요. 폼 패널(Reskin/SpriteGen)이 1200에서 너무 넓으면 값 조정 가능.

**패널 chrome 캔버스 일관화(2026-06-21, 사용자 요청)**: 캔버스 에디터를 레퍼런스로 6개 패널 chrome 통일.
- **헤더**: 우상단 X → 좌상단 "← 대화로 돌아가기"(캔버스 스타일 `h-[50px]` 풀폭, ArrowLeft). X import 전부 제거. 6패널(Reskin/NormalMap/NineSlice/ButtonState/SpriteGen/SpriteCanvas). SpriteCanvas는 닫기가 onCancel + 이펙트 토글 유지.
- **푸터**: 닫기/취소 버튼 제거(헤더 백버튼이 담당) → 생성/실행 버튼만. **PanelFooter 재설계**: 상시 닫기 버튼 제거, 생성 버튼 전체폭, `busy && onCancel`일 때만 "■ 생성 취소" abort 노출. onClose/closeLabel prop 제거(Reskin/SpriteGen/ButtonState 호출 정리). 커스텀 푸터(NormalMap·NineSlice·SpriteCanvas)는 닫기 버튼만 제거하고 나머지 액션 유지.
- 결정: "오른쪽 패널처럼"=별도 우측레일 신설이 아니라 생성 버튼을 깔끔한 전체폭 액션으로 정돈(사용자 확정). 단일컬럼 레이아웃 유지.
- 검증: tsc 0 / build 성공 / 변경파일 새 lint 에러 0(SpriteGen 225/237/275는 기존). ⚠️ 헤더 백버튼·푸터 시각은 육안 확인 필요.

**패널 레이아웃 캔버스 3-존 골격화(2026-06-21, 사용자 요청, 진행 중)**: 캔버스 에디터 레이아웃을 레퍼런스로 패널 내부를 재구성 — 상단 툴스트립(주 옵션) + 중앙 스테이지(미리보기, 다크 `bg-[#0c0c0d]` m-4) + 우측 레일 256px(하위 옵션) + 우하단 액션(합치기 자리). 폼형은 입력/프롬프트를 하단으로(사용자 확정).
- **완료(미리보기형 3개)**: NineSlice(레퍼런스 — 툴스트립=리사이즈크기 / 스테이지=이미지+슬라이스오버레이 / 레일=Inset / 우하단=그리드미리보기·리사이즈, SizeInput 헬퍼 제거), NormalMap(스테이지=원본·결과 / 레일=강도+결과액션 / 우하단=생성, 툴스트립 생략), ButtonState(스테이지=3슬롯 / 레일=Hover·Pressed 파라미터 / 우하단=3종생성, PanelFooter→레일버튼 전환, Loader2 복귀). tsc0/build/lint클린.
- **SpriteCanvas(완료, 사용자 지시 반영)**: 전체 3-존 강제 대신 — **저장·내보내기 블록(보정본 저장+Atlas 포맷+.json/zip/GIF)만 우측 레일**로, 나머지 컨트롤(그리드·행열·순서·방향·애니메이션·이펙트)은 **기존대로 중앙 스크롤** 유지. 중앙 콘텐츠+레일을 flex 행으로 감쌈(sizerRef 클래스 불변 → 그리드 측정 동일). 푸터 제거.
- **폼형 ReskinPanel·SpriteGenPanel(현재 유지로 결정)**: stage 없는 다중모드 폼이라 캔버스 3-존 부적합. 이미 헤더 백버튼 + 하단 생성(PanelFooter)으로 충분히 일관 → 재배치 안 함(사용자 결정).
- **결론**: 패널 레이아웃 캔버스 골격화 마무리. 미리보기형 4개(NineSlice·NormalMap·ButtonState·SpriteCanvas) 재구성, 폼형 2개 유지.
- **SpriteCanvas 우측 레일 다듬기(2026-06-21)**: 보정본 저장을 레일 하단 고정(캔버스 합치기 자리), 내보내기 옵션(Atlas·.json·zip·GIF)은 위 스크롤로. 커밋 d7e34df.
- **리스킨↔시트 만들기 통합 검토 → 분리 유지로 결정(2026-06-21)**: 둘 다 폼형이지만 옵션 disjoint + 진입 맥락 다름(시트는 단일 캐릭터 전용, 리스킨은 아무 이미지) + 큰 컴포넌트 2개라, 통합은 co-location에 그쳐 이득<비용. 서로 다른 작업이라 각자 유지.
- **SpriteGenPanel 3-존 재구성(2026-06-21, 사용자 스펙)**: 폼형이지만 참조 이미지가 있어 캔버스 골격 적용 — 상단 툴스트립=캐릭터/오브젝트/이펙트(+이펙트종류), 중앙 스테이지=참조 이미지(크게, 없으면 플레이스홀더), 중앙 하단=동작 텍스트 입력(+예시/AI, 위로 열림), 우측 레일=시점·방향·프레임·루프, 레일 하단=생성하기(생성 중 ■중단). PanelFooter→레일 버튼 전환(Loader2 import). ExamplePopover에 placement prop 추가(하위호환). 옵션 팝오버·핸들러·canSubmit 그대로 이전. 검증: tsc0/build/새 lint 에러0(SpriteGen 224/236/274 set-state는 기존). ⚠️ 팝오버 방향·참조 스테이지 육안 확인 필요. ReskinPanel은 별도(아래).
- **ReskinPanel 2단계→상단 모드 탭 펼침(2026-06-21, 사용자 A안 선택)**: Reskin은 모드(외형/색/화풍)마다 UI가 완전히 달라(텍스트/팔레트 매핑/프리셋 그리드/이미지 picker) 풀 3-존(stage+narrow rail) 부적합 → **안전한 부분만**: 진입 화면(큰 버튼 3개)+뒤로가기 제거하고 **상단 툴스트립에 색/외형/화풍 탭 상시 노출**(SpriteGen 패턴 일관). 원본 이미지+모드 상세는 중앙 그대로, 실행은 하단 PanelFooter. `entered` 상태·UI_MODE_LABELS 제거(미사용). initialMode/initialSkinInput 으로 초기 모드 지정 유지(ChatLayout 단축어 계약 보존). 검증: tsc0/build/lint클린.
- **ReskinPanel 풀 3-존 재구성(2026-06-21, 사용자 재요청)**: A안에 이어 SpriteGen식 풀 3-존 적용. 모드별로 텍스트↔옵션 분리 배치(사용자 확정 분배안): 중앙 스테이지=원본 이미지(kind 배지 오버레이), 중앙 하단 대화창=모드별 텍스트(skin/text 새스킨설명·color/ai 어떤색·style 직접입력·skin/image 추가지시; color/advanced는 "오른쪽 팔레트" 안내), 우측 레일=하위옵션(text/image 토글·고급+팔레트 매핑·프리셋 2열·이미지 picker 3열·시트안내), 레일 하단=리스킨 실행(생성중 ■중단). PanelFooter→레일 버튼(import 제거). AiSuggestDropdown placement="bottom"(대화창 하단이라 위로). 2번 edit(컨테이너 재배치+꼬리 정리). 검증: tsc0/build/lint클린. ⚠️ picker 3열·팔레트 압축·팝오버 방향 육안 확인 필요.

### Opus 분석 기반 코드 품질 수정 8건 — 2026-06-21

Opus가 전체 코드베이스를 분석해 도출한 실제 버그·중복·위생 이슈를 순차 수정. tsc 0 / lint 12→3 달성.

**수정 목록 (완료):**
1. **codex-exec 폴백 버그 (높음)** — `codex-exec.ts` 폴백 PNG 선택 필터에 `/^input\d*\.png$/i` 제외 조건 추가. output.png 없을 때 입력 이미지가 결과로 반환되던 silent wrong-output 차단.
2. **chroma-key 공유 모듈화 (중간)** — `chroma-key.ts` 신규 추출. codex-exec 단순 임계값 방식을 spritesheet-postprocess의 적응형(flood-fill+despill) 알고리즘으로 통일. 단일 이미지 chroma-key 품질 향상(픽셀 수준 변경).
3. **temp 파일 try/finally (중간)** — `spritesheet-postprocess.ts` 원자 쓰기 패턴에 `try/finally` 가드 추가. 크래시 시 `.tmp` 고아 방지.
4. **그리드 비정수 경고 (중간)** — `Math.floor(W/cols)` 나머지 픽셀 손실 시 `console.warn` 추가. 비표준 codex 출력 크기 디버깅 가시성 확보.
5. **suggest 4개 라우트 공유 유틸화 (중간)** — `src/lib/util/claude-suggest.ts` 신규. `/api/suggest·sprite-suggest·reskin-suggest·layer-suggest` 4개의 claude 호출 + JSON 파싱 + 에러 처리 공통화. 입력 검증 통일(500자 캡).
6. **ReskinPanel 레일 폭 통일 (낮음)** — `w-[300px]`→`w-[256px]`. 8개 패널 전체 `w-[256px]` 통일.
7. **lint 10→2 에러 정리 (낮음)** — set-state-in-effect 7건(StatusButton/ToolCallBlock/SpriteGenPanel에 이유 주석 disable), no-explicit-any 2건(GallerySheet `ElectronWindow` 타입 도입), 미사용 disable 1건(sprite-effect.ts 삭제). ChatLayout 2건은 미배선 SSE 흐름이라 의도적 잔존.
8. **spritesheet-reorder.ts 삭제 (낮음)** — 프로덕션 미배선 데드 코드. Claude Vision 재정렬 기능이었으나 MCP/API 미배선. 제거.

**미완료 (사용자 수동):**
- `.claude/skills/image-pipeline-dev/SKILL.md` 30행 — 삭제된 spritesheet-reorder.ts 참조 고아 라인. 스킬 파일은 보호되어 자동 수정 불가.

**검증:** tsc 0 / pnpm lint 12→3 (잔존 2건 ChatLayout 의도적, 1건 경고) / chroma-key 통합은 픽셀 수준 동작 변경 (품질 향상).

## ▶ 다음 작업

- **(사용자 수동)** `.claude/skills/image-pipeline-dev/SKILL.md` 30행 `spritesheet-reorder.ts` 참조 라인 삭제.
- **(선택)** NormalMap 헤더 서브타이틀(`{w}×{h}·parent`) 추가(props 이미 있음). 1200 폭 미세조정(패널별).
- **(선택, v1 한계 보완)** 출력 규격만 바꾼 경우도 저장하려면 isPristineSeedLayer에 size 비교 추가(원본 natural 기준).

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
