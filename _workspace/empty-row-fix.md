# 스프라이트시트 "빈 행" 버그 수정 (pipeline-engineer)

## 변경 파일
- `src/lib/image-backend/spritesheet-postprocess.ts` — `normalizeSpritesheetCells` step4(컴포넌트→셀 할당)만 교체. +75/-6.
- server.ts / 컴포넌트들은 미변경(MIN_CELL 그대로).

## 원인
모델이 캐릭터를 고정 그리드선(cellH=256)에 안 맞추고 세로로 표류시켜 그려, 다수결 고정-그리드 행 할당이 어떤 행(예: row2)에 0개를 배정 → 그 행이 통째로 빈다.
검증 스냅샷 `data/images/r52yy9mpk0yzo83d.png.stage1_chroma.png` 은 실제로 7개 콘텐츠 밴드(각 12 캐릭터, 84개)뿐 — 진단 전제("8행 정상")와 달리 7밴드. 따라서 8행 다 채우는 건 불가, 빈 행은 끝(row7)으로 가야 정상.

## 수정 (step4 only)
1. 기본 경로는 기존 다수결 고정-그리드 셀 할당 유지(col 은 항상 다수결 — 가로 표류 없음 데이터로 확인).
2. **유의미 컴포넌트(셀 면적 1% 이상)** 기준으로 "내부 빈 행"(콘텐츠 행 사이에 낀 빈 행) 탐지. 노이즈 스펙(키잉 잔재)이 행을 가리지 않도록 필터.
3. 내부 빈 행이 있을 때만 row 재배정: 유의미 컴포넌트 y-중심 정렬 → 갭(cellH*0.5) 초과 시 새 밴드(그리디 분할) → 밴드 순서대로 row 0..n-1. 밴드<rows 면 끝 행은 빈 채로(억지 채움 금지), 밴드>rows 면 마지막 행 클램프. 노이즈는 최근접 밴드 row 추종.
4. 패스1/2/3(추출·단일scale·앵커정렬), cross-cell keep, 다리사이 포켓, chroma despill 전부 미변경.

## before→after (동일 stage1_chroma 입력, 8x12)
| | r0 | r1 | r2 | r3 | r4 | r5 | r6 | r7 |
|--|--|--|--|--|--|--|--|--|
| before | 12 | 12 | **0** | 12 | 12 | 12 | 12 | 12 |
| after  | 12 | 12 | **12** | 12 | 12 | 12 | 12 | 0 |

내부 빈 행(row2) 제거. 빈 행은 끝(row7)으로 — 소스가 7밴드뿐이라 정상. 84/84 캐릭터 전부 보존.

## 게이트
- `npx tsx scripts/test-spritesheet.ts`: 18 PASS / 0 FAIL (A/B feet, C effect-center, D/E chroma, F pocket/halo 회귀 없음). 초기엔 C가 깨졌으나 "내부 빈 행 있을 때만 재배정" 가드로 well-behaved 시트는 기존 경로 유지하도록 수정해 통과.
- `npx tsc --noEmit`: exit 0.
- `npx eslint`: exit 0.

## visual-qa 검증 요청 항목
- kind=spritesheet, 8방향 캐릭터(예: 기사/전사 8-direction walk, rows=8 cols=12). codex 실제 생성으로 후처리 통과 후:
  - 8행 전부 채워지는지(모델이 8밴드 그렸을 때) 또는 빈 행이 끝으로만 가는지(7밴드일 때) 육안 확인.
  - 내부 빈 행 없음, cross-cell 캐릭터 손실 없음, 발 정렬 일관성.
- effect(center 앵커) 스프라이트시트로 회귀 없는지(세로 위치 다양해도 행 재배정 미발동) 확인.

## 남은 리스크
- 표류가 cellH 절반(128px)을 넘어 한 행 내 캐릭터 y-중심이 크게 벌어지면 bandGap 분할이 한 행을 둘로 쪼갤 수 있음. 현 데이터는 밴드 내 spread ~10px로 여유 큼.
- 캐릭터 폭/높이가 행마다 극단적으로 불균일하면 cy(=(minY+maxY)/2) 기반 밴드 경계가 흔들릴 수 있으나, 재배정은 "내부 빈 행" 신호가 있을 때만 발동하므로 평상시엔 영향 없음.
