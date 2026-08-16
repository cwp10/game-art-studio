/**
 * 레이아웃 가이드 — sprite_gen/prepare.py `draw_guide()` 이식.
 *
 * 모델에게 프레임 개수·슬롯 간격·중앙 정렬·안전 여백을 보여주는 첨부 이미지다.
 * 이미지 모델이 프롬프트 문구보다 첨부 레퍼런스를 강하게 따르는 성질을 이용한다.
 *
 * SVG 가 아니라 raw 버퍼에 직접 채운다: 통과 기준이 Python 출력과의 픽셀 동일인데
 * SVG 스트로크는 경로 중심 정렬이라 PIL 의 안쪽 정렬 사각형과 반픽셀씩 어긋나고
 * 래스터라이저 AA 가 경계에 회색을 남긴다. 도형이 축 정렬 사각형과 수직선뿐이라
 * SVG 로 얻을 이득도 없다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import sharp from "sharp";
import { drawMotionPhase, stateMotionPhases } from "@/lib/sprite/motion-phase";

type RGB = readonly [number, number, number];

const BACKGROUND: RGB = [0xf6, 0xf6, 0xf6];
const CELL_BORDER: RGB = [0x33, 0x33, 0x33];
const SAFE_BORDER: RGB = [0x2f, 0x80, 0xed];
const CENTER_LINE: RGB = [0xb8, 0xc8, 0xe8];

const CELL_BORDER_WIDTH = 3;
const SAFE_BORDER_WIDTH = 2;

export type GuideCanvas = { raw: Buffer; width: number; height: number };

export type GuideCell = {
  width: number;
  height: number;
  safeMarginX: number;
  safeMarginY: number;
  /**
   * 모션 페이즈 힌트를 그릴 상태명(방향 접두사를 뗀 것). **옵트인이다** —
   * 넘기지 않으면 원본의 `motion_phase_guides=False` 와 같이 아무것도 그리지 않는다.
   * 8프레임 로코모션이 아니면 넘겨도 빈 배열이라 그려지지 않는다.
   */
  motionPhaseState?: string;
};

function fillRect(c: GuideCanvas, x0: number, y0: number, x1: number, y1: number, color: RGB): void {
  const xa = Math.max(0, x0);
  const xb = Math.min(c.width - 1, x1);
  const ya = Math.max(0, y0);
  const yb = Math.min(c.height - 1, y1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const o = (y * c.width + x) * 3;
      c.raw[o] = color[0];
      c.raw[o + 1] = color[1];
      c.raw[o + 2] = color[2];
    }
  }
}

/**
 * PIL `draw.rectangle(..., outline, width)` 의 재현.
 * 좌표는 양끝 포함이고 띠는 경계 **안쪽으로** width 픽셀 자란다.
 */
function strokeRect(
  c: GuideCanvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGB,
  width: number,
): void {
  fillRect(c, x0, y0, x1, y0 + width - 1, color); // top
  fillRect(c, x0, y1 - width + 1, x1, y1, color); // bottom
  fillRect(c, x0, y0, x0 + width - 1, y1, color); // left
  fillRect(c, x1 - width + 1, y0, x1, y1, color); // right
}

export function renderLayoutGuideBuffer(frames: number, cell: GuideCell): GuideCanvas {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`renderLayoutGuide: frames must be a positive integer (got ${frames})`);
  }
  const cellWidth = cell.width;
  const cellHeight = cell.height;
  const marginX = cell.safeMarginX;
  const marginY = cell.safeMarginY;

  const width = frames * cellWidth;
  const height = cellHeight;
  const canvas: GuideCanvas = { raw: Buffer.alloc(width * height * 3), width, height };
  fillRect(canvas, 0, 0, width - 1, height - 1, BACKGROUND);

  for (let index = 0; index < frames; index++) {
    const left = index * cellWidth;
    const right = left + cellWidth - 1;
    strokeRect(canvas, left, 0, right, height - 1, CELL_BORDER, CELL_BORDER_WIDTH);
    strokeRect(
      canvas,
      left + marginX,
      marginY,
      right - marginX,
      height - 1 - marginY,
      SAFE_BORDER,
      SAFE_BORDER_WIDTH,
    );
    // 원본의 비대칭을 그대로 옮긴다: 세로선은 marginY ~ height-marginY 인데 safe
    // 사각형의 아래 변은 height-1-marginY 라 선이 1px 더 내려간다 (prepare.py:840).
    // 의도인지 오프바이원인지는 원본에 근거가 없다. 픽셀 동일이 기준이라 유지한다.
    const centerX = left + Math.floor(cellWidth / 2);
    fillRect(canvas, centerX, marginY, centerX, height - marginY, CENTER_LINE);
  }

  // 모션 페이즈 힌트는 **박스를 다 그린 뒤** 위에 얹는다 (prepare.py:841 과 같은 순서).
  if (cell.motionPhaseState) {
    const phases = stateMotionPhases(cell.motionPhaseState, frames);
    const facing = cell.motionPhaseState.endsWith("left") ? "left" : "right";
    phases.forEach((phase, index) => {
      drawMotionPhase(canvas, index * cellWidth, cellWidth, cellHeight, phase, facing);
    });
  }
  return canvas;
}

export async function renderLayoutGuide(
  destPath: string,
  frames: number,
  cell: GuideCell,
): Promise<{ width: number; height: number }> {
  const g = renderLayoutGuideBuffer(frames, cell);
  await sharp(g.raw, { raw: { width: g.width, height: g.height, channels: 3 } })
    .png()
    .toFile(destPath);
  return { width: g.width, height: g.height };
}
