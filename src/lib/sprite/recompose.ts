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
import sharp from "sharp";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { composeAtlas, writeAtlas } from "@/lib/sprite/atlas";
import { extractRowFrames, type RawImage } from "@/lib/sprite/extract";
import type { SpriteRequest } from "@/lib/sprite/request";
import { pixelUnfakeOptions } from "@/lib/sprite/pixel-unfake";
import {
  buildSelectedCycleManifest,
  labeledContactSheet,
} from "@/lib/sprite/selected-cycle";
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
      // 재합성은 원래 굽던 것과 **같은 알파**를 내야 한다. 저장된
      // `request.chroma.mode` 를 믿지 않고 다시 판정하는 이유: 그 필드는 런에 한
      // 벌뿐이라 행마다 경로가 갈렸으면 마지막 값만 남는다. 판정은 이미지의 순수
      // 함수라(`decideChromaMode`) 같은 행에는 같은 답이 나온다 — 재판정이 저장값
      // 보다 정확하다.
      chromaMode: "auto",
      chroma: {
        keyThreshold: request.chroma.keyThreshold,
        unmixReach: request.chroma.unmixReach,
        spillMaxFraction: request.chroma.spillMaxFraction,
      },
      // 재합성은 처음 구울 때와 같은 프레임을 내야 한다 — 분리 모드·언페이크도 따라간다.
      ...(request.fit ? { fit: request.fit } : {}),
      ...pixelUnfakeOptions(request),
      label: state,
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

  // 선택 사이클 QA 산출물 — 사람이 고른 프레임만의 라벨 시트와 그 기록.
  // 아틀라스가 본 계약이고 이건 곁다리라, 실패해도 재합성을 막지 않고 사유만 남긴다.
  const cycleNotes = await writeSelectedCycles({
    atlasParams: atlas.params ?? {},
    states,
    framesByState,
    curationByState,
    request,
  });

  const params = {
    ...atlas.params,
    cols: composed.manifest.animation.columns,
    manifest: composed.manifest,
    curationApplied: composed.manifest.curation_applied,
    // 파생 캐시가 언제 다시 구워졌는지 — 편집 반영본과 편집 전 산출물을 사후에 구분한다.
    recomposedAt: new Date().toISOString(),
    ...(cycleNotes.length > 0 ? { selectedCycleNotes: cycleNotes } : {}),
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

/**
 * 상태별 선택 사이클 산출물을 QA 디렉터리에 쓴다 → 문제가 있었던 것들의 사유 목록.
 *
 * 정본 `compose_cycle` 은 CLI 로 따로 부르지만 우리는 큐레이션 저장이 곧 재합성이라
 * 그 자리에 얹는다 — 정본도 `--frames` 를 안 주면 큐레이션 선택을 쓰므로 같은 입력이다.
 *
 * sha256 은 **디스크의 원본 프레임 파일**에서 뽑는다. 재합성은 원시 스트립에서 다시
 * 추출하므로 메모리의 프레임과 디스크 파일이 다를 수 있다 — 파일이 없으면 그 상태는
 * 건너뛰고 사유를 남긴다. 없는 해시를 지어내지 않는다.
 */
async function writeSelectedCycles(opts: {
  atlasParams: Record<string, unknown>;
  states: string[];
  framesByState: Record<string, RawImage[]>;
  curationByState: Record<string, { selected: number[] } | null | undefined>;
  request: SpriteRequest;
}): Promise<string[]> {
  const notes: string[] = [];
  const motionQa = opts.atlasParams.motionQa as { qaDir?: string } | undefined;
  const qaDir = motionQa?.qaDir;
  if (!qaDir) return ["qaDir 를 몰라 선택 사이클을 쓰지 않았습니다 (모션 QA 기록 없음)"];
  const runDir = dirname(qaDir);

  for (const state of opts.states) {
    try {
      const frames = opts.framesByState[state] ?? [];
      if (frames.length === 0) continue;
      const selected = opts.curationByState[state]?.selected ?? [];
      // 큐레이션이 없거나 비어 있으면 전체가 선택이다 (명시적 기본값).
      const zeroBased = selected.length > 0 ? selected : frames.map((_, i) => i);
      const framePaths = zeroBased.map(i => join(runDir, `frames-${state}`, `frame-${i}.png`));
      const missing = framePaths.filter(p => !existsSync(p));
      if (missing.length > 0) {
        notes.push(`${state}: 원본 프레임 파일이 없어 건너뜀 (${missing.length}/${framePaths.length}장)`);
        continue;
      }
      const sheet = labeledContactSheet(
        zeroBased.map(i => ({ number: i + 1, image: frames[i] })),
      );
      const contactPath = join(qaDir, `${state}-cycle-contact.png`);
      await writeRgbSheet(sheet, contactPath);
      const fps = opts.request.states[state]?.fps || 6;
      const manifest = await buildSelectedCycleManifest({
        state,
        name: `${state}-cycle`,
        userFrames: zeroBased.map(i => i + 1),
        framePaths,
        selectionSource: "curation",
        durationMs: Math.max(1, Math.round(1000 / fps)),
        contactPath,
      });
      await writeFile(
        join(qaDir, `${state}-cycle.json`),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
    } catch (e) {
      notes.push(`${state}: ${(e as Error).message}`);
    }
  }
  return notes;
}

async function writeRgbSheet(sheet: RawImage, destPath: string): Promise<void> {
  await sharp(sheet.data, { raw: { width: sheet.width, height: sheet.height, channels: 3 } })
    .png()
    .toFile(destPath);
}
