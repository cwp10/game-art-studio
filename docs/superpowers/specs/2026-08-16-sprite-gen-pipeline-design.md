# 스프라이트 파이프라인을 sprite-gen 구조로 재구성

> 상태: 설계 승인됨 (2026-08-16). 이 문서는 전체 방향과 **1단계**의 상세 설계를 담는다.
> 2·3단계는 개요만 두고 각자 별도 스펙으로 분리한다.

## 1. 배경

현재 `make_spritesheet` 결과물이 네 가지 모두에서 실패한다 — 배경 제거 품질, 프레임 분할·정렬,
프레임 간 캐릭터 일관성, 애니메이션 질. 사용자 표현으로 "매번 실패했다".

[sprite-gen](https://github.com/cwp10/sprite-gen) v1.57.2 (Apache-2.0, Python 3.10+, Pillow
중심, 15,297줄)은 같은 문제를 다른 파이프라인 구조로 푼다. 로컬 체크아웃:
`/Users/wonpyoung/Developer/workspace/sprite-gen`. 이 문서는 그 구조를 우리 TypeScript/sharp 스택으로
가져오는 설계다. **Python 런타임 의존은 도입하지 않는다** — 알고리즘과 파이프라인 구조를
포팅한다.

numpy 의존이 거의 없다는 점이 이 결정을 가능하게 한다: `extract.py`에 `np.` 20회,
`segment.py`·`breathe.py`·`anatomy.py`는 0회. 나머지는 Pillow 픽셀 연산이며 sharp raw buffer +
순수 TS 루프로 옮길 수 있다.

## 2. 진단 — 현재 파이프라인의 구조적 결함

착수 전 진단에서 확인한 것. 이 셋이 설계 근거다.

### 2.1 레이아웃 가이드가 조건부다

`shared.ts:373`과 `:406`의 분기는 `isWalk && isCharacter`일 때만 포즈 가이드를 붙인다.
`isWalk`는 `isLocomotion(userPrompt)` — `spritesheet-classify.ts:96`의 키워드 매칭이다.
따라서 공격·대기·점프·피격 등은 **가이드 없이 맨 프롬프트로** 생성된다.

sprite-gen은 모든 상태에 레이아웃 가이드를 깐다. 프레임 정렬과 포즈 일관성이 걷기에서만
그럭저럭이고 나머지가 나쁜 이유가 여기일 가능성이 높다. (로그로 실사용 빈도를 교차 확인하려
했으나 `data/logs/mcp-server.log`가 2026-07-03자 1,954바이트라 최근 실행 기록이 없어
확증하지 못했다.)

### 2.2 정체성 소유 규칙이 없다

`handleMakeSpritesheet`는 참조 이미지를 매 행 호출에 첨부한다.

sprite-gen 아키텍처 §5는 이를 명시적 안티패턴으로 규정한다:

```
identity truth = accepted idle anchor
motion truth   = layout guide + paired/basis row
base truth     = idle anchor 를 만들 때만 사용, 이후 row 입력에서 제거
```

> "Re-attaching base makes the row model solve identity again and weakens the purpose of
> the idle-anchor workflow."

베이스를 보험처럼 계속 붙이면 모델이 매 행에서 정체성을 다시 푼다. "프레임마다 캐릭터가
달라진다"의 직접적 원인 후보다.

### 2.3 추출이 슬롯 기반이다

우리는 정확 배수 리사이즈 후 rows×cols 격자로 자르고 셀 안에서 정렬한다. 생성 프롬프트의
격자와 후처리의 격자가 별개로 관리되므로 어긋나면 보정이 필요하고, 캐릭터가 셀 경계를 넘으면
잘린다.

sprite-gen은 **셀 객체 하나가 생성·추출·아틀라스 세 단계를 동일하게 지배**한다
(architecture.md §4). 추출은 내용 기반이다: connected components로 포즈 덩어리를 찾고,
x-center로 묶고, bbox를 크롭해 종횡비를 유지한 채(`scale = min(...) ≤ 1.0`) 셀에 중앙 배치한다.

## 3. 목표 파이프라인

