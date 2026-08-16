/**
 * 아틀라스 합성 + 런타임 매니페스트 — sprite_gen/compose_atlas.py 이식.
 *
 * 추출된 프레임(셀 규격, 알파)을 **상태당 한 행**으로 배치한다:
 *
 *   atlas = (columns × cellWidth) × (상태 수 × cellHeight)
 *   columns = 상태들 중 최대 프레임 수
 *
 * 소비자는 `frame_layout.rows.<state>[i]` 의 절대 사각형만 샘플링해야 한다. 아틀라스
 * 전체를 한 평면에 렌더하거나 격자를 추측하면 통합 실패다(SKILL.md Runtime Contract).
 *
 * `durations_ms` 가 프레임별 표시 시간의 SSoT 다 — 배열이 있으면 fps 대신 이것을 따른다.
 * 지금은 fps 등간격이고, 프레임별 편집 UI 가 생기면 여기만 비등간격으로 채워진다.
 *
 * 이식 범위에서 뺀 것(전부 원본에서도 옵트인/후속): 호흡 후처리 위상, 큐레이션 변형·픽셀
 * 편집, 프레임 복제(clones)와 그에 따른 **아틀라스 칸 재사용**, pixel/plain 변이 선택,
 * recolor. 재사용이 없으므로 지금은 인스턴스마다 칸을 하나씩 쓴다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import sharp from "sharp";
import { curatedSequence, type CurationRecord } from "@/lib/sprite/anchor";
import type { RawImage } from "@/lib/sprite/extract";
import type { CellSpec, SpriteRequest } from "@/lib/sprite/request";

export type FrameRect = { x: number; y: number; w: number; h: number };

export type FrameLayout = {
  sheetWidth: number;
  sheetHeight: number;
  cellWidth: number;
  cellHeight: number;
  rows: Record<string, FrameRect[]>;
};

export type AnimationRow = {
  row: number;
  frames: number;
  fps: number;
  durations_ms: number[];
  loop: boolean;
};

export type Animation = {
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: Record<string, AnimationRow>;
};

export type SpriteManifest = {
  characterId: string;
  engine: "component-row";
  game_input: string;
  degraded_static_fallback: false;
  cell: CellSpec;
  chroma_key: SpriteRequest["chromaKey"];
  animation: Animation;
  frame_layout: FrameLayout;
  /**
   * 이 아틀라스가 큐레이션 사이드카를 반영해 구워졌는가.
   *
   * 정본 Output Contract 의 핵심 기록이다 — *"Install from `curated/`, never from
   * `frames/`"*. `frames/` 는 큐레이션 이전이고, 사람의 선택은 사이드카에 있다가
   * 합성 시점에 적용된다. 이 플래그가 없으면 편집 반영본과 편집 전 산출물을 구분할 수
   * 없고, 그것이 실사고의 형태다(2026-07-26: 손으로 고친 191픽셀이 조용히 누락되고
   * "적용됨" 으로 보고).
   */
  curation_applied: boolean;
};

export type ComposeResult = {
  atlas: RawImage;
  manifest: SpriteManifest;
  /** 비어 있으면 통과. 하나라도 있으면 아틀라스를 쓰지 않는다. */
  errors: string[];
};

/** 프레임이 이보다 적은 픽셀만 쓰면 빈 프레임으로 본다 (원본 --min-used-pixels 기본). */
export const DEFAULT_MIN_USED_PIXELS = 64;

function alphaNonzeroCount(img: RawImage): number {
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3] !== 0) n++;
  return n;
}

