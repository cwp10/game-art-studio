# 스프라이트 파이프라인을 sprite-gen 구조로 재구성

> 상태: 설계 승인됨 (2026-08-16). 정본 계약(`SKILL.md`) 대조 후 순서 교정 (2026-08-16, 2차).
> 이 문서는 전체 방향과 **⓪①② 단계**의 상세를 담는다. ③④는 개요만 두고 별도 스펙으로 분리한다.

## 1. 배경

현재 `make_spritesheet` 결과물이 네 가지 모두에서 실패한다 — 배경 제거 품질, 프레임 분할·정렬,
프레임 간 캐릭터 일관성, 애니메이션 질. 사용자 표현으로 "매번 실패했다".

[sprite-gen](https://github.com/cwp10/sprite-gen) v1.57.2 (Apache-2.0, Python 3.10+, Pillow
중심, 15,297줄)은 같은 문제를 다른 파이프라인 구조로 푼다. 로컬 체크아웃:
`/Users/wonpyoung/Developer/workspace/sprite-gen`.

**Python 런타임 의존은 도입하지 않는다** — 알고리즘과 파이프라인 구조를 포팅한다. numpy 의존이
거의 없다는 점이 이를 가능하게 한다: `extract.py`에 `np.` 20회,
`segment.py`·`breathe.py`·`anatomy.py`는 0회. 나머지는 Pillow 픽셀 연산이며 sharp raw buffer +
순수 TS 루프로 옮길 수 있다.

**정본 계약의 위치**: sprite-gen 의 행동 계약은 `SKILL.md` 가 소유한다. `docs/architecture.md`
는 *"If this doc and SKILL.md ever disagree, SKILL.md wins and this doc is the bug"* 라고
명시한다. 이 스펙의 1차 초안은 architecture.md 만 보고 작성해 순서와 필수/선택 구분을 틀렸다.
2차 개정에서 SKILL.md 를 대조해 바로잡았다.

## 2. 진단 — 현재 파이프라인의 구조적 결함

착수 전 진단에서 확인한 것. 이 다섯이 설계 근거다.

### 2.1 베이스 잠금 게이트가 없다

sprite-gen 의 Stage 0 은 **차단형** 게이트다(SKILL.md "Base Lock Gate (Stage 0, BLOCKING)"):

> **Do not run `prepare_sprite_run.py` until a base is locked.** "Good enough for now" is not
> a pass — drift only grows once the rows start.
>
> A weak idle anchor **poisons every state** — proportions, style, and identity drift compound
> across all rows.

우리에게는 이 게이트가 없다. 채팅 한 줄이 곧바로 시트 생성으로 이어진다. 베이스 품질이
검증되지 않은 채 모든 상태가 생성되므로, 정체성·비율·스타일 드리프트가 누적된다.

잠금 기준 6가지(SKILL.md):
전신·비잘림 / 최종 비율과 스타일이 **이미** 맞을 것("나중에 고친다" 금지) / 픽셀아트 런이면
베이스 자체가 진짜 픽셀아트(균일 블록 피치 실측, AA 반투명 가장자리 없음) / 캐릭터시트와
정체성 일치 / 단일 명확한 대기 포즈·의도한 카메라 방향·작은 크기에서 읽히는 실루엣 /
평면 크로마 배경.

### 2.2 스타일 권한이 프롬프트에 있다고 가정한다

SKILL.md 필수 게이트:

> 이미지 모델은 첨부 레퍼런스를 **프롬프트 텍스트보다 강하게** 따른다. … `fit.pixel_unfake`
> 런에 AA/벡터풍 베이스를 붙이면 프롬프트에 "TRUE 32x32 pixel art" 를 적어도 raw 가 도트로
> 나오지 않는다. … **프롬프트 문구로 베이스의 스타일을 이기려 하지 마라.**

실사고 기록이 붙어 있다(2026-07-29 gptaku 아이콘: AA 블롭 베이스 → 비도트 raw → 추출 피치
x/y 불균일 10.5/9.7 → 실루엣 눌림 반려 3회).

우리는 `shared.ts` 에 거대한 프롬프트 지시문(`walkCycleRule` 등)을 쌓아 스타일과 포즈를
통제하려 한다. 이 접근의 상한이 낮다는 뜻이다. **스타일 SSoT 는 첨부된 베이스/앵커다.**

### 2.3 레이아웃 가이드가 조건부다

