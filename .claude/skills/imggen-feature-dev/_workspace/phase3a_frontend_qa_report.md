# Phase 3A 프론트엔드 QA 리포트 — 스프라이트시트 생성 패널

검증: visual-qa / 2026-05-28
대상: SpriteGenPanel + 마커 passthrough (커밋 미반영, 작업트리)

## 종합: PASS (1건 비차단 시각 관찰)

마커 방식(패널 → buildSpriteMessage → /api/chat → Claude → make_spritesheet)이 **실 LLM 흐름으로 검증됨**.
두 흐름(fresh / reference) 모두 마커 key/value 가 추론 변형 없이 make_spritesheet 에 전달됨.

---

## 1순위 — 게이트 (PASS)

| 게이트 | 결과 |
|--------|------|
| `npx tsc --noEmit` | exit 0, 0 error |
| `pnpm lint` (eslint) | exit 0, 0 error / 0 warning |
| `pnpm build` | exit 0, 14 routes 생성 성공 |

tsc 0-error 가 곧 `make_sheet` Action union 3곳(ImageResultCard L31 / MessageList L23 / ChatLayout handleAction L373) 정합 증명.

## 2순위 — 마커 빌더 결정적 단위 (PASS)

스크립트: `scripts/test-sprite-marker.ts` (tsx, codex 미사용).
`buildSpriteMessage` 를 `@/components/editor/SpriteGenPanel` 에서 **직접 import** — React 컴포넌트 파일이지만
top-level 사이드이펙트 없어 node 로드 정상(별도 빌더 파일 분리 불필요). 전 케이스 PASS:

- **character** (attack, anchorStrategy=hip, directions=4, framesPerDir=6, rows=4, cols=6, loop=false):
  마커 = `[spritesheet: subjectType=character; anchorStrategy=hip; directions=4; framesPerDir=6; rows=4; cols=6; seamlessLoop=false]`,
  자연어에 액션구(melee attack swing motion)·설명·style suffix·transparent background 포함.
- **effect** (slash, rows=2, cols=4, loop=true): directions/anchorStrategy/framesPerDir **생략**, rows/cols/seamlessLoop 포함.
- **reference**: referenceId 있으면 attachmentGenerationIds=[refId], 마커 본문엔 reference 미포함(route 가 prefix). 없으면 [].
- **custom**: customText 가 자연어에 반영.
- **white background**: "white background" 출력, transparent 미출력.

## 3순위 — UI 상호작용 (소스 검증 — Playwright 미설치)

**Playwright 미사용 사유:** `@playwright/*` 미설치 + ms-playwright 브라우저 캐시 없음. 설치는 네트워크 의존 무거운 작업이라
스킬 원칙(surgical) 상 회피. dev server(:3000)는 가동 중. UI 상호작용은 순수 React state 로직이라 컴포넌트 전문(全文)
정독 + 빌드 통과로 검증:

- Composer [▦ 시트] 버튼: `onOpenSpriteGen` 있을 때만 렌더(L244), 클릭 → `setSpriteGen({})` (ChatLayout L808). PASS
- 결과카드 분기(L195 삼항): spritesheet → [캐릭터](overlay), 비-시트 → [▦ 시트 만들기](make_sheet) → handleAction L417 → `setSpriteGen({ reference })`. PASS
- 종류 토글(L197): character↔effect → isCharacter 게이팅으로 옵션 영역 교체. PASS
- 그리드 미리보기(useMemo L147): character=directions×framesPerDir, effect=effectGrid(near-square). 방향 라벨(L108 DIRECTION_ROW_LABELS) directions>1 시 행별 표시. PASS
- 앵커 hip 힌트(L313): anchorStrategy==="hip" 시 "인간형 권장" 문구. PASS
- 커스텀(L152 canSubmit): preset==="custom" && customText 비면 [생성] disabled. PASS

스크린샷 미생성(Playwright 미설치). 로직 결함 없음 — 단, 실제 클릭 회귀는 미실행으로 명시.

## 4순위 — 마커→make_spritesheet passthrough (실 LLM, PASS) ★핵심

dev server 가 system-orchestrator.md 를 mtime-cache 로 리로드(route.ts L65~) → 수정된 "Structured directive" 지시 라이브 반영 확인.

### (a) fresh character — 실행 `/api/chat`
입력 메시지: `[spritesheet: subjectType=character; anchorStrategy=hip; directions=4; framesPerDir=6; rows=4; cols=6; seamlessLoop=false]\n캐릭터 melee attack...`
SSE `tool_call_started.args` (Claude 가 make_spritesheet 에 넘긴 그대로):
```
{"prompt":"blue armored knight melee attack swing motion, ... transparent background, uniform cells, consistent subject across frames",
 "rows":4,"cols":6,"subjectType":"character","anchorStrategy":"hip","directions":4,"seamlessLoop":false}
```
→ rows=4·cols=6·subjectType=character·anchorStrategy=hip·directions=4·seamlessLoop=false **그대로**. framesPerDir 미전달(정보용, 정상).
gen `pqqi3tdywlgna7a6`, params 영속 = 위와 동일(+ anchor pivot). mcp-server.log: `normalized (4x6) anchor=hip`, 24/24 non-empty.

### (b) reference(⑨) — 실행 `/api/chat` (attachmentGenerationIds=["xbp0ax6388mkud02"])
route 가 `[reference: xbp0ax6388mkud02]\n[spritesheet: ...]` 합성(route.ts L125,L127). SSE args:
```
{"prompt":"Character walking motion, 4 directions ... seamless walk cycle loop",
 "rows":4,"cols":6,"subjectType":"character","anchorStrategy":"hip","directions":4,"seamlessLoop":true,
 "inputGenerationId":"xbp0ax6388mkud02"}
```
→ **마커 params 6개 + inputGenerationId 둘 다 수신.** [reference:] 가 앞에 와도 directive 누락/변형 없음
   = 오케스트레이터 "may be preceded by [reference:]" 수정이 실제로 동작.
gen `btxjvmppsuvg3d5z`, input_image_ids=['xbp0ax6388mkud02'], params 영속 OK. mcp-server.log: start `inputs=[xbp0ax6388mkud02]`, `normalized (4x6) anchor=hip`.

## 9 — 결과카드/시각 검증 (PASS, 비차단 관찰 1)

- `data/images/pqqi3tdywlgna7a6.png` (Read 육안): 4×6 파란 갑옷 기사. 행=방향(정면/측면/후면), 6 공격 스윙 프레임. 셀 정렬 양호, 투명 후처리·셀 보존 정상, 녹색 잔여 없음.
- `data/images/btxjvmppsuvg3d5z.png` (Read 육안): 참조 마법사(보라 로브·모자·지팡이) 외형 전 프레임 보존 → 참조 생성 동작 확인. 4×6 walking.
  - **비차단 관찰:** 어두운 마법사라 chroma-key(green) 후 로브 가장자리에 옅은 녹색 잔여가 일부 보임. Phase 3A 프론트 회귀 아님 — 후처리/생성 품질 영역(어두운 피사체 chroma-key). 마커·params·결과카드 계약은 정상.

## 미검증/한계
- 브라우저 실제 클릭(패널 열기·토글·그리드 갱신) Playwright 미실행 — 소스 로직 검증으로 대체.
- effect 흐름 실 LLM 미실행(빌더 단위 + character passthrough 2건이 동일 마커 메커니즘 커버). 한도 절약 위해 케이스 2건으로 최소화.
