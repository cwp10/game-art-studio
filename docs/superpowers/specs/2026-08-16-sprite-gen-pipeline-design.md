# 스프라이트 파이프라인을 sprite-gen 구조로 재구성

> 상태: 설계 승인됨 (2026-08-16). **⓪①②③ 구현 완료, ④a(플랜 구동 엔진) 완료.**
> UI 배선은 ④b — §8 참조. 구/신 비교 결과는 `../notes/2026-08-16-pipeline-comparison.md`.
> 2차 — 정본 계약(`SKILL.md`) 대조 후 순서 교정. 3차 — leaf 문서 전체 대조 후 기본/옵트인 정정.
> 4차 — `directional-anchor-workflow.md` 대조 후 6단계로 재편(앵커 체인을 ③ 으로 독립).
> 5차 — `states-and-frames.md` 대조 후 프레임 대역·상태 등급 추가(§6.1.1), ② 구현 실측으로
> 렌더 방식(§6.2)과 통과 기준(§7) 갱신.
> 이 문서는 전체 방향과 **①② 단계**의 상세를 담는다(⓪ 상세는 구현 근거로 §4 에 보존).
> ③④⑤⑥ 은 개요만 두고 각자 별도 스펙으로 분리한다.

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
2차 개정에서 SKILL.md 를, 3차 개정에서 leaf 문서 전체를 대조해 바로잡았다.

### 1.1 기본 경로와 옵트인을 혼동하지 말 것

3차 개정의 가장 큰 정정. 초기 검토에서 sprite-gen 의 강점으로 꼽았던 항목들이 실제로는
**기본 경로가 아니라 특수 상황용 옵트인**이다.

| 항목 | 실제 기본값 | 옵트인의 용도 |
|------|-------------|---------------|
| `chroma.mode` | **`rgb`** | `ycbcr` 은 음영·그라디언트 배경, JPEG 크로마 노이즈 등 **열화된 소스**용. 깨끗한 평면 키에서는 RGB 의 정확해 unmix 가 키 틴트를 완전히 제거하는 반면 ycbcr 은 고정 스케일 despill 이라 **틴트 소프트엣지 헤일로를 남긴다** |
| `fit.align_x` | **`foot-centroid`** | `alpha-centroid` 는 perfectpixel-studio 포팅. `pixel_unfake` 경로에서 프레임별 적용 시 등록 지터 상쇄(상류 측정 σ 27.2px → 0.2px) |
| `fit.segmentation` | **`components`** | `projection` 은 융합된 포즈 복구 경로 |
| `fit.resample` | **`lanczos`** | `kcentroid` 는 픽셀아트 대상, `nearest` 는 오프그리드 아웃라인 손실 |
| `fit` 객체 자체 | **부재(legacy)** | 픽셀아트 타깃·지터 없는 locomotion 일 때만 선언 |

따라서 이식의 1차 목표는 이 옵션들이 아니라 **기본 경로**다: 3패스 RGB 알파 정리, components
분할, 프레임 수 미달 시 행 차단, 그리고 파이프라인 구조(베이스 잠금 → 가이드 → 행 생성 →
내용 기반 추출) 자체.

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

| 단계 | 범위 | 의존 | 상태 |
|------|------|------|------|
| **⓪** | provider 정합 — codex 호출 인자와 이미지 회수 방식 교체 | 없음 | **완료** (2026-08-16) |
| **①** | base idle 잠금 게이트 — 단일 이미지 1장 확정 + 잠금 기준 검사 | ⓪ | 다음 |
| **②** | 숫자형 SSoT + 레이아웃 가이드 + row 프롬프트 | ① | |
| **③** | stage 1 — 방향별 idle 행 생성 → curated head 크롭 → 앵커 확정 → base 은퇴 | ①② | |
| **④** | stage 2 — action rows 생성 (앵커만 첨부) | ③ | |
| **⑤** | 추출 교체 — 크로마 알파, connected components, 셀 배치 | ⓪ | |
| **⑥** | 아틀라스 + 런타임 매니페스트 | ④⑤ | |

**3차 재편 근거(2026-08-16, `directional-anchor-workflow.md` 대조)**: 2차 스펙은 `① 베이스 잠금
→ ② prepare` 였는데 이 둘이 **순환 의존**한다. 방향 앵커를 만들려면 idle 행을 생성해야 하고,
행 생성에는 prepare(레이아웃 가이드 + row 프롬프트)가 필요한데, row 프롬프트는 앵커를
참조한다.

정본의 `references/generation-plan.json` 이 이를 2단계 생성으로 푼다 — **stage 1
direction-anchors(base 기반) → stage 2 action-rows(앵커 기반)**. 같은 prepare 산출물을 쓰되
생성만 나뉜다. 그래서 앵커 체인을 ③ 으로 독립시키고 ① 은 "base idle 1장 확정"으로 좁혔다.

**방향성 스프라이트에만 필요하다.** 정본: *"기본 simple sprite(`idle`/`jump`/`attack`/`wave`)
에는 필요 없다."* 단일 방향이면 ③ 은 "front idle 앵커 1장"으로 축소된다.

이 문서는 **①②** 를 상세화하고 ③④⑤⑥ 은 개요만 둔다. (⓪ 상세는 §4 에 남긴다 — 구현 근거
기록이다.)

### 3.2 대체·존치 대상

**대체됨**
- `spritesheet-postprocess.ts` `normalizeSpritesheetCells` (820줄 파일의 슬롯 기반 정렬 전체) — ⑤에서.
  국소 수선 로직은 재생성 원칙으로 대체된다(§2.4)
- `chroma-key.ts` (326줄) — ⑤에서
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

### 3.3 UI/UX 방침 — 파이프라인 후행

**목표는 sprite-gen 흐름이다.** 근본 차이는 개별 화면이 아니라 흐름에 있다:

| | 흐름 |
|---|---|
| 지금 우리 | 패널 입력 → 채팅 전송 → 시트 한 장 → SpriteCanvas 보정. **원샷** |
| sprite-gen | 베이스 잠금(BLOCKING) → request 확정 → 상태별 행 생성 → 추출 검수 → 큐레이션 → 모션 QA → 굽기. **각 단계가 다음으로 넘어가기 전에 사람의 판단을 받는다** |

sprite-gen 자신의 표현으로 *"생성으로 90%까지 완성할 수 있고, 웹뷰는 사람이 결과를 출시
가능한 상태로 만드는 곳"* 이다. 그 나머지 10% 가 UI 에 있다.

**진행 방식**(사용자 결정 2026-08-16): UI 를 미리 설계하지 않는다. 각 단계를 구현한 뒤
**드러나는 UI 요구를 체크해 반영**한다. 파이프라인이 확정되기 전에 화면을 그리면 추측으로
설계하게 되기 때문이다.

따라서 각 단계 완료 시 아래를 점검하고, 필요한 변경을 그때 별도로 다룬다.

| 단계 | 완료 후 점검할 UI 항목 |
|------|------------------------|
| ⓪ | 회수 실패가 에러로 표면화된다. 지금까지 폴백에 흡수되던 실패가 보이기 시작하므로 **에러 표시가 읽을 만한지** 확인 |
| ① | 베이스 잠금 게이트 — 후보 표시, 6기준 검사 결과, 잠금/재생성. **신규 화면이 필요한 지점** |
| ② | 다중 상태 request. 지금 패널은 한 번에 한 동작이라 상태 맵을 어떻게 받을지 |
| ③ | 앵커 핀 UI 와 stale 판정. curated head 가 기본 앵커임을 보여주는 표시 |
| ④ | 앵커만 첨부하는 행 생성. 미러 방향 생략이 계약으로 보이는지 |
| ⑤ | 프레임 수 미달 시 **행 차단** → 실패 표시와 재생성 유도. 줄별 픽셀 언페이크 토글. 전/후 쌍둥이 비교 |
| ⑥ | `SpriteCanvas` 의 격자 전제 → 절대 좌표 `frame_layout` 대응. 모션 판정 기록 |