`shared.ts:373`과 `:406`의 분기는 `isWalk && isCharacter`일 때만 포즈 가이드를 붙인다.
`isWalk`는 `isLocomotion(userPrompt)` — `spritesheet-classify.ts:96`의 키워드 매칭이다.
따라서 공격·대기·점프·피격 등은 **가이드 없이 맨 프롬프트로** 생성된다.

sprite-gen 은 모든 상태에 레이아웃 가이드를 깐다. (로그로 실사용 빈도를 교차 확인하려 했으나
`data/logs/mcp-server.log`가 2026-07-03자 1,954바이트라 최근 실행 기록이 없어 확증하지 못했다.)

### 2.4 추출이 슬롯 기반이고, 나쁜 생성을 후처리로 수선한다

우리는 정확 배수 리사이즈 후 rows×cols 격자로 자르고 셀 안에서 정렬한다. 생성 프롬프트의
격자와 후처리의 격자가 별개로 관리되므로 어긋나면 보정이 필요하고, 캐릭터가 셀 경계를 넘으면
잘린다.

sprite-gen 은 **셀 객체 하나가 생성·추출·아틀라스 세 단계를 동일하게 지배**한다
(architecture.md §4). 추출은 내용 기반이다: connected components 로 포즈 덩어리를 찾고,
x-center 로 묶고, bbox 를 크롭해 종횡비를 유지한 채(`scale = min(...) ≤ 1.0`) 셀에 중앙 배치한다.

더 중요한 원칙 차이가 있다. SKILL.md Prompt Contract:

> If image generation produces guide boxes, visible labels, overlapping poses, backgrounds,
> cropped bodies, or identity drift, **regenerate the row. Do not repair bad visual generation
> by drawing or tiling sprites locally.**

우리 `normalizeSpritesheetCells`(820줄) 가 하는 일 상당수가 정확히 이 "국소 수선"이다.
셀 정렬 보정·잔여 제거·경계 넘김 복구는 생성이 실패했을 때의 수습이며, sprite-gen 은 그것을
재생성으로 처리한다.

### 2.5 provider 계층이 모델의 협조에 의존한다

**codex `image_gen` 은 파일을 저장하지 않는다.** PNG 를 세션 rollout jsonl 안에 base64 로
inline 반환한다(`codex_provider.py` 헤더).

우리는 `codex-exec.ts:43` 에서 `"Save the result as ./output.png in your current working
directory"` 라고 지시하고, 모델이 `~/.codex/generated_images/…png` 를 워크스페이스로 복사해
주기를 기대한 뒤 그 파일을 회수한다. 이 복사는 codex 의 보장이 아니라 **모델이 스킬 가이드를
따라 해주는 부가 동작**이다. 모델이 파일명을 달리 쓰거나, 복사를 건너뛰거나, 설명을 덧붙이면
회수가 실패한다. 우리 코드에 "output.png 없으면 최신 `.png`" 폴백이 있다는 사실 자체가 이
경로의 불안정성을 보여준다.

sprite-gen 은 정반대로 간다. 프롬프트에서 **파일 저장을 금지**하고
(`"파일 저장·셸 명령·코드 작성·경로 보고 전부 금지"`), rollout jsonl 에서 base64 를 직접
디코딩한다. 주석이 원칙을 못박는다: **"The model-reported path is never trusted."**

호출 인자도 다르다.

| | 우리 | sprite-gen |
|---|---|---|
| `--json` | 없음 | 있음 — session id 파싱에 필요 |
| `--add-dir ~/.codex/generated_images` | 없음 | 있음 — *"not in the default writable set; missing it silently fails"* |
| `--color never` | 없음 | 있음 |
| 작업 디렉터리 | `--cd {jobDir}` | `-C {workdir}` |
| 프롬프트 전달 | positional (`-- "prompt"`) | stdin (`-`) |
| 환경변수 | 부모 상속 | orchestrator 세션 env **prefix 계열 제거** |
| 타임아웃 | 600초 | 180초 (`SPRITE_GEN_GEN_TIMEOUT_SECONDS` 로 조절) |
| `--ephemeral` | 해당 없음 | **금지** — jsonl 이 디스크에 남아야 추출 가능 |

`--add-dir` 누락이 우리에게 실제로 어떤 영향을 주는지는 **확인되지 않았다**. 우리는 다른
경로(스킬이 복사)를 쓰기 때문이다. 다만 sprite-gen 주석이 "이 플래그가 없으면 조용히
실패한다"고 단언하므로, image_gen 도구 등록 자체에 영향을 줄 가능성이 있다.

