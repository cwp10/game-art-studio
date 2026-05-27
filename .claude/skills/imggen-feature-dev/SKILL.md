---
name: imggen-feature-dev
description: image-generator 프로젝트에서 기능 개발·버그 수정·리팩터링을 조율하는 오케스트레이터. 이미지 파이프라인(codex/sharp/스프라이트시트 후처리), 풀스택 경계면(Next API/MCP/DB/React), 시각·통합 검증을 가로지르는 작업을 받으면 사용. "기능 추가", "버그 수정", "이미지 생성/편집/스프라이트시트 작업", "API/UI/DB 변경", 그리고 후속 표현인 "다시 실행", "재실행", "업데이트", "수정", "보완", "이전 결과 개선", "X 부분만 다시"에도 적용. 단순 단일 파일 질문이나 설명 요청은 직접 응답 가능.
---

# image-generator 기능 개발 오케스트레이터

요청을 영역별로 분해하고, 전문 에이전트 팀으로 구현·검증을 조율한다.

**실행 모드:** 에이전트 팀 (생성-검증 + 전문가 풀 하이브리드). 모든 Agent/팀원 호출은 `model: "opus"`.

**팀 구성:**
| 에이전트 | 타입 | 담당 |
|---------|------|------|
| pipeline-engineer | general-purpose | image-backend, mcp/server.ts 후처리 (codex spawn, sharp, chroma-key, cell normalize) |
| fullstack-engineer | general-purpose | Next API, MCP 스키마, DB repo/schema, SSE, React |
| visual-qa | general-purpose | 시각 회귀, probe/test-spritesheet/build/lint 게이트, 경계면 교차 비교 |

오케스트레이터(이 스킬을 실행하는 메인)가 분배자·통합자 역할을 직접 맡는다. 별도 planner 에이전트는 두지 않는다.

## Phase 0: 컨텍스트 확인

워크플로우 시작 시 `_workspace/` 존재 여부로 실행 모드를 판별한다:
- `_workspace/` 없음 → **초기 실행**
- `_workspace/` 있음 + 사용자가 부분 수정 요청 → **부분 재실행** (해당 영역 에이전트만 재호출, 이전 요약 전달)
- `_workspace/` 있음 + 새 입력 → **새 실행** (기존 `_workspace/`를 `_workspace_prev/`로 이동 후 시작)

## Phase 1: 요청 분해 및 영역 판별

요청을 다음 축으로 분류한다:
- **이미지 파이프라인 영역**(후처리/codex/스프라이트시트) → pipeline-engineer
- **풀스택 경계면 영역**(API/MCP스키마/DB/React/SSE) → fullstack-engineer
- **양쪽 걸침**(예: 새 MCP 도구 = 후처리 + 스키마 + UI 카드) → 둘 다, 계약을 먼저 합의시킨다

작업이 단일 영역·소규모면 해당 에이전트 1명 + visual-qa로 충분하다. 팀 통신 오버헤드가 이득보다 크면 팀 대신 단일 `Agent` 서브 호출도 허용한다(판단은 규모 기준).

## Phase 2: 팀 구성 및 작업 할당

1. `TeamCreate`로 필요한 에이전트만 팀에 포함 (작업이 한 영역이면 그 영역 + visual-qa 2명).
2. `TaskCreate`로 작업을 의존성과 함께 등록:
   - 구현 작업(pipeline/fullstack) → 검증 작업(visual-qa)이 의존
   - 양쪽 걸침이면: "계약 합의" 작업을 먼저, 그 뒤 각자 구현
3. 팀원은 `SendMessage`로 직접 조율한다. 특히 **경계면 계약**: shape을 바꾸는 쪽이 반대편 소유자에게 먼저 통지·합의한 뒤 구현.

## Phase 3: 점진적 검증 루프

- 각 구현 모듈이 끝나면 즉시 visual-qa가 검증한다(전체 끝나고 1회가 아니다).
- 후처리 변경 → 시각 회귀(실제 PNG 생성 + Read 확인).
- 풀스택 변경 → 경계면 교차 비교 + `pnpm build`/`pnpm lint`.
- FAIL → visual-qa가 원인 후보를 구현 에이전트에 되돌리고, 1회 재시도. 재실패 시 결과 없이 진행하되 보고서에 누락·원인을 명시한다.

## Phase 4: 종합 및 정리

- 변경 파일·검증 결과를 종합해 사용자에게 보고.
- 중간 산출물은 `_workspace/`에 보존(파일명: `{phase}_{agent}_{artifact}.md`), 최종 코드만 실제 경로에.
- 팀 정리.

## 데이터 전달 프로토콜

- **태스크 기반**(TaskCreate/Update): 진행·의존 관리.
- **메시지 기반**(SendMessage): 경계면 계약 합의, 검증 요청/되돌림.
- **파일 기반**(`_workspace/`): 변경 요약·QA 결과 보존, 후속 재실행의 입력.

## 에러 핸들링

- 구현/검증 실패는 1회 재시도. 재실패 시 누락을 명시하고 진행.
- 상충하는 후처리 결과(예: 두 셀 정렬 방식)는 삭제하지 말고 둘 다 보고하고 사용자 판단을 받는다.
- codex/claude 구독 한도 이슈는 생성 검증 횟수를 줄여 대응(kind당 1장).

## 테스트 시나리오

**정상 흐름 — "스프라이트시트 배경이 가끔 녹색 잔여가 남는다, 고쳐줘":**
1. Phase 1: 이미지 파이프라인 영역으로 판별 → pipeline-engineer + visual-qa.
2. pipeline-engineer가 `image-pipeline-dev` 스킬로 chroma-key feather 임계값 수정.
3. visual-qa가 `node scripts/test-spritesheet.mjs`로 생성 후 Read로 녹색 잔여·cross-cell 보존 확인.
4. PASS → 종합 보고. `_workspace/`에 변경·QA 요약 저장.

**에러 흐름 — 새 MCP 도구 추가 중 shape 불일치:**
1. 양쪽 걸침 판별 → 계약 합의 태스크 먼저.
2. fullstack-engineer가 `structuredContent`에 새 필드 추가했으나 ImageResultCard 미반영.
3. visual-qa 경계면 교차 비교에서 FAIL → 원인(card 컴포넌트 path:line) 되돌림.
4. fullstack-engineer 재시도로 양쪽 동기화 → 재검증 PASS.
