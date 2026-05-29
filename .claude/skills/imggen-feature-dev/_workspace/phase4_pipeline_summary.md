# Phase 4 슬라이스: 참조 이미지 녹색 우세 자동 감지 → 마젠타 키 (pipeline)

## 목적
chroma-key 기본은 green(#00ff00) 키아웃. 참조 캐릭터 본체가 녹색(녹색 슬라임 등)이면
본체가 같이 키아웃되므로, **참조 이미지 색을 분석해 녹색 우세면 magenta(#ff00ff) 키로
자동 폴백**. 사용자가 "green" 키워드를 안 써도 작동. 기존 키워드 폴백(Phase 1)과 OR 결합.

## 작업 1: isGreenDominant 헬퍼 (순수)
- 파일: `src/lib/image-backend/spritesheet-postprocess.ts` (chromaKeyFile 직후, resolveAnchor 직전)
- 시그니처: `export async function isGreenDominant(filePath: string, log?: Logger): Promise<boolean>`
- 동작:
  - sharp 로 폭 256 다운샘플(`fit:"inside", withoutEnlargement:true`) → raw RGBA.
  - 콘텐츠 픽셀: 알파 있으면 `alpha>10`, 없으면 흰 배경 제외(`!(r>240&&g>240&&b>240)`).
  - 녹색 픽셀 판정식: `g - max(r,b) > 40 && g > 90`.
  - 콘텐츠 대비 녹색 비율 `ratio = green/content >= 0.35` → true. (보수적: 35% 미만 false.)
  - 빈/투명(content==0) → false. 결정적·side-effect 없음. 로깅 optional.
- WHY 주석 4줄(판정식·임계·보수성·다운샘플 근거) 추가.

## 작업 2: 핸들러 wiring (server.ts)
- import: `isGreenDominant` 를 spritesheet-postprocess import 블록에 추가 (~38행).
- make_spritesheet 핸들러 chromaKeyColor 결정부 (~395~412행):
  ```
  let refIsGreen = false;
  if (refId) {
    const rg = getGeneration(refId);
    if (rg) {
      try { refIsGreen = await isGreenDominant(path.join(DATA_DIR, rg.image_path), log); }
      catch { /* 분석 실패 시 키워드 경로 유지 */ }
      if (refIsGreen) log(`make_spritesheet: ref ${refId} green-dominant → magenta key`);
    }
  }
  const chromaKeyColor: ChromaKeyColor = greenSubject || refIsGreen ? "magenta" : "green";
  ```
- 기존 greenSubject(키워드) 동작 보존 — OR 결합만. getGeneration 별도 호출(과리팩터 회피).
  이 chromaKeyColor 가 bgInstruction(마젠타/녹색 배경 지시) + chromaKeyFile 후처리에 그대로 전파.

## 합성 검증 결과 (임시 스크립트, 정리 완료)
| 케이스 | 기대 | 실제 | ratio |
|--------|------|------|-------|
| 녹색 슬라임(투명 bg, 본체 전부 녹색) | true | true | 1.000 |
| 파랑 캐릭터(투명 bg) | false | false | 0.000 |
| 녹색 악센트 ~15%(회색 본체) | false | false | 0.160 |
| 빈/완전 투명 | false | false | (content=0) |
| 흰 배경+녹색 본체(불투명) | (n/a) | false | 0.250 |

마지막 케이스 주의: alpha-first 정책상 **불투명 흰 배경은 콘텐츠로 카운트**되어 녹색 비율이
희석됨(설계대로). 본 파이프라인 참조는 대부분 투명/chroma-key 게임 에셋이라 알파로 본체가
구분됨. 흰 배경 참조의 녹색 본체는 키워드 폴백(greenSubject)이 보완.

## 셀프 게이트 (전부 통과)
- `npx tsc --noEmit` → exit 0
- `pnpm lint` (eslint) → 에러 0
- `pnpm build` → ✓ Compiled successfully, exit 0
- `scripts/test-spritesheet.ts` → 18 PASS / 0 FAIL
- `scripts/test-classify.ts` → 34 PASS / 0 FAIL
- `scripts/test-directions.ts` → 42 PASS / 0 FAIL
- codex 실생성 없음(합성 PNG만).

## 회귀
- chromaKeyFile / normalizeSpritesheetCells / 셀 보존 불변식 미변경 (헬퍼 추가만, 호출부 OR 1개).
- 기존 키워드 녹색 폴백 동작 그대로. refId 없으면 refIsGreen=false → 기존 경로 동일.
- 도구 입력 스키마·structuredContent shape 변경 없음 → fullstack-engineer 통지 불필요.

## visual-qa 체크리스트
1. **녹색 슬라임 참조 → 시트 생성 (키워드 없이)**: 녹색 슬라임 1장을 먼저 generate,
   그 generation id 를 inputGenerationId(refId)로 make_spritesheet 호출하되 프롬프트에는
   "green/슬라임" 등 녹색 키워드를 **넣지 않는다**(예: "idle animation, 4 frames").
   - 확인: mcp-server.log 에 `ref ... green-dominant → magenta key` 로그.
   - 확인: 생성 시트에서 **슬라임 본체가 키아웃되지 않고 보존**(투명 배경, 본체 녹색 유지).
2. **비녹색 참조 회귀 무영향**: 파랑/회색 캐릭터 참조로 동일 흐름 → green 키 유지, 정상 투명화.
3. **키워드 경로 보존**: 참조 없이 프롬프트 "녹색 슬라임 idle" → 기존대로 magenta 키.
4. cross-cell 보존·셀 정렬·chroma 잔여는 기존 불변식대로(이 변경이 후처리 알고리즘 자체는
   안 건드림 — 키 색 선택만 영향).
