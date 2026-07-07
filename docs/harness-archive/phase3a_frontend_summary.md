# Phase 3A 프론트엔드 — 스프라이트시트 생성 전용 패널

작성: fullstack-engineer / 2026-05-28

## 새 파일
- `src/components/editor/SpriteGenPanel.tsx` — editor 전체화면 오버레이 패널(ReskinPanel 패턴).
  - export 컴포넌트 `SpriteGenPanel`
  - export 타입 `SpriteGenSubmit`, `SpriteSubject`, `SpriteAnchor`, `SpriteDirections`
  - export 순수 함수 `buildSpriteMessage(payload, stylePresetSuffix?)` (~L380) — 마커+자연어 합성
  - export `resolveStyleSuffix(presetId)` (~L420) — presetId → prompt_suffix 해석(listPresets 1회)

## 변경 파일 (경로:라인)
- `src/components/chat/ChatLayout.tsx`
  - L11~17: SpriteGenPanel/buildSpriteMessage/resolveStyleSuffix/SpriteGenSubmit import
  - L62~64: `const [spriteGen, setSpriteGen] = useState<{ reference?: EditTarget } | null>(null)` (별도 상태 — fresh 생성은 EditTarget 불필요)
  - handleAction union 에 `"make_sheet"` 추가 + 분기: 비-시트 단일 이미지 → `setSpriteGen({ reference })`
  - `handleSpriteGen(payload)` 신규: `resolveStyleSuffix` → `buildSpriteMessage` → `handleSend(message, { attachmentGenerationIds })`
  - Composer 에 `onOpenSpriteGen={() => setSpriteGen({})}` 전달
  - reskin 패널 블록 뒤에 SpriteGenPanel 마운트(`{spriteGen && <div className="fixed inset-0 z-40">…`)
- `src/components/chat/Composer.tsx`
  - `Grid3x3` import, `onOpenSpriteGen?: () => void` prop 추가/destructure
  - 액션 행에 [▦ 시트] 버튼(askSuggestions 앞, ml-auto 그룹 밖) — `onOpenSpriteGen` 있을 때만
- `src/components/chat/ImageResultCard.tsx`
  - `Grid3x3` import, Action union 에 `"make_sheet"` 추가
  - `kind === "spritesheet"` 분기를 삼항으로: 시트면 [캐릭터](overlay), 비-시트면 [시트 만들기](make_sheet)
- `src/components/chat/MessageList.tsx`
  - onAction union 에 `"make_sheet"` 추가
- `src/lib/prompt/system-orchestrator.md`
  - make_spritesheet 섹션 상단에 "Structured directive (`[spritesheet: k=v; …]`)" 규칙 추가:
    directive key/value 를 **그대로** make_spritesheet 에 전달(rows/cols/subjectType/anchorStrategy/directions/seamlessLoop), 추론·변경 금지, framesPerDir 은 정보용(=cols, 전달 안 함), 나머지 자연어=prompt, `[reference: id]`=inputGenerationId, directive 있으면 grid-selection 규칙 무시.

## SpriteGenPanel props / payload 타입
```ts
type Props = {
  reference?: { generationId; imageUrl; width; height; kind? }; // 결과카드 단축어 진입 시
  sessionId?: string | null;       // 향후 참조 그리드용(현재 미사용, 계약 유지)
  onSubmit: (payload: SpriteGenSubmit) => void;
  onClose: () => void;
};
type SpriteGenSubmit = {
  subjectType: "character" | "effect";
  preset: string;            // 캐릭터 액션 key / 이펙트 종류 key / "custom"
  customText: string;        // preset==="custom" 자유 텍스트
  anchorStrategy: "auto"|"feet"|"hip"|"center"|"top";  // character 전용
  directions: 1|2|4|8;       // character 전용
  framesPerDir: number;      // character — cols 로 매핑
  effectFrames: number;      // effect — rows×cols near-square
  rows: number; cols: number; // 최종 그리드(미리보기·마커와 동일)
  stylePresetId: string | null;
  description: string;
  background: "transparent" | "white";
  seamlessLoop: boolean;
  referenceId?: string;      // → attachmentGenerationIds
};
```

## 마커 형식 정확한 스펙 (계약 — make_spritesheet 입력명과 정확히 일치)
빌더: `buildSpriteMessage(payload, stylePresetSuffix?): { message, attachmentGenerationIds }`
- message = `<directive>\n<자연어>`
- 자연어 = `<피사체+액션구>, [설명], [styleSuffix], <transparent|white background>`
- 참조는 마커가 아니라 `attachmentGenerationIds` → /api/chat 이 `[reference: id]` prefix → inputGenerationId

**character** (directions/anchorStrategy/framesPerDir 포함):
```
[spritesheet: subjectType=character; anchorStrategy=hip; directions=4; framesPerDir=6; rows=4; cols=6; seamlessLoop=false]
캐릭터 melee attack swing motion 모션 스프라이트 시트, 파란 갑옷 기사, pixel art 16-bit, transparent background
```
**effect** (directions/anchorStrategy/framesPerDir 생략):
```
[spritesheet: subjectType=effect; rows=2; cols=4; seamlessLoop=true]
slash trail vfx 이펙트 스프라이트 시트, transparent background
```
키: `subjectType` `anchorStrategy` `directions` `framesPerDir` `rows` `cols` `seamlessLoop`. 구분자 `; `. **framesPerDir 은 정보용 — 오케스트레이터가 make_spritesheet 에 전달하지 않음(=cols).**

