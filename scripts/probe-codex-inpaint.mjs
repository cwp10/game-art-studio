#!/usr/bin/env node
// 게이트 검증: `codex exec -i 원본 -i 마스크 -- "마스크의 빨간 영역만 다시 그려"` 가
// imagegen 스킬에서 의도대로 동작하는가?
//
// 이 능력이 inpaint_image 도구(마스크 캔버스 UI)의 전제. M0(text→img), M4(img2img) 까지
// 검증됐지만 "2장 첨부 + 그중 하나가 마스크 의미" 는 미검증.
//
// 사용법:
//   node scripts/probe-codex-inpaint.mjs [--input=<png>] [--timeout=240]
//
// 마스크 생성: 원본 중앙에 작은 빨간 사각형(원본 width/height 의 ~25%) 을 sharp 로 합성.
// 그 영역을 "노란 별 모양" 같은 분명한 객체로 바꾸도록 지시. 결과 PNG 가:
//  - 빨간 영역 위치 ≈ 새 객체가 있는 위치 → 마스크 인식 ✅
//  - 빨간색이 결과에 그대로 남음 → 마스크를 그림으로 오해 ❌
//  - 영역 무시하고 전역 변경 → 마스크 무시 ❌

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const args = process.argv.slice(2);
const timeoutSec = Number(args.find(a => a.startsWith("--timeout="))?.split("=")[1] || 240);
const explicitInput = args.find(a => a.startsWith("--input="))?.split("=")[1];

async function pickInputImage() {
  if (explicitInput) return path.resolve(explicitInput);
  const imagesDir = path.resolve("data/images");
  const entries = await readdir(imagesDir).catch(() => []);
  const pngs = entries.filter(e => e.toLowerCase().endsWith(".png"));
  if (!pngs.length) throw new Error(`no PNG in ${imagesDir} and --input not given`);
  const stats = await Promise.all(
    pngs.map(async n => ({ name: n, mtime: (await stat(path.join(imagesDir, n))).mtimeMs })),
  );
  // 가장 큰 PNG 우선 (작은 리사이즈 결과 회피)
  stats.sort((a, b) => b.mtime - a.mtime);
  for (const s of stats) {
    const meta = await sharp(path.join(imagesDir, s.name)).metadata();
    if ((meta.width ?? 0) >= 512) return path.join(imagesDir, s.name);
  }
  return path.join(imagesDir, stats[0].name);
}

const log = (...a) => console.log("[probe]", ...a);

const inputAbs = await pickInputImage();
const inputMeta = await sharp(inputAbs).metadata();
const inputW = inputMeta.width ?? 1024;
const inputH = inputMeta.height ?? 1024;

const probeDir = await mkdtemp(path.join(tmpdir(), "codex-inpaint-probe-"));
const inputCopy = path.join(probeDir, "input.png");
const maskPath = path.join(probeDir, "mask.png");
await copyFile(inputAbs, inputCopy);

