# 캐릭터 오버레이(character overlay) 기능 구현 계획

> 상태: **검토 완료(가능), 구현 대기** (2026-05-27 작성)
> AetherAI "Character Overlay" 이식. **리스킨([[reskin-feature-plan]] / docs/reskin-plan.md)과 자매 기능** — 같은 2-이미지 img2img 백엔드 공유.

## 대표 유스케이스 (AetherAI 참고 이미지)
"Character Overlay — Same animations, new skin! Combine the sprite sheet and character":
1. **BASE 스프라이트시트 (마네킹)** — 표정·머리·복장 없는 중립 캐릭터 애니메이션 시트
2. **CHARACTER (단일 캐릭터 이미지, 예: 빨간머리 소녀)** — 완성된 캐릭터 1장
3. → **NEW 스프라이트시트** — 베이스의 **포즈는 그대로**, 2번 캐릭터의 외형(머리·얼굴·복장)이 모든 프레임에 입혀짐

## 리스킨과의 관계 (중복 구현 방지)
| | 입력 | 매핑 |
|---|---|---|
| **Reskin** | 시트 + **텍스트** 스킨 묘사 | reskin 계획 모드 (a) |
| **Character Overlay** | 시트 + **캐릭터 이미지**(2이미지) | reskin 계획 모드 (c) 참조 전이 |

→ Character Overlay = reskin 의 **2-이미지 입력 경로**와 동일. 별도 도구를 새로 만들기보다
`reskin_image(inputGenerationId=베이스시트, styleReferenceId=캐릭터참조)` 를 **재사용**하고,
UI에서 "캐릭터 오버레이" 액션이 그 경로를 호출하도록 노출하는 것을 권장.

## 사전 조사 결론 (코드베이스 사실)
- **codex img2img 다중 입력 지원** — `[baseSheet, characterRef]` 2장 입력 가능
  (spritesheet=`[grid, ref]`, inpaint=`[orig, mask]` 와 동일, `overrideInputPaths`).
- **스프라이트시트 후처리 재사용** — 생성 후 `resize → chromaKeyGreenFile → normalizeSpritesheetCells`.
  grid 는 치수에서 `detectSpriteGrid`(SpriteCanvas.tsx) gcd 역산.
- M3 오케스트레이션 동작 중 → 새 경로는 ①MCP 도구/파라미터 ②`allowedTools` ③오케스트레이터 프롬프트.

## 설계 (reskin_image 재사용안)
파라미터: `reskin_image(inputGenerationId, styleReferenceId, sessionId)` — prompt 없이 styleReferenceId 만 주면 "캐릭터 오버레이" 모드.

백엔드 프롬프트 템플릿 (codex-exec.ts `kind:"reskin"`, 2이미지 분기):
```
Image 1 = base sprite sheet. KEEP its EXACT poses, grid/cell layout, frame count,
and per-cell framing unchanged. Image 2 = character design reference.
Render image 2's character (hair, face, outfit, colors, identity) in EVERY pose of
image 1, one per cell. Same animations, identical character across all frames.
Each frame's full content stays within its own cell (effects/capes included).
```

## 파일별 변경 (reskin 구현에 포함되거나, 그 위에 얹음)
1. `src/lib/mcp/server.ts` — reskin_image 핸들러의 styleReferenceId 경로
   (입력 kind==spritesheet → 후처리 재사용, grid 역산).
2. `src/lib/image-backend/codex-exec.ts` — reskin kind 의 2-이미지 프롬프트 분기.
3. `src/app/api/chat/route.ts` — `mcp__imggen__reskin_image` allowedTools (reskin 과 공통).
4. `src/lib/prompt/system-orchestrator.md` — "캐릭터 오버레이/이 캐릭터를 이 시트에 입혀줘" → reskin_image + styleReferenceId 라우팅.
5. (선택) UI — ImageResultCard 또는 전용 패널: 베이스 시트 + 캐릭터 참조 선택 → 오버레이 실행.

