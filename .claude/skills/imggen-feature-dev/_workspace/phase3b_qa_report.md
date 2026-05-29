# Phase 3B — SpriteCanvas 강화 QA 리포트

검증자: visual-qa · 일시: 2026-05-28 · 대상 커밋 베이스: a39d4dd (작업 트리)

## 종합

| 영역 | 결과 |
|------|------|
| 게이트 (tsc/lint/build) | PASS |
| 결정적 API (GET/POST/.json) | **1 FAIL** (POST upload 존재하지 않는 sessionId → 500) + 나머지 PASS |
| 브라우저 UI (Playwright) | **미실행** (Playwright 설치 차단 — 사유 아래). 소스+결정적으로 커버 |

전반적으로 핵심 기능(params 그리드 source-of-truth, kind=spritesheet 라운드트립, lineage/params 보존, .json 포맷)은 동작. **다만 upload 라우트에 방어적이지 못한 FK 버그 1건** — fullstack-engineer 에 되돌림.

---

## 1순위 게이트 (PASS)

- `npx tsc --noEmit` → exit 0 (에러 0).
- `pnpm lint` → exit 0 (warn 0).
- `pnpm build` → exit 0. 라우트 등록 확인: `ƒ /api/generations/[id]`, `ƒ /api/upload`, `ƒ /api/generations`.

## 2순위 결정적 API

### GET /api/generations/[id] — PASS
- `GET eugn2815kt50sn9w` → 200, `{id,kind:"spritesheet",params:{seamlessLoop,subjectType,anchorStrategy,directions:4,anchor:{x:171,y:330},rows:4,cols:6,cellW:341,cellH:341,fps:12},width:2046,height:1364,imageUrl:"/api/images/eugn2815kt50sn9w"}` — 스펙·summary 실측과 일치.
- `GET doesnotexist0000` → 404 `{error:"generation not found"}`.
- 경계면: API route 응답 shape == client `getGeneration` 타입 == SpriteCanvas `gen.params as SheetParams`. repo `getGeneration` 가 `params` 를 JSON.parse 해 `Record<string,unknown>` 반환(generations.ts:33) — 일치.

### POST /api/upload kind="spritesheet" — **FAIL (조건부)**
- **유효 sessionId 로는 PASS**: `parentGenerationId=eugn2815kt50sn9w` + `sessionId=scwu7db0z46t`(실존) → 200. 생성된 행 검증:
  - `kind="spritesheet"` ✓, `params` 전체 보존 ✓, `input_image_ids=["eugn2815kt50sn9w"]`(lineage) ✓, `prompt="보정: <원본prompt>"` ✓, `backend="external"` ✓, 원본 `eugn2815kt50sn9w` 그대로 보존(비파괴) ✓.
- **FAIL**: `sessionId="qa-test-session"`(미존재) → **HTTP 500** `SqliteError: FOREIGN KEY constraint failed`.
  - 원인: `src/app/api/upload/route.ts:117`
    `session_id: parent?.session_id ?? body.sessionId ?? null`
    parent(eugn2815kt50sn9w)의 `session_id` 가 `null` 이라 `null ?? body.sessionId` → `body.sessionId` 채택. 그 값이 `sessions` 테이블에 없으면 `generations.session_id REFERENCES sessions(id)`(schema.sql:32) FK 위반 → 500.
  - 스택: `createGeneration (generations.ts:83) ← POST (upload/route.ts:115)`.
  - 영향: 정상 UI 경로(`sessionId=state.activeSessionId`, 보통 실존)에서는 200. 그러나 activeSessionId 가 stale/null·미존재이거나, parent.session_id 가 null 인데 전달 session 이 미존재인 경우 보정본 저장이 500. 방어 부족.

### kind="image" / "mask" 회귀 — PASS
- `kind="image"` (parent 없음) → 200.
- `kind="mask"` (parent 없음) → 400 `{error:"parentGenerationId required"}` (기대대로).

### .json 빌더 포맷 — PASS
- SpriteCanvas `buildAtlasJson()` 로직을 eugn2815kt50sn9w params 로 재현 → summary 예시와 **완전 일치**:
  `{image, cellWidth:341, cellHeight:341, rows:4, cols:6, subjectType:"character", directions:["DOWN…","LEFT","RIGHT","UP…"], framesPerDirection:6, fps:12, loop:true, anchor:{x:171,y:330}}`.

### 경계면 교차 비교 — PASS
- `uploadSpritesheet` 요청 `{kind:"spritesheet",dataUrl,parentGenerationId,sessionId,params}` == `UploadBody` 수용 필드.
- 응답 `{generationId,width,height}` == `onSaved(res)` == `dispatch(add_result_card{...kind:"spritesheet"})`.
- 비정사각: eugn 은 2046×1364, cols=6→floor=341, rows=4→floor=341 (우연히 정사각). floor 독립 역산 코드 경로 확인.

## 3순위 브라우저 UI — 미실행

**Playwright 설치 불가**: Python `playwright`, Node `playwright` 모두 미설치. `pip3 install playwright` 가 auto-mode 분류기에 의해 차단됨(declared dependency 아님 — supply-chain). 우회 시도 안 함.

대체 커버리지(소스 정독 + 결정적):
- params 그리드 마운트 fetch: dev 로그에서 실 UI 가 `GET /api/generations/btxjvmppsuvg3d5z 200`(4×6 dir=4 시트) 자연 발생 확인 → 마운트 effect 동작.
- 방향 드롭다운/어니언/행보정/저장: 소스 로직 정독으로 인덱스 정합 검증(`push` 루프 ↔ `framePos` ↔ `siblingsOf` ↔ `saveCorrected` 재배치 `col*cellW-dragPad`). 시각 픽셀 확인은 미수행.
- **육안(스크린샷) 미확보** 항목: 어니언 반투명 오버레이 실제 렌더, 방향 선택 시 미리보기 프레임 필터, 셀 드래그 인터랙션, 결과 카드 삽입. → 사람 확인 또는 Playwright 의존성 승인 후 재검 필요.

## 회귀
- kind=image/mask 라우트 회귀 0.
- 신규 npm 의존 0(gif.js/jszip 동적 import 유지).
- (무관) `CompareSheet.tsx:210` Turbopack dev 파싱 에러가 dev2.log 에 있으나 **Phase 3B 미변경 파일**·`pnpm build` green·git clean → stale dev 아티팩트. Phase 3B 무관.

## 정리
- 테스트 생성 행 2건(`ae1569t40e70e828`, `4kj7nb8fkci6odsu`) DB 삭제 + 이미지 파일 삭제 완료. 잔여 0.
- 원본 `eugn2815kt50sn9w` 보존 확인.
- /tmp 임시 파일 정리 완료.
