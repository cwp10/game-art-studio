/**
 * ② Task 4 — 레이아웃 가이드 픽셀 대조.
 *
 * 기준 PNG 는 sprite-gen `draw_guide()` 가 만든다. 경로는 GUIDE_REF_DIR 로 준다:
 *
 *   .venv/bin/python -c "... draw_guide(out/'sq256-f4.png', 'idle', 4, normalize_cell({},256,None)) ..."
 *
 * 기준이 없으면 SKIP 하고 성공으로 치지 않는다 — 조용한 통과를 막는다.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderLayoutGuideBuffer } from "../src/lib/sprite/layout-guide";
import { normalizeCell, type RawCell } from "../src/lib/sprite/request";

const REF_DIR = process.env.GUIDE_REF_DIR ?? "";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

void (async () => {
  console.log("=== 기하 (기준 PNG 없이도 검증 가능) ===");
  {
    const cell = normalizeCell({});
    const g = renderLayoutGuideBuffer(4, cell);
    check("캔버스는 frames*cellW x cellH", g.width === 1024 && g.height === 256);
    check("RGB 3채널", g.raw.length === 1024 * 256 * 3);
    const at = (x: number, y: number): string => {
      const o = (y * g.width + x) * 3;
      return `#${[g.raw[o], g.raw[o + 1], g.raw[o + 2]]
        .map(v => v.toString(16).padStart(2, "0"))
        .join("")}`;
    };
    check("배경은 #f6f6f6", at(140, 140) === "#f6f6f6", at(140, 140));
    check("셀 좌상단은 테두리 #333333", at(0, 0) === "#333333", at(0, 0));
    check("테두리 두께 3 — x=2 는 테두리", at(2, 128) === "#333333", at(2, 128));
    check("테두리 두께 3 — x=3 은 배경", at(3, 128) === "#f6f6f6", at(3, 128));
    check("safe 사각형 좌변 #2f80ed", at(24, 128) === "#2f80ed", at(24, 128));
    check("safe 두께 2 — x=25 도 safe", at(25, 128) === "#2f80ed", at(25, 128));
    check("safe 두께 2 — x=26 은 배경", at(26, 128) === "#f6f6f6", at(26, 128));
    check("중앙선 #b8c8e8", at(128, 128) === "#b8c8e8", at(128, 128));
    // 원본의 비대칭: safe 아래변은 y=231, 중앙선은 y=232 까지 내려간다.
    check("중앙선이 safe 아래변보다 1px 더 내려간다", at(128, 232) === "#b8c8e8", at(128, 232));
    check("y=233 은 배경", at(128, 233) === "#f6f6f6", at(128, 233));
    check("두 번째 셀의 좌테두리", at(256, 128) === "#333333", at(256, 128));
  }
  {
    let threw = false;
    try {
      renderLayoutGuideBuffer(0, normalizeCell({}));
    } catch {
      threw = true;
    }
    check("frames 0 은 거부", threw);
  }

  console.log("=== Python 기준 PNG 픽셀 대조 ===");
  const CASES: Array<[string, [RawCell, number, number | null], number]> = [
    ["sq256-f4", [{}, 256, null], 4],
    ["sq128-f6", [{ size: 128 }, 128, null], 6],
    ["rect192x208-f4", [{ width: 192, height: 208 }, 256, null], 4],
    ["sq256-m40-f8", [{}, 256, 40], 8],
  ];
  if (!REF_DIR) {
    console.log("  SKIP  GUIDE_REF_DIR 미설정 — Python 기준 대조를 건너뛴다");
    skipped += CASES.length;
  } else {
    for (const [label, cellArgs, frames] of CASES) {
      const refPath = join(REF_DIR, `${label}.png`);
      if (!existsSync(refPath)) {
        console.log(`  SKIP  ${label} — 기준 PNG 없음 (${refPath})`);
        skipped++;
        continue;
      }
      const cell = normalizeCell(cellArgs[0], cellArgs[1], cellArgs[2]);
      const mine = renderLayoutGuideBuffer(frames, cell);
      const ref = await sharp(refPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (ref.info.width !== mine.width || ref.info.height !== mine.height) {
        check(
          `${label} 치수 일치`,
          false,
          `ref ${ref.info.width}x${ref.info.height} vs ${mine.width}x${mine.height}`,
        );
        continue;
      }
      let diff = 0;
      let firstDiff = "";
      for (let i = 0; i < ref.data.length; i++) {
        if (ref.data[i] !== mine.raw[i]) {
          if (diff === 0) {
            const px = (i / 3) | 0;
            firstDiff = `첫 차이 (${px % mine.width},${(px / mine.width) | 0}) ref=${ref.data[i]} mine=${mine.raw[i]}`;
          }
          diff++;
        }
      }
      check(`${label} 픽셀 동일`, diff === 0, `${diff} bytes 불일치; ${firstDiff}`);
    }
  }

  console.log(`\n${passed} passed / ${failed} failed / ${skipped} skipped`);
  if (failed > 0) process.exit(1);
})();
