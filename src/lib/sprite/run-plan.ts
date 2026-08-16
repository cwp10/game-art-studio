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
  type AnchorPick,
  type AnchorRow,
  type CurationRecord,
} from "@/lib/sprite/anchor";
import { ANCHOR_SCALE, bakeAnchorImage } from "@/lib/sprite/anchor-image";
import { bareState } from "@/lib/sprite/directions";
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
  /**
   * 켜져 있으면 행을 **청크로 나눠 생성해 하나의 스트립으로 잇는다** (`chunk-generate.ts`).
   *
   * codex 는 프레임당 해상도가 임계 아래로 떨어지면 픽셀 블록을 안 그린다 —
   * `fit.pixel_unfake` 를 켠 런은 격자가 있어야 하므로 이 경로가 필요하다. 프레임 수가
   * 청크마다 다르므로 프롬프트·가이드를 다시 만들어야 하고, 그 방법을 여기서 넘긴다.
   */
  chunked?: {
    frameCount: number;
    chromaRgb: [number, number, number];
    promptFor: (frames: number) => string;
    guideFor: (frames: number, chunkIndex: number) => Promise<string>;
  };
}) => Promise<{ generationId: string; imagePath: string; width: number; height: number }>;

export type RunPlanDeps = {
  generate: GenerateFn;
  /**
   * 이미 생성된 행 — stage 1 에서 **다시 만들지 않고 재사용**한다.
   *
   * 매 런마다 방향 앵커 행을 새로 만들면 사람이 그 행에 한 큐레이션이 즉시 무의미해진다.
   * 정본은 run 디렉터리가 남아 stage 1 이 한 번만 돌고 이후 액션 행이 그 앵커를 쓴다.
   */
  existingRows?: Record<string, RunPlanRow>;
  /** direction → 앵커 지정(핀). 없으면 큐레이션 시퀀스 첫 인스턴스가 앵커다. */
  picks?: Record<string, AnchorPick>;
  /** 가이드·앵커 파일을 쓸 디렉터리. */
  workDir: string;
  /** 잠긴 base 의 파일 경로. 방향 앵커 행에만 붙는다. */
  lockedBasePath: string | null;
  /**
   * 상태별 교정 힌트 — 이전 시도의 score 가 만든 것. 그 상태 행의 프롬프트에만 얹는다.
   * 상태를 섞으면 idle 의 결함을 attack 행에 고치라고 시키는 꼴이 된다.
   */
  correctionHints?: Record<string, string[]>;
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
  /** 사람이 저장한 재생 시퀀스. 앵커 해석이 이것을 따른다. */
  curation?: CurationRecord | null;
  /** 이번 런에서 생성하지 않고 재사용한 행인가. */
  reused?: boolean;
};

export type RunPlanResult = {
  rows: Record<string, RunPlanRow>;
  anchors: Record<string, { path: string; state: string; index: number; source: string }>;
  skippedMirrors: MirroredDirection[];
  warnings: string[];
  /** 상태별로 실제 탄 크로마 경로. `request.chroma.mode` 는 한 벌뿐이라 여기가 정확하다. */
  chromaModes: Record<string, "rgb" | "ycbcr">;
};

/**
 * 그 상태의 가이드 셀 사양 — 모션 위상 힌트 옵트인을 여기서 얹는다.
 * `motionPhaseState` 를 넘겨야 스틱 포즈가 그려지고, 8프레임 로코모션이 아니면 무시된다.
 */
