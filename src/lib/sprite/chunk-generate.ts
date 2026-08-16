// SPDX-License-Identifier: Apache-2.0
//
// 청크 생성 — 정본에 없는 우리 설계. 실측이 강제한 것이다.
// 관련 이식: pixel-grid.ts(격자 검출), pixel-unfake.ts(스냅), reroll.ts(후보 재생성)

/**
 * 한 행을 **작은 청크로 나눠 생성한 뒤 하나의 스트립으로 잇는다.**
 *
 * ## 왜 필요한가 — 실측
 *
 * codex 는 캔버스 총량을 대략 150만~180만 픽셀로 고정한 채 프레임 수만 늘린다. 그래서
 * 프레임당 해상도가 프레임 수에 반비례해 깎이고, 임계 아래로 떨어지면 모델이 픽셀 블록을
 * **아예 안 그린다**(2026-08-17 실측):
 *
 *     1프레임 → 프레임당 1122px → 피치 8.00
 *     2프레임 → 프레임당  768px → 피치 6.00  (4회 중 2회)
 *     3프레임 → 프레임당  512px → 피치 1.00  (붕괴)
 *     4프레임 → 프레임당  384px → 피치 1.00
 *
 * 피치가 1.0 이면 `pixel_unfake` 의 스냅 경로가 통째로 건너뛰어진다. 즉 **격자가 필요한
 * 런은 청크로 나눠 생성하는 수밖에 없다.**
 *
 * ## 확률적이라는 것이 설계를 정한다
 *
 * 같은 2프레임 요청도 격자가 나올 때와 안 나올 때가 있다(4회 중 2회). 그래서 생성 뒤
 * **격자를 재서 게이트**를 걸고, 실패한 청크만 다시 만든다 — 정본 reroll 의 "후보를
 * 쌓고 고른다" 와 같은 형태다. 표본 1로 성질을 단정하지 말 것: 처음엔 "2프레임까지
 * 격자가 산다" 고 적었다가 추가 측정에 뒤집혔다.
 *
 * ## 거터가 필수다
 *
 * 청크를 그냥 붙이면 연결요소 분리가 어긋난다(실측: 논리 프레임이 561x351 로 튀어
 * `conformRowLogical` 이 막았다). 조각 사이와 양끝에 투명이 아니라 **크로마 거터**를
 * 넣는다 — 하류가 이 스트립을 여느 raw 스트립과 똑같이 크로마 제거부터 태우기 때문이다.
 */

import { detectPixelGrid } from "@/lib/sprite/pixel-grid";
import type { RGB } from "@/lib/sprite/chroma-clean";

export type RawImage = { data: Buffer; width: number; height: number };

/**
 * 청크 사이·양끝 크로마 거터 폭(px).
 *
 * `segment.ts` 의 8px 보다 크게 잡는다 — 저기는 이미 분리된 컴포넌트를 떼어놓는
 * 것이지만 여기는 **다른 생성물**을 잇는 것이라 서로의 AA 프린지가 겹치면 안 된다.
 */
export const CHUNK_GUTTER = 64;

/** 격자가 살아 있는 최대 청크 크기. 3프레임부터 붕괴가 관측됐다. */
export const MAX_CHUNK_FRAMES = 2;

/**
 * 프레임 수를 청크로 쪼갠다 — 앞에서부터 `size` 씩, 마지막이 나머지.
 *
 * 5프레임이면 `[2, 2, 1]` 이다. 1프레임 청크는 격자가 가장 잘 나오므로(1122px) 나머지를
 * 굳이 앞 청크에 섞지 않는다.
 */
export function planChunks(frameCount: number, size = MAX_CHUNK_FRAMES): number[] {
  if (frameCount <= 0) throw new Error("planChunks: frameCount 는 1 이상이어야 합니다");
  if (size < 1) throw new Error("planChunks: 청크 크기는 1 이상이어야 합니다");
  const out: number[] = [];
  let left = frameCount;
  while (left > 0) {
    const take = Math.min(size, left);
    out.push(take);
    left -= take;
  }
  return out;
}

/**
 * 청크 이미지들을 크로마 거터와 함께 가로로 잇는다.
 *
 * 높이는 가장 큰 청크에 맞추고 나머지는 **바닥 정렬**한다 — 발이 같은 선에 서야 하류의
 * 프레임 정합이 상체를 맞출 수 있다. 남는 위쪽은 크로마로 채워지므로 추출이 지운다.
 */
