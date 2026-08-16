/**
 * 크로마 키 자동 선택 — sprite_gen/prepare.py 의 소재 샘플링과 후보 점수화 이식.
 *
 * 목적은 전체의 1% 미만인 작지만 결정적인 특징(눈, 보석, 귀 램프)이 추출 시점에
 * **조용히 삭제되지 않게** 하는 것이다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import sharp from "sharp";
import { colorDistance, detectBackgroundMode, type BackgroundInfo } from "@/lib/sprite/base-gate";
import type { ChromaKeySpec } from "@/lib/sprite/request";

/**
 * NEAREST 로 샘플링한다 — 이웃을 평균내는 필터는 베이스에 없던 색을 만들어내고,
 * 그 색은 전부 크로마 배경과 소재 사이의 선 위에 앉는다. 후보 점수화가 절대
 * 봐서는 안 되는 영역이다. 256px 는 128px 이면 평균에 뭉개질 작은 특징(눈·보석)을 남긴다.
 */
const REFERENCE_SAMPLE_SIZE = 256;

const BACKGROUND_TOLERANCE = 48.0;
const ALPHA_TRANSPARENT_MAX = 16;

/**
 * 소재는 배경에 대해 ~1-2px 안티에일리어싱된다. 그 블렌드 픽셀은 소재가 아니라
 * 배경 오염이므로 마스크를 키워 띠를 삼킨다.
 */
const BACKGROUND_EDGE_DILATION = 2;

/**
 * 키 색 영역이 소재에 둘러싸여 있으면 애매하다 — 실루엣을 뚫고 배경이 보이는
 * 구멍일 수도, 작가가 키 색조로 그린 소재일 수도 있다. 구멍은 평면 채움이라
 * 거의 전부가 정확한 배경색에 앉고, 그린 소재는 음영을 가져 퍼진다. 구멍은
 * 배경으로, 그린 소재는 소재로 남겨야 삭제 반경 게이트가 그것을 지울 키를 거부한다.
 */
const BACKGROUND_FLAT_TOLERANCE = 16.0;
const ENCLOSED_FLAT_FRACTION = 0.6;

/**
 * 생성 이미지는 실루엣 안쪽에 고립된 스필·압축 스페클을 가진다(머리카락 틈의
 * 외톨이 (233,7,202) 하나). 픽셀 하나는 특징이 아니고, 그것을 세면 최근접 픽셀
 * 안전 게이트가 스페클에 지배된다. 자기 색의 영역에 속한 픽셀만 남긴다.
 */
const SPECKLE_NEIGHBOR_TOLERANCE = 40.0;
const SPECKLE_MIN_SIMILAR_NEIGHBORS = 3;

const NEIGHBORS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBORS_8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export type SampledPixel = [number, number, number];

/**
 * base-gate 의 BackgroundInfo 에 "참조 없음"을 더한 것. base-gate 를 넓히지 않는
 * 이유는 inspectBaseImage 가 항상 실재 파일을 받아 absent 를 만들지 않기 때문이다.
 */
export type ReferenceBackground = BackgroundInfo | { mode: "absent" };

function rgbAt(raw: Buffer, i: number, channels: number): SampledPixel {
  const o = i * channels;
  return [raw[o], raw[o + 1], raw[o + 2]];
}

function alphaAt(raw: Buffer, i: number, channels: number): number {
  return channels >= 4 ? raw[i * channels + 3] : 255;
}