## 3. 목표 파이프라인

```
[게이트] 베이스 잠금 (BLOCKING) — 잠기기 전에는 아래로 진행 금지
  → sprite-request (숫자형 SSoT)
  → prepare: 레이아웃 가이드 PNG + row 프롬프트 (전 상태)
  → 생성: 상태당 가로 스트립 1장 (AI 개입은 여기 한 곳뿐)
          앵커만 첨부 · base·원본 refs 는 입력에서 제거
          codex exec --json → rollout jsonl 의 inline base64 디코딩
  → extract: 크로마 제거 → connected components → 셀 배치 (결정론 변환)
  → compose: 아틀라스 + manifest.frame_layout (절대 좌표 + durations_ms)
```

### 3.1 단계 구분

| 단계 | 범위 | 의존 |
|------|------|------|
| **⓪** | provider 정합 — codex 호출 인자와 이미지 회수 방식 교체 | 없음 |
| **①** | 베이스 잠금 게이트 (Stage 0) — 잠금 기준 검사 + 확정 흐름 | ⓪ (베이스 생성에도 codex 를 쓴다) |
| **②** | 숫자형 SSoT + 레이아웃 가이드 + row 프롬프트 | ① (앵커가 있어야 프롬프트가 성립) |
| **③** | 추출 교체 — 크로마 알파, connected components, 셀 배치 | ⓪ (입력 신뢰성) |
| **④** | 아틀라스 + 런타임 매니페스트 | ②③ |

**순서 근거**: 1차 초안은 베이스 잠금을 마지막에 뒀다. SKILL.md 가 이를 Stage 0 BLOCKING 으로
규정하고 "약한 앵커가 모든 상태를 오염시킨다"고 명시하므로 앞으로 당겼다. ⓪ 이 ① 보다 앞인
이유는 베이스 이미지 생성 자체가 codex 호출이기 때문이다.

이 문서는 **⓪①②** 를 상세화한다.

### 3.2 대체·존치 대상

**대체됨**
- `spritesheet-postprocess.ts` `normalizeSpritesheetCells` (820줄 파일의 슬롯 기반 정렬 전체) — ③에서.
  국소 수선 로직은 재생성 원칙으로 대체된다(§2.4)
- `chroma-key.ts` (326줄) — ③에서
- `shared.ts`의 조건부 포즈 가이드 분기(`:373`, `:406`)와 거대 프롬프트 지시문 블록
  (`walkCycleRule` 등) — ②에서

**부분 교체**
- `codex-exec.ts` — spawn 골격·로그·progress 추론은 존치. **호출 인자와 출력 회수 경로만
  교체**(⓪). `PROMPT_HEADER` 의 파일 저장 지시는 제거된다

**존치**
- `handlers/shared.ts`의 `runImageTool` — DB 기록·progress.jsonl 배선. 변경 없음
- MCP 도구 스키마 — 입력 확장 필요, 골격 유지
- `SpriteCanvas.tsx` — ④에서 매니페스트 대응 수정
- `spritesheet-classify.ts` — `directionLabels` 등 일부 존치, `isLocomotion` 기반 분기는 축소

## 4. ⓪단계 상세 — provider 정합

`codex-exec.ts` 한 파일의 변경이다. spawn 골격·로그 버퍼·`inferStage` 진행 추론은 그대로 두고,
**호출 인자·프롬프트 헤더·출력 회수** 세 곳을 교체한다.

### 4.1 호출 인자

```
codex exec --json
           --sandbox workspace-write
           --skip-git-repo-check
           --color never
           --add-dir ~/.codex/generated_images
           -C {jobDir}
           [-i {ref}...]
           -                      # 프롬프트는 stdin
```

변경점: `--json`·`--color never`·`--add-dir` 추가, 프롬프트를 positional 에서 stdin 으로,
`--cd` 를 `-C` 로. `--ephemeral` 은 **절대 쓰지 않는다** — rollout jsonl 이 디스크에 남아야
회수가 된다.

**환경변수**: sprite-gen `provider_subprocess_env()` 를 그대로 따라 **prefix 블랙리스트**로
간다 — 부모 환경에서 orchestrator 세션 env 계열만 제거한다. 화이트리스트는 codex 인증·PATH
관련 변수를 빠뜨릴 위험이 있어 채택하지 않는다.

