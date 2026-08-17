// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen 픽셀 언페이크 ③단계 이식 — 격자 단위 dominant-color 스냅 다운스케일.
// 원본: sprite-gen/sprite_gen/extract.py:1548-1760 (Apache-2.0)

/**
 * 검출한 격자로 **진짜 해상도를 복원한다.**
 *
 * 셀마다 지배색 하나를 뽑아 논리 픽셀 한 칸으로 접는다. 비정수 리샘플이 한 번도 없어
 * 픽셀이 깨지지 않는다 — 이게 일반 다운스케일과 다른 점이다.
 *
 * ## 등간격으로 자르면 안 된다
 *
 * AI 블록은 국소적으로 흔들려서 등간격 절단은 경계 조각을 옆 칸으로 흘린다(실사고: 눈
 * 아래 유령 픽셀, 발밑 1픽셀 — 같은 뿌리). 각 내부 절단선을 ±pitch/3 창 안의 색경계
 * 질량 최대 위치로 옮긴다.
 *
 * ## 슬리버 가드
 *
 * 최소 칸폭은 절대 2px 가 아니라 **피치 비례(≥0.6×pitch)** 다. 절대 2px 는 피치 13px
 * 소재에서 0.15셀짜리 슬리버 쌍을 허용했고, 인접 절단선 둘이 서로를 향해 당기면 출력 두
 * 행이 소스의 거의 같은 밴드를 이중 샘플링했다 — 턱 늘어남과 눈물점 실사고가 이 한
 * 기전이다.
 */

import { gridEdges, type Pitch, type Phase, type RawImage } from "@/lib/sprite/pixel-grid";

type RGB = [number, number, number];

/** 이 경로 전역의 불투명 판정 — 검출·스냅·팔레트가 같은 기준을 써야 한다. */
const ALPHA_SOLID = 128;

/**
 * 셀의 지배색 — 2-means(3회 반복) 후 다수 클러스터의 정수 평균.
 *
 * 부동소수를 쓰지 않는다: 제곱거리와 `합 // 개수` 만으로 돈다. `detailBias` 는 눈·아웃라인
 * 같은 **어두운 소수 디테일**을 지키는 장치다 — 두 클러스터의 명도차가 크고 어두운 쪽
 * 점유율이 40% 이상이면 다수결 대신 어두운 클러스터를 택한다.
 */
export function dominantBlockColor(opaque: RGB[], detailBias = false): RGB {
  if (opaque.length === 1) return [opaque[0][0], opaque[0][1], opaque[0][2]];
  const luma = (p: RGB): number => p[0] * 299 + p[1] * 587 + p[2] * 114;

  // `min`/`max` 는 동점이면 **첫 번째**를 남긴다 (파이썬과 같은 순회 순서).
  let lo = opaque[0];
  let hi = opaque[0];
  let loL = luma(lo);
  let hiL = loL;
  for (let i = 1; i < opaque.length; i++) {
    const l = luma(opaque[i]);
    if (l < loL) { lo = opaque[i]; loL = l; }
    if (l > hiL) { hi = opaque[i]; hiL = l; }
  }
  const centroids: RGB[] = [[lo[0], lo[1], lo[2]], [hi[0], hi[1], hi[2]]];
  const assign = new Uint8Array(opaque.length);

  for (let iter = 0; iter < 3; iter++) {
    const [c00, c01, c02] = centroids[0];
    const [c10, c11, c12] = centroids[1];
    for (let i = 0; i < opaque.length; i++) {
      const [p0, p1, p2] = opaque[i];
      const d0 = (p0 - c00) ** 2 + (p1 - c01) ** 2 + (p2 - c02) ** 2;
      const d1 = (p0 - c10) ** 2 + (p1 - c11) ** 2 + (p2 - c12) ** 2;
      assign[i] = d0 <= d1 ? 0 : 1;
    }
    for (const cluster of [0, 1] as const) {
      let s0 = 0, s1 = 0, s2 = 0, cnt = 0;
      for (let i = 0; i < opaque.length; i++) {
        if (assign[i] !== cluster) continue;
        s0 += opaque[i][0]; s1 += opaque[i][1]; s2 += opaque[i][2]; cnt++;
      }
      if (cnt) {
        centroids[cluster] = [Math.floor(s0 / cnt), Math.floor(s1 / cnt), Math.floor(s2 / cnt)];
      }
    }
  }

  let c0 = 0;
  for (let i = 0; i < assign.length; i++) if (assign[i] === 0) c0++;
  const c1 = assign.length - c0;
  let dominant = c0 >= c1 ? 0 : 1;
  if (detailBias) {
    const darker = luma(centroids[0]) <= luma(centroids[1]) ? 0 : 1;
    const share = (darker === 0 ? c0 : c1) / assign.length;
    if (
      darker !== dominant &&
      share >= 0.4 &&
      luma(centroids[darker]) < 70000 &&
      luma(centroids[1 - darker]) - luma(centroids[darker]) > 50000
    ) {
      dominant = darker;
    }
  }
  let m0 = 0, m1 = 0, m2 = 0, mc = 0;
  for (let i = 0; i < opaque.length; i++) {
    if (assign[i] !== dominant) continue;
    m0 += opaque[i][0]; m1 += opaque[i][1]; m2 += opaque[i][2]; mc++;
  }
  return [Math.floor(m0 / mc), Math.floor(m1 / mc), Math.floor(m2 / mc)];
}

