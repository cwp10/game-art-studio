# CLAUDE.md

image-generator — Codex CLI imagegen 백엔드 + Claude CLI 오케스트레이션의 로컬 게임 에셋 이미지 생성기 (Next.js). 프로젝트 개요는 `README.md` 참조.

## 하네스: image-generator 기능 개발

**목표:** 이미지 파이프라인(codex/sharp/스프라이트시트 후처리) · 풀스택 경계면(Next API/MCP/DB/React) · 시각·통합 검증을 전문 에이전트 팀으로 조율해 기능 개발·버그 수정을 수행한다.

**트리거:** 기능 추가·버그 수정·리팩터링, 이미지 생성/편집/스프라이트시트 작업, API/UI/DB 변경, 그리고 후속 요청("다시 실행", "수정", "보완", "X만 다시")이 들어오면 `imggen-feature-dev` 스킬을 사용하라. 단순 단일 파일 질문·설명 요청은 직접 응답 가능.

## 코드 탐색: codebase-memory MCP 우선

이 저장소는 codebase-memory 지식 그래프에 인덱싱되어 있다. **프로젝트 이름: `Users-wonpyoung-Developer-workspace-game-art-studio`**

심볼·호출관계·구조를 찾을 때는 grep/glob 대신 그래프를 먼저 쓴다.

| 목적 | 호출 |
|------|------|
| 이름/키워드로 찾기 | `search_graph(project, query="spritesheet cell normalize")` — BM25, camelCase 분해됨 |
| 정규식 이름 매칭 | `search_graph(project, name_pattern=".*Spritesheet.*")` |
| 호출자·피호출자 | `trace_path(project, function_name="normalizeSpritesheetCells", direction="both")` |
| 소스 읽기 | `get_code_snippet(qualified_name="...")` |
| 구조 개관 | `get_architecture(project)` |
| 변경 영향 범위 | `detect_changes(project)` |

읽기 전 파일 확정, 설정·마크다운·비코드 파일 검색은 Read/Grep 을 그대로 쓴다.

**인덱스 갱신** — 커밋을 여러 개 쌓은 뒤나 파일을 새로 만든 뒤:
`index_repository(repo_path="/Users/wonpyoung/Developer/workspace/game-art-studio", mode="full")`

`moderate` 는 `scripts/` 를 제외 목록에 넣는다. probe·test-spritesheet 등 QA 스크립트를 그래프에 남기려면 `full` 을 써라. 제외 대상은 `.cbmignore` 가 관리한다(dist·node_modules·data·public·docs/harness-archive 등).

**주의** — 재인덱싱은 노드를 추가·갱신만 하고 사라진 노드를 청소하지 않는다. 파일을 지우거나 옮긴 뒤 그래프에서 없애려면 `delete_project` 후 재인덱싱해야 한다.