sprite-gen 이 이 격리를 두는 사유(codex 자체 훅이 프롬프트를 스폰한 워커 채널로 브로드캐스트)가
우리 환경에도 적용되는지는 **확인하지 않았다.** 우리에게 확실한 사유는 따로 있다 — Claude CLI
가 spawn 한 MCP 서버 안에서 codex 를 다시 spawn 하므로 세션 환경이 섞이면 추적이 어려워진다.

**타임아웃**: sprite-gen 은 180초다. 우리는 현행 600초를 **유지한다** — 우리 호출은
imagegen 스킬을 경유하고 스프라이트 시트처럼 큰 캔버스를 다루므로 더 느릴 수 있다. 다만 이
값은 근거 있는 측정이 아니라 보수적 선택이므로, ⓪ 구현 후 실제 소요를 로그로 재어 조정한다.

### 4.2 프롬프트 헤더

현재 `PROMPT_HEADER` 의 파일 저장 지시를 **삭제**한다.

```
- "Save the result as ./output.png in your current working directory."
- "Do not create any other files. ... Just produce ./output.png."
+ "image_gen 도구를 정확히 1번 호출해 이미지 1장만 생성한다."
+ "파일 저장·셸 명령·코드 작성·경로 보고를 하지 않는다. 생성만 하고 끝낸다."
```

모델에게 부가 작업을 시키지 않는 것이 요점이다. 이미지는 프로토콜에서 가져온다.

기존 헤더의 배경 제거 스크립트 금지 지시는 유지 — 후처리는 우리가 한다.

### 4.3 출력 회수

```
stdout 파싱 → session id
  {"type":"thread.started","thread_id":"<uuid>"}   (신 codex)
  "session id: <uuid>"                              (구 codex, 정규식)
↓
~/.codex/sessions/**/rollout-*{session_id}*.jsonl   (mtime 최신 우선)
↓
각 줄 JSON 파싱 → payload.type ∈ {image_generation_call, image_generation_end}
                   && payload.result 존재
   payload.status 가 있고 "completed" 가 아니면 → 에러
↓
base64 디코딩 → data/images/{generationId}.png → PNG magic 검증
```

레코드 타입 두 가지는 codex 버전 차이이며 **둘 다 정식**이다(폴백이 아니다).
`saved_path` 필드가 있어도 **쓰지 않는다.**

PNG 검증은 sprite-gen `verify_png` 를 따른다 — 파일 존재 + 매직 바이트 확인, 불일치 시
*"refusing to claim success"*.

기존 "`output.png` → 없으면 최신 `.png`" 폴백은 제거한다. 이 폴백은 회수 실패를 조용히
덮어 엉뚱한 이미지를 집어올 수 있다.

### 4.4 에러 처리

- **session id 파싱 실패** → 즉시 에러. stdout 에서 `turn.failed`/`error` 레코드의 사람이 읽을
  수 있는 메시지를 뽑아 함께 보고한다(sprite-gen `_extract_stream_errors` 이식).
- **rollout jsonl 없음** → 에러. 경로와 session id 를 메시지에 포함.
- **`image_gen` 결과 레코드 없음** → 에러. 모델이 도구를 호출하지 않은 경우다.
- **status ≠ completed** → 에러.
- **타임아웃** → SIGTERM → 5초 후 SIGKILL. 현행 유지.

지금은 회수 실패가 폴백에 흡수돼 "이상한 이미지가 나왔다"로 나타난다. 바뀐 뒤에는 실패가
실패로 드러난다. **이것이 이 단계의 핵심 이득이다.**

### 4.5 검증

⓪ 은 sprite-gen 과 픽셀 대조가 불가능하다(생성이 비결정적). 대신:

| 항목 | 방법 | 통과 기준 |
|------|------|-----------|
| 회수 경로 | `pnpm probe` (probe-codex-imagegen) | PNG 생성 성공, 매직 검증 통과 |
| 회수 실패 검출 | 프롬프트를 일부러 도구 미호출로 유도 | 폴백 없이 명시적 에러 |
| img2img | `probe-codex-img2img.mjs` | `-i` 참조가 반영된 PNG 회수 |
| 회귀 | 기존 생성 도구 전반 | `generate_image`·`edit_image` 각 1장 성공 |
| 소요 시간 | probe 로그의 elapsed | 180초 대비 실측 기록 (타임아웃 재조정 근거) |

## 5. ①단계 상세 — 베이스 잠금 게이트

### 5.1 게이트의 성격

