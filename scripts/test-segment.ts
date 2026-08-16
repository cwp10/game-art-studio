/**
 * `segment.ts` 가 정본 `sprite_gen/segment.py` 와 같은 수를 내는지.
 *
 * 투영 프로파일·런·봉우리·DP 컷·경계·재조립을 **같은 PNG** 로 양쪽에 물려 대조한다.
 * 크로마 경로를 태우지 않는 이유는 그 차이가 섞이면 이 모듈의 계약을 못 재기
 * 때문이다 — 여기서 보려는 건 "알파가 주어졌을 때 어디를 자르는가" 하나다.
 *
 * 실행: npx tsx scripts/test-segment.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectAlpha,
  contentRuns,
  dropMinorRuns,
  medianRunWidth,
  posePeaks,
  dpNCut,
  splitRange,
  segmentStrip,
  segmentBoundaries,
  resolveSegmentation,
  separateFusedPoses,
  GUTTER,
  type RawImage,
} from "../src/lib/sprite/segment";
import { removeChromaBackground } from "../src/lib/sprite/chroma-clean";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const dir = mkdtempSync(join(tmpdir(), "segment-"));

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

if (!existsSync(PY)) {
  console.log("  FAIL 파이썬 venv 없음 — 정본 대조를 못 했습니다");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

const FRAMES = [
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png",
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-1.png",
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-2.png",
  "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-3.png",
].filter(existsSync);

void (async () => {
if (FRAMES.length < 4) {
  console.log(`  FAIL 실제 프레임 부족 (${FRAMES.length}/4)`);
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

/** 프레임들을 가로로 이어붙인 스트립. overlap 이 양수면 서로 파고들어 융착된다. */
async function buildStrip(paths: string[], gap: number, name: string): Promise<string> {
  const parts = await Promise.all(
    paths.map(async p => {
      const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    }),
  );
  const h = Math.max(...parts.map(p => p.h));
  const step = parts[0].w + gap; // gap 음수 = 겹침
  const total = step * (parts.length - 1) + parts[parts.length - 1].w;
  const out = Buffer.alloc(total * h * 4);
  parts.forEach((p, i) => {
    const x0 = i * step;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const s = (y * p.w + x) * 4;
        if (p.data[s + 3] === 0) continue; // 겹칠 때 뒤 프레임이 앞을 지우지 않게
        const d = (y * total + x0 + x) * 4;
        out[d] = p.data[s]; out[d + 1] = p.data[s + 1];
        out[d + 2] = p.data[s + 2]; out[d + 3] = p.data[s + 3];
      }
    }
  });
  const path = join(dir, name);
  await sharp(out, { raw: { width: total, height: h, channels: 4 } }).png().toFile(path);
  return path;
}

