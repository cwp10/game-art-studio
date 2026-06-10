---
name: image-pipeline-dev
description: image-generator의 이미지 생성 파이프라인(codex CLI spawn, sharp 후처리, chroma-key, 스프라이트시트 cell normalize)을 구현·수정·디버깅할 때 사용. src/lib/image-backend/, src/lib/mcp/server.ts의 생성·후처리 로직을 다루거나, 스프라이트시트 셀 정렬/배경 투명화/seamless loop/그리드 템플릿을 손볼 때 반드시 사용. "후처리", "chroma-key", "cell 정렬", "codex 프롬프트", "스프라이트시트 생성 버그" 등의 작업에 적용.
---

# Image Pipeline Dev

이미지 생성 파이프라인을 안전하게 수정하기 위한 가이드. pipeline-engineer가 사용한다.

## 파이프라인 지도

```
MCP 도구(server.ts) → runImageTool() → selectImageBackend().execute()
                                         → CodexExecBackend (codex-exec.ts)
                                            → codex exec spawn → output.png
                                            → sharp 후처리 → data/images/{genId}.png
```

핵심 파일:
- `src/lib/image-backend/index.ts` — `ImageBackend` 인터페이스, `ImageJob`/`ImageResult`/`ProgressCallback` 타입
- `src/lib/image-backend/codex-exec.ts` — spawn 인자, `buildNaturalPrompt()`, stage 추론, output 회수, chroma-key
- `src/lib/mcp/server.ts` — 도구 라우팅 + 공통 생성 처리
- `src/lib/mcp/handlers/spritesheet-handler.ts` — `make_spritesheet` 전체 흐름 (facing 결정, 그리드 검증, 다방향 stitch)
- `src/lib/mcp/spritesheet-classify.ts` — 순수 함수 모듈: `inferSubjectType`, `classifyAnchor`, `isLocomotion`, `isRunning`, `directionLabels`, `buildDirectionPrompt`

## 스프라이트 프롬프트 계층 — 깨지기 쉬운 불변식

최근 커밋 중 약 절반이 스프라이트 facing/direction 버그였다. 수정 시 아래 불변식을 먼저 확인한다.

### facing 이중 제약 (SpriteGenPanel + spritesheet-handler)

방향 명시 시 **directive 와 자연어 양쪽에** 반드시 넣는다. 한쪽만 넣으면 LLM이 다방향으로 생성하거나 방향 문구가 서로 모순된다.

- directive: `[spritesheet: ...; facing=DOWN; ...]`
- 자연어: `SINGLE DIRECTION ONLY — facing DOWN (front view). Every frame must face this same direction. Do NOT include mirrored, opposite, or any other facing variants`

`SpriteGenPanel.tsx`의 `buildSpriteMessage`가 이 두 부분을 동시에 생성한다. 한쪽만 수정하면 모순 발생.

### facing 결정 우선순위 (spritesheet-handler.ts)

1. **UI 명시 (args.facing)** — 8방향 enum 범위 내 값이면 무조건 우선
2. **참조 이미지 방향 감지 (analyzeRefFacing)** — facing 미지정이고 directions=1일 때만 폴백
3. **null** — 지정 안 됨, 오케스트레이터가 방향을 결정

NL(자연어)에서 방향을 파싱하는 로직은 없다. 방향은 파라미터로만 전달된다.

### 다방향 시트 = 방향별 별도 codex 호출 (spritesheet-handler.ts)

`directions > 1` 이면 방향당 1번씩 codex를 호출하고 결과를 스티칭한다 — 단일 호출로 4방향을 그리지 않는다. 이유: 단일 호출은 24포즈를 한 번에 그려야 하므로 각 방향 품질이 희석된다.

```
directions=4 → ["DOWN","LEFT","RIGHT","UP"] 각각 codex 호출 → sharp로 행 stitch
```

`directions=1`이면 rows는 레이아웃 행 수 그대로 유지(강제 리셋 없음).

### subjectType / anchor 분류 (`spritesheet-classify.ts`)

`inferSubjectType(prompt, hasRef)` 가 `character | effect | object`를 결정한다:
- 참조 이미지 있으면 항상 `character`
- 캐릭터 키워드(캐릭터/기사/walk 등) 있으면 `character`
- VFX 키워드만 있으면 `effect`
- 오브젝트 키워드만 있으면 `object`
- 모호하면 `character` (보수적)

`effect`면 anchorStrategy=center(바닥 앵커 제거), 나머지는 feet.

