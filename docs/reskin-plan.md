# 리스킨(reskin) 기능 구현 계획

> 상태: **계획 확정 (미결정 해소), 구현 대기** (2026-05-27 작성 · 2026-05-28 모드 b 방식 확정)
> AetherAI 튜토리얼의 리스킨 기능을 본 프로젝트에 이식.

## 요구사항 (사용자 확정)
- **3개 모드 모두 필요**:
  - (a) 외형 교체 — 구조 유지 + 색/재질/테마/복장만 다른 버전
  - (b) 팔레트/색상만 변경 — 형태 100% 유지, 색만 스왑
  - (c) 참조 스타일 입히기 — 다른 참조 이미지의 화풍/팔레트를 기존 캐릭터에 전이
- **대상: 단일 캐릭터/이미지 + 스프라이트시트 둘 다**

## 대표 유스케이스 (AetherAI 참고 이미지)
"Sprite Reskin — Same animations, new look": **중립 마네킹** 애니메이션 시트(표정·머리·복장 없는
베이스)를 만들고, **같은 포즈 그대로** 특정 캐릭터(예: 빨간머리 소녀 + 보라색 별 망토)로 스킨만 입힘.
→ 모드 (a) 외형 교체 × 대상 스프라이트시트. `reskin_image(베이스시트, prompt="...")` → 시트 전체를
한 장으로 리스킨 → 후처리 재사용.

**현실적 품질:** 참고 이미지는 포즈가 완벽히 동일하나, gpt-image img2img는 픽셀-락이 아니라
재생성이라 프레임 간 포즈/캐릭터 디테일이 미세하게 틀어질 수 있다. 시트 전체 1회 처리 + 기존
미세조정 도구로 완화. 픽셀 단위 포즈 고정이 필수면 ControlNet 류 포즈 컨디셔닝 필요(현재 백엔드 미보유).

## 사전 조사 결론 (코드베이스 사실)
- **M3 오케스트레이션 동작 중**: 채팅 → `spawnClaude`(Claude CLI) → `allowedTools`의 MCP 도구 호출.
  새 도구는 ①MCP 서버 추가 ②`allowedTools` 등록 ③오케스트레이터 프롬프트 라우팅 → 채팅으로 즉시 사용 가능.
- **codex img2img 다중 입력 지원**: `[base, styleRef]` 2장 입력으로 스타일 전이 가능
  (spritesheet=`[grid, ref]`, inpaint=`[orig, mask]` 와 동일 방식, `overrideInputPaths`).
- **스프라이트시트 reskin은 기존 후처리 재사용**: 시트 전체를 한 장으로 리스킨 →
  `resize → chromaKeyGreenFile → normalizeSpritesheetCells`(server.ts) 그대로 적용.
- `GenerationKind`(`src/types/db.ts:30`)에 `reskin` 추가 필요.
- 스프라이트시트는 rows/cols 를 DB에 저장하지 않음 → **치수에서 grid 자동 감지**
  (`SpriteCanvas.tsx`의 `detectSpriteGrid` gcd 로직 재사용/이식).

## 설계: 단일 MCP 도구 `reskin_image`
파라미터로 3개 모드 분기. 대상(단일/시트)은 입력 generation의 `kind`로 자동 판별.

| 모드 | 트리거 파라미터 | 동작 |
|---|---|---|
| (a) 외형 교체 | `prompt`만 | img2img + "포즈/실루엣/구도 유지, 색·재질·테마만 교체" |
| (b) 팔레트만 | `paletteOnly: true` | "모든 형태·선 동일, 색 팔레트만 `<prompt>`로" (강한 구조 잠금) |
| (c) 참조 전이 | `styleReferenceId` | `[base, styleRef]` 2장, "image1 구조 유지 + image2 화풍" |

스키마(안):
```
reskin_image {
  inputGenerationId: string   // 필수, 리스킨 대상
  prompt?: string             // 모드 a/b/c 의 원하는 스킨 설명
  styleReferenceId?: string   // 모드 c
  paletteOnly?: boolean       // 모드 b
  sessionId?: string
}
```

## 파일별 변경
1. `src/types/db.ts` — `GenerationKind`에 `"reskin"` 추가.
2. `src/lib/image-backend/index.ts` — `ImageJob`에 styleRef/paletteOnly 전달
   (이미 `inputImagePaths` 다중 지원 → 최소 변경).
3. `src/lib/image-backend/codex-exec.ts` — `kind: "reskin"` 분기 + 3개 프롬프트 템플릿:
   - (a) `"Re-skin the attached character to: <prompt>. Keep the EXACT same pose, silhouette, proportions, composition, framing — change only colors, materials, textures, outfit theme. Same dimensions."`
   - (b) `"Recolor only: keep every shape/line/form pixel-identical; change ONLY the color palette to <prompt>. No structural changes."`
   - (c) `"Image 1 = base (keep its pose/structure/layout). Image 2 = style reference. Re-skin image 1 with image 2's visual style/material/palette. Keep image 1's exact pose and composition."`