```
sprite-request (숫자형 SSoT)
  → prepare: 레이아웃 가이드 PNG + row 프롬프트 (전 상태)
  → [게이트] idle 앵커 확정 → base·원본 refs 를 이후 입력에서 제거
  → 생성: 상태당 가로 스트립 1장 (AI 단계는 여기뿐)
  → extract: 크로마 제거 → connected components → fit_to_cell (내용 기반)
  → compose: 아틀라스 + manifest.frame_layout (절대 좌표 + 상태별 fps/loop)
```

### 3.1 단계 구분

| 단계 | 범위 | 의존 |
|------|------|------|
| **①** | 숫자형 SSoT + 레이아웃 가이드 + row 프롬프트 (생성 입력 계약) | 없음 |
| **②** | 추출 교체 — 크로마 알파, connected components, fit_to_cell | 없음 (①과 독립) |
| **③** | idle 앵커 게이트 + 아틀라스/매니페스트 | ①② |

①을 먼저 하면 ② 검증에 쓸 깨끗한 입력이 생긴다. 이 문서는 **①만** 상세화한다.

### 3.2 대체·존치 대상

**대체됨**
- `spritesheet-postprocess.ts` `normalizeSpritesheetCells` (820줄 파일의 슬롯 기반 정렬 전체) — ②에서
- `chroma-key.ts` (326줄) — ②에서
- `shared.ts`의 조건부 포즈 가이드 분기(`:373`, `:406`)와 거대 프롬프트 지시문 블록
  (`walkCycleRule` 등) — ①에서

**존치**
- `codex-exec.ts` — spawn 인프라. 변경 없음
- `handlers/shared.ts`의 `runImageTool` — DB 기록·progress.jsonl 배선. 변경 없음
- MCP 도구 스키마 — 입력 확장 필요, 골격 유지
- `SpriteCanvas.tsx` — ③에서 매니페스트 대응 수정
- `spritesheet-classify.ts` — `directionLabels` 등 일부 존치, `isLocomotion` 기반 분기는 축소

## 4. 1단계 상세 설계

### 4.1 SpriteRequest — 숫자형 SSoT

프롬프트 문자열에서 매번 재해석하는 대신, 한 객체가 셀 기하·크로마·상태 목록을 소유한다.

```ts
// src/lib/sprite/request.ts (신규)
export type CellSpec = {
  shape: "square" | "rect";   // width === height 에서 파생
  width: number;
  height: number;
  safeMarginX: number;
  safeMarginY: number;
};

export type StateSpec = {
  frames: number;
  fps: number;
  loop: boolean;
  action: string;             // 자연어 동작 서술
};

export type SpriteRequest = {
  version: 1;
  character: { id: string; description: string; baseGenerationId?: string };
  cell: CellSpec;
  chromaKey: { name: string; hex: string; rgb: [number, number, number] };
  states: Record<string, StateSpec>;
  style: string;
};
```

`normalizeCell()`이 `size` 단축 표기(정사각)와 `width`/`height` 표기를 모두 받아 위 형태로
정규화한다. 기본값은 정사각 256, safe margin 24 — sprite-gen 기본값과 동일하게 둔다.

**크로마 키 선택**: 피사체의 지배 색조에서 **먼** 키를 고른다. 추출이 크로마 인접 색조를
먹기 때문이다(sprite-gen `chroma-alpha.md`). 베이스 이미지를 샘플링해 자동 선택하되,
명시 지정도 받는다. 지금 우리가 `#00ff00` 고정에 가깝게 쓰는 것과 달라지는 지점이다.

### 4.2 레이아웃 가이드 렌더러

sprite-gen `draw_guide()`의 이식. `frames × cellW` 캔버스에:

| 요소 | 색 | 두께 |
|------|-----|------|
| 셀 테두리 (프레임마다) | `#333333` | 3px |
| safe margin 사각형 | `#2f80ed` | 2px |
| 셀 중앙 세로선 | `#b8c8e8` | 1px |
| 배경 | `#f6f6f6` | — |

SVG 문자열을 조립해 sharp로 래스터화한다. 픽셀 연산이 필요 없고 기존 `pose-reference.ts`의
SVG 폴백 경로와 같은 기법이라 새 의존이 없다.

