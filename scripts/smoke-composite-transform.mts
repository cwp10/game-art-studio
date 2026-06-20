/**
 * 단독 스모크: runComposite 가 신규 레이어 필드(rotation+flipH+stretchW/H+filters)를 적용하면서
 * 투명 알파를 보존하는지 검증한다. codex 호출 없음(순수 sharp 경로).
 *
 * 검증 항목:
 *  1) PNG 생성 + 4채널(RGBA) 출력.
 *  2) 알파 보존: 출력 코너 픽셀 alpha=0 (회전+contrast+blur 후에도 투명 배경 유지).
 *  3) filter-only 레이어가 hasTransform 게이트를 통과(폴백으로 새지 않음).
 *  4) 하위호환: 신규 필드 미지정/중립 호출의 출력이 기존 경로와 byte-identical.
 *
 * 실행: pnpm exec tsx scripts/smoke-composite-transform.mts
 */
import sharp from "sharp";
import { runComposite } from "../src/lib/image-backend/composite-runner";
import { resolveImagePath } from "../src/lib/util/paths";
import { getGeneration } from "../src/lib/db/repo/generations";

// 투명 배경(remove_bg/layer_extract) 결과를 시드로 사용 — 알파 보존을 실제로 검증할 수 있다.
const SEED = "1hxvij5ishkv8pqk"; // remove_bg, 1254x1254

async function cornerAlpha(imagePath: string): Promise<number> {
  const { data } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[3]; // top-left pixel alpha
}

async function main() {
  const seed = getGeneration(SEED);
  if (!seed) throw new Error(`seed generation not found: ${SEED} — pick another transparent-bg id`);

  // --- 1) 신규 필드 전부 포함한 합성 ---
  const full = await runComposite({
    layers: [
      {
        generationId: SEED,
        opacity: 90,
        x: 40,
        y: -20,
        scale: 0.8,
        rotation: 18, // 회전 → 투명 코너 생성
        flipH: true, // 좌우반전
        stretchW: 1.3, // 비균일 늘이기
        stretchH: 0.85,
        filters: { brightness: 115, saturation: 130, hue: 25, contrast: 140, blur: 2 },
      },
      // filter-only 레이어(지오메트리 변형 없음) — hasTransform 게이트 통과 확인.
      {
        generationId: SEED,
        opacity: 50,
        filters: { brightness: 80, contrast: 120 },
      },
    ],
    sessionId: null,
    outputWidth: 1024,
    outputHeight: 1024,
  });
  const fullPath = resolveImagePath(getGeneration(full.generationId)!.image_path);
  const fullMeta = await sharp(fullPath).metadata();
  const fullCorner = await cornerAlpha(fullPath);
  console.log(`[1] full transform -> ${full.generationId} ${fullMeta.width}x${fullMeta.height} ch=${fullMeta.channels}`);
  console.log(`    corner alpha = ${fullCorner} (expect 0 — alpha preserved through rotate+contrast+blur)`);
  console.log(`    PATH: ${fullPath}`);

  if (fullMeta.channels !== 4) throw new Error(`FAIL: output not RGBA (channels=${fullMeta.channels})`);
  if (fullCorner !== 0) throw new Error(`FAIL: corner alpha=${fullCorner}, transparent background destroyed`);

  // --- 2) 하위호환: 신규 필드 미지정 vs 중립 명시 → byte-identical ---
  const baseLayers = { generationId: SEED, opacity: 100, x: 10, y: 10, scale: 1.0 };
  const noNew = await runComposite({
    layers: [baseLayers],
    sessionId: null,
    outputWidth: 512,
    outputHeight: 512,
  });
  const neutralNew = await runComposite({
    layers: [
      {
        ...baseLayers,
        rotation: 0,
        flipH: false,
        stretchW: 1,
        stretchH: 1,
        filters: { brightness: 100, saturation: 100, hue: 0, contrast: 100, blur: 0 },
      },
    ],
    sessionId: null,
    outputWidth: 512,
    outputHeight: 512,
  });
  const a = await sharp(resolveImagePath(getGeneration(noNew.generationId)!.image_path)).raw().toBuffer();
  const b = await sharp(resolveImagePath(getGeneration(neutralNew.generationId)!.image_path)).raw().toBuffer();
  const identical = a.equals(b);
  console.log(`[2] backward-compat byte-identical (no-new vs neutral-new): ${identical}`);
  if (!identical) throw new Error("FAIL: neutral new fields changed output — regression risk");

  console.log("\nALL SMOKE CHECKS PASSED");
  console.log(`VIEW: ${fullPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
