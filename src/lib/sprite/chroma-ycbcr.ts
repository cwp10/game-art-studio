// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `extract.remove_chroma_background_ycbcr` 및 그 헬퍼 이식.
// 원본: sprite-gen/sprite_gen/extract.py:348-694 (Apache-2.0)
// 원본의 원본: perfectpixel-studio internal/sprite/chroma.go (MIT) — NOTICE 참조.

/**
 * 크로미넌스 평면 매팅 — **열화된 크로마 원본**용 opt-in 경로.
 *
 * 기본 RGB 경로(`chroma-clean.ts`)는 키까지의 RGB 거리로 픽셀을 분류하므로,
 * 셰이딩·그라디언트가 섞인 키 배경이나 JPEG 4:2:0 크로마 노이즈가 배경 픽셀을
 * 소거 반경 밖으로 밀어내 배경이 살아남는다. 이 경로는 루마를 통째로 버리고
 * CbCr 평면에서 분리한다 — 셰이딩은 Y 를 움직이지 CbCr 을 움직이지 않으므로
 * 키가 하나의 조밀한 크로마 클러스터로 남는다.
 *
 * **기본이 아니다.** 정본이 rgb 를 기본으로 두는 이유가 있다: 깨끗한 평면 키
 * 원본에서는 RGB 경로의 exact-solve 언믹스가 키 틴트를 완전히 제거하는 반면,
 * ycbcr 의 고정 스케일 디스필은 소프트 엣지에 옅은 틴트 헤일로를 남긴다.
 * (sprite-gen docs/chroma-alpha.md: *"ycbcr is for degraded sources … not a
 * general upgrade"*.)
 *
 * 이 경로가 rgb 와 결정적으로 다른 점은 **선언된 키를 믿지 않는다**는 것이다.
 * 테두리에서 실제 키를 검출하고(CbCr 히스토그램 최빈), 매팅 후 두 오검출 증상
 * — 불투명 비율 급등(배경 대신 피사체가 지워짐) · 선언키 잔류 급등(배경이
 * 살아남음) — 을 자가 진단해 선언된 순수 키로 재매팅한다. 더 나은 쪽이 이기고,
 * 폴백은 `warnings` 로 표면화된다(조용한 폴백 없음).
 */

export type RGB = readonly [number, number, number];

const YCC_CHROMA_IN = 24.0; // CbCr 거리 이하 → 완전 투명 (키)
const YCC_CHROMA_OUT = 72.0; // CbCr 거리 이상 → 완전 불투명 (피사체)
const YCC_DESPILL_BAND = 100.0; // 이 안쪽 CbCr 거리의 픽셀을 디스필
const YCC_DESPILL_SCALE = 0.92; // 디스필 강도 (키 방향 크로마 억제)
const YCC_FLOOD_TOL = 88.0; // 테두리 플러드 필 배경 허용치 (CbCr, 관대)
const YCC_ALPHA_EMPTY = 10; // 이 값 이하 알파는 빈 픽셀로 센다
const YCC_KEY_RESIDUE_DIST = 55.0; // 선언 키 주변 잔류 측정 반경
const YCC_KEY_BIAS_FRACTION = 0.12; // 최빈값을 뒤엎는 선언키 테두리 점유율
const YCC_REMATTE_OPAQUE_FRAC = 0.6; // 불투명 비율 급등 → 키 오검출 의심
const YCC_REMATTE_RESIDUE_FRAC = 0.025; // 선언키 잔류 급등 → 매팅 미완

/** BT.601 YCbCr, 8비트 범위, 크로마는 128 중심. */
export function rgbToYcc(red: number, green: number, blue: number): [number, number, number] {
  const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
  return [luma, (blue - luma) * 0.564 + 128.0, (red - luma) * 0.713 + 128.0];
}

/** 원본 `_u8` — 음수는 0, 255 초과는 255, 그 사이는 `int(v + 0.5)`(절단). */
function u8(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.trunc(value + 0.5);
}

export function yccToRgb(luma: number, cb: number, cr: number): [number, number, number] {
  return [
    u8(luma + 1.402 * (cr - 128.0)),
    u8(luma - 0.344136 * (cb - 128.0) - 0.714136 * (cr - 128.0)),
    u8(luma + 1.772 * (cb - 128.0)),
  ];
}