기존 `generateGridTemplate`(shared.ts)과 역할이 겹친다. 그 함수는 격자 템플릿을 만들지만
safe margin·중앙선 개념이 없고 호출 조건이 다르다. **`generateGridTemplate`을 이 렌더러로
대체**하고 호출부를 옮긴다.

**모션 페이즈 가이드**는 1단계 범위에서 제외한다. sprite-gen에서도 8프레임 로코모션에만
적용되는 옵트인이고(`motion_phase_guides`), 우리는 이미 `pose-reference.ts`에 유사 자산이
있어 통합 방식을 ③에서 함께 정하는 편이 낫다.

### 4.3 row 프롬프트 빌더

상태 하나당 프롬프트 하나. 구성 요소:

1. **셀 계약** — "가로 스트립을 보이지 않는 `cellW`×`cellH` 프레임 슬롯 `frames`개로 취급하라"
2. **크로마 배경** — 지정된 키 색으로 배경을 채우라는 지시
3. **캐릭터 서술** — `character.description` + `style`
4. **상태 요구사항** — `states[state].action` + 상태별 고정 요구사항
5. **앵커 락** — (③에서 추가) 정체성은 앵커에서 오고, 이 행은 모션만 소유한다

현재 `buildSpritePrompt`의 거대 지시문(`walkCycleRule`, `singleDirWalkDir`, `actionAnimRule`
등)은 대부분 이 구조로 흡수되거나 폐기된다. **긍정 진술 먼저 → 구체적 Avoid 열거** 패턴은
유지한다(`image-pipeline-dev` 스킬의 프롬프트 작성 규칙 — gpt-image-2에 CFG 네거티브가 없다는
제약은 그대로다).

### 4.4 컴포넌트 경계

```
src/lib/sprite/
  request.ts       — SpriteRequest 타입 + normalizeCell + 크로마 키 자동 선택
  layout-guide.ts  — SVG 조립 + sharp 래스터화 (draw_guide 이식)
  row-prompt.ts    — 상태별 프롬프트 빌더 (row_prompt 이식)
```

세 모듈 모두 **순수 함수 + 파일 출력**이며 DB·MCP·codex를 모르게 한다.
`spritesheet-classify.ts`가 순수 함수 모듈로 유지되는 것과 같은 규약이다.
`spritesheet-handler.ts`가 이들을 호출해 조립한다.

### 4.5 에러 처리

- **크로마 키 자동 선택 실패**(베이스 이미지 없음, 샘플링 불가) → 기본 마젠타로 폴백하고
  경고를 progress에 남긴다. 생성을 막지 않는다.
- **셀 치수 검증 실패**(`frames × cellW`가 codex 캔버스 한계 초과) → 생성 전에 throw.
  지금도 상류 검증(~488줄)이 8방향을 막는 것과 같은 자리다.
- **가이드 렌더링 실패** → non-fatal. 가이드 없이 진행하되 로그에 남긴다. 현재 포즈 가이드
  실패 처리와 동일한 정책.

### 4.6 UI/UX 영향 — 1단계는 없음

`SpriteGenPanel`은 이미 `subjectType`·`direction`·`frames`·`seamlessLoop`·`actionPrompt`·
`perspective`를 받는다. `SpriteRequest`는 이 값들에서 파생하고 나머지는 기본값으로 채운다:

| SpriteRequest 필드 | 출처 |
|---|---|
| `states[s].frames` | 패널 `frames` |
| `states[s].action` | 패널 `actionPrompt` |
| `states[s].loop` | 패널 `seamlessLoop` |
| `states[s].fps` | 기본값 (프레임 수에서 파생) |
| `cell` | 기본값 — 정사각 256, safe margin 24 |
| `chromaKey` | 자동 선택 (§4.1) |
| `character.description` | 참조 이미지 있으면 그쪽, 없으면 `actionPrompt` |
| `style` | 기본값 |

