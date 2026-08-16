/**
 * ⑥ Output Contract — 큐레이션 반영 재합성 테스트.
 *
 * 정본이 못박은 함정: `frames/` 를 그대로 설치하면 사람의 편집이 조용히 누락된다.
 * 우리 구조에서는 "큐레이션을 저장했는데 아틀라스가 그대로"가 같은 형태다. 저장 →
 * 재합성 → 아틀라스 PNG·매니페스트가 실제로 바뀌는지를 개발 DB 에 써서 확인한다.
 *
 *   pnpm tsx scripts/test-recompose.ts
 */
import { unlink } from "node:fs/promises";
import sharp from "sharp";
import {
  createGeneration,
  deleteGeneration,
  getGeneration,
  saveCuration,
} from "../src/lib/db/repo/generations";
import { newGenerationId } from "../src/lib/util/ids";
import { recomposeCuratedAtlas } from "../src/lib/sprite/recompose";
import {
  DEFAULT_CHROMA_TUNABLES,
  normalizeCell,
  type SpriteRequest,
} from "../src/lib/sprite/request";
import { imagePath, toRelative } from "../src/lib/util/paths";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const CELL = normalizeCell({ size: 64 });
const MAGENTA: [number, number, number] = [255, 0, 255];

/** frames 개 덩어리가 놓인 마젠타 크로마 행 시트. 덩어리마다 색이 다르다. */
async function writeRowSheet(dest: string, frames: number): Promise<void> {
  const w = 480;
  const h = 200;
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = 255;
    raw[i * 4 + 1] = 0;
    raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = 255;
  }
  const slot = w / frames;
  for (let f = 0; f < frames; f++) {
    const x0 = Math.round(f * slot + slot * 0.3);
    const x1 = Math.round(f * slot + slot * 0.7);
    for (let y = Math.floor(h * 0.25); y < Math.floor(h * 0.8); y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        raw[o] = 40 + f * 50; // 프레임마다 다른 빨강 — 어느 프레임이 구워졌는지 식별
        raw[o + 1] = 120;
        raw[o + 2] = 60;
        raw[o + 3] = 255;
      }
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(dest);
}

