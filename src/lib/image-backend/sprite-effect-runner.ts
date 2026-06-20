import fs from "node:fs/promises";
import { getGeneration, createGeneration } from "../db/repo/generations";
import { newGenerationId } from "../util/ids";
import {
  IMAGES_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  toRelative,
  resolveImagePath,
} from "../util/paths";
import {
  applySpritesheetEffect,
  type SpriteEffect,
  type SpriteEffectParams,
} from "./sprite-effect";

/**
 * 스프라이트 이펙트 공통 오케스트레이터. Next 라우트(/api/sprite-effect)와 MCP 도구
 * (apply_sprite_effect)가 동일 계약을 공유한다. HTTP 우회 없음 — 두 호출자가 직접 이 함수를 부른다.
 *
 * 책임: generationId 조회 → kind='spritesheet' 검증 → cols/rows 해석 → applySpritesheetEffect
 * 호출 → generation 행 작성. cols/rows 는 generation.params 우선, 없으면 params 인자에서.
 */

export interface RunSpriteEffectParams {
  generationId: string;
  effect: SpriteEffect;
  params?: SpriteEffectParams;
  sessionId?: string | null;
  cols?: number;
  rows?: number;
}

export interface SpriteEffectResult {
  generationId: string;
  imagePath: string; // /api/images/{id}
  width: number;
  height: number;
}

export async function runSpriteEffect(params: RunSpriteEffectParams): Promise<SpriteEffectResult> {
  const { generationId, effect, sessionId } = params;
  const effectParams = params.params ?? {};

  // 1. generationId 조회 → kind='spritesheet' 검증 → 파일 경로.
  const gen = getGeneration(generationId);
  if (!gen) {
    throw new Error(`generation not found: ${generationId}`);
  }
  if (gen.kind !== "spritesheet") {
    throw new Error(`generation kind must be 'spritesheet', got '${gen.kind}'`);
  }

  // 2. cols/rows: generation.params 우선, 없으면 params 인자.
  const paramCols = typeof gen.params.cols === "number" ? (gen.params.cols as number) : undefined;
  const paramRows = typeof gen.params.rows === "number" ? (gen.params.rows as number) : undefined;
  const cols = paramCols ?? (typeof params.cols === "number" ? params.cols : undefined);
  const rows = paramRows ?? (typeof params.rows === "number" ? params.rows : undefined);
  if (!cols || !rows) {
    throw new Error("cols/rows not found in generation.params and not provided in params");
  }

  ensureDataDirs();
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const newId = newGenerationId();
  const outPath = imagePathFor(newId);

  // 3. applySpritesheetEffect 호출.
  const result = await applySpritesheetEffect({
    inputPath: resolveImagePath(gen.image_path),
    effect,
    effectParams,
    cols,
    rows,
    outPath,
  });

  // 4. generation 행 작성 (kind='sprite_effect', backend='direct').
  createGeneration({
    id: newId,
    session_id: sessionId ?? null,
    message_id: null,
    kind: "sprite_effect",
    backend: "direct",
    prompt: `스프라이트 이펙트 (${effect})`,
    input_image_ids: [generationId],
    params: { effect, effectParams, cols, rows },
    image_path: toRelative(outPath),
    width: result.width,
    height: result.height,
  });

  // 5. 결과 반환.
  return {
    generationId: newId,
    imagePath: `/api/images/${newId}`,
    width: result.width,
    height: result.height,
  };
}