**개념 차이 하나**: sprite-gen의 `states`는 여러 상태의 맵(idle/jump/attack…)이고, 우리 패널은
한 번에 한 동작이다. 1단계에서는 "상태 1개짜리 request"로 다뤄 UI를 건드리지 않는다. 다중
상태를 한 번에 받는 UI는 ③에서 필요해지면 그때 설계한다.

2단계도 추출 내부 교체라 UI 변경이 없다.

**③은 UI가 바뀐다.** idle 앵커 게이트는 차단형 승인 단계라 새 흐름이 필요하고,
`SpriteCanvas`(2,064줄)는 격자 전제로 짜여 있어 절대 좌표 `frame_layout`을 받으려면 수정해야
한다. 그 설계는 ③ 스펙에서 다룬다.

## 5. 검증 전략

**sprite-gen을 기준 구현으로 삼는다.** "코드상 맞아 보임"은 통과 근거가 아니다.

| 대상 | 방법 | 통과 기준 |
|------|------|-----------|
| 레이아웃 가이드 | 같은 `cell`·`frames`로 Python `draw_guide()`와 TS 렌더러를 각각 실행 | PNG 픽셀 동일 (알파 포함) |
| `normalizeCell` | sprite-gen `normalize_cell()`의 테스트 케이스를 그대로 이식 | 출력 객체 동일 |
| row 프롬프트 | Python `row_prompt()` 출력과 문자열 비교 | 의미 동일 — 완전 일치는 요구하지 않되 누락된 계약 항목이 없을 것 |
| 회귀 | 기존 시트 생성 경로가 깨지지 않는지 | `pnpm test`(test-classify·test-directions·test-sprite-marker) 통과 |

Python 기준 출력 생성은 sprite-gen의 `.venv`를 그대로 쓴다(이미 구성돼 있고 CLI 동작 확인함).
이 의존은 **개발·검증 시점에만** 있고 런타임·배포에는 없다.

## 6. 후속 단계 개요

### ② 추출 교체
- `remove_chroma_background()` — 색거리 볼로 근접 키 픽셀 제거 → 완전 투명 RGB 정리 →
  크로마 물든 경계 블렌드를 despill RGB + 소프트 알파로 분리
- `connected_components()` — 포즈 덩어리 탐지, x-center 그룹핑
- `fit_to_cell()` — bbox 크롭 → 종횡비 유지 리스케일 → 셀 중앙 배치
- 선택: `segmentation: "projection"` (projection profile + DP 최적 컷) — 융합된 포즈 복구 경로
- 선택: 백본 격자 (`detect_pixel_grid`, `crosscheck_pitch_runlen`) — 픽셀 아트 블록 일관성

### ③ 앵커 게이트 + 아틀라스
- idle 앵커 확정 게이트 (차단형). 앵커 확정 후 base·원본 refs 제거
- `manifest.frame_layout` — 절대 좌표 프레임 사각형 + 상태별 fps/loop
- `SpriteCanvas`·export·DB kind 대응

## 7. 라이선스

sprite-gen은 Apache-2.0(Copyright 2026 Alex Kim)이다. 이식 시:

- 포팅한 파일 헤더에 출처와 Apache-2.0 고지를 남긴다
- `NOTICE` 파일을 우리 저장소에 추가하고 sprite-gen의 NOTICE 내용을 승계한다 — 특히
  perfectpixel-studio(MIT, Copyright Andrew Kim)에서 온 부분(`align_x: alpha-centroid`,
  `segmentation: projection`, `chroma.mode: ycbcr`)의 이중 고지
- 이 저장소는 공개 저장소이므로 고지 누락은 라이선스 위반이 된다

## 8. 미해결 / 후속 결정

- **기존 생성물 호환** — 이미 만든 스프라이트시트를 새 매니페스트 포맷으로 옮길지, 격자
  해석을 유지할지는 ③에서 결정한다.
- **모션 페이즈 가이드** — `pose-reference.ts`의 기존 포즈 자산과 sprite-gen
  `motion_phase_guides`의 통합 방식은 ③에서 정한다.
- **`isLocomotion` 분기의 운명** — row 프롬프트가 상태별 요구사항을 소유하면 키워드 매칭
  분기의 필요성이 줄어든다. ①에서 어디까지 걷어낼지는 구현 중 판단한다.