**기존 자산**: `SpriteCanvas`(2,064줄)가 큐레이션 기능의 상당수를 이미 갖고 있다 — 애니메이션
재생(FPS 조절), 방향별 행 재생, 어니언 스킨, 프레임 드래그 재정렬, 프레임 제외, 셀 재생성.
sprite-gen 웹뷰와 역할이 겹치므로 뒷단은 신규 제작이 아니라 확장이 될 가능성이 높다. 앞단
(베이스 잠금·request 편집)은 통째로 없다.

**기대 관리**: ⑤ 이후 "실패가 늘어난 것처럼 보이는" 구간이 생긴다. 지금은 캐릭터가 3개만
그려져도 격자로 8칸을 잘라 "8프레임 성공" 으로 표시되지만, 바뀐 뒤에는 차단된다. 실제로는
원래 실패하던 것이 드러나는 것이다.

## 4. ⓪단계 상세 — provider 정합

`codex-exec.ts` 의 변경이다. spawn 골격·타임아웃·로그 버퍼·Windows 처리·후처리(chroma/luma key)는
그대로 두고, **호출 인자·프롬프트 헤더·진행 단계 추론·출력 회수** 네 곳을 교체한다. 파싱 로직은
`codex-rollout.ts` 로 분리해 codex 없이 테스트한다.

**정정(계획 작성 중 확인)**: 2차 개정에서 "`inferStage` 진행 추론은 그대로 두고"라고 쓴 것은
틀렸다. `inferStage`(`codex-exec.ts:404-405`)는 stderr 의 `generated_images` + `find`/`cp `
문자열에 **전적으로 의존한다** — 모델이 파일을 복사하는 동작의 부산물이다. 프롬프트에서 파일
저장 지시를 없애면 두 단계(`image_generating`·`recovering`)가 함께 사라져 진행 표시가
"starting" 에서 "done" 으로 점프한다. `--json` 스트림의 `image_generation_*` 이벤트를 읽도록
교체해야 한다.

**status 판정은 sprite-gen 과 다르게 간다.** 로컬 `~/.codex/sessions` 실측(2026-08-16)에서
`image_generation_*` 레코드의 `status` 가 `"generating"` 으로만 관측됐다. sprite-gen 의
`status != "completed" → 에러` 를 그대로 이식하면 **항상 실패한다.** `result` 존재로 판정하고
status 는 로그에만 남긴다.

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

변경점: `--json`·`--color never`·`--add-dir` 추가. `--ephemeral` 은 **절대 쓰지 않는다** —
rollout jsonl 이 디스크에 남아야 회수가 된다.

**정정(계획 작성 중 확인, 2026-08-16)**: 프롬프트는 **이미 stdin 으로 전달하고 있다**
(`codex-exec.ts:473-474`, `514` — `-` sentinel + `child.stdin.end(naturalPrompt)`). 2차 개정에서
"positional → stdin 변경"이라고 쓴 것은 현행 코드를 잘못 읽은 것이다. `--cd` 도 그대로 둔다 —
`-C` 로 바꿀 이유가 없다. 그리고 현행에는 sprite-gen 에 없는 `-c model_reasoning_effort="high"`
가 있는데, 우리 고유 설정이므로 유지한다.

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

## 5. ①단계 상세 — base idle 잠금 게이트

> 범위: **base idle 1장을 확정**하는 것까지다. 방향별 앵커 생성은 ③ 이다(§8).
> base 는 identity 의 최초 truth 이며, 방향 앵커가 승인되면 **은퇴해 행 입력에서 빠진다.**

### 5.1 게이트의 성격

**차단형이다.** 베이스가 잠기기 전에는 상태 행 생성으로 넘어가지 않는다. "일단 이 정도면
됐다"는 통과가 아니다 — 드리프트는 행이 시작된 뒤에 커지기만 한다.

게이트 질문: *"이 이미지를 정본 베이스 대기 자세로 **잠글** 만큼 좋은가?"* (y/n)

`n` 이면 베이스 후보를 다시 생성·검토하고 재게이트한다.

### 5.2 잠금 기준 (전부 만족해야 통과)

| # | 기준 | 자동 검사 |
|---|------|-----------|
| 1 | 전신, 잘린 곳 없음 (머리~발이 프레임 안) | **가능** — 피사체 bbox 가 캔버스 가장자리에 닿는지 |
| 2 | 최종 비율·스타일이 **이미** 맞음 ("나중에 고친다" 금지) | 불가 — 사람 판단 |
| 3 | 픽셀아트 런이면 베이스가 진짜 픽셀아트 (균일 블록 피치 실측, AA 반투명 가장자리 없음) | **부분** — ① 은 AA 반투명 비율만. 피치 실측은 ⑤ 에서 검출기를 포팅한 뒤 붙인다 |
| 4 | 캐릭터시트/레퍼런스와 정체성 일치 | 불가 — 사람 판단 |
| 5 | 단일 명확한 대기 포즈, 의도한 카메라 방향, 작은 크기에서 읽히는 실루엣 | 불가 — 사람 판단 |
| 6 | 평면 크로마 배경 (또는 쉽게 키잉 가능) | **가능** — 테두리 링 분석(flat/transparent/heterogeneous) |

자동 검사(1·3·6)를 **사전 검사**로 돌려 실패 항목을 표시하고, 최종 y/n 은 사람이 누른다.
**자동 검사가 전부 통과해도 잠금이 자동으로 되지 않는다.**

**정정(계획 작성 중, 2026-08-16)**: 기준 5를 "부분 — 축소 후 실루엣 대비"로 적었으나
**사람 판단으로 옮겼다.** "작은 크기에서 읽히는 실루엣"의 결정론적 정의가 없다. 기준 1은
반대로 "부분"에서 "가능"으로 올렸다 — bbox 가 가장자리에 닿는지는 명확히 판정된다.

**기준 3의 한계 (① 구현 실측으로 확인, 2026-08-16)**: AA 비율만으로는 불완전한 정도가 아니라,
**우리 생성물에서는 아예 측정되지 않는다.** codex 가 만드는 PNG 는 `channels=3`,
`hasAlpha=false` 다. 알파가 없으면 `ensureAlpha()` 가 전부 255 로 채우므로 반투명 비율이 항상
0 이 되어 근거 없이 통과한다.

정본의 기준 3 은 **투명 배경 픽셀아트**를 전제한다. 크로마 배경 위에 그려진 이미지는 AA 가
알파가 아니라 색 블렌딩으로 나타나므로 알파만 봐서는 잡히지 않는다.

구현은 이를 조용히 통과시키지 않고 `unmeasured` 플래그로 드러낸다 — 차단하지는 않되 판정
근거가 없다는 사실이 보인다. 정본이 요구하는 "균일 블록 피치 실측"이 ⑤ 에서 붙기 전까지는
**사람이 확인해야 한다.**

### 5.3 잠금 이후의 소유권 규칙

```
identity truth = 승인된 방향 앵커 (③ 에서 생성)
motion truth   = 레이아웃 가이드 (+ 필요 시 basis/paired row)
base truth     = 방향 앵커를 만들 때만 사용, 이후 row 입력에서 제거
```

**베이스 재첨부 금지**가 핵심이다. 앵커가 생긴 뒤 상태 행에 베이스를 "보험으로" 다시 붙이면
모델이 정체성을 매번 다시 풀어야 하고, 앵커 워크플로의 목적이 무너진다(architecture.md §5).