void (async () => {
  const FRAMES = 4;
  const request: SpriteRequest = {
    version: 1,
    character: { id: "recompose-test", description: "d", anchorGenerationId: "" },
    cell: CELL,
    chromaKey: { name: "magenta", hex: "#FF00FF", rgb: MAGENTA, selection: "auto" },
    chroma: DEFAULT_CHROMA_TUNABLES,
    states: { down_idle: { frames: FRAMES, fps: 4, loop: true, action: "idle" } },
  };

  const rowId = newGenerationId();
  const rowPath = imagePath(rowId);
  await writeRowSheet(rowPath, FRAMES);
  createGeneration({
    id: rowId,
    session_id: null,
    message_id: null,
    kind: "spritesheet",
    prompt: "row",
    image_path: toRelative(rowPath),
    params: { planDriven: true, state: "down_idle" },
    width: 480,
    height: 200,
  });

  const atlasId = newGenerationId();
  const atlasPath = imagePath(atlasId);
  // 처음에는 큐레이션 없이 구운 것처럼 4칸짜리 더미를 둔다.
  await sharp({
    create: { width: 4 * 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toFile(atlasPath);
  createGeneration({
    id: atlasId,
    session_id: null,
    message_id: null,
    kind: "spritesheet",
    prompt: "atlas",
    input_image_ids: [],
    image_path: toRelative(atlasPath),
    params: {
      rows: 1,
      cols: FRAMES,
      cellW: 64,
      cellH: 64,
      fps: 4,
      engine: "component-row",
      planDriven: true,
      states: ["down_idle"],
      rowGenerationIds: { down_idle: rowId },
      request,
    },
    width: 4 * 64,
    height: 64,
  });

  try {
    console.log("=== 큐레이션 없이 재합성 ===");
    {
      const r = await recomposeCuratedAtlas(atlasId);
      check("프레임 4개 그대로", r.frameCounts.down_idle === FRAMES, JSON.stringify(r.frameCounts));
      check("curation_applied=false", r.curationApplied === false);
      check("아틀라스 폭 4칸", r.width === 4 * 64, `${r.width}`);
      const meta = await sharp(atlasPath).metadata();
      check("PNG 도 4칸으로 쓰였다", meta.width === 4 * 64, `${meta.width}`);
    }

    console.log("=== 프레임 0 을 뺀 큐레이션 ===");
    {
      saveCuration(rowId, { selected: [1, 2, 3] });
      const r = await recomposeCuratedAtlas(atlasId);
      check("프레임 3개", r.frameCounts.down_idle === 3, JSON.stringify(r.frameCounts));
      check("curation_applied=true", r.curationApplied === true);
      check("columns 3", r.columns === 3);
      check("아틀라스가 좁아졌다", r.width === 3 * 64, `${r.width}`);

      const meta = await sharp(atlasPath).metadata();
      check("PNG 가 실제로 다시 쓰였다", meta.width === 3 * 64, `${meta.width}`);

      const gen = getGeneration(atlasId);
      check("params.cols 갱신", gen?.params?.cols === 3, String(gen?.params?.cols));
      check("params.curationApplied 갱신", gen?.params?.curationApplied === true);
      check("recomposedAt 기록", typeof gen?.params?.recomposedAt === "string");
      check("DB 치수 갱신", gen?.width === 3 * 64, String(gen?.width));
      const manifest = gen?.params?.manifest as { curation_applied?: boolean; animation?: { rows: Record<string, { frames: number }> } };
      check("매니페스트 curation_applied", manifest?.curation_applied === true);
      check("매니페스트 프레임 수", manifest?.animation?.rows.down_idle.frames === 3);

      // 첫 칸이 원래 프레임 1(빨강 90)이어야 한다 — 프레임 0(빨강 40)이 아니다.
      const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let firstCellRed = -1;
      for (let y = 0; y < info.height && firstCellRed < 0; y++) {
        for (let x = 0; x < 64; x++) {
          if (data[(y * info.width + x) * 4 + 3] > 200) {
            firstCellRed = data[(y * info.width + x) * 4];
            break;
          }
        }
      }
      check("첫 칸이 원래 프레임 1", firstCellRed === 90, `red=${firstCellRed}`);
    }

    console.log("=== 재정렬도 반영된다 ===");
    {
      saveCuration(rowId, { selected: [3, 0] });
      const r = await recomposeCuratedAtlas(atlasId);
      check("프레임 2개", r.frameCounts.down_idle === 2);
      const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let firstCellRed = -1;
      for (let y = 0; y < info.height && firstCellRed < 0; y++) {
        for (let x = 0; x < 64; x++) {
          if (data[(y * info.width + x) * 4 + 3] > 200) {
            firstCellRed = data[(y * info.width + x) * 4];
            break;
          }
        }
      }
      check("첫 칸이 원래 프레임 3", firstCellRed === 190, `red=${firstCellRed}`);
    }

    console.log("=== request 가 없으면 fail-loud ===");
    {
      const badId = newGenerationId();
      createGeneration({
        id: badId,
        session_id: null,
        message_id: null,
        kind: "spritesheet",
        prompt: "old sheet",
        image_path: "images/none.png",
        params: { rows: 2, cols: 4 },
      });
      let threw = "";
      try {
        await recomposeCuratedAtlas(badId);
      } catch (e) {
        threw = String(e);
      }
      check("플랜 구동이 아니면 던진다", threw.includes("request"), threw);
      deleteGeneration(badId);
    }
  } finally {
    // 개발 DB 를 공유하므로 만든 것은 치운다.
    deleteGeneration(atlasId);
    deleteGeneration(rowId);
    await unlink(rowPath).catch(() => {});
    await unlink(atlasPath).catch(() => {});
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
