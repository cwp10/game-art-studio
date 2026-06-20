# CLAUDE.md

image-generator — Codex CLI imagegen 백엔드 + Claude CLI 오케스트레이션의 로컬 게임 에셋 이미지 생성기 (Next.js). 프로젝트 개요는 `README.md` 참조.

## 하네스: image-generator 기능 개발

**목표:** 이미지 파이프라인(codex/sharp/스프라이트시트 후처리) · 풀스택 경계면(Next API/MCP/DB/React) · 시각·통합 검증을 전문 에이전트 팀으로 조율해 기능 개발·버그 수정을 수행한다.

**트리거:** 기능 추가·버그 수정·리팩터링, 이미지 생성/편집/스프라이트시트 작업, API/UI/DB 변경, 그리고 후속 요청("다시 실행", "수정", "보완", "X만 다시")이 들어오면 `imggen-feature-dev` 스킬을 사용하라. 단순 단일 파일 질문·설명 요청은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-05-27 | 초기 구성 (pipeline-engineer / fullstack-engineer / visual-qa + imggen-feature-dev 오케스트레이터) | 전체 | - |
| 2026-05-29 | TeamCreate/SendMessage 제거 → Agent 도구 직접 스폰 모델로 전환; 에이전트 간 직접 통신 → 오케스트레이터 중재 방식으로 전환 | imggen-feature-dev, agents/*.md, 서브 스킬 | Claude 4.x 하네스 업데이트 반영 |
| 2026-06-20 | 에이전트 페르소나 삽입 (프로젝트 실전 스카 기반); 스킬 파일 맵 업데이트 (composite/nine-slice/button-states/sprite-effect 등 신규 백엔드 반영, CanvasEditor 등 신규 컴포넌트 반영); visual-qa description 정확화; 루트 _workspace/ .gitignore 추가 | agents/pipeline-engineer.md, agents/fullstack-engineer.md, agents/visual-qa.md, skills/image-pipeline-dev, skills/fullstack-boundary-dev, .gitignore | 하네스 감사·검토 결과 반영 |
