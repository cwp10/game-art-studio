import fs from "node:fs/promises";
import sharp from "sharp";
import { getGeneration, createGeneration } from "../db/repo/generations";
import { newGenerationId } from "../util/ids";
import {
  IMAGES_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  toRelative,
  resolveImagePath,
} from "../util/paths";
import { mergeImages, type LayerFilters } from "./composite-layers";

/**
 * 씬 합성 공통 오케스트레이터. Next 라우트(/api/composite)와 MCP 도구(composite_scene)가
 * 동일 계약을 공유하도록 핵심 실행을 한 곳에 둔다. HTTP 우회 없음 — 두 호출자가 직접 이 함수를 부른다.
 *
 * 책임: generationId → 파일 경로 해석, 출력 크기 폴백, mergeImages 호출, generation 행 작성.
 * 입력 검증(존재/형식)은 호출자(라우트)에 남기되, 이 함수도 getGeneration 으로 한 번 더 확인해
 * MCP 경로(라우트 검증 없음)에서 명확한 에러를 throw 한다.
 */

export interface CompositeLayerSpec {
  generationId: string;
  opacity?: number; // 0-100, 기본 100
  x?: number; // 중앙 기준 오프셋 px
  y?: number;
  scale?: number; // 1.0 = contain-fit
  rotation?: number; // 회전 각도 도(°), 기본 0
  flipH?: boolean; // 좌우반전, 기본 false
  stretchW?: number; // 가로 늘이기 배수, 기본 1 (scale 과 곱해짐)
  stretchH?: number; // 세로 늘이기 배수, 기본 1
  filters?: LayerFilters; // 색보정(밝기/채도/색조/대비/흐림), 중립이면 패스
}

export interface RunCompositeParams {
  layers: CompositeLayerSpec[];
  sessionId?: string | null;
  outputWidth?: number;
  outputHeight?: number;
}

export interface CompositeResult {
  generationId: string;
  imagePath: string; // /api/images/{id}
  width: number;
  height: number;
}

export async function runComposite(params: RunCompositeParams): Promise<CompositeResult> {
  const { layers, sessionId, outputWidth: reqWidth, outputHeight: reqHeight } = params;

  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error("layers must be a non-empty array");
  }

  // 1. generationId → 절대 파일 경로 해석.
  const resolved: {
    imagePath: string;
    opacity: number;
    generationId: string;
    x?: number;
    y?: number;
    scale?: number;
    rotation?: number;
    flipH?: boolean;
    stretchW?: number;
    stretchH?: number;
    filters?: LayerFilters;
  }[] = [];
  for (const [i, l] of layers.entries()) {
    if (!l.generationId) {
      throw new Error(`layers[${i}].generationId required`);
    }
    const gen = getGeneration(l.generationId);
    if (!gen) {
      throw new Error(`generation not found: ${l.generationId}`);
    }
    const opacity = typeof l.opacity === "number" ? l.opacity : 100;
    resolved.push({
      imagePath: resolveImagePath(gen.image_path),
      opacity,
      generationId: l.generationId,
      x: typeof l.x === "number" ? l.x : undefined,
      y: typeof l.y === "number" ? l.y : undefined,
      scale: typeof l.scale === "number" ? l.scale : undefined,
      rotation: typeof l.rotation === "number" ? l.rotation : undefined,
      flipH: typeof l.flipH === "boolean" ? l.flipH : undefined,
      stretchW: typeof l.stretchW === "number" ? l.stretchW : undefined,
      stretchH: typeof l.stretchH === "number" ? l.stretchH : undefined,
      filters: l.filters,
    });
  }

  // 2. 출력 크기 미지정 시 첫 레이어 이미지의 실제 크기로 폴백.
  let outputWidth = reqWidth;
  let outputHeight = reqHeight;
  if (!outputWidth || !outputHeight) {
    const meta = await sharp(resolved[0].imagePath).metadata();
    outputWidth = meta.width ?? 0;
    outputHeight = meta.height ?? 0;
  }
  if (!outputWidth || !outputHeight) {
    throw new Error("could not determine output dimensions");
  }

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  // 3. mergeImages 호출.
  const newId = newGenerationId();
  const outPath = imagePathFor(newId);
  const { width, height } = await mergeImages({
    layers: resolved.map((r) => ({
      imagePath: r.imagePath,
      opacity: r.opacity,
      x: r.x,
      y: r.y,
      scale: r.scale,
      rotation: r.rotation,
      flipH: r.flipH,
      stretchW: r.stretchW,
      stretchH: r.stretchH,
      filters: r.filters,
    })),
    outputWidth,
    outputHeight,
    outPath,
  });

  // 4. generation 행 작성 (kind='composite', backend='direct').
  createGeneration({
    id: newId,
    session_id: sessionId ?? null,
    message_id: null,
    kind: "composite",
    backend: "direct",
    prompt: `씬 합성 (${layers.length}개 레이어)`,
    input_image_ids: resolved.map((r) => r.generationId),
    params: { layers, outputWidth, outputHeight },
    image_path: toRelative(outPath),
    width,
    height,
  });

  // 5. 결과 반환.
  return {
    generationId: newId,
    imagePath: `/api/images/${newId}`,
    width,
    height,
  };
}
