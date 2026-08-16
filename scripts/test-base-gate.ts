/**
 * base 잠금 게이트 단위 테스트 — codex 미사용, 합성 이미지로 판정한다.
 *
 *   pnpm tsx scripts/test-base-gate.ts
 */
import sharp from "sharp";
import { detectBackgroundMode } from "../src/lib/sprite/base-gate";

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
