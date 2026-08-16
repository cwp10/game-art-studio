/**
 * 클린 투명 GIF — sprite_gen/gif_utils.py 이식.
 *
 * GIF 프리뷰는 투명 픽셀로 **이전 프레임이 비쳐서는 안 된다**. 프레임마다 전용 투명
 * 팔레트 인덱스를 쓰고 disposal method 2(다음 프레임을 그리기 전에 지운다)를 건다.
 * 이것이 Discord·브라우저 프리뷰에서 나오는 "잔상" 의 원인이자 해결이다.
 *
 * Node 에는 애니메이션 GIF 인코더가 없다(sharp 는 디코드된 버퍼에서 애니메이션 GIF 를
 * 쓰지 못한다). 그래서 양자화·LZW·GIF89a 조립을 직접 한다. 알고리즘은 Pillow 경로를
 * 따른다 — `convert("P", palette=ADAPTIVE, colors=255)` 는 Pillow 내부에서
 * `im.quantize(colors)` 로 빠지므로 **디더링 없는 median cut** 이다(Image.py:1185).
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RawImage } from "@/lib/sprite/extract";

/** ImageMagick/GIF delay tick(1/100초) → PIL 밀리초. */
export function delayTicksToDurationMs(delayTicks: number): number {
  if (delayTicks <= 0) throw new Error("delay_ticks must be positive");
  return delayTicks * 10;
}

/** 투명으로 볼 알파 상한. 원본 `save_clean_gif(alpha_threshold=8)`. */
const DEFAULT_ALPHA_THRESHOLD = 8;

/** 투명 전용 인덱스. 원본은 255 를 예약하고 색은 255 색까지만 뽑는다. */
const TRANSPARENT_INDEX = 255;

// ── median cut 양자화 ─────────────────────────────────────────────────────────

type Box = {
  /** 이 상자에 속한 서로 다른 색들. key = (r<<16)|(g<<8)|b */
  colors: number[];
  counts: number[];
  total: number;
  min: [number, number, number];
  max: [number, number, number];
};

function boxBounds(colors: number[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  for (const key of colors) {
    const c = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return { min, max };
}

function makeBox(colors: number[], counts: number[]): Box {
  let total = 0;
  for (const n of counts) total += n;
  return { colors, counts, total, ...boxBounds(colors) };
}

/**
 * median cut — 픽셀이 가장 많은 상자를 가장 긴 축의 중앙값에서 자른다.
 *
 * 반환은 `{palette, indexOf}` 다. `indexOf` 는 색 key → 팔레트 인덱스로, 각 색이 정확히
 * 한 상자에만 속하므로 최근접 탐색이 필요 없다(median cut 의 성질).
 */
function medianCut(
  histogram: Map<number, number>,
  maxColors: number,
): { palette: [number, number, number][]; indexOf: Map<number, number> } {
  const colors = [...histogram.keys()];
  const counts = colors.map(k => histogram.get(k)!);
  let boxes: Box[] = [makeBox(colors, counts)];

  while (boxes.length < maxColors) {
    // 자를 수 있는(색이 2개 이상인) 상자 중 픽셀이 가장 많은 것.
    let target = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length < 2) continue;
      if (target < 0 || boxes[i].total > best) {
        target = i;
        best = boxes[i].total;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    // 가장 긴 축.
    let axis = 0;
    let span = -1;
    for (let a = 0; a < 3; a++) {
      const s = box.max[a] - box.min[a];
      if (s > span) {
        span = s;
        axis = a;
      }
    }
    const shift = axis === 0 ? 16 : axis === 1 ? 8 : 0;
    const order = box.colors
      .map((key, i) => ({ key, count: box.counts[i] }))
      .sort((p, q) => ((p.key >> shift) & 0xff) - ((q.key >> shift) & 0xff));

    // 누적 픽셀 수가 절반에 닿는 지점에서 자른다. 양쪽 모두 비지 않게 한다.
    let acc = 0;
    let cut = 0;
    for (let i = 0; i < order.length - 1; i++) {
      acc += order[i].count;
      cut = i + 1;
      if (acc * 2 >= box.total) break;
    }
    const left = order.slice(0, cut);
    const right = order.slice(cut);
    boxes = [
      ...boxes.slice(0, target),
      makeBox(left.map(e => e.key), left.map(e => e.count)),
      makeBox(right.map(e => e.key), right.map(e => e.count)),
      ...boxes.slice(target + 1),
    ];
  }

  // 팔레트 색 = 상자의 픽셀 가중 평균. Pillow 도 상자 평균을 쓴다.
  const palette: [number, number, number][] = [];
  const indexOf = new Map<number, number>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < box.colors.length; j++) {
      const key = box.colors[j];
      const n = box.counts[j];
      r += ((key >> 16) & 0xff) * n;
      g += ((key >> 8) & 0xff) * n;
      b += (key & 0xff) * n;
      indexOf.set(key, i);
    }
    palette.push([
      Math.round(r / box.total),
      Math.round(g / box.total),
      Math.round(b / box.total),
    ]);
  }
  return { palette, indexOf };
}

/**
 * RGBA 프레임 → 팔레트 인덱스 + 팔레트.
 *
 * 원본 `_prepare_transparent_frame`:
 * 보이지 않는 RGB 를 적응형 팔레트에서 뺀다 — 안 그러면 투명 소스 픽셀이 팔레트 항목을
 * 훔쳐 컬러 프린지가 생긴다. Pillow 는 `rgb.paste(rgba.convert("RGB"), mask=alpha)` 로
 * 투명 영역을 검정 한 색으로 뭉갠다(팔레트 항목 하나만 차지하게).
 */
