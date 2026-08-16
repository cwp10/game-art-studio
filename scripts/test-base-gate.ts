/**
 * base 잠금 게이트 단위 테스트 — codex 미사용, 합성 이미지로 판정한다.
 *
 *   pnpm tsx scripts/test-base-gate.ts
 */
import sharp from "sharp";
import {
  detectBackgroundMode,
  inspectBaseImage,
  softAlphaFraction,
  subjectBBox,
  touchesEdge,
} from "../src/lib/sprite/base-gate";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** RGBA 원시 버퍼를 만든다. paint(x,y) 가 [r,g,b,a] 를 돌려준다. */
function makeRaw(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): { raw: Buffer; width: number; height: number; channels: number } {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  return { raw, width, height, channels: 4 };
}

const SIZE = 32;

// ── flat: 순수 마젠타 배경 + 중앙 피사체 ──────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) =>
    x > 10 && x < 21 && y > 10 && y < 21 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("평면 마젠타 배경 → flat", bg.mode === "flat", bg.mode);
  if (bg.mode === "flat") {
    check("배경색 복원", bg.hex.toLowerCase() === "#ff00ff", bg.hex);
    check("테두리 커버리지 1.0", bg.borderCoverage === 1, String(bg.borderCoverage));
  }
}

// ── flat: 코덱 지터가 낀 배경 ─────────────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) => {
    if (x > 10 && x < 21 && y > 10 && y < 21) return [20, 40, 200, 255];
    const jitter = ((x + y) % 3) - 1; // -1..1
    return [255, Math.max(0, 4 + jitter), 255, 255];
  });
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("지터가 있어도 flat 으로 판정", bg.mode === "flat", bg.mode);
}

// ── transparent: 테두리가 거의 투명 ───────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) =>
    x > 10 && x < 21 && y > 10 && y < 21 ? [20, 40, 200, 255] : [0, 0, 0, 0],
  );
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("투명 테두리 → transparent", bg.mode === "transparent", bg.mode);
}

// ── heterogeneous: 테두리가 그라디언트 ────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(SIZE, SIZE, (x, y) => [
    Math.round((x / (SIZE - 1)) * 255),
    Math.round((y / (SIZE - 1)) * 255),
    128,
    255,
  ]);
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("그라디언트 테두리 → heterogeneous", bg.mode === "heterogeneous", bg.mode);
}

// ── 경계: 1×1 이미지도 죽지 않는다 ────────────────────────────────
{
  const { raw, width, height, channels } = makeRaw(1, 1, () => [255, 0, 255, 255]);
  const bg = detectBackgroundMode(raw, width, height, channels);
  check("1×1 이미지 처리", bg.mode === "flat", bg.mode);
}

// ── softAlphaFraction ─────────────────────────────────────────────
{
  const opaque = makeRaw(16, 16, () => [10, 20, 30, 255]);
  check(
    "반투명 없음 → 0",
    softAlphaFraction(opaque.raw, opaque.width, opaque.height, opaque.channels) === 0,
  );

  const half = makeRaw(16, 16, x => [10, 20, 30, x < 8 ? 128 : 255]);
  check(
    "절반 반투명 → 0.5",
    Math.abs(softAlphaFraction(half.raw, half.width, half.height, half.channels) - 0.5) < 1e-9,
  );

  const cut = makeRaw(16, 16, x => [10, 20, 30, x < 8 ? 0 : 255]);
  check(
    "완전 투명은 세지 않는다",
    softAlphaFraction(cut.raw, cut.width, cut.height, cut.channels) === 0,
  );
}

