# 스프라이트시트 "중앙 세로 빈 열" — col 적응형 할당 (행 로직 대칭 확장)

## 변경 파일
- `src/lib/image-backend/spritesheet-postprocess.ts` — step4 에 col 적응형(4c) 추가. `Comp` 타입에 `cx` 필드 추가.
- `src/lib/mcp/server.ts` — 변경 없음(MIN_CELL + rowCountRule 만 유지). 임시 SS_DEBUG_STAGES 백업은 추가했다가 검증 후 제거 완료.

## col 적응형 로직 (4c)
- 행(4a/4b)과 대칭: "유의미 컴포넌트(셀 면적 1%↑) 사이에 낀 빈 그리드 열" 이 있을 때만 발동(가드).
- **행그룹 내 독립 정렬** 채택. 근거: 캐릭터는 행마다 x정렬이 다름(망토/자세). 전역 x중심으로 묶으면 행별 갭 위치 차이가 서로 메워져 빈 열을 가림(실측: 시트-전역 프로파일 12밴드처럼 보이나 행별로는 11밴드+중앙갭).
- 갭 임계 `cellW*0.5`(행의 cellH*0.5 대칭). 인접 캐릭터 x중심 간격 ~cellW 라 항상 초과 → 캐릭터마다 개별 밴드. 중앙 슈퍼갭 오분할 없음.
- 밴드<cols → 끝 열을 빈 채로(억지 채움 금지), >cols → 클램프.

## 핵심 결론 (stage0_raw 측정)
- 실제 생성 `qfd26c9fwip83bdj` 의 raw 모델 출력(3072x2048): **행당 11개만 그림**(8행 중 7행이 11밴드, row4 만 12). 빈 그리드 열 위치가 행마다 다름(col 5/6/7).
- → col 적응형은 중앙 구멍을 제거(11개를 col 0-10 에 연속 배치, col 11 끝 빈칸)하나 **없는 12번째 캐릭터는 생성 불가**. 7행은 정당하게 11프레임.
- **추가 필요: 프롬프트 열-개수 강조**(rowCountRule 의 col 버전). 후처리만으로는 12개 채울 수 없음.

## 검증 결과
- 합성 테스트 18/18 PASS(effect center 회귀 없음).
- 스냅샷 회귀 `r52yy...stage1_chroma`(7행 12열 정상): col 적응형 오발동 없음, 12열 유지.
- 실제 모델 출력에 충실한 프로덕션 파이프라인(resize→chroma→normalize) 적용: 최종 PNG 행밴드 8, 행별 11/11 연속(중앙 갭 제거), 끝 열 빈칸. 육안 확인.
- tsc clean, eslint clean.

## QA 스냅샷 경로 (사용자 확인용)
- `data/tmp/col-adaptive-qa/01_raw_model_output_green.png` — 모델 raw(녹색 배경, 11/행 + 중앙갭 육안 확인)
- `data/tmp/col-adaptive-qa/02_final_coladaptive.png` — 최종 후처리(중앙갭 제거, 11열 연속 + 끝 빈칸)
- 기존 참조: `data/images/r52yy9mpk0yzo83d.png.stage1_chroma.png`(회귀 기준), `data/images/xujqa4yjz395b8es.png`(원래 문제 시트)

## 남은 리스크
- 12열 클러스터 robustness: row4 는 raw 에서 12개였으나 chroma 후 11로 측정 — 인접 캐릭터(망토 접촉)가 한 컴포넌트로 병합됐을 가능성. cross-cell keep 이 보존하나 셀 할당 시 1개로 셈.
- 망토 펼침/넓은 무기 스윙으로 x중심 흔들리면 colGap(cellW*0.5) 근처에서 밴드 분할이 흔들릴 수 있음(현재 데이터에선 안정).
- 근본 원인(모델 11개 생성)은 프롬프트 측 col-count rule 추가로만 해결 가능.