function prepareTransparentFrame(
  frame: RawImage,
  alphaThreshold: number,
): { indices: Buffer; palette: [number, number, number][] } {
  const n = frame.width * frame.height;
  const histogram = new Map<number, number>();
  const keys = new Int32Array(n);
  const transparent = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const a = frame.data[i * 4 + 3];
    // mask=alpha 붙여넣기와 같은 결과: 알파가 0 이면 검정. Pillow 의 mask 는 알파값을
    // 그대로 쓰는 부분 블렌드지만, 우리 프레임은 추출 산출물이라 부분 알파가 가장자리에만
    // 있고 그 픽셀은 아래 투명 판정(<= 8)에서 대부분 살아남는다.
    const key =
      a === 0
        ? 0
        : ((frame.data[i * 4] << 16) | (frame.data[i * 4 + 1] << 8) | frame.data[i * 4 + 2]);
    keys[i] = key;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    transparent[i] = a <= alphaThreshold ? 1 : 0;
  }

  const { palette, indexOf } = medianCut(histogram, TRANSPARENT_INDEX);
  const indices = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    indices[i] = transparent[i] ? TRANSPARENT_INDEX : indexOf.get(keys[i])!;
  }

  // 팔레트를 256 항목으로 채우고 255 번을 투명 전용으로 예약한다(원본과 같은 검정).
  const full: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) full.push(palette[i] ?? [0, 0, 0]);
  full[TRANSPARENT_INDEX] = [0, 0, 0];
  return { indices, palette: full };
}

// ── LZW ──────────────────────────────────────────────────────────────────────

class BitWriter {
  readonly bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  write(code: number, size: number): void {
    this.cur |= code << this.nbits;
    this.nbits += size;
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>>= 8;
      this.nbits -= 8;
    }
  }

  flush(): void {
    if (this.nbits > 0) {
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.nbits = 0;
    }
  }
}

/** GIF 변종 LZW. 코드는 LSB 우선으로 채워 넣는다. */
function lzwEncode(indices: Buffer, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = new BitWriter();
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map<number, number>();

  out.write(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    out.write(prefix, codeSize);
    dict.set(key, nextCode);
    nextCode++;
    if (nextCode === 1 << codeSize) {
      if (codeSize < 12) {
        codeSize++;
      } else {
        // 테이블이 꽉 찼다 — 지우고 처음부터.
        out.write(clearCode, codeSize);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  out.write(eoiCode, codeSize);
  out.flush();
  return out.bytes;
}

/** LZW 바이트열을 255 바이트 이하 서브블록으로 쪼개고 0x00 으로 끝낸다. */
function subBlocks(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0x00);
  return out;
}

// ── GIF89a 조립 ──────────────────────────────────────────────────────────────

function u16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function colorTable(palette: [number, number, number][]): number[] {
  const out: number[] = [];
  for (const [r, g, b] of palette) out.push(r, g, b);
  return out;
}

export type CleanGifOptions = {
  durationMs: number;
  /** 0 = 무한 루프(GIF/Pillow 용어). 원본 기본값. */
  loop?: number;
  alphaThreshold?: number;
};

/**
 * RGBA 프레임들을 클린 투명 GIF 로 쓴다.
 *
 * `loop=0` 은 GIF/Pillow 용어로 무한 루프다.
 */
export async function saveCleanGif(
  frames: RawImage[],
  outputPath: string,
  opts: CleanGifOptions,
): Promise<void> {
  const { durationMs, loop = 0, alphaThreshold = DEFAULT_ALPHA_THRESHOLD } = opts;
  if (durationMs <= 0) throw new Error("duration_ms must be positive");
  if (frames.length === 0) throw new Error("at least one frame is required");

  const prepared = frames.map(f => ({
    ...prepareTransparentFrame(f, alphaThreshold),
    width: f.width,
    height: f.height,
  }));

  const width = Math.max(...prepared.map(p => p.width));
  const height = Math.max(...prepared.map(p => p.height));
  const bytes: number[] = [];

  // Header + Logical Screen Descriptor. GCT 는 첫 프레임 팔레트 — 로컬 팔레트가 없는
  // 디코더용 폴백이다(프레임마다 로컬 팔레트를 따로 싣는다).
  bytes.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  bytes.push(...u16(width), ...u16(height));
  bytes.push(0xf7, 0x00, 0x00); // GCT flag=1, color res=7, sort=0, size=7(=256)
  bytes.push(...colorTable(prepared[0].palette));

  // NETSCAPE2.0 — 루프 횟수.
  bytes.push(0x21, 0xff, 0x0b);
  bytes.push(...Buffer.from("NETSCAPE2.0", "ascii"));
  bytes.push(0x03, 0x01, ...u16(loop), 0x00);

  const delayTicks = Math.round(durationMs / 10);
  for (const frame of prepared) {
    // Graphic Control Extension — disposal 2(다음 프레임 전에 지운다) + 투명 인덱스.
    // packed = reserved(3) | disposal(3) | userInput(1) | transparentFlag(1)
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | 0x01, ...u16(delayTicks), TRANSPARENT_INDEX, 0x00);
    // Image Descriptor — 로컬 팔레트 있음(0x87 = LCT flag + size 7).
    bytes.push(0x2c, ...u16(0), ...u16(0), ...u16(frame.width), ...u16(frame.height), 0x87);
    bytes.push(...colorTable(frame.palette));
    const minCodeSize = 8;
    bytes.push(minCodeSize);
    bytes.push(...subBlocks(lzwEncode(frame.indices, minCodeSize)));
  }

  bytes.push(0x3b); // Trailer
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(bytes));
}
