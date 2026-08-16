/**
 * inspect 신호 이식 테스트 — 정본과의 **수치 동일성**이 판정 기준이다.
 *
 * 이 신호들은 score 가 그대로 임계와 비교해 교정 힌트를 만드는 입력이라, 근사로는
 * 정본과 다른 판정이 나온다. 특히 dHash 는 축소본의 인접 픽셀 대소 비교여서 1 LSB
 * 차이로 비트가 뒤집힌다 — 그래서 리샘플러까지 바이트 단위로 맞춘다.
 *
 * 파이썬 venv 가 없으면 대조를 건너뛰지 않고 **실패로 표시한다**(조용한 통과 금지).
 *
 * 사용법: pnpm tsx scripts/test-inspect.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  alphaCentroid,
  dhash,
  dhashSimilarity,
  histogramIntersection,
  inspectStates,
  rgbHistogram,
  similaritySummary,
  type Frame,
} from "../src/lib/sprite/inspect";
import {
  compositeOnWhite,
  pilResizeBilinear,
  pilResizeRgba,
  pilRgbToL,
} from "../src/lib/sprite/pil-resample";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const CANON = "/Users/wonpyoung/Developer/workspace/sprite-gen";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 알파가 섞인 결정론 노이즈. 알파 균일 이미지는 프리멀티플라이 차이를 못 잡는다. */
function noise(w: number, h: number, seed: number): Frame {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x * 251 + y * 97 + seed) % 256;
      d[i + 1] = (x * 97 + y * 173 + seed * 3) % 256;
      d[i + 2] = (x * 173 + y * 251 + seed * 7) % 256;
      d[i + 3] = (x * 31 + y * 17 + seed * 11) % 256;
    }
  }
  return { data: d, width: w, height: h };
}

