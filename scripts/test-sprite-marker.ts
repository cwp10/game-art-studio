/**
 * Phase 3A 마커 빌더 결정적 단위 테스트 (codex 미사용).
 * buildSpriteMessage 가 SpriteGenPanel 의 구조화 payload → [spritesheet: ...] 마커 +
 * 자연어 + attachmentGenerationIds 로 정확히 합성하는지 단언한다.
 *
 * 실행: npx tsx --tsconfig tsconfig.json scripts/test-sprite-marker.ts
 */
import { buildSpriteMessage, type SpriteGenSubmit } from "@/components/editor/SpriteGenPanel";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

function base(): SpriteGenSubmit {
  return {
    subjectType: "character",
    preset: "walk",
    customText: "",
    anchorStrategy: "auto",
    directions: 4,
    framesPerDir: 6,
    effectFrames: 8,
    rows: 4,
    cols: 6,
    stylePresetId: null,
    description: "",
    background: "transparent",
    seamlessLoop: false,
  };
}

// ── Case 1: character (directions=4, framesPerDir=6, anchorStrategy=hip, rows=4, cols=6) ──
console.log("[Case 1] character full");
{
  const p: SpriteGenSubmit = {
    ...base(),
    subjectType: "character",
    preset: "attack",
    anchorStrategy: "hip",
    directions: 4,
    framesPerDir: 6,
    rows: 4,
    cols: 6,
    seamlessLoop: false,
    description: "파란 갑옷 기사",
    background: "transparent",
  };
  const { message, attachmentGenerationIds } = buildSpriteMessage(p, "pixel art 16-bit");
  const [directive, nl] = message.split("\n");
  console.log(`  directive: ${directive}`);
  console.log(`  nl:        ${nl}`);
  assert(directive.includes("subjectType=character"), "subjectType=character");
  assert(directive.includes("anchorStrategy=hip"), "anchorStrategy=hip");
  assert(directive.includes("directions=4"), "directions=4");
  assert(directive.includes("framesPerDir=6"), "framesPerDir=6");
  assert(directive.includes("rows=4"), "rows=4");
  assert(directive.includes("cols=6"), "cols=6");
  assert(directive.includes("seamlessLoop=false"), "seamlessLoop=false");
  assert(directive.startsWith("[spritesheet: ") && directive.endsWith("]"), "directive 형식 [spritesheet: ...]");
  // 자연어: 액션구(attack=melee attack swing motion) + 설명 + style suffix + 배경
  assert(nl.includes("melee attack swing motion"), "자연어에 액션구 포함");
  assert(nl.includes("파란 갑옷 기사"), "자연어에 설명 포함");
  assert(nl.includes("pixel art 16-bit"), "자연어에 style suffix 포함");
  assert(nl.includes("transparent background"), "자연어에 배경(transparent) 포함");
  assert(attachmentGenerationIds.length === 0, "참조 없으면 attachmentGenerationIds=[]");
}

// ── Case 2: effect (directions/anchorStrategy 생략, rows/cols/seamlessLoop 포함) ──
console.log("[Case 2] effect");
{
  const p: SpriteGenSubmit = {
    ...base(),
    subjectType: "effect",
    preset: "slash",
    rows: 2,
    cols: 4,
    seamlessLoop: true,
    background: "transparent",
  };
  const { message } = buildSpriteMessage(p);
  const [directive, nl] = message.split("\n");
  console.log(`  directive: ${directive}`);
  console.log(`  nl:        ${nl}`);
  assert(directive.includes("subjectType=effect"), "subjectType=effect");
  assert(!directive.includes("directions="), "directions 생략");
  assert(!directive.includes("anchorStrategy="), "anchorStrategy 생략");
  assert(!directive.includes("framesPerDir="), "framesPerDir 생략");
  assert(directive.includes("rows=2"), "rows=2");
  assert(directive.includes("cols=4"), "cols=4");
  assert(directive.includes("seamlessLoop=true"), "seamlessLoop=true");
  assert(nl.includes("slash trail vfx"), "자연어에 이펙트구 포함");
  assert(nl.includes("transparent background"), "자연어 배경 포함");
}

// ── Case 3: referenceId 있으면 attachmentGenerationIds=[refId] ──
console.log("[Case 3] reference attach");
{
  const p: SpriteGenSubmit = { ...base(), referenceId: "gen-abc-123" };
  const { attachmentGenerationIds, message } = buildSpriteMessage(p);
  assert(
    attachmentGenerationIds.length === 1 && attachmentGenerationIds[0] === "gen-abc-123",
    "attachmentGenerationIds=[refId]",
  );
  // 마커 자체에는 reference 가 들어가지 않음(route 가 prefix) — directive 에 reference 미포함
  assert(!message.includes("reference"), "마커 본문에는 reference 미포함(route 가 prefix)");
}

// ── Case 4: custom 액션 → customText 가 자연어에 반영 ──
console.log("[Case 4] custom action");
{
  const p: SpriteGenSubmit = {
    ...base(),
    preset: "custom",
    customText: "방패로 막으면서 뒤로 물러나기",
  };
  const { message } = buildSpriteMessage(p);
  const nl = message.split("\n")[1];
  console.log(`  nl: ${nl}`);
  assert(nl.includes("방패로 막으면서 뒤로 물러나기"), "customText 가 자연어에 반영");
}

// ── Case 5: background=white → "white background" ──
console.log("[Case 5] white background");
{
  const p: SpriteGenSubmit = { ...base(), background: "white" };
  const { message } = buildSpriteMessage(p);
  const nl = message.split("\n")[1];
  assert(nl.includes("white background") && !nl.includes("transparent background"), "white background");
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
