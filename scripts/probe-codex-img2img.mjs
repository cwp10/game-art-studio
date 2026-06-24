#!/usr/bin/env node
// M4 게이트: `codex exec -i <png>` 가 imagegen 스킬을 image→image 모드로 발동하는지 검증.
//
// M0 probe 의 자매격. M0 가 text→image 를 확인했다면 여기는:
//  - 첨부 PNG 를 입력으로 받아
//  - imagegen 스킬이 변형/편집을 수행하고
//  - output.png 를 새로 만드는지
// 를 검증한다. edit_image / upscale_image / remove_background / inpaint_image 도구가
// 모두 이 능력에 의존하므로 도구 구현 전 반드시 통과해야 한다.
//
// 사용법:
//   node scripts/probe-codex-img2img.mjs [--input=<png path>] [--mode=edit|upscale|remove_bg|inpaint] [--timeout=180]
//
// 기본 input 은 data/images/ 의 가장 최근 PNG (직전 생성 결과 자동 활용).
//
// 산출물:
//   - /tmp/codex-img2img-probe-XXXXX/ 작업 디렉토리에 변형 PNG 생성 여부
//   - stdout/stderr 전문, 소요 시간, 종료 코드, 결과 PNG 의 size
//   - 입력과 결과 PNG 의 SHA-256 비교 (변형이 실제로 일어났는지 1차 확인)

import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1] || 'edit';
const timeoutSec = Number(args.find(a => a.startsWith('--timeout='))?.split('=')[1] || 180);
const explicitInput = args.find(a => a.startsWith('--input='))?.split('=')[1];

// 입력 이미지: 인자로 받거나 data/images/ 의 가장 최근 PNG
async function pickInputImage() {
  if (explicitInput) return path.resolve(explicitInput);
  const imagesDir = path.resolve('data/images');
  const entries = await readdir(imagesDir).catch(() => []);
  const pngs = entries.filter(e => e.toLowerCase().endsWith('.png'));
  if (!pngs.length) throw new Error(`no PNG in ${imagesDir} and --input not given`);
  const stats = await Promise.all(
    pngs.map(async name => ({ name, mtime: (await stat(path.join(imagesDir, name))).mtimeMs })),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return path.join(imagesDir, stats[0].name);
}

const PROMPT_HEADER =
  'Use the imagegen skill. ' +
  'Save the result as a PNG file at the path ./output.png in your current working directory. ' +
  'Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.\n\n';

const prompts = {
  edit:
    PROMPT_HEADER +
    'Use the attached image as a reference. Generate a new image that is the same subject ' +
    'but with a small visible change: add a single green leaf on top. Keep the rest identical.',
  upscale:
    PROMPT_HEADER +
    'Use the attached image as a reference. Upscale it to higher resolution (~2x) while ' +
    'preserving all detail. Output the upscaled PNG only.',
  remove_bg:
    PROMPT_HEADER +
    'Use the attached image as a reference. Regenerate the same subject on a flat solid ' +
    '#00ff00 chroma-key background (no shadows, no gradients, crisp edges).',
  inpaint:
    PROMPT_HEADER +
    'Use the attached image as a reference. Edit it by replacing the central object with ' +
    'a yellow banana of similar size and position. Preserve everything else.',
};

const naturalPrompt = prompts[mode];
if (!naturalPrompt) {
  console.error(`Unknown mode: ${mode}. Available: ${Object.keys(prompts).join(', ')}`);
  process.exit(2);
}

// ─── setup ───────────────────────────────────────────────────────────────────
const inputAbs = await pickInputImage();
const inputStat = await stat(inputAbs);
const probeDir = await mkdtemp(path.join(tmpdir(), 'codex-img2img-probe-'));
const inputCopy = path.join(probeDir, 'input.png');
await copyFile(inputAbs, inputCopy);

const log = (...a) => console.log('[probe]', ...a);

log('working dir:', probeDir);
log('input    :', inputAbs, `(${(inputStat.size / 1024).toFixed(1)}KB)`);
log('mode     :', mode);
log('timeout  :', `${timeoutSec}s`);
log('cmd      : codex exec --cd <probeDir> --sandbox workspace-write --skip-git-repo-check -i input.png -- - < "<prompt stdin>"');
log('──── starting ────');

const start = performance.now();

// `-i, --image <FILE>...` 가 multi-value 옵션이라 `--` 로 옵션 종료를 명시하고,
// 프롬프트는 stdin 으로 전달한다.
const child = spawn(
  'codex',
  [
    'exec',
    '--cd', probeDir,
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
    '-i', inputCopy,
    '--',
    '-',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
child.stdin.end(naturalPrompt);

let stdoutBuf = '';
let stderrBuf = '';
child.stdout.on('data', chunk => {
  const text = chunk.toString();
  stdoutBuf += text;
  process.stdout.write(text);
});
child.stderr.on('data', chunk => {
  const text = chunk.toString();
  stderrBuf += text;
  process.stderr.write(text);
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[probe] TIMEOUT after ${timeoutSec}s, sending SIGTERM`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5000).unref();
}, timeoutSec * 1000);

const exitInfo = await new Promise(resolve => {
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
log('──── finished ────');
log(`elapsed: ${elapsed}s, exit ${exitInfo.code}, signal ${exitInfo.signal}, timedOut: ${timedOut}`);

// ─── scan workdir ────────────────────────────────────────────────────────────
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.isFile()) {
      const st = await stat(full);
      files.push({ path: path.relative(probeDir, full), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}
await walk(probeDir);
log(`files (${files.length}):`);
for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
  log(`  ${f.path}  ${(f.size / 1024).toFixed(1)}KB`);
}

// output.png 가 input.png 와 다른지 SHA-256 비교
async function sha256(p) {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}
const outputAbs = path.join(probeDir, 'output.png');
const outputExists = files.some(f => f.path === 'output.png');
let sameAsInput = null;
if (outputExists) {
  const [inHash, outHash] = await Promise.all([sha256(inputCopy), sha256(outputAbs)]);
  sameAsInput = inHash === outHash;
  log(`input  sha256: ${inHash}`);
  log(`output sha256: ${outHash}`);
}

await writeFile(path.join(probeDir, '_probe_stdout.log'), stdoutBuf);
await writeFile(path.join(probeDir, '_probe_stderr.log'), stderrBuf);
await writeFile(
  path.join(probeDir, '_probe_summary.json'),
  JSON.stringify(
    {
      mode,
      input: inputAbs,
      probeDir,
      elapsedSec: Number(elapsed),
      exitCode: exitInfo.code,
      signal: exitInfo.signal,
      timedOut,
      outputProduced: outputExists,
      outputSameAsInput: sameAsInput,
      files: files.map(f => ({ path: f.path, sizeKB: Math.round(f.size / 1024) })),
    },
    null,
    2,
  ),
);

// ─── verdict ─────────────────────────────────────────────────────────────────
log('');
if (outputExists && sameAsInput === false) {
  log('VERDICT: ✅ image→image WORKS — codex produced a different output.png');
} else if (outputExists && sameAsInput === true) {
  log('VERDICT: ⚠️ output.png is BYTE-IDENTICAL to input — codex likely copied without editing');
} else if (exitInfo.code !== 0) {
  log(`VERDICT: ❌ FAILED — exit ${exitInfo.code}, no output.png`);
} else {
  log('VERDICT: ❌ FAILED — exited 0 but no output.png');
}
log(`keep workdir for inspection: ${probeDir}`);

process.exit(outputExists && sameAsInput === false ? 0 : 1);