// ── subjectBBox / touchesEdge ─────────────────────────────────────
{
  const img = makeRaw(32, 32, (x, y) =>
    x >= 10 && x <= 20 && y >= 10 && y <= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
  const box = subjectBBox(img.raw, img.width, img.height, img.channels, bg);
  check("피사체 bbox 검출", box !== null);
  if (box) {
    check(
      "bbox 좌표 정확",
      box.x0 === 10 && box.y0 === 10 && box.x1 === 20 && box.y1 === 20,
      JSON.stringify(box),
    );
    check("가장자리에 닿지 않음", !touchesEdge(box, img.width, img.height));
  }

  const full = makeRaw(32, 32, (x, y) =>
    x >= 0 && x <= 20 && y >= 10 && y <= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255],
  );
  const fullBg = detectBackgroundMode(full.raw, full.width, full.height, full.channels);
  const fullBox = subjectBBox(full.raw, full.width, full.height, full.channels, fullBg);
  check("잘린 피사체는 가장자리에 닿음", fullBox !== null && touchesEdge(fullBox, 32, 32));

  const trans = makeRaw(32, 32, (x, y) =>
    x >= 12 && x <= 18 && y >= 12 && y <= 18 ? [20, 40, 200, 255] : [0, 0, 0, 0],
  );
  const transBg = detectBackgroundMode(trans.raw, trans.width, trans.height, trans.channels);
  const transBox = subjectBBox(trans.raw, trans.width, trans.height, trans.channels, transBg);
  check(
    "투명 배경에서 bbox 검출",
    transBox !== null && transBox.x0 === 12 && transBox.x1 === 18,
    JSON.stringify(transBox),
  );

  const empty = makeRaw(16, 16, () => [255, 0, 255, 255]);
  const emptyBg = detectBackgroundMode(empty.raw, empty.width, empty.height, empty.channels);
  check(
    "피사체 없으면 null",
    subjectBBox(empty.raw, empty.width, empty.height, empty.channels, emptyBg) === null,
  );
}

