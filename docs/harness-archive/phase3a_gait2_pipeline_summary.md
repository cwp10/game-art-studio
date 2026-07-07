# Phase 3A — gait v2: 프레임별 choreography + 집중 생성 비교

## 변경 (작업 1)
- 파일: `src/lib/mcp/spritesheet-classify.ts` `buildGaitPrompt()` 만 강화. 서버 wiring·후처리·UI·DB 무변경.
- 테스트: `scripts/test-directions.ts` gait 단언을 새 문구에 맞게 갱신(의미 유지). 회귀 0.
- QA 도구 추가(일회성): `scripts/measure-gait-diff.mjs` — 인접 프레임 하단 1/3 실루엣 XOR/Union diff 정량.

### 프롬프트 전후
- **전(a1dae81):** "Frame 1 = LEFT forward", "Frame mid = MIRROR", "SCISSOR ... passing frame", "Do NOT keep one foot static" — 일반 서술. 모델이 near-duplicate·narrow stance 로 미준수.
- **후:** 프레임 번호별 명시 표.
  - F1 CONTACT (legs WIDE, max stride) → F2 PUSH-OFF → F3 PASSING (legs cross UNDER torso, 단일 다리 실루엣) → F4 CONTACT(mirror, WIDE) → F5 PUSH-OFF(mirror) → F6 PASSING(mirror, F1 으로 loop). N(4/6/8/12) 인지형(공식: contact at F1 & floor(N/2)+1, 나머지 push-off/passing 보간).
  - 차별화 강제: "NO two frames may look the same or near-duplicate ... animation FAILS".
  - stride 강제: "CONTACT frames legs WIDE apart, LARGE stride, never narrow upright stance".
  - 측면 crossing: PASSING 에서 두 다리 시각적 OVERLAP/CROSS, bent knee + 상하 bob.
  - front/back(DOWN/UP): 좌우 다리 반절씩 교대 + arm swing + bob.
  - directional: "every row SAME per-frame choreography, only camera angle differs".

## 작업 2 — 집중 생성 가설 실측 (강화 프롬프트 적용 후 재생성)
diff 지표 = 인접 프레임 다리영역(하단 1/3) 실루엣 XOR/Union. 0=동일(near-dup), 1=완전상이. <0.10 ≈ 같은 포즈.

| 시트 | 행 | avg diff | min diff | 비고 |
|------|-----|---------|----------|------|
| **baseline**(eugn2815kt50sn9w, 강화 전 4×6) | LEFT | 0.243 | 0.182 | 좁은 stride, passing 없음 |
| | RIGHT | 0.128 | 0.071 | 거의 정적 |
| | DOWN | 0.113 | 0.017 | 정적 |
| | UP | 0.030 | 0.013 | 사실상 동일 |
| **A** 단일방향 측면(fsx7tpfv3qtsxn7k, 1×6→자동 2×3) | LEFT(상단3) | **0.620** | 0.117 | 광폭 stride + 명확 passing |
| | RIGHT(하단3) | **0.636** | 0.182 | 광폭 stride + 명확 passing |
| **B** 4방향(6knn3ym9adk9n3h9, 4×6) | DOWN | 0.172 | 0.139 | 정면 occlusion, 약하지만 baseline↑ |
| | LEFT | **0.439** | 0.213 | 명확 scissor + passing |
| | RIGHT | **0.410** | 0.205 | 명확 scissor + passing |
| | UP | 0.181 | 0.099 | 후면 occlusion, 약하지만 baseline↑ |

### 육안 판정 (실 PNG)
- **A**: 6프레임 = 광폭 contact(다리 앞뒤로 크게 벌어짐) + passing(다리 겹쳐 단일다리 실루엣) 교대가 또렷. **명확한 발 교차.** 가장 깨끗.
- **B**: LEFT/RIGHT 측면 행에 광폭 stride + passing 프레임 둘 다 등장 → 진짜 scissor. baseline 대비 RIGHT 0.128→0.410(+220%), LEFT 0.243→0.439(+81%). DOWN/UP(정/후면)은 다리가 몸에 가려 stride 가 작게 보이나 baseline 의 "정지"보다는 분명히 교대.

## 판정 & 권고 (정직)
- 강화 프롬프트는 baseline 의 3대 문제(near-duplicate / narrow stride / passing 부재)를 **정량·육안 모두에서 개선**. 측면 행이 핵심 수혜.
- **A(단일방향) > B(4방향).** A 의 측면 diff(0.62/0.64) 가 B 의 측면(0.44/0.41) 보다 확연히 높고 stride·passing 이 더 또렷 → "24포즈 희석" 가설은 **부분적으로 참**: 한 방향에 집중하면 측면 보행 품질이 더 좋다.
- **사용자 권고:**
  1. 측면 보행 품질이 중요하면 **방향별로 따로 생성**(directions=1, 측면 의도 프롬프트)이 가장 또렷. 4방향 한 장 생성보다 측면 stride/passing 우수.
  2. 4방향 한 장도 baseline 대비 측면은 쓸만하나 정/후면(DOWN/UP)은 occlusion 으로 약함 — 한계 인지.
  3. 프레임수는 6 으로 충분히 contact/passing 표현됨. 더 줄일(4) 필요 없음. 단 프레임이 많을수록(8/12) 모델이 차별화에 부담 → 6 권장.
- **한계(정직):** 모델 의존 best-effort. 프롬프트로 보장 불가. A 의 reshape(1×6→2×3)로 측면이 2행에 나뉘었어도 품질은 좋았음. 완벽한 4방향 일괄 보행은 여전히 모델 한계.

## 게이트
- tsc --noEmit: PASS / eslint: PASS / next build: PASS(exit 0)
- test-classify 34 / test-directions 42 / test-spritesheet 18 = 회귀 0.

## 산출물 경로
- A: `/Users/wonpyoung/Developer/workspace/image-generator/data/images/fsx7tpfv3qtsxn7k.png`
- B: `/Users/wonpyoung/Developer/workspace/image-generator/data/images/6knn3ym9adk9n3h9.png`
- baseline: `/Users/wonpyoung/Developer/workspace/image-generator/data/images/eugn2815kt50sn9w.png`