**차단형이다.** 베이스가 잠기기 전에는 상태 행 생성으로 넘어가지 않는다. "일단 이 정도면
됐다"는 통과가 아니다 — 드리프트는 행이 시작된 뒤에 커지기만 한다.

게이트 질문: *"이 이미지를 정본 베이스 대기 자세로 **잠글** 만큼 좋은가?"* (y/n)

`n` 이면 베이스 후보를 다시 생성·검토하고 재게이트한다.

### 5.2 잠금 기준 (전부 만족해야 통과)

| # | 기준 | 자동 검사 가능? |
|---|------|-----------------|
| 1 | 전신, 잘린 곳 없음 (머리~발이 프레임 안) | 부분 — 알파 bbox 가 캔버스 가장자리에 닿는지 |
| 2 | 최종 비율·스타일이 **이미** 맞음 ("나중에 고친다" 금지) | 불가 — 사람 판단 |
| 3 | 픽셀아트 런이면 베이스가 진짜 픽셀아트 (균일 블록 피치 실측, AA 반투명 가장자리 없음) | **가능** — 피치 검출 + 반투명 픽셀 비율 |
| 4 | 캐릭터시트/레퍼런스와 정체성 일치 | 불가 — 사람 판단 |
| 5 | 단일 명확한 대기 포즈, 의도한 카메라 방향, 작은 크기에서 읽히는 실루엣 | 부분 — 축소 후 실루엣 대비 |
| 6 | 평면 크로마 배경 (또는 쉽게 키잉 가능) | **가능** — 테두리 픽셀 색 분산 |

자동 검사 가능한 3·6과 부분 가능한 1·5를 **사전 검사**로 돌려 실패 항목을 표시하고, 최종
y/n 은 사람이 누른다. 2·4는 자동화하지 않는다.

### 5.3 잠금 이후의 소유권 규칙

```
identity truth = 승인된 idle 앵커
motion truth   = 레이아웃 가이드 (+ 필요 시 basis/paired row)
base truth     = idle 앵커를 만들 때만 사용, 이후 row 입력에서 제거
```

**베이스 재첨부 금지**가 핵심이다. 앵커가 생긴 뒤 상태 행에 베이스를 "보험으로" 다시 붙이면
모델이 정체성을 매번 다시 풀어야 하고, 앵커 워크플로의 목적이 무너진다(architecture.md §5).

우리 `handleMakeSpritesheet` 는 지금 참조 이미지를 매 행 호출에 첨부한다. 이 동작을 제거하고
**앵커만** 첨부하도록 바꾼다.

원본 생성물은 잠금 결정을 감사할 수 있도록 보존하되, 행 입력으로는 다시 쓰지 않는다.

### 5.4 저장 구조

앵커는 방향별로 하나씩 존재한다. DB `generations` 에 새 kind 를 추가하는 대신, **기존 행에
앵커 표식을 다는 방식**을 우선 검토한다 — 새 kind 는 `migrate.ts` + `schema.sql` +
`types/db.ts` 3중 동기화를 요구하므로(CLAUDE.md 참조) 비용이 있다. 최종 결정은 구현 시.

### 5.5 UI/UX 영향

**여기서 UI 가 바뀐다.** 지금은 채팅 한 줄이 곧바로 시트 생성으로 이어지지만, 게이트가 생기면
베이스 후보를 보고 승인하는 단계가 들어간다.

최소 형태: 베이스 후보 이미지 + 사전 검사 결과(§5.2의 자동 검사 항목) + 잠금/재생성 버튼.
`SpriteGenPanel` 또는 채팅 결과 카드 어느 쪽에 붙일지는 구현 시 정한다.

## 6. ②단계 상세 — SSoT · 레이아웃 가이드 · row 프롬프트

### 6.1 SpriteRequest — 숫자형 SSoT

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
  character: { id: string; description: string; anchorGenerationId: string };
  cell: CellSpec;
  chromaKey: { name: string; hex: string; rgb: [number, number, number] };
  states: Record<string, StateSpec>;
};
```

`character.anchorGenerationId` 는 ①에서 잠근 앵커를 가리킨다. 베이스 이미지 ID 가 아니다.

**safe margin 기본값은 비례다.** 생략 시 축당 셀 치수의 **9.4% 내림**: 256→24, 128→12,
rect 192×208→18/19. 명시값은 절대값으로 그대로 이긴다. (1차 초안은 24를 상수로 적었다 —
오류였다.)

셀 기본값은 정사각 256. `256` 은 변수이지 숨은 상수가 아니며, 바꾸면 가이드·프롬프트·추출·
아틀라스를 같은 request 에서 다시 만든다.

**크로마 키 선택** — 소재색을 먼저 보고 고른다:

| 소재색 | 키 |
|--------|-----|
| 핑크/보라/자주 | 그린 `#00FF00` |
| 녹색/청록 식물 | 마젠타 `#FF00FF` |

