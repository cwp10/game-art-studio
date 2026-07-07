# Phase 2 QA 리포트 — 캐릭터/이펙트 시트 의미 분리

검증자: visual-integration-qa | 일시: 2026-05-28
대상: classifyAnchor 순수 모듈 추출 + ③ 캐릭터 시트 이펙트 가드 주입

---

## 1순위 — 결정적 분류 단위 검증  ✅ PASS (34/34)

테스트 스크립트: `scripts/test-classify.ts` (신규 작성·실행, `pnpm tsx scripts/test-classify.ts`).
`src/lib/mcp/spritesheet-classify.ts` 의 `inferSubjectType`/`classifyAnchor` 직접 import.
inferSubjectType 와 classifyAnchor 일관성도 케이스마다 동시 단언.

### character 매핑 (모션 동사 포함, 액션이어도 character)
| 입력 | 결과 |
|---|---|
| 마법사 걷기 / 마법사 공격 / 마법사 마법 시전 | character ✅ |
| 기사 idle / 공격 4프레임 / 로봇 걷기 / 불 정령 idle | character ✅ |
| 화염 마법사 공격 (char-first) / 방패로 막기 | character ✅ |
| 궁수 회피 구르기 / 전사 사망 / 기사 피격 / 몬스터 도발 (경계) | character ✅ |
| warrior attack 6 frames / wizard cast spell / knight block (영문 경계) | character ✅ |

### effect 매핑 (발산 VFX, 캐릭터 단어 없음)
| 입력 | 결과 |
|---|---|
| 슬래시 이펙트 / 번개 이펙트 / 폭발 2x2 / 검기 트레일 | effect ✅ |
| 화염구 폭발 이펙트 (char 단어 없음) | effect ✅ |
| explosion vfx / beam blast / 충격파 / 스파크 파티클 / 회오리 소용돌이 (경계) | effect ✅ |

### hasRef=true → 무조건 character
"슬래시 이펙트"+ref / "폭발 vfx"+ref / 임의 프롬프트+ref → 모두 character ✅

### 모호 → character (기존 동작)
"4프레임 애니메이션" / "2x2 grid" / "loop animation" → character ✅

### 회귀: 보일러플레이트 오염 방지
"슬래시 이펙트, ... character consistent across frames" → effect ✅
(분류 전 `(character|subject) consistent across frames` 정규식 제거 — classify.ts:47-49)

**회귀 핵심 확인**: 슬래시/번개/폭발/빔 등 발산 VFX 명사는 effect 유지, 모션 동사는 character.

---

## 1.5순위 — 가드 게이팅 코드 검증  ✅ PASS (결정적 논증)

게이팅 체인 (server.ts):
- `userPrompt` = args.prompt (316행), `refId` = args.inputGenerationId (318행).
- `subjectType` = `args.subjectType ?? inferSubjectType(userPrompt, !!refId)` (403행).
- `resolvedAnchor` = `anchorStrategy!=="auto" ? anchorStrategy : subjectType==="effect" ? "center" : "feet"` (406-407행).
- `isEffectAnchor` = `resolvedAnchor === "center"` (408행).
- **`effectGuard` = `isEffectAnchor ? "" : <가드 블록>`** (432-440행) → character 에만 주입, effect 면 빈 문자열. ✅
- `decorated` 가 anchorRule 뒤 · loopInstruction 앞에 `effectGuard` 삽입 (452-453행). ✅
- rule (1)/(3): `containedContent`(423-425) / `oversizeContent`(426-428) 가 `isEffectAnchor` 분기.
  character 경로는 "the character's body, weapon, and any flowing cape or robe" 만 열거 — **발산 VFX 를 콘텐츠로 전제하지 않음** (③ 모순 제거 확인). ✅

end-to-end 일관성: postprocess.ts `resolveAnchor`(155행) 가 server.ts 와 동일 규칙
(`subjectType==="effect" ? "center" : "feet"`) → 프롬프트 가드와 후처리 정렬이 같은 신호로 구동. ✅

**최종 결론**: auto 플로우(실제 경로)에서 character → 가드 주입, effect → 미주입 성립.

### 부수 관찰 (FAIL 아님, 경미)
`effectGuard` 게이팅이 `subjectType` 이 아니라 `resolvedAnchor === "center"`(isEffectAnchor)에 직접 의존.
명시 `anchorStrategy:"center"` + `subjectType:"character"` 조합이면 가드가 빠지고,
명시 `subjectType:"effect"` + `anchorStrategy:"feet"` 면 가드가 들어간다(앵커-가드 결합).
기본/auto 경로(=오케스트레이터·UI 가 쓰는 실제 경로)에선 subjectType 이 anchor 를 결정하므로 정상.
Phase 3 에서 actionCategory 도입 시 가드 게이팅을 subjectType 직접 분기로 두는 것을 권고.

---

## 2순위 — 게이트  ✅ ALL PASS

| 게이트 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0, 출력 0 ✅ |
| `pnpm lint` (eslint) | exit 0, error/warning 0 ✅ |
| `pnpm build` (next) | exit 0, 14 라우트 빌드 성공 ✅ |
| `scripts/test-classify.ts` | 34/34 PASS ✅ |

---

## 3순위 — 실제 codex 생성

하네스: `scripts/qa-mcp-spritesheet.mjs` (신규) — `scripts/gen.ts` 는 ImageBackend 직접 호출로
effectGuard/decorated 빌더를 우회하므로, 진짜 MCP 서버(stdio)를 spawn 해 make_spritesheet
핸들러의 decorated 프롬프트(가드 포함)+후처리 전체를 그대로 실행한다.

