/** 픽셀 언페이크 ON 실생성 — 격자가 없어도 끝까지 가는지, 경고가 관측되는지. */
import { runPlanDrivenSpritesheet } from "../src/lib/mcp/handlers/plan-driven-spritesheet";

const BASE = "euaom92zbh0jrchz";
void (async () => {
  const t0 = Date.now();
  const lines: string[] = [];
  try {
    const res = await runPlanDrivenSpritesheet(
      {
        baseGenerationId: BASE,
        characterId: "pu-e2e",
        description: "a blue knight in plate armor",
        uiDirection: "REF",
        frames: 4,
        loop: true,
        actionPrompt: "subtle idle breathing",
        fit: { pixel_unfake: true },
      },
      {},
      {
        sessionId: null,
        log: (m: string) => { lines.push(m); console.log("  " + m); },
      },
    );
    const s = res.structuredContent as Record<string, unknown>;
    console.log(`\n=== 완료 ${Math.round((Date.now() - t0) / 1000)}s ===`);
    console.log("generationId:", s.generationId);
    console.log("크기:", `${s.width}x${s.height}`);
  } catch (e) {
    console.log(`\n=== 실패 ${Math.round((Date.now() - t0) / 1000)}s ===`);
    console.log((e as Error).message);
  }
  console.log("\n--- 격자/청크/언페이크 관련 로그 ---");
  for (const l of lines) {
    if (/격자|청크|피치|언페이크|경고|pitch|chunk/.test(l)) console.log("  " + l);
  }
})();
