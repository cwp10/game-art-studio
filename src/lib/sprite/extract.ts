/**
 * 프레임 추출 — sprite_gen/extract.py 의 컴포넌트 경로 이식.
 *
 *   raw 스트립 (크로마 배경, 임의 치수)
 *     → removeChromaBackground        알파 생성 (chroma-clean.ts)
 *     → extractComponentImages        연결 컴포넌트로 frameCount 개 분리
 *     → fitToCell                     request 의 셀 규격에 맞춰 배치
 *     → frames[]                      셀 크기, 알파 있음
 *
 * **request 의 cell·safeMargin 은 추출의 출력 규격이다** — 입력 raw 의 치수와 무관하다.
 * 그래서 모델이 가이드 치수를 안 따라도 결과 프레임은 항상 요청 규격으로 나온다.
 *
 * 컴포넌트로 선언된 프레임 수를 못 찾으면 **행을 차단한다**. 그리드 등분
 * (`extractSlotFrames`)은 원본과 같이 **명시적 옵트인 디버깅용**이고 결과에
 * `slots-explicit` 로 표기된다 — 기본 경로가 아니다.
 *
 * 이식 범위에서 뺀 것(전부 원본에서도 옵트인): ycbcr 매팅, projection 세그먼테이션,
 * pixel_unfake, kcentroid 리샘플, alpha-centroid 정렬, takes.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import sharp from "sharp";
import { removeChromaBackground, type ChromaCleanOptions, type RGB } from "@/lib/sprite/chroma-clean";
import { decideChromaMode, type ChromaMode, type ChromaModeDecision } from "@/lib/sprite/chroma-mode";
import { removeChromaBackgroundYcbcr } from "@/lib/sprite/chroma-ycbcr";
import { inspectFrames, type FrameQaResult } from "@/lib/sprite/frame-qa";
import type { CellSpec, FitSpec } from "@/lib/sprite/request";
import {
  separateFusedPoses,
  type SegmentationMode,
  type SeparateResult,
} from "@/lib/sprite/segment";

export type RawImage = { data: Buffer; width: number; height: number };

export type Component = {
  pixels: number[];
  area: number;
  /** [x0, y0, x1, y1) — 오른쪽·아래는 배타적 (원본과 동일). */
  bbox: [number, number, number, number];
  centerX: number;
};

const ALPHA_FLOOR = 16;

/** 4-연결 연결 컴포넌트. 알파 > 16 인 픽셀만 본다. */
export function connectedComponents(img: RawImage): Component[] {
  const { data, width, height } = img;
  const n = width * height;
  const visited = new Uint8Array(n);
  const out: Component[] = [];

  for (let start = 0; start < n; start++) {
    if (data[start * 4 + 3] <= ALPHA_FLOOR || visited[start]) continue;
    visited[start] = 1;
    const stack = [start];
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length > 0) {
      const cur = stack.pop() as number;
      pixels.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      for (const nb of [cur - 1, cur + 1, cur - width, cur + width]) {
        if (nb < 0 || nb >= n || visited[nb]) continue;
        // 좌우 이웃이 행을 넘지 않게 — 원본의 abs(nx - x) > 1 가드와 같다.
        if (Math.abs((nb % width) - x) > 1) continue;
        if (data[nb * 4 + 3] > ALPHA_FLOOR) {
          visited[nb] = 1;
          stack.push(nb);
        }
      }
    }

    out.push({
      pixels,
      area: pixels.length,
      bbox: [minX, minY, maxX + 1, maxY + 1],
      centerX: (minX + maxX + 1) / 2,
    });
  }
  return out;
}

