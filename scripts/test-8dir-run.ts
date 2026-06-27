/**
 * 8방향 달리기 스프라이트시트 전체 테스트.
 * directions=1, facing=<DIR> 로 방향당 1회 호출(4프레임) → 8행 수직 스티칭.
 *
 * 사용법: pnpm tsx scripts/test-8dir-run.ts
 */
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { handleMakeSpritesheet } from "@/lib/mcp/handlers/spritesheet-handler";
import { DATA_DIR } from "@/lib/util/paths";

const DIRS = ["DOWN", "DOWN-LEFT", "LEFT", "UP-LEFT", "UP", "UP-RIGHT", "RIGHT", "DOWN-RIGHT"] as const;
const COLS = 4;
const ROWS = 2; // 방향당 2행 × 4열 = 8프레임 (비율 2:1, 검증 통과)
const FINAL_CELL_PX = 512;
const OUT_PATH = path.join(DATA_DIR, "images", `8dir-run-test-${Date.now()}.png`);

const PROMPT =
  "pixel art bare-skinned male character in briefs/underwear, " +
  "leaning body slightly forward, arms pumping vigorously, fast running sprint cycle, " +
  "pixel art, 16-bit style, sharp pixels, transparent background";

async function main() {
  console.log("[test-8dir-run] 8방향 달리기 시작 (방향별 1회 codex 호출, 총 8회)...");
  const start = Date.now();
  const rowPaths: string[] = [];

  for (let i = 0; i < DIRS.length; i++) {
    const facing = DIRS[i];
    console.log(`\n[test-8dir-run] (${i + 1}/8) ${facing}...`);

    const result = await handleMakeSpritesheet(
      {
        prompt: PROMPT,
        rows: ROWS,
        cols: COLS,
        directions: 1,
        facing,
        seamlessLoop: false,
        viewpoint: "side",
      },
      { signal: undefined },
      { sessionId: null, log: (msg: string) => console.log(`  ${msg}`) },
    );

    const sc = (result as { structuredContent?: { generationId?: string } }).structuredContent;
    const gid = sc?.generationId;
    if (!gid) throw new Error(`${facing} 방향 생성 실패`);

    const imgPath = path.join(DATA_DIR, "images", `${gid}.png`);
    rowPaths.push(imgPath);
    console.log(`  → ${gid}.png`);
  }

  // 8행 수직 스티칭
  const ROW_W = COLS * FINAL_CELL_PX;
  const ROW_H = ROWS * FINAL_CELL_PX;

  const composites = await Promise.all(
    rowPaths.map(async (p, i) => {
      const buf = await sharp(p)
        .resize(ROW_W, ROW_H, { fit: "fill" })
        .png()
        .toBuffer();
      return { input: buf, left: 0, top: i * ROW_H };
    }),
  );

  await sharp({
    create: {
      width: ROW_W,
      height: ROW_H * DIRS.length,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(OUT_PATH);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[test-8dir-run] 완료 (${elapsed}s)`);
  console.log(`[test-8dir-run] 결과: ${OUT_PATH}`);
  console.log(`[test-8dir-run] 방향 순서 (위→아래): ${DIRS.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
