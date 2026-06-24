#!/usr/bin/env node
// M0 게이트: `codex exec` 가 imagegen 스킬을 non-interactive 로 자동 발동하는지 검증
//
// 사용법:
//   node scripts/probe-codex-imagegen.mjs [--mode=simple|sprite] [--timeout=180]
//
// 산출물:
//   - /tmp/codex-probe-XXXXX/ 작업 디렉토리에 PNG 생성 여부
//   - stdout/stderr 전문, 소요 시간, 종료 코드
//   - 최종 verdict: SCENARIO A 성립 / 실패

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1] || 'simple';
const timeoutSec = Number(args.find(a => a.startsWith('--timeout='))?.split('=')[1] || 180);
const timeoutMs = timeoutSec * 1000;

const prompts = {
  simple:
    'Use the imagegen skill to generate an image of a single red apple on a white background, simple illustration. ' +
    'Save the result as a PNG file at the path ./output.png in your current working directory. ' +
    'Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.',
  sprite:
    'Use the imagegen skill to generate a single 1024x1024 PNG containing a 4x4 grid sprite sheet ' +
    'of the same pixel art knight character in 16 different poses, transparent background, uniform cell size. ' +
    'Save the result as a PNG file at the path ./output.png in your current working directory. ' +
    'Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.',
};

const naturalPrompt = prompts[mode];
if (!naturalPrompt) {
  console.error(`Unknown mode: ${mode}. Available: ${Object.keys(prompts).join(', ')}`);
  process.exit(2);
}

// ─── setup ───────────────────────────────────────────────────────────────────
const probeDir = await mkdtemp(path.join(tmpdir(), 'codex-probe-'));
const log = (...a) => console.log('[probe]', ...a);

log('working dir:', probeDir);
log('mode:', mode);
log('timeout:', `${timeoutSec}s`);
log('prompt:', JSON.stringify(naturalPrompt));
log('cmd: codex exec --cd <probeDir> --sandbox workspace-write --skip-git-repo-check - < "<prompt stdin>"');
log('──── starting ────');

const start = performance.now();

const child = spawn(
  'codex',
  [
    'exec',
    '--cd', probeDir,
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
    '-',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
child.stdin.end(naturalPrompt);

// ─── stream stdio (also buffer) ──────────────────────────────────────────────
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

// ─── timeout ─────────────────────────────────────────────────────────────────
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[probe] TIMEOUT after ${timeoutSec}s, sending SIGTERM`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5000).unref();
}, timeoutMs);

const exitInfo = await new Promise(resolve => {
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
log('──── finished ────');
log(`elapsed: ${elapsed}s`);
log(`exit code: ${exitInfo.code}, signal: ${exitInfo.signal}, timedOut: ${timedOut}`);

// ─── scan workdir ────────────────────────────────────────────────────────────
const files = [];
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full);
    } else if (e.isFile()) {
      const st = await stat(full);
      files.push({
        path: path.relative(probeDir, full),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
}
await walk(probeDir);

log(`files in workdir (${files.length}):`);
for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
  log(`  ${f.path}  ${(f.size / 1024).toFixed(1)}KB`);
}

const pngs = files.filter(f => f.path.toLowerCase().endsWith('.png'));

// ─── save logs ───────────────────────────────────────────────────────────────
await writeFile(path.join(probeDir, '_probe_stdout.log'), stdoutBuf);
await writeFile(path.join(probeDir, '_probe_stderr.log'), stderrBuf);
await writeFile(
  path.join(probeDir, '_probe_summary.json'),
  JSON.stringify(
    {
      mode,
      prompt: naturalPrompt,
      probeDir,
      elapsedSec: Number(elapsed),
      exitCode: exitInfo.code,
      signal: exitInfo.signal,
      timedOut,
      filesCount: files.length,
      pngs: pngs.map(p => ({ path: p.path, sizeKB: Math.round(p.size / 1024) })),
    },
    null,
    2,
  ),
);

// ─── verdict ─────────────────────────────────────────────────────────────────
log('');
if (pngs.length === 1 && pngs[0].path === 'output.png') {
  log('VERDICT: ✅ SCENARIO A — `codex exec` auto-fired imagegen, produced ./output.png');
} else if (pngs.length >= 1) {
  log(`VERDICT: ⚠️ PARTIAL — PNG(s) produced but at unexpected path(s): ${pngs.map(p => p.path).join(', ')}`);
} else if (exitInfo.code !== 0) {
  log(`VERDICT: ❌ SCENARIO A FAILED — exit ${exitInfo.code}, no PNG`);
} else {
  log('VERDICT: ❌ SCENARIO A FAILED — exited 0 but no PNG was produced');
}
log(`keep workdir for inspection: ${probeDir}`);
log(`  - _probe_summary.json`);
log(`  - _probe_stdout.log`);
log(`  - _probe_stderr.log`);

process.exit(pngs.length > 0 ? 0 : 1);
