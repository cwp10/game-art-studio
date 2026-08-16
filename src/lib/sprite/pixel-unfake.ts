// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen 픽셀 언페이크 ⑥단계 이식 — 스트립 → 논리 프레임 → 셀 배치.
// 원본: sprite-gen/sprite_gen/extract.py (_snap_strip, fit_pixel_unfake,
//       conform_row_logical, binarize_alpha), curation.py (pixel_snap_scale) — Apache-2.0

/**
 * 격자 검출(①②)과 스냅(③)을 실제 추출 경로로 엮는다.
 *
 * ## 프레임 자체 검출이 1순위 진실이다
 *
 * 합의 피치를 프레임에 강제하면 측정차(0.5px/셀 수준)가 폭 전체에 누적돼 셀 경계가
 * 블록 중앙을 지난다(실사고: 합의 13.00 vs 자체 12.50 → 눈이 반쪽). 그래서 프레임마다
 * 자기 검출값으로 스냅하되, **합의 '피치 패밀리'(1.1) 이내에서만** 채택한다 —
 * 하모닉/붕괴 오검출(×2·÷3)까지 믿으면 한 프레임의 거대 논리 해상도가 행 일관 배율을
 * 끌어내려 행 전체가 붕괴한다.
 *
 * 합의는 검출이 실패한 프레임의 폴백이기도 하다. 합의 계산에서 **붕괴한 프레임**
 * (최대값의 60% 미만)은 버린다 — 6프레임 중 절반이 3.00 으로 무너져 합의가 5.00 이 된
 * 실사고가 있다.
 *
 * ## 이식하지 않은 것
 *
 * - **runlen 세컨드 오피니언**(`estimate_pixel_grid_runlen` + `arbitrate_pitch`):
 *   정본에서도 **경고 전용**이고 채택은 언제나 detect 고정이다. 스냅 결과가 달라지지
 *   않으므로 뺐다.
 * - **런 전체 공유 팔레트**: 정본은 배치의 모든 행이 팔레트 하나를 나눠 써 프레임 간
 *   색 흔들림을 없앤다. 우리는 행이 독립 generation 이라 "런 전체" 라는 단위가 없다.
 * - **kCentroid 축소**: 논리 프레임이 셀보다 클 때만 쓰인다. 그 경로에 들어가면 조용히
 *   다른 알고리즘으로 축소하지 않고 **던진다**.
 */

import {
  detectPixelGrid,
  bestPhase,
  gridEdges,
  resolveFramePitch,
  type Pitch,
} from "@/lib/sprite/pixel-grid";
import { refineEdgesToBoundaries, snapByEdges } from "@/lib/sprite/pixel-snap";
import type { CellSpec, SpriteRequest } from "@/lib/sprite/request";

export type RawImage = { data: Buffer; width: number; height: number };

export class PixelUnfakeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PixelUnfakeFailed";
  }
}

/**
 * 논리 격자 배율 (셀 px 당 논리 px). `fit.pixel_unfake` 가 꺼져 있으면 `null`.
 *
 * 배율이 정수라 셀 높이의 약수가 아닌 `logical_height` 는 선언대로 적용될 수 없다 —
 * 셀 64 에 48 을 선언하면 `64//48 = 1` 이라 논리 높이가 64 로 되돌아간다. 호출자는
 * 선언값이 아니라 `effectiveLogicalHeight` 를 봐야 한다.
 */
export function pixelSnapScale(request: SpriteRequest): number | null {
  if (!request.fit?.pixel_unfake) return null;
  const cellHeight = request.cell.height;
  const marginY = request.cell.safeMarginY;
  const usableHeight = Math.max(1, cellHeight - marginY * 2);
  const logicalHeight = request.fit.logical_height ?? cellHeight;
  let scale = Math.max(1, Math.floor(cellHeight / Math.max(1, logicalHeight)));
  if (logicalHeight * scale > cellHeight) {
    scale = Math.max(1, Math.floor(usableHeight / Math.max(1, logicalHeight)));
  }
  return scale;
}

/** 엔진이 **실제로** 쓰는 논리 높이 = 셀 높이 / 파생 배율. 선언값이 아니다. */
export function effectiveLogicalHeight(request: SpriteRequest): number | null {
  const scale = pixelSnapScale(request);
  if (scale === null) return null;
  return Math.max(1, Math.floor(request.cell.height / scale));
}

/** 알파 이진화 — 128 미만은 완전 투명, 그 이상은 완전 불투명. */
export function binarizeAlpha(img: RawImage): RawImage {
  const out = Buffer.from(img.data);
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * 4;
    if (out[i + 3] < 128) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    } else if (out[i + 3] !== 255) {
      out[i + 3] = 255;
    }
  }
  return { data: out, width: img.width, height: img.height };
}

/** 알파 > 0 인 영역의 bbox (PIL `getbbox()` — Pillow 10+ 는 RGBA 에서 알파만 본다). */
function alphaBBox(img: RawImage): [number, number, number, number] | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

