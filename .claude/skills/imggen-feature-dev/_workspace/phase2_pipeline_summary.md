# Phase 2 — 의미 분리 (캐릭터/이펙트 시트) 파이프라인 변경 요약

스프라이트시트 개편 Phase 2(③ 캐릭터-이펙트 의미 분리). 캐릭터 시트엔 액션 무관하게
발산 VFX 가드를 무조건 주입, 이펙트는 별도 effect 시트. classifyAnchor 를 순수 모듈로 추출 + 정련.

## 변경 파일·함수 (경로:라인)

### 1. 신규 — `src/lib/mcp/spritesheet-classify.ts` (순수 모듈, side-effect 없음)
- `classifyAnchor(prompt, hasRef): "effect"|"character"` (43행) — server.ts 에서 추출.
- `inferSubjectType(prompt, hasRef): SubjectType` (56행) — classifyAnchor 의 SubjectType 래퍼(단위 테스트·호출부용).
- `SubjectType` 은 `../image-backend/spritesheet-postprocess.js` 에서 import 재사용(중복 정의 없음).
- top-level: DB·서버 기동·MCP 등록 없음 → tsx import 안전(검증: `npx tsx` 로 import 성공).

### 2. `src/lib/mcp/server.ts`
- import 블록(44행): `import { inferSubjectType } from "./spritesheet-classify.js";` 추가.
- make_spritesheet subjectType 산출(~395행): `args.subjectType ?? inferSubjectType(userPrompt, !!refId)` — 기존 인라인 classifyAnchor 호출 대체.
- **이펙트 가드 + rule (1)/(3) 분기 주입(~413~445행, decorated 빌더 직전/내부):**
  - `containedContent`: isEffectAnchor 면 기존 "effects, trails, particles, projectiles, beams, auras, capes/robes" 열거 / character 면 `"the character's body, weapon, and any flowing cape or robe"` (발산 VFX 미열거 — ③ 모순 제거).
  - `oversizeContent`: effect 면 "sweeping effect like a slash, blast, beam, or trail" / character 면 "a large pose or a wide weapon swing".
  - `effectGuard`: isEffectAnchor 면 `""`, 아니면 가드 블록(아래) — character 시트면 액션 무관 항상 주입.
  - `decorated` 의 rule (1)/(3) 이 `containedContent`/`oversizeContent` 를 사용하도록 수정, anchorRule 뒤·loopInstruction 앞에 `effectGuard` 삽입.
- 기존 함수 정의 `classifyAnchor`(구 783~809행) 삭제.

### 3. `src/lib/prompt/system-orchestrator.md` (make_spritesheet 섹션 ~19행 뒤)
- "캐릭터 시트 ↔ 이펙트 시트 분리 (중요)" 두 불릿 추가:
  - 캐릭터 모션 시트는 몸·동작만(서버가 발산 VFX 금지, 공격·스킬도 자세/포즈만, 고유 디자인 허용).
  - 순수 VFX 는 별도 effect 시트. "공격+이펙트" 요청 시 캐릭터 시트 1 + 이펙트 시트 1 안내.
- 기존 "consistent subject" 보일러플레이트·배경·seamlessLoop·reference 규칙은 그대로 유지.

## 이펙트 가드 텍스트 (subjectType==="character" 일 때만, 영어)
```
Render the character's body and its INTRINSIC design only.
Do NOT add action or ability visual effects: NO attack slash trails,
NO spell or magic particles, NO projectiles, NO emitted auras around the body,
NO motion lines, NO impact flashes, NO smoke, NO sparkles, NO extra decorative VFX.
The character's OWN intrinsic material is fine (e.g. a robot's status lights or
glowing core, a fire creature's flame body, a weapon that glows as part of its
resting design). Any action or ability effect belongs on a SEPARATE effect sprite sheet.
```

