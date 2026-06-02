---
name: imggen-feature-dev
description: image-generator 프로젝트에서 기능 개발·버그 수정·리팩터링을 조율하는 오케스트레이터. 이미지 파이프라인(codex/sharp/스프라이트시트 후처리), 풀스택 경계면(Next API/MCP/DB/React), 시각·통합 검증을 가로지르는 작업을 받으면 사용. "기능 추가", "버그 수정", "이미지 생성/편집/스프라이트시트 작업", "API/UI/DB 변경", 그리고 후속 표현인 "다시 실행", "재실행", "업데이트", "수정", "보완", "이전 결과 개선", "X 부분만 다시"에도 적용. 단순 단일 파일 질문이나 설명 요청은 직접 응답 가능.
---

# image-generator 기능 개발 오케스트레이터

요청을 영역별로 분해하고, `Agent` 도구로 전문 에이전트를 직접 스폰해 구현·검증을 조율한다.

**실행 모드:** Agent 도구 기반 직접 스폰. pipeline-engineer·fullstack-engineer 호출은 `model: "opus"` 옵션 적용. visual-qa는 에이전트 정의(`model: sonnet`)를 따르므로 model 옵션 생략.

**팀 구성:**
| 에이전트 | subagent_type | 담당 |
|---------|--------------|------|
| pipeline-engineer | `pipeline-engineer` | image-backend, mcp/server.ts 후처리 (codex spawn, sharp, chroma-key, cell normalize) |
| fullstack-engineer | `fullstack-engineer` | Next API, MCP 스키마, DB repo/schema, SSE, React |
| visual-qa | `visual-qa` | 시각 회귀, probe/test-spritesheet/build/lint 게이트, 경계면 교차 비교 |

오케스트레이터(이 스킬을 실행하는 메인)가 분배자·통합자 역할을 직접 맡는다. 에이전트 간 직접 통신은 없고, 모든 조율은 오케스트레이터가 결과를 받아 다음 에이전트 프롬프트에 반영하는 방식으로 한다.

## Phase 0: 컨텍스트 확인

워크플로우 시작 시 `_workspace/` 존재 여부로 실행 모드를 판별한다:
- `_workspace/` 없음 → **초기 실행**
- `_workspace/` 있음 + 사용자가 부분 수정 요청 → **부분 재실행** (해당 영역 에이전트만 재호출, 이전 요약 전달)
- `_workspace/` 있음 + 새 입력 → **새 실행** (기존 `_workspace/`를 `_workspace_prev/`로 이동 후 시작)

## Phase 1: 요청 분해 및 영역 판별

요청을 다음 축으로 분류한다:
- **이미지 파이프라인 영역**(후처리/codex/스프라이트시트) → pipeline-engineer
- **풀스택 경계면 영역**(API/MCP스키마/DB/React/SSE) → fullstack-engineer
- **양쪽 걸침**(예: 새 MCP 도구 = 후처리 + 스키마 + UI 카드) → 계약 먼저 확정 후 둘 다 스폰

작업이 단일 영역·소규모면 해당 에이전트 1명 + visual-qa로 충분하다.

## Phase 1.5: advisor 호출 (조건부)

Phase 2 진입 전, 아래 조건 중 하나라도 해당하면 `advisor()`를 호출한다.

**호출 조건:**
- 요청이 pipeline + fullstack 양쪽에 걸쳐 **경계면 계약을 새로 설계**해야 할 때 (새 MCP 도구, 새 DB 컬럼 + UI 연동 등)
- 어느 에이전트에 배분해야 할지 **불명확**할 때
- visual-qa FAIL이 **2회 이상 반복**될 때 (재스폰 전략 재검토)

**호출하지 않는 조건:**
- 단일 영역·소규모 수정 (SpriteCanvas UI 수정, chroma-key 튜닝 등)
- 부분 재실행에서 이미 계약이 확정된 상태

advisor는 전체 대화 컨텍스트를 보므로 별도 설명 없이 `advisor()`만 호출하면 된다. 조언을 받은 뒤 Phase 2로 진행한다.

## Phase 2: 에이전트 스폰 및 작업 할당

