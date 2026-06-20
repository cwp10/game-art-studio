// 검증 스크립트: runComposite / runSpriteEffect 를 실제 DB 픽스처로 호출한다.
// 실행: node --import tsx scripts/test-mcp-phase1.mts
// (runner 는 .ts 를 .js 확장자로 import 하므로 tsx 로더 필요.)
import { runComposite } from "../src/lib/image-backend/composite-runner.js";
import { runSpriteEffect } from "../src/lib/image-backend/sprite-effect-runner.js";

const COMPOSITE_LAYERS = [
  { generationId: "8aovpfe31koivaip" }, // base (1254x1254)
  { generationId: "l6u2lnb8g5kduwyr", opacity: 70 }, // overlay
];
const SHEET_ID = "quqga9g0d8ik18q1"; // kind=spritesheet 4x4

async function main() {
  console.log("=== runComposite ===");
  const comp = await runComposite({ layers: COMPOSITE_LAYERS });
  console.log(JSON.stringify(comp));

  console.log("=== runSpriteEffect: drop_shadow ===");
  const shadow = await runSpriteEffect({
    generationId: SHEET_ID,
    effect: "drop_shadow",
    params: { color: "#000000", opacity: 70, blur: 3, offsetX: 6, offsetY: 6 },
  });
  console.log(JSON.stringify(shadow));

  console.log("=== runSpriteEffect: outline ===");
  const outline = await runSpriteEffect({
    generationId: SHEET_ID,
    effect: "outline",
    params: { color: "#ffffff", opacity: 100, thickness: 3 },
  });
  console.log(JSON.stringify(outline));

  console.log("=== runSpriteEffect: glow ===");
  const glow = await runSpriteEffect({
    generationId: SHEET_ID,
    effect: "glow",
    params: { color: "#00ffff", opacity: 80, blur: 6 },
  });
  console.log(JSON.stringify(glow));

  // 결과 파일 경로(절대) 출력 — Read 도구로 육안 확인용.
  console.log("=== OUTPUT FILES (data/images) ===");
  for (const r of [comp, shadow, outline, glow]) {
    console.log(`data/images/${r.generationId}.png  (${r.width}x${r.height})`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
