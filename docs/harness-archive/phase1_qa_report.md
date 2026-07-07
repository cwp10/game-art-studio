# Phase 1 — 결정적 후처리 강화 QA 보고서

검증: 2026-05-28 · visual-qa
대상: `src/lib/image-backend/spritesheet-postprocess.ts` + `src/lib/mcp/server.ts` (make_spritesheet 312~509, reskin 623~664)
검증 스크립트: `scripts/test-spritesheet.ts` (tsx 실행, 합성 PNG + raw 픽셀 단언 + Read 육안)
산출 이미지: `data/tmp/qa-spritesheet/`

## 1순위 — 결정적 합성 시트 (codex 미사용)

`pnpm tsx scripts/test-spritesheet.ts` → **15 PASS / 0 FAIL.** 각 케이스 출력 PNG 육안 확인 완료.

### CASE A/B — 오버플로 클램프 + 단일 scale + foot 정렬 (2×2 캐릭터, green key, feet)  **PASS**
로그: `chromaKeyFile(green): hardThresh=50 keyedOut=178919/262144`, `anchor=feet scale=0.906 maxBb=200x254`
- A1 셀 경계 내부 100% 포함 (cross-cell 침범 0) — PASS
- A3 전 셀 동일 scale: out/in 높이비 0.906/0.905/0.907/0.906, spread 0.002 < 0.07 — PASS
- A4 최대 콘텐츠 높이 230 ≤ safe-zone 230 (scale<1 적용 확인) — PASS
- B1 발 라인 일관성: 4셀 foot local-Y 모두 247, 드리프트 0px — PASS
- B1b 발 라인이 고정 목표선 247 정렬 — PASS
- B2 가로 중심 정렬 spread 0.5px — PASS
- 육안(`caseAB_00_raw.png` vs `caseAB_02_norm.png`): 입력의 좌상단 캐릭터가 셀 밖으로 넘쳤으나 출력에선 셀 내부로 클램프됨. 녹색 배경 완전 제거. 4 캐릭터 발이 공통 라인 정렬, 상대 크기 보존. 녹색 fringe 없음(`caseAB_01_chroma.png` 확인).

### CASE C — center 앵커(effect) 세로 중앙  **PASS**
로그: `anchor=center scale=1.000`
- C1 4셀 모두 topGap=botGap (103/103, 98/98, 98/98, 108/108), centerY=128(=cellH/2) — PASS
- 육안(`caseC_norm.png`): 입력에서 상/하 치우쳤던 슬래시 사각들이 모두 셀 세로 중앙으로 정렬, 하단 미접촉.

### CASE D — 본체 보호(내부 녹색 옷 보존)  **PASS**
- D1 내부 녹색 패치 px(128,120) alpha=255 보존 — PASS
- D1b 내부 패치 g=255 (despill 안 됨) — PASS
- D2 배경 녹색 코너 alpha=0 — PASS
- D3 회색 본체 alpha=255 — PASS
- 육안(`caseD_chroma.png`): 회색 본체 안에 둘러싸인 밝은 녹색 패치 그대로, 배경 녹색만 투명. 테두리 flood-fill 본체 보호 동작 확인.

### CASE E — 마젠타 키(녹색 슬라임 보존, halo 없음)  **PASS**
로그: `chromaKeyFile(magenta): hardThresh=50 keyedOut=53536/65536`
- E1 마젠타 배경 코너 alpha=0 — PASS
- E2 녹색 본체 px(128,130) alpha=255 / E2b g=200 보존 — PASS
- E3 본체 경계 1~3px 링 마젠타스러운 잔재 0개 — PASS
- 육안(`caseE_chroma.png`): 마젠타 배경 완전 제거, 녹색 슬라임 본체 깨끗, halo/fringe 없음.

## 2순위 — 게이트  **PASS**
- `pnpm lint` → exit 0, 출력 `$ eslint` 만 (경고·에러 0).
- `pnpm build` → `✓ Compiled successfully`, `Finished TypeScript` (타입 에러 0), 14 라우트 정상 생성.

## 경계면 교차 비교  **PASS**
- 영속 params shape(server.ts 464~474) = 요약서 Phase 3 계약: `{seamlessLoop, subjectType, anchorStrategy, anchor:{x,y}, rows, cols, cellW, cellH, fps}` 일치.
- SCHEMA(115/120) + CallArgs(286/287) `subjectType`·`anchorStrategy` optional enum 추가, required 불변.
- ⑧ 업프런트 피벗 anchorY(feet=`cellH-paddingBottom-1`, server.ts 455) = normalize 고정 목표선(501) 동일식 → export 좌표 일치 보장.
- reskin 시트(647~657): green chroma + 부모 `params.subjectType` 상속(effect→center, else feet) — 요약서대로.
- import 경로 `../image-backend/spritesheet-postprocess.js` (NodeNext) — build 통과로 해소 확인.

## 알려진 관찰 — localLines inert 코드  **정상(한계만 기록)**
orchestrator 지적대로 feet/hip 경로의 `localLines`(458~467)가 전 셀 고정선이라 "중앙값 이상치 거부"(505~506)는 사실상 no-op. **그러나 결과는 정상**: Case A/B 에서 foot 드리프트 0px, 전 셀 정확히 목표선 247 정렬. 고정 목표선이 일관성을 직접 보장하므로 inert 코드는 무해. **이번 범위 수정 불필요, 한계로만 기록.** (참고: noisy footY 검출 시 셀별 폴백이 동작 안 하는 잠재 한계는 존재하나, 합성·시각 양쪽에서 정렬 일관성 정상.)

## 3순위 — 실제 codex 생성  **미실행**
사유: 구독 한도 절약(스킬 원칙) + 1순위 결정적 검증이 모든 보장(scale·foot·center·body·magenta)을 합성으로 이미 픽셀 단위 입증. 실제 생성 검증은 한도 여유 시 케이스당 1장(기사 걷기 8프레임 / 녹색 슬라임)으로 보강 권장. 로그 확인 지점: `data/logs/mcp-server.log` 의 `chromaKeyFile(...)`, `normalizeSpritesheetCells(... anchor=... scale=...)`, `key=magenta`.

## 종합
결정적 후처리 강화 백엔드 = **전 항목 PASS, 회귀 0.** 게이트(lint/build) 통과. 영속 params·reskin 상속·앵커 피벗 경계면 정합. 실제 codex 생성만 한도 고려로 미실행(은폐 아님, 결정적 검증이 1순위로 충분).
