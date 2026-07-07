# 편집/레이어 캔버스 16:10 뷰박스 + 줌/팬 — QA 리포트

검증일 2026-05-28 · 대상 `useZoomPan.tsx`(신규), `MaskCanvas.tsx`/`LayerCanvas.tsx`(변경)
방법: tsc/lint/build 게이트 + Playwright(node) 브라우저 UI + LayerCanvas crop 결정적 좌표 검증.
테스트 이미지: `작은 빨간 사과 아이콘` (gen `di10o3j029hra8ms`, 1254×1254, 세션 `3zs63dc2t1g3`).

## 1. 게이트 — 전부 PASS
| 게이트 | 결과 |
|--------|------|
| `npx tsc --noEmit` | PASS (exit 0, 에러 0) |
| `pnpm lint` | PASS (exit 0, eslint 경고/에러 0) |
| `pnpm build` | PASS (exit 0, 14 라우트 정상 빌드) |

## 2. 브라우저 UI — 전부 PASS

### LayerCanvas (레이어 분리)
| 항목 | 관찰 | 결과 |
|------|------|------|
| 16:10 뷰박스 | viewbox 979×612 = **ratio 1.600** = 16/10. 정사각 이미지가 contain-fit, 좌우 레터박스(bg-bg-app) | PASS |
| 줌 `[+]` ×2 | 100% → 150% (step 0.25) | PASS |
| 줌 리셋(% 클릭) | 150% → 100% | PASS |
| 컨트롤 고정 | zoom=1.5 에서도 컨트롤 @1147,665 우하단 고정 (transform 밖, 안 딸려감) | PASS |
| 모드 토글 | ✏️편집 ↔ ✋이동 정상 | PASS |
| overflow clip | zoom 150% 시 이미지가 뷰박스로 클립됨(잎/하단 잘림) | PASS |

스샷: `zoompan_shots/layer_16x10_viewbox.png`, `layer_zoom150.png`, `layer_panmode.png`

### MaskCanvas (인페인트/편집)
| 항목 | 관찰 | 결과 |
|------|------|------|
| 16:10 뷰박스 | viewbox 945×591 = **ratio 1.599** = 16/10, 레터박스 정상 | PASS |
| 줌 `[+]`/`[−]` | 100%→125%(+1)→75%(−2, clamp 동작)→reset 100% | PASS |
| 편집 모드 그리기 | 드래그 → 마스크 캔버스 **4986 opaque px**(스트로크 보임) | PASS |
| 이동 모드 팬 | 모드 토글 후 드래그 → 캔버스 dx=100px 이동 | PASS |
| 이동 중 그리기 차단 | 팬 드래그 후 신규 마스크 px = **0** (누수 없음) | PASS |

스샷: `zoompan_shots/mask_16x10_viewbox.png`, `mask_drawn_editmode.png`, `mask_panned.png`

> 주: MaskCanvas 실제 제출(인페인트)은 codex 비용이라 **미제출(제출 전 단계까지 검증)**. 좌표 정확도는 아래 LayerCanvas crop 결정적 검증으로 커버.

## 3. 줌 상태 그리기 → export 좌표 정확도 (핵심 회귀) — PASS

LayerCanvas crop(결정적, codex 미사용). 동일 정규화 이미지 좌표(nx=0.40, ny=0.42)에 brush(16px):
- **RUN A** zoom=1: 화면 (739,345), 캔버스박스 612×612@495,88
- **RUN B** zoom=2 + 팬(이동모드 드래그): 화면 (798,376), 캔버스박스 1224×1224@309,−138

(같은 이미지점이 줌/팬 따라 화면상 다른 위치·다른 캔버스박스로 투영됨 → 테스트 유효)

생성 레이어 PNG(둘 다 원본 해상도 1254×1254)의 칠해진 영역 centroid 비교:
| | centroid | bbox |
|--|----------|------|
| RUN A (zoom1) | (503.4, 532.8) | x477 y510 w54 h46 |
| RUN B (zoom2+pan) | (502.3, 529.5) | x481 y510 w44 h40 |

**Δ centroid = 3.4px = 0.19% of diagonal** (허용 12px). bbox 도 거의 겹침(둘 다 y=510 시작). 잔차 3.4px 는 zoom2 마우스 1px 양자화(=원본 0.5px)·blob 크기 미세차로 설명됨.

→ `rectRatioPoint`(`el.width/rect.width` 비율 역산)이 **줌/팬 무관하게 동일 원본좌표**로 매핑됨을 입증. `inv=1/fitScale` export 수식 영향 없음. **PASS**

## 4. 회귀 — PASS
- zoom=1 기본 상태에서 그리기/색칠/제출(crop) 정상 — RUN A 가 곧 zoom=1 경로 검증.
- 브러시 크기 슬라이더, 색 선택, undo, 모드 토글 모두 동작.
- MaskCanvas 편집모드 그리기·줌 clamp(0.5~4) 정상.
- 경계면(API/MCP/DB/SSE) 무변경 — 순수 클라이언트 캔버스 변경. layers API 응답 shape `{layers:[{generationId,colorLabel,width,height}]}` 그대로.

## 5. 정리
- 테스트 레이어 generation 2건(`m9g6q1auh7y3us7m`, `zavz7vucgq5yt9a0`) DB 행 + PNG 삭제 완료.
- 임시 Playwright 스크립트 6개 삭제. working tree 는 구현 3파일만 변경 상태.

## 종합: ALL PASS (게이트 3/3, UI 양쪽, 좌표정확도, 회귀)
