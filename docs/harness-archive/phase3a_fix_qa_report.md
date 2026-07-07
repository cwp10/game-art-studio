# Phase 3A Fix QA Report — chroma 잔여 제거 + 걷기 gait

검증 대상: pipeline-engineer 의 chroma(결정적) + gait(모델 의존) 수정.
before: `data/images/el2vbyq3eqccnv7n.png` / after: `data/images/eugn2815kt50sn9w.png`

## 1순위 — 결정적 게이트·회귀 (전부 PASS)

| 게이트 | 결과 |
|--------|------|
| `npx tsc --noEmit` | PASS (exit 0) |
| `pnpm lint` | PASS (exit 0, eslint clean) |
| `pnpm build` | PASS (exit 0, 17 routes) |
| `test-spritesheet.ts` | **18/18 PASS** |
| `test-classify.ts` | 34/34 PASS |
| `test-directions.ts` | 40/40 PASS |

본체 보호 회귀(핵심):
- **CASE D** 내부 녹색 옷 패치 보존: px(128,120) rgba=0,255,0,**255** (alpha=255, g=255 despill 안 됨). 회색 본체 alpha=255. → enclosed 포켓 키아웃이 큰 내부 녹색 옷을 먹지 않음.
- **CASE E** magenta: 배경 alpha=0, 녹색 슬라임 본체 g=200 보존, magenta fringe 0개.
- **CASE F (신규, 다크 피사체)**: F1 다리 사이 포켓 키아웃 남은 불투명 **0px**, F2 큰 내부 옷 손상 셀 **0**, F3 옷 외부 halo+포켓 k>20 **0px**.

## 2순위 — 실제 재생성 비교 (실생성 수행함)

`scripts/qa-mcp-spritesheet.mjs "기사 걷기" 4 6 character 4` (seamlessLoop=true 하드코딩).
gen=eugn2815kt50sn9w, 2046x1364, 137.5s, exit 0. before 와 동일 조건.

### 잔여 (결정적 개선) — 정량
`scripts/_qa-green-residue.mjs` (opaque 픽셀만, keyness=g-max(r,b)):

| keyness | before | after | 감소 |
|---------|--------|-------|------|
| k>40 (강한 녹색) | **2,055** | **6** | **99.7%** |
| k>20 | 5,326 | 95 | 98.2% |
| k>5 | 22,334 | 2,634 | 88.2% |

per-cell k>40 (4x6): before 는 row1(측면 RIGHT) 676px·row2(측면 LEFT) 837px 에 집중(다리 사이 포켓). after 는 **row1=0, row2=0 전부 소거**, 잔여 6px(row0 끝셀 4 + row3 첫셀 2)는 무시 가능.

### 잔여 — 육안 (Read)
after: 다크 아머 가장자리 녹색 fringe 없음. 측면 행(1·2) 다리 사이 enclosed 녹색 포켓/삼각형 잔여 없음. 은색 아머·빨강 망토·갈색 방패 색 손상 없음(본연 색 보존).

### 보행 (best-effort) — 육안
after 측면 행(1=LEFT, 2=RIGHT): 6프레임에 걸쳐 한 다리 앞·한 다리 뒤로 뻗고 교대, 중간 passing 프레임에서 교차(SCISSOR). before(측면 다리 거의 정지, 한 발만 까딱)와 명확히 대비. 정면(0)·뒷면(3) 다리 좌우 교대 + 약간 bob. "한 발만 까딱" 해소.

### gaitPrompt 주입 로그 증거
`data/logs/codex-rgcnyjzeib.log` (이 잡의 codex 로그) 에 시그니처 전부 존재:
"WALK/RUN GAIT", "SCISSOR", "ONE complete walk cycle", "BOTH legs must swing",
"twitch a single leg", "passing frame where they cross", "Every row uses the SAME N-frame gait cycle".
→ 프롬프트 실제 주입 확인(코드 버그 아님). 보행 개선은 모델이 프롬프트를 준수한 결과.

chroma 로그: keyedOut 2,045,629 → 2,164,530 (+119k px, 포켓 키아웃+despill feather 반영).

## 경계면 / 배선 확인
- server.ts:566 `chromaKeyFile(filePath, chromaKeyColor, log, cellW*cellH)` → postprocess 4th param `cellArea` shape 일치. 단일 이미지 경로(720) 미지정 → 전체 폴백.
- server.ts:410/485-486 `isWalk=isLocomotion("기사 걷기")=true`, `isCharacter=true` → `gaitPrompt=buildGaitPrompt(6,true)` 주입(effectGuard 뒤, loopInstruction 앞). loopInstruction(415) isWalk 분기로 중복 하드코딩 walk 제거.

## 결론
- 잔여(chroma, 결정적): **PASS** — 강한 녹색 99.7% 감소, 측면 포켓 완전 소거, 본체 무손상. CASE D/E/F 회귀 0.
- 보행(gait, 모델 의존 best-effort): **개선 확인** — 프롬프트 주입 검증됨(로그), 측면 발 교차/scissor 육안 확인. 완벽 보장은 모델 의존이나 이전보다 명백히 나아짐.
- 회귀: **0**.