우리 `handleMakeSpritesheet` 는 지금 참조 이미지를 매 행 호출에 첨부한다. 이 동작을 제거하고
**앵커만** 첨부하도록 바꾼다 — 실제 전환은 ④ 에서 일어난다.

원본 생성물은 잠금 결정을 감사할 수 있도록 보존하되, 행 입력으로는 다시 쓰지 않는다.

**base 는 down(정면) 기본자세 1장이다.** 정본의 체인 그림에서 base 는 방향 앵커의 원천일 뿐
그 자체가 앵커가 아니다.

### 5.4 저장 구조

앵커는 방향별로 하나씩 존재한다. DB `generations` 에 새 kind 를 추가하는 대신, **기존 행에
앵커 표식을 다는 방식**을 우선 검토한다 — 새 kind 는 `migrate.ts` + `schema.sql` +
`types/db.ts` 3중 동기화를 요구하므로(CLAUDE.md 참조) 비용이 있다. 최종 결정은 구현 시.

### 5.5 UI/UX — 신규 화면이 필요한 지점

①은 파이프라인 다섯 단계 중 **UI 변경이 가장 큰 곳**이다. 지금은 채팅 한 줄이 곧바로 시트
생성으로 이어지지만, 게이트가 생기면 베이스 후보를 보고 승인하는 단계가 들어간다.

필요한 요소는 베이스 후보 이미지 + 사전 검사 결과(§5.2의 자동 검사 항목) + 잠금/재생성이다.
다만 §3.3 방침에 따라 **화면을 미리 설계하지 않는다** — ① 파이프라인을 구현한 뒤 실제로 필요한
형태를 확인해 반영한다. `SpriteGenPanel` 확장인지 채팅 결과 카드인지, 별도 화면인지도 그때
정한다.

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
  chromaKey: {
    name: string; hex: string; rgb: [number, number, number];
    // auto 선택이 기록하는 근거 — 왜 이 키가 뽑혔는지 감사 가능하게
    score?: number; minSubjectDistance?: number; clearsEraseRadius?: boolean;
  };
  chroma: {
    mode: "rgb";               // ycbcr 은 옵트인, 기본 아님 (§1.1)
    keyThreshold: number;      // 기본 96
    unmixReach: number;        // 기본 4
    spillMaxFraction: number;  // 기본 0.005
  };
  states: Record<string, StateSpec>;
};
```

`chroma` 튜너블을 request 가 소유하는 이유는 추출기가 유효값을 여기에 **되쓰기** 때문이다 —
어떤 파라미터가 그 결과를 만들었는지 런마다 기록에 남는다.

#### 6.1.1 상태 등급과 프레임 수 대역 (`states-and-frames.md` 대조 후 추가)

②단계 구현 착수 전 `docs/states-and-frames.md` 를 읽고 확인한 것. 1~4차 개정 시점에는
이 문서를 대조하지 않아 아래가 스펙에 없었다.

**프레임 수 대역** — 프레임을 늘린다고 애니메이션이 부드러워지지 않는다:

| 프레임 수 | 정본 분류 |
|---|---|
| 4 | 단순 동작의 **기본 안정 범위** |
| 5 | 비루프 제스처가 대기 복귀 포즈를 필요로 할 때 허용 |
| 6 | 인간형 one-shot 기본값의 **보수적 상한** |
| 8 | hatch-pet 급 **고급 영역**. 컴팩트 마스코트·로코모션 행·명시적 실험에만 |
| 9, 12 | **기본값이 아니다.** 검증 런에서 중복 몸통·빈 프레임·슬롯 붕괴·추출 실패가 늘었다 |

사용자가 9 또는 12 를 요구하면 명시적 실험으로 돌리고 `duplicate-heavy`·`blur/merge`·
`extract-fail` 을 정직하게 보고한다. 정상 통과처럼 다루지 않는다.

**상태 등급**:

- **simple 안정** — `idle`(4f, loop) · `jump`(4f, non-loop) · `attack`(4f, non-loop) ·
  `wave`(4f, non-loop; 마지막 프레임이 의도적으로 1번으로 돌아갈 때만 5f)
- **simple 후보** — `talk` `blink` `bounce` `hurt` `celebrate` `magic_cast`.
  허용하지만 모션 QA 통과 전에는 pass 가 아니다
- **experimental** — `walk` `run` `frontwalk` `45_frontwalk` 및 모든 주기적 이동,
  정확한 발접지 교대·위상 대칭을 요구하는 방향 사이클

약한 walk/run 행을 simple MVP 산출물과 **같은 등급으로 조용히 승격하지 않는다.**
`classifyState`·`frameCountAdvice`(`request.ts`)가 이 판정을 수단으로 제공한다.

**우리 패널 기본값이 이 대역과 어긋난다** — `SpriteGenPanel.tsx` 의 `frames` 초기값은
8(정본 4), `seamlessLoop` 초기값은 true(정본은 idle 만), 동작 힌트는 걷기·달리기 8f
loop(정본 experimental) · 공격 6f(정본 4) · 점프 6f(정본 4) · 시전 8f 다. **②에서
고치지 않는다** — 실제 생성 결과 없이 바꿀 근거가 없으므로 §3.3 UI 체크포인트로 넘긴다.

**`normalizeStates` 의 의도적 이탈 1건**: 원본 `prepare.py:509` 의 `loop` 폴백은 무조건
`True` 라 `DEFAULT_STATES` 의 `attack`/`jump`/`wave`(`loop: false`)와 어긋난다. 우리는
`fps`·`action` 과 같은 규칙으로 `DEFAULT_STATES` 에서 채운다. 미지 상태에서는 원본과
동일하게 `true` 로 떨어진다.

`character.anchorGenerationId` 는 ①에서 잠근 앵커를 가리킨다. 베이스 이미지 ID 가 아니다.

**safe margin 기본값은 비례다.** 생략 시 축당 셀 치수의 **9.4% 내림**: 256→24, 128→12,
rect 192×208→18/19. 명시값은 절대값으로 그대로 이긴다. (1차 초안은 24를 상수로 적었다 —
오류였다.)

셀 기본값은 정사각 256. `256` 은 변수이지 숨은 상수가 아니며, 바꾸면 가이드·프롬프트·추출·
아틀라스를 같은 request 에서 다시 만든다.

**크로마 키 선택** — 소재색을 먼저 보고 고른다(`chroma-alpha.md` §Key selection):

| 소재색 | 키 | 이유 |
|--------|-----|------|
| 핑크/보라/마젠타 계열 (꽃, 씨앗봉투) | 그린 `#00FF00` | 마젠타 키에서 가장자리 블렌드가 실루엣 픽셀을 낭비 |
| **진한 빨강/크림슨/와인** (머리·의상) | 그린 `#00FF00` | **마젠타 인접** — 둘 다 R 이 높다 |
| 녹색/청록/올리브 | 마젠타 `#FF00FF` | |
| **파랑** | 마젠타 또는 그린 | 시안/블루 키를 피한다 |
| 핑크와 그린이 한 소재에 공존 | 더 크고 중요한 소재에서 먼 키 | 추출 후 **양쪽 생존을 검증**하고 `auto` 를 선호 |

하드 키 삭제는 키 주위의 **색거리 볼**(`key-threshold`, 기본 96)이다. 그 반경 안의 소재색은
위치와 무관하게 삭제된다.

**자동 선택은 단순 샘플링이 아니다.** 감지된 평면 불투명 크로마 배경을 소재 점수에서 제외한
뒤 남은 소재 픽셀로부터의 거리로 후보를 점수화하고, **더 안전한 후보가 있으면 최근접 소재
픽셀이 삭제 반경 안에 들어오는 키를 거부한다.** `score`·`min_subject_distance`·
`clears_erase_radius`·`background` 를 request 에 기록하고, 어떤 후보도 소재를 벗어나지 못하면
경고한다. 목적은 전체의 1% 미만인 작지만 결정적인 특징(눈, 보석, 귀 램프)이 **조용히
삭제되지 않게** 하는 것이다.

