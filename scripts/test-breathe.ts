/**
 * breathe + anatomy 이식 테스트 — 정본과의 **픽셀 동일성**이 판정 기준이다.
 *
 * 이 모듈은 AI 개입 0 의 결정론 변형이라 "그럴듯한 결과" 로 통과시킬 여지가 없다:
 * 같은 입력이면 정본과 바이트가 같아야 한다. 워프(행 복제/삭제 + 밀도 적분 가로
 * 사상)와 외곽선 1px 다듬기(고정점 반복)가 한 군데라도 어긋나면 위상마다 다른
 * 아티팩트가 남는다.
 *
 * 사용법: pnpm tsx scripts/test-breathe.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/lib/sprite/anatomy";
import {
  bakeBreatheSequence,
  fitBreathePattern,
  fittedBreathCount,
  recommendedBreatheFrames,
  breatheReadsSmoothly,
  phaseFrame,
  envelope as envelopeFn,
  warp,
  wave as waveFn,
  smoothstep as smoothstepFn,
  DEFAULT_DEPTH,
  DEFAULT_LAG,
  type BreatheConfig,
} from "../src/lib/sprite/breathe";

/** 정본 `state_breathe` 가 낸 것과 같은 모양의 기본 설정. */
const cfg = (over: Partial<BreatheConfig> = {}): BreatheConfig => ({
  depth: DEFAULT_DEPTH,
  depth_x: null,
  breaths: 1,
  lag: DEFAULT_LAG,
  rigid_row: null,
  axis_x: null,
  torso_half: null,
  anatomy: null,
  ...over,
});

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const dir = mkdtempSync(join(tmpdir(), "breathe-"));
const srcs = [
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png",
  "data/sprite-runs/sprite-1786910676578/frames-down45_idle/frame-0.png",
  "data/sprite-runs/sprite-1786868942478/frames-down_idle/frame-1.png",
].filter(existsSync);

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

if (!existsSync(PY)) {
  console.log("  FAIL 파이썬 venv 없음 — 픽셀 대조를 못 했습니다");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}