/** 축별 색/알파 경계 질량 프로파일 — 절단선 스냅의 증거. */
export function boundaryMass(img: RawImage): { col: number[]; row: number[] } {
  const { data, width: w, height: h } = img;
  const col = new Array<number>(Math.max(1, w)).fill(0);
  const row = new Array<number>(Math.max(1, h)).fill(0);
  const isEdge = (a: number, b: number): boolean => {
    const aa = data[a + 3] >= ALPHA_SOLID;
    const bb = data[b + 3] >= ALPHA_SOLID;
    if (aa !== bb) return true;
    if (!aa || !bb) return false;
    return (
      Math.abs(data[a] - data[b]) +
        Math.abs(data[a + 1] - data[b + 1]) +
        Math.abs(data[a + 2] - data[b + 2]) >
      48
    );
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      if (isEdge((y * w + x) * 4, (y * w + x + 1) * 4)) col[x + 1]++;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h - 1; y++) {
      if (isEdge((y * w + x) * 4, ((y + 1) * w + x) * 4)) row[y + 1]++;
    }
  }
  return { col, row };
}

/**
 * 등간격 절단선을 실제 블록 경계로 스냅한다.
 *
 * 질량이 무의미하면(평탄 영역) 등간격 위치를 유지한다. 단조 증가와 최소 칸폭
 * (`0.6×pitch`)을 강제하고, 위반이 생기면 그 축을 통째로 등간격으로 되돌린다.
 */
export function refineEdgesToBoundaries(
  component: RawImage,
  xEdges: number[],
  yEdges: number[],
  pitch: Pitch,
): { xs: number[]; ys: number[] } {
  const { col, row } = boundaryMass(component);

  const snap = (edges: number[], mass: number[], pitchAxis: number, limit: number): number[] => {
    if (edges.length < 3) return edges;
    const out = [...edges];
    const window = Math.max(1, Math.trunc(pitchAxis / 3));
    const minGap = Math.max(2, pyRound(pitchAxis * 0.6));
    for (let i = 1; i < out.length - 1; i++) {
      const e = edges[i];
      const lo = Math.max(out[i - 1] + minGap, e - window);
      const hi = Math.min(edges[i + 1] - minGap, e + window, limit - 1);
      if (hi < lo) continue;
      // `max(range(...))` 는 동점이면 **첫 번째(가장 작은 pos)** 를 남긴다.
      let best = lo;
      let bestMass = lo < mass.length ? mass[lo] : 0;
      for (let pos = lo + 1; pos <= hi; pos++) {
        const m = pos < mass.length ? mass[pos] : 0;
        if (m > bestMass) { bestMass = m; best = pos; }
      }
      if (bestMass > 0) out[i] = best;
    }
    for (let i = 1; i < out.length; i++) {
      // 스냅 순서상 위반 불가지만 방어적으로 단정한다 — 위반 시 등간격 유지.
      if (out[i] <= out[i - 1]) return [...edges];
    }
    return out;
  };

  return {
    xs: snap(xEdges, col, pitch[0], component.width),
    ys: snap(yEdges, row, pitch[1], component.height),
  };
}

/**
 * 명시 절단선으로 블록 샘플링 — 스냅 다운스케일의 코어(비등간격 지원).
 *
 * 셀의 **절반 이상**이 불투명해야 픽셀을 찍는다. 그 미만이면 투명으로 남긴다 —
 * 프린지뿐인 가장자리 셀이 실루엣 밖 부스러기로 굳는 것을 막는 규칙이다.
 */