/** 컴포넌트 묶음을 자기 픽셀만 담은 새 이미지로 굽는다 (패딩 4px). */
export function componentGroupImage(
  source: RawImage,
  components: Component[],
  padding = 4,
): RawImage {
  const { width, height } = source;
  const minX = Math.max(0, Math.min(...components.map(c => c.bbox[0])) - padding);
  const minY = Math.max(0, Math.min(...components.map(c => c.bbox[1])) - padding);
  const maxX = Math.min(width, Math.max(...components.map(c => c.bbox[2])) + padding);
  const maxY = Math.min(height, Math.max(...components.map(c => c.bbox[3])) + padding);
  const w = maxX - minX;
  const h = maxY - minY;
  const out = Buffer.alloc(w * h * 4);
  for (const c of components) {
    for (const idx of c.pixels) {
      const x = idx % width;
      const y = (idx / width) | 0;
      const so = idx * 4;
      const to = ((y - minY) * w + (x - minX)) * 4;
      out[to] = source.data[so];
      out[to + 1] = source.data[so + 1];
      out[to + 2] = source.data[so + 2];
      out[to + 3] = source.data[so + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * 컴포넌트를 frameCount 개 그룹으로 나눈다. 못 나누면 null (= 행 차단).
 *
 * 시드 = 가장 큰 컴포넌트들. 나머지(위성)는 **x 거리로만 붙이지 않는다** — 멀리 떨어진
 * 파편(크로마 잔여물·분리된 이펙트)까지 병합되면 bbox 가 늘어나 프레임 바닥선과 크롭이
 * 흔들린다. 시드 bbox 를 살짝 넓힌 근접 영역과 겹치는 위성만 병합하고 나머지는 버린다.
 */
export function extractComponentImages(
  strip: RawImage,
  frameCount: number,
): { images: RawImage[]; dropped: number } | null {
  const components = connectedComponents(strip);
  if (components.length === 0) return null;

  const largestArea = Math.max(...components.map(c => c.area));
  const seedThreshold = Math.max(120, largestArea * 0.2);
  let seeds = components.filter(c => c.area >= seedThreshold);
  if (seeds.length < frameCount) {
    seeds = [...components].sort((a, b) => b.area - a.area).slice(0, frameCount);
  }
  if (seeds.length < frameCount) return null;

  seeds = [...seeds]
    .sort((a, b) => b.area - a.area)
    .slice(0, frameCount)
    .sort((a, b) => a.centerX - b.centerX);

  const seedSet = new Set(seeds);
  const groups: Component[][] = seeds.map(s => [s]);
  const noiseThreshold = Math.max(12, largestArea * 0.002);

  let dropped = 0;
  for (const c of components) {
    if (seedSet.has(c) || c.area < noiseThreshold) continue;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const d = Math.abs(seeds[i].centerX - c.centerX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    const [sx0, sy0, sx1, sy1] = seeds[nearest].bbox;
    const padX = Math.max(6, Math.round((sx1 - sx0) * 0.15));
    const padY = Math.max(6, Math.round((sy1 - sy0) * 0.15));
    const [cx0, cy0, cx1, cy1] = c.bbox;
    if (cx0 < sx1 + padX && cx1 > sx0 - padX && cy0 < sy1 + padY && cy1 > sy0 - padY) {
      groups[nearest].push(c);
    } else {
      dropped++;
    }
  }

  return { images: groups.map(g => componentGroupImage(strip, g)), dropped };
}

/** 알파 > 0 인 영역의 bbox. 없으면 null. */
function alphaBBox(img: RawImage): [number, number, number, number] | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1];
}

function cropRaw(img: RawImage, box: [number, number, number, number]): RawImage {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * img.width + x0) * 4;
    img.data.copy(out, y * w * 4, src, src + w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * 알파 가중 가로 무게중심. `bottomFraction` 이 1 미만이면 아래쪽 그만큼만 본다 —
 * 기본 정렬(foot-centroid)이 하위 20% 알파(다리)에 앵커를 두어, 끌리는 머리카락·망토가
 * 몸통을 셀 축에서 밀어내지 않게 한다(런타임 좌우 반전에 결정적).
 */
export function alphaCentroidX(img: RawImage, bottomFraction = 1.0, minAlpha = 0): number {
  const yStart = Math.max(0, img.height - Math.max(2, Math.round(img.height * bottomFraction)));
  let total = 0;
  let weighted = 0;
  for (let y = yStart; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      if (a > minAlpha) {
        total += a;
        weighted += a * (x + 0.5);
      }
    }
  }
  if (total === 0 && bottomFraction < 1.0) return alphaCentroidX(img, 1.0, minAlpha);
  return total > 0 ? weighted / total : img.width / 2;
}

/**
 * 컴포넌트 이미지를 셀 규격에 맞춰 배치한다.
 *
 * 기본값은 원본과 같다: resample=lanczos, align_x=foot-centroid, align_y=bottom.
 * (2026-07-04 알렉스: 프레임 간 "무게감"(발밑 기준선)이 기본으로 잡혀야 한다.)
 * kcentroid·alpha-centroid·center 는 옵트인이라 이식 범위 밖이다.
 */
export async function fitToCell(img: RawImage, cell: CellSpec): Promise<RawImage> {
  const target = Buffer.alloc(cell.width * cell.height * 4);
  const box = alphaBBox(img);
  if (!box) return { data: target, width: cell.width, height: cell.height };

  let sprite = cropRaw(img, box);
  const maxWidth = Math.max(1, cell.width - cell.safeMarginX * 2);
  const maxHeight = Math.max(1, cell.height - cell.safeMarginY * 2);
  const scale = Math.min(maxWidth / sprite.width, maxHeight / sprite.height, 1.0);
  if (scale !== 1.0) {
    const nw = Math.max(1, Math.round(sprite.width * scale));
    const nh = Math.max(1, Math.round(sprite.height * scale));
    const resized = await sharp(sprite.data, {
      raw: { width: sprite.width, height: sprite.height, channels: 4 },
    })
      .resize(nw, nh, { kernel: "lanczos3", fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    sprite = { data: resized.data, width: resized.info.width, height: resized.info.height };
    const recrop = alphaBBox(sprite);
    if (recrop) sprite = cropRaw(sprite, recrop);
  }

  let left = Math.round(cell.width / 2 - alphaCentroidX(sprite, 0.2));
  left = Math.max(0, Math.min(cell.width - sprite.width, left));
  const top = Math.max(0, cell.height - cell.safeMarginY - sprite.height);

  for (let y = 0; y < sprite.height; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= cell.height) continue;
    for (let x = 0; x < sprite.width; x++) {
      const tx = left + x;
      if (tx < 0 || tx >= cell.width) continue;
      const so = (y * sprite.width + x) * 4;
      const a = sprite.data[so + 3];
      if (a === 0) continue;
      const to = (ty * cell.width + tx) * 4;
      target[to] = sprite.data[so];
      target[to + 1] = sprite.data[so + 1];
      target[to + 2] = sprite.data[so + 2];
      target[to + 3] = a;
    }
  }
  return { data: target, width: cell.width, height: cell.height };
}

/** 그리드 등분 — **명시적 옵트인 디버깅용**. 기본 경로가 아니다. */
export async function extractSlotFrames(
  strip: RawImage,
  frameCount: number,
  cell: CellSpec,
): Promise<RawImage[]> {
  const slotWidth = strip.width / frameCount;
  const frames: RawImage[] = [];
  for (let i = 0; i < frameCount; i++) {
    const left = Math.round(i * slotWidth);
    const right = Math.round((i + 1) * slotWidth);
    frames.push(await fitToCell(cropRaw(strip, [left, 0, right, strip.height]), cell));
  }
  return frames;
}

export class ExtractionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailed";
  }
}

export type ExtractResult = {
  frames: RawImage[];
  method: "components" | "slots-explicit";
  dropped: number;
  /** 어느 크로마 경로를 탔는지와 그 근거. `chromaMode: "auto"` 일 때만 채워진다. */
  chroma?: ChromaModeDecision;
  /** ycbcr 자가 진단이 선언 키로 재매팅했을 때의 사유. 조용한 폴백은 없다. */
  chromaWarnings?: string[];
  /** 프레임별 QA (정본 `inspect_frames`) — 에러는 행을 차단한다. */
  frameQa?: FrameQaResult;
  /**
   * 투영 분리 결과. **옵트인이 켜졌을 때만** 채워진다. `applied: false` 인데 note 가
   * 있으면 분리가 기대 개수를 못 내 스트립을 건드리지 않았다는 뜻이다.
   */
  segmentation?: SeparateResult;
};

/**
 * raw 시트 파일 → 셀 규격 프레임들.
 *
 * 컴포넌트로 frameCount 개를 못 찾으면 throw 한다 — 원본의 행 차단과 같다.
 * `allowSlotFallback` 은 디버깅용이며 켜면 `method: "slots-explicit"` 로 표기된다.
 */
export async function extractRowFrames(opts: {
  sheetPath: string;
  frameCount: number;
  cell: CellSpec;
  chromaKey: RGB;
  chroma?: ChromaCleanOptions;
  /**
   * 알파 생성 경로. 정본과 같이 기본은 `"rgb"` 다 — ycbcr 은 깨끗한 평면 키에서
   * 소프트 엣지에 옅은 헤일로를 남기므로 일반적인 업그레이드가 아니다.
   * `"auto"` 는 배경을 재서 rgb 하드컷이 통하지 않을 때만 ycbcr 로 간다.
   */
  chromaMode?: ChromaMode | "auto";
  allowSlotFallback?: boolean;
  /** 프레임 QA 에러로 차단하지 않는다 — 진단용. 경고·기록은 그대로 돌려준다. */
  allowFrameQaErrors?: boolean;
  /** 분리 모드의 SSoT (`fit.segmentation`). 없으면 `"components"` 다. */
  fit?: FitSpec;
  /** 명시 override — CLI·진단용. 주면 `fit` 을 덮는다. */
  segmentation?: SegmentationMode;
  /** 분리 보고에 붙는 이름 (보통 상태명). */
  label?: string;
}): Promise<ExtractResult> {
  const { data, info } = await sharp(opts.sheetPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new ExtractionFailed(`extractRowFrames: RGBA 가 아니다 (channels=${info.channels})`);
  }

  const requested = opts.chromaMode ?? "rgb";
  const decision =
    requested === "auto"
      ? decideChromaMode(data, info.width, info.height, opts.chromaKey, opts.chroma?.keyThreshold)
      : null;
  const mode: ChromaMode = decision ? decision.mode : (requested as ChromaMode);
  const chromaWarnings: string[] = [];
  if (mode === "ycbcr") {
    removeChromaBackgroundYcbcr(data, info.width, info.height, opts.chromaKey, chromaWarnings);
  } else {
    removeChromaBackground(data, info.width, info.height, opts.chromaKey, opts.chroma);
  }
  let strip: RawImage = { data, width: info.width, height: info.height };

  // 융착 포즈 분리 — 옵트인이고 기본은 꺼져 있다. 켜져 있을 때만 스트립을 갈라
  // 거터를 넣어 재조립하고, 기대 개수를 못 내면 **건드리지 않고** 사유만 남긴다.
  // 하류 연결요소 추출이 기존 에러로 관측 가능하게 실패하게 두는 것이다.
  const separated = separateFusedPoses(strip, opts.frameCount, {
    fit: opts.fit,
    override: opts.segmentation,
    label: opts.label,
  });
  if (separated.applied) {
    const s = separated.strip;
    // segment 는 Uint8Array 로 짓는다. 새로 할당한 버퍼라 복사 없이 뷰만 씌운다.
    strip = {
      data: Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength),
      width: s.width,
      height: s.height,
    };
  }

  const extra = {
    ...(decision ? { chroma: decision } : {}),
    ...(chromaWarnings.length > 0 ? { chromaWarnings } : {}),
    ...(separated.note ? { segmentation: separated } : {}),
  };

  const grouped = extractComponentImages(strip, opts.frameCount);
  if (grouped) {
    const frames: RawImage[] = [];
    for (const image of grouped.images) frames.push(await fitToCell(image, opts.cell));
    // 프레임별 QA — 정본은 여기서 멈춘다. 에러(빈 프레임·크로마 잔류)는 그 행을
    // 그대로 쓰면 안 된다는 뜻이고, 폐루프(inspect/score)는 이 뒤의 관계 신호라
    // 프레임 하나가 뭉개진 것을 못 잡는다(실측: 그런 시트가 100점을 받았다).
    const frameQa = inspectFrames(frames, opts.chromaKey);
    if (frameQa.errors.length > 0 && !opts.allowFrameQaErrors) {
      throw new ExtractionFailed(frameQa.errors.join("; "));
    }
    return { frames, method: "components", dropped: grouped.dropped, frameQa, ...extra };
  }

  if (!opts.allowSlotFallback) {
    throw new ExtractionFailed(
      `could not extract ${opts.frameCount} sprite components`,
    );
  }
  return {
    frames: await extractSlotFrames(strip, opts.frameCount, opts.cell),
    method: "slots-explicit",
    dropped: 0,
    ...extra,
  };
}

/** RawImage 를 PNG 파일로. */
export async function writeRaw(img: RawImage, destPath: string): Promise<void> {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(destPath);
}
