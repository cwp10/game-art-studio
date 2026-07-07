# Phase 1 — 씬 프리뷰어 구현 완료

## 검증: ALL PASS

| Gate | 결과 |
|------|------|
| TypeScript tsc --noEmit | PASS (오류 0) |
| ESLint (신규 에러) | PASS (0개 신규) |
| Next.js build | PASS |
| DB 마이그레이션 (migrateV7) | PASS |
| 경계면 교차 비교 | PASS |
| ChatLayout 연결 | PASS |
| dispatch 호환성 | PASS |

## 변경 파일

### 신규
- `src/lib/image-backend/composite-layers.ts` — mergeImages() sharp 합성 함수
- `src/app/api/composite/route.ts` — POST /api/composite
- `src/components/editor/SceneComposer.tsx` — 씬 합성 UI

### 수정
- `src/lib/db/migrate.ts` — migrateV7 ('composite' kind 추가)
- `src/lib/db/schema.sql` — kind CHECK 확장
- `src/types/db.ts` — GenerationKind에 'composite' 추가
- `src/components/chat/ChatLayout.tsx` — sceneOpen 상태 + SceneComposer 렌더 + add_to_scene 핸들러
- `src/components/chat/ImageResultCard.tsx` — "씬에 추가" 버튼

## Phase 2 (미구현)
- 드래그 배치 (x,y 자유 배치)
- MCP 자연어 연동
- 씬 저장/재편집 (현재 flatten-only PNG)
- SpriteCanvas 오버레이 탭
