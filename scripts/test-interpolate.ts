/**
 * `interpolate.ts` + 선행 부품(`tightenComponents`, `registerRowFrames`)이 정본과
 * 같은 결과를 내는지.
 *
 * 생성(codex) 자체는 여기서 부르지 않는다 — 이 스위트가 고정하는 건 생성을 감싸는
 * **두 결정론 단계**다: 참조 쌍 정합과 결과 스케일 정규화. 그 둘이 어긋나면 tween 이
 * 형제 프레임과 다른 크기·다른 바닥선으로 굽혀 재생 시 캐릭터가 튄다.
 *
 * 실행: npx tsx scripts/test-interpolate.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeChromaBackground } from "../src/lib/sprite/chroma-clean";
import {
  extractComponentImages,
  registerRowFrames,
  tightenComponents,
  pilGetBBox,
  type RawImage,
} from "../src/lib/sprite/extract";
import {
  tweenPrompt,
  alignedPairOnChroma,
  chromaContentBBox,
  normalizeTweenScale,
  defaultTweenLabel,
  assertSafeLabel,
  InterpolationFailed,
  interpolateBetween,
  type RgbImage,
} from "../src/lib/sprite/interpolate";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const dir = mkdtempSync(join(tmpdir(), "interp-"));

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

void (async () => {

console.log("=== tweenPrompt: 정본과 글자까지 동일 ===");
{
  const cases: Array<[string | null, number]> = [
    ["a blue knight in plate armor", 0.5],
    ["a blue knight in plate armor", 0.25],
    ["a blue knight in plate armor", 0.75],
    [null, 0.5],
    ["문어 캐릭터", 0.35],
    ["x", 0.1],
    ["x", 0.9],
    ["x", 0.125],
  ];
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.interpolate import tween_prompt
cases = json.loads(sys.stdin.read())
out = []
for desc, t in cases:
    req = {"character": {"description": desc}, "chroma_key": {"name": "magenta", "hex": "#FF00FF"}}
    out.append(tween_prompt(req, t))
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify(cases) })) as string[];

  cases.forEach(([desc, t], i) => {
    const ours = tweenPrompt(
      { characterDescription: desc, chromaName: "magenta", chromaHex: "#FF00FF" },
      t,
    );
    check(`프롬프트 t=${t} desc=${desc === null ? "null" : "설정"}`, ours === refs[i],
      ours === refs[i] ? "" : `\n    우리: ...${ours.slice(150, 260)}\n    정본: ...${refs[i].slice(150, 260)}`);
  });
}

console.log("\n=== 라벨 규칙 ===");
{
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import json
cases = [(1, 2, 0.5), (0, 1, 0.25), (3, 4, 0.125), (0, 7, 0.9)]
print(json.dumps([f"tween_{a}_{b}_t{t:g}".replace(".", "p") for a, b, t in cases]))
`], { encoding: "utf8" })) as string[];
  const cases: Array<[number, number, number]> = [[1, 2, 0.5], [0, 1, 0.25], [3, 4, 0.125], [0, 7, 0.9]];
  cases.forEach(([a, b, t], i) => {
    check(`기본 라벨 ${a}<->${b} t=${t}`, defaultTweenLabel(a, b, t) === refs[i],
      `${defaultTweenLabel(a, b, t)} vs ${refs[i]}`);
  });
  let threw = "";
  try { assertSafeLabel("a/b"); } catch (e) { threw = (e as Error).message; }
  check("슬래시 라벨은 거부", threw.includes("filesystem-safe"), threw);
  threw = "";
  try { assertSafeLabel(".hidden"); } catch (e) { threw = (e as Error).message; }
  check("점으로 시작하는 라벨도 거부", threw.includes("filesystem-safe"), threw);
  let ok = true;
  try { assertSafeLabel("tween_1_2_t0p5"); } catch { ok = false; }
  check("정상 라벨은 통과", ok);
}

// ── 실제 스트립으로 정합·스케일 정규화 대조 ─────────────────────────

const SRC = "data/images/8bw0d8mv2bg3sf0g.png";
if (!existsSync(SRC)) {
  check("실제 스트립 없음 — 이미지 대조를 못 했습니다", false, SRC);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(1);
}
const CHROMA: [number, number, number] = [255, 0, 255];
const FRAMES = 8;

// 양쪽이 **같은 알파**에서 출발하도록, 크로마를 지운 스트립을 PNG 로 굳혀 공유한다.
const { data: rawData, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
removeChromaBackground(rawData, info.width, info.height, CHROMA);
const cleanedPath = join(dir, "cleaned.png");
await sharp(rawData, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png().toFile(cleanedPath);
const strip: RawImage = { data: Buffer.from(rawData), width: info.width, height: info.height };

console.log("\n=== tightenComponents / registerRowFrames (선행 부품) ===");
{
  const grouped = extractComponentImages(strip, FRAMES);
  if (!grouped) {
    check("컴포넌트 분리", false, "null");
  } else {
    const tight = tightenComponents(grouped.images);
    const pair = registerRowFrames([tight[1], tight[3]]);

    const outBin = join(dir, "reg.bin");
    const meta = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import extract_component_images, tighten_components, register_row_frames
im = Image.open(${JSON.stringify(cleanedPath)}).convert("RGBA")
comps = extract_component_images(im, ${FRAMES})
tight = tighten_components(comps)
sizes = [list(c.size) for c in tight]
pair = register_row_frames([tight[1], tight[3]])
np.concatenate([np.array(p).ravel() for p in pair]).tofile(${JSON.stringify(outBin)})
print(json.dumps({"tight_sizes": sizes, "pair_size": list(pair[0].size)}))
`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as { tight_sizes: number[][]; pair_size: number[] };

    check("tighten 후 컴포넌트 크기 동일",
      JSON.stringify(tight.map(t => [t.width, t.height])) === JSON.stringify(meta.tight_sizes),
      `${JSON.stringify(tight.map(t => [t.width, t.height]))} vs ${JSON.stringify(meta.tight_sizes)}`);
    check("정합 결과 캔버스 크기 동일",
      pair[0].width === meta.pair_size[0] && pair[0].height === meta.pair_size[1],
      `${pair[0].width}x${pair[0].height} vs ${meta.pair_size.join("x")}`);
    const ref = new Uint8Array(readFileSync(outBin));
    const mine = new Uint8Array(pair[0].data.length + pair[1].data.length);
    mine.set(pair[0].data, 0);
    mine.set(pair[1].data, pair[0].data.length);
    let diff = 0;
    for (let i = 0; i < Math.min(ref.length, mine.length); i++) if (ref[i] !== mine[i]) diff++;
    check("정합 결과 픽셀 동일", ref.length === mine.length && diff === 0,
      `${diff}/${ref.length} 바이트 불일치 (길이 ${mine.length} vs ${ref.length})`);
  }
}

console.log("\n=== alignedPairOnChroma ===");
let img0: RgbImage, img1: RgbImage;
{
  [img0, img1] = alignedPairOnChroma(strip, FRAMES, 1, 3, CHROMA);
  const outBin = join(dir, "aligned.bin");
  const meta = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import extract_component_images, tighten_components, register_row_frames
im = Image.open(${JSON.stringify(cleanedPath)}).convert("RGBA")
comps = extract_component_images(im, ${FRAMES})
tight = tighten_components(comps)
pair = register_row_frames([tight[1], tight[3]])
w, h = pair[0].size
pw, ph = (w + 31) // 32 * 32, (h + 31) // 32 * 32
outs = []
for frame in pair:
    canvas = Image.new("RGBA", (pw, ph), (255, 0, 255, 255))
    canvas.alpha_composite(frame, ((pw - w) // 2, ph - h))
    outs.append(canvas.convert("RGB"))
np.concatenate([np.array(o).ravel() for o in outs]).tofile(${JSON.stringify(outBin)})
print(json.dumps({"size": [pw, ph]}))
`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as { size: number[] };

  check("정합 쌍 캔버스 크기 (32의 배수)",
    img0.width === meta.size[0] && img0.height === meta.size[1],
    `${img0.width}x${img0.height} vs ${meta.size.join("x")}`);
  check("캔버스가 32의 배수", img0.width % 32 === 0 && img0.height % 32 === 0);
  const ref = new Uint8Array(readFileSync(outBin));
  const mine = new Uint8Array(img0.data.length + img1.data.length);
  mine.set(img0.data, 0);
  mine.set(img1.data, img0.data.length);
  let diff = 0;
  for (let i = 0; i < Math.min(ref.length, mine.length); i++) if (ref[i] !== mine[i]) diff++;
  check("정합 쌍 픽셀 동일", ref.length === mine.length && diff === 0,
    `${diff}/${ref.length} 바이트 불일치`);
}

console.log("\n=== chromaContentBBox ===");
{
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.extract import extract_component_images, tighten_components, register_row_frames
from sprite_gen.interpolate import _chroma_content_bbox
im = Image.open(${JSON.stringify(cleanedPath)}).convert("RGBA")
comps = extract_component_images(im, ${FRAMES})
tight = tighten_components(comps)
pair = register_row_frames([tight[1], tight[3]])
w, h = pair[0].size
pw, ph = (w + 31) // 32 * 32, (h + 31) // 32 * 32
outs = []
for frame in pair:
    canvas = Image.new("RGBA", (pw, ph), (255, 0, 255, 255))
    canvas.alpha_composite(frame, ((pw - w) // 2, ph - h))
    outs.append(canvas.convert("RGB"))
print(json.dumps([list(_chroma_content_bbox(o, (255, 0, 255)) or []) for o in outs]))
`], { encoding: "utf8" })) as number[][];
  const b0 = chromaContentBBox(img0, CHROMA);
  const b1 = chromaContentBBox(img1, CHROMA);
  check("img0 콘텐츠 bbox 동일", JSON.stringify(b0) === JSON.stringify(refs[0]),
    `${JSON.stringify(b0)} vs ${JSON.stringify(refs[0])}`);
  check("img1 콘텐츠 bbox 동일", JSON.stringify(b1) === JSON.stringify(refs[1]),
    `${JSON.stringify(b1)} vs ${JSON.stringify(refs[1])}`);
}

console.log("\n=== normalizeTweenScale ===");
{
  // 생성 결과를 흉내낸다: 다른 프레임을 1.2배·0.8배로 키워/줄여 크로마 위에 앉힌 것.
  // 정본이 실사고로 잡은 "tween 이 14% 크게 나온" 상황과 같은 클래스다.
  for (const [tag, scaleNum, scaleDen] of [["1.2배", 6, 5], ["0.8배", 4, 5]] as Array<[string, number, number]>) {
    const midPath = join(dir, `mid-${scaleNum}-${scaleDen}.png`);
    const w = Math.round((img0.width * scaleNum) / scaleDen);
    const h = Math.round((img0.height * scaleNum) / scaleDen);
    await sharp(Buffer.from(img1.data), { raw: { width: img1.width, height: img1.height, channels: 3 } })
      .resize(w, h, { kernel: "nearest" })
      .png()
      .toFile(midPath);
    // 다시 원 캔버스에 크로마 배경으로 앉혀 "생성 결과" 모양을 만든다.
    const stagedPath = join(dir, `staged-${scaleNum}-${scaleDen}.png`);
    execFileSync(PY, ["-c", `
from PIL import Image
mid = Image.open(${JSON.stringify(midPath)}).convert("RGB")
canvas = Image.new("RGB", (${img0.width}, ${img0.height}), (255, 0, 255))
canvas.paste(mid, (max(0, (canvas.width - mid.width) // 2), max(0, canvas.height - mid.height)))
canvas.save(${JSON.stringify(stagedPath)})
`]);
    const { data: sd, info: si } = await sharp(stagedPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const mid: RgbImage = { data: new Uint8Array(sd), width: si.width, height: si.height };

    const img0Path = join(dir, "img0.png");
    const img1Path = join(dir, "img1.png");
    await sharp(Buffer.from(img0.data), { raw: { width: img0.width, height: img0.height, channels: 3 } }).png().toFile(img0Path);
    await sharp(Buffer.from(img1.data), { raw: { width: img1.width, height: img1.height, channels: 3 } }).png().toFile(img1Path);

    const outBin = join(dir, `norm-${scaleNum}-${scaleDen}.bin`);
    execFileSync(PY, ["-c", `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.interpolate import normalize_tween_scale
mid = Image.open(${JSON.stringify(stagedPath)}).convert("RGB")
a = Image.open(${JSON.stringify(img0Path)}).convert("RGB")
b = Image.open(${JSON.stringify(img1Path)}).convert("RGB")
out = normalize_tween_scale(mid, a, b, (255, 0, 255))
np.array(out).tofile(${JSON.stringify(outBin)})
`], { maxBuffer: 64 * 1024 * 1024 });

    const ours = normalizeTweenScale(mid, img0, img1, CHROMA);
    const ref = new Uint8Array(readFileSync(outBin));
    let diff = 0;
    for (let i = 0; i < Math.min(ref.length, ours.data.length); i++) if (ref[i] !== ours.data[i]) diff++;
    check(`${tag} tween 스케일 정규화 픽셀 동일`,
      ref.length === ours.data.length && diff === 0,
      `${diff}/${ref.length} 바이트 불일치`);

    // 계약: 정규화 후 콘텐츠 높이가 참조 두 장의 평균에 맞는다.
    const nb = chromaContentBBox(ours, CHROMA);
    const r0 = chromaContentBBox(img0, CHROMA)!;
    const r1 = chromaContentBBox(img1, CHROMA)!;
    const target = ((r0[3] - r0[1]) + (r1[3] - r1[1])) / 2;
    const got = nb ? nb[3] - nb[1] : 0;
    check(`${tag} 콘텐츠 높이가 참조 평균에 맞는다`, Math.abs(got - target) <= 2,
      `${got} vs 목표 ${target}`);
  }
}

console.log("\n=== 실패는 조용하지 않다 ===");
{
  let threw = "";
  try { alignedPairOnChroma(strip, FRAMES, 0, 99, CHROMA); }
  catch (e) { threw = (e as Error).message; }
  check("범위 밖 인덱스는 거부", threw.includes("out of range"), threw);

  const flat: RgbImage = { data: new Uint8Array(32 * 32 * 3), width: 32, height: 32 };
  for (let i = 0; i < 32 * 32; i++) { flat.data[i * 3] = 255; flat.data[i * 3 + 1] = 0; flat.data[i * 3 + 2] = 255; }
  threw = "";
  try { normalizeTweenScale(flat, img0, img1, CHROMA); }
  catch (e) { threw = e instanceof InterpolationFailed ? e.message : String(e); }
  check("콘텐츠가 없으면 스케일 정규화 거부", threw.includes("could not find content"), threw);
}

console.log("\n=== pilGetBBox 는 4채널 기준이다 ===");
{
  // 알파 0 이지만 RGB 가 남은 픽셀 — PIL getbbox 는 콘텐츠로 세고 알파 bbox 는 아니다.
  const img: RawImage = { data: Buffer.alloc(4 * 4 * 4), width: 4, height: 4 };
  img.data[(1 * 4 + 1) * 4] = 200; // RGB 만, 알파 0
  const outJson = execFileSync(PY, ["-c", `
import json, numpy as np
from PIL import Image
a = np.zeros((4, 4, 4), dtype=np.uint8)
a[1, 1, 0] = 200
rgb_only = list(Image.fromarray(a, "RGBA").getbbox() or [])
a[2, 2, 3] = 200
with_alpha = list(Image.fromarray(a, "RGBA").getbbox() or [])
print(json.dumps({"rgb_only": rgb_only, "with_alpha": with_alpha}))
`], { encoding: "utf8" });
  const ref = JSON.parse(outJson) as { rgb_only: number[]; with_alpha: number[] };
  // Pillow 10+ 의 getbbox 는 RGBA 에서 alpha_only 가 기본이라 RGB 잔여를 무시한다.
  check("알파 0 + RGB 잔여는 콘텐츠가 아니다 (alpha_only 기본)",
    (pilGetBBox(img) === null) === (ref.rgb_only.length === 0),
    `${JSON.stringify(pilGetBBox(img))} vs ${JSON.stringify(ref.rgb_only)}`);
  const img2: RawImage = { data: Buffer.from(img.data), width: 4, height: 4 };
  img2.data[(2 * 4 + 2) * 4 + 3] = 200;
  check("알파가 있으면 그 픽셀이 박스를 만든다",
    JSON.stringify(pilGetBBox(img2)) === JSON.stringify(ref.with_alpha),
    `${JSON.stringify(pilGetBBox(img2))} vs ${JSON.stringify(ref.with_alpha)}`);
}

console.log("\n=== 오케스트레이션 (생성은 스텁) ===");
{
  // 스텁은 "1.3배로 크게 그린 생성 모델" 을 흉내낸다 — 정규화가 되돌려야 한다.
  let seenPrompt = "";
  let seenRefs: [RgbImage, RgbImage] | null = null;
  const stub = async (a: RgbImage, b: RgbImage, _t: number, prompt: string): Promise<RgbImage> => {
    seenPrompt = prompt;
    seenRefs = [a, b];
    const w = Math.round(a.width * 1.3), h = Math.round(a.height * 1.3);
    const big = await sharp(Buffer.from(b.data), { raw: { width: b.width, height: b.height, channels: 3 } })
      .resize(w, h, { kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
    const canvas: RgbImage = { data: new Uint8Array(a.width * a.height * 3), width: a.width, height: a.height };
    for (let i = 0; i < a.width * a.height; i++) {
      canvas.data[i * 3] = CHROMA[0]; canvas.data[i * 3 + 1] = CHROMA[1]; canvas.data[i * 3 + 2] = CHROMA[2];
    }
    const left = Math.max(0, Math.floor((a.width - w) / 2)), top = Math.max(0, a.height - h);
    for (let y = 0; y < h; y++) {
      const dy = top + y; if (dy >= a.height) break;
      for (let x = 0; x < w; x++) {
        const dx = left + x; if (dx >= a.width) break;
        const sIdx = (y * w + x) * 3, dIdx = (dy * a.width + dx) * 3;
        canvas.data[dIdx] = big.data[sIdx]; canvas.data[dIdx + 1] = big.data[sIdx + 1]; canvas.data[dIdx + 2] = big.data[sIdx + 2];
      }
    }
    return canvas;
  };

  const r = await interpolateBetween({
    strip, frameCount: FRAMES, indexA: 1, indexB: 3, chromaRgb: CHROMA,
    chromaName: "magenta", chromaHex: "#FF00FF",
    characterDescription: "a blue knight", t: 0.5, interpolator: stub,
  });
  check("기본 라벨이 붙는다", r.label === "tween_1_3_t0p5", r.label);
  check("프롬프트가 생성기에 그대로 전달된다", seenPrompt === r.prompt);
  check("참조 쌍이 정합 결과와 같다",
    seenRefs !== null && (seenRefs as [RgbImage, RgbImage])[0].width === img0.width);
  check("결과 캔버스가 참조와 같은 크기",
    r.mid.width === img0.width && r.mid.height === img0.height,
    `${r.mid.width}x${r.mid.height} vs ${img0.width}x${img0.height}`);
  // 1.3배로 그려도 참조 평균 높이로 되돌아온다 — 이게 이 단계의 존재 이유다.
  const nb = chromaContentBBox(r.mid, CHROMA);
  const r0 = chromaContentBBox(img0, CHROMA)!, r1 = chromaContentBBox(img1, CHROMA)!;
  const target = ((r0[3] - r0[1]) + (r1[3] - r1[1])) / 2;
  check("1.3배로 그려도 참조 평균 높이로 정규화된다",
    Math.abs((nb ? nb[3] - nb[1] : 0) - target) <= 2, `${nb ? nb[3] - nb[1] : 0} vs ${target}`);

  let threw = "";
  try {
    await interpolateBetween({
      strip, frameCount: FRAMES, indexA: 1, indexB: 3, chromaRgb: CHROMA,
      chromaName: "magenta", chromaHex: "#FF00FF", t: 0, interpolator: stub,
    });
  } catch (e) { threw = (e as Error).message; }
  check("t 가 (0,1) 밖이면 거부", threw.includes("inside (0, 1)"), threw);
}

void writeFileSync;
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