**사후 검증이 계약의 일부다**: 변환 후 소재색이 보존됐는지 확인한다. 색이 있어야 할 곳이
검게 나오거나 주요 색이 빠졌으면 키가 소재와 인접한 것이므로, 국소 보정이 아니라 **키를 바꿔
재생성**한다. 지금 우리가 `#00ff00` 고정에 가깝게 쓰는 것과 달라지는 지점이다.

**튜너블은 request 가 소유한다** — `chroma.unmix_reach`, `chroma.spill_max_fraction` 을
`SpriteRequest` 에 둔다. 추출기가 여기서 읽고, 유효값을 request 에 되써서 **무엇이 그 결과를
만들었는지 기록**한다.

### 6.2 레이아웃 가이드 렌더러

sprite-gen `draw_guide()` 의 이식. `frames × cellW` 캔버스에:

| 요소 | 색 | 두께 |
|------|-----|------|
| 배경 | `#f6f6f6` | — |
| 셀 테두리 (프레임마다) | `#333333` | 3px |
| safe margin 사각형 | `#2f80ed` | 2px |
| 셀 중앙 세로선 | `#b8c8e8` | 1px |

**구현에서 SVG 를 버렸다(2026-08-16).** 초안은 "SVG 문자열을 조립해 sharp 로 래스터화"였다.
통과 기준이 Python 출력과의 **픽셀 동일**인데 SVG 스트로크는 경로 중심 정렬이라 PIL 의
안쪽 정렬 사각형과 반픽셀씩 어긋나고 래스터라이저 AA 가 경계에 회색을 남긴다. 도형이 축 정렬
사각형과 수직선뿐이라 SVG 로 얻을 이득도 없다. **raw RGB 버퍼에 직접 채운다** — AA 자체가
없어 픽셀 동일이 정의상 보장된다. 실측으로 4개 케이스 전부 바이트 단위 동일을 확인했다.

재현해야 할 PIL 의미 3가지: `rectangle(outline, width)` 는 경계 **안쪽으로** width 픽셀 띠를
그리고 좌표는 **양끝 포함**이다. 그리는 순서가 겹침 우선순위다(바깥 테두리 → safe → 중앙선).
그리고 **원본의 비대칭 하나** — 중앙선 y 범위는 `marginY ~ height-marginY` 인데 safe 사각형의
아래 변은 `height-1-marginY` 라 선이 1px 더 내려간다(`prepare.py:840`). 의도인지 오프바이원인지
원본에 근거가 없으나 픽셀 동일이 기준이므로 그대로 재현한다.

기존 `generateGridTemplate`(shared.ts)과 역할이 겹친다. safe margin·중앙선 개념이 없고 호출
조건이 다르므로 **이 렌더러로 대체**하고 호출부를 옮긴다.

**모션 페이즈 가이드**는 ② 범위에서 제외한다. sprite-gen 에서도 8프레임 로코모션에만 적용되는
옵트인(`motion_phase_guides`)이고, 우리는 `pose-reference.ts` 에 유사 자산이 있어 통합 방식을
⑥에서 함께 정하는 편이 낫다.

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

**스타일을 텍스트로 재기술하지 않는다.** `pixel-unfake.md` §스타일의 SSoT:

> 프롬프트 텍스트로 체형·등신·볼살·아웃라인 굵기·디테일 밀도를 재기술하지 마라 — 텍스트가
> 레퍼런스와 경쟁해 identity 를 되돌린다. 행 프롬프트에는 **"첨부 레퍼런스를 정확히 따라라
> (밀도·비율·아웃라인·팔레트)" + 모션 서술 + 레이아웃/크로마 규칙만** 남긴다.

현재 `buildSpritePrompt` 의 거대 지시문(`walkCycleRule`, `singleDirWalkDir`, `actionAnimRule`
등)은 이 원칙에 정면으로 어긋난다 — 대부분 폐기된다. 남는 것은 모션 서술과 레이아웃·크로마
규칙뿐이다. **긍정 진술 먼저 → 구체적 Avoid 열거** 패턴은 금지 목록(7번)에만 적용한다
(gpt-image-2 에 CFG 네거티브가 없다는 제약은 그대로다).

**픽셀 밀도도 프롬프트가 지배하지 않는다.** image_gen 은 출력 크기가 ~1024px 급 고정이라
"작게 생성"이 불가능하고 "TRUE NxN grid" 문구만으로 밀도가 잠기지 않는다. 모델이 실제로
따라가는 것은 **첨부된 레퍼런스의 픽셀 블록 굵기**다. 픽셀 타깃 런이면 레퍼런스를 타깃
로지컬 해상도급의 진짜 저해상 도트로 준비해야 한다.

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

### 6.6 UI/UX — 기존 입력에서 파생, 다중 상태는 후속

`SpriteGenPanel` 은 이미 `subjectType`·`direction`·`frames`·`seamlessLoop`·`actionPrompt`·
`perspective` 를 받는다. `SpriteRequest` 는 이 값들에서 파생하고 나머지는 기본값으로 채운다:

| SpriteRequest 필드 | 출처 |
|---|---|
| `states[s].frames` | 패널 `frames` |
| `states[s].action` | 패널 `actionPrompt` |
| `states[s].loop` | 패널 `seamlessLoop` |
| `states[s].fps` | `DEFAULT_STATES` 의 상태별 값(idle 4 · attack/jump 8 · wave 6), 미지 상태는 6 |
| `cell` | 기본값 — 정사각 256, safe margin 비례(24) |
| `chromaKey` | 소재색 기반 선택 (§6.1) |
| `character.anchorGenerationId` | ①에서 잠근 앵커 |
| `character.description` | 앵커 생성 시 확정된 서술 |

**개념 차이 하나**: sprite-gen 의 `states` 는 여러 상태의 맵(idle/jump/attack…)이고, 우리
패널은 한 번에 한 동작이다. ②에서는 "상태 1개짜리 request" 로 다뤄 **패널을 건드리지 않고**
넘어간다. 다중 상태를 한 번에 받는 UI 는 §3.3 체크포인트로 남긴다 — ② 구현 후 실제로 필요한지
확인한다.

단계별 UI 영향 전체는 §3.3 표를 따른다. ⓪③④⑤⑥ 에도 각각 확인할 항목이 있으므로 "②만 없다"
는 서술은 정확하지 않다.

## 7. 검증 전략

**결정론 단계는 sprite-gen 을 기준 구현으로 삼아 픽셀 대조한다.** "코드상 맞아 보임"은 통과
근거가 아니다. 비결정 단계(생성)는 대조가 불가능하므로 방법이 다르다.

