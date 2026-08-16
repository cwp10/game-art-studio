/**
 * 플랜 실행기 — ③의 buildGenerationPlan 순서대로 생성을 몬다.
 *
 *   stage 1: base → 방향 앵커 행
 *   (앵커 베이크 — 매 행 생성 직전에 다시 굽는다: 파생 캐시)
 *   stage 2: 앵커 → 액션 행    ← base 는 여기 붙지 않는다
 *
 * 생성 함수를 주입받으므로 codex 를 모른다. 순서·ref 계약·베이크 시점이 결정론이라
 * 가짜 생성기로 전부 검증된다. 실제 codex 는 scripts/gen-sprite-run.ts 가 주입한다.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AnchorUnavailable,
  resolveAnchor,
  type AnchorContext,
  type AnchorRow,
} from "@/lib/sprite/anchor";
import { ANCHOR_SCALE, bakeAnchorImage } from "@/lib/sprite/anchor-image";
import { extractRowFrames, writeRaw } from "@/lib/sprite/extract";
import {
  buildGenerationPlan,
  type MirroredDirection,
  type PlanItem,
} from "@/lib/sprite/generation-plan";
import { renderLayoutGuide } from "@/lib/sprite/layout-guide";
import { buildRowPrompt } from "@/lib/sprite/row-prompt";
import type { SpriteRequest } from "@/lib/sprite/request";

export type GenerateFn = (spec: {
  state: string;
  prompt: string;
  inputPaths: string[];
  role: PlanItem["role"];
}) => Promise<{ generationId: string; imagePath: string; width: number; height: number }>;

export type RunPlanDeps = {
  generate: GenerateFn;
  /** 가이드·앵커 파일을 쓸 디렉터리. */
  workDir: string;
  /** 잠긴 base 의 파일 경로. 방향 앵커 행에만 붙는다. */
  lockedBasePath: string | null;
  log: (message: string) => void;
};

export type RunPlanRow = {
  generationId: string;
  /** 생성된 raw 시트 (크로마 배경). */
  imagePath: string;
  frameCount: number;
  /** 추출된 프레임 PNG 경로들 — 셀 크기, 알파 있음. */
  framePaths: string[];
  method: "components" | "slots-explicit";
};

export type RunPlanResult = {
  rows: Record<string, RunPlanRow>;
  anchors: Record<string, { path: string; state: string; index: number; source: string }>;
  skippedMirrors: MirroredDirection[];
  warnings: string[];
};

/** 액션 행에 base 가 붙었는지 기계적으로 검증한다 — 주석이 아니라 코드로 막는다. */
function assertNoBase(item: PlanItem, inputPaths: string[], basePath: string | null): void {
  if (item.role !== "action-row" || !basePath) return;
  if (inputPaths.includes(basePath)) {
    throw new Error(
      `runSpritePlan: 액션 행 '${item.state}' 에 base 가 첨부됐다 — ` +
        `base 는 방향 앵커 생성까지만 identity 소스다`,
    );
  }
}

/**
 * 생성된 raw 시트를 추출해 프레임으로 만들고 기록한다.
 *
 * **request 의 cell·safeMargin 이 추출의 출력 규격이다** — raw 치수와 무관하다.
 * 컴포넌트로 선언된 프레임 수를 못 찾으면 extractRowFrames 가 throw 하고 행이 차단된다.
 */
async function recordRow(
  result: RunPlanResult,
  request: SpriteRequest,
  state: string,
  frameCount: number,
  workDir: string,
  gen: Awaited<ReturnType<GenerateFn>>,
): Promise<void> {
  const extracted = await extractRowFrames({
    sheetPath: gen.imagePath,
    frameCount,
    cell: request.cell,
    chromaKey: request.chromaKey.rgb,
    chroma: {
      keyThreshold: request.chroma.keyThreshold,
      unmixReach: request.chroma.unmixReach,
      spillMaxFraction: request.chroma.spillMaxFraction,
    },
  });
  const dir = join(workDir, `frames-${state}`);
  await mkdir(dir, { recursive: true });
  const framePaths: string[] = [];
  for (let i = 0; i < extracted.frames.length; i++) {
    const p = join(dir, `frame-${i}.png`);
    await writeRaw(extracted.frames[i], p);
    framePaths.push(p);
  }
  if (extracted.dropped > 0) {
    result.warnings.push(
      `'${state}': 시드 근접 밖의 파편 ${extracted.dropped} 개를 버렸다`,
    );
  }
  result.rows[state] = {
    generationId: gen.generationId,
    imagePath: gen.imagePath,
    frameCount: extracted.frames.length,
    framePaths,
    method: extracted.method,
  };
}