/** Hermite 0→1 전이 (소프트 매트 엣지 페더링). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return 0.0;
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
  return t * t * (3.0 - 2.0 * t);
}

/**
 * 코너 패치 + 얇은 테두리에서 배경 키를 추정한다.
 *
 * 양자화한 CbCr 히스토그램의 **최빈값** — 평균이 아니다: 평균은 그라디언트·압축
 * 노이즈에 끌려가고, 최빈값은 지배적인 크로마 클러스터에 물린다. 넓은 포즈(걷기
 * 사이클)는 테두리에 닿아 히스토그램을 피사체 색으로 채울 수 있으므로, 표본 중
 * 선언 키의 크로마 패밀리가 충분한 비율을 차지하면 그 클러스터가 무조건 이긴다.
 *
 * 코너 패치와 테두리 줄은 겹치는 픽셀을 **두 번 센다** — 원본과 동일하다.
 */
export function detectBackgroundKeyYcc(
  src: Uint8Array,
  width: number,
  height: number,
  declaredKey: RGB,
): [number, number, number] {
  if (width === 0 || height === 0) return [declaredKey[0], declaredKey[1], declaredKey[2]];
  const [, declaredCb, declaredCr] = rgbToYcc(declaredKey[0], declaredKey[1], declaredKey[2]);
  const bins = new Map<number, [number, number, number, number]>();
  let total = 0;
  const keyFamily = [0, 0, 0, 0]; // count, sum r, sum g, sum b

  const visit = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    const red = src[i], green = src[i + 1], blue = src[i + 2];
    total += 1;
    const [, cb, cr] = rgbToYcc(red, green, blue);
    if (Math.hypot(cb - declaredCb, cr - declaredCr) < YCC_KEY_RESIDUE_DIST) {
      keyFamily[0] += 1;
      keyFamily[1] += red;
      keyFamily[2] += green;
      keyFamily[3] += blue;
    }
    // 원본의 `(int(cb) >> 3 << 6) | (int(cr) >> 3)`. int() 는 0 방향 절단이고
    // cb/cr 은 음수가 될 수 있다(예: 검은 배경) — Math.trunc 와 부호 있는 시프트가
    // Python 의 절단·산술 시프트와 같은 값을 낸다.
    const slot = ((Math.trunc(cb) >> 3) << 6) | (Math.trunc(cr) >> 3);
    let acc = bins.get(slot);
    if (acc === undefined) {
      acc = [0, 0, 0, 0];
      bins.set(slot, acc);
    }
    acc[0] += 1;
    acc[1] += red;
    acc[2] += green;
    acc[3] += blue;
  };

  let cornerW = Math.floor(width / 5);
  let cornerH = Math.floor(height / 5);
  if (cornerW < 2) cornerW = width;
  if (cornerH < 2) cornerH = height;
  const patches: Array<[number, number, number, number]> = [
    [0, 0, cornerW, cornerH],
    [width - cornerW, 0, width, cornerH],
    [0, height - cornerH, cornerW, height],
    [width - cornerW, height - cornerH, width, height],
  ];
  for (const [x0, y0, x1, y1] of patches) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) visit(x, y);
  }
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }

  if (total > 0 && keyFamily[0] * 100 >= total * Math.trunc(YCC_KEY_BIAS_FRACTION * 100)) {
    const count = keyFamily[0];
    return [
      Math.floor(keyFamily[1] / count),
      Math.floor(keyFamily[2] / count),
      Math.floor(keyFamily[3] / count),
    ];
  }
  let best: [number, number, number, number] | null = null;
  for (const acc of bins.values()) {
    if (best === null || acc[0] > best[0]) best = acc;
  }
  if (best === null || best[0] === 0) return [declaredKey[0], declaredKey[1], declaredKey[2]];
  return [
    Math.floor(best[1] / best[0]),
    Math.floor(best[2] / best[0]),
    Math.floor(best[3] / best[0]),
  ];
}

/**
 * 테두리에서 시작하는 4연결 플러드 필 — 키 크로마 픽셀의 알파를 0 으로.
 *
 * 피사체를 지키는 것은 **연결성**이다: 크로마가 우연히 키 근처인 내부 픽셀(고립된
 * 하이라이트, 보석)은 테두리에 닿지 않아 살아남고, 소프트 매트가 다 지우지 못한
 * 그라디언트·노이즈 배경은 테두리에 연결되어 지워진다.
 *
 * 판정은 **원본 색**(src)으로 하고 지우는 것은 출력 알파다.
 */