| 단계 | 대상 | 방법 | 통과 기준 |
|------|------|------|-----------|
| ⓪ | 회수 경로 | §4.5 참조 | probe 성공 + 실패가 에러로 드러남 |
| ① | 사전 검사 (피치·테두리 분산) | 알려진 픽셀아트/비픽셀아트 샘플 투입 | 분류 일치 |
| ② | 레이아웃 가이드 | 같은 `cell`·`frames` 로 Python `draw_guide()` 와 TS 렌더러 각각 실행 | **PNG 픽셀 동일** — raw RGB 버퍼 렌더 (§6.2). **실측 완료**: 4케이스 바이트 동일 |
| ② | `normalizeCell` (비례 margin 포함) | Python `normalize_cell()` 에 같은 입력 투입 | **기하 필드 동일** — 정사각·동일 margin 일 때만 붙는 레거시 `size`·`safe_margin` 키는 이식하지 않는다(읽는 쪽이 없다). **실측 완료** |
| ② | 크로마 키 자동 선택 | Python `choose_chroma_key()` 와 같은 PNG 로 대조 | 승자·`score`·`min_subject_distance`·후보 4종 전부 동일. **실측 완료** |
| ② | row 프롬프트 | Python `row_prompt()` 출력과 `diff` | Prompt Contract 7항목 누락 없음. **실측 결과 공백 1줄 외 완전 일치** (그 1줄은 이식하지 않은 `motion_phase_guides` 슬롯) |
| ③ | 방향 정규화·앵커 합성 | Python `normalize_directions`/`ensure_direction_anchors` 와 대조 | 키 순서·`action` 문자열 완전 일치. **실측 완료** |
| ③ | 생성 플랜 | Python `build_generation_plan` 과 구조 대조 | stage 순서·상태명·방향·미러 일치 (refs 인코딩은 의도적으로 다름). **실측 완료** |
| ③ | 방향 프롬프트 | Python `row_prompt()` 와 `diff` (방향 상태 4종) | 공백 외 완전 일치. **실측 완료** |
| ③ | 앵커 콘텐츠 크롭 | 실제 codex PNG 투입 | **알파 없는 raw 생성물에서는 bbox 가 셀 전체 — 크롭 무의미.** `sourceHasAlpha` 로 드러냄. 알파 부여 후 ①의 `subjectBBox` 와 좌표 일치 |
| 전체 | 회귀 | 기존 경로가 깨지지 않는지 | `pnpm test` 통과 |

**②의 미검증 항목 1건**: §6.5 의 "셀 치수 검증 실패(`frames × cellW` 가 codex 캔버스 한계
초과) → 생성 전 throw" 는 넣지 않았다. 한계값을 모른다 — ⓪ 검증에서 codex **출력**이
~1024px 급 고정으로 나왔을 뿐 입력 한계는 측정하지 않았다. ④에서 실측 후 넣는다.
모르는 상수를 지어내지 않는다.

Python 기준 출력 생성은 sprite-gen 의 `.venv` 를 그대로 쓴다(구성돼 있고 CLI 동작 확인함).
이 의존은 **개발·검증 시점에만** 있고 런타임·배포에는 없다.

### 7.1 Motion Continuity 게이트 (BLOCKING, ⑥ 이후)

정본은 이를 차단형으로 규정한다(`qa-motion.md`). **정적 QA 로는 부족하다** — 프레임 수가 맞고
알파가 깨끗하고 정체성이 일관돼도 애니메이션이 쓰레기일 수 있다. 모션을 **모션으로** 본다:
상태별 contact sheet + GIF 를 만들어 루프를 재생한다.

판정 기준:

- **주기적 이동(walk/run)** — 제자리 흔들림이 아니라 연속 이동으로 읽혀야 한다. 몸 리듬, 사지
  운동, 발 접지 안정성, 요청한 방향·속도가 전달되는지
- **실험적 경계** — walk/run/frontwalk/45-frontwalk 은 **기본 통과 상태가 아니다.** 생성은
  하되 모션 연속성을 깨끗이 통과하지 못하면 **실험적이라고 보고**한다
- **루프 이음매** — `loop: true` 상태는 마지막 프레임이 첫 프레임으로 흘러야 한다. 감기는
  지점의 눈에 띄는 점프는 실패
- **비루프 제스처** — attack/jump/hurt/wave 는 이음매가 아니라 시작·중간·끝 가독성으로 판정.
  프레임이 여럿이라는 이유로 **억지로 루프로 만들지 않는다**
- **인간형 주의** — 무릎·팔꿈치·엉덩이·손에서 디퓨전 드리프트가 가장 크다. **모든** 프레임을
  검토해 해부 파손·사지 증감·길이 변화를 본다. blob/creature 보다 엄격하게
- **독립 2차 의견**(인간형 권장) — GIF 를 별도 비전 세션에 넘겨 판정받는다

**실패 시 행을 재생성한다.** 국소 수정(그리기·리타이밍) 금지.

우리 대응: `SpriteCanvas` 의 애니메이션 재생·어니언스킨이 contact sheet/GIF 역할을 일부 하고,
`scripts/measure-gait-diff.mjs`(인접 프레임 하단 1/3 실루엣 diff)가 "제자리 흔들림"의 정량
탐지에 해당한다. 판정 기준을 `visual-integration-qa` 스킬에 추가해야 한다 — 현재 그 스킬에는
모션 판정 항목이 없다.

**기대치 조정**: 우리는 걷기·달리기에 가장 공을 들였고 포즈 가이드도 거기에만 붙어 있다.
원본은 그 상태들을 실험적으로 분류한다. 이식 후에도 walk/run 이 안정적으로 통과하리라 기대해서는
안 된다.

## 8. 후속 단계 개요

### ①②③은 아직 배선되지 않았다 — ④가 통합 단계다

`base-gate.ts`(①), `request.ts`·`chroma-key.ts`·`layout-guide.ts`·`row-prompt.ts`(②),
`directions.ts`·`generation-plan.ts`·`anchor.ts`·`anchor-image.ts`(③)는 만들어져 있고
테스트를 통과하지만 **호출부에 연결되어 있지 않다.** ④가 생성 흐름 자체를 교체하므로
지금 `spritesheet-handler.ts` 에 배선하면 ④에서 다시 뜯는다.

같은 이유로 다음 넷도 건드리지 않았다 — 전부 ④의 몫이다:

- 기존 `buildSpritePrompt` 의 거대 지시문(`walkCycleRule` 등) 제거 — 지금 지우면 현재
  생성 경로가 즉시 깨진다
- `generateGridTemplate` → 레이아웃 가이드 대체 (호출부가 함께 이동해야 한다)
- 패널 기본값 8프레임 → 4 조정 (§6.1.1, §3.3)
- `SpriteCanvas` 의 `frameOrder`/`excludedFrames` 를 `saveCuration` 으로 영속 (아래 참조)

**이 결정의 리스크**: 미배선 코드가 ①②③에 걸쳐 누적되어 ④⑤ 전까지 사용자에게 보이는 변화가
없다. ④ 통합 시점에 인터페이스 불일치가 한꺼번에 드러날 수 있다.

**④는 순수 모듈 추가 단계가 아니다.** 첫 Task 가 반드시 다음이어야 한다:

1. `SpriteCanvas` 가 `frameOrder`/`excludedFrames` 를 `saveCuration` 으로 영속
2. 앵커 지정 UI(프레임 카드의 핀) → `pinAnchorFrame`
3. `spritesheet-handler` 가 `buildGenerationPlan` 순서대로 생성 (stage 1 → stage 2)
4. 액션 행 refs 에 base 가 없음을 런타임 검증 (`PlanRef.kind` 로 기계 확인)
5. codex 실왕복 1회 — 방향 앵커 1장 + 액션 행 1개
6. **상태 앵커 게이트**(정본 체크리스트 3번) — 비로코모션 상태마다 대표 포즈 앵커를
   행 생성 전에 만든다. ③ 범위에 넣지 않았으므로 ④에서 놓치지 말 것.
   로코모션에는 단일 피크 포즈 앵커를 **넣지 않는다** — 모든 프레임이 같은 다리 위상으로
   고정된다. 양쪽 접지가 다 보이는 contact sheet/선택 사이클/레이아웃 페이즈 가이드가 필요하다.

### ③ stage 1 — 방향 앵커 체인

정본 체인(`directional-anchor-workflow.md`):

```
base 1장 (down/정면)
  → base 를 ref 로 방향별 idle "행" 생성        ← stage 1
  → 그 행의 curated head 1장을 크롭 = 앵커
  → 이 시점부터 base 은퇴 (행 생성에 재부착 금지)
```

