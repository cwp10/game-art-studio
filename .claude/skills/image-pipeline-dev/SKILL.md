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
- `src/lib/mcp/server.ts` — 도구 7종, `make_spritesheet` 후처리 파이프라인, `normalizeSpritesheetCells()`

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

1. 도구 입력 스키마나 `structuredContent` shape을 바꿨다면 → **fullstack-engineer에 통지**(API/UI가 의존).
2. 후처리 로직을 바꿨다면 → **visual-qa에 검증 요청**. 코드 리뷰로는 시각 회귀를 못 잡는다. 검증 항목을 명시:
   - 어떤 kind/프롬프트/프레임수로 생성할지
   - 무엇을 눈으로 볼지 (셀 정렬, chroma 잔여, cross-cell 보존, loop 연속성)
3. 로그 위치: `data/logs/codex-{jobId}.log`, `data/logs/mcp-server.log`.

## 디버깅 진입점

- 생성이 안 나옴 → codex 로그에서 imagegen 스킬 발동 여부, output.png 생성 여부 확인.
- 셀이 어긋남 → 배수 리사이즈 정수 분할 여부 먼저 확인.
- 캐릭터가 잘림 → 글로벌 라벨링 전에 셀 자르기를 하지 않았는지 확인.
