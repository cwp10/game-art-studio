---
name: visual-integration-qa
description: image-generator 변경을 실제 실행으로 검증할 때 사용. 후처리 변경의 시각 회귀 확인(실제 PNG/스프라이트시트 생성 후 육안 검사), probe/test-spritesheet CLI 게이트, pnpm build/lint 게이트, 그리고 API 응답 shape ↔ React 훅 같은 경계면 교차 비교를 수행. "검증", "QA", "시각 회귀", "게이트 실행", "통합 테스트" 작업에 반드시 사용. visual-qa 에이전트가 사용한다.
---

# Visual & Integration QA

코드 리뷰가 아니라 **실행으로** 검증한다. visual-qa(general-purpose) 에이전트가 사용한다.

## 검증 4종

### 1. 시각 회귀 (후처리 변경 시)
실제 이미지를 생성하고 **Read 도구로 PNG를 직접 본다.** "코드상 맞아 보임"은 통과 근거가 아니다.

```bash
# 단독 1장 (Next 불필요)
pnpm tsx scripts/gen.ts "a red apple, simple illustration"
# 스프라이트시트 전체 파이프라인(생성+resize+chroma+normalize)
node scripts/test-spritesheet.mjs
```
생성물은 `data/images/{generationId}.png`. Read로 열어 확인할 항목:
- 셀 정렬(발 라인·가로 중심), chroma-key 잔여 녹색, **cross-cell 캐릭터 보존**, seamless loop 연속성.

### 2. CLI 게이트
```bash
pnpm probe                              # M0: text→image, imagegen 스킬 자동 발동
node scripts/probe-codex-img2img.mjs    # img2img 전제
node scripts/probe-codex-inpaint.mjs    # 원본+마스크 빨간 영역만 재생성
```

### 3. 빌드/타입/린트 게이트 (풀스택 변경 시)
```bash
pnpm build && pnpm lint
```

### 4. 경계면 교차 비교 (핵심)
"존재 확인"이 아니라 **양쪽을 동시에 읽어 shape 일치**를 본다. 보내는 쪽 필드명·타입 = 받는 쪽 필드명·타입인지:
- MCP `structuredContent`(server.ts) ↔ ImageResultCard / chat-state
- generations.kind enum(schema.sql) ↔ upload·layers의 kindHint
- chat stream-json 이벤트(chat/route) ↔ chat-state reducer
- progress.jsonl stage(server.ts) ↔ tailProgress(chat/route)

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

전부 PASS면 오케스트레이터에 종합 보고, 하나라도 FAIL이면 해당 구현 에이전트에 SendMessage로 되돌린다.
