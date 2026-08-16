// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `interpolate.py` 이식 — 두 프레임 사이 중간(in-between) 프레임 생성.
// 원본: sprite-gen/sprite_gen/interpolate.py (Apache-2.0)

/**
 * 한 상태의 두 프레임 사이 중간 포즈를 **생성 모델로** 그려낸다.
 *
 * ## 왜 광학 흐름이 아니라 생성인가
 *
 * 플로우 기반 VFI(RIFE)는 정본이 파기했다. 외형이 변하는 픽셀아트 보간에서 VFI 는
 * 구조적으로 크로스페이드(블러 잔상)를 내고, 3-way 실측 비교에서 생성형이 중간 포즈를
 * 깨끗한 픽셀로 그려내 압승했다.
 *
 * ## 파이프라인에서의 위치
 *
 * "AI 개입은 raw 생성 한 곳뿐" 이라는 도크트린을 지킨다 — 보간도 **raw 단계의 AI
 * 생성**이다. 산출물은 최종 프레임이 아니라 raw 이미지이고, 논리 프레임은 언제나 기존
 * 결정론 추출 경로(크로마 제거 → 컴포넌트 → 셀 배치)가 굽는다.
 *
 * ## 두 개의 결정론 단계가 생성을 감싼다
 *
 * 1. **정합** (`alignedPairOnChroma`): 정적인 몸 픽셀이 두 참조에서 같은 위치에 있어야
 *    생성 모델이 "움직인 부위만 다른 같은 그림 두 장" 으로 읽는다.
 * 2. **스케일 정규화** (`normalizeTweenScale`): 생성형은 피사체를 다른 크기로 그릴 수
 *    있다(정본 실사고: tween 이 형제 프레임보다 14% 커져 재생 시 캐릭터가 튐). 참조
 *    두 장의 콘텐츠 높이 평균에 맞춰 되돌린다.
 */

import {
  extractComponentImages,
  registerRowFrames,
  tightenComponents,
  type RawImage,
} from "@/lib/sprite/extract";
export type { RawImage };
import { pilResizeLanczos } from "@/lib/sprite/pil-resample";
import type { RGB } from "@/lib/sprite/chroma-clean";

export class InterpolationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterpolationFailed";
  }
}

/** 크로마 위에 앉힌 RGB 프레임 (알파 없음 — 생성 모델에 넣을 참조 이미지). */
export type RgbImage = { data: Uint8Array; width: number; height: number };

const ALPHA_PRECISION_BITS = 7;

/** `SHIFTFORDIV255` (Imaging.h) — a/255 의 PIL 정수 근사. */
function shiftForDiv255(a: number): number {
  return ((a >> 8) + a) >> 8;
}

/**
 * 보간 생성 프롬프트 — request 의 캐릭터·크로마 진실에서 **결정론으로** 조립한다.
 *
 * 문구를 바꾸면 정본과 다른 그림이 나온다. 대조 테스트가 글자까지 고정한다.
 */
export function tweenPrompt(
  opts: {
    characterDescription?: string | null;
    chromaName: string;
    chromaHex: string;
  },
  t: number,
): string {
  const character = opts.characterDescription || "the same character";
  let blend: string;
  if (Math.abs(t - 0.5) < 1e-9) {
    blend = "the precise halfway in-between of A and B";
  } else {
    const nearer = t < 0.5 ? "A" : "B";
    blend =
      `the in-between of A and B at t=${formatG(t)} on the A->B motion ` +
      `(closer to ${nearer})`;
  }
  return (
    "Pixel art animation IN-BETWEEN frame task. Reference image 1 is frame A and " +
    "reference image 2 is frame B of the same character's animation. " +
    `Draw exactly ONE full-body pose that is ${blend}: limbs and body positioned ` +
    "between the two reference poses. " +
    `Character identity must match the references exactly (${character}). ` +
    "Same clean pixel-art style, same pixel block size, same scale, and same " +
    "position in the canvas as the references. " +
    `Flat solid chroma ${opts.chromaName} ${opts.chromaHex} background filling the ` +
    "entire canvas. No shadows, no text, no labels, no frame borders, no arrows, " +
    "no multiple panels — exactly one figure on the flat background."
  );
}