## 진입점 2개
1. **Composer [▦ 시트] 버튼** → `onOpenSpriteGen()` → `setSpriteGen({})` (fresh, 참조 없음).
2. **결과카드 [▦ 시트 만들기]** (kind !== "spritesheet" 인 단일 이미지) → `onAction("make_sheet")` → handleAction → `setSpriteGen({ reference: { generationId, imageUrl, width, height, kind } })` (참조 채워진 패널, 캐릭터 기본).

## 그리드 미리보기
정적 — codex 호출 없음. rows×cols 빈 격자 + 캐릭터+directions≥2 면 행별 방향 라벨(정면/측면/후면/8방위). 옵션 변경 시 useMemo 로 즉시 갱신. [생성]만 실제 codex 호출(handleSend 경유).

## 경계면 영향 (어느 shape → 어느 반대편)
- **신규 마커 `[spritesheet: …]`** (React→/api/chat→Claude→make_spritesheet). 새 계약. message 본문에 directive 가 들어가고 오케스트레이터가 key/value 를 make_spritesheet args 로 매핑. 기존 `[reference: id]`/`[mask: id]` passthrough 와 동일 검증된 방식 — **route.ts·MCP 스키마 변경 0** (기존 입력 그대로 사용). 키 이름이 곧 make_spritesheet 입력명이라 빌더↔스키마 정합이 생명.
- **Action union `"make_sheet"`** 3곳 동기화: ImageResultCard / MessageList / ChatLayout handleAction. GallerySheet 는 자체 GalleryAction(make_sheet 없음) + ImageResultCard 미사용이라 무영향.
- **structuredContent / chat-state items / generations.kind enum 변경 없음.** 결과는 make_spritesheet 가 평소처럼 `spritesheet` kind 로 저장 → 기존 결과카드 흐름 재사용.

## 기존 회귀 체크 (무영향)
- reskin 패널: editing.mode==="reskin" 그대로. spriteGen 은 독립 상태.
- sprite(SpriteCanvas) / layer / inpaint 패널: 변경 없음.
- Composer: onOpenSpriteGen 옵셔널 — 미전달 시 버튼 미렌더. 기존 send/batch/frames/preset 흐름 무변경.
- ImageResultCard: spritesheet 카드는 [캐릭터] 그대로(삼항 분기), 비-시트만 [시트 만들기] 신규.
- GallerySheet onAction(narrower) ← handleAction(wider) 할당 정상.

## 셀프 게이트 결과
- `npx tsc --noEmit`: 0 error
- `pnpm lint`: 0 error / 0 warning
- `pnpm build`: 성공(14 routes)
- 마커 빌더 순수 함수: 독립 스크립트로 character/effect/custom 3케이스 출력 확인 — 형식 정확.
- dev server(:3000) 컴파일 클린. **브라우저 클릭 상호작용(패널 열기·토글·그리드 갱신·결과카드 진입)은 Playwright 미설치로 직접 미실행 → visual-qa 위임.**

## visual-qa 체크리스트
1. **진입점 a**: Composer [▦ 시트] 클릭 → fresh 패널 오픈(참조 미리보기 없음, 캐릭터 기본).
2. **진입점 b**: 단일 이미지 결과카드 [▦ 시트 만들기] → 참조 미리보기 채워진 패널. spritesheet 카드엔 이 버튼 없고 [캐릭터]만.
3. **종류 토글**: 캐릭터↔이펙트 전환 시 옵션 영역 교체(액션/방향/프레임/방향/앵커 ↔ 이펙트종류/프레임수).
4. **그리드 미리보기 갱신**: 방향 4·프레임/방향 6 → 4×6 격자 + 행 라벨(정면/측면/후면/측면). 이펙트 8프레임 → 2×4. 옵션 변경 즉시 반영.
5. **앵커 hip 힌트**: 앵커=엉덩이 선택 시 "인간형 권장" 문구.
6. **커스텀**: 액션/이펙트=커스텀 → textarea 노출, 비우면 [생성] disabled.
7. **마커→make_spritesheet passthrough (핵심 통합)**:
   - 캐릭터 4방향·6프레임·hip·루프 OFF 로 [생성] → data/logs 의 make_spritesheet 호출에서 `rows=4, cols=6, subjectType=character, anchorStrategy=hip, directions=4, seamlessLoop=false` 가 **그대로** 전달됐는지(추론 변형 없음) 확인. directions=4 → MCP 가 rows=4 강제(이미 일치).
   - 이펙트 8프레임 → `rows=2, cols=4, subjectType=effect, seamlessLoop` 전달, directions/anchorStrategy 미전달 확인.
   - 결과 generation.params 에 subjectType/anchorStrategy/directions 가 저장되는지(server.ts L526~529).
8. **참조 연결**: 진입점 b 생성 시 [reference: id] 가 prefix 돼 make_spritesheet inputGenerationId 로 들어가는지.
9. **결과카드 정상 표시**: 생성 결과가 spritesheet kind 로 기존 결과카드(캐릭터/스프라이트 액션 포함) 표시, 셀 정렬·투명 후처리 적용.
10. **게이트**: pnpm build/lint 재확인. (codex 실제 생성은 한도 고려 1~2회.)