**앵커는 정확히 1장의 단일 포즈 이미지다(앵커 = 1장).** 다프레임 idle 행은 유효한 앵커가
아니다 — 행을 붙이면 모델이 프레임 간 미세 모션을 identity 분산으로 읽어 facing 잠금이
희석된다(수홍 확정 2026-07-12, hero 5-anchor 사고).

**어느 프레임이 앵커인가** — 손으로 고르지 않는다. 규칙이 코드로 정해져 있다:

- 기본: `<dir>_<anchor_suffix>` 의 **curated sequence head** — 재생 시퀀스의 첫 프레임이며
  **index 0 이 아니다.** 프레임을 제외·재정렬하면 앵커가 따라 움직이므로, 아카이브된 편집 전
  프레임이 앵커가 될 수 없다
- override: 사람이 뷰에서 핀한 프레임. 재생 시퀀스 밖의 후보 프레임도 허용된다 — 가장 좋은
  facing 포즈가 늘 idle 시퀀스 안에 있지는 않다
- 핀이 사라진 인스턴스를 가리키면 **하드 에러**다. 조용히 기본값으로 돌아가지 않는다
- 핀의 행이 재생성됐어도 **하드 에러**다(`pick-stale-generation`). 같은 index 가 다른 이미지가
  되므로, 사람이 본 적 없는 프레임이 방향의 identity 가 되는 것을 막는다. 핀은 재스탬프도
  드롭도 하지 않고 stale 로 표시해 한 번의 재선택으로 풀게 한다
  (**우리 구현에서는 이 두 오류가 하나로 합쳐진다** — 아래 구현 결과 참조)

**앵커 파일은 파생 캐시다.** 큐레이션 뷰가 보여주는 그대로(픽셀 편집 → 변형 → 재양자화) 굽고,
**매 생성 직전에 다시 굽는다** — 뷰에서의 나중 편집이 파일을 조용히 무효화한다. 근거: 승인된
identity 는 사람이 화면에서 승인한 것이고, 편집 전 raw 에서 생성하면 승인 전 모습이 모든 하류
행에 샌다.

**미러 방향은 생성을 생략하는 것이 기본이다**(`--mirror left=side`). 런타임 미러이며 그 사실이
계약으로 기록된다. 미러가 부족해 재생성할 때만 반대편 행을 timing/scale 참조로**만** 붙이고
대상 방향 앵커를 새로 뽑는다. 미러는 관측 가능한 파생이지 조용한 폴백이 아니다.

#### 구현 결과 (2026-08-16)

`directions.ts`·`generation-plan.ts`·`anchor.ts`·`anchor-image.ts` 로 구현했다.
Python 대조 결과: 방향 정규화·앵커 합성 action 문자열 완전 일치, 생성 플랜 구조 일치,
방향 프롬프트 4종(`down_idle`·`down_walk`·`running-front-right`·`running-front-left`)
공백 외 완전 일치.

**우리 UI 에 이미 같은 사고가 있다.** [SpriteCanvas.tsx:319](../../../src/components/editor/SpriteCanvas.tsx)
가 `frameOrder`(재정렬) + `excludedFrames`(제외)로 정확히 큐레이션 시퀀스를 계산하고
재생·GIF·ZIP 이 전부 그것을 따른다. 즉 "index 0 을 앵커로 쓰면 된다"는 **우리 UI 에서도
틀린다.**

**그런데 그 큐레이션이 영속되지 않는다 — ④의 전제 조건이다.**

| 항목 | 현재 상태 |
|---|---|
| `frameOrder` | React state. `saveCorrected()` 가 시트 PNG 자체를 재배열해 파괴적으로 반영 |
| `excludedFrames` | React state. **영속되지 않는다** — 미리보기·내보내기 전용 |
| 앵커 지정(핀) | **없다** |

③은 DB 계약(`saveCuration`/`getCuration`/`pinAnchorFrame`/`clearAnchorPick`/`getAnchorPicks`)
만 만들었고 **쓰는 쪽이 없다.** ①의 `lockBaseGeneration` 과 같은 상태다.

**핀이 원본보다 단순하다(의도적 축소).** 원본 핀은 `{state, index}` + `state_revision` 이라
행 재생성 시 같은 index 가 다른 이미지가 되고, 그래서 `pick-stale-generation`·
`pick-unverifiable` 두 오류가 필요하다. **우리 핀은 `{generationId, index}`** 라 행을 다시
생성하면 새 id 가 나오고 낡은 핀은 정의상 존재하지 않는 행을 가리킨다 — 두 오류가
`pick-unknown-generation` 하나로 합쳐진다. *pending*(`no-anchor-row`·`row-not-generated`)과
*broken*(나머지) 구분은 그대로 유지했다.

**큐레이션 스키마를 처음에 틀렸다(2026-08-16 정정).** §11 이 `curation.md` 를 ③용으로
표시했는데 읽지 않고 구현해, `{order, excluded}` 라는 우리 UI state 모양을 그대로 저장했다.
정본 `curation.json` 은 다르다:

- **`selected`** — 재생 순서의 0-based 인덱스. **이것이 권위 필드다.** 선택과 순서를 한
  배열이 함께 표현한다. 없거나 비면 전체 프레임을 원래 순서로.
- `order` — 웹뷰 소유의 표시 배열(시퀀스 줄 + 후보 풀). 정본은 *"compose / state_plan
  ignore it and key off `selected`"* 라고 못박는다 — 화면 배열이 구운 결과를 바꾸지
  못하게 하기 위해서다.

`{selected, order?}` 로 고쳤다. `SpriteCanvas` 의 `frameOrder`·`excludedFrames` 에서
파생한 재생 시퀀스가 곧 `selected` 이므로 ④의 저장 시점에 굽는다.

**같이 드러난 공백**: 정본은 행별 `revision` 스탬프로 프레임 인덱스 공간이 바뀐 큐레이션
(재추출·리롤)을 걸러낸다. 우리에겐 그 스탬프가 없고 재추출은 `generationId` 를 바꾸지 않는다.
`selected` 가 프레임 수 범위를 벗어나면 조용히 필터링하지 않고 `curation-stale` 로
fail-loud 하게 했다 — 필터링하면 사람이 승인한 것과 다른 프레임이 시퀀스 헤드가 된다.

**이식하지 않은 큐레이션 필드**(전부 후속): `clones`(프레임 복제 = 홀드 프레임),
`transforms`(프레임별 어파인 — 우리 `SpriteCanvas.offsets` 가 dx/dy 부분에 해당),
`pixel_unfake` 2층 토글, `recolor.picked`, `run_revision`.

**저장 위치**: 큐레이션은 그 행의 `params.curation`, 핀은 **잠긴 base 의**
`params.anchorPicks[direction]`. ①이 "base 는 스코프당 딱 1장"을 강제하므로 run 스코프
메타데이터를 걸 유일하게 안정적인 자리다. `sprite_runs` 테이블 신설은 마이그레이션 3중
동기화 비용 때문에 미뤘다 — ④에서 run 이 실체를 가지면 옮긴다.

**콘텐츠 크롭이 raw 생성물에서 무의미하다(실측).** codex PNG 는 `channels: 3,
hasAlpha: false` 라 `ensureAlpha()` 가 전 픽셀을 255 로 채우고, 1254×1254 사과에서
`contentBBox` 가 **정확히 셀 전체**를 돌려줬다. ①의 AA 검사와 같은 함정이라 조용히
통과시키지 않고 `BakeResult.sourceHasAlpha` 로 드러낸다. 알파를 만든 뒤에는 정상 동작하며,
①의 `subjectBBox` 와 좌표가 정확히 일치했다((203,125)-(1050,1086)).