/**
 * 파이썬 `f"{x:g}"` — 유효숫자 6자리, 꼬리 0 제거.
 *
 * 프롬프트에 `t=0.35` 로 들어가는 값이라 `0.35000000000000003` 같은 double 잡음이
 * 새어나가면 정본과 다른 프롬프트가 된다.
 */
function formatG(x: number): string {
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  // %g 는 지수가 -4 미만이거나 유효숫자(6) 이상이면 지수 표기로 간다. 보간 t 는
  // (0, 1) 이라 그 범위 밖으로 갈 일이 없지만 원본 규칙 그대로 둔다.
  if (exp < -4 || exp >= 6) {
    return x
      .toExponential(5)
      .replace(/\.?0+e/, "e")
      .replace(/e([+-])(\d)$/, "e$10$2");
  }
  const fixed = x.toFixed(Math.max(0, 5 - exp));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * 스트립에서 두 프레임을 뽑아 상체 정합 후 같은 크로마 캔버스에 앉힌다.
 *
 * 배경은 요청 크로마 단색이다 — 생성 결과도 같은 배경을 유지하도록 프롬프트가 요구하고,
 * 추출의 크로마 제거가 그대로 처리한다. 캔버스는 32의 배수로 패딩한다.
 *
 * `strip` 은 **크로마를 이미 지운** RGBA 여야 한다. 정본은 이 함수 안에서 ycbcr 매팅을
 * 부르지만, 우리는 크로마 경로가 `auto` 판정을 거치므로 호출자가 지운 것을 넘긴다 —
 * 같은 행에 두 가지 알파가 생기는 것을 막는다.
 */
export function alignedPairOnChroma(
  strip: RawImage,
  frameCount: number,
  indexA: number,
  indexB: number,
  chromaRgb: RGB,
): [RgbImage, RgbImage] {
  const grouped = extractComponentImages(strip, frameCount);
  if (!grouped) {
    throw new InterpolationFailed(`could not extract ${frameCount} components from the strip`);
  }
  const components = grouped.images;
  for (const index of [indexA, indexB]) {
    if (!(index >= 0 && index < components.length)) {
      throw new InterpolationFailed(
        `frame index ${index} out of range 0..${components.length - 1}`,
      );
    }
  }
  const tight = tightenComponents(components);
  const pair = registerRowFrames([tight[indexA], tight[indexB]]);
  const width = pair[0].width;
  const height = pair[0].height;
  const paddedW = Math.floor((width + 31) / 32) * 32;
  const paddedH = Math.floor((height + 31) / 32) * 32;
  const outputs = pair.map(frame => {
    const canvas: RgbImage = {
      data: new Uint8Array(paddedW * paddedH * 3),
      width: paddedW,
      height: paddedH,
    };
    for (let i = 0; i < paddedW * paddedH; i++) {
      canvas.data[i * 3] = chromaRgb[0];
      canvas.data[i * 3 + 1] = chromaRgb[1];
      canvas.data[i * 3 + 2] = chromaRgb[2];
    }
    const left = Math.floor((paddedW - width) / 2);
    const top = paddedH - height;
    // 불투명 크로마 위 `alpha_composite` → RGB 변환. **실수식을 쓰면 안 된다** —
    // PIL 은 7비트 고정소수점 계수와 반올림 항을 쓰고, 그 차이가 프린지에서 1 씩
    // 어긋나 정본과 다른 참조 이미지를 만든다 (실측 8591/516096 바이트).
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const s = (y * frame.width + x) * 4;
        const sa = frame.data[s + 3];
        if (sa === 0) continue;
        const d = ((top + y) * paddedW + (left + x)) * 3;
        // 대상이 불투명(a=255)이라 outa255 는 항상 255*255 이고 coef1 = sa*128 이다.
        const coef1 = sa * (1 << ALPHA_PRECISION_BITS);
        const coef2 = 255 * (1 << ALPHA_PRECISION_BITS) - coef1;
        for (let c = 0; c < 3; c++) {
          const tmp = frame.data[s + c] * coef1 + chromaRgb[c] * coef2 + (0x80 << ALPHA_PRECISION_BITS);
          canvas.data[d + c] = shiftForDiv255(tmp) >> ALPHA_PRECISION_BITS;
        }
      }
    }
    return canvas;
  });
  return [outputs[0], outputs[1]];
}

