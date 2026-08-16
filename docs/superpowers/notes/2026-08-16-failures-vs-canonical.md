# 구현 중 실패 사례 ↔ 원본 대조 (2026-08-16)

원칙: **원본 로직을 최대한 따르고, 잘 안 되면 원본과 대조해 원인을 찾는다.**
그 원칙으로 ⓪~④a 구현 중 나온 실패·이탈을 전부 다시 확인했다.

## 결론 먼저 — 실패 5건이 한 뿌리다

sprite-gen 의 추출 진입점(`extract.py:2953-2963`):

```python
strip = _load_strip(...)          # raw → remove_chroma_background → 알파 생성
                                  #     → separate_fused_poses (projection 옵트인)
frames = extract_component_frames(strip, frame_count,
                                  cell_width, cell_height, safe_margin_x, safe_margin_y, fit)
method = "components"
if frames is None:
    if not args.allow_slot_fallback:
        all_errors.append(f"{state}: could not extract {frame_count} sprite components")
        continue                  # ← 행 차단
    frames = extract_slot_frames(...)   # 그리드 슬롯 등분
    method = "slots-explicit"
```

그리고 `extract_component_frames` 는:

```python
images = extract_component_images(strip, frame_count)   # 컴포넌트로 frame_count 개
if images is None: return None                          # 못 찾으면 차단
return [fit_to_cell(img, cell_width, cell_height, safe_margin_x, safe_margin_y, fit) ...]
```

**여기서 세 가지가 따라 나온다:**

1. **알파는 추출의 첫 단계에서 생긴다.** raw 는 크로마 배경째로 들어오고
   `remove_chroma_background` 가 RGBA 로 만든다.
2. **request 의 `cell`·`safe_margin` 은 추출의 *출력 규격*이다.** 입력 raw 의 치수와
   무관하다. `fit_to_cell` 이 컴포넌트를 그 규격에 맞춰 넣는다.
3. **그리드 등분(`extract_slot_frames`)은 명시적 옵트인 폴백**이며 결과에
   `method = "slots-explicit"` 로 표기된다.

> **우리는 지금 원본의 `--allow-slot-fallback` 경로를 기본으로 쓰고 있다.**
> 원본이 "이걸 쓰면 표기하라"고 못박은 폴백이 우리의 유일한 경로다.

## 사례별 대조

| # | 우리가 겪은 것 | 원본은 | 판정 |
|---|---|---|---|
| 1 | ① AA 검사가 알파 없는 base 에서 측정 불가 | base 는 원본도 크로마 배경이다. SKILL.md 의 "AA 반투명 가장자리 없음"은 **사람 판정 기준**이지 자동 검사가 아니다 | **이탈 아님.** 우리가 자동화하려다 부딪힌 것. `unmeasured` 표기가 정직한 처리 |
| 2 | ③ 앵커 콘텐츠 크롭이 raw 에서 무의미 (bbox = 셀 전체) | `bake_frame` 은 `frames/`(추출 완료, 알파 있음)에서 읽는다. raw 에서 굽지 않는다 | **아키텍처 이탈.** 추출 전에 앵커를 굽고 있다. ⑤가 붙으면 해소 |
| 3 | ④a codex 가 가이드 치수를 안 따름 → `measureSheet` 로 셀 기하 유도 | **raw 치수에 의존하는 개념 자체가 없다.** 컴포넌트를 찾아 request cell 에 넣는다 | **불필요한 발명.** 그리드로 자르니까 필요했던 것. ⑤ 이후 `measureSheet` 는 제거 대상 |
| 4 | ④a 셀 경계 침범 4/4 | components 는 그리드를 안 본다. 이웃과 닿으면 **컴포넌트 병합**으로 나타나고, 대응은 옵트인 `projection` 세그먼테이션(투영 최적 절단 → 투명 거터 → 재조립, `segment.py`) | **프롬프트 문제가 아니다.** px→비율 변경 시도는 되돌렸다 |
| 5 | ④a `ANCHOR_SCALE=8` 이 443px 셀에 과함 → `anchorScaleFor` 클램프 발명 | `ANCHOR_SCALE = 8` 고정, 클램프 없음. **원본 셀은 항상 request cell(256)이라 8배가 2048 로 딱 맞는다** | **사례 3의 파생.** 추출이 붙으면 셀이 256 이 되어 클램프가 불필요. 제거 대상 |
| 6 | ④a `params.rawPrompt` 통과 경로 추가 | `sprite-gen gen --prompt-file prompts/<state>.txt` — 행 프롬프트를 그대로 보내고 provider 헤더만 붙는다 | **원본과 일치.** 구조적 등가물. 유지 |
| 7 | ② `normalizeStates` 의 `loop` 폴백을 `DEFAULT_STATES` 기준으로 바꿈 | `bool(entry.get("loop", True))` — 무조건 `True` | **의도적 이탈.** 원본 내부 불일치를 고친 것(`DEFAULT_STATES.attack.loop = False` 인데 폴백은 True). 원칙상 재검토 대상 — 아래 참조 |
| 8 | ③ 큐레이션 스키마를 `{order, excluded}` 로 만듦 | `selected` 가 권위 필드, `order` 는 표시 전용 | **이미 정정** (`{selected, order?}`) |
| 9 | ④a 프레임 수 미달을 경고로만 처리 | `could not extract N sprite components` → **행 차단**. 폴백은 명시 옵트인 | **원본은 차단한다.** 우리는 셀 수단이 없어 못 한다. ⑤에서 차단으로 바꾼다 |
| 10 | `test-base-gate` 가 실 DB 상태에 의존해 깨짐 | 해당 없음 (우리 테스트 문제) | 고침 |