// 마스크: 검은 배경 + 중앙에 빨간 사각형 (가로/세로 25%)
const maskW = inputW;
const maskH = inputH;
const rectW = Math.round(maskW * 0.25);
const rectH = Math.round(maskH * 0.25);
const rectX = Math.round((maskW - rectW) / 2);
const rectY = Math.round((maskH - rectH) / 2);
const redRect = await sharp({
  create: {
    width: rectW,
    height: rectH,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
}).png().toBuffer();
await sharp({
  create: { width: maskW, height: maskH, channels: 3, background: { r: 0, g: 0, b: 0 } },
})
  .composite([{ input: redRect, left: rectX, top: rectY }])
  .png()
  .toFile(maskPath);

log("working dir:", probeDir);
log("input    :", inputAbs, `${inputW}×${inputH}`);
log("mask     :", maskPath, `${maskW}×${maskH}, red rect at (${rectX},${rectY}) size ${rectW}×${rectH}`);
log("timeout  :", `${timeoutSec}s`);

const naturalPrompt =
  "Use the imagegen skill. " +
  "I am attaching TWO images: " +
  "(1) the original image, and " +
  "(2) a mask where the RED rectangle marks the area to be replaced. " +
  "Replace ONLY the red region with a clearly visible yellow five-pointed star, " +
  "preserving everything outside the red region exactly as in the original. " +
  "Do not include the red color or the mask itself in the output. " +
  "Save the result as a PNG file at the path ./output.png in your current working directory. " +
  "Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.";

const startedAt = performance.now();
const child = spawn(
  "codex",
  [
    "exec",
    "--cd",
    probeDir,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-i",
    inputCopy,
    "-i",
    maskPath,
    "--",
    "-",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
child.stdin.end(naturalPrompt);

let stdoutBuf = "";
let stderrBuf = "";
child.stdout.on("data", c => {
  const t = c.toString();
  stdoutBuf += t;
  process.stdout.write(t);
});
child.stderr.on("data", c => {
  const t = c.toString();
  stderrBuf += t;
  process.stderr.write(t);
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[probe] TIMEOUT after ${timeoutSec}s, sending SIGTERM`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}, timeoutSec * 1000);

const exitInfo = await new Promise(resolve =>
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  }),
);

const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
log("──── finished ────");
log(`elapsed: ${elapsed}s, exit ${exitInfo.code}, signal ${exitInfo.signal}, timedOut: ${timedOut}`);

const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.isFile()) {
      const st = await stat(full);
      files.push({ path: path.relative(probeDir, full), size: st.size });
    }
  }
}
await walk(probeDir);
log(`files (${files.length}):`);
for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
  log(`  ${f.path}  ${(f.size / 1024).toFixed(1)}KB`);
}

// 분석
async function sha256(p) {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}
const outputAbs = path.join(probeDir, "output.png");
const outputExists = files.some(f => f.path === "output.png");
let analysis = { outputExists, sameAsInput: null, redOnlyInRect: null, rectChanged: null };

if (outputExists) {
  const [inH, outH] = await Promise.all([sha256(inputCopy), sha256(outputAbs)]);
  analysis.sameAsInput = inH === outH;
  log(`input  sha256: ${inH}`);
  log(`output sha256: ${outH}`);

  // 결과 PNG 의 픽셀을 raw 로 읽어 두 지표 계산
  const out = await sharp(outputAbs).resize(maskW, maskH, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const inRaw = await sharp(inputCopy).resize(maskW, maskH, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const channels = out.info.channels;

  // 지표 1: 결과에 빨간 픽셀이 (사각형 영역 밖에) 남았는가 → 마스크를 그림으로 오해 신호
  let redInside = 0, redOutside = 0;
  // 지표 2: 사각형 안의 픽셀이 원본과 얼마나 달라졌는가
  let rectDiffSum = 0, rectPxCount = 0, outsideDiffSum = 0, outsidePxCount = 0;
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      const idx = (y * maskW + x) * channels;
      const r = out.data[idx], g = out.data[idx + 1], b = out.data[idx + 2];
      const isRed = r > 180 && g < 80 && b < 80;
      const inside = x >= rectX && x < rectX + rectW && y >= rectY && y < rectY + rectH;
      if (isRed) {
        if (inside) redInside++;
        else redOutside++;
      }
      const ir = inRaw.data[idx], ig = inRaw.data[idx + 1], ib = inRaw.data[idx + 2];
      const diff = Math.abs(r - ir) + Math.abs(g - ig) + Math.abs(b - ib);
      if (inside) { rectDiffSum += diff; rectPxCount++; }
      else { outsideDiffSum += diff; outsidePxCount++; }
    }
  }
  const rectMeanDiff = rectDiffSum / Math.max(1, rectPxCount);
  const outsideMeanDiff = outsideDiffSum / Math.max(1, outsidePxCount);
  analysis.redOnlyInRect = { redInsideRect: redInside, redOutsideRect: redOutside };
  analysis.rectChanged = { rectMeanDiff: Math.round(rectMeanDiff), outsideMeanDiff: Math.round(outsideMeanDiff) };
  log(`red pixels: inside_rect=${redInside}, outside_rect=${redOutside}  (낮을수록 마스크가 결과로 새지 않음)`);
  log(`mean diff vs input: inside_rect=${Math.round(rectMeanDiff)}, outside=${Math.round(outsideMeanDiff)}  (inside 가 outside 보다 훨씬 커야 마스크 의도대로)`);
}

await writeFile(path.join(probeDir, "_probe_stdout.log"), stdoutBuf);
await writeFile(path.join(probeDir, "_probe_stderr.log"), stderrBuf);
await writeFile(
  path.join(probeDir, "_probe_summary.json"),
  JSON.stringify({ input: inputAbs, probeDir, elapsedSec: Number(elapsed), exitCode: exitInfo.code, signal: exitInfo.signal, timedOut, analysis, files }, null, 2),
);

// Verdict
log("");
let verdict = "❌ UNKNOWN";
if (!outputExists) {
  verdict = `❌ FAILED — no output.png (exit ${exitInfo.code})`;
} else if (analysis.sameAsInput) {
  verdict = "⚠️ NO-OP — output 이 input 과 byte-identical (codex 가 아무것도 안 함)";
} else {
  const { redOutsideRect } = analysis.redOnlyInRect;
  const { rectMeanDiff, outsideMeanDiff } = analysis.rectChanged;
  const maskBled = redOutsideRect > 100; // 마스크 색이 결과에 그대로 남음
  const followedMask = rectMeanDiff > outsideMeanDiff * 3 && rectMeanDiff > 30;
  if (maskBled) {
    verdict = `⚠️ MASK BLED — 빨간 픽셀 ${redOutsideRect}개가 사각형 밖에 남음 (codex 가 마스크를 그림으로 오해 가능)`;
  } else if (followedMask) {
    verdict = `✅ WORKS — rect_diff=${rectMeanDiff} ≫ outside_diff=${outsideMeanDiff}, 마스크 영역만 변경됨`;
  } else if (rectMeanDiff < 30) {
    verdict = `⚠️ WEAK — 사각형 안도 거의 안 변함 (rect_diff=${rectMeanDiff})`;
  } else {
    verdict = `⚠️ PARTIAL — rect_diff=${rectMeanDiff}, outside_diff=${outsideMeanDiff}. 마스크 영향이 약함`;
  }
}
log("VERDICT: " + verdict);
log(`keep workdir for inspection: ${probeDir}`);

process.exit(verdict.startsWith("✅") ? 0 : 1);
