// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `compose_cycle.py` 이식 — QA 가 고른 프레임 부분집합의 선택 사이클.
// 원본: sprite-gen/sprite_gen/compose_cycle.py (Apache-2.0)

/**
 * 사람이 고른 프레임만으로 **선택 사이클** 산출물을 만든다.
 *
 * 생성이 큰 행을 내놨는데 모션 QA 결과 일부만 쓸 만한 경우를 위한 것이다. 원본
 * 프레임 파일은 그대로 두고(비파괴), 선택 내역을 담은 매니페스트와 라벨 접촉 시트만
 * 새로 쓴다.
 *
 * ## 우리 구조에서 이식한 범위
 *
 * 정본은 여기서 GIF 도 굽지만 우리는 `SpriteCanvas` 가 이미 선택 프레임(`playIndices`)
 * 으로 GIF 를 만든다 — 중복을 만들지 않는다. 정본의 변형·픽셀 편집 계층
 * (`apply_transform`·`apply_pixel_edits`·`frame_variant`)도 우리 큐레이션에 없어
 * 빠진다. 남는 것은 정본에만 있던 둘이다:
 *
 * 1. **라벨 접촉 시트** — 칸마다 프레임 번호가 찍힌 QA 시트. 우리 `contactSheet` 는
 *    라벨이 없어 "몇 번 프레임이 문제인지" 를 시트만 보고 못 짚는다.
 * 2. **선택 사이클 매니페스트** — 어떤 프레임을 골라 무엇을 만들었는지 + 원본 프레임의
 *    sha256. 큐레이션은 "지금 무엇이 선택돼 있나" 라는 시점 상태이고, 이건 "이 산출물이
 *    어느 원본에서 나왔나" 라는 **산출물에 묶인 기록**이라 서로 대체하지 못한다.
 *
 * 라벨 글리프는 정본과 다르다. 정본은 PIL 기본 폰트(Pillow 12 부터 내장 FreeType)를
 * 쓰는데 TS 에서 비트 동일하게 재현할 방법이 없다. **레이아웃은 픽셀 동일**하게 두고
 * 글자만 자체 5x7 비트맵으로 그린다 — 외부 폰트 의존이 없어 결정론이 유지된다.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type RawImage = { data: Buffer; width: number; height: number };

/** 정본 `contact_sheet` 기본값. */
export const CYCLE_GAP = 4;
export const CYCLE_LABEL_HEIGHT = 24;

/**
 * `--frames` 파싱 — 1-based 프레임 번호 목록.
 *
 * 정본과 같은 거부 조건이다: 비어 있으면 안 되고, 0 이나 음수도 안 된다. 조용히
 * 걸러내지 않고 던진다 — "2,0,4" 를 [2,4] 로 받으면 사용자가 고른 것과 다른 사이클이
 * 구워진다.
 */
export function parseFrames(value: string): number[] {
  const frames = value
    .split(",")
    .filter(part => part.trim() !== "")
    .map(part => {
      const n = Number(part.trim());
      if (!Number.isInteger(n)) {
        throw new Error(`invalid frame number: ${JSON.stringify(part.trim())}`);
      }
      return n;
    });
  if (frames.length === 0) throw new Error("at least one frame number is required");
  if (frames.some(f => f <= 0)) {
    throw new Error("frame numbers are 1-based and must be positive");
  }
  return frames;
}

// ── 체커보드 배경 (정본 checker/flatten 과 같은 값) ──────────────────

function checker(width: number, height: number, square = 16): Buffer {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      const v = light ? 235 : 210;
      const i = (y * width + x) * 3;
      out[i] = v; out[i + 1] = v; out[i + 2] = v;
    }
  }
  return out;
}

/** 알파를 체커보드 위에 얹어 RGB 로 — 투명 영역이 눈에 보이게. */
function flattenRgb(frame: RawImage): Buffer {
  const out = checker(frame.width, frame.height);
  for (let p = 0; p < frame.width * frame.height; p++) {
    const s = p * 4;
    const a = frame.data[s + 3];
    if (a === 0) continue;
    const d = p * 3;
    if (a === 255) {
      out[d] = frame.data[s]; out[d + 1] = frame.data[s + 1]; out[d + 2] = frame.data[s + 2];
      continue;
    }
    // PIL alpha_composite 의 정수식 (대상이 불투명이라 outa255 = 255*255).
    const coef1 = a * 128;
    const coef2 = 255 * 128 - coef1;
    for (let c = 0; c < 3; c++) {
      const tmp = frame.data[s + c] * coef1 + out[d + c] * coef2 + (0x80 << 7);
      out[d + c] = (((tmp >> 8) + tmp) >> 8) >> 7;
    }
  }
  return out;
}

// ── 5x7 비트맵 폰트 (라벨 전용) ──────────────────────────────────────

/**
 * `frame N` 라벨에 필요한 글자만 담은 5x7 비트맵.
 *
 * 각 문자는 7개 행이고 행마다 하위 5비트가 좌→우 픽셀이다. 외부 폰트를 쓰지 않는
 * 이유는 결정론이다 — 시스템 폰트에 의존하면 기계마다 다른 시트가 나온다.
 */