### (필수) "마법사 공격 4프레임" (2x2, ref 없음)  ✅ 가드 주입 런타임 확인

**결정적 런타임 증거 (코드-경로 확인):** 실제 MCP make_spritesheet 핸들러가 빌드한
`decorated` 프롬프트를 `codex exec` 명령줄(`ps aux`)로 직접 캡처. ATTACK 액션 프롬프트인데도:
- `(5) CHARACTER ANCHOR — keep the hip/waist near X=256, Y=256, feet on a consistent ground line`
  → subjectType=character, resolvedAnchor=feet, isEffectAnchor=false. ✅
- rule (1): `the character's body, weapon, and any flowing cape or robe`
  (effect 의 "ALL of its effects, trails, particles..." 열거가 **아님**) → character containedContent 분기. ✅
- rule (3): `especially a large pose or a wide weapon swing` → character oversizeContent 분기. ✅
- **effectGuard 그대로 주입**: `Render the character's body and its INTRINSIC design only.
  Do NOT add action or ability visual effects: NO attack slash trails, NO spell or magic particles,
  NO projectiles, NO emitted auras around the body, NO motion lines, NO impact flashes, NO smoke,
  NO sparkles, NO extra decorative VFX. The character's OWN intrinsic material is fine...` ✅

→ 공격(액션) 프롬프트에서 가드가 실제로 character 시트에 주입되고, rule (1)/(3) 이 VFX 를
콘텐츠로 전제하지 않음을 **핸들러 실행 결과로 확정**. (코드 리뷰가 아니라 실제 spawn 한 codex 명령줄.)

**시각 확인(육안):** ✅ PASS
- gen=`f57gbonwp4dskxgg` (1024x1024, 2x2, 161.4s), PNG=`data/images/f57gbonwp4dskxgg.png`.
- server log: `make_spritesheet normalized gen=f57gbonwp4dskxgg (2x2) anchor=feet` → subjectType=character/resolvedAnchor=feet 확정.
- structuredContent shape: `{generationId, imagePath, width, height, kind:"spritesheet", elapsedMs}` (정상).
- 이미지 관찰: 마법사의 **공격/시전 자세 4프레임만** (준비→지팡이 들기→찌르기→마무리).
  **슬래시 궤적·마법 입자·투사체·임팩트 플래시·오라·모션라인·연기·스파클 전무.** 가드 적중.
- **고유 디자인 보존(반대 방향 오류 없음)**: 지팡이 끝 발광 블루 젬은 무기 고유 대기 디자인 →
  가드가 캐릭터 고유 발광은 지우지 않음(intrinsic-material 절 정상 동작).
- 셀 정렬: 동일 캐릭터 높이, feet 바닥선 일치, cross-cell 누출 없음, green chroma-key 깔끔 제거(녹색 fringe 없음).

### (선택) "슬래시 이펙트 4프레임" — 미실행 (사유 명시)
- **미실행.** 사유: (1) 구독 한도 절약 — 캐릭터 케이스(Phase 2 핵심)가 위에서 결정적으로 확인됨.
  (2) effect 분기는 1순위 분류 테스트(슬래시 이펙트→effect, 34/34)+1.5순위 가드 게이팅
  (effect→effectGuard="" / anchorRule=CENTER / containedContent=VFX 열거)로 결정적 커버됨.
  실생성은 모델의 VFX 렌더 품질 확인일 뿐 가드 로직 검증엔 추가 정보 없음 → 한도 절약 차원 보류.
- 회귀 위험 낮음: EFFECT_WORDS 무변경, anchorRule/containedContent 의 effect 분기 코드 무변경.

### 알려진 하네스 이슈 (도구 한계, 코드 결함 아님)
- MCP SDK 기본 RPC 타임아웃 60s < 스프라이트시트 생성 5-10분 → 1차 실행은 client 가
  `-32001 Request timed out` 으로 RPC 포기 + StdioClientTransport 가 자식 SIGTERM.
  `scripts/qa-mcp-spritesheet.mjs` 에 `timeout:900000, resetTimeoutOnProgress:true` 적용해 해결, 재실행.
- `scripts/gen.ts` 는 ImageBackend 직접 호출이라 effectGuard/decorated 빌더를 우회 → 실생성 검증엔 부적합.
  진짜 핸들러 경로는 MCP 호출(qa-mcp-spritesheet.mjs)로만 검증 가능.

---

## 종합 판정

| 검증 | 결과 |
|---|---|
| 1순위 결정적 분류 (scripts/test-classify.ts) | ✅ 34/34 PASS |
| 1.5순위 가드 게이팅 (코드 + 런타임 codex 명령줄) | ✅ PASS |
| 2순위 게이트 (tsc / lint / build) | ✅ ALL PASS (exit 0) |
| 3순위 실생성 캐릭터 공격 (육안) | ✅ PASS — VFX 없음, 고유 디자인 보존 |
| 3순위 실생성 이펙트 시트 | ⚠️ 미실행 (한도 절약, 결정적 커버) |

**최종: PASS.** Phase 2(캐릭터/이펙트 의미 분리)는 결정적 분류·가드 게이팅·게이트·
실생성 캐릭터 케이스에서 모두 통과. 캐릭터 공격 시트에서 발산 VFX 가 실제로 억제되고
무기 고유 발광은 보존됨을 실제 codex 생성으로 확인.

### 산출물
- 신규 `scripts/test-classify.ts` — 분류 단위 테스트 (34 케이스).
- 신규 `scripts/qa-mcp-spritesheet.mjs` — 진짜 MCP 핸들러 실생성 하네스 (effectGuard/decorated 경로).
- 생성 증거 PNG: `data/images/f57gbonwp4dskxgg.png`.
