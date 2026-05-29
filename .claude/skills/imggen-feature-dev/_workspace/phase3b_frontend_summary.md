# Phase 3B — SpriteCanvas 강화 (frontend) 변경 요약

스프라이트시트 개편 Phase 3B. params 기반 그리드 + 방향 행 선택 + 어니언 스킨 + 아틀라스 .json export
+ 오프셋 행별 보정 + 보정본 새 generation 저장. make_spritesheet 백엔드 후처리·생성 패널(3A)·codex
프롬프트는 일절 손대지 않음(읽기만).

## 신규/변경 파일

| 파일 | 변경 |
|------|------|
| `src/app/api/generations/[id]/route.ts` (신규) | `GET /api/generations/[id]` — 단일 generation 조회 |
| `src/lib/api/client.ts` (변경) | `getGeneration(id)`, `uploadSpritesheet(args)` 래퍼 2개 추가 (listGenerations 위, ~266행) |
| `src/app/api/upload/route.ts` (변경) | `kind:"spritesheet"` + optional `params`/`parentGenerationId` 수용 (UploadBody 타입·kind 가드·parent lookup·createGeneration 분기) |
| `src/components/editor/SpriteCanvas.tsx` (변경) | params fetch·방향 드롭다운·어니언·json·행 보정·보정본 저장 |
| `src/components/chat/ChatLayout.tsx` (변경) | SpriteCanvas 마운트에 `sessionId`/`onSaved` 전달 (~839행) |

## 경계면 계약 (요청/응답 shape)

### GET /api/generations/[id]  (신규)
- 요청: 경로 파라미터 `id`. body 없음.
- 응답 200: `{ id, kind, params: Record<string,unknown>, width:number|null, height:number|null, imageUrl:"/api/images/<id>" }`
- 응답 404: `{ error:"generation not found" }`
- 실측(eugn2815kt50sn9w): `params={seamlessLoop,subjectType,anchorStrategy,directions:4,anchor:{x,y},rows:4,cols:6,cellW:341,cellH:341,fps:12}`
- 소비자: `getGeneration` 래퍼 → SpriteCanvas 마운트 effect. (반대편 같이 변경한 곳 없음 — 순수 신규 조회 엔드포인트.)

### POST /api/upload  (확장 — 기존 image/mask 회귀 0, optional 필드만 추가)
- 기존: `{kind:"mask"|"image", ...}` 그대로 동작.
- 추가: `{ kind:"spritesheet", dataUrl, parentGenerationId?, sessionId?, params? }`
  → `createGeneration({kind:'spritesheet', backend:'external', params, input_image_ids:[parent?], session_id:parent?.session_id ?? sessionId, prompt:"보정: <원본prompt>" })`
  → 응답 `{ generationId, width, height }` (기존과 동일 shape).
- parent 는 선택 — 있으면 lineage(input_image_ids)·세션 승계, 없거나 삭제됐어도 저장 진행.
- 파일 쓰기: spritesheet 는 image 와 동일 sharp().png() 경로(mask 만 raw write 분기).
- schema CHECK enum 에 'spritesheet' 이미 존재 → kindHint 우회 불필요(image/mask 와 다른 점).

### onSaved → add_result_card (chat-state)
- `dispatch({type:"add_result_card", generationId, width, height, kind:"spritesheet", userText:"🎞️ 보정된 스프라이트시트", tempId})`
  reskin b-precise 패턴과 동일. ImageResultCard 가 `{generationId, imageUrl:/api/images/<id>, width, height, kind}` 합성 toolResult 로 렌더.

## SpriteCanvas 동작

