/**
 * 마커 빌더 결정적 단위 테스트 (codex 미사용).
 * buildSpriteMessage 가 SpriteGenPanel 의 SpriteGenState → [spritesheet: ...] 마커 +
 * 자연어 + attachmentGenerationIds 로 정확히 합성하는지 단언한다.
 *
 * 단일 방향 스트립(directions=1; rows=1; cols=frames) 시트로 전면 개편됨.
 *
 * 실행: npx tsx --tsconfig tsconfig.json scripts/test-sprite-marker.ts
 */
import {
  buildSpriteMessage,
  type SpriteGenState,
} from "@/components/editor/SpriteGenPanel";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

function base(): SpriteGenState {
  return {
    subjectType: "character",
    direction: "DOWN",
    frames: 9,
    stylePresetId: null,
    seamlessLoop: false,
    actionPrompt: "걷기 모션",
  };
}

// ── Case 1: character (directions=1, anchorStrategy=feet, rows=1, cols=frames) ──
console.log("[Case 1] character full");
{
  const p: SpriteGenState = {
    ...base(),
    subjectType: "character",
    direction: "RIGHT",
    frames: 16,
    seamlessLoop: false,
    actionPrompt: "공격 모션",
  };
  const { message, attachmentGenerationIds } = buildSpriteMessage(p, "pixel art 16-bit");
  const [directive, nl] = message.split("\n");
  console.log(`  directive: ${directive}`);
  console.log(`  nl:        ${nl}`);
  assert(directive.includes("subjectType=character"), "subjectType=character");
  assert(directive.includes("anchorStrategy=feet"), "anchorStrategy=feet");
  assert(directive.includes("directions=1"), "directions=1");
  assert(directive.includes("framesPerDir=16"), "framesPerDir=16");
  assert(directive.includes("rows=1"), "rows=1");
  assert(directive.includes("cols=16"), "cols=16");
  assert(directive.includes("seamlessLoop=false"), "seamlessLoop=false");
  assert(directive.startsWith("[spritesheet: ") && directive.endsWith("]"), "directive 형식 [spritesheet: ...]");
  assert(nl.includes("공격 모션"), "자연어에 actionPrompt 포함");
  assert(nl.includes("pixel art 16-bit"), "자연어에 style suffix 포함");
  assert(nl.includes("facing RIGHT (side view)"), "자연어에 facingPhrase 포함");
  assert(nl.includes("transparent background"), "자연어에 transparent background 포함");
  assert(attachmentGenerationIds.length === 0, "참조 없으면 attachmentGenerationIds=[]");
}

// ── Case 2: effect (anchorStrategy=center, facingPhrase 생략) ──
console.log("[Case 2] effect");
{
  const p: SpriteGenState = {
    ...base(),
    subjectType: "effect",
    frames: 9,
    seamlessLoop: true,
    actionPrompt: "슬래시 이펙트",
  };
  const { message } = buildSpriteMessage(p);
  const [directive, nl] = message.split("\n");
  console.log(`  directive: ${directive}`);
  console.log(`  nl:        ${nl}`);
  assert(directive.includes("subjectType=effect"), "subjectType=effect");
  assert(directive.includes("anchorStrategy=center"), "anchorStrategy=center");
  assert(directive.includes("directions=1"), "directions=1");
  assert(directive.includes("rows=1"), "rows=1");
  assert(directive.includes("cols=9"), "cols=9");
  assert(directive.includes("seamlessLoop=true"), "seamlessLoop=true");
  assert(nl.includes("슬래시 이펙트"), "자연어에 actionPrompt 포함");
  assert(!nl.includes("facing"), "이펙트는 facingPhrase 생략");
  assert(nl.includes("transparent background"), "자연어 배경 포함");
}

// ── Case 3: object (anchorStrategy=center, facingPhrase 생략) ──
console.log("[Case 3] object");
{
  const p: SpriteGenState = {
    ...base(),
    subjectType: "object",
    frames: 4,
    actionPrompt: "코인 회전",
  };
  const { message } = buildSpriteMessage(p);
  const [directive, nl] = message.split("\n");
  assert(directive.includes("subjectType=object"), "subjectType=object");
  assert(directive.includes("anchorStrategy=center"), "anchorStrategy=center");
  assert(directive.includes("cols=4") && directive.includes("rows=1"), "rows=1; cols=4");
  assert(!nl.includes("facing"), "오브젝트는 facingPhrase 생략");
}

// ── Case 4: referenceId 있으면 attachmentGenerationIds=[refId] ──
console.log("[Case 4] reference attach");
{
  const { attachmentGenerationIds, message } = buildSpriteMessage(base(), null, "gen-abc-123");
  assert(
    attachmentGenerationIds.length === 1 && attachmentGenerationIds[0] === "gen-abc-123",
    "attachmentGenerationIds=[refId]",
  );
  assert(!message.includes("reference"), "마커 본문에는 reference 미포함(route 가 prefix)");
}

// ── Case 5: 방향별 facingPhrase 분기 (대각=3/4 view, UP=back view) ──
console.log("[Case 5] direction facing branches");
{
  const cases: Array<[SpriteGenState["direction"], string]> = [
    ["DOWN", "facing DOWN (front view)"],
    ["UP", "facing UP (back view)"],
    ["LEFT", "facing LEFT (side view)"],
    ["DOWN-LEFT", "facing DOWN-LEFT (3/4 front view)"],
    ["UP-RIGHT", "facing UP-RIGHT (3/4 back view)"],
  ];
  for (const [dir, phrase] of cases) {
    const { message } = buildSpriteMessage({ ...base(), direction: dir });
    const nl = message.split("\n")[1];
    assert(nl.includes(phrase), `${dir} → ${phrase}`);
  }
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