(async () => {
  console.log("=== 단위: 순수 로직 ===");
  {
    const a = [0.5, 0.5, 0, 0];
    const b = [0.25, 0.25, 0.5, 0];
    check("histogramIntersection", Math.abs(histogramIntersection(a, b) - 0.5) < 1e-12);
    // bigint 리터럴은 target ES2017 에서 못 쓴다 (inspect.ts 주석 참고).
    const B = (n: number) => BigInt(n);
    check("dhashSimilarity 동일 = 1", dhashSimilarity(B(123), B(123)) === 1.0);
    check(
      "dhashSimilarity 1비트 차 = 63/64",
      Math.abs(dhashSimilarity(B(0), B(1)) - 63 / 64) < 1e-12,
    );
    const allBits = (B(1) << B(64)) - B(1);
    check("dhashSimilarity 전비트 차 = 0", dhashSimilarity(B(0), allBits) === 0.0);
    const empty: Frame = { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 };
    check("전부 투명이면 무게중심 null", alphaCentroid(empty) === null);
    check("전부 투명이면 히스토그램 0", rgbHistogram(empty).every(v => v === 0));
    check("프레임 1장이면 유사도 1.0", similaritySummary([noise(8, 8, 1)]).dhash_similarity.min === 1.0);
    check("프레임 1장이면 모션 0", similaritySummary([noise(8, 8, 1)]).motion_presence === 0.0);
  }

  if (!existsSync(PY)) {
    console.log("\n  FAIL 정본 대조 미실행 — 파이썬 venv 없음");
    failed++;
    console.log(`\n${passed} passed / ${failed} failed`);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "inspect-parity-"));
  try {
    console.log("\n=== 정본 대조: PIL 리샘플러 (바이트) ===");
    for (const [w, h, ow, oh] of [
      [4, 4, 2, 2],
      [16, 16, 4, 4],
      [256, 256, 64, 64],
      [1024, 256, 64, 64],
    ] as Array<[number, number, number, number]>) {
      const f = noise(w, h, 5);
      const srcPath = join(dir, `src-${w}x${h}.bin`);
      const ourPath = join(dir, `our-${w}x${h}-${ow}x${oh}.bin`);
      writeFileSync(srcPath, Buffer.from(f.data));
      writeFileSync(ourPath, Buffer.from(pilResizeRgba(f.data, w, h, ow, oh)));
      const out = execFileSync(
        PY,
        [
          "-c",
          [
            "from PIL import Image",
            "import numpy as np",
            `src = np.fromfile(${JSON.stringify(srcPath)}, dtype=np.uint8).reshape(${h},${w},4)`,
            `ref = np.array(Image.fromarray(src,"RGBA").resize((${ow},${oh}), Image.Resampling.BILINEAR))`,
            `our = np.fromfile(${JSON.stringify(ourPath)}, dtype=np.uint8).reshape(${oh},${ow},4)`,
            "print(int((ref!=our).sum()))",
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );
      check(`RGBA ${w}×${h} → ${ow}×${oh} 바이트 동일`, Number(out.trim()) === 0, `${out.trim()}B 차이`);
    }
    {
      // dHash 가 타는 경로: 흰 배경 합성 → L → 9×8 (1채널 리샘플)
      const f = noise(128, 128, 9);
      const white = compositeOnWhite(f.data, 128, 128);
      const gray = pilRgbToL(white, 128, 128);
      const srcPath = join(dir, "src-dhash.bin");
      const grayPath = join(dir, "our-gray.bin");
      const smallPath = join(dir, "our-small.bin");
      writeFileSync(srcPath, Buffer.from(f.data));
      writeFileSync(grayPath, Buffer.from(gray));
      writeFileSync(smallPath, Buffer.from(pilResizeBilinear(gray, 128, 128, 9, 8, 1)));
      const out = execFileSync(
        PY,
        [
          "-c",
          [
            "from PIL import Image",
            "import numpy as np",
            `src = np.fromfile(${JSON.stringify(srcPath)}, dtype=np.uint8).reshape(128,128,4)`,
            'im = Image.fromarray(src, "RGBA")',
            'flat = Image.new("RGBA", im.size, (255,255,255,255)); flat.alpha_composite(im)',
            'refL = np.array(flat.convert("L"))',
            `ourL = np.fromfile(${JSON.stringify(grayPath)}, dtype=np.uint8).reshape(128,128)`,
            'ref98 = np.array(flat.convert("L").resize((9,8), Image.Resampling.BILINEAR))',
            `our98 = np.fromfile(${JSON.stringify(smallPath)}, dtype=np.uint8).reshape(8,9)`,
            "print(int((refL!=ourL).sum()), int((ref98!=our98).sum()))",
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );
      const [lBad, sBad] = out.trim().split(/\s+/).map(Number);
      check("흰 배경 합성 + convert('L') 바이트 동일", lBad === 0, `${lBad}B 차이`);
      check("L 9×8 리샘플 바이트 동일", sBad === 0, `${sBad}B 차이`);
    }

    console.log("\n=== 정본 대조: 실제 추출 프레임의 신호 ===");
    const frameDirs = [
      "data/sprite-runs/sprite-1786868942478/frames-down_idle",
      "data/sprite-runs/sprite-1786868942478/frames-down_attack",
      "data/sprite-runs/sprite-1786866319972/frames-down_action",
    ].filter(existsSync);
    if (frameDirs.length === 0) {
      console.log("  FAIL 실제 프레임 디렉터리 없음 — 합성만으로는 이 대조를 대신할 수 없다");
      failed++;
    }
    for (const d of frameDirs) {
      const files = readdirSync(d)
        .filter(f => f.endsWith(".png"))
        .sort();
      const frames: Frame[] = [];
      for (const f of files) {
        const { data, info } = await sharp(join(d, f))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        frames.push({ data: new Uint8Array(data), width: info.width, height: info.height });
      }
      const ours = similaritySummary(frames);
      const ourHashes = frames.map(fr => dhash(fr).toString());
      const ourCentroids = frames.map(alphaCentroid);
      const out = execFileSync(
        PY,
        [
          "-c",
          [
            "import json, glob, os, sys",
            `sys.path.insert(0, ${JSON.stringify(CANON)})`,
            "from PIL import Image",
            "from sprite_gen.inspect import _similarity_summary, _dhash, _alpha_centroid",
            `files = sorted(glob.glob(os.path.join(${JSON.stringify(join(process.cwd(), d))}, "*.png")))`,
            'frames = [Image.open(f).convert("RGBA") for f in files]',
            "print(json.dumps({",
            '  "summary": _similarity_summary(frames),',
            '  "hashes": [str(_dhash(f)) for f in frames],',
            '  "centroids": [_alpha_centroid(f) for f in frames],',
            "}))",
          ].join("\n"),
        ],
        { encoding: "utf8", cwd: CANON },
      );
      const ref = JSON.parse(out) as {
        summary: typeof ours;
        hashes: string[];
        centroids: Array<[number, number] | null>;
      };
      const name = d.split("/").slice(-1)[0];
      const eq = (a: number, b: number) => Math.abs(a - b) < 1e-12;
      check(`${name}: dHash 값`, JSON.stringify(ourHashes) === JSON.stringify(ref.hashes));
      check(
        `${name}: 히스토그램 교차 min/mean`,
        eq(ours.histogram_intersection.min, ref.summary.histogram_intersection.min) &&
          eq(ours.histogram_intersection.mean, ref.summary.histogram_intersection.mean),
        `${ours.histogram_intersection.min} vs ${ref.summary.histogram_intersection.min}`,
      );
      check(
        `${name}: dHash 유사도 min/mean`,
        eq(ours.dhash_similarity.min, ref.summary.dhash_similarity.min) &&
          eq(ours.dhash_similarity.mean, ref.summary.dhash_similarity.mean),
        `${ours.dhash_similarity.min} vs ${ref.summary.dhash_similarity.min}`,
      );
      check(
        `${name}: 모션 존재`,
        eq(ours.motion_presence, ref.summary.motion_presence),
        `${ours.motion_presence} vs ${ref.summary.motion_presence}`,
      );
      check(
        `${name}: 무게중심 σ`,
        eq(ours.centroid_sigma.x, ref.summary.centroid_sigma.x) &&
          eq(ours.centroid_sigma.y, ref.summary.centroid_sigma.y),
        `${ours.centroid_sigma.x} vs ${ref.summary.centroid_sigma.x}`,
      );
      check(
        `${name}: 무게중심 값`,
        JSON.stringify(ourCentroids) === JSON.stringify(ref.centroids),
      );
    }

    console.log("\n=== 리포트 조합 ===");
    {
      const frames = [noise(32, 32, 1), noise(32, 32, 2), noise(32, 32, 3)];
      const r = inspectStates([{ state: "down_idle", expected: 3, frames }]);
      check("프레임 수가 맞으면 ok", r.ok && r.rows[0].ok);
      const r2 = inspectStates([{ state: "down_idle", expected: 4, frames }]);
      check(
        "프레임 수가 다르면 에러로 잡는다",
        !r2.ok && r2.rows[0].errors[0].includes("expected 4 frame(s), inspect found 3"),
        JSON.stringify(r2.rows[0].errors),
      );
      const r3 = inspectStates([{ state: "down_idle", expected: 4, frames: [] }]);
      check("프레임이 없으면 missing", r3.rows[0].source === "missing" && !r3.ok);
      // 같은 프레임을 반복하면 모션이 0 이라 경고가 떠야 한다.
      const still = [noise(32, 32, 1), noise(32, 32, 1)];
      const r4 = inspectStates([{ state: "down_idle", expected: 2, frames: still }]);
      check(
        "정지 화면은 모션 경고",
        r4.rows[0].warnings.some(w => w.includes("motion presence is too low")),
        JSON.stringify(r4.rows[0].warnings),
      );
      check("경고는 ok 를 뒤집지 않는다 (에러만 뒤집는다)", r4.ok && r4.rows[0].ok);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