function cropRaw(img: RawImage, box: [number, number, number, number]): RawImage {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    img.data.copy(out, y * w * 4, s, s + w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * 행 단위 크기 통일 — 논리 프레임을 모두 콘텐츠 bbox 로 조이고 알파를 이진화한다.
 *
 * 정본은 행 최대 프레임이 논리 규격을 넘으면 kCentroid 로 한 배율에 맞춰 줄인다.
 * 그 축소기는 이식하지 않았으므로 **그 경로에서는 던진다** — 다른 알고리즘으로 조용히
 * 줄이면 정본과 다른 그림이 나온다.
 */
export function conformRowLogical(
  images: RawImage[],
  logicalWidth: number,
  logicalHeight: number,
): RawImage[] {
  const snapped = images.map(im => {
    const box = alphaBBox(im);
    return box ? cropRaw(im, box) : im;
  });
  const maxW = Math.max(...snapped.map(s => s.width));
  const maxH = Math.max(...snapped.map(s => s.height));
  if (maxW > logicalWidth || maxH > logicalHeight) {
    throw new PixelUnfakeFailed(
      `pixel-unfake: 논리 프레임 ${maxW}x${maxH} 이 규격 ${logicalWidth}x${logicalHeight} 을 넘습니다 — ` +
        `정본은 kCentroid 로 줄이지만 그 축소기는 이식하지 않았습니다. ` +
        `fit.logical_height 를 올리거나 셀을 키우세요.`,
    );
  }
  return snapped.map(binarizeAlpha);
}

/**
 * 논리 프레임을 셀에 **정수배 NEAREST** 로 앉힌다.
 *
 * 콘텐츠 bbox 로 먼저 크롭한다 — 투명 패딩째 바닥에 붙이면 패딩만큼 프레임마다 발이
 * 떠서 바닥선("무게감")이 흔들린다. 가로 배치는 논리 격자에 스냅해(`left -= left % scale`)
 * 좌우 반전 대칭을 지킨다.
 */
export function fitPixelUnfake(
  logical: RawImage,
  cell: CellSpec,
  scale: number,
  alphaCentroidX: (img: RawImage, bottomFraction?: number, minAlpha?: number) => number,
  alignX = "foot-centroid",
  alignY = "bottom",
): RawImage {
  const target: RawImage = {
    data: Buffer.alloc(cell.width * cell.height * 4),
    width: cell.width,
    height: cell.height,
  };
  const bbox = alphaBBox(logical);
  if (!bbox) return target;
  const cropped = cropRaw(logical, bbox);

  // 정수배 NEAREST — 비정수 리샘플이 없어야 픽셀이 깨지지 않는다.
  const sw = cropped.width * scale;
  const sh = cropped.height * scale;
  const sprite: RawImage = { data: Buffer.alloc(sw * sh * 4), width: sw, height: sh };
  for (let y = 0; y < sh; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < sw; x++) {
      const sx = Math.floor(x / scale);
      const s = (sy * cropped.width + sx) * 4;
      const d = (y * sw + x) * 4;
      sprite.data[d] = cropped.data[s];
      sprite.data[d + 1] = cropped.data[s + 1];
      sprite.data[d + 2] = cropped.data[s + 2];
      sprite.data[d + 3] = cropped.data[s + 3];
    }
  }

  let left: number;
  if (alignX === "foot-centroid") left = pyRound(cell.width / 2.0 - alphaCentroidX(sprite, 0.2));
  else if (alignX === "centroid") left = pyRound(cell.width / 2.0 - alphaCentroidX(sprite));
  else left = Math.floor((cell.width - sprite.width) / 2);
  left = Math.max(0, Math.min(cell.width - sprite.width, left));
  left -= left % scale; // 논리 픽셀 격자에 스냅 (짝수 배치로 flip 대칭 보존)

  const top =
    alignY === "bottom"
      ? Math.max(0, cell.height - cell.safeMarginY - sprite.height)
      : Math.floor((cell.height - sprite.height) / 2);

  for (let y = 0; y < sprite.height; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= target.height) continue;
    for (let x = 0; x < sprite.width; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= target.width) continue;
      const s = (y * sprite.width + x) * 4;
      if (sprite.data[s + 3] === 0) continue;
      const d = (dy * target.width + dx) * 4;
      target.data[d] = sprite.data[s];
      target.data[d + 1] = sprite.data[s + 1];
      target.data[d + 2] = sprite.data[s + 2];
      target.data[d + 3] = sprite.data[s + 3];
    }
  }
  return target;
}

export type SnapReport = {
  /** 프레임별로 실제 스냅에 쓴 피치. `[1,1]` 이면 그 프레임은 스냅하지 않았다. */
  pitches: Pitch[];
  consensus: Pitch;
  warnings: string[];
};

