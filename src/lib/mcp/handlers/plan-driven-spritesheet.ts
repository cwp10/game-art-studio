/**
 * 플랜 구동 스프라이트시트 — sprite-gen component-row 엔진 경로.
 *
 *   base 잠금 → 방향 앵커 행 생성 → 앵커 베이크 → 액션 행 생성
 *   → 컴포넌트 추출(크로마 3패스 + 연결 컴포넌트 + fit_to_cell) → 아틀라스 합성
 *
 * `handleMakeSpritesheet` 가 **적용 가능할 때만** 여기로 보낸다(캐릭터 + 단일 방향 +
 * 참조 이미지). 이펙트·오브젝트·다방향 시트는 기존 경로가 그대로 처리한다 — 정본의
 * component-row 엔진도 캐릭터 상태 행을 위한 것이고 변형 시트는 별도 경로다.
 *
 * 생성 호출이 2회다(앵커 행 + 액션 행). 기존 경로의 2배이며, 그 대가로 액션 행이
 * base 가 아니라 **앵커**에서 정체성을 받는다.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { composeAtlas, writeAtlas } from "@/lib/sprite/atlas";
import { buildSpriteRequest } from "@/lib/sprite/build-request";
import { runSpritePlan, type GenerateFn } from "@/lib/sprite/run-plan";
import type { RawImage } from "@/lib/sprite/extract";
import sharp from "sharp";
import { createGeneration, getLockedBase, lockBaseGeneration } from "../../db/repo/generations.js";
import { DATA_DIR, imagePath, toRelative } from "../../util/paths.js";
import { newGenerationId } from "../../util/ids.js";
import {
  loadGenerationWithPath,
  runImageTool,
  type HandlerContext,
  type HandlerExtra,
  type ToolResponse,
} from "./shared.js";

export type PlanDrivenInput = {
  /** 잠글 base generation (패널의 참조 이미지). */
  baseGenerationId: string;
  characterId: string;
  description: string;
  /** SpriteGenPanel 의 Direction 값. */
  uiDirection: string;
  frames: number;
  loop: boolean;
  actionPrompt: string;
};

/**
 * 이 경로를 쓸 수 있는가. 정본의 component-row 엔진 적용 범위와 같다.
 * 하나라도 어긋나면 기존 경로가 처리한다.
 */
export function canUsePlanDrivenPath(opts: {
  subjectType: string;
  directions: number | null;
  refId: string | null;
}): boolean {
  if (opts.subjectType !== "character") return false;
  if (opts.directions !== null && opts.directions > 1) return false;
  if (!opts.refId) return false;
  return true;
}

export async function runPlanDrivenSpritesheet(
  input: PlanDrivenInput,
  extra: HandlerExtra,
  ctx: HandlerContext,
): Promise<ToolResponse> {
  const { log, sessionId } = ctx;
  const t0 = Date.now();

  // ① base 잠금 — 약한 base 는 모든 행을 오염시킨다.
  if (getLockedBase(sessionId)?.id !== input.baseGenerationId) {
    lockBaseGeneration(input.baseGenerationId, sessionId);
    log(`plan-driven: base 잠금 ${input.baseGenerationId}`);
  }
  const { filePath: basePath } = loadGenerationWithPath(input.baseGenerationId);

  const workDir = path.join(DATA_DIR, "sprite-runs", `${input.characterId}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const { request, warnings } = await buildSpriteRequest({
    characterId: input.characterId,
    description: input.description,
    baseImagePath: basePath,
    uiDirection: input.uiDirection,
    frames: input.frames,
    loop: input.loop,
    actionPrompt: input.actionPrompt,
  });
  for (const w of warnings) log(`plan-driven 경고: ${w}`);
  log(
    `plan-driven: 크로마 ${request.chromaKey.name} ${request.chromaKey.hex} ` +
      `(${request.chromaKey.selection}), 상태 ${Object.keys(request.states).join(", ")}`,
  );

  const stateOrder = Object.keys(request.states);
  const generate: GenerateFn = async spec => {
    const step = stateOrder.indexOf(spec.state) + 1;
    const res = await runImageTool({
      name: "sprite_row",
      kind: "spritesheet",
      prompt: spec.prompt,
      inputGenerationIds: [],
      overrideInputPaths: spec.inputPaths,
      params: { rawPrompt: true, state: spec.state, role: spec.role, planDriven: true },
      signal: extra.signal,
      sessionId,
      progressPrefix: `${spec.role} ${step}/${stateOrder.length}`,
    });
    const s = res.structuredContent;
    const { filePath } = loadGenerationWithPath(s.generationId);
    return {
      generationId: s.generationId,
      imagePath: filePath,
      width: s.width,
      height: s.height,
    };
  };

  const result = await runSpritePlan(request, {
    generate,
    workDir,
    lockedBasePath: basePath,
    log: m => log(`plan-driven: ${m}`),
  });
  for (const w of result.warnings) log(`plan-driven 경고: ${w}`);

  // 추출된 프레임을 상태 순서대로 읽어 아틀라스를 합성한다.
  const framesByState: Record<string, RawImage[]> = {};
  for (const state of stateOrder) {
    const row = result.rows[state];
    if (!row) continue;
    const frames: RawImage[] = [];
    for (const p of row.framePaths) {
      const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      frames.push({ data, width: info.width, height: info.height });
    }
    framesByState[state] = frames;
  }

  const composed = composeAtlas({ request, framesByState });
  if (composed.errors.length > 0) {
    throw new Error(`아틀라스 합성 실패: ${composed.errors.join("; ")}`);
  }

  const atlasId = newGenerationId();
  const atlasPath = imagePath(atlasId);
  await writeAtlas(composed.atlas, atlasPath);

  const states = Object.keys(framesByState);
  const gen = createGeneration({
    id: atlasId,
    session_id: sessionId,
    message_id: null,
    kind: "spritesheet",
    prompt: input.actionPrompt,
    input_image_ids: [input.baseGenerationId],
    params: {
      // SpriteCanvas 가 셀을 자를 때 쓰는 기하.
      rows: states.length,
      cols: composed.manifest.animation.columns,
      cellW: request.cell.width,
      cellH: request.cell.height,
      fps: composed.manifest.animation.rows[states[0]]?.fps ?? 6,
      // 신 경로임을 기록 — 구/신 산출물을 사후에 구분할 수 있어야 한다.
      engine: "component-row",
      planDriven: true,
      states,
      rowGenerationIds: Object.fromEntries(states.map(s => [s, result.rows[s].generationId])),
      extraction: Object.fromEntries(states.map(s => [s, result.rows[s].method])),
      anchors: result.anchors,
      manifest: composed.manifest,
      warnings: result.warnings,
    },
    image_path: toRelative(atlasPath),
    width: composed.atlas.width,
    height: composed.atlas.height,
    backend: "codex_exec",
  });

  const elapsedMs = Date.now() - t0;
  log(
    `plan-driven done gen=${gen.id} ${composed.atlas.width}x${composed.atlas.height} ` +
      `states=${states.join(",")} ${elapsedMs}ms`,
  );

  return {
    content: [
      {
        type: "text",
        text:
          `Generated component-row sprite sheet ${gen.id} ` +
          `(${composed.atlas.width}×${composed.atlas.height}, ${states.length} rows × ` +
          `${composed.manifest.animation.columns} frames, ${(elapsedMs / 1000).toFixed(1)}s). ` +
          `Rows: ${states.join(", ")}. Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width: composed.atlas.width,
      height: composed.atlas.height,
      kind: "spritesheet",
      elapsedMs,
    },
  };
}
