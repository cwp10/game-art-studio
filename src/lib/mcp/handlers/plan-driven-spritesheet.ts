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
import { mkdir, writeFile } from "node:fs/promises";
import { composeAtlas, writeAtlas } from "@/lib/sprite/atlas";
import { buildPreviews } from "@/lib/sprite/preview";
import { buildSpriteRequest } from "@/lib/sprite/build-request";
import { inspectBaseImage } from "@/lib/sprite/base-gate";
import { formatHints } from "@/lib/sprite/correction-loop";
import { inspectStates, type InspectReport } from "@/lib/sprite/inspect";
import { scoreInspection, type ScoreReport } from "@/lib/sprite/score";
import { runSpritePlan, type GenerateFn, type RunPlanRow } from "@/lib/sprite/run-plan";
import { extractRowFrames, writeRaw, type RawImage } from "@/lib/sprite/extract";
import sharp from "sharp";
import {
  createGeneration,
  getAnchorPicks,
  getCuration,
  getGeneration,
  getLockedBase,
  lockBaseGeneration,
} from "../../db/repo/generations.js";
import { getDb } from "../../db/client.js";
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
  /**
   * 교정 재생성의 출발점이 된 아틀라스 generation.
   *
   * 정본은 correction loop 를 **별도 CLI 명령**으로 노출한다
   * (`sprite-gen correction-loop --provider-command …`) — 기본 생성에 자동으로
   * 붙지 않는다. 재생성은 codex 호출이라 비용·시간이 배로 드니 사람이 트리거를
   * 쥔다. 우리도 같다: 이 필드가 있을 때만 이전 힌트를 얹어 다시 굽는다.
   */
  correctFrom?: string;
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
  return planDrivenBlocker(opts) === null;
}

/**
 * 플랜 구동 경로를 쓸 수 **없는** 이유. 쓸 수 있으면 null.
 *
 * 이유를 문자열로 돌려주는 목적은 하나다 — 구 격자 경로로 떨어진 사실이 **조용하지
 * 않게** 하는 것. 정본이 base 잠금을 BLOCKING 으로 둔 이유가 "약한 base 가 모든 행을
 * 오염시킨다" 인데, 우리 쪽 조용한 폴백은 그 게이트를 통째로 건너뛰게 만든다.
 */
export function planDrivenBlocker(opts: {
  subjectType: string;
  directions: number | null;
  refId: string | null;
}): string | null {
  if (opts.subjectType !== "character") {
    return `피사체가 '${opts.subjectType}' — component-row 엔진은 캐릭터 상태 행을 위한 것이라 이펙트·오브젝트는 격자 경로가 맞습니다`;
  }
  if (opts.directions !== null && opts.directions > 1) {
    return `다방향(${opts.directions}) 시트 — 아직 플랜 구동 경로가 단일 방향만 받습니다`;
  }
  if (!opts.refId) {
    return "참조 이미지가 없습니다 — base 를 먼저 만들고 잠그면 component-row 엔진(방향 앵커 체인 · 컴포넌트 추출 · 큐레이션)을 씁니다";
  }
  return null;
}