export async function runSpritePlan(
  request: SpriteRequest,
  deps: RunPlanDeps,
): Promise<RunPlanResult> {
  const result: RunPlanResult = { rows: {}, anchors: {}, skippedMirrors: [], warnings: [] };
  const plan = buildGenerationPlan(request);

  // 방향 계약이 없으면(REF 런) 단일 행 경로 — base 를 그대로 identity 로 쓴다.
  if (!plan) {
    for (const [state, entry] of Object.entries(request.states)) {
      const guide = join(deps.workDir, `guide-${state}.png`);
      await renderLayoutGuide(guide, entry.frames, request.cell);
      const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
      deps.log(`flat ${state}: refs=${inputPaths.length}`);
      const gen = await deps.generate({
        state,
        prompt: buildRowPrompt(request, state, entry),
        inputPaths,
        role: "action-row",
      });
      await recordRow(result, request, state, entry.frames, deps.workDir, gen);
    }
    result.warnings.push("방향 계약 없는 런 — 앵커 체인을 쓰지 않는다(REF 모드)");
    return result;
  }

  result.skippedMirrors = plan.mirroredDirections;
  for (const m of plan.mirroredDirections) deps.log(`미러 생략: ${m.direction} ← ${m.mirrorOf}`);

  // ── stage 1: 방향 앵커 행 ────────────────────────────────────────────────
  for (const item of plan.order[0].items) {
    const entry = request.states[item.state];
    const guide = join(deps.workDir, `guide-${item.state}.png`);
    await renderLayoutGuide(guide, entry.frames, request.cell);
    const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
    deps.log(`stage1 ${item.state}: refs=${inputPaths.length}`);
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry),
      inputPaths,
      role: item.role,
    });
    await recordRow(result, request, item.state, entry.frames, deps.workDir, gen);
  }

  // ── stage 2: 액션 행 ────────────────────────────────────────────────────
  for (const item of plan.order[1].items) {
    const entry = request.states[item.state];

    // 앵커 ref 는 파생 캐시다 — 매 행 생성 직전에 큐레이션 진실에서 다시 굽는다.
    const anchorRows: Record<string, AnchorRow> = {};
    for (const [state, row] of Object.entries(result.rows)) {
      anchorRows[state] = {
        generationId: row.generationId,
        frameCount: row.frameCount,
        curation: null,
      };
    }
    const ctx: AnchorContext = { request, picks: {}, rows: anchorRows };
    let resolved;
    try {
      resolved = resolveAnchor(ctx, item.direction);
    } catch (e) {
      if (e instanceof AnchorUnavailable) {
        throw new Error(
          `runSpritePlan: '${item.state}' 의 앵커를 낼 수 없다 ` +
            `(${e.kind}${e.pending ? ", pending" : ""}) — ${e.message}`,
        );
      }
      throw e;
    }
    const anchorRow = result.rows[resolved.state];
    const anchorPath = join(deps.workDir, `anchor-${item.direction}-x${ANCHOR_SCALE}.png`);
    // 입력은 추출된 프레임이다 — 셀 크기, 알파 있음. 원본 bake_frame 과 같은 위치.
    await bakeAnchorImage({ framePath: anchorRow.framePaths[resolved.index], destPath: anchorPath });
    result.anchors[item.direction] = {
      path: anchorPath,
      state: resolved.state,
      index: resolved.index,
      source: resolved.source,
    };

    const guide = join(deps.workDir, `guide-${item.state}.png`);
    await renderLayoutGuide(guide, entry.frames, request.cell);
    // 정본 ref 순서: 타깃 방향 앵커 → (모션 참조) → 레이아웃 가이드
    const inputPaths = [anchorPath, guide];
    assertNoBase(item, inputPaths, deps.lockedBasePath);
    deps.log(
      `stage2 ${item.state}: anchor=${resolved.state}#${resolved.index} (${resolved.source})`,
    );
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry),
      inputPaths,
      role: item.role,
    });
    await recordRow(result, request, item.state, entry.frames, deps.workDir, gen);
  }

  return result;
}
