/**
 * 보행/달리기 포즈 가이드 레퍼런스 PNG 재생성.
 *   pnpm gen:poses
 *
 * buildPoseSvg(통합 computePose 기하) → 8방향(행)×8프레임(열), 셀 384px → 3072×3072 PNG 2장:
 *   data/reference/pose-guided-walk-8dir.png
 *   data/reference/pose-guided-run-8dir.png
 *
 * pose-reference.ts의 기하(computePose/buildPoseSvg)를 바꾸면 반드시 이 스크립트를 재실행해야
 * 프로덕션(extractPoseGuideGrid 가 이 PNG에서 추출)에 반영된다. 실행 시 stale 추출 캐시
 * (data/templates/pose-*.png)를 전부 삭제해 다음 생성 때 새 소스로 재추출되게 한다.
 */
import { writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { buildEightDirReferenceSheet } from "@/lib/image-backend/pose-reference";
import { REFERENCE_DIR, TEMPLATES_DIR, ensureDataDirs } from "@/lib/util/paths";

const CELL = 384; // 8 × 384 = 3072

async function main() {
  ensureDataDirs();

  for (const isRun of [false, true]) {
    const type = isRun ? "run" : "walk";
    const buf = await buildEightDirReferenceSheet(CELL, isRun);
    const out = path.join(REFERENCE_DIR, `pose-guided-${type}-8dir.png`);
    writeFileSync(out, buf);
    console.log(`[gen:poses] wrote ${out} (${8 * CELL}×${8 * CELL}, ${(buf.length / 1024).toFixed(0)}KB)`);
  }

  // 소스 PNG가 바뀌었으므로 추출 캐시 전부 무효화.
  if (existsSync(TEMPLATES_DIR)) {
    const stale = readdirSync(TEMPLATES_DIR).filter(f => f.startsWith("pose-") && f.endsWith(".png"));
    for (const f of stale) rmSync(path.join(TEMPLATES_DIR, f));
    console.log(`[gen:poses] cleared ${stale.length} stale template cache file(s)`);
  }
}

main().catch(e => {
  console.error("[gen:poses] failed:", e);
  process.exit(1);
});
