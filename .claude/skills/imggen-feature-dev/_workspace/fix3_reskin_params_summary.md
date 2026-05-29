# Fix 3: reskin 시트 sprite params 영속

## 변경 위치
- `src/lib/mcp/server.ts` `reskin_image` 핸들러
  - `~694행`: `inheritedSheetParams` 추출 블록 추가 (isSheet 일 때 부모 `inputGen.params` 에서 sprite 그리드 메타 추출, 아니면 `{}`).
  - `~726행`: runImageTool `params` 객체 맨 앞에 `...inheritedSheetParams` 스프레드 병합 (기존 mode/styleReferenceId/spritesheet 키 유지).

## 상속하는 sprite 메타
`subjectType, anchorStrategy, anchor, directions, rows, cols, cellW, cellH, fps`
- 부모(`inputGen.params`)에서 그대로 복사. reskin 은 입력 시트 치수를 보존하므로 재계산 없이 상속으로 충분.

## params shape 변화

### 변경 전 (reskin 시트 저장)
```json
{ "mode": "...", "styleReferenceId": "...", "spritesheet": true }
```

### 변경 후 (부모가 sprite params 보유한 시트)
```json
{
  "subjectType": "character", "anchorStrategy": "...", "anchor": { "x": 0, "y": 0 },
  "directions": 8, "rows": 2, "cols": 4, "cellW": 128, "cellH": 128, "fps": 12,
  "mode": "...", "styleReferenceId": "...", "spritesheet": true
}
```

## 구버전 폴백
- 부모 시트가 sprite params 를 갖지 않은 구버전이면 추출 값들이 전부 `undefined`.
- `JSON.stringify`(영속 직렬화) 시 undefined 키는 자동 제외 → 저장 안 됨.
- 이 경우 SpriteCanvas 는 기존처럼 GCD 폴백 사용. **회귀 없음.**

## 단일 이미지 reskin
- `isSheet === false` → `parentSheet = null` → `inheritedSheetParams = {}`.
- params 는 기존과 동일 (`mode/styleReferenceId/spritesheet`). 회귀 없음.

## 후처리
- normalize/chroma-key/정렬 등 시트 후처리 로직은 손대지 않음 (기존 부모 subjectType 상속 정렬 유지).
- 이번 변경은 **영속 params 만** 보강.

## 셀프 게이트 (전부 통과)
- `npx tsc --noEmit` ✅
- `pnpm lint` ✅
- `pnpm build` ✅
- `scripts/test-spritesheet.ts` 18/18 ✅
- `scripts/test-classify.ts` 34/34 ✅
- `scripts/test-directions.ts` 42/42 ✅

## fullstack-engineer 통지 필요?
- structuredContent shape 미변경 (generationId 그대로). 입력 스키마 미변경.
- 영속 `params` 가 sprite 메타를 추가로 담게 되나, 이는 make_spritesheet 가 이미 쓰는 동일 shape → SpriteCanvas/atlas export 가 이미 소비. **신규 계약 변경 없음** → 별도 통지 불요.

## visual-qa 검증 필요?
- 후처리 픽셀 로직 미변경, 결정적 params 병합만 → **시각 회귀 없음**. codex 실생성 불필요.
- (선택) reskin 한 시트를 SpriteCanvas 로 열어 anchor/directions/subjectType 가 GCD 폴백 대신 부모 값으로 채워지는지, .json atlas export 가 채워지는지 기능 확인 권장.