4. `src/lib/mcp/server.ts` — `SCHEMAS.reskin_image`, `TOOLS` 엔트리, `case "reskin_image"`:
   - 입력 kind == `spritesheet` → 생성 후 `resize → chromaKeyGreenFile → normalizeSpritesheetCells`(grid는 detectSpriteGrid 역산). 감지 실패 시 단일처럼 폴백.
   - 단일 이미지 → 후처리 없음.
5. `src/app/api/chat/route.ts` — `allowedTools`에 `mcp__imggen__reskin_image` 추가 (line ~59).
6. `src/lib/prompt/system-orchestrator.md` — 라우팅: "리스킨/다른 색·재질 버전/스킨 변경/이 화풍으로" → `reskin_image`. 기본 투명 배경 상속, 시트 자동 감지 안내.

## 단계 구분
- **Phase 1 (핵심)**: 위 1~6. 채팅으로 3개 모드 × 2개 대상 동작.
- **Phase 2 (UI, 선택)**: `ImageResultCard`에 "🎨 리스킨" 퀵 버튼 + 리스킨 패널. 아래 [UI/UX 와이어프레임](#uiux-와이어프레임-phase-2) 참조.
- **Phase 3 (선택)**: **결정적 팔레트 교체** — sharp 기반 색상 매핑(픽셀-퍼펙트). 명시적 색 지정(컬러피커 UI) 필요. 모드(b)가 codex로 부족하면 추가.

## UI/UX 와이어프레임 (Phase 2)
> 2026-05-28 기획. 코드 미반영(기획 단계). 기존 결과 카드 액션은 두 패턴: ①자연어 단축어(resize/remove_bg/reference/duplicate — `attachmentGenerationIds` 붙인 메시지 → Claude → MCP), ②우측 패널 에디터(edit/layer/sprite — `setEditing({mode})`로 캔버스 패널). 리스킨은 프롬프트 입력 + (모드 c) 참조 선택이 필요 → **기존 패널 슬롯(`setEditing`)을 재사용하는 리스킨 패널**로 설계.

### (1) 진입점 — 결과 카드 액션 줄에 `🎨 리스킨` 추가
```
┌─────────────────────────────────────────────┐
│            [ 생성된 이미지 / 시트 ]            │   ← 클릭 시 라이트박스 (기존)
├─────────────────────────────────────────────┤
│ ⧉  a red-haired girl with purple star cape  │   ← 프롬프트 (기존)
│ ─────────────────────────────────────────── │
│ 512×512                                      │
│ [✎ 편집][⤢ 리사이즈▾][✂ 배경제거][▣ 레이어]   │
│ [▦ 스프라이트][🎨 리스킨][🔗 참조][↻ 복제][⤓ 저장] │   ← 🎨 리스킨 신규
└─────────────────────────────────────────────┘
```
`🎨 리스킨` 클릭 → `setEditing({ mode: "reskin", generationId, … })` → 우측/전체화면 패널 오픈(편집·레이어·스프라이트와 동일 슬롯).

### (2) 리스킨 패널 — 상단 모드 세그먼트 + 모드별 입력
공통 골격:
```
┌──── 리스킨 ─────────────────────────────[ ✕ ]┐
│  ┌ 모드 ──────────────────────────────────┐  │
│  │ [ 외형 교체 ] [ 색만 변경 ] [ 참조 전이 ] │  │  ← 세그먼트 토글 (a/b/c)
│  └────────────────────────────────────────┘  │
│  ┌─ 원본 ────────────┐                        │
│  │   [원본 미리보기]  │   512×512 · 스프라이트시트 │  ← kind 자동 판별 배지
│  │                  │   4×4 · 16프레임          │     (시트면 grid 감지 표시)
│  └──────────────────┘                        │
│  ‹ 모드별 입력 영역 (아래 a/b/c) ›              │
│  ┌────────────────────────────────────────┐  │
│  │  ⓘ 시트는 셀 정렬·투명 후처리가 자동 적용됩니다 │  │  ← 시트일 때만 안내
│  └────────────────────────────────────────┘  │
│              [ 취소 ]   [ 리스킨 실행 ▸ ]        │
└──────────────────────────────────────────────┘
```
모드 (a) 외형 교체 — `prompt`만:
```
│  ┌─ 새 스킨 설명 ───────────────────────────┐  │
│  │ 파란 갑옷의 기사, 은빛 검                  │  │  ← textarea
│  └────────────────────────────────────────┘  │
│  포즈·실루엣·구도는 유지하고 색·재질·테마만 교체됩니다 │  ← 헬퍼 텍스트
```
모드 (b) 색만 변경 — `paletteOnly: true`:
```
│  ┌─ 원하는 색 팔레트 ───────────────────────┐  │
│  │ 빨강→파랑, 금색 장식은 은색으로            │  │  ← textarea
│  └────────────────────────────────────────┘  │
│  형태·선은 그대로 두고 색 팔레트만 바꿉니다       │
│  ⚠ img2img 특성상 형태가 미세하게 틀어질 수 있어요 │  ← codex 한계 고지
│     (정밀 색교체는 추후 컬러피커 모드 예정)         │     (Phase 3 예고)
```
모드 (c) 참조 전이 — `styleReferenceId`:
```
│  ┌─ 스타일 참조 이미지 ─────────────────────┐  │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐            │  │  ← 세션 내 이미지 썸네일 그리드
│  │  │ ✓  │ │    │ │    │ │ +  │            │  │     (선택 시 ✓, [+]=업로드)
│  │  └────┘ └────┘ └────┘ └────┘            │  │
│  └────────────────────────────────────────┘  │
│  ┌─ 원본 ──┐   ┌─ 참조 ──┐                    │  ← 선택 시 base + ref 나란히
│  │ [base] │ → │ [style]│  이 화풍/팔레트를 입힘  │
│  └────────┘   └────────┘                    │
│  ┌─ (선택) 추가 지시 ──────────────────────┐  │
│  │ 더 어둡고 차분하게                        │  │  ← 선택적 prompt
│  └────────────────────────────────────────┘  │
```

### (3) 실행 후 — 채팅 흐름 (기존 단축어와 동일 경로)
`리스킨 실행 ▸` → 패널 닫힘 → 자연어 메시지 전송(`attachmentGenerationIds`로 원본/참조 첨부). 버튼은 단축어, 실행은 자연어 → Claude → `reskin_image`.
```
┌─ 채팅 타임라인 ────────────────────────────────┐
│                  [user] 이 캐릭터를 파란 갑옷의   │
│                        기사로 리스킨해줘.        │   ← 모드 a 자동 메시지
│                        [reference: a1b2…]      │   ← marker (기존 정직성 정책)
│  [assistant] ⚙ reskin_image 실행 중…           │
│              ▸ 생성 → 시트 정렬 → 투명 처리      │   ← progress 채널
│  ┌──────────────────────────┐                │
│  │   [ 리스킨된 결과 카드 ]    │                │   ← 새 generation(kind=reskin)
│  │  [✎][⤢▾][✂][▣][▦][🎨][🔗][↻][⤓]│              │     → 결과 카드 그대로 체이닝 가능
│  └──────────────────────────┘                │
└──────────────────────────────────────────────┘
```
- **단일 이미지 입력** → 후처리 없이 결과 카드.
- **스프라이트시트 입력** → 시트 전체 1회 리스킨 → `resize → chroma-key → normalizeSpritesheetCells` 자동 적용 후 결과 카드(→ `🎨` 또는 `▦ 스프라이트`로 미리보기 연결).

### UI 설계 결정
| 항목 | 권장 | 이유 |
|---|---|---|
| 진입 표면 | **우측/전체화면 패널**(`setEditing` mode=`reskin`) | 모드 c의 참조 picker·미리보기가 팝오버엔 과함. 편집/레이어/스프라이트와 일관 |
| 모드 전환 | 상단 **세그먼트 토글** 1개 패널 | 3모드가 같은 대상·같은 출력 → 화면 분기보다 입력만 교체가 단순 |
| 모드 c 참조 선택 | **세션 이미지 썸네일 그리드 + [+] 업로드** | 기존 업로드/참조 인프라(`/api/upload`, composerAttachment) 재사용 |
| 실행 경로 | 자연어 메시지 + attachment (패널은 메시지 빌더) | 기존 단축어와 동일 → 백엔드/오케스트레이터 변경 최소 |
| 시트 안내 | kind 배지 + 후처리 안내 배너 | 사용자가 처리 시간·정렬 동작을 예측 가능 |

**대안:** 모드 a/b는 입력이 단순(prompt 1개)하므로 버튼 옆 팝오버(리사이즈 드롭다운처럼)로 더 가볍게 갈 수 있으나, 모드 c와 일관성 위해 단일 패널로 통일 권장.

## 결정 사항 (2026-05-28 확정)
- **모드(b) 팔레트 교체: codex img2img 로 먼저 구현 (Phase 1).**
  - 근거: 모드 a/c 와 백엔드 공유 → 3모드를 한 번에 완성. 실제 결과로 형태 드리프트가 실용상 문제인지 판단.
  - **폴백 조건:** codex 결과의 형태 미세 변형이 "100% 형태 유지" 요구에 미달하면, 그때 모드(b)에 한해 **결정적 sharp 색상 매핑(Phase 3)** 을 추가 (컬러맵/피커 UI 동반). Phase 1 에서는 착수하지 않음.

## 핵심 리스크
- img2img는 픽셀 고정이 아니라 재생성 → 포즈/형태 미세 드리프트. (b)도 codex면 동일 한계.
- 스프라이트시트: 시트 전체 한 장 리스킨이 프레임 일관성에 최선이나, 모델이 셀 구조를 깨뜨릴 위험. normalize가 정렬은 복구하나 내용 일관성은 모델 의존.
- grid 감지 실패 시 후처리 스킵 폴백.

## 검증 계획
실생성으로: ①단일 캐릭터(포즈 유지) ②스프라이트시트(셀 정렬·프레임 일관성) ③참조 스타일 전이 — 각 1회 생성 후 픽셀 분석 + 육안.
(검증 패턴: 이전 chroma/normalize 검증 때 쓴 MCP stdio 드라이버 + sharp 분석 스크립트 방식 재사용)
