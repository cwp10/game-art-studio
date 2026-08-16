// SPDX-License-Identifier: Apache-2.0
//
// Pillow 의 리샘플러·색 변환 이식. 원본: Pillow src/libImaging/Resample.c,
// Convert.c (PIL, HPND License). sprite-gen 의 inspect 신호가 이 둘 위에서
// 계산되므로, 수치를 맞추려면 리샘플러부터 맞아야 한다.

/**
 * PIL `Image.Resampling.BILINEAR` 와 **바이트 동일**한 리샘플러.
 *
 * 왜 sharp 를 안 쓰는가: sharp/libvips 의 어떤 커널도 PIL 과 일치하지 않는다
 * (실측, 실제 프레임 기준 — mitchell 이 최선이고 maxdiff 7~12, 나머지는 더 크다).
 * `_dhash` 는 축소본의 **인접 픽셀 대소 비교**라 1 차이로도 비트가 뒤집히고,
 * 그 해밍 거리가 곧 점수·교정 힌트의 입력이다. 근사로는 정본과 같은 판정이 안 나온다.
 *
 * PIL 의 BILINEAR 는 단순 이중선형 보간이 아니라 **support 가 스케일에 따라 늘어나는
 * triangle 필터**다(축소할 때 안티에일리어싱이 붙는다). 가로 패스 → 세로 패스 2패스로
 * 돌고, 계수는 22비트 고정소수점으로 양자화한 뒤 정수 누산한다 — 그 양자화까지
 * 재현해야 마지막 1 LSB 가 맞는다.
 */

const PRECISION_BITS = 32 - 8 - 2; // Resample.c

/** triangle(bilinear) 필터. support = 1.0. */
function bilinearFilter(x: number): number {
  const a = x < 0 ? -x : x;
  return a < 1.0 ? 1.0 - a : 0.0;
}

/** `sinc_filter` (Resample.c). */
function sincFilter(x: number): number {
  if (x === 0.0) return 1.0;
  const p = x * Math.PI;
  return Math.sin(p) / p;
}

/**
 * `lanczos_filter` (Resample.c) — 잘린 sinc. support = 3.0.
 *
 * 삼각 필터와 달리 **계수가 음수가 될 수 있다.** 아래 고정소수점 변환의 음수 분기가
 * 여기서 실제로 쓰인다 (PIL 은 음수를 -0.5, 양수를 +0.5 오프셋으로 반올림한다).
 */
function lanczosFilter(x: number): number {
  if (x >= -3.0 && x < 3.0) return sincFilter(x) * sincFilter(x / 3);
  return 0.0;
}

type FilterSpec = { fn: (x: number) => number; support: number };
const BILINEAR: FilterSpec = { fn: bilinearFilter, support: 1.0 };
const LANCZOS: FilterSpec = { fn: lanczosFilter, support: 3.0 };

type Coeffs = {
  /** 출력 픽셀당 [xmin, xmax(길이)]. */
  bounds: Int32Array;
  /** 출력 픽셀당 ksize 개의 고정소수점 계수. */
  kk: Int32Array;
  ksize: number;
};

/**
 * `precompute_coeffs` + `normalize_coeffs_8bpc` (Resample.c).
 *
 * 음수 계수의 반올림이 양수와 다르다(-0.5 vs +0.5 오프셋) — triangle 은 음수 계수가
 * 없지만 원본과 같은 식을 쓴다.
 */
function precomputeCoeffs(inSize: number, outSize: number, filter: FilterSpec): Coeffs {
  const scale = inSize / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const support = filter.support * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);

  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0.0;
    const ss = 1.0 / filterscale;
    // `(int)` 는 0 방향 절단이지만 인자가 음수면 0 으로 클램프되므로 floor 와 같다.
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = filter.fn((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0.0) k[x] /= ww;
    }
    for (let x = xmax; x < ksize; x++) k[x] = 0;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
    for (let x = 0; x < ksize; x++) {
      const v = k[x];
      kk[xx * ksize + x] =
        v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
  }
  return { bounds, kk, ksize };
}