function floodClearBackgroundYcc(
  out: Uint8Array,
  src: Uint8Array,
  width: number,
  height: number,
  keyCb: number,
  keyCr: number,
): void {
  if (width < 3 || height < 3) return;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  // floodable(rgb) 는 픽셀값의 순수 함수(키·톨 고정)라 색값으로 메모이즈해도
  // 방문 집합이 동일하다 — 지배적 단색 배경의 float 판정을 색당 한 번만 돈다.
  const floodCache = new Map<number, boolean>();

  const push = (x: number, y: number): void => {
    const position = y * width + x;
    if (visited[position]) return;
    const i = position * 4;
    const rgbKey = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    let ok = floodCache.get(rgbKey);
    if (ok === undefined) {
      const [, cb, cr] = rgbToYcc(src[i], src[i + 1], src[i + 2]);
      ok = Math.hypot(cb - keyCb, cr - keyCr) <= YCC_FLOOD_TOL;
      floodCache.set(rgbKey, ok);
    }
    if (ok) {
      visited[position] = 1;
      stack.push(position);
    }
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length > 0) {
    const position = stack.pop() as number;
    const x = position % width;
    const y = (position - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  // 방문 집합 = 클리어 대상. 알파만 0 으로 (RGB 불변).
  for (let p = 0; p < visited.length; p++) {
    if (visited[p]) out[p * 4 + 3] = 0;
  }
}

/**
 * `src` 를 `key` 에 대해 CbCr 평면에서 소프트 매팅한다.
 *
 * 매팅된 RGBA 와 **불투명 픽셀 비율**을 돌려준다 — 후자가 자가 진단의 입력이다:
 * 키를 잘못 검출하면 배경 대신 피사체가 지워져 이 비율이 급등한다.
 */
function matteYcc(
  src: Uint8Array,
  width: number,
  height: number,
  key: RGB,
): { out: Uint8Array; frac: number } {
  const out = new Uint8Array(width * height * 4); // 전부 (0,0,0,0)
  const [, keyCb, keyCr] = rgbToYcc(key[0], key[1], key[2]);
  const keyVb = keyCb - 128.0;
  const keyVr = keyCr - 128.0;
  const keyLen = Math.hypot(keyVb, keyVr);
  // 매트 출력은 픽셀값 (r,g,b) 의 순수 함수(키 고정) — 크로마 배경 스프라이트는
  // 고유색이 적어 색값 메모이즈로 같은 float 연산을 색당 한 번만 돈다. 산술 동일.
  const cache = new Map<number, [number, number, number, number]>();

  const px = width * height;
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    const alpha = src[i + 3];
    if (alpha === 0) continue;
    const rgbKey = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    let hit = cache.get(rgbKey);
    if (hit === undefined) {
      let red = src[i], green = src[i + 1], blue = src[i + 2];
      const [luma, cb0, cr0] = rgbToYcc(red, green, blue);
      let cb = cb0, cr = cr0;
      const dist = Math.hypot(cb - keyCb, cr - keyCr);
      const coverage = smoothstep(YCC_CHROMA_IN, YCC_CHROMA_OUT, dist);
      if (coverage <= 0) {
        hit = [0, 0, 0, coverage];
      } else {
        if (keyLen > 1 && dist < YCC_DESPILL_BAND) {
          // 디스필: 키 방향 크로마 성분만 뺀다 — 키에 직교하는 색은 채도를 유지한다.
          const pixelVb = cb - 128.0;
          const pixelVr = cr - 128.0;
          const proj = (pixelVb * keyVb + pixelVr * keyVr) / keyLen;
          if (proj > 0) {
            const weight =
              smoothstep(0.0, 1.0, (YCC_DESPILL_BAND - dist) / YCC_DESPILL_BAND) * YCC_DESPILL_SCALE;
            cb = 128.0 + (pixelVb - (keyVb / keyLen) * proj * weight);
            cr = 128.0 + (pixelVr - (keyVr / keyLen) * proj * weight);
            [red, green, blue] = yccToRgb(luma, cb, cr);
          }
        }
        hit = [red, green, blue, coverage];
      }
      cache.set(rgbKey, hit);
    }
    const cov = hit[3];
    if (cov <= 0) continue;
    out[i] = hit[0];
    out[i + 1] = hit[1];
    out[i + 2] = hit[2];
    out[i + 3] = Math.trunc(alpha * cov);
  }
  floodClearBackgroundYcc(out, src, width, height, keyCb, keyCr);
  let opaque = 0;
  for (let p = 0; p < px; p++) if (out[p * 4 + 3] > YCC_ALPHA_EMPTY) opaque++;
  const frac = px > 0 ? opaque / px : 0.0;
  return { out, frac };
}

/**
 * 키의 크로마 패밀리 안에서 아직 불투명한 픽셀의 비율.
 * *"매트가 배경 제거를 끝내지 못했다"* 의 증상 지표.
 */
export function keyResidueFractionYcc(
  img: Uint8Array,
  width: number,
  height: number,
  key: RGB,
): number {
  const px = width * height;
  if (px === 0) return 0.0;
  const [, keyCb, keyCr] = rgbToYcc(key[0], key[1], key[2]);
  let count = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    if (img[i + 3] <= YCC_ALPHA_EMPTY) continue;
    const [, cb, cr] = rgbToYcc(img[i], img[i + 1], img[i + 2]);
    if (Math.hypot(cb - keyCb, cr - keyCr) < YCC_KEY_RESIDUE_DIST) count++;
  }
  return count / px;
}