/**
 * 크로마 단색 배경 위 피사체의 bbox — 크로마와 충분히 다른 픽셀만 콘텐츠로 센다.
 *
 * 임계는 채널 절대차의 **합**이다(맨해튼 거리). 생성 결과의 배경이 요청 크로마와 몇
 * 단계 어긋나도 배경으로 읽히도록 넉넉히 잡혀 있다.
 */
export function chromaContentBBox(
  image: RgbImage,
  chromaRgb: RGB,
  tolerance = 60,
): [number, number, number, number] | null {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1;
  const [cr, cg, cb] = chromaRgb;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 3;
      const d =
        Math.abs(image.data[i] - cr) +
        Math.abs(image.data[i + 1] - cg) +
        Math.abs(image.data[i + 2] - cb);
      if (d <= tolerance) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * 생성된 중간 프레임을 참조 쌍의 스케일에 맞춘다 (결정론 후처리).
 *
 * 참조 두 장의 콘텐츠 **높이 평균**을 목표로 중간 프레임을 리스케일하고, 참조와 같은
 * 크로마 캔버스에 **같은 바닥선**으로 다시 앉힌다. 이후의 추출이 격자를 다시 굽는다.
 */
export function normalizeTweenScale(
  mid: RgbImage,
  img0: RgbImage,
  img1: RgbImage,
  chromaRgb: RGB,
): RgbImage {
  const refBoxes = [chromaContentBBox(img0, chromaRgb), chromaContentBBox(img1, chromaRgb)];
  const midBox = chromaContentBBox(mid, chromaRgb);
  if (!refBoxes[0] || !refBoxes[1] || !midBox) {
    throw new InterpolationFailed(
      "tween scale normalization failed: could not find content on the chroma background",
    );
  }
  const targetH = (refBoxes[0][3] - refBoxes[0][1] + (refBoxes[1][3] - refBoxes[1][1])) / 2.0;
  const midH = midBox[3] - midBox[1];
  const factor = targetH / midH;

  const [mx0, my0, mx1, my1] = midBox;
  const cw = mx1 - mx0;
  const ch = my1 - my0;
  const content = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const s = ((my0 + y) * mid.width + mx0) * 3;
    content.set(mid.data.subarray(s, s + cw * 3), y * cw * 3);
  }
  const sw = Math.max(1, pyRound(cw * factor));
  const sh = Math.max(1, pyRound(ch * factor));
  const scaled = pilResizeLanczos(content, cw, ch, sw, sh, 3);

  const canvas: RgbImage = {
    data: new Uint8Array(img0.width * img0.height * 3),
    width: img0.width,
    height: img0.height,
  };
  for (let i = 0; i < img0.width * img0.height; i++) {
    canvas.data[i * 3] = chromaRgb[0];
    canvas.data[i * 3 + 1] = chromaRgb[1];
    canvas.data[i * 3 + 2] = chromaRgb[2];
  }
  const left = Math.floor((canvas.width - sw) / 2);
  // 참조와 같은 바닥선 — 참조 콘텐츠가 캔버스 바닥에서 띄운 만큼을 그대로 띄운다.
  const top = Math.max(0, canvas.height - sh - (img0.height - refBoxes[0][3]));
  for (let y = 0; y < sh; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= canvas.height) continue;
    for (let x = 0; x < sw; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= canvas.width) continue;
      const s = (y * sw + x) * 3;
      const d = (dy * canvas.width + dx) * 3;
      canvas.data[d] = scaled[s];
      canvas.data[d + 1] = scaled[s + 1];
      canvas.data[d + 2] = scaled[s + 2];
    }
  }
  return canvas;
}

