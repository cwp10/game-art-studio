# data 누적 데이터 정리(lifecycle) — 구현 요약

날짜: 2026-05-28

## 배경
`data/images/` 241MB/169장 누적. 이미지 파일을 지우는 코드가 어디에도 없었음
(`deleteGeneration`은 DB행만·호출처 0곳, 세션삭제는 FK SET NULL로 generation 보존).
로그 244파일·jobs 261행도 prune 없이 무한 누적.

## 변경 파일
1. `src/lib/db/repo/sessions.ts` — `deleteSession` cascade 확장.
   - 세션 삭제 전 generation 수집 → 외부(타세션/고아) `input_image_ids` 참조 판별
     (`input_image_ids LIKE '%"id"%' AND session_id IS NOT ?`).
   - 미참조: 행+파일(이미지·썸네일) 삭제. 참조됨: 행·파일 모두 보존(FK가 session_id만 NULL).
   - 행 삭제는 트랜잭션, 파일 unlink는 그 뒤(fs.rmSync force).
2. `src/app/api/thumbnails/[id]/route.ts` (신규) — on-demand 썸네일.
   - `thumbnailPath(id)`(.webp) 캐시 히트 서빙, 미스 시 sharp `resize(256, inside)`+webp 생성·캐시.
   - 원본 없으면 410. 기존 167장 backfill 불필요(첫 요청 시 lazy 생성).
3. `src/components/library/GallerySheet.tsx` — 그리드 img src를 `/api/thumbnails/${id}`로
   교체(상세/라이트박스는 원본 `/api/images` 유지).
4. `scripts/cleanup.ts` (신규) + `package.json` `"cleanup"` — `pnpm cleanup [--days=7] [--dry-run]`.
   - (a) 고아 이미지/썸네일 (b) N일 지난 logs/*.log 삭제 + mcp-server.log 5MB 초과 시 tail 1MB로 truncate
   - (c) N일 지난 터미널+pending jobs 행 prune (d) tmp/job-* N일 정리. dry-run 시 건수만 출력.

## 검증 게이트 (전부 PASS)
- `tsc --noEmit` exit 0, `eslint` exit 0, `pnpm build` exit 0 (`/api/thumbnails/[id]` 라우트 빌드 포함).
- 썸네일 sharp 스모크: 1024×1024/289KB → 256×256 webp/14KB (~20x 절감).
- `pnpm cleanup --dry-run`: 고아 이미지 2개 감지(=수동 comm 결과 일치), 파괴 없음.
- 세션 cascade 격리 테스트(임시 IMAGEGEN_DATA_DIR) 8/8 PASS:
  미참조 행·파일 삭제 / 참조됨 행·파일 보존+session_id NULL / 타세션 무손상 / 세션 삭제.
  테스트 스크립트·임시 데이터 실행 후 삭제, 실데이터 무손상.

## 미실행(사용자 확인 필요)
- 실제 `pnpm cleanup`(non-dry) 미실행. dry-run 기준 회수 대상은 고아 이미지 2개(~184B)뿐.
- 개별 이미지 삭제 버튼: 범위 밖(사용자 결정).