export function joinChunks(chunks: RawImage[], chromaRgb: RGB, gutter = CHUNK_GUTTER): RawImage {
  if (chunks.length === 0) throw new Error("joinChunks: 청크가 없습니다");
  const height = Math.max(...chunks.map(c => c.height));
  const width = chunks.reduce((s, c) => s + c.width, 0) + gutter * (chunks.length + 1);
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = chromaRgb[0];
    data[p * 4 + 1] = chromaRgb[1];
    data[p * 4 + 2] = chromaRgb[2];
    data[p * 4 + 3] = 255;
  }
  let x = gutter;
  for (const c of chunks) {
    const top = height - c.height; // 바닥 정렬
    for (let y = 0; y < c.height; y++) {
      c.data.copy(data, ((top + y) * width + x) * 4, y * c.width * 4, (y + 1) * c.width * 4);
    }
    x += c.width + gutter;
  }
  return { data, width, height };
}

export type ChunkAttempt = {
  index: number;
  frames: number;
  attempts: number;
  /** 채택한 청크의 검출 피치. `[1,1]` 이면 격자 없이 통과시킨 것이다. */
  pitch: [number, number];
  accepted: boolean;
};

export type ChunkGenerateResult = {
  strip: RawImage;
  chunks: RawImage[];
  attempts: ChunkAttempt[];
  warnings: string[];
};

/**
 * 청크를 하나씩 만들며 **격자를 게이트로** 건다.
 *
 * `generateChunk(chunkIndex, frames, attempt)` 는 그 청크의 raw 이미지를 낸다.
 * 피치가 `minPitch` 미만이면 `maxAttempts` 까지 다시 만들고, 그래도 안 나오면 **마지막
 * 것을 그대로 쓰되 사유를 남긴다** — 행 전체를 실패시키는 것보다 낫다. 격자가 없는
 * 청크가 섞이면 `pixel_unfake` 가 그 프레임만 스냅하지 않고 넘어간다(합의 폴백).
 */
export async function generateChunkedRow(opts: {
  frameCount: number;
  chromaRgb: RGB;
  chunkSize?: number;
  minPitch?: number;
  maxAttempts?: number;
  gutter?: number;
  label?: string;
  generateChunk: (chunkIndex: number, frames: number, attempt: number) => Promise<RawImage>;
  log?: (message: string) => void;
}): Promise<ChunkGenerateResult> {
  const chunkSize = opts.chunkSize ?? MAX_CHUNK_FRAMES;
  const minPitch = opts.minPitch ?? 2.0;
  const maxAttempts = opts.maxAttempts ?? 3;
  const label = opts.label ?? "row";
  const plan = planChunks(opts.frameCount, chunkSize);
  const chunks: RawImage[] = [];
  const attempts: ChunkAttempt[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < plan.length; i++) {
    const frames = plan[i];
    let best: RawImage | null = null;
    let bestPitch: [number, number] = [1, 1];
    let used = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      used = attempt;
      const img = await opts.generateChunk(i, frames, attempt);
      const g = detectPixelGrid({
        data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
        width: img.width,
        height: img.height,
      });
      const pitch: [number, number] = [g.pitch[0], g.pitch[1]];
      opts.log?.(
        `${label} 청크 ${i + 1}/${plan.length} 시도 ${attempt}: ${img.width}x${img.height} ` +
          `피치 ${pitch[0].toFixed(2)}x${pitch[1].toFixed(2)}`,
      );
      // 더 나은 것을 남긴다 — 마지막 시도가 최악일 수 있다.
      if (best === null || Math.min(...pitch) > Math.min(...bestPitch)) {
        best = img;
        bestPitch = pitch;
      }
      if (Math.min(pitch[0], pitch[1]) >= minPitch) break;
    }
    const accepted = Math.min(bestPitch[0], bestPitch[1]) >= minPitch;
    if (!accepted) {
      warnings.push(
        `${label}: 청크 ${i + 1} 이 ${used}번 시도에도 픽셀 격자를 못 냈습니다 ` +
          `(피치 ${bestPitch[0].toFixed(2)}x${bestPitch[1].toFixed(2)}) — 그대로 씁니다`,
      );
    }
    chunks.push(best as RawImage);
    attempts.push({ index: i, frames, attempts: used, pitch: bestPitch, accepted });
  }

  return {
    strip: joinChunks(chunks, opts.chromaRgb, opts.gutter),
    chunks,
    attempts,
    warnings,
  };
}
