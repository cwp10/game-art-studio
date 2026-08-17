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
import type { Anatomy } from "@/lib/sprite/anatomy";
import {
  anatomyReport,
  fitBreathePattern,
  phaseFrame,
  resolveAnatomy,
  type AnatomyReport,
  type BreatheConfig,
} from "@/lib/sprite/breathe";
import { stateBreathe } from "@/lib/sprite/curation-breathe";
import { applyTransform, stateTransforms, type Transform } from "@/lib/sprite/curation-transform";
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
  /** 호흡이 켜진 행에만 있다 — 굽기가 실제로 쓴 해부. 호흡이 꺼졌으면 키가 없다. */
  breathe?: AnatomyReport | null;
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

// 호흡을 구운 프레임은 Uint8Array 를 들고 오므로 Buffer 로 좁히지 않는다.
function alphaNonzeroCount(img: { data: Uint8Array; width: number; height: number }): number {
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
  // 호흡 위상 — 재생 시퀀스 길이에 딱 맞춰 breaths 회가 떨어진다(루프 불변).
  // 호흡이 꺼진 행은 전부 0 이다. 설정이 잘못되면 stateBreathe 가 여기서 던진다 —
  // 조용히 끄지 않는 게 이 레이어의 계약이다.
  const breatheByState: Record<string, BreatheConfig | null> = {};
  const phases: Record<string, number[]> = {};
  // 프레임별 변형 — 사이드카가 진실이고 원본 프레임은 불변이다. 합성할 때마다 다시 얹는다.
  const transformsByState: Record<string, Record<number, Transform>> = {};
  let curationApplied = false;
  for (const state of states) {
    const curation = opts.curationByState?.[state] ?? null;
    playOrder[state] = curatedSequence(framesByState[state].length, curation);
    transformsByState[state] = stateTransforms(curation?.transforms);
    if (curation && curation.selected.length > 0) curationApplied = true;
    // 선택을 안 바꾸고 위치만 맞춘 큐레이션도 "적용됨" 이다 — 아니면 재합성이
    // 사람 손을 반영했는데도 리포트가 손대지 않은 시트라고 말한다.
    if (Object.keys(transformsByState[state]).length > 0) curationApplied = true;
    const cfg = stateBreathe(curation, state);
    breatheByState[state] = cfg;
    phases[state] = cfg
      ? fitBreathePattern(playOrder[state].length, cfg)
      : new Array(playOrder[state].length).fill(0);
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
    const breatheCfg = breatheByState[state];
    // 해부는 **캐릭터 속성이라 줄 전체가 한 벌을 쓴다.** 프레임마다 다시 재면 경계가
    // 흔들려 강체 구간이 프레임 간 같은 구간이 아니게 된다.
    let rowAnatomy: Anatomy | undefined;
    const rowSourceFrames: RawImage[] = []; // 호흡 적용 **직전** 프레임 (관측용)

    // 재생 순서대로 굽는다 — col 은 아틀라스 칸이고 srcIndex 는 추출 프레임이다.
    playOrder[state].forEach((srcIndex, col) => {
      const source = frames[srcIndex];
      if (source.width !== cell.width || source.height !== cell.height) {
        errors.push(
          `${state} frame ${srcIndex} is ${source.width}x${source.height}; expected ${cell.width}x${cell.height}`,
        );
        return;
      }
      // 사람이 맞춘 변형을 먼저 얹는다 — 정본 순서가 변형 → 호흡이고, 해부도 변형 **후**
      // 프레임에서 잰다. 옮겨 놓은 프레임의 해부를 원본 위치에서 재면 강체 구간이 어긋난다.
      let frame: { data: Uint8Array; width: number; height: number } =
        transformsByState[state][srcIndex]
          ? applyTransform(source, transformsByState[state][srcIndex], cell)
          : source;
      if (breatheCfg) {
        rowSourceFrames.push(frame as RawImage);
        rowAnatomy ??= resolveAnatomy(frame, breatheCfg);
        // **위상 0 도 굽는다.** 진행파 지연(lag) 때문에 t=0 에서도 윗행은
        // wave(-lag·u) 만큼 변형된다. 건너뛰면 그 칸만 원본이 되어 아틀라스가 매 루프
        // 시작에서 튀고 GIF 굽기와 그림이 갈린다.
        frame = phaseFrame(source, breatheCfg, phases[state][col], rowAnatomy);
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
        atlasData.set(frame.data.subarray(src, src + cell.width * 4), dst);
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
      // 굽기가 실제로 쓴 해부를 남긴다 — 사이드카 캐시와 다른 값을 구웠는지 보이게.
      ...(breatheCfg
        ? { breathe: rowSourceFrames.length > 0 ? anatomyReport(rowSourceFrames, breatheCfg) : null }
        : {}),
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
