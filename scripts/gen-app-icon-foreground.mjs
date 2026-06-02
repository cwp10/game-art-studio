#!/usr/bin/env node
// One-off: Sprite Forge macOS app icon FOREGROUND generation.
//
// Flow (mirrors CodexExecBackend text2img + remove_bg post-process):
//   1. codex exec (text2img shape: no -i, no --) → ./output.png on a #00ff00 chroma-key bg
//   2. chroma-key green out (greenness feather, replicated from codex-exec.ts)
//   3. sharp: trim to alpha bbox → contain-resize to ~80% → center on 1024x1024 transparent canvas
//
// Output: /Users/.../icon-source-foreground.png  (RGBA 1024x1024, transparent bg)

import { spawn } from "node:child_process";
import { mkdtemp, stat, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const FINAL = path.join(ROOT, "icon-source-foreground.png");
const CANVAS = 1024;
const CONTENT_FRACTION = 0.8; // ~10% padding each side

const PROMPT_HEADER =
  "Use the imagegen skill. " +
  "Save the result as a PNG file at the path ./output.png in your current working directory. " +
  "Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.\n\n";

const SUBJECT =
  "Generate an image: a pixel art blacksmith anvil with a glowing magical sparkle star " +
  "and small star bursts shimmering above it, app icon foreground artwork. " +
  "Render the anvil and sparkles on a SOLID FLAT #00ff00 green chroma-key background " +
  "(pure green, no shadows, no gradients, crisp clean edges) so the green can be keyed out later. " +
  "Use ONLY metallic silver and bright white highlights for the anvil, warm gold/white for the sparkle, " +
  "and a bold dark outline around every shape so it reads on both light and dark backgrounds. " +
  "ABSOLUTELY NO green or teal anywhere in the anvil or sparkles themselves — green is reserved for the background only. " +
  "Clean crisp pixel art style, the anvil centered with generous empty margin on all sides. 1024x1024.";

const log = (...a) => console.log("[icon]", ...a);

async function chromaKeyGreen(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const greenness = g - Math.max(r, b);
    if (greenness > 40 && g > 90) {
      data[i + 3] = 0;
      continue;
    }
    if (data[i + 3] > 0 && greenness > 5) {
      data[i + 1] = Math.max(r, b);
      const fade = 1 - Math.min(1, (greenness - 5) / 35);
      data[i + 3] = Math.round(data[i + 3] * fade);
    }
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch },
  })
    .png()
    .toBuffer();
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "icon-fg-"));
  const prompt = PROMPT_HEADER + SUBJECT;

  log("workDir:", workDir);
  log("spawning codex exec (text2img shape)...");
  const start = performance.now();

  const child = spawn(
    "codex",
    [
      "exec",
      "--cd",
      workDir,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      prompt,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  const exit = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  log(`codex exited code=${exit.code} signal=${exit.signal} in ${elapsed}s`);
  if (exit.code !== 0) throw new Error(`codex exec failed (code ${exit.code})`);

  // recover output.png (fallback: newest .png)
  let picked = path.join(workDir, "output.png");
  try {
    await stat(picked);
  } catch {
    const entries = await readdir(workDir);
    const pngs = entries.filter((e) => e.toLowerCase().endsWith(".png"));
    if (!pngs.length) throw new Error(`no PNG in ${workDir}`);
    const stats = await Promise.all(
      pngs.map(async (e) => ({
        name: e,
        mtime: (await stat(path.join(workDir, e))).mtimeMs,
      })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    picked = path.join(workDir, stats[0].name);
  }
  log("picked codex output:", picked);

  // keep a copy of the raw codex output for inspection
  const rawCopy = path.join(ROOT, "icon-source-foreground.raw.png");
  await copyFile(picked, rawCopy);
  const rawMeta = await sharp(picked).metadata();
  log(`raw output: ${rawMeta.width}x${rawMeta.height}, channels=${rawMeta.channels}`);

  // 1) chroma-key green → transparent
  const keyed = await chromaKeyGreen(picked);

  // 2) trim to alpha bbox → contain-resize content to ~80% → center on transparent canvas
  const trimmed = sharp(keyed).trim();
  const trimMeta = await trimmed.metadata();
  log(`trimmed content bbox: ${trimMeta.width}x${trimMeta.height}`);

  const target = Math.round(CANVAS * CONTENT_FRACTION);
  const contentBuf = await sharp(keyed)
    .trim()
    .resize(target, target, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  // extend the (target x target) content onto a CANVAS x CANVAS transparent canvas, centered
  const pad = Math.round((CANVAS - target) / 2);
  await sharp(contentBuf)
    .extend({
      top: pad,
      bottom: CANVAS - target - pad,
      left: pad,
      right: CANVAS - target - pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(FINAL);

  const finalMeta = await sharp(FINAL).metadata();
  log(`FINAL: ${FINAL}`);
  log(
    `  ${finalMeta.width}x${finalMeta.height}, channels=${finalMeta.channels}, hasAlpha=${finalMeta.hasAlpha}`,
  );
  log("done.");
}

main().catch((e) => {
  console.error("[icon] FAILED:", e);
  process.exit(1);
});