async function load(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** 정본을 그대로 돌려 모든 중간 산출을 받는다. */
function canonical(path: string, expected: number): Record<string, unknown> {
  const out = execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.segment import (project_alpha, smooth_profile, content_runs, drop_minor_runs,
                                median_run_width, pose_peaks, dp_n_cut, split_range,
                                segment_strip, segment_boundaries)
im = Image.open(${JSON.stringify(path)}).convert("RGBA")
width = im.width
raw = project_alpha(im)
window = max(3, width // 220)
profile = smooth_profile(raw, window)
peak_max = max(profile, default=0.0)
eps, peak_min = 0.045 * peak_max, 0.18 * peak_max
min_run = max(4, width // 100)
runs = content_runs(profile, eps, peak_min, min_run)
kept = drop_minor_runs(profile, runs, 0.20)
segs, natural = segment_strip(im, ${expected})
bounds, natural2 = segment_boundaries(im, ${expected})
print(json.dumps({
  "width": width, "raw_sum": sum(raw), "raw_head": raw[:12],
  "profile_head": profile[:12], "peak_max": peak_max,
  "runs": runs, "kept": kept, "med": median_run_width(kept),
  "peaks": [pose_peaks(profile, s, e) for s, e in kept],
  "dp2": dp_n_cut(profile, 0, width, 2),
  "dp4": dp_n_cut(profile, 0, width, 4),
  "split3": split_range(profile, 0, width, 3),
  "segments": segs, "natural": natural,
  "boundaries": bounds, "natural2": natural2,
}))
`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

const nearly = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const strips: Array<[string, string, number]> = [
  ["거터 있는 스트립 (자연 분리)", await buildStrip(FRAMES, 24, "gapped.png"), 4],
  ["딱 붙은 스트립", await buildStrip(FRAMES, 0, "flush.png"), 4],
  ["겹친 스트립 (융착)", await buildStrip(FRAMES, -28, "fused.png"), 4],
];

for (const [label, path, expected] of strips) {
  console.log(`\n=== ${label} ===`);
  const img = await load(path);
  const ref = canonical(path, expected);

  const raw = projectAlpha(img);
  const rawSum = raw.reduce((a, b) => a + b, 0);
  check(`${label}: 알파 투영 합`, rawSum === ref.raw_sum, `${rawSum} vs ${ref.raw_sum}`);
  check(`${label}: 알파 투영 앞 12칸`,
    (ref.raw_head as number[]).every((v, i) => raw[i] === v));

  // segment_strip 내부와 같은 순서로 재현한다.
  const { smoothProfile } = await import("../src/lib/sprite/silhouette");
  const window = Math.max(3, Math.floor(img.width / 220));
  const profile = smoothProfile(raw, window);
  let peakMax = 0;
  for (const v of profile) if (v > peakMax) peakMax = v;
  check(`${label}: 평활 프로파일 최대`, nearly(peakMax, ref.peak_max as number), `${peakMax} vs ${ref.peak_max}`);
  check(`${label}: 평활 프로파일 앞 12칸`,
    (ref.profile_head as number[]).every((v, i) => nearly(profile[i], v)));

  const runs = contentRuns(profile, 0.045 * peakMax, 0.18 * peakMax, Math.max(4, Math.floor(img.width / 100)));
  check(`${label}: 콘텐츠 런`, JSON.stringify(runs) === JSON.stringify(ref.runs),
    `${JSON.stringify(runs)} vs ${JSON.stringify(ref.runs)}`);
  const kept = dropMinorRuns(profile, runs, 0.2);
  check(`${label}: 잡티 런 제거`, JSON.stringify(kept) === JSON.stringify(ref.kept));
  check(`${label}: 런 폭 중앙값`, medianRunWidth(kept) === ref.med, `${medianRunWidth(kept)} vs ${ref.med}`);
  const peaks = kept.map(([s, e]) => posePeaks(profile, s, e));
  check(`${label}: 포즈 봉우리`, JSON.stringify(peaks) === JSON.stringify(ref.peaks),
    `${JSON.stringify(peaks)} vs ${JSON.stringify(ref.peaks)}`);

  check(`${label}: DP 2분할 컷`, JSON.stringify(dpNCut(profile, 0, img.width, 2)) === JSON.stringify(ref.dp2),
    `${JSON.stringify(dpNCut(profile, 0, img.width, 2))} vs ${JSON.stringify(ref.dp2)}`);
  check(`${label}: DP 4분할 컷`, JSON.stringify(dpNCut(profile, 0, img.width, 4)) === JSON.stringify(ref.dp4),
    `${JSON.stringify(dpNCut(profile, 0, img.width, 4))} vs ${JSON.stringify(ref.dp4)}`);
  check(`${label}: splitRange 3`, JSON.stringify(splitRange(profile, 0, img.width, 3)) === JSON.stringify(ref.split3));

  const st = segmentStrip(img, expected);
  check(`${label}: 세그먼트`, JSON.stringify(st.segments) === JSON.stringify(ref.segments),
    `${JSON.stringify(st.segments)} vs ${JSON.stringify(ref.segments)}`);
  check(`${label}: 자연 포즈 수`, st.natural === ref.natural, `${st.natural} vs ${ref.natural}`);

  const bd = segmentBoundaries(img, expected);
  check(`${label}: 경계 컬럼`, JSON.stringify(bd.boundaries) === JSON.stringify(ref.boundaries),
    `${JSON.stringify(bd.boundaries)} vs ${JSON.stringify(ref.boundaries)}`);

  // 재조립 스트립 픽셀 대조 — 정본은 crop/paste 로, 우리는 행 복사로 만든다.
  const outBin = join(dir, `rebuilt-${label.replace(/\W+/g, "_")}.bin`);
  const pyOut = execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.segment import separate_fused_poses
im = Image.open(${JSON.stringify(path)}).convert("RGBA")
out = separate_fused_poses(im, ${expected}, {"segmentation": "projection"}, None, "t")
np.array(out).tofile(${JSON.stringify(outBin)})
print(json.dumps({"w": out.width, "h": out.height}))
`], { encoding: "utf8" });
  const meta = JSON.parse(pyOut) as { w: number; h: number };
  const ours = separateFusedPoses(img, expected, { fit: { segmentation: "projection" }, label: "t" });
  check(`${label}: 재조립 크기`, ours.strip.width === meta.w && ours.strip.height === meta.h,
    `${ours.strip.width}x${ours.strip.height} vs ${meta.w}x${meta.h}`);
  const refBytes = new Uint8Array(readFileSync(outBin));
  check(`${label}: 재조립 픽셀 동일`,
    refBytes.length === ours.strip.data.length && refBytes.every((v, i) => v === ours.strip.data[i]));
  check(`${label}: applied 플래그가 경계 유무와 일치`, ours.applied === (bd.boundaries !== null));
}

console.log("\n=== 모드 해석 ===");
check("기본은 components", resolveSegmentation(undefined, null) === "components");
check("fit 이 SSoT", resolveSegmentation({ segmentation: "projection" }, null) === "projection");
check("override 가 우선", resolveSegmentation({ segmentation: "projection" }, "components") === "components");
check("대문자도 소문자로", resolveSegmentation({ segmentation: "PROJECTION" }, null) === "projection");

console.log("\n=== off 면 스트립을 건드리지 않는다 ===");
{
  const img = await load(strips[2][1]);
  const r = separateFusedPoses(img, 4, {});
  check("모드가 꺼져 있으면 입력 그대로", r.strip === img && r.applied === false);
  check("꺼져 있으면 note 도 없다", r.note === undefined);
}

console.log("\n=== 분리 실패는 조용하지 않다 ===");
{
  // 프레임 4장짜리 스트립에서 9개를 기대하면 못 찾는다 — 스트립은 그대로 두고 보고한다.
  const img = await load(strips[0][1]);
  const r = separateFusedPoses(img, 9, { fit: { segmentation: "projection" }, label: "row" });
  const refOut = execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.segment import segment_boundaries
im = Image.open(${JSON.stringify(strips[0][1])}).convert("RGBA")
b, n = segment_boundaries(im, 9)
print(json.dumps({"b": b, "n": n}))
`], { encoding: "utf8" });
  const ref = JSON.parse(refOut) as { b: number[] | null; n: number };
  check("정본도 같은 자연 포즈 수", r.natural === ref.n, `${r.natural} vs ${ref.n}`);
  if (ref.b === null) {
    check("실패하면 스트립을 건드리지 않는다", r.applied === false && r.strip === img);
    check("실패 사실을 note 로 낸다", !!r.note && r.note.includes("left untouched"), r.note ?? "");
  } else {
    check("정본이 9개를 찾았다 — 우리도 찾아야 한다", r.applied === true);
  }
}

console.log("\n=== 거터 폭 계약 ===");
{
  const img = await load(strips[1][1]);
  const r = separateFusedPoses(img, 4, { fit: { segmentation: "projection" } });
  if (r.applied) {
    check("거터가 조각 사이와 양끝에 들어간다",
      r.strip.width === img.width + GUTTER * 5, `${r.strip.width} vs ${img.width + GUTTER * 5}`);
    // 첫 GUTTER 열은 완전히 투명해야 한다 (4-연결 분리 보장).
    let opaque = 0;
    for (let y = 0; y < r.strip.height; y++)
      for (let x = 0; x < GUTTER; x++)
        if (r.strip.data[(y * r.strip.width + x) * 4 + 3] !== 0) opaque++;
    check("좌측 거터는 완전 투명", opaque === 0, `${opaque}px`);
  } else {
    check("딱 붙은 스트립도 4개로 갈린다", false, r.note ?? "");
  }
}

console.log("\n=== 실제 원시 스트립 (크로마 제거 후) ===");
{
  const src = "data/images/8bw0d8mv2bg3sf0g.png";
  if (!existsSync(src)) {
    check("원시 스트립 없음 — 실데이터 대조를 건너뜁니다", false, src);
  } else {
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    removeChromaBackground(data, info.width, info.height, [255, 0, 255]);
    const path = join(dir, "real-cleaned.png");
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(path);
    const img = await load(path);
    const ref = canonical(path, 8);
    const st = segmentStrip(img, 8);
    check("실스트립: 세그먼트 동일", JSON.stringify(st.segments) === JSON.stringify(ref.segments),
      `${JSON.stringify(st.segments)} vs ${JSON.stringify(ref.segments)}`);
    check("실스트립: 자연 포즈 수 동일", st.natural === ref.natural, `${st.natural} vs ${ref.natural}`);
    const bd = segmentBoundaries(img, 8);
    check("실스트립: 경계 동일", JSON.stringify(bd.boundaries) === JSON.stringify(ref.boundaries),
      `${JSON.stringify(bd.boundaries)} vs ${JSON.stringify(ref.boundaries)}`);
    console.log(`  (참고) 1774x887 스트립 자연 포즈 ${st.natural}개, 경계 ${JSON.stringify(bd.boundaries)}`);
  }
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