`Agent` 도구로 필요한 에이전트를 직접 스폰한다:

```
Agent({
  subagent_type: "pipeline-engineer",  // or "fullstack-engineer" / "visual-qa"
  model: "opus",
  prompt: "작업 명세 + 필요한 컨텍스트 (이전 _workspace/ 요약 포함)"
})
```

**스폰 순서 원칙:**
- 서로 독립적인 구현 작업(경계면 계약이 확정된 상태) → 병렬 스폰 가능
- 양쪽 걸침 작업 → 오케스트레이터가 계약(schema/structuredContent 형태)을 먼저 결정해 양쪽 프롬프트에 명시, 그 뒤 병렬 스폰
- visual-qa → 구현 에이전트 결과를 받은 뒤 스폰 (결과 요약을 프롬프트에 포함)

**컨텍스트 전달:** 에이전트가 알아야 할 이전 단계 결과는 `_workspace/{phase}_{agent}_summary.md`를 읽어 프롬프트에 직접 포함한다.

## Phase 3: 점진적 검증 루프

- 각 구현 에이전트가 완료되면 즉시 visual-qa를 스폰한다(전체 끝나고 1회가 아니다).
- 후처리 변경 → 시각 회귀(실제 PNG 생성 + Read 확인).
- 풀스택 변경 → 경계면 교차 비교 + `pnpm build`/`pnpm lint`.
- FAIL → visual-qa 결과에서 원인 후보를 추출해 해당 구현 에이전트를 재스폰. 1회 재시도 후 재실패 시 `advisor()`를 호출해 원인 분석과 재스폰 전략을 검토한다. 그래도 해결 안 되면 누락·원인을 명시하고 사용자에게 보고한다.

## Phase 4: 종합 및 정리

- 변경 파일·검증 결과를 종합해 사용자에게 보고.
- 중간 산출물은 `_workspace/`에 보존(파일명: `{phase}_{agent}_{artifact}.md`), 최종 코드만 실제 경로에.

## 데이터 전달 프로토콜

- **파일 기반**(`_workspace/`): 변경 요약·QA 결과 보존. 다음 에이전트 프롬프트에 해당 파일 내용을 직접 포함한다.
- **TaskCreate/Update**: 진행 상황 트래킹이 필요할 때만 사용 (복잡한 다단계 작업).
- 에이전트 간 직접 통신(SendMessage 등)은 사용하지 않는다. 오케스트레이터가 중간 결과를 수집해 다음 프롬프트를 구성한다.

## 에러 핸들링

- 구현/검증 실패는 1회 재시도. 재실패 시 누락을 명시하고 진행.
- 상충하는 후처리 결과(예: 두 셀 정렬 방식)는 삭제하지 말고 둘 다 보고하고 사용자 판단을 받는다.
- codex/claude 구독 한도 이슈는 생성 검증 횟수를 줄여 대응(kind당 1장).

## 테스트 시나리오

**정상 흐름 — "스프라이트시트 배경이 가끔 녹색 잔여가 남는다, 고쳐줘":**
1. Phase 1: 이미지 파이프라인 영역으로 판별 → pipeline-engineer + visual-qa.
2. `Agent(subagent_type="pipeline-engineer", model="opus")` 스폰: chroma-key feather 임계값 수정 요청.
3. pipeline-engineer 결과를 받아 `_workspace/pipeline_summary.md` 확인.
4. `Agent(subagent_type="visual-qa", model="opus")` 스폰: pipeline 요약 포함, 녹색 잔여·cross-cell 보존 확인 요청.
5. PASS → 종합 보고.

**에러 흐름 — 새 MCP 도구 추가 중 shape 불일치:**
1. 양쪽 걸침 판별 → 오케스트레이터가 `structuredContent` 계약을 직접 결정해 문서화.
2. fullstack-engineer + pipeline-engineer 병렬 스폰 (계약을 각자 프롬프트에 명시).
3. visual-qa 스폰 → 경계면 교차 비교에서 FAIL → 원인(card 컴포넌트 path:line) 반환.
4. fullstack-engineer 재스폰 (FAIL 원인 포함) → 양쪽 동기화 → visual-qa 재스폰 → PASS.