/** 파이썬 `round()` — 은행가 반올림. `.5` 가 뜨면 짝수 쪽으로 간다. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 테이크 라벨 기본값 — 정본과 같은 규칙(`.` 을 `p` 로). */
export function defaultTweenLabel(indexA: number, indexB: number, t: number): string {
  return `tween_${indexA}_${indexB}_t${formatG(t)}`.replace(/\./g, "p");
}

/** 파일명으로 쓸 수 있는 라벨인가 — 정본과 같은 거부 조건. */
export function assertSafeLabel(label: string): void {
  if (label.includes("/") || label.startsWith(".")) {
    throw new InterpolationFailed(`take label must be filesystem-safe: '${label}'`);
  }
}

// ── 오케스트레이션 ───────────────────────────────────────────────────

/**
 * 중간 프레임 생성기. `(img0, img1, t, prompt) -> mid`.
 *
 * 정본과 같이 주입 가능하다 — 테스트는 스텁을 넣어 생성 없이 앞뒤 결정론 단계를 잰다.
 */
export type Interpolator = (
  img0: RgbImage,
  img1: RgbImage,
  t: number,
  prompt: string,
) => Promise<RgbImage>;

export type InterpolateResult = {
  /** 참조 쌍과 같은 캔버스·같은 바닥선으로 정규화된 중간 프레임. */
  mid: RgbImage;
  /** 생성에 쓴 참조 쌍 (진단·QA 용). */
  refs: [RgbImage, RgbImage];
  prompt: string;
  label: string;
};

/**
 * 두 프레임 사이 중간 프레임을 만든다.
 *
 * 정본 `interpolate_between` 에 대응하되 **기록은 하지 않는다** — 정본은 테이크 raw
 * 사이드카(`raw/<state>.takes/`)에 쓰고 request 를 갱신하지만 우리에겐 그 계층이 없다.
 * 어디에 남길지는 호출자가 정한다.
 *
 * `strip` 은 **크로마를 이미 지운** RGBA 여야 한다 (`alignedPairOnChroma` 주석 참조).
 */
export async function interpolateBetween(opts: {
  strip: RawImage;
  frameCount: number;
  indexA: number;
  indexB: number;
  chromaRgb: RGB;
  chromaName: string;
  chromaHex: string;
  characterDescription?: string | null;
  t?: number;
  label?: string;
  interpolator: Interpolator;
}): Promise<InterpolateResult> {
  const t = opts.t ?? 0.5;
  if (!(t > 0 && t < 1)) {
    throw new InterpolationFailed(`t must be inside (0, 1): ${t}`);
  }
  const label = opts.label ?? defaultTweenLabel(opts.indexA, opts.indexB, t);
  assertSafeLabel(label);

  const [img0, img1] = alignedPairOnChroma(
    opts.strip,
    opts.frameCount,
    opts.indexA,
    opts.indexB,
    opts.chromaRgb,
  );
  const prompt = tweenPrompt(
    {
      characterDescription: opts.characterDescription,
      chromaName: opts.chromaName,
      chromaHex: opts.chromaHex,
    },
    t,
  );
  const generated = await opts.interpolator(img0, img1, t, prompt);
  // 생성형은 피사체를 다른 크기로 그린다 — 참조 쌍 스케일로 되돌리는 게 계약이다.
  const mid = normalizeTweenScale(generated, img0, img1, opts.chromaRgb);
  return { mid, refs: [img0, img1], prompt, label };
}