const GLYPHS: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  f: [0b00110, 0b01001, 0b01000, 0b11110, 0b01000, 0b01000, 0b01000],
  r: [0b00000, 0b00000, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
  a: [0b00000, 0b00000, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
  m: [0b00000, 0b00000, 0b11010, 0b10101, 0b10101, 0b10101, 0b10101],
  e: [0b00000, 0b00000, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

/** 시트(RGB)에 라벨을 그린다. 없는 글자는 건너뛴다 — 라벨은 QA 보조지 계약이 아니다. */
function drawLabel(
  sheet: RawImage,
  text: string,
  left: number,
  top: number,
  color: [number, number, number],
): void {
  let x = left;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (!(glyph[gy] & (1 << (4 - gx)))) continue;
          const px = x + gx;
          const py = top + gy;
          if (px < 0 || px >= sheet.width || py < 0 || py >= sheet.height) continue;
          const i = (py * sheet.width + px) * 3;
          sheet.data[i] = color[0];
          sheet.data[i + 1] = color[1];
          sheet.data[i + 2] = color[2];
        }
      }
    }
    x += 6;
  }
}

/**
 * 칸마다 프레임 번호가 찍힌 접촉 시트.
 *
 * 레이아웃은 정본 `contact_sheet` 와 같다 — 칸 크기는 최대 프레임 크기, 위쪽에
 * `labelHeight` 만큼 어두운 라벨 띠, 사이와 바깥에 `gap`. 시트 배경은 흰색이다.
 */
export function labeledContactSheet(
  frames: Array<{ number: number; image: RawImage }>,
  gap = CYCLE_GAP,
  labelHeight = CYCLE_LABEL_HEIGHT,
): RawImage {
  if (frames.length === 0) throw new Error("labeledContactSheet: 프레임이 없습니다");
  const cellW = Math.max(...frames.map(f => f.image.width));
  const cellH = Math.max(...frames.map(f => f.image.height));
  const width = frames.length * cellW + (frames.length + 1) * gap;
  const height = cellH + labelHeight + gap * 2;
  const sheet: RawImage = { data: Buffer.alloc(width * height * 3, 255), width, height };

  let x = gap;
  for (const { number, image } of frames) {
    // 라벨 띠 (정본과 같은 색·같은 사각형 범위).
    for (let y = gap; y < gap + labelHeight; y++) {
      for (let px = x; px < x + cellW; px++) {
        const i = (y * width + px) * 3;
        sheet.data[i] = 24; sheet.data[i + 1] = 24; sheet.data[i + 2] = 24;
      }
    }
    drawLabel(sheet, `frame ${number}`, x + 6, gap + 5, [255, 255, 255]);
    // 프레임 (체커보드 위에 얹어서).
    const flat = flattenRgb(image);
    for (let y = 0; y < image.height; y++) {
      const s = y * image.width * 3;
      const d = ((gap + labelHeight + y) * width + x) * 3;
      flat.copy(sheet.data, d, s, s + image.width * 3);
    }
    x += cellW + gap;
  }
  return sheet;
}

// ── 선택 사이클 매니페스트 ───────────────────────────────────────────

export type SelectedCycleSource = {
  user_frame: number;
  zero_based_frame: number;
  path: string;
  sha256: string;
};

export type SelectedCycleManifest = {
  version: 1;
  kind: "sprite-gen-selected-cycle";
  state: string;
  name: string;
  selected_user_frames: number[];
  selected_zero_based_frames: number[];
  selection_source: "explicit-frames" | "curation";
  duration_ms: number;
  delay_ticks: number;
  loop: boolean;
  note?: string;
  outputs: { contact: string };
  source_frames: SelectedCycleSource[];
};

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * 선택 사이클 매니페스트를 만든다 — **산출물에 묶인 기록**이다.
 *
 * 큐레이션(`curation.selected`)은 "지금 무엇이 선택돼 있나" 라는 시점 상태라 나중에
 * 바뀐다. 이 매니페스트는 "이 시트가 어느 프레임 파일에서 나왔나" 를 해시까지 붙여
 * 고정하므로, 나중에 큐레이션이 바뀌어도 그때 무엇을 봤는지 되짚을 수 있다.
 *
 * `userFrames` 는 **1-based** 다 (정본과 같다). 0-based 인덱스는 파생 필드로 함께 싣는다.
 */
export async function buildSelectedCycleManifest(opts: {
  state: string;
  name: string;
  userFrames: number[];
  framePaths: string[];
  selectionSource: "explicit-frames" | "curation";
  durationMs: number;
  contactPath: string;
  note?: string;
}): Promise<SelectedCycleManifest> {
  if (opts.userFrames.length !== opts.framePaths.length) {
    throw new Error(
      `buildSelectedCycleManifest: 프레임 번호 ${opts.userFrames.length}개와 경로 ${opts.framePaths.length}개가 어긋납니다`,
    );
  }
  const sources: SelectedCycleSource[] = [];
  for (let i = 0; i < opts.userFrames.length; i++) {
    sources.push({
      user_frame: opts.userFrames[i],
      zero_based_frame: opts.userFrames[i] - 1,
      path: opts.framePaths[i],
      sha256: await sha256File(opts.framePaths[i]),
    });
  }
  return {
    version: 1,
    kind: "sprite-gen-selected-cycle",
    state: opts.state,
    name: opts.name,
    selected_user_frames: opts.userFrames,
    selected_zero_based_frames: opts.userFrames.map(f => f - 1),
    selection_source: opts.selectionSource,
    duration_ms: opts.durationMs,
    delay_ticks: Math.round(opts.durationMs / 10),
    loop: true,
    ...(opts.note ? { note: opts.note } : {}),
    outputs: { contact: opts.contactPath },
    source_frames: sources,
  };
}