/**
 * 컴포넌트들을 격자 스냅해 논리 프레임으로 바꾼다.
 *
 * 합의 피치는 **검출 실패 프레임의 폴백**이자 하모닉 오검출의 가드다. 붕괴한 프레임
 * (최대값의 60% 미만)은 합의 계산에서 버린다.
 */
export function snapComponents(
  components: RawImage[],
  strip: RawImage,
  detailBias: boolean,
  tag: string,
): { frames: RawImage[]; report: SnapReport } {
  const warnings: string[] = [];
  const toGridImage = (im: RawImage) => ({
    data: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength),
    width: im.width,
    height: im.height,
  });
  const grids = components.map(c => detectPixelGrid(toGridImage(c)));

  const consensusAxis = (axis: 0 | 1): number => {
    const confident = grids.map(g => g.pitch[axis]).filter(p => p >= 2.0).sort((a, b) => a - b);
    if (confident.length > 0) {
      // 붕괴한 프레임(참 피치의 약수로 떨어진 값)이 중앙값을 오염시킨다.
      const ceiling = confident[confident.length - 1];
      const trusted = confident.filter(p => p >= ceiling * 0.6);
      const dropped = confident.length - trusted.length;
      if (dropped) {
        warnings.push(
          `${tag}: dropped ${dropped} collapsed per-frame pitch(es) below ${(ceiling * 0.6).toFixed(2)}`,
        );
      }
      return trusted[Math.floor(trusted.length / 2)];
    }
    const stripGrid = detectPixelGrid(toGridImage(strip));
    if (stripGrid.pitch[axis] >= 2.0) {
      warnings.push(`${tag}: pitch from whole-strip detection=${stripGrid.pitch[axis].toFixed(2)}`);
    }
    return stripGrid.pitch[axis];
  };
  const consensus: Pitch = [consensusAxis(0), consensusAxis(1)];

  const frames: RawImage[] = [];
  const pitches: Pitch[] = [];
  components.forEach((component, index) => {
    const own = grids[index].pitch;
    let use: Pitch;
    if (Math.min(own[0], own[1]) >= 2.0) {
      const [resolved, outlier] = resolveFramePitch(own, consensus);
      if (outlier) {
        warnings.push(
          `${tag}: frame ${index} own pitch ${own[0].toFixed(2)}x${own[1].toFixed(2)} is outside the ` +
            `consensus pitch family ${consensus[0].toFixed(2)}x${consensus[1].toFixed(2)} — ` +
            `harmonic/collapsed misdetection; snapped at consensus`,
        );
      }
      use = resolved;
    } else if (Math.min(consensus[0], consensus[1]) >= 2.0) {
      use = consensus;
      warnings.push(
        `${tag}: frame ${index} pitch detection inconclusive — consensus fallback ` +
          `${consensus[0].toFixed(2)}x${consensus[1].toFixed(2)}`,
      );
    } else {
      // 격자 확신이 없으면 **스냅하지 않는다** — 조용히 근사하지 않는다.
      frames.push(component);
      pitches.push([1.0, 1.0]);
      return;
    }
    const gi = toGridImage(component);
    // 위상은 히스토그램 값이 아니라 셀 균일도로 다시 고른다 (반 칸 밀림 방어).
    const phase = bestPhase(gi, use);
    const xs = gridEdges(component.width, use[0], phase[0]);
    const ys = gridEdges(component.height, use[1], phase[1]);
    const refined = refineEdgesToBoundaries(gi, xs, ys, use);
    const snapped = snapByEdges(gi, refined.xs, refined.ys, detailBias);
    frames.push({
      data: Buffer.from(snapped.data.buffer, snapped.data.byteOffset, snapped.data.byteLength),
      width: snapped.width,
      height: snapped.height,
    });
    pitches.push(use);
  });

  return { frames, report: { pitches, consensus, warnings } };
}

/** 파이썬 `round()` — 은행가 반올림. 셀 배치가 이 규칙 위에 선다. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * request 에서 추출용 픽셀 언페이크 옵션을 파생한다 — **배율 식의 소유자는 여기 하나다.**
 *
 * 소비자(추출·재합성·앵커 재추출)가 손으로 다시 유도하면 갈린다. 정본도 같은 이유로
 * `pixel_snap_scale` 한 곳에 두고 extract·웹뷰·compose 가 전부 그것을 부른다.
 *
 * 꺼져 있으면 `{}` 라 스프레드해도 아무것도 안 붙는다.
 */
export function pixelUnfakeOptions(request: SpriteRequest): {
  pixelUnfake?: { scale: number; logicalWidth: number; logicalHeight: number; detailBias: boolean };
} {
  const scale = pixelSnapScale(request);
  if (scale === null) return {};
  const logicalHeight = effectiveLogicalHeight(request);
  if (logicalHeight === null) return {};
  return {
    pixelUnfake: {
      scale,
      logicalWidth: Math.max(1, Math.floor(request.cell.width / scale)),
      logicalHeight,
      detailBias: request.fit?.detail_bias ?? true,
    },
  };
}