## 핵심 리스크
- **프레임 간 캐릭터 정체성 일관성** (가장 어려움) — 16프레임에서 머리·얼굴·복장이 동일해야 하나
  gpt-image img2img 는 프레임마다 드리프트. 시트 전체 1패스로 완화하나 완벽 보장 불가.
- **포즈 보존** — img2img 는 픽셀-락이 아니라 재생성. 미세 드리프트 가능.
- **베이스 시트 품질 의존** — 베이스가 격자 안에 잘 정렬돼 있어야(=Option A 적용 생성) 결과가 깔끔.
  격자 넘는 베이스를 쓰면 오버레이도 깨짐.
- 픽셀 단위 포즈/정체성 고정이 필수면 ControlNet+IP-Adapter 류 필요(현재 백엔드 미보유).

## 단계 구분
- **Phase 1**: reskin_image 구현 시 styleReferenceId(2이미지) 경로 포함 → 캐릭터 오버레이 자동 지원.
- **Phase 2 (UI)**: 베이스 시트 + 캐릭터 참조를 고르는 전용 UI. 아래 [UI/UX 와이어프레임](#uiux-와이어프레임-phase-2) 참조.

## UI/UX 와이어프레임 (Phase 2)
> 2026-05-28 기획. 코드 미반영(기획 단계). **캐릭터 오버레이 = 리스킨([[reskin-feature-plan]] / docs/reskin-plan.md) 모드(c) 참조 전이의 한 경우** — `reskin_image(inputGenerationId=베이스시트, styleReferenceId=캐릭터참조)`. 차이는 입력 의미뿐: 원본이 **스프라이트시트(마네킹)**, 참조가 **완성 캐릭터 1장**. UI는 리스킨 패널을 재사용하되 "원본이 시트 + 모드 c"일 때 **라벨/안내만 시트-캐릭터 맥락으로 리프레이밍**. (리스킨 패널 와이어프레임은 docs/reskin-plan.md 참조)

### (1) 진입점 — 두 갈래, 같은 경로로 수렴
```
(A) 베이스 시트 결과 카드에서 [🎨 리스킨] → "참조 전이" 모드 선택
    └ 원본이 스프라이트시트 ⇒ 패널이 "캐릭터 오버레이"로 자동 리프레이밍
(B) 시트 카드 전용 보조 단축어 [👤 캐릭터 입히기] (선택, 권장)
    → setEditing({mode:"reskin", subMode:"overlay"}) — 백엔드 동일, 모드c+오버레이 프레이밍으로 바로 오픈
```
```
┌─ 스프라이트시트 결과 카드 (마네킹 베이스) ──────┐
│        [ 4×4 마네킹 애니메이션 시트 ]            │
├──────────────────────────────────────────────┤
│ neutral mannequin walk cycle, 16 frames        │
│ ────────────────────────────────────────────  │
│ 1024×1024 · 시트                                │
│ [✎][⤢▾][✂][▣][▦ 스프라이트][🎨 리스킨][👤 캐릭터입히기][🔗][↻][⤓] │
└──────────────────────────────────────────────┘
                                  ▲ 시트 카드에만 노출하는 보조 단축어
```

### (2) 패널 — "캐릭터 오버레이" 프레이밍 (= 리스킨 모드 c, 시트 베이스)
```
┌──── 캐릭터 오버레이 ────────────────────────[ ✕ ]┐
│  ⓘ 베이스 시트의 포즈는 그대로 두고,             │
│     선택한 캐릭터의 외형을 모든 프레임에 입힙니다     │  ← 오버레이 전용 안내
│  ┌─ 베이스 시트 ────────┐                         │
│  │  [4×4 마네킹 시트]   │  1024×1024 · 시트          │  ← 원본 = 마네킹(고정)
│  │                    │  4×4 · 16프레임            │     grid 자동 감지 표시
│  └────────────────────┘                         │
│  ┌─ 입힐 캐릭터 ───────────────────────────────┐   │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐               │   │  ← 세션 이미지 썸네일
│  │  │ ✓  │ │    │ │    │ │ +  │               │   │     ([+] = 캐릭터 업로드)
│  │  └────┘ └────┘ └────┘ └────┘               │   │
│  └──────────────────────────────────────────┘   │
│  ┌─ 베이스 ─┐   ┌─ 캐릭터 ─┐                       │  ← 선택 시 나란히 미리보기
│  │ [시트]  │ + │ [character]│  → 이 캐릭터를 입힘     │
│  └─────────┘   └──────────┘                     │
│  ┌─ (선택) 추가 지시 ─────────────────────────┐    │
│  │ 망토는 더 길게                              │    │  ← 선택적 prompt
│  └──────────────────────────────────────────┘    │
│  ⚠ 16프레임 전체에서 머리·얼굴·복장 일관성은         │  ← 정직한 한계 고지
│     모델 의존 (드리프트 가능). 베이스 정렬 품질 중요.  │     (리스크: 정체성 일관성)
│  ⓘ 시트는 셀 정렬·투명 후처리가 자동 적용됩니다       │
│              [ 취소 ]   [ 오버레이 실행 ▸ ]          │
└──────────────────────────────────────────────────┘
```
리스킨 모드 c 패널과 구조 동일 — 라벨/안내만 치환(원본→"베이스 시트", 참조→"입힐 캐릭터", 헬퍼→"모든 프레임에 입힘").

### (3) 실행 후 — 채팅 흐름 (시트 후처리 포함)
```
┌─ 채팅 타임라인 ────────────────────────────────────┐
│              [user] 이 캐릭터를 베이스 시트의 모든     │
│                    포즈에 입혀줘.                    │  ← 자동 메시지
│                    [reference: base…] [reference: char…] │  ← 2장 attach (marker)
│  [assistant] ⚙ reskin_image 실행 중…              │
│              ▸ 2이미지 생성 → 셀 정렬 → 투명 처리     │  ← progress 채널
│  ┌────────────────────────────┐                  │
│  │  [ 캐릭터가 입혀진 새 시트 ]   │                  │  ← kind=reskin, 시트
│  │  [▦ 스프라이트][🎨][🔗][↻][⤓] │                   │     → ▦로 GIF 미리보기 확인
│  └────────────────────────────┘                  │
└──────────────────────────────────────────────────┘
```
입력 베이스가 시트 → 결과도 시트 → `resize → chroma-key → normalizeSpritesheetCells` 자동 적용 → `▦ 스프라이트`로 GIF 미리보기.

### 리스킨 모드 c vs 캐릭터 오버레이 — UI 차이
| | 리스킨 모드 c | 캐릭터 오버레이 |
|---|---|---|
| 패널 제목 | 리스킨 | **캐릭터 오버레이** |
| 원본 라벨 | 원본 | **베이스 시트** |
| 참조 라벨 | 스타일 참조 | **입힐 캐릭터** |
| 안내 문구 | "화풍/팔레트 전이" | "모든 포즈에 캐릭터 입힘 + 정체성 드리프트 고지" |
| 백엔드 | **동일** (`reskin_image` 2이미지 경로) | **동일** |
| 진입 | 모든 이미지 카드 | **시트 카드 전용** `👤` 단축어(권장) |

**핵심 결정:** 별도 도구·별도 패널 없이 **리스킨 패널 1개를 문맥 리프레이밍**으로 재사용 → 중복 구현 0, 백엔드 1개 ("중복 구현 방지" 원칙과 일치).

## 검증 계획
Option A 적용 마네킹 베이스 시트 + 캐릭터 참조 1장으로 실생성 →
①포즈 보존 ②프레임 간 캐릭터 정체성 일관성 ③격자 컨테인먼트 를 픽셀 분석 + 육안 확인.
(검증 패턴: MCP stdio 드라이버 + sharp 분석 스크립트 재사용)