/** `clip8` (Resample.c) — 누산값을 PRECISION_BITS 만큼 내리고 0..255 로 자른다. */
function clip8(input: number): number {
  const v = Math.floor(input / (1 << PRECISION_BITS));
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 채널이 `channels` 개인 8비트 이미지를 PIL BILINEAR 로 리샘플한다.
 * 가로 → 세로 2패스, 중간 버퍼는 8비트 (원본과 같다).
 */
export function pilResizeBilinear(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  channels: number,
): Uint8Array {
  return pilResize(src, srcW, srcH, dstW, dstH, channels, BILINEAR);
}

/** 같은 리샘플러의 LANCZOS 경로 — 보간 tween 의 스케일 정규화가 쓴다. */
export function pilResizeLanczos(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  channels: number,
): Uint8Array {
  return pilResize(src, srcW, srcH, dstW, dstH, channels, LANCZOS);
}

function pilResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  channels: number,
  filter: FilterSpec,
): Uint8Array {
  // 가로 패스: srcW → dstW, 높이는 그대로.
  const hc = precomputeCoeffs(srcW, dstW, filter);
  const mid = new Uint8Array(dstW * srcH * channels);
  for (let yy = 0; yy < srcH; yy++) {
    for (let xx = 0; xx < dstW; xx++) {
      const xmin = hc.bounds[xx * 2];
      const xmax = hc.bounds[xx * 2 + 1];
      const kOff = xx * hc.ksize;
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let x = 0; x < xmax; x++) {
          ss += src[(yy * srcW + (x + xmin)) * channels + c] * hc.kk[kOff + x];
        }
        mid[(yy * dstW + xx) * channels + c] = clip8(ss);
      }
    }
  }
  // 세로 패스: srcH → dstH.
  const vc = precomputeCoeffs(srcH, dstH, filter);
  const out = new Uint8Array(dstW * dstH * channels);
  for (let yy = 0; yy < dstH; yy++) {
    const ymin = vc.bounds[yy * 2];
    const ymax = vc.bounds[yy * 2 + 1];
    const kOff = yy * vc.ksize;
    for (let xx = 0; xx < dstW; xx++) {
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y++) {
          ss += mid[((y + ymin) * dstW + xx) * channels + c] * vc.kk[kOff + y];
        }
        out[(yy * dstW + xx) * channels + c] = clip8(ss);
      }
    }
  }
  return out;
}

/** `MULDIV255` (Imaging.h) — a*b/255 의 PIL 반올림. */
function muldiv255(a: number, b: number): number {
  const tmp = a * b + 128;
  return ((tmp >> 8) + tmp) >> 8;
}

/**
 * PIL `Image.resize` 의 RGBA 경로.
 *
 * Pillow 는 RGBA 를 **그냥 리샘플하지 않는다** (Image.py):
 *
 *     if self.mode in ["LA", "RGBA"] and resample != NEAREST:
 *         im = self.convert({"LA": "La", "RGBA": "RGBa"}[self.mode])
 *         im = im.resize(size, resample, box)
 *         return im.convert(self.mode)
 *
 * 즉 알파 프리멀티플라이(RGBa) → 리샘플 → 언프리멀티플라이다. 이걸 빼면 투명
 * 픽셀의 RGB(우리 파이프라인에서는 0)가 이웃 색을 끌어내려 결과가 어긋난다 —
 * 알파가 균일한 이미지에서는 차이가 안 나서 놓치기 쉽다(실측: 불투명 합성
 * 이미지는 256×256→64×64 까지 바이트 일치, 알파를 섞자 11364/16384 불일치).
 */
export function pilResizeRgba(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const n = srcW * srcH;
  // RGBA → RGBa (Convert.c `rgba2rgbA`)
  const pre = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = rgba[i + 3];
    pre[i] = muldiv255(rgba[i], a);
    pre[i + 1] = muldiv255(rgba[i + 1], a);
    pre[i + 2] = muldiv255(rgba[i + 2], a);
    pre[i + 3] = a;
  }
  const small = pilResizeBilinear(pre, srcW, srcH, dstW, dstH, 4);
  // RGBa → RGBA (Convert.c `rgbA2rgba`) — 정수 나눗셈은 0 방향 절단.
  const m = dstW * dstH;
  const out = new Uint8Array(m * 4);
  for (let p = 0; p < m; p++) {
    const i = p * 4;
    const a = small[i + 3];
    if (a === 255 || a === 0) {
      out[i] = small[i];
      out[i + 1] = small[i + 1];
      out[i + 2] = small[i + 2];
    } else {
      for (let c = 0; c < 3; c++) {
        const v = Math.trunc((255 * small[i + c]) / a);
        out[i + c] = v > 255 ? 255 : v;
      }
    }
    out[i + 3] = a;
  }
  return out;
}

/**
 * PIL `convert("L")` — RGB→그레이. 원본은 부동소수 계수가 아니라 정수 근사다
 * (Convert.c `rgb2l`): `(R*19595 + G*38470 + B*7471 + 0x8000) >> 16`.
 * 0.299/0.587/0.114 를 그대로 쓰면 반올림이 어긋난다.
 */
export function pilRgbToL(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    out[p] = (rgba[i] * 19595 + rgba[i + 1] * 38470 + rgba[i + 2] * 7471 + 0x8000) >>> 16;
  }
  return out;
}

/**
 * PIL `alpha_composite` 로 흰 배경에 얹은 결과.
 *
 * `_dhash` 는 투명 영역을 흰색으로 메운 뒤 해시한다 — 알파가 다른 두 프레임이
 * 같은 실루엣이면 같은 해시가 나오게 하려는 것이다.
 */
export function compositeOnWhite(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const a = rgba[i + 3];
    if (a === 255) {
      out[i] = rgba[i];
      out[i + 1] = rgba[i + 1];
      out[i + 2] = rgba[i + 2];
      out[i + 3] = 255;
      continue;
    }
    // PIL 의 alpha_composite 은 두 소스를 프리멀티플라이해 합성한다. 배경이 완전
    // 불투명(255)이면 결과 알파도 255 이고 색은 src*a + dst*(255-a) 의 반올림이다.
    for (let c = 0; c < 3; c++) {
      const src = rgba[i + c] * a;
      const dst = 255 * (255 - a);
      out[i + c] = Math.round((src + dst) / 255);
    }
    out[i + 3] = 255;
  }
  return out;
}