/**
 * 완전히 고립된 불투명 점을 지우고 거의 둘러싸인 핀홀을 메운다.
 *
 * 판정은 알파 **스냅샷**에서 하므로 패스가 연쇄되지 않는다. 소프트 매트 엣지는
 * 건드리지 않는다(이웃 0 개인 점과 이웃 7 개 이상인 구멍만).
 */
function cleanupAlphaYcc(img: Uint8Array, width: number, height: number): void {
  if (width < 3 || height < 3) return;
  const px = width * height;
  const op = new Uint8Array(px);
  for (let p = 0; p < px; p++) op[p] = img[p * 4 + 3] > YCC_ALPHA_EMPTY ? 1 : 0;
  const neighbors = new Uint8Array(px);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          n += op[ny * width + nx];
        }
      }
      neighbors[y * width + x] = n;
    }
  }
  for (let p = 0; p < px; p++) {
    if (op[p] === 1 && neighbors[p] === 0) img[p * 4 + 3] = 0;
    else if (op[p] === 0 && neighbors[p] >= 7) img[p * 4 + 3] = 255;
  }
}

/**
 * 자가 진단 순수키 재매팅이 붙은 크로미넌스 평면 매팅.
 *
 * `data` 를 제자리에서 고친다(RGBA). `warnings` 를 주면 폴백 사유가 담긴다 —
 * 정본과 같이 **폴백은 조용하지 않다**.
 */
export function removeChromaBackgroundYcbcr(
  data: Uint8Array,
  width: number,
  height: number,
  declaredKey: RGB,
  warnings?: string[],
): void {
  const source = Uint8Array.from(data); // 매팅·플러드·재매팅 모두 원본을 본다
  const detected = detectBackgroundKeyYcc(source, width, height, declaredKey);

  let { out, frac: opaqueFrac } = matteYcc(source, width, height, detected);
  let residue = keyResidueFractionYcc(out, width, height, declaredKey);
  let usedDeclared =
    detected[0] === declaredKey[0] && detected[1] === declaredKey[1] && detected[2] === declaredKey[2];

  const note = (message: string): void => {
    warnings?.push(message);
  };

  if (
    !usedDeclared &&
    (opaqueFrac > YCC_REMATTE_OPAQUE_FRAC || residue > YCC_REMATTE_RESIDUE_FRAC)
  ) {
    const { out: retry, frac: retryFrac } = matteYcc(source, width, height, declaredKey);
    const retryResidue = keyResidueFractionYcc(retry, width, height, declaredKey);
    const betterFrac = retryFrac < opaqueFrac - 0.03 && retryFrac > 0.02;
    const lessResidue = retryResidue < residue;
    if ((betterFrac || lessResidue) && retryFrac > 0.02) {
      note(
        `검출 키 [${detected}] 기각 (불투명 ${opaqueFrac.toFixed(3)}, ` +
          `잔류 ${residue.toFixed(4)}) — 선언 키 [${declaredKey}] 로 재매팅`,
      );
      out = retry;
      opaqueFrac = retryFrac;
      residue = retryResidue;
      usedDeclared = true;
    }
  }

  if (!usedDeclared) {
    // 검출 키가 선언 키의 크로마 패밀리 밖(어둡거나 무채색인 테두리 오독)인 경우:
    // 선언된 순수 키로도 한 번 해보고 더 깨끗한 쪽을 남긴다.
    const [, detectedCb, detectedCr] = rgbToYcc(detected[0], detected[1], detected[2]);
    const [, declaredCb, declaredCr] = rgbToYcc(declaredKey[0], declaredKey[1], declaredKey[2]);
    if (Math.hypot(detectedCb - declaredCb, detectedCr - declaredCr) > YCC_KEY_RESIDUE_DIST) {
      const { out: retry, frac: retryFrac } = matteYcc(source, width, height, declaredKey);
      if (retryFrac > 0.02 && keyResidueFractionYcc(retry, width, height, declaredKey) < residue) {
        note(`검출 키 [${detected}] 가 선언 키 패밀리 밖 — 선언 키 [${declaredKey}] 로 재매팅`);
        out = retry;
      }
    }
  }

  cleanupAlphaYcc(out, width, height);
  data.set(out);
}
