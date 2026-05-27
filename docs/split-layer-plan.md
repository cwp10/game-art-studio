# 레이어 분리(split layer) 전면 수정 계획

> 상태: **검토 완료 — 경로 3(반자동)은 이미 구현됨. 전면 수정(개선) 가능.** (2026-05-27 작성)
> AetherAI "Layer Separation" 참고. 결론: 새로 만들 필요 없음, 기존 LayerCanvas 개선.

## 핵심 사실: 경로 3은 이미 end-to-end로 존재
이 프로젝트엔 이미 **"🎨 레이어 분리"(LayerCanvas)** 기능이 있고, AetherAI Split Layer 의
핵심(부위 분리 + 가림 복원)을 이미 한다:

- **`src/components/editor/LayerCanvas.tsx`** — 8색 브러시로 부위 페인팅, 두 모드:
  - `crop`: 색별 `원본 × binary mask` → 부위 컷아웃 PNG (가림 복원 없음)
  - `inpaint`(⚡AI 복원): 색별로 "다른 부위가 가린 영역"을 red 마스크로 → codex inpaint 호출 →
    **가려진 부분을 AI가 복원** (= AetherAI "Hidden parts recreated by AI")
- **`src/components/chat/ChatLayout.tsx`** `handleLayerSplit` — crop은 `/api/layers`(N개 generation 행),
  inpaint는 색별 `uploadMask` + inpaint("빨간 영역을 자연스럽게 복원"). `action:"layer_split"` 진입.
- **`/api/layers/route.ts`**, `uploadMask`/`uploadLayers`(`src/lib/api/client.ts`) 모두 존재.

→ **경로 3 = 신규 구현 아님. 기존 기능 개선("전면 수정")으로 충분.**

## AetherAI 대비 격차 = 전면 수정 범위
| AetherAI Split Layer | 현재 LayerCanvas | 수정안 |
|---|---|---|
| 부위에 시맨틱 라벨(HEADBAND/FACE/BODY/EYES) | 일반 색(빨강/초록…) | 색마다 **사용자 라벨/이름** 입력 |
| 부위 자동 감지 | 수동 페인팅 | 경로 3 범위 밖(자동=경로 2 분할모델). 단 "AI 부위 추천" 보조는 검토 |
| 깔끔한 분리 레이어 스택 뷰 | 2열 썸네일 그리드 | **exploded 레이어 스택 뷰** + z-order |
| 가림 복원 | inpaint 모드로 구현됨 | 프롬프트/품질 개선, z-order(위/아래) 반영 |
| — | — | 레이어 재합성 미리보기, 이름 기반 PNG 내보내기 |

## 전면 수정 항목 (경로 3 한정)
1. **시맨틱 라벨**: 8색 각각에 텍스트 라벨(머리띠/얼굴/몸/눈…) 부여. inpaint 복원 프롬프트에
   부위명을 넣어 복원 품질↑ ("body 영역을 몸통의 자연스러운 연속으로 복원").
2. **z-order(겹침 순서)**: 어떤 부위가 위/아래인지 지정 → inpaint 시 "위 레이어가 가린 아래 레이어"만
   복원하도록 마스크 생성 로직 정교화 (현재는 "다른 모든 색"을 일괄 red).
3. **결과 뷰 개선**: exploded 스택 + 재합성 미리보기 + 레이어별 이름/순서 표시.
4. (선택) **AI 부위 추천 보조**: codex 에 "이 캐릭터의 분리 가능한 부위 나열" 요청 → 라벨 프리셋 제안.
   자동 마스킹은 아님(그건 경로 2).

## 파일별 변경 (기존 개선)
1. `src/components/editor/LayerCanvas.tsx` — 라벨 입력 UI, z-order, exploded 결과 뷰, inpaint 마스크 로직 정교화.
2. `src/components/chat/ChatLayout.tsx` `handleLayerSplit` — 라벨/순서를 inpaint 프롬프트에 반영.
3. (필요 시) `/api/layers/route.ts` — 라벨 메타 저장.
4. `src/lib/api/client.ts` — uploadLayers 시 라벨 전달.

## 경로 3의 한계 (정직)
- **부위 자동 감지는 안 됨** — 사용자가 칠해야 함. 완전 자동·고품질은 분할 모델(경로 2, SAM류) 필요.
- inpaint 복원은 codex 생성형이라 부위별 1회 호출(시간 N배·구독 차감) + 복원 결과가 원본과 미세하게 다를 수 있음.
- 이미 동작하므로 위험 낮음 — 전면 수정은 UX/품질 개선 중심.

## 검증 계획
캐릭터 1장으로: 부위 3~4개 라벨 페인팅 → AI 복원 → 각 레이어가 가림 없이 완전한지 + 재합성 시 원본과
일치하는지 육안 확인.
