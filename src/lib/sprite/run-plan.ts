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
import { ANCHOR_SCALE, bakeAnchorImage } from "@/lib/sprite/anchor-image";
import {
  buildGenerationPlan,
  type MirroredDirection,
  type PlanItem,
} from "@/lib/sprite/generation-plan";
import { renderLayoutGuide } from "@/lib/sprite/layout-guide";
import { buildRowPrompt } from "@/lib/sprite/row-prompt";
import type { CellSpec, SpriteRequest } from "@/lib/sprite/request";

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
  imagePath: string;
  /** 슬라이스에 쓸 열 개수 = 요청 프레임 수. 레이아웃은 모델이 따랐다고 본다. */
  frameCount: number;
  /** 실제 출력에서 유도한 셀 기하. request.cell 이 아니다 — 아래 measureSheet 주석 참조. */
  cell: CellSpec;
};

export type RunPlanResult = {
  rows: Record<string, RunPlanRow>;
  anchors: Record<string, { path: string; state: string; index: number; source: string }>;
  skippedMirrors: MirroredDirection[];
  warnings: string[];
};

/**
 * 실제 출력에서 셀 기하를 유도한다.
 *
 * **codex 는 레이아웃 가이드의 픽셀 치수를 따르지 않는다**(실측 2026-08-16): 4프레임
 * 256셀 = 1024×256(4:1) 가이드를 붙였는데 출력이 1774×887(2:1)로 나왔다. image_gen 은
 * 고정된 몇 가지 종횡비만 내므로 4:1 스트립 자체가 불가능하다.
 *
 * 따르는 것은 **프레임 개수와 배열**이지 캔버스 치수가 아니다. 그래서 열 개수는 요청값을
 * 쓰고 셀 폭은 실제 폭을 나눠 구한다. 요청 셀 폭(256)으로 나누면 1774/256 = 7 이라는
 * 없는 프레임 수가 나오고, 그 인덱스로 크롭하면 배경 조각이 앵커가 된다 — 실제로 그렇게
 * 되어 액션 행이 정체성을 통째로 재발명했다.
 *
 * 모델이 요청 개수를 실제로 지켰는지는 내용 기반 분할(후속 단계)이 있어야 확인된다.
 */
export async function measureSheet(
  sheetPath: string,
  requestedFrames: number,
): Promise<{ cell: CellSpec; width: number; height: number }> {
  const meta = await sharp(sheetPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const cols = Math.max(1, requestedFrames);
  const cellWidth = Math.max(1, Math.floor(width / cols));
  return {
    cell: {
      shape: cellWidth === height ? "square" : "rect",
      width: cellWidth,
      height,
      safeMarginX: 0,
      safeMarginY: 0,
    },
    width,
    height,
  };
}

/**
 * 정본의 ANCHOR_SCALE=8 은 256px 셀을 전제한다(256×8 = 2048 — image_gen 이 읽을 수 있는 크기).
 * 우리 셀은 출력에서 유도되므로 443px 같은 값이 나오고, 거기에 ×8 을 걸면 3544px 짜리
 * 레퍼런스가 된다. 확대의 목적은 **작은 셀의 가독성**이지 무조건 8배가 아니므로,
 * 결과가 정본 목표치에 닿도록 배율을 잡고 8 을 넘지 않게 한다.
 */
const ANCHOR_TARGET_PX = 2048;

export function anchorScaleFor(cellWidth: number): number {
  if (cellWidth <= 0) return ANCHOR_SCALE;
  return Math.max(1, Math.min(ANCHOR_SCALE, Math.round(ANCHOR_TARGET_PX / cellWidth)));
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
  requestedCell: CellSpec,
  gen: Awaited<ReturnType<GenerateFn>>,
): Promise<void> {
  const measured = await measureSheet(gen.imagePath, requestedFrames);
  const wantW = requestedFrames * requestedCell.width;
  if (measured.width !== wantW || measured.height !== requestedCell.height) {
    result.warnings.push(
      `'${state}': 가이드는 ${wantW}x${requestedCell.height} 인데 출력이 ` +
        `${measured.width}x${measured.height} 다 — 셀 기하를 실제 출력에서 유도한다 ` +
        `(${measured.cell.width}x${measured.cell.height})`,
    );
  }
  result.rows[state] = {
    generationId: gen.generationId,
    imagePath: gen.imagePath,
    frameCount: requestedFrames,
    cell: measured.cell,
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
      await recordRow(result, state, entry.frames, request.cell, gen);
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
    await recordRow(result, item.state, entry.frames, request.cell, gen);
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
    const scale = anchorScaleFor(anchorRow.cell.width);
    const anchorPath = join(deps.workDir, `anchor-${item.direction}-x${scale}.png`);
    const baked = await bakeAnchorImage({
      sheetPath: anchorRow.imagePath,
      // 요청 셀이 아니라 그 행의 실제 기하다 — codex 가 가이드 치수를 안 따른다.
      cell: anchorRow.cell,
      cols: anchorRow.frameCount,
      index: resolved.index,
      destPath: anchorPath,
      scale,
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
    await recordRow(result, item.state, entry.frames, request.cell, gen);
  }

  return result;
}
