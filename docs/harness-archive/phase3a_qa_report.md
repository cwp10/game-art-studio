# Phase 3A 백엔드 QA 리포트 — 방향 지원 + 가드/앵커 텍스트 일반화

검증자: visual-integration-qa  ·  날짜: 2026-05-28

## 1순위 — 결정적 단위 검증 (codex 미사용)

### 1A. 방향 단위 테스트 — `scripts/test-directions.ts` (신규)
실행: `pnpm tsx scripts/test-directions.ts` → **23 PASS / 0 FAIL (EXIT 0)**

`directionLabels` / `buildDirectionPrompt` / `Directions` 를 직접 import 해 단언:
- `directionLabels(1)=[]`, `(2)=[LEFT,RIGHT]`, `(4)=[DOWN.., LEFT, RIGHT, UP..]`, `(8)`=시계방향 8개(DOWN,DOWN-LEFT,LEFT,UP-LEFT,UP,UP-RIGHT,RIGHT,DOWN-RIGHT) 정확. 길이=방향수.
- `buildDirectionPrompt(4,6)`: "DIRECTIONAL sheet" + "6-frame action cycle" + Row 1(top) DOWN ~ Row 4 UP 라인 4개 + "only the viewing angle differs". Row 토큰 정확히 4개.
- `buildDirectionPrompt(1,n)=""` (단일 방향).
- 경계 n=2(Row 2개, framesPerDir=8 반영), n=8(Row 8개, 시계방향 라벨순 정확, framesPerDir=4 반영).

### 1B. 분류 회귀 — `scripts/test-classify.ts` (기존)
실행: `pnpm tsx scripts/test-classify.ts` → **34 PASS / 0 FAIL (EXIT 0)**. 회귀 0.

## 1.5순위 — 가드/placement 게이팅 매트릭스 (server.ts 라인 인용)

핵심 라인:
- L420-421 `subjectType = args.subjectType ?? inferSubjectType(...)`
- L424-425 `resolvedAnchor = anchorStrategy!=="auto" ? anchorStrategy : subjectType==="effect" ? "center" : "feet"`
- L428 `isCharacter = subjectType === "character"`
- L433-451 `placementRule` switch(resolvedAnchor); `center` case 가 `isCharacter` 로 재분기
- L452 `anchorRule = "(5) " + (isCharacter?"CHARACTER":"EFFECT") + " ANCHOR — " + placementRule`
- L456-461 `containedContent`/`oversizeContent` ← `isCharacter`
- L465-473 `effectGuard` ← `isCharacter` (캐릭터면 항상 주입, anchor 무관)
- L476-477 `directionPrompt = isCharacter && directions ? buildDirectionPrompt(directions, cols) : ""`
- L489-491 decorated 조립: `anchorRule + directionPrompt + effectGuard`

| subjectType | resolvedAnchor | effectGuard | content 열거 | placement 문구 | directionPrompt |
|---|---|---|---|---|---|
| character | feet | 주입(L465) | 캐릭터(L456) | feet ground line(L436) | directions시 주입(L476) |
| character | hip | 주입 | 캐릭터 | hip 셀중앙+발 자연낙하(L438) | directions시 주입 |
| character | center | **주입** | 캐릭터 | "WHOLE character vertically centered"(L443), **VFX/ground line 단어 없음** | directions시 주입 |
| character | top | 주입 | 캐릭터 | head top 셀상단(L440) | directions시 주입 |
| effect | center(auto) | 미주입(L465 ""→) | VFX 포함(L458) | "this is a visual effect / VFX … radiates symmetrically … no ground line"(L444-449) | 미주입(isCharacter=false) |

**핵심 회귀 결론 (코드 논증):**
- character+center 의 placement 는 L443(isCharacter 분기)만 도달 → "this is a VFX" 문자열(L444)은 도달 불가. effectGuard(L465 isCharacter)도 주입. **Phase 2 모순(캐릭터인데 VFX 문구+가드 누락) 해소 확인.**
- effect+auto: resolvedAnchor=center, isCharacter=false → L444-449 VFX 프레이밍 유지, effectGuard "" → Phase 2 와 의미 동일.
- character+auto: resolvedAnchor=feet, isCharacter=true → CHARACTER ANCHOR + feet(L436) + effectGuard 주입 → Phase 2 와 의미 동일.
- directionPrompt 는 `isCharacter && directions` 에서만 (L476-477). effect/단일방향(directions 없음)엔 미주입. 조립 위치는 anchorRule 뒤·effectGuard 앞(L489-491).
- 문자열 위치 grep 교차확인: `WHOLE character vertically centered`=L443, `this is a visual effect / VFX`=L444(center의 !isCharacter 분기 내부), `radiates symmetrically`=L449. 매트릭스와 일치.

## 2순위 — 게이트

| 게이트 | 결과 |
|---|---|
| `npx tsc --noEmit` | **EXIT 0** (에러 0) |
| `pnpm lint` (eslint) | **EXIT 0** (에러 0) |
| `pnpm build` | **EXIT 0** ("Compiled successfully", 전체 라우트 정상) |

## 3순위 — 실제 codex 생성 (방향 시각 검증)

- 하네스 확장: `scripts/qa-mcp-spritesheet.mjs` 에 optional `[directions]` 5번째 인자 추가(additive, 기존 호출 무영향).
- 실행: `node scripts/qa-mcp-spritesheet.mjs "기사 걷기" 4 6 character 4` (directions=4, framesPerDir=6 → rows=4 강제, cols=6). **QA_EXIT=0**
- gen=`el2vbyq3eqccnv7n`, codex 226.2s, 2046×1364 생성 → resize → chroma-key(green) → normalized **(4x6) anchor=feet**.
- **로그 증거**: grid template `6x4` (rows=directions=4, cols=6 확인). `data/logs/codex-yo2x6gcu0g.log` 에 directionPrompt 실주입 확인 — "DIRECTIONAL sheet … SAME 6-frame action cycle" + Row 1 DOWN / Row 2 LEFT / Row 3 RIGHT / Row 4 UP. → `isCharacter && directions` 경로·라벨·framesPerDir=6 라이브 검증.
- **육안 (PNG Read) — PASS**:
  - Row 1 = DOWN(정면, 얼굴/방패/검 보임), Row 2 = LEFT(좌측면), Row 3 = RIGHT(우측면, row2 거울상), Row 4 = UP(뒷모습, 파란 망토·헬멧 뒤). **4행 방향 순서 라벨과 정확히 일치.**
  - 동일 기사 정체성(은갑옷·파란망토·검+방패) 전 행 유지. 행 간 카메라 각도만 차이.
  - 발 라인/접지 정렬 행 내·행 간 일관(feet 앵커 동작). chroma 녹색 잔여 없음, 투명 배경 클린. cross-cell 침범 없음(셀 내 마진 유지). 6열 보행 사이클 페이즈 진행·행 간 정렬 양호.

## 종합 판정: **PASS**

- 단위(방향 23/23, 분류 34/34) PASS, 게이팅 매트릭스 코드 논증 PASS(character+center VFX 모순 해소 확인), 게이트(tsc/lint/build) 전부 EXIT 0, 실생성 4방향 시각 검증 PASS.
- 회귀 0. character+auto / effect+auto 의미 Phase 2 대비 불변.
- 미해결/리스크 없음. (normalize 무변경은 의도된 설계 — anchor 고정선이 행마다 셀-로컬로 자동 일관.)