// sharp 가 실제로 같은 레이아웃을 주는지 확인 (raw 규약 고정)
void (async () => {
  const png = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const { data, info } = await sharp(png)
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bg = detectBackgroundMode(data, info.width, info.height, info.channels);
  check("sharp raw 버퍼와 호환", bg.mode === "flat", `${bg.mode} ch=${info.channels}`);

  // ── inspectBaseImage (파일 경로 기반) ───────────────────────────
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "base-gate-test-"));

  // 통과 케이스: 평면 마젠타 배경 + 잘리지 않은 중앙 피사체, AA 없음
  const goodPath = join(tmp, "good.png");
  await sharp(
    makeRaw(64, 64, (x, y) =>
      x >= 20 && x <= 43 && y >= 20 && y <= 43 ? [20, 40, 200, 255] : [255, 0, 255, 255],
    ).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png()
    .toFile(goodPath);

  const good = await inspectBaseImage(goodPath);
  check("통과 케이스 autoPass", good.autoPass, JSON.stringify(good.checks));
  check("검사 3종 보고", good.checks.length === 3, String(good.checks.length));
  check("치수 보고", good.width === 64 && good.height === 64);

  // 실패 케이스: 피사체가 가장자리까지 잘림
  const croppedPath = join(tmp, "cropped.png");
  await sharp(makeRaw(64, 64, (x, y) => (y >= 20 ? [20, 40, 200, 255] : [255, 0, 255, 255])).raw, {
    raw: { width: 64, height: 64, channels: 4 },
  })
    .png()
    .toFile(croppedPath);

  const cropped = await inspectBaseImage(croppedPath);
  check("잘린 피사체는 autoPass 실패", !cropped.autoPass);
  check(
    "실패 항목이 fullBody",
    cropped.checks.find(c => c.id === "fullBody")?.ok === false,
    JSON.stringify(cropped.checks),
  );

  // pixelArt 옵션: AA 가 있으면 실패
  const aaPath = join(tmp, "aa.png");
  await sharp(
    makeRaw(64, 64, (x, y) => {
      const inside = x >= 20 && x <= 43 && y >= 20 && y <= 43;
      const edge = x === 19 || x === 44 || y === 19 || y === 44;
      if (edge) return [20, 40, 200, 128];
      return inside ? [20, 40, 200, 255] : [255, 0, 255, 255];
    }).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png()
    .toFile(aaPath);

  const aa = await inspectBaseImage(aaPath, { pixelArt: true });
  check(
    "픽셀아트 런에서 AA 가장자리는 실패",
    aa.checks.find(c => c.id === "pixelArt")?.ok === false,
    JSON.stringify(aa.checks),
  );

  const aaOff = await inspectBaseImage(aaPath);
  check(
    "픽셀아트 런이 아니면 AA 는 통과",
    aaOff.checks.find(c => c.id === "pixelArt")?.ok === true,
  );

  // 알파 채널이 없는 원본 — AA 를 측정할 수 없으므로 unmeasured 로 드러나야 한다.
  // (실측: codex 가 만든 PNG 는 channels=3, hasAlpha=false 다.)
  const noAlphaPath = join(tmp, "no-alpha.png");
  await sharp(
    makeRaw(64, 64, (x, y) =>
      x >= 20 && x <= 43 && y >= 20 && y <= 43 ? [20, 40, 200, 255] : [255, 0, 255, 255],
    ).raw,
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .removeAlpha()
    .png()
    .toFile(noAlphaPath);

  const noAlpha = await inspectBaseImage(noAlphaPath, { pixelArt: true });
  const noAlphaCheck = noAlpha.checks.find(c => c.id === "pixelArt");
  check(
    "알파 없는 원본은 unmeasured 로 표시",
    noAlphaCheck?.unmeasured === true,
    JSON.stringify(noAlphaCheck),
  );
  check("unmeasured 여도 ok 는 true (차단하지 않음)", noAlphaCheck?.ok === true);

  // ── base 잠금 저장·조회 ─────────────────────────────────────────
  const { createGeneration, getLockedBase, lockBaseGeneration } = await import(
    "../src/lib/db/repo/generations"
  );
  const { newGenerationId } = await import("../src/lib/util/ids");

  const genId = newGenerationId();
  createGeneration({
    id: genId,
    session_id: null,
    message_id: null,
    kind: "text2img",
    prompt: "base idle candidate",
    image_path: "data/images/dummy.png",
    params: { source: "test" },
  });

  // 개발 DB 를 공유하므로 "잠긴 base 가 하나도 없다"를 단언하면 안 된다 —
  // CLI(gen-sprite-run)가 남긴 잠금이 있으면 깨진다. 이 generation 이 아직 base 가
  // 아니라는 것만 본다.
  check("잠금 전에는 이 generation 이 base 가 아니다", getLockedBase(null)?.id !== genId);

  // `lockBaseGeneration` 은 **같은 스코프의 기존 base 표식을 걷어낸다**. 개발 DB 를
  // 공유하니 이 테스트가 사람이 게이트에서 잠근 base 를 풀어버린다 — 실제로 그래서
  // 다음 생성이 "base 자동 잠금 (게이트 미검토)" 로 빠졌다(2026-08-16). 테스트가
  // 남기는 행만 지우는 것으로는 부족하고, 걷어낸 잠금을 되돌려야 한다.
  const priorBase = getLockedBase(null)?.id ?? null;

  lockBaseGeneration(genId, null);
  const locked = getLockedBase(null);
  check("잠금 후 조회됨", locked?.id === genId, locked?.id ?? "null");
  check(
    "기존 params 를 보존",
    (locked?.params as Record<string, unknown> | undefined)?.source === "test",
    JSON.stringify(locked?.params),
  );

  // 두 번째 base 를 잠그면 그것이 현재 base 가 된다
  const genId2 = newGenerationId();
  createGeneration({
    id: genId2,
    session_id: null,
    message_id: null,
    kind: "text2img",
    prompt: "second base",
    image_path: "data/images/dummy2.png",
  });
  lockBaseGeneration(genId2, null);
  check("가장 최근 잠금이 현재 base", getLockedBase(null)?.id === genId2);

  // 정리 — 테스트가 남긴 행을 지우고, 걷어낸 잠금을 되돌린다.
  const { deleteGeneration } = await import("../src/lib/db/repo/generations");
  deleteGeneration(genId);
  deleteGeneration(genId2);
  if (priorBase) lockBaseGeneration(priorBase, null);
  check(
    "테스트 전 잠겨 있던 base 를 되돌렸다",
    (getLockedBase(null)?.id ?? null) === priorBase,
    `prior=${priorBase} now=${getLockedBase(null)?.id ?? "null"}`,
  );

  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