if (srcs.length === 0) {
  console.log("  FAIL 실제 idle 프레임 없음");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

void (async () => {
console.log("=== 단위: 파형·봉투 ===");
{
  check("wave(0) = 0", Math.abs(waveFn(0)) < 1e-12);
  check("wave(0.5) ≈ 0", Math.abs(waveFn(0.5)) < 1e-12);
  check("wave 는 주기 1", Math.abs(waveFn(0.3) - waveFn(1.3)) < 1e-12);
  check("smoothstep 클램프", smoothstepFn(0, 1, -1) === 0 && smoothstepFn(0, 1, 2) === 1);
  check("smoothstep 중점", Math.abs(smoothstepFn(0, 1, 0.5) - 0.5) < 1e-12);
  // b <= a 는 계단이다: 원본이 `1.0 if x >= b else 0.0` 이라 x 가 b 이상이면 1 이다
  // (0 이 아니다 — 폭 0 구간을 "이미 지났다" 로 읽는다).
  check("퇴화 구간은 계단", smoothstepFn(1, 0, 0.5) === 1 && smoothstepFn(1, 0, -1) === 0);
}

console.log("\n=== 정본 대조: 워프 픽셀 동일 ===");
for (const src of srcs) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame = { data: new Uint8Array(data), width: info.width, height: info.height };
  const anat = analyze(frame);
  for (const t of [0, 0.125, 0.25, 0.5, 0.75]) {
    let ours: Uint8Array | null = null, ourErr = "";
    try { ours = warp(frame, anat, DEFAULT_DEPTH, DEFAULT_LAG, t).data; }
    catch (e) { ourErr = (e as Error).message; }
    const outBin = join(dir, `ref-${t}.bin`);
    const out = execFileSync(PY, ["-c", `
import sys, numpy as np
sys.path.insert(0, "/Users/wonpyoung/Developer/workspace/sprite-gen")
from PIL import Image
from sprite_gen.anatomy import analyze
from sprite_gen.breathe import _warp, DEFAULT_DEPTH, DEFAULT_LAG
im = Image.open(${JSON.stringify(join(process.cwd(), src))}).convert("RGBA")
try:
    w = _warp(im, analyze(im), DEFAULT_DEPTH, DEFAULT_LAG, ${t})
    np.array(w).tofile(${JSON.stringify(outBin)})
    print("ok")
except SystemExit as e:
    print("err:" + str(e))
`], { encoding: "utf8", cwd: "/Users/wonpyoung/Developer/workspace/sprite-gen" }).trim();
    if (out.startsWith("err:")) {
      check(`t=${t} 정본이 멈추면 우리도 멈춘다`, ourErr !== "", out.slice(0, 80));
      continue;
    }
    if (ourErr) { check(`t=${t} 우리만 에러`, false, ourErr.slice(0, 80)); continue; }
    const ref = new Uint8Array(readFileSync(outBin));
    let diff = 0;
    for (let i = 0; i < ref.length; i++) if (ref[i] !== (ours as Uint8Array)[i]) diff++;
    check(`${src.split("/").slice(-2).join("/")} t=${t}`, diff === 0, `${diff}B 차이 / ${ref.length}`);
  }
}
console.log("\n=== 강체 구간은 비트 동일 (불변식 1) ===");
{
  // 정본이 핵심 계약으로 못박은 것: env=0 인 행은 g=0 이라 가로 사상이 원본 좌표
  // 그대로이고 sy=1 이라 행 복제/삭제가 없다. 눈·입이 몇 도트뿐인 픽셀아트에서
  // 3% 세로 신장도 표정을 뭉개므로 근사가 아니라 **동일**이어야 한다.
  //
  // 비교는 **콘텐츠 상단 기준**이다. 머리는 강체여도 아래 몸통이 늘면 통째로
  // 위아래로 이동한다 — 그게 호흡이다. 캔버스 절대 좌표로 재면 당연히 다르다.
  const { data, info } = await sharp(srcs[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const base = { data: new Uint8Array(data), width: info.width, height: info.height };
  const anat = analyze(base);
  // 정지 1컷 + 링크 복제 레시피 — 같은 프레임 6장에 호흡을 굽는다.
  const cyc = bakeBreatheSequence(Array.from({ length: 6 }, () => base), cfg()).frames;

  const topOf = (f: { data: Uint8Array; width: number; height: number }): number => {
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++)
        if (f.data[(y * f.width + x) * 4 + 3] >= 128) return y;
    return -1;
  };
  const tops = cyc.map(topOf);
  check("모든 위상에 콘텐츠가 있다", tops.every(t => t >= 0), JSON.stringify(tops));

  // 강체 = **env(u) === 0 인 행**이다. rigid_row 바로 위는 테이퍼 구간이라 부분
  // 변형되므로 rigid_row 를 그대로 경계로 쓰면 안 된다 — 봉투에 직접 묻는다.
  const { env } = envelopeFn(anat);
  const rigidRows: number[] = [];
  for (let j = 0; j < anat.height; j++) {
    if (env(1.0 - j / Math.max(1, anat.height - 1)) === 0) rigidRows.push(j);
    else break; // 정수리부터 연속인 구간만
  }
  let diff = 0;
  let compared = 0;
  for (let i = 1; i < cyc.length; i++) {
    for (const j of rigidRows) {
      const y0 = tops[0] + j;
      const yi = tops[i] + j;
      if (y0 >= base.height || yi >= base.height) continue;
      for (let x = 0; x < base.width; x++) {
        const o0 = (y0 * base.width + x) * 4;
        const oi = (yi * base.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          compared++;
          if (cyc[0].data[o0 + c] !== cyc[i].data[oi + c]) diff++;
        }
      }
    }
  }
  check(
    `강체 구간(정수리부터 ${rigidRows.length}행, rigid_row=${anat.rigid_row})이 위상 간 비트 동일`,
    diff === 0,
    `${diff}B 차이 / ${compared}B 비교`,
  );
  check("비교가 실제로 이뤄졌다", compared > 0, `${compared}B`);

  // 반대 방향 확인 — 변형 구간은 실제로 달라져야 한다(검사가 무의미하지 않다는 증거).
  let bodyDiff = 0;
  for (let j = rigidRows.length; j < anat.height; j++) {
    const y0 = tops[0] + j;
    const y3 = tops[3] + j;
    if (y0 >= base.height || y3 >= base.height) continue;
    for (let x = 0; x < base.width; x++) {
      const o0 = (y0 * base.width + x) * 4;
      const o3 = (y3 * base.width + x) * 4;
      for (let c = 0; c < 4; c++) if (cyc[0].data[o0 + c] !== cyc[3].data[o3 + c]) bodyDiff++;
    }
  }
  check("변형 구간은 위상마다 달라진다", bodyDiff > 0, `${bodyDiff}B`);
}

console.log("\n=== 루프 길이 불변 (불변식 5) ===");
{
  const { data, info } = await sharp(srcs[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const f = { data: new Uint8Array(data), width: info.width, height: info.height };
  for (const n of [4, 6, 8]) {
    const seq = Array.from({ length: n }, () => f);
    check(`${n}프레임 입력 → ${n}프레임 출력`, bakeBreatheSequence(seq, cfg()).frames.length === n);
  }
  const cyc = bakeBreatheSequence(Array.from({ length: 6 }, () => f), cfg()).frames;
  check(
    "캔버스 크기가 변하지 않는다",
    cyc.every(c => c.width === info.width && c.height === info.height),
  );
}

console.log("\n=== 정본 대조: 위상 시퀀스 (fit_breathe_pattern) ===");
{
  const combos: Array<[number, number]> = [
    [6, 1], [6, 2], [6, 3], [18, 3], [12, 5], [8, 3], [4, 2], [1, 1], [0, 1], [7, 8],
  ];
  const refs = JSON.parse(
    execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, "/Users/wonpyoung/Developer/workspace/sprite-gen")
from sprite_gen.breathe import fit_breathe_pattern, fitted_breath_count, recommended_breathe_frames, breathe_reads_smoothly
combos = ${JSON.stringify(combos)}
print(json.dumps([{
    "pattern": fit_breathe_pattern(n, {"breaths": b}),
    "count": fitted_breath_count(n, {"breaths": b}),
    "recommended": recommended_breathe_frames({"breaths": b}),
    "smooth": breathe_reads_smoothly(n, {"breaths": b}),
} for n, b in combos]))
`], { encoding: "utf8" }),
  ) as Array<{ pattern: number[]; count: number; recommended: number; smooth: boolean }>;

  combos.forEach(([n, b], i) => {
    const c = cfg({ breaths: b });
    const ours = fitBreathePattern(n, c);
    const ref = refs[i];
    // 비트 동일이어야 한다 — 근사가 아니다. 아틀라스 칸 재사용이 이 동일성 위에 선다.
    const same = ours.length === ref.pattern.length && ours.every((v, k) => v === ref.pattern[k]);
    check(`seq=${n} breaths=${b} 위상 배열 비트 동일`, same, `${JSON.stringify(ours)} vs ${JSON.stringify(ref.pattern)}`);
    check(`seq=${n} breaths=${b} 부수 관측 3종 일치`,
      fittedBreathCount(n, c) === ref.count &&
      recommendedBreatheFrames(c) === ref.recommended &&
      breatheReadsSmoothly(n, c) === ref.smooth);
  });

  // 정본이 주석에 남긴 실측: 나머지를 나중에 취하면 유니크 6 → 14 로 늘어난다.
  const uniq = new Set(fitBreathePattern(18, cfg({ breaths: 3 }))).size;
  check("18슬롯 3호흡 유니크 위상 = 6 (칸 재사용이 성립한다)", uniq === 6, String(uniq));
  const naive = new Set(Array.from({ length: 18 }, (_, i) => ((i * 3) / 18) % 1.0)).size;
  check("나머지를 나중에 취하면 깨진다 (대조군)", naive > 6, String(naive));
}

console.log("\n=== 정본 대조: 시퀀스 굽기 (bake_breathe_sequence) ===");
for (const src of srcs.slice(0, 2)) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const f = { data: new Uint8Array(data), width: info.width, height: info.height };
  for (const [n, b] of [[6, 1], [6, 2], [4, 1]] as Array<[number, number]>) {
    const ours = bakeBreatheSequence(Array.from({ length: n }, () => f), cfg({ breaths: b }));
    const outBin = join(dir, `bake-${n}-${b}.bin`);
    const refPhases = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, "/Users/wonpyoung/Developer/workspace/sprite-gen")
from PIL import Image
from sprite_gen.breathe import bake_breathe_sequence
im = Image.open(${JSON.stringify(join(process.cwd(), src))}).convert("RGBA")
frames, phases = bake_breathe_sequence([im] * ${n}, {"breaths": ${b}})
np.concatenate([np.array(x).ravel() for x in frames]).tofile(${JSON.stringify(outBin)})
print(json.dumps(phases))
`], { encoding: "utf8" })) as number[];
    const ref = new Uint8Array(readFileSync(outBin));
    const mine = new Uint8Array(ours.frames.length * f.data.length);
    ours.frames.forEach((fr, i) => mine.set(fr.data, i * f.data.length));
    const bytesSame = ref.length === mine.length && ref.every((v, i) => v === mine[i]);
    check(`${src.split("/").pop()} seq=${n} breaths=${b} 굽기 픽셀 동일`, bytesSame,
      `${mine.length}B vs ${ref.length}B`);
    check(`${src.split("/").pop()} seq=${n} breaths=${b} 위상 동일`,
      ours.phases.length === refPhases.length && ours.phases.every((v, i) => v === refPhases[i]));
  }
}

console.log("\n=== 위상별 strain 검사는 축마다 따로다 ===");
{
  const { data, info } = await sharp(srcs[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const f = { data: new Uint8Array(data), width: info.width, height: info.height };
  // depth 는 통과하지만 depth_x 가 상한을 넘으면 depth_x 이름으로 멈춰야 한다.
  let msg = "";
  try { phaseFrame(f, cfg({ depth_x: 5.0 }), 0.25); } catch (e) { msg = (e as Error).message; }
  check("depth_x 초과는 depth_x 이름으로 거부", msg.includes("depth_x") && msg.includes("조용히 깎지 않는다"), msg);
  let ok = true;
  try { phaseFrame(f, cfg({ depth_x: 0 }), 0.25); } catch { ok = false; }
  check("depth_x = 0 은 유효하다 (가로만 끄기)", ok);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
