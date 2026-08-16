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
  breatheCycle,
  envelope as envelopeFn,
  warp,
  wave as waveFn,
  smoothstep as smoothstepFn,
  DEFAULT_DEPTH,
  DEFAULT_LAG,
} from "../src/lib/sprite/breathe";

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
  const cyc = breatheCycle(base, { frames: 6, breaths: 1 });

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
    check(`${n}프레임 요청 → ${n}프레임 출력`, breatheCycle(f, { frames: n }).length === n);
  }
  const cyc = breatheCycle(f, { frames: 6 });
  check(
    "캔버스 크기가 변하지 않는다",
    cyc.every(c => c.width === info.width && c.height === info.height),
  );
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
