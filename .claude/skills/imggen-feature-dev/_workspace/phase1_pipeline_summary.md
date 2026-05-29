# Phase 1 — 결정적 후처리 강화 (백엔드) 변경 요약

작성: 2026-05-28 · pipeline-engineer

## 변경 파일·함수

### 신규: `src/lib/image-backend/spritesheet-postprocess.ts`
순수 픽셀 모듈 (sharp + node:fs 만 의존, top-level 사이드이펙트 없음 → tsx import 안전).
- `chromaKeyFile(filePath, keyColor="green", log?)` — green/magenta 일반화 + 적응형 임계값 + 테두리-connected 배경만 키아웃(본체 보호) + despill.
- `normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, opts?)` — 2-패스 시트-전역 단일 scale-to-fit + 앵커 전략별 정렬.
- export 타입: `AnchorStrategy = "auto"|"feet"|"hip"|"center"|"top"`, `SubjectType = "character"|"effect"`, `ChromaKeyColor = "green"|"magenta"`.

### 수정: `src/lib/mcp/server.ts`
- import: 새 모듈에서 `chromaKeyFile`, `normalizeSpritesheetCells`, 3 타입 (라인 ~37).
- `SCHEMAS.make_spritesheet.properties`: `subjectType`(enum), `anchorStrategy`(enum) optional 추가. required 불변.
- `CallArgs`: `subjectType?`, `anchorStrategy?` 추가.
- `make_spritesheet` 핸들러:
  - 녹색 캐릭터 키워드 감지 → `chromaKeyColor: "green"|"magenta"`, `bgInstruction` 마젠타 분기.
  - `subjectType`(param→classifyAnchor 폴백), `anchorStrategy`(param→"auto"), `resolvedAnchor`, `isEffectAnchor` 산출.
  - ⑧ 앵커 피벗 `anchorPivot {x,y}` 결정적 산출 (normalize 고정 목표선과 일치).
  - `runImageTool({ params: {...} })` 에 신규 params 전달.
  - 후처리: `chromaKeyFile(filePath, chromaKeyColor, log)`, `normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, { anchorStrategy, subjectType, log })`.
- `reskin_image` 시트 경로: `chromaKeyFile(filePath, "green", log)`, 부모 `params.subjectType` 상속 → `normalizeSpritesheetCells(..., { subjectType, log })`.
- 제거: 구 `chromaKeyGreenFile`, 구 `normalizeSpritesheetCells`(centerVertically 시그니처) — 모듈로 이관. `classifyAnchor`, `detectSpriteGrid` 는 server.ts 유지.

### 수정: `src/lib/image-backend/codex-exec.ts`
- `chromaKeyGreen` 위 NOTE 주석만 갱신(단일 이미지 전용이며 시트는 별도 chromaKeyFile 사용함을 명시). 코드 무변경.

## 영속되는 params JSON shape (Phase 3 계약)

`make_spritesheet` 결과 generation 의 `params` (JSON TEXT 컬럼, 파싱 시 객체):

```jsonc
{
  "seamlessLoop": false,          // boolean — 기존 유지
  "subjectType": "character",     // "character" | "effect"
  "anchorStrategy": "auto",       // "auto"|"feet"|"hip"|"center"|"top" (사용자 원시 선택, auto 보존)
  "anchor": { "x": 128, "y": 232 }, // 셀-로컬 피벗 (정수). export ⑧ 가 그대로 사용.
  "rows": 4,                      // 정수
  "cols": 6,                      // 정수
  "cellW": 256,                   // 정수 (셀 폭 px)
  "cellH": 256,                   // 정수 (셀 높이 px)
  "fps": 12                       // 정수 (SpriteCanvas 미리보기 기본값)
}
```

피벗 산출식 (cellH 기준, paddingBottom=round(cellH*0.03), margin=round(min(cellW,cellH)*0.05)):
- `anchor.x = round(cellW/2)`
- feet: `anchor.y = cellH - paddingBottom - 1`
- center: `round(cellH/2)`
- top: `margin`
- hip: `round(cellH - paddingBottom - 1 - cellH*0.9*0.45)`

주의: `anchorStrategy="auto"` 가 저장되며 `anchor` 는 resolved 전략(character→feet, effect→center) 기준으로 이미 계산됨. 읽는 쪽은 `anchor` 좌표를 신뢰하면 됨(전략 재해석 불필요).

reskin 시트 결과 params 는 기존대로 `{ mode, styleReferenceId, spritesheet }` (Phase 1 에서 anchor 메타 미저장 — reskin 은 부모 subjectType 만 상속해 정렬).

## 새 시그니처

```ts
chromaKeyFile(
  filePath: string,
  keyColor: ChromaKeyColor = "green",
  log?: (line: string) => void,
): Promise<void>

normalizeSpritesheetCells(
  filePath: string,
  rows: number,
  cols: number,
  wantsTransparent: boolean,
  opts?: { anchorStrategy?: AnchorStrategy; subjectType?: SubjectType; log?: (line: string) => void },
): Promise<void>
```