/** 배경에 속하는 픽셀을 표시한다. 길이 width*height, true = 배경. */
export function backgroundMask(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  background: ReferenceBackground,
): boolean[] {
  const n = width * height;
  const transparent = new Array<boolean>(n);
  for (let i = 0; i < n; i++) transparent[i] = alphaAt(raw, i, channels) <= ALPHA_TRANSPARENT_MAX;
  const mask = transparent.slice();

  if (background.mode === "flat") {
    const key = background.rgb;
    const near = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
      near[i] =
        transparent[i] || colorDistance(rgbAt(raw, i, channels), key) <= BACKGROUND_TOLERANCE;
    }
    const visited = new Array<boolean>(n).fill(false);
    for (let start = 0; start < n; start++) {
      if (!near[start] || visited[start]) continue;
      visited[start] = true;
      const queue: number[] = [start];
      const component: number[] = [];
      let grounded = false;
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        component.push(i);
        const x = i % width;
        const y = (i / width) | 0;
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1 || transparent[i]) {
          grounded = true;
        }
        for (const [dx, dy] of NEIGHBORS_8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          if (near[j] && !visited[j]) {
            visited[j] = true;
            queue.push(j);
          }
        }
      }
      if (!grounded) {
        let flat = 0;
        for (const i of component) {
          if (colorDistance(rgbAt(raw, i, channels), key) <= BACKGROUND_FLAT_TOLERANCE) flat++;
        }
        // 그린 키 색조 소재는 소재로 남긴다 — 그래야 삭제 반경 게이트가 그것을
        // 지울 키를 거부할 수 있다 (sprite-gen v1.10.1 키 틴트 보호).
        if (flat / component.length < ENCLOSED_FLAT_FRACTION) continue;
      }
      for (const i of component) mask[i] = true;
    }
  }

  for (let pass = 0; pass < BACKGROUND_EDGE_DILATION; pass++) {
    const grown: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask[i]) continue;
      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of NEIGHBORS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (mask[ny * width + nx]) {
          grown.push(i);
          break;
        }
      }
    }
    for (const i of grown) mask[i] = true;
  }
  return mask;
}

/** 배경·근백색·고립 스페클을 뺀 소재 픽셀의 색 목록. */
export function subjectPixels(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  background: ReferenceBackground,
): SampledPixel[] {
  const n = width * height;
  const mask = backgroundMask(raw, width, height, channels, background);
  const candidate = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const c = rgbAt(raw, i, channels);
    candidate[i] = !mask[i] && !(c[0] > 244 && c[1] > 244 && c[2] > 244);
  }

  const out: SampledPixel[] = [];
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) continue;
    const color = rgbAt(raw, i, channels);
    const x = i % width;
    const y = (i / width) | 0;
    let similar = 0;
    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx;
      if (
        candidate[j] &&
        colorDistance(rgbAt(raw, j, channels), color) <= SPECKLE_NEIGHBOR_TOLERANCE
      ) {
        similar++;
      }
    }
    if (similar >= SPECKLE_MIN_SIMILAR_NEIGHBORS) out.push(color);
  }
  return out;
}

/**
 * 베이스를 (소재 픽셀, 배경 분류)로 샘플링한다.
 *
 * 이 파이프라인의 베이스는 항상 크로마 배경을 달고 있다. 그 픽셀을 소재로 세면
 * 현재 배경과 일치하는 후보의 minSubjectDistance 가 0 에 고정되어, auto 는
 * 베이스가 그려진 바로 그 키를 두 번 다시 고를 수 없게 된다.
 */
export async function sampleReference(
  filePath: string,
): Promise<{ pixels: SampledPixel[]; background: ReferenceBackground }> {
  try {
    const { data, info } = await sharp(filePath)
      .resize(REFERENCE_SAMPLE_SIZE, REFERENCE_SAMPLE_SIZE, {
        fit: "inside",
        withoutEnlargement: true,
        kernel: "nearest",
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const background = detectBackgroundMode(data, info.width, info.height, info.channels);
    const pixels = subjectPixels(data, info.width, info.height, info.channels, background);
    return { pixels, background };
  } catch {
    return { pixels: [], background: { mode: "absent" } };
  }
}

/* --- 후보 점수화 ------------------------------------------------------------ */

/** 순서가 선호도다 — 점수가 완전히 동률이면 앞선 후보가 이긴다. */
export const CHROMA_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ["magenta", "#FF00FF"],
  ["green", "#00FF00"],
  ["cyan", "#00FFFF"],
  ["blue", "#004DFF"],
];

/**
 * 추출기 `--key-threshold` 기본값의 거울. 이 색거리 반경 안의 소재 픽셀은 추출
 * 시점에 위치와 무관하게 삭제되므로, 최근접 소재 픽셀이 이 안에 들어오는 키는
 * 그 특징을 지운다.
 */
export const MIN_SUBJECT_KEY_DISTANCE = 96.0;

export type ChromaCandidate = {
  name: string;
  hex: string;
  score: number;
  minSubjectDistance: number;
  clearsEraseRadius: boolean;
};

export type ChromaSelection = ChromaKeySpec & {
  candidates?: ChromaCandidate[];
  background?: ReferenceBackground;
};

function parseHexColor(value: string): SampledPixel {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`chooseChromaKey: invalid chroma key color: ${value}; expected #RRGGBB`);
  }
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