- **params 그리드(source of truth)**: 마운트 시 `getGeneration(parentGenerationId)` → `params.rows/cols/fps` 있으면 초기값 동기화(사용자 수동 입력 유지). params 없으면(구버전 외부 업로드) `detectSpriteGrid`(GCD) 폴백 — 회귀 0. cellW/cellH 는 `floor(W/cols)`·`floor(H/rows)` 독립 역산(비정사각 셀 지원, 정사각 가정 제거).
- **방향 행 선택**: `params.directions>1`(=rows) + order="row" 일 때만 "방향" 드롭다운. 라벨은 `directionLabels(n)`(spritesheet-classify.ts 재사용). 비표준 directions 면 "행 N" 폴백. 선택 시 미리보기·GIF 가 해당 행 [r*cols, r*cols+cols) 프레임만 재생. "전체" 옵션 존재.
- **어니언 스킨(⑪)**: 토글 off 기본. ON 시 미리보기 캔버스에 (방향 필터된) 인접 prev/next 프레임을 globalAlpha 0.3 으로 깔고 현재 프레임 100% 위. canvas API 만 사용.
- **.json export(⑧)**: 다운로드 영역 [.json] 버튼 → `buildAtlasJson()` Blob 다운로드(`<id>.json`). params 우선, 없으면 현재 rows/cols/fps 최선.
- **행 보정(⑤)**: "행 보정" 토글 ON 시 드래그/화살표 nudge 가 같은 행 전체에 일괄(siblingsOf — order 고려). per-frame 미세조정도 유지.
- **보정본 저장(⑤)**: [보정본 저장] → adjustedFrames 를 원본 시트 치수(cols*cellW × rows*cellH)로 재배치한 PNG → `uploadSpritesheet`(params 보존) → onSaved. 저장 전 슬라이더/드래그는 미리보기만(비파괴). "보정본 저장됨" 피드백.

## .json 포맷 예시 (eugn2815kt50sn9w 실측)
```json
{
  "image": "eugn2815kt50sn9w.png",
  "cellWidth": 341, "cellHeight": 341,
  "rows": 4, "cols": 6,
  "subjectType": "character",
  "directions": ["DOWN (toward viewer)", "LEFT", "RIGHT", "UP (away from viewer)"],
  "framesPerDirection": 6,
  "fps": 12, "loop": true,
  "anchor": { "x": 171, "y": 330 }
}
```

## 구버전 폴백 / 기존 기능 회귀 체크
- params 없는 외부 업로드 시트: getGeneration→params null → detectSpriteGrid(GCD) 그대로. 방향 드롭다운/어니언 같은 방향 기준은 없지만(directionCount=0) 전체 재생·.json(폴백)·보정본 저장 동작.
- 기존 per-frame nudge·잔재 정리 슬라이더·GIF/zip 다운로드: 변경 없음(회귀 0). gif.js/jszip 동적 import 유지, 새 npm 의존 0.
- 정사각 시트(rows=cols=cellW=cellH): saveCorrected sheetW/H == 원본(실측 2046×1364 일치).

## 셀프 게이트 결과
- `npx tsc --noEmit` ✅  `pnpm lint` ✅(0 warn)  `pnpm build` ✅(/api/generations/[id] 라우트 등록 확인)
- 라이브 검증(localhost:3000 dev): GET /api/generations/eugn2815kt50sn9w → 200 + params 전체. 미존재 → 404. POST /api/upload kind=spritesheet → 200, kind='spritesheet'·lineage·params 보존 확인 후 테스트 행/이미지 정리.

## visual-qa 체크리스트
1. 결과카드 [스프라이트]로 eugn2815kt50sn9w(4×6 dir=4) 열기 → 그리드 4×6 자동, "방향" 드롭다운 4개 + 전체.
2. 방향 선택 시 미리보기/GIF 가 해당 행 6프레임만 재생.
3. 어니언 토글 → 인접 프레임 반투명 겹침 보임.
4. [.json] 다운로드 내용이 위 예시와 일치(directions 라벨·anchor·framesPerDirection).
5. 셀 드래그→[보정본 저장]→ chat 결과 카드 삽입 + 새 generation(kind=spritesheet, 원본 보존). 재오픈 시 params 그리드·.json 동작.
6. "행 보정" ON 후 한 셀 조정 → 같은 행 전체 이동.
7. 구버전: params 없는 외부 업로드 시트 → GCD 폴백, 방향 드롭다운 없음, 나머지 동작.
8. 회귀: per-frame nudge·잔재 정리·GIF·zip 그대로.
```
