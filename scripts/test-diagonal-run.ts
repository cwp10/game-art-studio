/**
 * 대각선 4방향 달리기만 재생성.
 * pnpm tsx scripts/test-diagonal-run.ts
 */
import path from "node:path";
import sharp from "sharp";
import { handleMakeSpritesheet } from "@/lib/mcp/handlers/spritesheet-handler";
import { DATA_DIR } from "@/lib/util/paths";

const DIRS = ["DOWN-LEFT", "UP-LEFT", "UP-RIGHT", "DOWN-RIGHT"] as const;
const COLS = 4;
const ROWS = 2;
const FINAL_CELL_PX = 512;
const OUT_PATH = path.join(DATA_DIR, "images", `diagonal-run-test-${Date.now()}.png`);

const PROMPT =
  "pixel art bare-skinned male character in briefs/underwear, " +
  "leaning body slightly forward, arms pumping vigorously, fast running sprint cycle, " +
  "pixel art, 16-bit style, sharp pixels, transparent background";

async function main() {
  console.log("[test-diagonal] 대각선 4방향 달리기 시작...");
  const rowPaths: string[] = [];

  for (let i = 0; i < DIRS.length; i++) {
    const facing = DIRS[i];
    console.log(`\n[test-diagonal] (${i + 1}/4) ${facing}...`);

    const result = await handleMakeSpritesheet(
      { prompt: PROMPT, rows: ROWS, cols: COLS, directions: 1, facing, seamlessLoop: false, viewpoint: "side" },
      { signal: undefined },
      { sessionId: null, log: (msg: string) => console.log(`  ${msg}`) },
    );

    const gid = (result as { structuredContent?: { generationId?: string } }).structuredContent?.generationId;
    if (!gid) throw new Error(`${facing} 실패`);
    rowPaths.push(path.join(DATA_DIR, "images", `${gid}.png`));
    console.log(`  → ${gid}.png`);
  }

  const ROW_W = COLS * FINAL_CELL_PX;
  const ROW_H = ROWS * FINAL_CELL_PX;

  const composites = await Promise.all(
    rowPaths.map(async (p, i) => ({
      input: await sharp(p).resize(ROW_W, ROW_H, { fit: "fill" }).png().toBuffer(),
      left: 0,
      top: i * ROW_H,
    })),
  );

  await sharp({
    create: { width: ROW_W, height: ROW_H * DIRS.length, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toFile(OUT_PATH);

  console.log(`\n[test-diagonal] 완료 → ${OUT_PATH}`);
  console.log(`[test-diagonal] 방향 (위→아래): ${DIRS.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