**`×8` 확대는 셀 크기 프레임을 전제한다.** 256px 셀 → 2048px 로 image_gen 이 읽을 수 있게
키우는 값이다. 1254px 급 raw 생성물에 그대로 걸면 1만 픽셀이 된다 — ④에서 추출된 프레임을
입력으로 쓰면 자연히 해소된다.

**방향 계약 런에서는 `STATE_REQUIREMENTS` 가 붙지 않는다(원본과 동일).** 키가 맨 상태명
(`walk`·`run`)인데 방향 계약 런의 상태는 `down_walk` 이라 매칭되지 않는다. 실측 확인:
`down_walk` → `STATE_REQ=0, suffix=0`. 즉 로코모션 anti-bobbing 지시("제자리 흔들림 대신
읽히는 사이클")가 **방향 런에서는 사라진다.** 원본의 동작이므로 그대로 뒀지만, 사용자의
원래 불만이 걷기·달리기 품질이었으므로 ④에서 실제 결과를 보고 판단할 항목이다.

### ④ stage 2 — action rows

각 행 = **자기 방향 앵커(identity) + 레이아웃 가이드(모션 슬롯)**. base·원본 refs 는 붙이지
않는다.

#### ④를 셋으로 쪼갰다 (2026-08-16)

| | 범위 | 상태 |
|---|---|---|
| ④a | 플랜 실행기 + 앵커 베이크 배선 + CLI + 구/신 비교 | **완료** |
| ④b | `spritesheet-handler` 배선, `SpriteCanvas` 큐레이션 영속, 앵커 핀 UI | 미착수 |
| ④c | 상태 앵커 게이트, 좌우 쌍 순서, 모션 contact sheet | 미착수 |

UI 배선을 첫 항목으로 뒀던 원래 진입 조건에서 **순서를 바꿨다**. ⓪①②③ 네 단계 동안 새
경로로 codex 를 한 번도 돌리지 않았고, 생성 품질은 Python 대조로 알 수 없기 때문이다.
④a 가 실왕복 + 비교를 먼저 하고 그 결과가 ④b·④c 우선순위를 정한다.

#### ④a 실측으로 드러난 것 (2026-08-16)

**codex 는 레이아웃 가이드의 픽셀 치수를 따르지 않는다.** 4프레임 256셀 = 1024×256(4:1)
가이드를 붙였는데 출력이 1774×887(2:1)이었다. `image_gen` 이 고정 종횡비만 내므로 4:1
스트립 자체가 불가능하다. 따르는 것은 **프레임 개수와 배열**이지 캔버스 치수가 아니다.
→ 셀 기하를 요청값이 아니라 **실제 출력에서 유도**한다(`measureSheet`). 요청 셀 폭으로
나누면 1774/256 = 7 이라는 없는 프레임 수가 나오고, 그 인덱스로 크롭하면 배경 조각이
앵커가 된다.

**나쁜 앵커 → 전면 드리프트가 인과로 실증됐다.** 위 버그로 앵커가 셀 좌상단 배경 조각으로
구워진 실행에서, 액션 행은 지팡이가 사라지고 얼굴·후드·의상이 통째로 바뀌었다. 기하를
고쳐 앵커가 온전한 단일 포즈가 되자 같은 프롬프트에서 정체성이 보존됐다.

**미해결 결함: safe margin 이 실제 셀과 무관하다.** 프롬프트가 요청 셀(256) 기준 24px 을
말하는데 실제 셀은 443px 이라 비율이 5.4% 로 떨어진다(정본 9.4%). 셀 경계 침범이 4/4
프레임에서 났다. **④b 착수 전에 고쳐야 한다.**

**`ANCHOR_SCALE=8` 은 256px 셀 전제다.** 443px 셀에 ×8 이면 3544px 이 된다. 정본 목표치
(256×8 = 2048)에 닿도록 배율을 잡고 8 을 상한으로 둔다(`anchorScaleFor`).

**프롬프트 통과 경로가 필요했다.** `buildSpritesheetPrompt` 가 우리 행 프롬프트를 자기 틀
("I am attaching TWO images: … GRID TEMPLATE")로 다시 감싸 계약이 둘이 된다. `codex-exec.ts`
에 `params.rawPrompt` 를 추가해 헤더만 붙이고 통과시킨다. 기존 호출부는 영향 없다.

**구 경로는 1×N 가로 행을 만들지 못한다** — `종횡비 초과 4.00:1 (한계 3:1)` 로 생성 전
거부. 구조적 차이(component-row vs 그리드)가 여기서 드러난다.

방향성 상태는 **체인 참조 계획이 기본**이다. 독립 생성은 명시적 실험으로만 허용하고 그렇게
표기해야 한다.

로코모션 패턴(hatch-pet): `running-right` 를 먼저 생성해 검사한 뒤 `running-left` 를 만들고,
그때 `raw/running-right.png` 를 **gait 리듬 참조로만** 붙인다 — identity 는 여전히 앵커가
소유한다.

### ⑤ 추출 교체

**기본 경로**(우리가 이식할 대상):

1. **하드 키 컷** — 키로부터 `key_threshold`(기본 96) 색거리 볼 안의 픽셀과 이미 투명한 입력을
   삭제. **alpha=0 픽셀은 RGB 를 `(0,0,0)` 으로 지운다** — 헤일로 방지
2. **소프트 알파 언믹스** — 키 틴트가 낀 경계 블렌드를 despill RGB + **부분 알파**로 분리.
   블렌드 모델 `observed = (1-k)·subject + k·key` 를 키 틴트 점수에서 푼다. 안티앨리어싱된
   실루엣이 이진 계단으로 붕괴하지 않고 커버리지 램프를 유지한다. in-band 는 key-distance
   `<= 2`, out-of-band 는 `unmix_reach`(기본 4)
3. **트랩된 스필 despill** — 소재의 `spill_max_fraction`(기본 0.005) 이하 크기의 연결
   클러스터에 강하게 틴트된 픽셀이 하나 이상 있으면 위치와 무관하게 생성기 스필로 보고
   **제자리에서 색만 보정**(알파 유지 → 핀홀 없음). 큰 키 틴트 영역은 의도된 소재이므로 건드리지
   않고, 약간 따뜻한 소재색(피부)은 자격이 없다
4. **connected components** — 포즈 덩어리 탐지, x-center 그룹핑
5. **`fit_to_cell`** — bbox 크롭 → 종횡비 유지 리스케일(`scale ≤ 1.0`) → 셀 배치

1차 초안은 3번(트랩된 스필 despill)을 빠뜨렸다.

**프레임 수 미달은 행을 차단한다.** *"If component extraction cannot find the declared frame
count, the row is blocked."* 슬롯 폴백은 명시적 디버깅 전용이며 `slots-explicit` 으로 보고해야
하고 기본 경로가 아니다.

이것이 우리와의 가장 큰 행동 차이다. 우리는 격자로 강제 분할하므로 **추출이 항상
"성공"한다** — 캐릭터가 3개만 그려져도 8칸으로 잘라 8프레임이라 보고한다. 실패가 조용히
넘어가는 경로이며, "매번 실패"가 진단되지 않은 이유일 수 있다.

**실패는 원자적이다.** 실패한 추출은 `frames/` 에 **아무것도 발행하지 않는다**(부분 생성
금지). 재추출 실패는 직전 완전 생성을 바이트 그대로 남긴다. 실패 신호는 `frames/` **밖**에
per-state 로 기록해 관측 가능하게 유지하고, 자동 교정 루프가 그것을 소비해 재생성을 유도한다.

**옵트인(픽셀아트 런일 때만)** — `fit.pixel_unfake`:
피치 검출(소수로 측정, 정수 반올림 금지) → 위상 실측(`_best_phase`, 축별 8단계) → 그리드 스냅
→ kCentroid → run-wide 공유 팔레트(프레임 간 색 깜빡임 제거) → 알파 이진화 → 정수 NEAREST
셀 업스케일. 적용 여부는 **사람이 줄 단위 체크박스로 결정**한다(§10 참조).

**단순 다운스케일 쇼트컷은 금지다.** raw 를 `resize()` 한 줄로 줄여 최종 경로에 놓는 것은
픽셀 언페이크 변환이 아니다 — AA 가장자리 열화와 그리드 미정렬이 남는다.

기타 옵트인: `segmentation: "projection"`(융합 포즈 복구), `chroma.mode: "ycbcr"`(열화된 소스).
**둘 다 기본이 아니다** — §1.1.

### ⑥ 아틀라스 + 런타임 매니페스트

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
있다.** 편집 결과가 반영된 산출물과 편집 전 산출물을 구분하는 경계를 ⑥에서 명시해야 한다.

## 9. 라이선스

sprite-gen 은 Apache-2.0(Copyright 2026 Alex Kim)이다. 이식 시:

- 포팅한 파일 헤더에 출처와 Apache-2.0 고지를 남긴다
- `NOTICE` 파일을 우리 저장소에 추가하고 sprite-gen 의 NOTICE 내용을 승계한다 — 특히
  perfectpixel-studio(MIT, Copyright Andrew Kim)에서 온 부분(`align_x: alpha-centroid`,
  `segmentation: projection`, `chroma.mode: ycbcr`)의 이중 고지
- `codex_provider.py` 는 image-gen 스킬(MIT, aldegad/image-gen)에서 포팅된 것이므로, ⓪ 이식
  시 그 계보도 함께 고지한다
- 이 저장소는 공개 저장소이므로 고지 누락은 라이선스 위반이 된다

## 10. 결정된 사항 / 미해결

### 결정 — 픽셀 언페이크는 조건부 옵트인, 사람이 결정

사용자 결정(2026-08-16): **픽셀아트를 목표로 하지는 않지만, 픽셀아트로 생성된 시안에서
시작하면 필요하다.**

이는 sprite-gen 의 설계와 일치한다. `fit.pixel_unfake` 는 옵트인이고, `pixel-unfake.md`
§역할 계약은 **적용 여부를 사람이 체크박스로 결정**한다고 규정한다. 토글은 **줄(state) 단위**이며
그 줄의 표시와 굽기를 함께 결정한다.

우리 구현:

- 기본은 **끔**. `fit` 없는 legacy 경로(lanczos, foot-centroid)로 간다
- ①단계 베이스 잠금 게이트의 자동 검사(§5.2 기준 3 — 균일 블록 피치 실측, AA 반투명 가장자리
  없음)가 베이스를 픽셀아트로 판정하면 **체크박스 기본값을 켬으로 제안**한다. 판정이지 강제가
  아니다
- 최종 결정은 사람이 누른다
- 적용 단계는 **row 추출뿐이다**. 베이스/앵커는 가공 없이 원본을 쓴다 — 베이스는 행의 identity
  truth 이므로(`pixel-unfake.md` §Stage ownership)
- 픽셀 언페이크로 잠근 판을 다시 앵커로 투입하지 않는다 — 이중 열화로 얼굴·디테일이 뭉개진다.
  베이스 raw 가 이미 그리드 인식 생성물이면 그 raw 가 최상의 앵커다

### 미해결

- **전/후 쌍둥이 저장 여부** — sprite-gen 은 `frame-N.png`(pp 적용, canonical) +
  `frame-N.plain.png`(셀 크기, 굽기용) + `orig/frame-N.png`(고해상, 표시용) 3벌을 남겨 토글이
  크기 변화 없이 품질만 비교하게 한다. 우리 DB·파일 레이아웃에 어떻게 앉힐지는 ⑤에서 결정
- **앵커 저장 구조** — 새 DB kind 추가(3중 동기화 비용) vs 기존 행에 표식. §5.4
- **기존 생성물 호환** — 이미 만든 시트를 새 매니페스트로 옮길지, 격자 해석을 유지할지. ⑥
- **모션 페이즈 가이드** — `pose-reference.ts` 자산과 `motion_phase_guides` 의 통합 방식. ⑥
- **`isLocomotion` 분기의 운명** — row 프롬프트가 상태별 요구사항을 소유하면 키워드 매칭
  분기의 필요성이 줄어든다. ② 구현 중 판단.
- **타임아웃 600초의 근거** — ⓪ 구현 후 실측으로 조정. §4.1

## 11. 원본 문서 대조 상태

**읽고 대조 완료**:

- `SKILL.md` 전체 — 필수 게이트, Base Lock Gate, SSoT, Prompt/Output/Runtime Contract, QA
- `docs/architecture.md` §1~§5
- `docs/chroma-alpha.md` — 키 선택 분기표, `auto` 거부 로직, 3패스 알파 정리, ycbcr 옵트인
- `docs/pixel-unfake.md` — `fit` 기본값, 역할 계약, 스타일 SSoT, 픽셀 밀도 규칙, 전/후 쌍둥이
- `docs/qa-motion.md` — Motion Continuity 판정 기준 5가지
- `docs/run-contract.md` §1(스테이지 표), §6~§7(실패 원자성, 동시성 경계)
- `docs/directional-anchor-workflow.md` §1~§139 — 앵커 체인, 앵커=1장 규칙, curated head,
  핀 stale 판정, 미러 계약 (4차 재편 근거)
- `sprite_gen/gen/codex_provider.py`, `gen/base.py` — ⓪ 근거
- `docs/directional-anchor-workflow.md` §139~318 — 실패 처리, 좌우 게이트, Advanced Gates (③)
- `docs/states-and-frames.md` — simple/experimental 등급, 프레임 수 대역 (② §6.1.1)
- `docs/curation.md` — `curation.json` 스키마, 완성 시트 편집 경로. **③ 후에 읽어 스키마
  오류 1건을 정정했다**(§8 ③ 구현 결과)
- `docs/locomotion-curation.md` — motion-phase 실험, 수동 selected-cycle, 클린 GIF (④)
- `docs/gen.md` — provider 계약, codex 플래그, `--transparent` fail-loud (⓪ 사후 확인:
  우리 codex 인자가 정본과 일치)
- `docs/locomotion-curation.md` — motion-phase 실험, 수동 selected-cycle, 클린 GIF 불변식 (④).
  **정본도 인간형 로코모션을 자동으로 풀지 못한다** — *"the most reliable path is candidate
  generation plus human frame picking"*. 우리 `SpriteCanvas` 의 프레임 제외·재정렬이 그 경로다

**미독**:

- `docs/run-contract.md` §2~§5 — 폴더 계약, 표시 계약, 임포트 규칙 (⑥ 착수 전)
- `docs/recolor.md`, `docs/sheet-slicing.md`, `docs/frame-interpolation.md`,
  `docs/static-pose-recipe.md`, `docs/troubleshooting.md` — 범위 밖 또는 후속

1·2차 초안이 정본을 읽지 않아 오류 12건이 났다. 3차에서 leaf 문서를 대조해 추가로 7건을
바로잡았다. **미독 문서가 남은 단계의 스펙을 쓸 때는 먼저 읽는다.**

이 규칙을 ③에서 한 번 어겼다 — 위 목록이 `curation.md` 를 ③용으로 표시했는데 읽지 않고
구현해 큐레이션 스키마의 권위 필드를 반대로 잡았다(`{order, excluded}` vs 정본 `selected`).
④ 착수 전 읽은 뒤 정정했다. **표에 단계가 적힌 문서는 그 단계 착수 전에 읽는다.**