추출이 크로마 인접 색조를 먹기 때문에 **피사체의 지배 색조에서 먼** 키를 고른다. 베이스를
샘플링해 자동 선택하되 명시 지정도 받는다.

**사후 검증이 계약의 일부다**: 변환 후 소재색이 보존됐는지 확인한다. 꽃이 희게 탈색됐거나
주요 색이 빠졌으면 키가 소재와 충돌한 것이므로, 국소 보정이 아니라 **키를 바꿔 재생성**한다.
지금 우리가 `#00ff00` 고정에 가깝게 쓰는 것과 달라지는 지점이다.

### 6.2 레이아웃 가이드 렌더러

sprite-gen `draw_guide()` 의 이식. `frames × cellW` 캔버스에:

| 요소 | 색 | 두께 |
|------|-----|------|
| 배경 | `#f6f6f6` | — |
| 셀 테두리 (프레임마다) | `#333333` | 3px |
| safe margin 사각형 | `#2f80ed` | 2px |
| 셀 중앙 세로선 | `#b8c8e8` | 1px |

SVG 문자열을 조립해 sharp 로 래스터화한다. 픽셀 연산이 필요 없고 기존 `pose-reference.ts` 의
SVG 폴백 경로와 같은 기법이라 새 의존이 없다.

기존 `generateGridTemplate`(shared.ts)과 역할이 겹친다. safe margin·중앙선 개념이 없고 호출
조건이 다르므로 **이 렌더러로 대체**하고 호출부를 옮긴다.

**모션 페이즈 가이드**는 ② 범위에서 제외한다. sprite-gen 에서도 8프레임 로코모션에만 적용되는
옵트인(`motion_phase_guides`)이고, 우리는 `pose-reference.ts` 에 유사 자산이 있어 통합 방식을
④에서 함께 정하는 편이 낫다.

### 6.3 row 프롬프트 빌더

SKILL.md Prompt Contract 가 요구하는 **7항목을 모두** 담는다:

1. `sprite-request` 의 **정확한 상태 프레임 수**
2. 보이지 않는 request 크기 슬롯마다 **완전한 전신 포즈 하나**
3. `sprite-request` 의 **safe margin**
4. **모든 프레임에 걸쳐 동일한 잠긴 앵커 정체성**
5. **모션 전용 행 책임** — 행은 팔다리·몸통 타이밍을 풀고, 캐릭터 세부를 재발견하지 않는다
6. `sprite-request` 의 **평면 크로마 배경**
7. **금지 목록**: 그림자, 글로우, 스미어, 스피드 라인, 먼지, 배경, 텍스트, UI, 프레임 번호,
   **가이드 박스**, 분리된 이펙트

현재 `buildSpritePrompt` 의 거대 지시문(`walkCycleRule`, `singleDirWalkDir`, `actionAnimRule`
등)은 대부분 이 구조로 흡수되거나 폐기된다. **긍정 진술 먼저 → 구체적 Avoid 열거** 패턴은
유지한다(gpt-image-2 에 CFG 네거티브가 없다는 제약은 그대로다).

**생성 실패 시 재생성한다.** 가이드 박스·라벨·겹친 포즈·배경·잘린 몸·정체성 드리프트가 나오면
행을 다시 생성한다. 국소 수선(그리기·타일링)으로 고치지 않는다.

### 6.4 컴포넌트 경계

```
src/lib/sprite/
  request.ts       — SpriteRequest 타입 + normalizeCell(비례 margin) + 크로마 키 선택
  layout-guide.ts  — SVG 조립 + sharp 래스터화 (draw_guide 이식)
  row-prompt.ts    — 상태별 프롬프트 빌더 (row_prompt 이식, Prompt Contract 7항목)
```

세 모듈 모두 **순수 함수 + 파일 출력**이며 DB·MCP·codex 를 모르게 한다.
`spritesheet-classify.ts` 가 순수 함수 모듈로 유지되는 것과 같은 규약이다.
`spritesheet-handler.ts` 가 이들을 호출해 조립한다.

### 6.5 에러 처리

- **크로마 키 자동 선택 실패**(베이스 샘플링 불가) → 마젠타로 폴백하고 경고를 progress 에
  남긴다. 생성을 막지 않는다.