## 동작 요약 (결정적 보장)

- **① scale-to-fit**: 비빈 셀 keep-union bbox 중 maxBbW/maxBbH 로 단일 scale=min(1, cellSafeW/maxBbW, cellSafeH/maxBbH). scale<1 이면 모든 셀 nearest 축소. 콘텐츠를 자신의 셀 박스 `[cellX0, cellX0+cellW-sW]`/`[cellY0, cellY0+cellH-sH]` 에 클램프 → 셀 100% 포함. scale<0.5 면 log 경고.
- **⑤ 앵커**: feet/hip/top 은 고정 목표선(feet/hip=발 기준선 cellH-paddingBottom-1, top=margin) + scale 반영 기준점 offset. 셀의 목표 local 선이 중앙값에서 cellH*0.25 이상 벗어나면 중앙값 폴백(검출 이상치 거부). center 는 셀별 bbox 세로 중앙(기존 centerVertically 동작과 동일).
- **⑥ chroma**: 적응형 hard 임계값(strong 키 픽셀 median*0.5, [30,50] 클램프). 테두리 flood-fill(4-conn)로 배경-connected hard-key 만 투명화 → 본체 내부 키색 보존. despill 은 배경 경계 fringe 에만(green→g=max(r,b), magenta→r=b=g). 마젠타 키워드 폴백 핸들러에서 결정.
- **⑦ 이펙트 중앙**: subjectType=effect/auto→center 경로가 기존 centerVertically=true 와 동일.

## 알려진 한계·미구현

- **hip 휴리스틱**: `hipY ≈ footY - (footY-headTopY)*0.45` — 이족 인간형 가정. 4족/뱀/부유체엔 부정확. 비인간형은 feet/center 권장(계획서 ③ 참조). 피벗 산출식은 footY 기준 근사라 normalize 의 hip 정렬(headTopY 사용)과 미세 차이 가능.
- **적응형 임계값 범위**: hard 임계값 [30,50] 으로 보수적 제한. 모델이 매우 어두운 키색(#0a3a0a 등)을 그리면 잔재 일부 가능 → 슬라이더(미구현, 기존 noop) 대신 magenta 폴백 권장.
- **마젠타 폴백**: userPrompt 키워드(녹색/초록/연두/green/슬라임/slime/잎/leaf/이끼/moss)만 트리거. "고블린" 등 모호어 제외(회귀 방지). 사후 hue 분석 폴백은 비용 과다라 미구현(계획서 결정).
- **directions(②)**: Phase 3 — 미구현. params 에 directions 미저장.
- **reskin anchor 메타**: reskin 시트 결과엔 anchor/rows/cols params 미저장(부모 subjectType 상속만). export 가 reskin 시트를 다루려면 Phase 3 에서 보강 필요.

## visual-qa 검증 체크리스트

실제 codex 생성으로 확인 (구독 한도 고려, 케이스당 1장):

1. **오버플로 0 + 크기 일관성** (캐릭터): "기사 걷기 8프레임" 류 4x2, subjectType 미지정(추론). 모든 셀 콘텐츠가 셀 안 100% 포함, 프레임 간 캐릭터 크기 동일한지.
2. **foot 정렬** (캐릭터): 위 시트에서 모든 프레임 발이 공통 ground line 에 정렬되는지(드리프트 없음). `anchorStrategy=feet` 명시도 1장.
3. **이펙트 중앙** (effect): "슬래시 이펙트 4프레임" 2x2, subjectType=effect 또는 추론. bbox 세로 중앙, 꼬리 셀 하단 미접촉.
4. **녹색 옷 보호 + 녹색 캐릭터 마젠타 키**: "녹색 슬라임 idle 4프레임" → 마젠타 키 경로(로그 `key=magenta`), 슬라임 본체 녹색 보존 + 배경 투명. "녹색 망토 기사 걷기" → 본체 녹색 옷 보존되는지.
5. **마젠타 키 잔재**: 위 슬라임 시트에 마젠타 fringe/halo 잔재 없는지.
6. **hip 앵커** (선택): `anchorStrategy=hip` 인간형 1장 — 골반 라인 정렬이 발 기준보다 위로 안정적인지(휴리스틱 한계 인지).
7. **reskin 회귀**: 기존 마법사 캐릭터 시트 reskin → 셀 정렬·투명화 회귀 0. effect 부모 시트 reskin 시 중앙 정렬 유지.
8. **scale 경고 로그**: 모델이 셀보다 크게 그린 케이스에서 mcp-server.log 에 `scale=0.xxx` 가 합리적인지(<0.5 경고 여부).

로그 확인: `data/logs/mcp-server.log` 의 `chromaKeyFile(...)`, `normalizeSpritesheetCells(... anchor=... scale=...)` 라인.
