/**
 * 큐레이션 반영 재합성 — 정본 Output Contract 의 경계를 실제로 긋는다.
 *
 * *"Install from `curated/`, never from `frames/`."* `frames/` 는 큐레이션 이전이고,
 * 사람의 선택은 사이드카에 있다가 **합성 시점에** 적용된다. 정본은 큐레이션 후
 * `compose_sprite_atlas.py` 를 다시 돌려 아틀라스와 매니페스트를 다시 굽는다. 그 단계가
 * 없으면 편집 전 산출물이 조용히 배포된다(실사고 2026-07-26: 손으로 고친 191픽셀이
 * 누락되고 "적용됨" 으로 보고).
 *
 * 우리 구조 대응:
 *   진실  = 행 generation 의 raw 시트 + 그 행에 저장된 큐레이션
 *   파생  = 아틀라스 PNG + 매니페스트  ← 매번 진실에서 다시 굽는다
 *
 * 그래서 아틀라스 이미지를 **제자리에서 덮어쓴다.** 원본 행 시트는 건드리지 않는다.
 * 프레임도 저장된 경로가 아니라 raw 시트에서 다시 추출한다 — 앵커 베이크와 같은 원칙이다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import { composeAtlas, writeAtlas } from "@/lib/sprite/atlas";
import { extractRowFrames, type RawImage } from "@/lib/sprite/extract";
import type { SpriteRequest } from "@/lib/sprite/request";
import { getCuration, getGeneration, setGenerationDimensions } from "@/lib/db/repo/generations";
import { getDb } from "@/lib/db/client";
import { resolveImagePath } from "@/lib/util/paths";

export type RecomposeResult = {
  generationId: string;
  width: number;
  height: number;
  columns: number;
  curationApplied: boolean;
  /** 상태 → 최종 재생 프레임 수(큐레이션 반영). */
  frameCounts: Record<string, number>;
};

/**
 * 아틀라스 generation 을 큐레이션 반영본으로 다시 굽는다.
 *
 * 플랜 구동 시트가 아니거나 request 기록이 없으면 **던진다** — 조용히 편집 전 시트를
 * 남기지 않는다.
 */
export async function recomposeCuratedAtlas(atlasGenerationId: string): Promise<RecomposeResult> {
  const atlas = getGeneration(atlasGenerationId);
  if (!atlas) throw new Error(`recompose: generation ${atlasGenerationId} 없음`);

  const request = atlas.params?.request as SpriteRequest | undefined;
  const rowIds = atlas.params?.rowGenerationIds as Record<string, string> | undefined;
  if (!request || !rowIds) {
    throw new Error(
      `recompose: ${atlasGenerationId} 는 플랜 구동 시트가 아니거나 request 를 기록하지 ` +
        `않았습니다 — 큐레이션을 반영하려면 시트를 다시 생성해야 합니다`,
    );
  }

  // 상태 순서는 굽던 그 순서를 유지한다 — 행 인덱스가 바뀌면 매니페스트 소비자가 깨진다.
  const states = (atlas.params?.states as string[] | undefined) ?? Object.keys(rowIds);

  const framesByState: Record<string, RawImage[]> = {};
  const curationByState: Record<string, ReturnType<typeof getCuration>> = {};
  for (const state of states) {
    const rowId = rowIds[state];
    const rowGen = rowId ? getGeneration(rowId) : null;
    if (!rowGen?.image_path) {
      throw new Error(`recompose: 상태 '${state}' 의 행 generation(${rowId}) 을 찾을 수 없습니다`);
    }
    const extracted = await extractRowFrames({
      sheetPath: resolveImagePath(rowGen.image_path),
      frameCount: request.states[state]?.frames ?? 0,
      cell: request.cell,
      chromaKey: request.chromaKey.rgb,
      chroma: {
        keyThreshold: request.chroma.keyThreshold,
        unmixReach: request.chroma.unmixReach,
        spillMaxFraction: request.chroma.spillMaxFraction,
      },
    });
    framesByState[state] = extracted.frames;
    curationByState[state] = getCuration(rowId);
  }

  const composed = composeAtlas({ request, framesByState, curationByState });
  if (composed.errors.length > 0) {
    throw new Error(`recompose: 아틀라스 합성 실패 — ${composed.errors.join("; ")}`);
  }

  await writeAtlas(composed.atlas, resolveImagePath(atlas.image_path!));

  const frameCounts: Record<string, number> = {};
  for (const state of states) {
    frameCounts[state] = composed.manifest.animation.rows[state]?.frames ?? 0;
  }

  const params = {
    ...atlas.params,
    cols: composed.manifest.animation.columns,
    manifest: composed.manifest,
    curationApplied: composed.manifest.curation_applied,
    // 파생 캐시가 언제 다시 구워졌는지 — 편집 반영본과 편집 전 산출물을 사후에 구분한다.
    recomposedAt: new Date().toISOString(),
  };
  getDb()
    .prepare("UPDATE generations SET params = ? WHERE id = ?")
    .run(JSON.stringify(params), atlas.id);
  setGenerationDimensions(atlas.id, composed.atlas.width, composed.atlas.height);

  return {
    generationId: atlas.id,
    width: composed.atlas.width,
    height: composed.atlas.height,
    columns: composed.manifest.animation.columns,
    curationApplied: composed.manifest.curation_applied,
    frameCounts,
  };
}