- **셀 치수 검증 실패**(`frames × cellW` 가 codex 캔버스 한계 초과) → 생성 전에 throw.
  지금도 상류 검증(~488줄)이 8방향을 막는 것과 같은 자리다.
- **가이드 렌더링 실패** → non-fatal. 가이드 없이 진행하되 로그에 남긴다.

### 6.6 UI/UX 영향 — ②는 없음

`SpriteGenPanel` 은 이미 `subjectType`·`direction`·`frames`·`seamlessLoop`·`actionPrompt`·
`perspective` 를 받는다. `SpriteRequest` 는 이 값들에서 파생하고 나머지는 기본값으로 채운다:

| SpriteRequest 필드 | 출처 |
|---|---|
| `states[s].frames` | 패널 `frames` |
| `states[s].action` | 패널 `actionPrompt` |
| `states[s].loop` | 패널 `seamlessLoop` |
| `states[s].fps` | 기본값 (프레임 수에서 파생) |
| `cell` | 기본값 — 정사각 256, safe margin 비례(24) |
| `chromaKey` | 소재색 기반 선택 (§6.1) |
| `character.anchorGenerationId` | ①에서 잠근 앵커 |
| `character.description` | 앵커 생성 시 확정된 서술 |

**개념 차이 하나**: sprite-gen 의 `states` 는 여러 상태의 맵(idle/jump/attack…)이고, 우리
패널은 한 번에 한 동작이다. ②에서는 "상태 1개짜리 request" 로 다뤄 UI 를 건드리지 않는다.
다중 상태를 한 번에 받는 UI 는 ④에서 필요해지면 그때 설계한다.

⓪ 과 ③ 도 UI 변경이 없다. **UI 가 바뀌는 곳은 ①(베이스 잠금 게이트)과 ④(매니페스트 대응)뿐이다.**

## 7. 검증 전략

**결정론 단계는 sprite-gen 을 기준 구현으로 삼아 픽셀 대조한다.** "코드상 맞아 보임"은 통과
근거가 아니다. 비결정 단계(생성)는 대조가 불가능하므로 방법이 다르다.

| 단계 | 대상 | 방법 | 통과 기준 |
|------|------|------|-----------|
| ⓪ | 회수 경로 | §4.5 참조 | probe 성공 + 실패가 에러로 드러남 |
| ① | 사전 검사 (피치·테두리 분산) | 알려진 픽셀아트/비픽셀아트 샘플 투입 | 분류 일치 |
| ② | 레이아웃 가이드 | 같은 `cell`·`frames` 로 Python `draw_guide()` 와 TS 렌더러 각각 실행 | **PNG 픽셀 동일** (알파 포함) |
| ② | `normalizeCell` (비례 margin 포함) | sprite-gen `normalize_cell()` 테스트 케이스 이식 | 출력 객체 동일 |
| ② | row 프롬프트 | Python `row_prompt()` 출력과 대조 | Prompt Contract 7항목 누락 없음 (문자열 완전 일치는 요구하지 않음 — 언어·표현이 다르다) |
| 전체 | 회귀 | 기존 경로가 깨지지 않는지 | `pnpm test` 통과 |

Python 기준 출력 생성은 sprite-gen 의 `.venv` 를 그대로 쓴다(구성돼 있고 CLI 동작 확인함).
이 의존은 **개발·검증 시점에만** 있고 런타임·배포에는 없다.

## 8. 후속 단계 개요

### ③ 추출 교체

SKILL.md 필수 게이트가 규정하는 결정론 변환 경로:
**크로마 제거 → 컴포넌트 분리 → 피치 검출/그리드 스냅 → kCentroid → 공유 팔레트 → 셀 배치**

- `remove_chroma_background()` — 색거리 볼로 근접 키 픽셀 제거 → 완전 투명 RGB 정리 →
  크로마 물든 경계 블렌드를 despill RGB + 소프트 알파로 분리
- `connected_components()` — 포즈 덩어리 탐지, x-center 그룹핑
- `fit_to_cell()` — bbox 크롭 → 종횡비 유지 리스케일 → 셀 중앙 배치

**단순 다운스케일 쇼트컷은 금지다.** raw 를 `resize()` 한 줄로 줄여 최종 경로에 놓는 것은
픽셀 언페이크 변환이 아니다 — AA 가장자리 열화와 그리드 미정렬이 남는다.

