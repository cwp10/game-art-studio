# Phase 3A 백엔드 — 방향 지원 + 가드/앵커 텍스트 일반화 (pipeline)

## 변경 파일·함수

### `src/lib/mcp/spritesheet-classify.ts`
- 신규 export `type Directions = 1 | 2 | 4 | 8` (라인 ~62).
- 신규 순수 함수 `directionLabels(n: Directions): string[]` (라인 ~70).
- 신규 순수 함수 `buildDirectionPrompt(n: Directions, framesPerDir: number): string` (라인 ~96).
- 기존 classifyAnchor/inferSubjectType/CHAR_WORDS/EFFECT_WORDS 무변경 (회귀 0).

### `src/lib/mcp/server.ts`
- import: `buildDirectionPrompt`, `type Directions` 추가 (라인 ~44).
- `SCHEMAS.make_spritesheet.properties.directions` 추가 (enum [1,2,4,8], optional) (라인 ~126).
- `CallArgs.directions?: Directions` 추가 (라인 ~291).
- 핸들러 directions 해석: `directions` 가 있으면 `rows = directions` 강제 + log (라인 ~321).
- 가드/앵커 일반화 블록 교체 (라인 ~414~470): `isEffectAnchor` 제거 → `isCharacter = subjectType === "character"` 기준.
  - `placementRule` (5전략 switch, exhaustive) + `anchorRule` 조립.
  - `containedContent`/`oversizeContent`/`effectGuard` 게이팅을 `isCharacter` 로.
  - `directionPrompt = isCharacter && directions ? buildDirectionPrompt(directions, cols) : ""`.
- `decorated` 조립에 `directionPrompt` 주입 (anchorRule 뒤, effectGuard 앞) (라인 ~480).
- `params.directions: directions ?? undefined` 영속 추가 (라인 ~503).

## 작업 1: directions 동작

- **레이아웃:** `rows = directions`, `cols = framesPerDirection`(그대로 사용). directions 미지정이면 기존 동작.
- **방향 순서(확정):**
  - 2 = LEFT, RIGHT
  - 4 = DOWN, LEFT, RIGHT, UP
  - 8 = DOWN, DOWN-LEFT, LEFT, UP-LEFT, UP, UP-RIGHT, RIGHT, DOWN-RIGHT (시계방향)
- **프롬프트:** "This is a DIRECTIONAL sheet: each ROW is one facing direction … Row 1 (top): character facing DOWN … Keep identical character, identical action phase alignment across rows; only the viewing angle differs."
- **이펙트 시트:** directions 가 와도 `directionPrompt` 미주입(`isCharacter` 게이트). rows 강제는 적용되나 방향 라벨 없음.
- directions=1 → `directionLabels` 빈 배열 → `buildDirectionPrompt` 빈 문자열(단일 방향).

### 시그니처
```ts
directionLabels(n: 1|2|4|8): string[]
buildDirectionPrompt(n: 1|2|4|8, framesPerDir: number): string  // ""  if n==1
```

## 작업 2: 가드/anchorRule 일반화 (전후 매트릭스)

게이팅 기준이 `isEffectAnchor`(=resolvedAnchor==="center") → `isCharacter`(=subjectType==="character") 로 이동.

| subjectType | anchor | effectGuard | content 열거 | placement 문구 |
|---|---|---|---|---|
| character | feet | 주입 | 캐릭터(몸·무기·천) | feet ground line + 동일 키 |
| character | hip | 주입 | 캐릭터 | hip 셀중앙 + 발 자연 낙하 |
| character | center | **주입(이전엔 누락)** | 캐릭터 | "WHOLE character vertically centered"(접지 언급 X, **VFX 문구 없음**) |
| character | top | 주입 | 캐릭터 | head top 셀 상단 근처 |
| effect | center | 없음 | VFX 포함 | "this is a VFX / radiates symmetrically / no ground line / tail not touching bottom" |
| effect | feet/hip/top | 없음 | VFX 포함 | 해당 캐릭터형 배치 문구(이론상; effect+auto→center 가 기본) |

**핵심 회귀 안전:**
- character+auto → resolvedAnchor=feet → 가드 주입 + CHARACTER ANCHOR + feet 문구 = **이전과 의미 동일**.
- effect+auto → resolvedAnchor=center → 가드 없음 + EFFECT ANCHOR + VFX 문구 = **이전과 동일**(VFX 문구 그대로 유지).
- 신규 해소된 모순: character+center 가 이전엔 "this is a VFX"라 말하고 가드가 빠졌으나, 이제 캐릭터 프레이밍 + 가드 주입.

## normalize 변경 여부

**변경 없음.** `normalizeSpritesheetCells` 의 앵커 정렬선은 feet=고정 cell-local 선(`cellH - paddingBottom - 1`)이라 각 행(방향)이 자동으로 셀-로컬 일관 정렬됨. directions 는 rows 수만 늘릴 뿐 셀 단위 후처리 불변식(글로벌 라벨링 → 최다 픽셀 셀 배치 → 셀별 정렬)에 영향 없음. 계획서 ⑤.4 "per-row 중앙값"은 median-of-detected 전제였고 현재 고정선 방식엔 무의미. 과설계 금지 원칙에 따라 미변경.

## params shape 갱신

기존 영속 객체에 `directions: directions ?? undefined` 1키 추가. (DB 스키마 무변경 — params 는 JSON blob.) directions 미지정 시 undefined 라 직렬화 안 됨(기존 시트와 호환).

## visual-qa 체크리스트

1. **방향 시트 4방향** — `make_spritesheet(prompt="기사 걷기", rows=4, cols=6, directions=4, subjectType="character", seamlessLoop=true)`:
   - 4행이 각각 DOWN/LEFT/RIGHT/UP facing 인지(행 순서 확인).
   - 모든 행 동일 캐릭터·동일 보행 사이클 페이즈 정렬, 카메라 각도만 차이.
   - 셀 정렬(발 라인)·chroma 잔여·cross-cell 캐릭터 보존 회귀 없음.
2. **방향 시트 2/8방향** — 2=좌/우, 8=시계방향 라벨 순서가 시각적으로 맞는지(특히 8방향 대각선).
3. **이펙트 + directions 무시** — `make_spritesheet(prompt="슬래시 이펙트", rows=4, cols=4, directions=4)`: 방향 라벨이 그려지지 않고 기존 이펙트 중앙 앵커 동작인지(rows=4 강제는 OK, 방향성 없음).
4. **character + center 회귀** — `anchorStrategy="center"`, subjectType=character: 캐릭터가 VFX 처럼 그려지지 않고(이펙트 입자 없음=가드 동작) 셀 수직 중앙 배치인지.
5. **기존 회귀 (의미 동일성)** — character+auto(걷기), effect+auto(슬래시): Phase 2 대비 결과 변화 없는지.