## 사례 7 — 판단이 필요한 유일한 항목

원본 `normalize_states` 는 `loop` 폴백이 무조건 `True` 인데, 같은 파일의
`DEFAULT_STATES` 는 `attack`/`jump`/`wave` 를 `loop: False` 로 정의한다.
`states-and-frames.md` 도 "attack/jump/wave 는 non-loop"라고 적는다.

즉 **원본 안에서 두 곳이 어긋난다.** 우리는 `fps`·`action` 과 같은 규칙으로
`DEFAULT_STATES` 를 참조하게 했다(`loop` 생략 시 attack → false).

- 원본을 글자 그대로 따르면: 폴백을 `true` 로 되돌린다. 대신 `{attack: {frames: 4}}`
  같은 부분 지정에서 문서와 다른 결과가 나온다.
- 원본의 *의도*를 따르면: 지금이 맞다.

**현재는 후자를 유지하고 있고 스펙 §6.1.1 에 이탈로 기록돼 있다.**

## 같이 발견한 스펙 오류 1건

스펙 §1.1 과 §11 이 크로마 알파 정리를 **"3패스"** 라고 적는다. `sheet-slicing.md`
의 Alpha ownership 절은 **4패스**라고 명시한다:

> the same v1.13 **4-pass** chain the row pipeline uses (hard key cut →
> **key-depth in-band unmix** → soft-alpha unmix → trapped-spill despill)

v1.13 에서 `key-depth in-band unmix` 가 추가됐다. `remove_chroma_background` 는
`np.select` 분류 + 키 영역까지의 **체비셰프 거리 변환**(`depths`)을 쓴다 — 이 거리가
in-band unmix 의 근거다. 스펙을 4패스로 고쳐야 하고, ⑤ 이식 범위에 이 패스가 포함된다.

## ⑤ 착수 시 제거·교체 목록

| 대상 | 처리 |
|---|---|
| `run-plan.ts` `measureSheet` | **제거.** 추출이 raw 치수를 무관하게 만든다 |
| `run-plan.ts` `anchorScaleFor` | **제거.** 셀이 256 이면 `ANCHOR_SCALE=8` 그대로 |
| `RunPlanRow.cell` | **제거.** request.cell 이 다시 유일한 셀 규격이 된다 |
| `anchor-image.ts` 의 시트+셀 크롭 입력 | **교체.** 추출된 프레임 파일을 읽는다 (원본 `bake_frame` 과 같은 위치) |
| 프레임 수 미달 경고 | **차단으로 승격.** 컴포넌트 개수 불일치 = 행 실패 |
| `bakeAnchorImage.sourceHasAlpha` 경고 | **불필요해짐.** 입력이 항상 알파를 갖는다 |

이 목록은 ④a 가 임시방편을 쌓았다는 뜻이 아니라, **추출이 없는 상태에서 그리드 폴백으로
파이프라인을 끝까지 돌려보려면 필요했던 비계**라는 뜻이다. 비계는 ⑤에서 걷는다.
