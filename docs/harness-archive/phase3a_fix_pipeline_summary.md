# Phase 3A Fix — chroma 잔여 제거 + 걷기 gait 프롬프트

대상 회귀: gen `el2vbyq3eqccnv7n` (기사 걷기, 4방향 6프레임, seamlessLoop=true, green key)
1. 녹색 잔여(다크 아머 엣지 halo + 다리 사이 포켓)
2. 측면 걷기 보행 부실(발 교대 없음)

---

## 진단 (픽셀 근거)

`data/images/el2vbyq3eqccnv7n.png` (최종 후처리 출력, 2046x1364) 를 sharp raw 로 분석:

- opaque=448,260 중 녹색 잔여(keyness=g-max(r,b)>5) = 22,334px
- **강한 녹색(k>40) = 2,055px** — 명백히 키아웃됐어야 할 픽셀
- 강한 녹색의 투명 경계까지 거리 분포:
  - d1~d2 (엣지 halo): **1,038px** ← 다크 엣지 2~3px 안쪽. 기존 despill(bgKey 1px 인접만)이 못 잡음
  - deep>8 (내부 깊숙): **578px** ← 다리 사이 enclosed 포켓(테두리 flood-fill 도달 불가) + sub-threshold
- 셀별 분포: row1(LEFT)·row2(RIGHT) 측면 행에 잔여 집중 → 측면뷰 다리 틈 포켓과 일치
- 잔여 connected-component: 3,860개 중 3,751개가 ≤30px, **>300px 0개** → 포켓은 전부 소형 (옷=대형과 명확히 구분)

결론: (1) 엣지 halo = despill 존이 1px 로 너무 좁음. (2) 다리 사이 = 소형 enclosed 키 포켓이 보존됨.

---

## 작업 1: chroma 변경 (`spritesheet-postprocess.ts`)

시그니처에 `cellArea?: number` 추가(시트=cellW*cellH 전달, 단일 이미지=미지정→전체).

### (a) enclosed 포켓 키아웃 (신규 단계 3.5)
테두리 flood-fill(bgKey) 후, 도달 못 한 hard-key 컴포넌트를 4-conn 라벨링.
**컴포넌트 면적 < max(48, cellArea*0.02)** 이면 배경 bleed 로 보고 bgKey=1 흡수.
- 다리 사이 포켓(셀의 ~0.17%) → 키아웃
- 옷/슬라임 본체(셀의 수%~) → 보존 (CASE D 패치=셀의 3.66% > 2% 임계 → 안전)

### (b) despill feather (신규 단계 3.6)
bgKey 에서 BFS 거리장 `bgDist` (반경 `DESPILL_RADIUS=3` 까지). despill 조건을
"bgKey 1px 인접" → "**bgDist ≤ 3**" 으로 확대. 다크 엣지 2~3px 안쪽 halo 까지 탈채도+알파감쇠.
내부 깊은 키색(옷)은 거리>3 이라 무영향. magenta 경로 동일 적용(keyness 정의만 다름).

---

## 작업 2: gait 프롬프트 (`spritesheet-classify.ts` + `server.ts`)

### 신규 순수 함수 (classify.ts)
- `isLocomotion(prompt)`: 걷기/walk/run/달리기/뛰기/march/행진/조깅… 키워드 감지
- `buildGaitPrompt(framesPerDir, hasDirections)`: 프레임수 인지형 gait
  - N 프레임 = 1 완전 보행주기. Frame1=좌발앞/우발뒤, Frame `floor(N/2)+1`=거울(우발앞/좌발뒤)
  - "BOTH legs must swing fully… NOT keep one foot static or twitch a single leg" 강조
  - 측면(LEFT/RIGHT): "legs SCISSOR in profile… visible passing frame"
  - 정면/뒷면(DOWN/UP): 다리 좌우 교대 + 약간 상하 bob
  - hasDirections: "Every row uses the SAME N-frame gait cycle" 행 일관성

### server.ts 배선
- `isWalk = isLocomotion(userPrompt)`
- `gaitPrompt = isCharacter && isWalk ? buildGaitPrompt(cols, !!directions) : ""` → decorated 에 effectGuard 뒤·loopInstruction 앞 주입
- **loopInstruction 통합**: 기존 하드코딩 8프레임 walk 예시 제거. isWalk 면 loop 은 "gait closes seamlessly" 한 줄만, 비보행이면 idle/attack 폐쇄만 담당 → 중복/충돌 제거
- seamlessLoop 무관하게 보행이면 발 교대 주입(걷기인데 loop 아니어도). 이펙트엔 미적용.

---

## 회귀 결과 (전부 PASS)

| 게이트 | 결과 |
|--------|------|
| `tsc --noEmit` | EXIT 0 |
| `pnpm lint` | EXIT 0 |
| `pnpm build` | EXIT 0 |
| `test-spritesheet.ts` | **18/18** (CASE D 내부녹색옷 alpha=255·g=255 보존, CASE E 마젠타 fringe 0, +신규 **CASE F**) |
| `test-classify.ts` | 34/34 |
| `test-directions.ts` | **40/40** (+gait/locomotion 단언) |

### 신규 CASE F (다크 피사체 잔여 결정적 검증)
다크 아머 + 다리 사이 enclosed 포켓 + 엣지 halo 합성:
- **F1** 다리 사이 포켓 키아웃: 남은 불투명 **0px** (before: 포켓 전체 348px 생존)
- **F2** 큰 내부 녹색 옷 보존: 손상 셀 **0** (CASE D 불변식 유지)
- **F3** 옷 외부 halo+포켓 잔여: **0px** (k>20)

---

## visual-qa 검증 포인트 (codex 실생성)

1. **재생성**: "기사 걷기", directions=4, cols=6, seamlessLoop=true (원본과 동일 params). green key.
2. **chroma 잔여 (작업1)**:
   - 다크 아머 가장자리 옅은 녹색 fringe 사라졌는지 (특히 다리·몸통 윤곽)
   - 다리 사이 틈에 녹색 포켓/삼각형 잔여 없는지 (LEFT/RIGHT 측면 행 집중 확인)
   - **회귀 금지**: 캐릭터 옷/장신구의 의도된 녹색이 통째로 사라지지 않았는지(보존)
3. **걷기 보행 (작업2)**:
   - 측면(2·3행): 한 다리 앞/한 다리 뒤로 확실히 뻗고 중간 프레임 교차(scissor), 다음 반대로
   - 정면·뒷면(1·4행): 다리 좌우 교대 + 약간 상하 bob, 정지 아님
   - 한쪽 발만 까딱거리는 현상 해소됐는지
   - 6프레임 루프 연속성(프레임6→1 자연 연결)
4. **결정성 회귀 0**: 발라인 정렬·셀 경계 내 포함·cross-cell 캐릭터 보존 그대로인지.
5. 추가 권장: 녹색 옷 캐릭터(예 "녹색 갑옷 기사 걷기") → magenta 경로 + gait 동시 동작 확인.