주의: 피치 검출·kCentroid·공유 팔레트는 `fit.pixel_unfake` **옵트인 경로**에 속한다(`fit`
부재 시 legacy 동작). 우리가 픽셀아트를 목표로 하는지에 따라 필수 여부가 갈리므로, ③ 스펙에서
먼저 결정한다. (1차 초안은 이를 단순히 "선택"으로 적어 필수 게이트와의 관계를 흐렸다.)

옵션: `segmentation: "projection"` (projection profile + DP 최적 컷) — 융합된 포즈 복구 경로.

### ④ 아틀라스 + 런타임 매니페스트

SKILL.md Runtime Contract 필수 필드:
- `game_input: "sprite-sheet-alpha.png"`
- `degraded_static_fallback: false`
- `animation.rows.<state>` 에 `frames`, `fps`, `durations_ms`, `loop`
- `frame_layout.rows.<state>[i]` 절대 아틀라스 사각형

**`durations_ms` 가 프레임별 표시 시간의 SSoT 다** — 배열이 있으면 fps 대신 이것을 따른다.
홀드 프레임은 마지막 프레임 복제(같은 rect 반복, 텍스처 비용 0)나 duration 연장으로 표현한다.
런타임은 활성 사각형만 샘플링해야 하며, 아틀라스 전체를 한 평면에 렌더하거나 격자를 추측하면
통합 실패다.

**Output Contract 함정**: sprite-gen 은 *"Install from `curated/`, never from `frames/`"* 를
못박는다. 실사고 기록 — 손으로 고친 191픽셀이 조용히 누락되고 "적용됨"으로 보고됨
(2026-07-26). 우리 `SpriteCanvas` 도 프레임 편집·제외·재정렬 기능이 있으므로 **같은 함정이
있다.** 편집 결과가 반영된 산출물과 편집 전 산출물을 구분하는 경계를 ④에서 명시해야 한다.

## 9. 라이선스

sprite-gen 은 Apache-2.0(Copyright 2026 Alex Kim)이다. 이식 시:

- 포팅한 파일 헤더에 출처와 Apache-2.0 고지를 남긴다
- `NOTICE` 파일을 우리 저장소에 추가하고 sprite-gen 의 NOTICE 내용을 승계한다 — 특히
  perfectpixel-studio(MIT, Copyright Andrew Kim)에서 온 부분(`align_x: alpha-centroid`,
  `segmentation: projection`, `chroma.mode: ycbcr`)의 이중 고지
- `codex_provider.py` 는 image-gen 스킬(MIT, aldegad/image-gen)에서 포팅된 것이므로, ⓪ 이식
  시 그 계보도 함께 고지한다
- 이 저장소는 공개 저장소이므로 고지 누락은 라이선스 위반이 된다

## 10. 미해결 / 후속 결정

- **픽셀아트 목표 여부** — `fit.pixel_unfake` 경로를 채택할지가 ③의 필수 범위를 가른다.
  우리 도구는 픽셀 아트와 일반 일러스트를 모두 만드는데, sprite-gen 의 결정론 변환 계약은
  픽셀아트 런을 전제로 쓰였다.
- **앵커 저장 구조** — 새 DB kind 추가(3중 동기화 비용) vs 기존 행에 표식. §5.4
- **기존 생성물 호환** — 이미 만든 시트를 새 매니페스트로 옮길지, 격자 해석을 유지할지. ④
- **모션 페이즈 가이드** — `pose-reference.ts` 자산과 `motion_phase_guides` 의 통합 방식. ④
- **`isLocomotion` 분기의 운명** — row 프롬프트가 상태별 요구사항을 소유하면 키워드 매칭
  분기의 필요성이 줄어든다. ② 구현 중 판단.
- **타임아웃 600초의 근거** — ⓪ 구현 후 실측으로 조정. §4.1

## 11. 아직 읽지 않은 원본 문서

이 스펙은 아래를 읽지 않은 상태에서 작성됐다. ③④ 스펙 착수 전에 대조가 필요하다.

- `SKILL.md` §QA, §Motion Continuity (BLOCKING) — 애니메이션 질 관련
- `docs/run-contract.md` — 스테이지→스크립트 정본 표, takes 계약, curated 폴더 트리
- `docs/chroma-alpha.md` — 크로마 키 분기표 상세, YCbCr 매팅
- `docs/pixel-unfake.md` — 피치 검출·kCentroid·공유 팔레트 파라미터
- `docs/curation.md` — curation.json 스키마
