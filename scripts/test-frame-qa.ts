/**
 * 프레임별 QA 이식 테스트 — 정본 `extract.inspect_frames` 와 **문구까지** 대조한다.
 *
 * 경고·에러 문자열이 그대로 사람에게 나가고 score 의 힌트 분류 입력이 되므로,
 * 숫자 포맷 한 자리가 달라도 교차 대조가 깨진다(실측: 중앙값 9022.5 를 정본은
 * "9022", JS toFixed 는 "9023" 으로 쓴다).
 *
 * 사용법: pnpm tsx scripts/test-frame-qa.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import { inspectFrames, type RGB } from "../src/lib/sprite/frame-qa";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const CANON = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const KEY: RGB = [255, 0, 255];

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

type F = { data: Uint8Array; width: number; height: number };

/** w×h 캔버스에 사각형 하나. 나머지는 투명. */
function box(w: number, h: number, x0: number, y0: number, x1: number, y1: number, c: RGB): F {
  const d = new Uint8Array(w * h * 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

(async () => {
  console.log("=== 단위: 각 검사가 도는가 ===");
  {
    const normal = box(64, 64, 16, 16, 48, 48, [40, 90, 200]);
    const r = inspectFrames([normal, normal, normal], KEY);
    check("정상 프레임은 에러·경고 없음", r.errors.length === 0 && r.warnings.length === 0);
    check("레코드가 프레임 수만큼", r.records.length === 3);
    check("bbox 가 기록된다", JSON.stringify(r.records[0].bbox) === "[16,16,48,48]");

    const empty: F = { data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 };
    check(
      "빈 프레임은 에러",
      inspectFrames([empty], KEY).errors.some(e => e.includes("empty or too sparse")),
    );

    // 크로마 잔류 — 키 색 덩어리가 남아 있다.
    const residue = box(64, 64, 0, 0, 20, 20, [255, 0, 255]);
    check(
      "크로마 잔류는 에러",
      inspectFrames([residue], KEY).errors.some(e => e.includes("chroma-adjacent")),
    );

    // 테두리 접촉 — 위쪽 가장자리에 붙었다.
    const edge = box(64, 64, 0, 0, 64, 8, [40, 90, 200]);
    check(
      "테두리 접촉은 경고",
      inspectFrames([edge], KEY).warnings.some(w => w.includes("non-transparent edge pixels")),
    );

    // 크기 이상치 — 하나만 훨씬 작다.
    const small = box(64, 64, 30, 30, 36, 36, [40, 90, 200]);
    const out = inspectFrames([normal, normal, small], KEY);
    check(
      "중앙값보다 훨씬 작으면 경고",
      out.warnings.some(w => w.includes("much smaller than median")),
      JSON.stringify(out.warnings),
    );
    const big = box(64, 64, 2, 2, 62, 62, [40, 90, 200]);
    check(
      "중앙값보다 훨씬 크면 경고",
      inspectFrames([small, small, big], KEY).warnings.some(w => w.includes("much larger than median")),
    );
  }

  console.log("\n=== 정본 대조: 실제 추출 프레임 ===");
  if (!existsSync(PY)) {
    console.log("  FAIL 파이썬 venv 없음 — 대조를 못 했습니다");
    failed++;
  } else {
    const dirs = [
      "data/sprite-runs/sprite-1786909158013/frames-left_idle",
      "data/sprite-runs/sprite-1786909158013/frames-left_walk",
      "data/sprite-runs/sprite-1786868942478/frames-down_idle",
    ].filter(existsSync);
    if (dirs.length === 0) {
      console.log("  FAIL 실제 프레임 디렉터리 없음");
      failed++;
    }
    for (const d of dirs) {
      const files = readdirSync(d).filter(f => f.endsWith(".png")).sort();
      const frames: F[] = [];
      for (const f of files) {
        const { data, info } = await sharp(join(d, f))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        frames.push({ data: new Uint8Array(data), width: info.width, height: info.height });
      }
      const ours = inspectFrames(frames, KEY);
      const out = execFileSync(
        PY,
        [
          "-c",
          [
            "import json, glob, os, sys, argparse",
            `sys.path.insert(0, ${JSON.stringify(CANON)})`,
            "from PIL import Image",
            "from sprite_gen.extract import inspect_frames",
            `files = sorted(glob.glob(os.path.join(${JSON.stringify(join(process.cwd(), d))}, "*.png")))`,
            'frames = [Image.open(f).convert("RGBA") for f in files]',
            "args = argparse.Namespace(min_used_pixels=400, edge_margin=2, edge_pixel_threshold=24,",
            "  chroma_adjacent_threshold=150.0, chroma_adjacent_pixel_threshold=120,",
            "  small_outlier_ratio=0.35, large_outlier_ratio=2.75)",
            "e, w, r = inspect_frames(frames, (255,0,255), args)",
            'print(json.dumps({"errors": e, "warnings": w, "records": r}))',
          ].join("\n"),
        ],
        { encoding: "utf8", cwd: CANON },
      );
      const ref = JSON.parse(out) as typeof ours;
      const name = d.split("/").slice(-1)[0];
      check(`${name}: 에러 문구 동일`, JSON.stringify(ours.errors) === JSON.stringify(ref.errors),
        `${JSON.stringify(ours.errors)} vs ${JSON.stringify(ref.errors)}`);
      check(`${name}: 경고 문구 동일`, JSON.stringify(ours.warnings) === JSON.stringify(ref.warnings),
        `${JSON.stringify(ours.warnings)} vs ${JSON.stringify(ref.warnings)}`);
      check(`${name}: 레코드 동일 (픽셀 수·bbox·엣지·크로마)`,
        JSON.stringify(ours.records) === JSON.stringify(ref.records));
    }
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