### 보행(gait) 프롬프트 주입 (`spritesheet-classify.ts`)

`isLocomotion(prompt)` 이 참이면 gait 지시문이 주입된다. 변경 시 확인:
- `buildDirectionPrompt`는 다방향 시트에서만 사용(단일 방향엔 빈 문자열)
- gait 지시문과 loop 지시문은 중복되지 않아야 함 (서로 다른 관심사)

## codex spawn 규칙 (codex-exec.ts)

- 워크디렉토리 `data/tmp/job-{id}/`에 입력을 `input{i}.png`로 복사한 뒤 그 안에서 실행.
- 인자: `codex exec --cd {workDir} --sandbox workspace-write --skip-git-repo-check [-i input...] -- "{naturalPrompt}"`.
- **`--` 종료자는 필수.** `-i`가 multi-value라 종료자가 없으면 positional prompt를 삼킨다.
- PROMPT_HEADER로 "imagegen 스킬 사용 + `./output.png`만 생성"을 강제한다. 출력 회수는 `output.png` → 없으면 최신 `.png`.
- 진행 단계는 stdout/stderr 라인 파싱으로 추론(`inferStage`). 새 stage를 추가하면 UI 진행 표시(progress.jsonl 소비측)와 일관되게.

## sharp 후처리 — 깨지기 쉬운 불변식

최근 커밋 #26~#30이 전부 이 영역의 회귀였다. 수정 시 다음 불변식을 깨지 않았는지 self-check 한다:

1. **정확 배수 리사이즈 먼저.** 셀 크기 = 캔버스 / (rows·cols)가 정수로 나누어떨어지도록 sharp로 강제 리사이즈한 뒤에야 셀 단위 연산을 한다. 안 그러면 cell residue drift(#29).
2. **글로벌 connected-component 우선.** `normalizeSpritesheetCells()`는 시트 전체를 4-connectivity로 라벨링한 뒤 각 컴포넌트를 **픽셀 최다 셀에 통째로** 배치한다. 셀 경계로 먼저 자르면 cross-cell 캐릭터가 잘린다(#30). 셀별 처리는 그 다음이다.
3. **chroma-key는 greenness feather 방식.** 단순 `==#00ff00` 비교가 아니라 greenness 기반 부드러운 알파. spill 제거(#26)를 함께 본다.
4. **셀 정렬은 shape-aware.** 행별 픽셀 분포로 발 라인/가로 중심을 추정해 하단·중앙 정렬. 재스케일하지 않는다(#26: no rescale).

배경 결정 우선순위: 명시 키워드 > 참조 이미지 상속(`detectTransparentBg` 꼭짓점 샘플링) > 기본 투명(#00ff00 chroma-key 경유).

## codex vs sharp 경계

- **결정적 작업은 sharp:** resize_image(lanczos), 흰 배경 투명화, 셀 정렬. codex 호출 없음.
- **생성/재해석은 codex:** generate/edit/upscale/inpaint, 그리고 generate성 remove_bg.
- 둘을 한 도구 안에서 섞지 않는다 — 이 분리가 결정성과 구독 한도 절약의 근거다.

## 변경 후 필수 절차

1. 도구 입력 스키마나 `structuredContent` shape을 바꿨다면 → `_workspace/` 요약에 변경 내역 명시. 오케스트레이터가 fullstack-engineer에 전달한다.
2. 후처리 로직을 바꿨다면 → `_workspace/` 요약에 visual-qa 검증 항목 명시:
   - 어떤 kind/프롬프트/프레임수로 생성할지
   - 무엇을 눈으로 볼지 (셀 정렬, chroma 잔여, cross-cell 보존, loop 연속성)
3. 스프라이트 프롬프트/facing 로직을 바꿨다면 → `scripts/test-directions.ts`, `scripts/test-classify.ts`, `scripts/test-sprite-marker.ts` 단위 테스트를 먼저 돌린다(codex 불필요, 빠름).
4. 로그 위치: `data/logs/codex-{jobId}.log`, `data/logs/mcp-server.log`.

## 디버깅 진입점

- 생성이 안 나옴 → codex 로그에서 imagegen 스킬 발동 여부, output.png 생성 여부 확인.
- 셀이 어긋남 → 배수 리사이즈 정수 분할 여부 먼저 확인.
- 캐릭터가 잘림 → 글로벌 라벨링 전에 셀 자르기를 하지 않았는지 확인.
