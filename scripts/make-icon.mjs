/**
 * codex 가 생성한 마스터 PNG → macOS .icns (SpriteForge.app/Contents/Resources/AppIcon.icns).
 *   pnpm tsx scripts/make-icon.mjs <master.png>
 *
 * 아트는 그대로 두고, 코너를 라운드-스퀘어로 투명 처리(네이티브 아이콘 모양) 후
 * iconset 사이즈를 생성, iconutil 로 .icns 패키징한다.
 */
import sharp from "sharp";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: pnpm tsx scripts/make-icon.mjs <master.png>");
  process.exit(2);
}

const APP = "SpriteForge.app";
const RES = path.join(APP, "Contents/Resources");
const ICONSET = path.join("build", "AppIcon.iconset");
const SIZE = 1024;
const RADIUS = 230; // Apple squircle 근사 (≈22.5%)
const ZOOM = 1.06; // 얇은 검은 여백 제거용 살짝 확대 후 중앙 크롭

fs.mkdirSync(RES, { recursive: true });
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

const zoomed = Math.round(SIZE * ZOOM);
const offset = Math.round((zoomed - SIZE) / 2);

const base = await sharp(SRC)
  .resize(zoomed, zoomed, { fit: "cover", position: "centre" })
  .extract({ left: offset, top: offset, width: SIZE, height: SIZE })
  .toBuffer();

const mask = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);

const rounded = await sharp(base)
  .composite([{ input: mask, blend: "dest-in" }])
  .png()
  .toBuffer();

fs.writeFileSync(path.join(RES, "icon-master-1024.png"), rounded);

const sizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
for (const [name, sz] of sizes) {
  await sharp(rounded).resize(sz, sz).png().toFile(path.join(ICONSET, name));
}

execSync(`iconutil -c icns -o "${path.join(RES, "AppIcon.icns")}" "${ICONSET}"`);
console.log(`done → ${path.join(RES, "AppIcon.icns")}`);
