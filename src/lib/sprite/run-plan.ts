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
import { join } from "node:path";
import sharp from "sharp";
import {
  AnchorUnavailable,
  resolveAnchor,
  type AnchorContext,
  type AnchorRow,
} from "@/lib/sprite/anchor";
import { bakeAnchorImage } from "@/lib/sprite/anchor-image";
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

export type RunPlanRow = { generationId: string; imagePath: string; frameCount: number };

export type RunPlanResult = {
  rows: Record<string, RunPlanRow>;
  anchors: Record<string, { path: string; state: string; index: number; source: string }>;
  skippedMirrors: MirroredDirection[];
  warnings: string[];
};

/**
 * 시트 PNG 에서 실제 프레임 수를 추정한다 (셀 폭 기준).
 *
 * 요청값을 쓰면 안 된다 — 모델이 요청 프레임 수를 안 지킬 수 있고, 그러면 앵커 인덱스
 * 해석과 셀 크롭이 엉뚱한 자리를 짚는다. 내용 기반 추출이 붙기 전까지 셀 폭 추정이 최선이다.
 */
export async function inferFrameCount(sheetPath: string, cellWidth: number): Promise<number> {
  const meta = await sharp(sheetPath).metadata();
  return Math.max(1, Math.round((meta.width ?? cellWidth) / cellWidth));
}

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

async function recordRow(
  result: RunPlanResult,
  state: string,
  requestedFrames: number,
  cellWidth: number,
  gen: Awaited<ReturnType<GenerateFn>>,
): Promise<void> {
  const actual = await inferFrameCount(gen.imagePath, cellWidth);
  if (actual !== requestedFrames) {
    result.warnings.push(
      `'${state}': ${requestedFrames} frames 요청했는데 ${actual} 칸이 나왔다 — ` +
        `앵커 인덱스와 추출은 실측값을 따른다`,
    );
  }
  result.rows[state] = {
    generationId: gen.generationId,
    imagePath: gen.imagePath,
    frameCount: actual,
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
      await recordRow(result, state, entry.frames, request.cell.width, gen);
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
    await recordRow(result, item.state, entry.frames, request.cell.width, gen);
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
    const anchorPath = join(deps.workDir, `anchor-${item.direction}-x8.png`);
    const baked = await bakeAnchorImage({
      sheetPath: anchorRow.imagePath,
      cell: request.cell,
      cols: anchorRow.frameCount,
      index: resolved.index,
      destPath: anchorPath,
    });
    if (!baked.sourceHasAlpha) {
      result.warnings.push(
        `앵커 '${item.direction}': 원본에 알파가 없어 콘텐츠 크롭이 셀 전체가 됐다 ` +
          `(크로마 배경이 남아 있다 — 추출 단계 이후에야 유효하다)`,
      );
    }
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
    await recordRow(result, item.state, entry.frames, request.cell.width, gen);
  }

  return result;
}