export function snapByEdges(
  image: RawImage,
  xEdges: number[],
  yEdges: number[],
  detailBias = false,
): RawImage {
  const { data, width: w } = image;
  const outW = xEdges.length - 1;
  const outH = yEdges.length - 1;
  const out: RawImage = { data: new Uint8Array(outW * outH * 4), width: outW, height: outH };
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let total = 0;
      const opaque: RGB[] = [];
      for (let y = yEdges[oy]; y < yEdges[oy + 1]; y++) {
        for (let x = xEdges[ox]; x < xEdges[ox + 1]; x++) {
          total++;
          const s = (y * w + x) * 4;
          if (data[s + 3] >= ALPHA_SOLID) opaque.push([data[s], data[s + 1], data[s + 2]]);
        }
      }
      if (opaque.length * 2 < total) continue;
      const c = dominantBlockColor(opaque, detailBias);
      const d = (oy * outW + ox) * 4;
      out.data[d] = c[0];
      out.data[d + 1] = c[1];
      out.data[d + 2] = c[2];
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/**
 * 격자 스냅 다운스케일 — 소수 피치·위상을 받아 격자선만 정수로 확정한다.
 *
 * 정수 피치 + 정수 위상을 주면 예전 경계와 같은 결과가 나온다(골든 회귀 없음).
 */
export function gridSnapDownscale(
  image: RawImage,
  pitch: Pitch,
  detailBias = false,
  phase: Phase = [0, 0],
): RawImage {
  const xs = gridEdges(image.width, pitch[0], phase[0]);
  const ys = gridEdges(image.height, pitch[1], phase[1]);
  return snapByEdges(image, xs, ys, detailBias);
}

/** 파이썬 `round()` — 은행가 반올림. 최소 칸폭 계산이 이 규칙 위에 선다. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * kCentroid 스타일 픽셀아트 다운스케일 — 출력 픽셀마다 소스 블록의 **지배 클러스터
 * 중심색**을 취한다.
 *
 * 어두운 1px 아웃라인이 살아남는다: LANCZOS 는 평균에 먹혀 흐려지고, NEAREST 는 타깃
 * 격자가 원본 픽셀 격자와 안 맞을 때 임의 샘플이 되어 아웃라인을 통째로 떨군다.
 *
 * 논리 프레임이 셀 규격을 넘을 때만 쓰인다 — 정본도 "계약으로의 conform 축소는 칸을
 * 병합해 디테일을 갈아먹는다" 며 경계하고 **물리 한계에서만** 건다.
 */
export function kcentroidDownscale(
  sprite: RawImage,
  targetWidth: number,
  targetHeight: number,
  detailBias = false,
): RawImage {
  const { data, width: sw, height: sh } = sprite;
  const out: RawImage = {
    data: new Uint8Array(targetWidth * targetHeight * 4),
    width: targetWidth,
    height: targetHeight,
  };
  for (let oy = 0; oy < targetHeight; oy++) {
    const y0 = Math.floor((oy * sh) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * sh) / targetHeight));
    for (let ox = 0; ox < targetWidth; ox++) {
      const x0 = Math.floor((ox * sw) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * sw) / targetWidth));
      let total = 0;
      const opaque: RGB[] = [];
      let alphaSum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          const s = (y * sw + x) * 4;
          if (data[s + 3] >= ALPHA_SOLID) {
            opaque.push([data[s], data[s + 1], data[s + 2]]);
            alphaSum += data[s + 3];
          }
        }
      }
      // 블록의 절반 이상이 불투명해야 찍는다 (스냅 다운스케일과 같은 규칙).
      if (opaque.length * 2 < total) continue;
      const d = (oy * targetWidth + ox) * 4;
      if (opaque.length === 1) {
        out.data[d] = opaque[0][0];
        out.data[d + 1] = opaque[0][1];
        out.data[d + 2] = opaque[0][2];
        out.data[d + 3] = alphaSum;
        continue;
      }
      const c = dominantBlockColor(opaque, detailBias);
      out.data[d] = c[0];
      out.data[d + 1] = c[1];
      out.data[d + 2] = c[2];
      out.data[d + 3] = Math.floor(alphaSum / opaque.length);
    }
  }
  return out;
}
