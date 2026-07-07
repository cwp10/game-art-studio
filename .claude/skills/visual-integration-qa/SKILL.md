---
name: visual-integration-qa
description: image-generator 변경을 실제 실행으로 검증할 때 사용. 후처리 변경의 시각 회귀 확인(실제 PNG/스프라이트시트 생성 후 육안 검사), probe/test-spritesheet CLI 게이트, pnpm build/lint 게이트, 그리고 API 응답 shape ↔ React 훅 같은 경계면 교차 비교를 수행. "검증", "QA", "시각 회귀", "게이트 실행", "통합 테스트" 작업에 반드시 사용. visual-qa 에이전트가 사용한다.
---

# Visual & Integration QA

코드 리뷰가 아니라 **실행으로** 검증한다. visual-qa 에이전트가 사용한다.

## 검증 4종

### 1. 시각 회귀 (후처리 변경 시)
실제 이미지를 생성하고 **Read 도구로 PNG를 직접 본다.** "코드상 맞아 보임"은 통과 근거가 아니다.

```bash
# 단독 1장 (Next 불필요, ImageBackend 직접 호출 — decorated 프롬프트는 우회)
pnpm tsx scripts/gen.ts "a red apple, simple illustration"
# 진짜 MCP 서버를 spawn — decorated 프롬프트(가드 포함)+후처리 전체를 태우는 유일한 충실 실생성 검증
node scripts/qa-mcp-spritesheet.mjs "<prompt>" <rows> <cols> [subjectType] [directions]
```
생성물은 `data/images/{generationId}.png`. Read로 열어 확인할 항목:
- 셀 정렬(발 라인·가로 중심), chroma-key 잔여 녹색, **cross-cell 캐릭터 보존**, seamless loop 연속성.

### 2. CLI 게이트

**단위 테스트 (codex 없이 빠름 — 스프라이트 로직 변경 시 먼저 실행):**
```bash
pnpm test                              # test-classify + test-directions + test-sprite-marker 일괄
pnpm tsx scripts/test-directions.ts    # directionLabels/buildDirectionPrompt 검증
pnpm tsx scripts/test-classify.ts      # inferSubjectType/classifyAnchor/isLocomotion 검증
pnpm tsx scripts/test-sprite-marker.ts # buildSpriteMessage 마커 직렬화 검증
```

**후처리 스모크 (codex 없이 — 합성 시트로 정량 단언):**
```bash
pnpm test:post                         # test-spritesheet(chromaKey/normalize) + smoke-composite-transform(runComposite 알파 보존)
node scripts/measure-gait-diff.mjs <png> <rows> <cols>  # 인접 프레임 하단 1/3 실루엣 diff — near-duplicate 포즈 정량 탐지
```

**생성 probe (codex 호출 — 구독 한도 내, kind당 1장):**
```bash
pnpm probe                                  # text→image, imagegen 스킬 자동 발동
node scripts/probe-codex-img2img.mjs        # img2img 전제
node scripts/probe-codex-inpaint.mjs        # 원본+마스크 빨간 영역만 재생성
```

**달리기·방향 회귀 (codex 실생성 — 비쌈, 관련 로직 변경 시에만):**
```bash
pnpm tsx scripts/test-8dir-run.ts      # 8방향 달리기 시트 — 방향당 1회 호출 후 스티칭
pnpm tsx scripts/test-diagonal-run.ts  # 대각선 4방향만 재생성
pnpm tsx scripts/test-r-half.ts        # R-CONTACT 절반(프레임 5~8) 단독 생성 검증
```

### 3. 빌드/타입/린트 게이트 (풀스택 변경 시)
```bash
pnpm build && pnpm lint
```

### 4. 경계면 교차 비교 (핵심)
"존재 확인"이 아니라 **양쪽을 동시에 읽어 shape 일치**를 본다. 보내는 쪽 필드명·타입 = 받는 쪽 필드명·타입인지:
- MCP `structuredContent`(handlers/shared.ts의 `ToolResponse`) ↔ ImageResultCard / chat-state
- generations.kind enum(schema.sql) ↔ upload·layers의 kindHint
- chat stream-json 이벤트(chat/route) ↔ chat-state reducer
- progress.jsonl stage(handlers/shared.ts `runImageTool`) ↔ tailProgress(chat/route)

## 작업 원칙

- **점진적 검증.** 각 모듈 완성 직후 검증한다. 전체 끝나고 1회가 아니다.
- **구독 한도 절약.** codex/claude는 구독 한도 내 동작 → 생성 검증은 kind당 1장, 최소 횟수.
- **거짓 통과 금지.** FAIL이면 게이트 출력 로그를 그대로 인용하고, 원인 후보 파일·줄을 구현 에이전트에 되돌린다.
- dev 서버가 필요하면 `pnpm dev`(127.0.0.1:3000) 기동. 로그: `data/logs/`(codex-*.log, mcp-server.log).

## 출력 형식

```
[검증 항목] PASS/FAIL
- 근거: (관찰한 이미지 / 인용한 로그 / shape 비교 결과)
- FAIL 시: 원인 후보 = path:line, 재현 = (명령/프롬프트)
```

전부 PASS면 오케스트레이터에 종합 보고, 하나라도 FAIL이면 `_workspace/` QA 결과 파일에 FAIL 근거·원인 후보를 기록한다. 오케스트레이터가 이 결과를 읽어 해당 구현 에이전트를 재스폰한다.