export async function runPlanDrivenSpritesheet(
  input: PlanDrivenInput,
  extra: HandlerExtra,
  ctx: HandlerContext,
): Promise<ToolResponse> {
  const { log, sessionId } = ctx;
  const t0 = Date.now();

  // ① base 잠금 — 약한 base 는 모든 행을 오염시킨다.
  //
  // 사람이 게이트에서 잠근 base 면 그대로 쓴다. 아니면 여기서 자동으로 잠그는데,
  // 그건 정본이 BLOCKING 으로 둔 y/n 을 건너뛰는 것이므로 **자동 검사 결과를 경고로
  // 표면화한다.** 실패 항목이 있으면 2회의 codex 호출을 쓰기 전에 사람이 알아야 한다.
  const gateWarnings: string[] = [];
  const alreadyLocked = getLockedBase(sessionId)?.id === input.baseGenerationId;
  const { filePath: basePath } = loadGenerationWithPath(input.baseGenerationId);
  if (!alreadyLocked) {
    lockBaseGeneration(input.baseGenerationId, sessionId);
    log(`plan-driven: base 자동 잠금 ${input.baseGenerationId} (게이트 미검토)`);
    try {
      const inspection = await inspectBaseImage(basePath);
      const failed = inspection.checks.filter(c => !c.ok);
      const unmeasured = inspection.checks.filter(c => c.unmeasured);
      if (failed.length > 0) {
        gateWarnings.push(
          `base 게이트 미검토 + 자동 검사 실패: ${failed.map(c => `${c.id}(${c.detail})`).join("; ")} — ` +
            "약한 base 는 모든 행의 비율·스타일·정체성을 오염시킵니다",
        );
      } else {
        gateWarnings.push(
          "base 를 게이트 검토 없이 자동 잠금했습니다 — 자동 검사는 통과했지만 비율·스타일·정체성·" +
            "실루엣 가독성은 기계가 못 봅니다(패널의 base 잠금 게이트에서 확인하세요)",
        );
      }
      for (const c of unmeasured) {
        gateWarnings.push(`base 검사 '${c.id}' 는 근거 없이 통과로 쳤습니다 — ${c.detail}`);
      }
    } catch (e) {
      gateWarnings.push(`base 자동 검사 실패: ${(e as Error).message}`);
    }
    for (const w of gateWarnings) log(`plan-driven 경고: ${w}`);
  }

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

  // ── 교정 재생성: 이전 시도의 힌트 회수 ───────────────────────────────────
  // 힌트는 이전 아틀라스의 params 에 이미 있다. 그것을 상태별로 갈라 그 상태 행의
  // 프롬프트에만 얹는다. 이전 점수도 들고 있다가 아래에서 새 점수와 비교한다 —
  // 재생성이 **더 나빠질 수 있고**, 그 사실이 조용하면 퇴보한 시트를 쓰게 된다.
  const correctionHints: Record<string, string[]> = {};
  let previousScore: { id: string; overall: number; ok: boolean } | null = null;
  if (input.correctFrom) {
    const prev = getGeneration(input.correctFrom);
    const prevInspect = prev?.params?.inspect as
      | { ok: boolean; overall_score: number; rows: Array<{ state: string; hints: string[] }> }
      | null
      | undefined;
    if (!prevInspect) {
      gateWarnings.push(
        `교정 출발점 ${input.correctFrom} 에 검사 리포트가 없습니다 — 힌트 없이 새로 생성합니다`,
      );
    } else {
      previousScore = {
        id: input.correctFrom,
        overall: prevInspect.overall_score,
        ok: prevInspect.ok,
      };
      for (const row of prevInspect.rows) {
        if (row.hints.length > 0) correctionHints[row.state] = row.hints;
      }
      const total = Object.values(correctionHints).reduce((a, h) => a + h.length, 0);
      log(
        `plan-driven: 교정 재생성 (이전 ${prevInspect.overall_score}점, 힌트 ${total}개 ` +
          `— ${Object.keys(correctionHints).join(", ") || "없음"})`,
      );
    }
  }

  // ── 기존 방향 앵커 행 재사용 ─────────────────────────────────────────────
  // 매 런마다 앵커 행을 새로 만들면 사람이 그 행에 한 큐레이션·핀이 즉시 무의미해진다.
  // 잠긴 base 가 자기 스코프의 앵커 행을 기억하고, 있으면 재사용한다.
  //
  // 프레임은 저장된 경로를 믿지 않고 **raw 시트에서 다시 추출**한다 — 정본의 파생 캐시
  // 원칙과 같다(파일이 사라지거나 낡아도 진실에서 다시 굽는다).
  const lockedBase = getLockedBase(sessionId);
  const anchorRows = (lockedBase?.params?.anchorRows as Record<string, string> | undefined) ?? {};
  const existingRows: Record<string, RunPlanRow> = {};
  for (const [state, rowId] of Object.entries(anchorRows)) {
    if (!(state in request.states)) continue;
    // 교정 대상 상태는 **재사용하지 않는다**. 그 행을 그대로 쓰면 힌트를 얹을 자리가
    // 없어 "교정 재생성" 이 아무것도 바꾸지 않는다 — 방향 앵커 행이 곧 게임의 idle
    // 행이기도 해서 실제로 자주 걸린다.
    if (correctionHints[state]?.length) {
      log(`plan-driven: 앵커 행 '${state}' 재사용 생략 — 교정 대상`);
      continue;
    }
    const rowGen = getGeneration(rowId);
    if (!rowGen) continue;
    try {
      const { filePath } = loadGenerationWithPath(rowId);
      const extracted = await extractRowFrames({
        sheetPath: filePath,
        frameCount: request.states[state].frames,
        cell: request.cell,
        chromaKey: request.chromaKey.rgb,
        // 이전 런이 구운 앵커 행을 다시 뽑는 자리다 — 그 행 이미지에 맞는 경로를
        // 그때와 같이 재판정한다(판정은 이미지의 순수 함수).
        chromaMode: "auto",
        chroma: {
          keyThreshold: request.chroma.keyThreshold,
          unmixReach: request.chroma.unmixReach,
          spillMaxFraction: request.chroma.spillMaxFraction,
        },
      });
      const dir = path.join(workDir, `frames-${state}`);
      await mkdir(dir, { recursive: true });
      const framePaths: string[] = [];
      for (let i = 0; i < extracted.frames.length; i++) {
        const fp = path.join(dir, `frame-${i}.png`);
        await writeRaw(extracted.frames[i], fp);
        framePaths.push(fp);
      }
      // 재사용 행도 경로가 갈릴 수 있다 — 새로 굽는 행(run-plan)에서만 알리면
      // 재사용 경로는 조용해진다.
      if (extracted.chroma?.mode === "ycbcr") {
        const w = `앵커 행 '${state}': ycbcr 크로마 경로 — ${extracted.chroma.reason}`;
        gateWarnings.push(w);
        log(`plan-driven 경고: ${w}`);
      }
      for (const w of extracted.chromaWarnings ?? []) {
        gateWarnings.push(`앵커 행 '${state}': ${w}`);
        log(`plan-driven 경고: 앵커 행 '${state}': ${w}`);
      }
      existingRows[state] = {
        generationId: rowId,
        imagePath: filePath,
        frameCount: extracted.frames.length,
        framePaths,
        method: extracted.method,
        curation: getCuration(rowId),
      };
    } catch (e) {
      // 재추출이 실패하면 재사용을 포기하고 새로 만든다 — 조용히 깨진 행을 쓰지 않는다.
      log(`plan-driven: 앵커 행 ${state} 재사용 실패, 새로 생성 — ${(e as Error).message}`);
    }
  }
  const picks = getAnchorPicks(sessionId);
  if (Object.keys(picks).length > 0) {
    log(`plan-driven: 앵커 지정 ${JSON.stringify(picks)}`);
  }

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
    existingRows,
    picks,
    workDir,
    lockedBasePath: basePath,
    correctionHints,
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

  // 폐루프의 측정·판단 단계. **차단하지 않는다** — 정본도 inspect/score 는 신호를
  // 낼 뿐이고 재생성 여부는 correction_loop 가 정한다. 여기서는 리포트를 남겨
  // 모션 QA 화면이 읽게 하고, 힌트는 다음 재생성 때 프롬프트에 얹을 재료로 쓴다.
  //
  // 입력이 `framesByState` 인 이유: 이 맵은 새로 구운 행과 **재사용한 앵커 행**을 모두
  // 담는다. 생성 단계에서만 모으면 재사용 런이 통째로 검사에서 빠진다 — 정본 inspect
  // 도 frames/ 를 통째로 읽지 어느 행이 이번에 생성됐는지 가리지 않는다.
  // 아직 큐레이션 이전이라 사람이 뺀 프레임이 신호에 섞이지 않는다.
  let inspectReport: InspectReport | null = null;
  let scoreReport: ScoreReport | null = null;
  {
    const inspectInput = stateOrder
      .filter(s => framesByState[s]?.length)
      .map(s => ({
        state: s,
        expected: request.states[s].frames,
        frames: framesByState[s].map(f => ({ data: f.data, width: f.width, height: f.height })),
      }));
    if (inspectInput.length > 0) {
      inspectReport = inspectStates(inspectInput);
      scoreReport = scoreInspection(inspectReport);
      log(
        `plan-driven: 검사 ${scoreReport.overall_score}점 ` +
          `(${scoreReport.ok ? "통과" : "미달"}, rank=${scoreReport.candidate_rank})`,
      );
      for (const row of scoreReport.rows) {
        log(`plan-driven: 검사 '${row.state}' ${row.score}점, 힌트 ${row.hints.length}개`);
      }
      await writeFile(
        path.join(workDir, "inspect.json"),
        JSON.stringify({ inspect: inspectReport, score: scoreReport }, null, 2) + "\n",
      );
      if (scoreReport.hints.length > 0) {
        await writeFile(path.join(workDir, "correction-hints.txt"), formatHints(scoreReport.hints));
      }
      // 교정이 **퇴보했을 수 있다.** 정본의 correction loop 는 최선 후보를 따로
      // 보존하는데, 우리는 두 시트가 다 DB 에 남으므로 사람이 고른다 — 대신 어느
      // 쪽이 나은지는 말해줘야 한다. 조용하면 새 시트가 무조건 낫다고 오해한다.
      if (previousScore) {
        const delta = scoreReport.overall_score - previousScore.overall;
        const line =
          `교정 결과 ${previousScore.overall}점 → ${scoreReport.overall_score}점 ` +
          `(${delta >= 0 ? "+" : ""}${Math.round(delta * 100) / 100})`;
        if (delta < 0) {
          gateWarnings.push(
            `${line} — **이전 시트가 더 낫습니다**. 이전 것을 쓰려면 ` +
              `${previousScore.id} 를 그대로 두고 이 시트를 버리세요`,
          );
        } else if (delta === 0) {
          gateWarnings.push(`${line} — 점수가 그대로입니다`);
        } else {
          gateWarnings.push(line);
        }
        log(`plan-driven: ${line}`);
      }
    }
  }

  // 이번 런의 방향 앵커 행을 base 에 기록해 다음 런이 재사용하게 한다.
  {
    const base = getLockedBase(sessionId);
    if (base) {
      const anchorStates = Object.keys(request.states).filter(st =>
        st.endsWith(`_${request.directions?.anchorSuffix ?? "idle"}`),
      );
      const next = { ...anchorRows };
      for (const st of anchorStates) {
        if (result.rows[st]) next[st] = result.rows[st].generationId;
      }
      const params = { ...base.params, anchorRows: next };
      getDb()
        .prepare("UPDATE generations SET params = ? WHERE id = ?")
        .run(JSON.stringify(params), base.id);
    }
  }

  // 재사용한 행에는 사람이 저장한 큐레이션이 붙어 있다 — 아틀라스는 **그것을 반영해**
  // 구워야 한다(정본 Output Contract: `frames/` 가 아니라 큐레이션 반영본을 설치).
  const curationByState = Object.fromEntries(
    stateOrder.map(s => [s, result.rows[s]?.curation ?? null]),
  );
  const composed = composeAtlas({ request, framesByState, curationByState });
  if (composed.errors.length > 0) {
    throw new Error(`아틀라스 합성 실패: ${composed.errors.join("; ")}`);
  }

  // 모션 QA 계측기 — 정적 QA 로는 부족하다. 프레임 수가 맞고 알파가 깨끗하고 정체성이
  // 일관돼도 애니메이션이 쓰레기일 수 있다(`qa-motion.md`, BLOCKING). 접촉 시트는 사람이
  // 프레임을 훑고, GIF 는 루프 이음매를 본다. 런타임 에셋이 아니라 판정 도구다.
  //
  // 아틀라스 합성이 통과한 뒤에 만든다 — 합성이 실패한 런은 QA 할 대상이 아니다.
  const preview = await buildPreviews({
    request,
    framesByState,
    qaDir: path.join(workDir, "qa"),
  });
  if (!preview.ok) {
    log(`plan-driven 경고: 모션 QA 프리뷰 일부 실패 — ${JSON.stringify(preview.states)}`);
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
      // 큐레이션 저장 후 재합성이 이 request 로 프레임을 다시 추출한다. 없으면 아틀라스를
      // 다시 구울 수 없어 편집 전 산출물이 남는다.
      request,
      curationApplied: composed.manifest.curation_applied,
      warnings: [...gateWarnings, ...result.warnings],
      // 교정 계보 — 어느 시트를 고치려다 나온 것인지, 점수가 어떻게 움직였는지.
      ...(previousScore
        ? {
            correctionOf: previousScore.id,
            previousScore: previousScore.overall,
            correctedStates: Object.keys(correctionHints),
          }
        : {}),
      // 폐루프 신호. 점수·힌트만 담고 프레임은 담지 않는다 — 리포트가 params 를
      // 무겁게 만들면 안 되고, 프레임은 workDir 의 inspect.json 에 이미 있다.
      inspect: scoreReport
        ? {
            ok: scoreReport.ok,
            overall_score: scoreReport.overall_score,
            candidate_rank: scoreReport.candidate_rank,
            rows: scoreReport.rows.map(r => ({
              state: r.state,
              score: r.score,
              errors: r.errors,
              warnings: r.warnings,
              hints: r.hints,
            })),
            hints: scoreReport.hints,
            metrics: Object.fromEntries(
              (inspectReport?.rows ?? []).map(r => [r.state, r.metrics]),
            ),
          }
        : null,
      // 모션 QA 산출물 경로 — 판정은 사람이 한다. 여기 기록해 두면 어떤 런의 어떤
      // 상태를 봤는지 사후에 짚을 수 있다.
      motionQa: {
        ok: preview.ok,
        qaDir: preview.qaDir,
        allContact: preview.allContactPath,
        states: preview.states,
      },
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
