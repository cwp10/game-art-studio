마지막 업데이트: 2026-06-20

## 프로젝트 개요
game-art-studio — Codex CLI imagegen 백엔드 + Claude CLI 오케스트레이션의 로컬 게임 에셋 이미지 생성기 (Next.js + Electron).

## 완료된 작업

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
- POST /api/composite request에 x,y,scale 포함

**B. SpriteCanvas 알파 이펙트 탭:**
- 헤더에 "이펙트" 탭 버튼 추가
- 효과 유형: drop_shadow / outline / glow (알파 마스크 기반, 셀별 처리)
- POST /api/sprite-effect → onSaved로 결과 chat 카드 삽입

**신규 파일:**
- `src/lib/image-backend/sprite-effect.ts` — applySpritesheetEffect() 셀별 이펙트 처리
- `src/app/api/sprite-effect/route.ts` — POST /api/sprite-effect

**수정 파일:**
- `src/lib/image-backend/composite-layers.ts` — x,y,scale + placeWithTransform() (crop-to-visible-window)
- `src/app/api/composite/route.ts` — CompositeLayerInput에 x?,y?,scale? 추가
- `src/lib/db/migrate.ts` — migrateV8: 'sprite_effect' kind 추가
- `src/lib/db/schema.sql` — kind CHECK 17개
- `src/types/db.ts` — GenerationKind에 'sprite_effect' 추가
- `src/components/editor/SceneComposer.tsx` — 드래그 배치 + scale 슬라이더
- `src/components/editor/SpriteCanvas.tsx` — 이펙트 탭 추가

## 기술 스택
- Next.js (App Router), TypeScript, React
- sharp 0.33 (이미지 합성), better-sqlite3 (WAL), MCP stdio
- DB: generations 테이블 (kind enum v8: text2img/img2img/.../composite/sprite_effect)

## 주요 설계 포인트
- **sharp out-of-bounds**: overlay > base 크기면 throw. `scale>1` 시 crop-to-visible-window 방식 채택 (배치 사각형 ∩ 캔버스 → extract → 교집합 좌상단 합성).
- **opacity**: sharp composite에 opacity 옵션 없음 → raw RGBA alpha 채널 multiply.
- **contain-fit**: fit:'contain'으로 정확한 캔버스 크기 맞춤 (투명 패딩).
- **이펙트 셀 처리**: 각 셀 독립 투명 캔버스에서 effect(아래)+sprite(위) 합성 → 셀 경계 블리딩 방지.
- **outline 채널 버그**: sharp `.threshold()`가 3채널 sRGB로 승격 → `.toColourspace("b-w")`로 단일채널 복원 필요.
- **SceneComposer 드래그**: useZoomPan의 drag-pan이 실제로 배선 안 돼 있어 충돌 없음; selectedIdx 있을 때 window-level mousemove 추적.
- **이펙트 적용 범위**: 전체 시트 오버레이(위치 어긋남 문제) 대신 알파 마스크 기반으로 캐릭터 위치 자동 추적.

## 다음 단계
- Phase 3 (필요 시): 9-slice 패널 생성기, 버튼 상태 스프라이트
- 이펙트 탭 확장: 프레임별 이펙트 (Phase 3 별도 빌드)
- MCP 자연어 연동 (씬 합성 명령어)