/** sprite-gen `rgb_to_hex` 와 같은 대문자 표기. base-gate 의 소문자판과 별개다. */
function rgbToHexUpper(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(c => c.toString(16).toUpperCase().padStart(2, "0")).join("")}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

type ScoredCandidate = {
  score: number;
  minDistance: number;
  preference: number;
  name: string;
  rgb: SampledPixel;
};

/** score → minDistance → preference 순의 사전식 비교. Python 의 튜플 max 와 같다. */
function better(a: ScoredCandidate, b: ScoredCandidate): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.minDistance !== b.minDistance) return a.minDistance > b.minDistance;
  return a.preference > b.preference;
}

export async function chooseChromaKey(
  referencePath: string | null,
  requested: string,
): Promise<ChromaSelection> {
  if (requested.toLowerCase() !== "auto") {
    const rgb = parseHexColor(requested);
    const hex = rgbToHexUpper(rgb);
    const known = CHROMA_CANDIDATES.find(([, candidateHex]) => candidateHex === hex);
    return { name: known ? known[0] : "manual", hex, rgb, selection: "manual" };
  }

  const { pixels, background } =
    referencePath === null
      ? { pixels: [] as SampledPixel[], background: { mode: "absent" } as ReferenceBackground }
      : await sampleReference(referencePath);

  if (pixels.length === 0) {
    const reason =
      background.mode === "absent"
        ? "no base reference to sample"
        : "the base reference yielded no subject pixels once its background was excluded";
    return {
      name: "magenta",
      hex: "#FF00FF",
      rgb: parseHexColor("#FF00FF"),
      selection: "fallback",
      background,
      selectionReason: reason,
    };
  }

  const scored: ScoredCandidate[] = CHROMA_CANDIDATES.map(([name, hex], preferenceIndex) => {
    const rgb = parseHexColor(hex);
    const distances = pixels.map(p => colorDistance(rgb, p)).sort((a, b) => a - b);
    // Python: int(len * 0.01) 을 [0, len-1] 로 클램프
    const idx = Math.max(0, Math.min(distances.length - 1, Math.trunc(distances.length * 0.01)));
    return { score: distances[idx], minDistance: distances[0], preference: -preferenceIndex, name, rgb };
  });

  // 1퍼센타일 점수는 1% 미만의 특징(눈·보석·귀 램프)을 무시한다 — 최근접 소재
  // 픽셀이 여전히 삭제 반경 안인데도 키가 "안전"해 보일 수 있다. 모든 소재 픽셀을
  // 벗어나는 후보를 먼저 고르고, 그런 후보가 없을 때만 경고와 함께 원래 순위로 떨어진다.
  const safe = scored.filter(e => e.minDistance > MIN_SUBJECT_KEY_DISTANCE);
  const pool = safe.length > 0 ? safe : scored;
  const winner = pool.reduce((best, e) => (better(e, best) ? e : best), pool[0]);

  const selection: ChromaSelection = {
    name: winner.name,
    hex: rgbToHexUpper(winner.rgb),
    rgb: winner.rgb,
    selection: "auto",
    score: round2(winner.score),
    minSubjectDistance: round2(winner.minDistance),
    background,
    candidates: scored.map(e => ({
      name: e.name,
      hex: rgbToHexUpper(e.rgb),
      score: round2(e.score),
      minSubjectDistance: round2(e.minDistance),
      clearsEraseRadius: e.minDistance > MIN_SUBJECT_KEY_DISTANCE,
    })),
    selectionReason:
      safe.length > 0
        ? `highest 1st-percentile subject distance among the ${safe.length} candidate(s) clearing the ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)} erase radius`
        : `no candidate clears the ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)} erase radius; ranked by 1st-percentile subject distance alone`,
  };

  if (winner.minDistance <= MIN_SUBJECT_KEY_DISTANCE) {
    selection.warning =
      `nearest subject pixel is ${winner.minDistance.toFixed(1)} from ${winner.name} ` +
      `(<= ${MIN_SUBJECT_KEY_DISTANCE.toFixed(0)}); that feature will be erased at extraction — ` +
      `recolor it or force a different chroma key`;
  }
  return selection;
}
