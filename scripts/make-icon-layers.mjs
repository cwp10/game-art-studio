/**
 * Tahoe 레이어드 아이콘용 레이어 PNG 생성.
 *   pnpm tsx scripts/make-icon-layers.mjs <foreground-on-green.png>
 *
 * 출력 (icon-layers/):
 *   foreground.png — 크로마 그린 키 + 스필 억제로 투명화한 전경 엠블럼 (1024)
 *   background.png — 다크→바이올렛 그라디언트 배경 플레이트 (1024, 풀블리드)
 *
 * Icon Composer 에서 background(아래) + foreground(위) 두 레이어로 조립 → .icon 내보내기.
 */
import sharp from "sharp";
import fs from "node:fs";

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: pnpm tsx scripts/make-icon-layers.mjs <foreground-on-green.png>");
  process.exit(2);
}

const SIZE = 1024;
const OUT = "icon-layers";
fs.mkdirSync(OUT, { recursive: true });

// ── 전경: 그린 스크린 키 + 페더 + 스필 억제 ──────────────────────────────────
const { data, info } = await sharp(SRC)
  .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const ch = info.channels; // 4
for (let i = 0; i < data.length; i += ch) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const greenness = g - Math.max(r, b); // 그린 스크린일수록 큼
  if (greenness > 60) {
    data[i + 3] = 0; // 완전 투명
  } else if (greenness > 18) {
    // 가장자리 페더 + 스필 억제
    const t = (60 - greenness) / 42; // 0..1
    data[i + 3] = Math.round(data[i + 3] * Math.max(0, Math.min(1, t)));
    const cap = Math.max(r, b);
    if (g > cap) data[i + 1] = cap;
  } else if (g > Math.max(r, b) + 12) {
    data[i + 1] = Math.max(r, b) + 12; // 약한 그린 틴트 제거
  }
}

await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
  .png()
  .toFile(`${OUT}/foreground.png`);

// ── 배경: 다크→바이올렛 그라디언트 플레이트 ─────────────────────────────────
const bg = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#241b3a"/>` +
    `<stop offset="1" stop-color="#8b5cf6"/>` +
    `</linearGradient></defs>` +
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/></svg>`,
);
await sharp(Buffer.from(bg)).png().toFile(`${OUT}/background.png`);

console.log(`done → ${OUT}/foreground.png, ${OUT}/background.png`);