function guideCell(request: SpriteRequest, state: string) {
  return {
    ...request.cell,
    ...(request.motionPhaseGuides
      ? { motionPhaseState: bareState(state, request.directions ?? null) }
      : {}),
  };
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
    // 새로 굽는 행은 배경을 재서 경로를 정하고(auto), 정해진 값을 아래에서
    // request 에 되쓴다 — 기록에는 정본이 아는 rgb|ycbcr 만 남는다.
    chromaMode: "auto",
    chroma: {
      keyThreshold: request.chroma.keyThreshold,
      unmixReach: request.chroma.unmixReach,
      spillMaxFraction: request.chroma.spillMaxFraction,
    },
    // 분리 모드 SSoT 는 request `fit` 하나다 — 행마다 다르게 두지 않는다.
    ...(request.fit ? { fit: request.fit } : {}),
    label: state,
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
  // 결정된 경로를 request 에 되쓴다 (정본 `effective_chroma` 와 같은 패턴).
  // request.chroma 는 런 하나에 한 벌뿐인데 판정은 **행마다** 하므로, 행끼리
  // 갈리면 되쓰기가 한 값으로 뭉갠다. 재현은 재판정이 맡으니(같은 이미지 →
  // 같은 판정) 실제 피해는 없지만, 기록이 실제와 달라진 사실은 남겨야 한다.
  if (extracted.chroma) {
    if (result.chromaModes[state] === undefined) {
      const prior = Object.entries(result.chromaModes);
      if (prior.length > 0 && prior.some(([, m]) => m !== extracted.chroma!.mode)) {
        result.warnings.push(
          `크로마 경로가 행마다 갈립니다 (${prior.map(([s, m]) => `${s}=${m}`).join(", ")}, ` +
            `${state}=${extracted.chroma.mode}) — request.chroma.mode 는 마지막 값만 담습니다`,
        );
      }
    }
    result.chromaModes[state] = extracted.chroma.mode;
    request.chroma.mode = extracted.chroma.mode;
    // 경로가 갈린 사실은 조용하면 안 된다 — 나중에 결과가 달라진 이유를 못 찾는다.
    if (extracted.chroma.mode === "ycbcr") {
      result.warnings.push(`'${state}': ycbcr 크로마 경로 — ${extracted.chroma.reason}`);
    }
  }
  for (const w of extracted.chromaWarnings ?? []) {
    result.warnings.push(`'${state}': ${w}`);
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
  const result: RunPlanResult = {
    rows: {},
    anchors: {},
    skippedMirrors: [],
    warnings: [],
    chromaModes: {},
  };
  const plan = buildGenerationPlan(request);

  // 방향 계약이 없으면(REF 런) 단일 행 경로 — base 를 그대로 identity 로 쓴다.
  if (!plan) {
    for (const [state, entry] of Object.entries(request.states)) {
      const guide = join(deps.workDir, `guide-${state}.png`);
      await renderLayoutGuide(guide, entry.frames, guideCell(request, state));
      const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
      deps.log(`flat ${state}: refs=${inputPaths.length}`);
      const gen = await deps.generate({
        state,
        prompt: buildRowPrompt(request, state, entry, deps.correctionHints?.[state] ?? []),
        inputPaths,
        role: "action-row",
        ...chunkedSpec(request, state, entry, deps),
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
    const existing = deps.existingRows?.[item.state];
    if (existing) {
      result.rows[item.state] = { ...existing, reused: true };
      deps.log(
        `stage1 ${item.state}: 재사용 ${existing.generationId} ` +
          `(큐레이션 ${existing.curation ? "있음" : "없음"})`,
      );
      continue;
    }
    const entry = request.states[item.state];
    const guide = join(deps.workDir, `guide-${item.state}.png`);
    await renderLayoutGuide(guide, entry.frames, guideCell(request, item.state));
    const inputPaths = [...(deps.lockedBasePath ? [deps.lockedBasePath] : []), guide];
    deps.log(`stage1 ${item.state}: refs=${inputPaths.length}`);
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry, deps.correctionHints?.[item.state] ?? []),
      inputPaths,
      role: item.role,
      ...chunkedSpec(request, item.state, entry, deps),
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
        curation: row.curation ?? null,
      };
    }
    const ctx: AnchorContext = { request, picks: deps.picks ?? {}, rows: anchorRows };
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
    await renderLayoutGuide(guide, entry.frames, guideCell(request, item.state));
    // 정본 ref 순서: 타깃 방향 앵커 → (모션 참조) → 레이아웃 가이드
    const inputPaths = [anchorPath, guide];
    assertNoBase(item, inputPaths, deps.lockedBasePath);
    deps.log(
      `stage2 ${item.state}: anchor=${resolved.state}#${resolved.index} (${resolved.source})`,
    );
    const gen = await deps.generate({
      state: item.state,
      prompt: buildRowPrompt(request, item.state, entry, deps.correctionHints?.[item.state] ?? []),
      inputPaths,
      role: item.role,
      ...chunkedSpec(request, item.state, entry, deps),
    });
    await recordRow(result, request, item.state, entry.frames, deps.workDir, gen);
  }

  return result;
}

/**
 * `fit.pixel_unfake` 가 켜진 런에만 청크 생성 사양을 붙인다.
 *
 * 꺼져 있으면 `{}` 라 기존 경로가 **바이트 불변**이다. 켜져 있으면 생성기가 프레임을
 * 2장씩 나눠 만들고 격자를 게이트로 건다 — codex 가 프레임당 해상도 임계 아래에서
 * 픽셀 블록을 안 그리기 때문이다(실측: 3프레임부터 붕괴).
 */
function chunkedSpec(
  request: SpriteRequest,
  state: string,
  entry: { frames: number },
  deps: RunPlanDeps,
): { chunked?: NonNullable<Parameters<GenerateFn>[0]["chunked"]> } {
  if (!request.fit?.pixel_unfake) return {};
  const stateEntry = request.states[state];
  return {
    chunked: {
      frameCount: entry.frames,
      chromaRgb: request.chromaKey.rgb,
      promptFor: (frames: number) =>
        buildRowPrompt(
          request,
          state,
          { ...stateEntry, frames },
          deps.correctionHints?.[state] ?? [],
        ),
      guideFor: async (frames: number, chunkIndex: number) => {
        const guide = join(deps.workDir, `guide-${state}-chunk${chunkIndex}.png`);
        await renderLayoutGuide(guide, frames, guideCell(request, state));
        return guide;
      },
    },
  };
}
