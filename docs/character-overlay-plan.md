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
- **Phase 2 (UI)**: 베이스 시트 + 캐릭터 참조를 고르는 전용 UI.

## 검증 계획
Option A 적용 마네킹 베이스 시트 + 캐릭터 참조 1장으로 실생성 →
①포즈 보존 ②프레임 간 캐릭터 정체성 일관성 ③격자 컨테인먼트 를 픽셀 분석 + 육안 확인.
(검증 패턴: MCP stdio 드라이버 + sharp 분석 스크립트 재사용)