## classifyAnchor 정련 — CHAR_WORDS 추가 키워드
char-first 순서 유지, 발산 VFX 명사는 EFFECT_WORDS 에 그대로 둠. 추가한 캐릭터 모션 동사/명사:
- 명사: 로봇/robot, 정령
- 동사: 공격/attack, 스킬/skill, 시전/cast, 주문/spell, 방어/block, 막기, 회피/dodge,
  구르기/roll, 사망/death, 피격/hit, 가드/guard, 승리/victory, 도발/taunt, 인사/wave, 웅크/crouch
- (EFFECT_WORDS 무변경 — 슬래시/slash/참격/검기/폭발/explosion/빔/beam 등 발산 VFX 명사는 effect 신호 유지)

## 분류 동작표 (대표 입력 → subjectType, 임시 tsx 스니펫 검증 ALL PASS)
| 입력 | hasRef | subjectType |
|---|---|---|
| 마법사 걷기 4프레임 | false | character |
| 마법사 공격 4프레임 | false | character |
| 마법사 마법 시전 4프레임 | false | character |
| 공격 4프레임 | false | character |
| 회피 구르기 / 방어 막기 / 사망 | false | character |
| 기사 idle / 로봇 걷기 | false | character |
| 화염 마법사 공격 (혼합) | false | character (char-first) |
| 슬래시 이펙트 4프레임 | false | effect |
| 번개 이펙트 4프레임 | false | effect |
| 폭발 2x2 / 슬래시 | false | effect |
| (참조 이미지 있음) | true | character |

## 알려진 한계
- **이펙트 가드는 모델 의존(best-effort).** 프롬프트로 강제하지만 픽셀 보장 불가 — 가끔 미세
  글로우·잔여 입자가 남을 수 있음(재생성으로 해결). 계획서 ③ "모델 의존" 표기와 일치.
- 가드는 "외부 발산 액션/능력 VFX" 만 금지하고 캐릭터 고유 디자인(로봇 발광 코어·정령 불꽃 몸체·
  대기 무기 글로우)은 명시 허용 — 모델이 둘을 혼동하면 고유 디자인까지 지울 가능성(반대 방향 오류).
- 후처리(spritesheet-postprocess.ts) 픽셀 로직은 변경 없음 — 컨테인먼트/정렬 불변식 그대로.

## visual-qa 검증 체크리스트 (codex 실제 생성 — visual-qa 담당)
1. **캐릭터 공격 시트(이펙트 가드 효과):** "마법사 공격 4프레임" (2x2, ref 없음) 생성.
   → 칼/지팡이 휘두르는 자세만, **슬래시 궤적·마법 입자·오라·임팩트 플래시 없음** 확인.
2. **캐릭터 스킬 시전:** "마법사 마법 시전 4프레임" (2x2) → 시전 포즈만, 마법 VFX 없음.
3. **캐릭터 고유 디자인 보존:** "로봇 걷기 4프레임" 또는 "불 정령 idle" → 발광 코어/불꽃 몸체는
   유지되되 발산 트레일·파티클은 없음(가드가 고유 디자인을 지우지 않았는지 양방향 확인).
4. **이펙트 시트 회귀:** "슬래시 이펙트 4프레임" → 캐릭터 없는 VFX 시트, CENTER 앵커 정렬,
   가드 미주입(트레일·잔상 정상 렌더) 확인.
5. **회귀:** 기존 캐릭터 걷기/idle 시트(ref 첨부 1장 포함) — 셀 정렬·chroma·cross-cell 보존 무변경.
6. **단위 테스트:** inferSubjectType 분류표(위)를 정식 테스트로 작성 권장.

## fullstack-engineer 통지 필요 여부
- **불필요.** 도구 입력 스키마·structuredContent shape **무변경**(subjectType/anchorStrategy 는
  Phase 1 추가분 그대로). 새 스키마 필드(actionCategory 등) 추가 안 함 — Phase 3 범위.

## 셀프 게이트 결과
- `npx tsc --noEmit`: PASS (출력 0)
- `pnpm lint`: PASS (에러 0)
- `pnpm build`: PASS (14 라우트 빌드 성공)
- classifyAnchor 회귀 스니펫: ALL PASS (15/15)
