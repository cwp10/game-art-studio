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
 */
import sharp from "sharp";
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
  /** 상태 → 추출된 프레임들. 키 순서가 곧 행 순서다. */
  framesByState: Record<string, RawImage[]>;
  atlasName?: string;
  minUsedPixels?: number;
}): ComposeResult {
  const { request, framesByState } = opts;
  const cell = request.cell;
  const minUsed = opts.minUsedPixels ?? DEFAULT_MIN_USED_PIXELS;
  const states = Object.keys(framesByState);
  const errors: string[] = [];

  const columns = Math.max(1, ...states.map(s => framesByState[s].length));
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

    frames.forEach((frame, col) => {
      if (frame.width !== cell.width || frame.height !== cell.height) {
        errors.push(
          `${state} frame ${col} is ${frame.width}x${frame.height}; expected ${cell.width}x${cell.height}`,
        );
        return;
      }
      const used = alphaNonzeroCount(frame);
      if (used < minUsed) {
        errors.push(`${state} frame ${col} is too sparse (${used})`);
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