export function composeAtlas(opts: {
  request: SpriteRequest;
  /**
   * 상태 → **추출된 전체 프레임**(큐레이션 이전). 키 순서가 곧 행 순서다.
   * 정본 `frames/` 에 해당한다 — 여기서 바로 구우면 안 되고 큐레이션을 통과해야 한다.
   */
  framesByState: Record<string, RawImage[]>;
  /**
   * 상태 → 사람이 저장한 재생 시퀀스. 없거나 비어 있으면 추출 순서 그대로 쓴다 —
   * **명시적 기본값이지 조용한 폴백이 아니다**(curation.md: *"an explicit default,
   * not a silent fallback"*).
   */
  curationByState?: Record<string, CurationRecord | null | undefined>;
  atlasName?: string;
  minUsedPixels?: number;
}): ComposeResult {
  const { request, framesByState } = opts;
  const cell = request.cell;
  const minUsed = opts.minUsedPixels ?? DEFAULT_MIN_USED_PIXELS;
  const states = Object.keys(framesByState);
  const errors: string[] = [];

  // 재생 순서 해석 — 이 배열이 굽는 인스턴스 순서다(정본 curation.state_plan).
  // 범위를 벗어난 인덱스는 curatedSequence 가 던진다(재추출로 인덱스 공간이 바뀐 큐레이션).
  const playOrder: Record<string, number[]> = {};
  let curationApplied = false;
  for (const state of states) {
    const curation = opts.curationByState?.[state] ?? null;
    playOrder[state] = curatedSequence(framesByState[state].length, curation);
    if (curation && curation.selected.length > 0) curationApplied = true;
  }

  const columns = Math.max(1, ...states.map(s => playOrder[s].length));
  const sheetWidth = columns * cell.width;
  const sheetHeight = states.length * cell.height;
  const atlasData = Buffer.alloc(sheetWidth * sheetHeight * 4);

  const frameLayout: FrameLayout = {
    sheetWidth,
    sheetHeight,
    cellWidth: cell.width,
    cellHeight: cell.height,
    rows: {},
  };
  const animation: Animation = {
    cellWidth: cell.width,
    cellHeight: cell.height,
    columns,
    rows: {},
  };

  states.forEach((state, rowIndex) => {
    const frames = framesByState[state];
    const entry = request.states[state];
    const rects: FrameRect[] = [];

    // 재생 순서대로 굽는다 — col 은 아틀라스 칸이고 srcIndex 는 추출 프레임이다.
    playOrder[state].forEach((srcIndex, col) => {
      const frame = frames[srcIndex];
      if (frame.width !== cell.width || frame.height !== cell.height) {
        errors.push(
          `${state} frame ${srcIndex} is ${frame.width}x${frame.height}; expected ${cell.width}x${cell.height}`,
        );
        return;
      }
      const used = alphaNonzeroCount(frame);
      if (used < minUsed) {
        errors.push(`${state} frame ${srcIndex} is too sparse (${used})`);
      }
      const left = col * cell.width;
      const top = rowIndex * cell.height;
      for (let y = 0; y < cell.height; y++) {
        const src = y * cell.width * 4;
        const dst = ((top + y) * sheetWidth + left) * 4;
        frame.data.copy(atlasData, dst, src, src + cell.width * 4);
      }
      rects.push({ x: left, y: top, w: cell.width, h: cell.height });
    });

    frameLayout.rows[state] = rects;
    const fps = entry?.fps ?? 6;
    const durationMs = Math.max(1, Math.round(1000 / (fps || 6)));
    animation.rows[state] = {
      row: rowIndex,
      frames: rects.length,
      fps,
      durations_ms: new Array(rects.length).fill(durationMs),
      loop: entry?.loop ?? true,
    };
  });

  return {
    atlas: { data: atlasData, width: sheetWidth, height: sheetHeight },
    manifest: {
      characterId: request.character.id,
      engine: "component-row",
      game_input: opts.atlasName ?? "sprite-sheet-alpha.png",
      degraded_static_fallback: false,
      cell,
      chroma_key: request.chromaKey,
      animation,
      frame_layout: frameLayout,
      curation_applied: curationApplied,
    },
    errors,
  };
}

export async function writeAtlas(atlas: RawImage, destPath: string): Promise<void> {
  await sharp(atlas.data, {
    raw: { width: atlas.width, height: atlas.height, channels: 4 },
  })
    .png()
    .toFile(destPath);
}
