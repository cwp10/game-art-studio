# 스프라이트시트 생성측 셀 최소크기 보장 (2026-05-29)

## 변경 파일
- `src/lib/mcp/server.ts` (make_spritesheet, cellH/cellW 계산식 + 주석)

## 핵심 조사 결과 (근거)
- codex 백엔드 = OpenAI 빌트인 `image_gen`(gpt-image-2). 네이티브 출력 크기는 **1024×1024 / 1024×1536 / 1536×1024 고정** — 장축 **1536px 가 모델 실제 출력 상한**.
  - 근거: `data/logs/codex-*.log` 의 `pixelWidth: 1536 / pixelHeight: 1024`, 그리고 비-스프라이트(강제 리사이즈 없는) 기존 출력들이 모두 1024·1536 계열.
  - 로그 size 파라미터 빈도: 1024x1024 / 1024x1536 / 1536x1024 만 등장. 2048 이상 없음.
- `server.ts:575` 후처리가 codex 출력을 **무조건 canvasW×canvasH 로 fit:"fill" 리사이즈**. 따라서 선언 캔버스 크기는 모델 디테일이 아니라 **다운스트림(chroma/normalize/export) 작업 픽셀량**만 좌우한다.
- 결론: 캔버스 상수를 키워도 모델은 1536 안에서만 그린다. 8×12(장축 12셀)는 모델 실효 셀 ≈1536/12≈128px 가 하드 캡. **(1) 만으로 8×12 모델측 혼잡은 못 푼다 — (2) 행분할 생성이 진짜 해법.**

## 수정 (before → after)
```
const cellH = rows === 1 ? 768 : Math.min(512, Math.floor(2048 / Math.max(rows, cols)));
↓
const MIN_CELL = 256;
const cellH = rows === 1 ? 768 : Math.max(MIN_CELL, Math.min(512, Math.floor(2048 / Math.max(rows, cols))));
```
- 8×12: cell 170 → **256**, canvas 2040×1360 → **3072×2048**
- 4×4: 512(불변), 8×8: 256, 8×16: 256(canvas 4096×2048)
- rows=1 분기 불변(요청대로).
- 후처리 호출 계약 불변 — normalize 가 rows/cols 로 cellW/cellH 자체 재계산.

## tsc/lint
- `npx tsc --noEmit` → exit 0
- `npx eslint src/lib/mcp/server.ts` → exit 0

## (2) 필요성 판단
**필요함.** (1)은 다운스트림 작업 해상도만 올린다(후처리·export 품질엔 도움). 그러나 모델 1536 캡 때문에 8×12 셀 침범/닿음의 *생성측 원인*은 (1)로 못 푼다. 다음 단계로 방향(행)단위 분할 생성(rows당 1536 폭 풀 사용 → 행별 12셀 각 ~128 대신 행 1개만 그려 셀 ~1536/12 동일하지만 행을 1024 세로 풀사용) 또는 directions 를 2~4행씩 나눠 여러 번 생성 후 병합이 유효. 단 생성 횟수 증가 → 사용자 한도 영향, 별도 승인 필요.

## 실제 생성 검증 (완료)
- `node scripts/qa-mcp-spritesheet.mjs "armored knight..." 8 12 character 8` → gen=210f199cvvklel1d, 3072×2048, 185s, exit 0.
- 파일: `data/images/210f199cvvklel1d.png` (crop: /tmp/knight_crop.png).
- 육안 소견: 각 기사가 셀 안에 완전히 수용·서로 닿지 않음·셀 경계 침범 없음·크로마키 깨끗. 170px 셀 대비 명확히 개선. 빈 셀(대형 검은 구멍) 없음. (normalize 로그 "78 non-empty"는 인접 셀 안티앨리어싱 fringe 컴포넌트 병합 카운트일 뿐, 시각상 96셀 모두 채워짐.)

## visual-qa 검증 항목
- kind=spritesheet, directions=8, cols=12, subjectType=character, prompt="armored knight...".
- 육안 확인: 셀 침범/인접 캐릭터 닿음/빈 셀(라벨 병합)/잘림이 이전 대비 줄었는지.
- 재현: `node scripts/qa-mcp-spritesheet.mjs "armored knight with sword and shield and red cape, walking" 8 12 character 8`
