/**
 * make_spritesheet 핸들러.
 *
 * 그리드 검증 → 배경/chroma-key 결정 → 포즈 가이드 프롬프트 조립(buildSpritePrompt) →
 * 시도 루프·후처리(runSpritesheetAttempts). 셀 정렬·투명화 불변식은 shared.ts·
 * spritesheet-postprocess.ts 가 담당한다.
 */
import path from "node:path";
import { getGeneration } from "../../db/repo/generations.js";
import { DATA_DIR } from "../../util/paths.js";
import {
  isGreenDominant,
  PADDING_BOTTOM_RATIO,
  CELL_MARGIN_RATIO,
  type AnchorStrategy,
  type ChromaKeyColor,
  type SubjectType,
} from "../../image-backend/spritesheet-postprocess.js";
import { inferSubjectType, type Directions } from "../spritesheet-classify.js";
import {
  analyzeRefHandObjects,
  buildSpritePrompt,
  detectTransparentBg,
  generateGridTemplate,
  requireInt,
  requireString,
  runDirectionalSpritesheet,
  runSpritesheetAttempts,
  type HandlerContext,
  type HandlerExtra,
  type ToolResponse,
} from "./shared.js";

export async function handleMakeSpritesheet(
  args: Record<string, unknown>,
  extra: HandlerExtra,
  ctx: HandlerContext,
): Promise<ToolResponse> {
  const { sessionId, log } = ctx;
  let rows = requireInt(args.rows, "rows");
  let cols = requireInt(args.cols, "cols");
  const userPrompt = requireString(args.prompt, "prompt");
  const seamlessLoop = args.seamlessLoop === true;
  const viewpoint = typeof args.viewpoint === "string" ? args.viewpoint : "side";
  // UI에서 명시한 facing 방향 — NL regex 감지보다 우선 적용 (오케스트레이터 방향 오해 방지)
  const facing = typeof args.facing === "string" ? args.facing : null;
  const refId = typeof args.inputGenerationId === "string" && args.inputGenerationId
    ? args.inputGenerationId
    : null;

  // ② 방향 시트: directions > 1 이면 rows=directions 로 강제(각 행=한 방향).
  // directions=1(단일 방향)은 rows 를 레이아웃 행 수로 그대로 유지 — SpriteGenPanel
  // 단일 동작 directive 에서 항상 directions=1 을 명시하므로 오케스트레이터가
  // rows=2 를 "2방향"으로 오해해 다방향 시트를 생성하는 것을 방지한다.
  const directions: Directions | null = (args.directions as Directions | undefined) ?? null;
  if (directions && directions > 1 && rows !== directions) {
    log(`make_spritesheet directions=${directions}: rows ${rows} → ${directions}`);
    rows = directions;
  }

  // rows=1 이고 cols > 4 인 경우: 다행 그리드로 자동 변환.
  // (시스템 프롬프트가 잘못 지시하거나 사용자가 명시해도 방어)
  if (rows === 1 && cols > 4) {
    const n = cols;
    rows = Math.round(Math.sqrt(n));
    cols = Math.ceil(n / rows);
    log(`make_spritesheet auto-reshape: 1×${n} → ${rows}×${cols}`);
  }

  // gpt-image-2 API 제약 검증 — 384px 셀 기준: 최대 한 변 3840px(10셀), 총 8.29M px, 비율 ≤ 3:1.
  // auto-reshape 후 최종 rows/cols 에 적용.
  {
    const VALIDATION_CELL_PX = 384;
    const cW = cols * VALIDATION_CELL_PX;
    const cH = rows * VALIDATION_CELL_PX;
    const API_MAX_EDGE = 1536;        // 생성 캔버스 실측 최대 (CELL_PX=384 × 4)
    const API_MAX_PX = 1536 * 1536;   // = 2_359_296
    const API_MAX_RATIO = 3;
    const maxCellsPerEdge = Math.floor(API_MAX_EDGE / VALIDATION_CELL_PX); // 4
    const maxTotalCells = Math.floor(API_MAX_PX / (VALIDATION_CELL_PX * VALIDATION_CELL_PX)); // 16

    if (Math.max(cW, cH) > API_MAX_EDGE) {
      const overDim = cW > cH ? `cols=${cols}` : `rows=${rows}`;
      const overPx = Math.max(cW, cH);
      throw new Error(
        `make_spritesheet 캔버스 장축 초과: ${overDim} → ${overPx}px (한계 ${API_MAX_EDGE}px). ` +
        `셀 ${VALIDATION_CELL_PX}px 기준 한 변 최대 ${maxCellsPerEdge}셀.`,
      );
    }
    const totalPx = cW * cH;
    if (totalPx > API_MAX_PX) {
      throw new Error(
        `make_spritesheet 총 픽셀 초과: ${rows}×${cols}=${rows * cols}셀 → ` +
        `${cW}×${cH}=${(totalPx / 1_000_000).toFixed(1)}M px (한계 ${(API_MAX_PX / 1_000_000).toFixed(1)}M). ` +
        `총 셀 수를 ${maxTotalCells}개 이하로 줄이세요.`,
      );
    }
    const ratio = Math.max(cW, cH) / Math.min(cW, cH);
    if (ratio > API_MAX_RATIO) {
      throw new Error(
        `make_spritesheet 종횡비 초과: ${cW}×${cH} = ${ratio.toFixed(2)}:1 (한계 ${API_MAX_RATIO}:1). ` +
        `rows:cols 비율을 ${API_MAX_RATIO}:1 이하로 조정하세요.`,
      );
    }
  }

  // 생성 셀 384px 고정 → codex 네이티브 장축(1536px) 안으로 캔버스가 들어온다.
  //   3×2:1152×768, 4×2:1536×768, 3×4:1152×1536, 4×4:1536×1536 — 모두 장축 ≤1536.
  // 최종 출력은 FINAL_CELL_PX(512)로 업스케일(후처리 normalize 후 1회). 384→512 = ×4/3.
  const CELL_PX = 384;       // codex 생성 셀 크기
  const FINAL_CELL_PX = 512; // 업스케일 후 최종 셀 크기 (DB params·export 기준)
  const cellH = CELL_PX;
  const cellW = CELL_PX;
  const canvasW = cols * cellW;
  const canvasH = rows * cellH;

  // 그리드 템플릿 PNG 생성 (흰 배경 + 회색 선) — Codex 에게 레이아웃 시각적으로 전달
  const gridTemplatePath = await generateGridTemplate(cols, rows, cellW, cellH);

  // ── 배경 결정 우선순위 ──────────────────────────────────────────────
  // 1. 사용자가 프롬프트에 명시("white background", "흰 배경" 등) → 흰 배경
  // 2. 사용자가 "transparent/투명" 명시 → 투명
  // 3. 참조 이미지가 있으면 그 배경 상속
  // 4. 기본 → 투명 (게임 에셋 기본값)
  const hasExplicitBgKeyword = /transparent|투명|white\s*bg|흰\s*배경|white\s*background/.test(
    userPrompt.toLowerCase(),
  );
  let wantsTransparent = true; // 기본값: 투명
  if (/white\s*bg|흰\s*배경|white\s*background/.test(userPrompt.toLowerCase())) {
    wantsTransparent = false;
  } else if (/transparent|투명/.test(userPrompt.toLowerCase())) {
    wantsTransparent = true;
  } else if (!hasExplicitBgKeyword && refId) {
    const refGen = getGeneration(refId);
    if (refGen) {
      const refPath = path.join(DATA_DIR, refGen.image_path);
      wantsTransparent = await detectTransparentBg(refPath);
      log(
        `make_spritesheet: ref=${refId} transparent=${wantsTransparent} (inherited from reference bg)`,
      );
    }
  }

  // ⑥ 녹색 캐릭터 키워드 감지 → 마젠타 키 폴백.
  // 명시적 녹색 색상 키워드만(고블린 등 모호어 제외) — 녹색 옷/슬라임이 chroma-key 에
  // 먹히는 회귀 방지. 키워드 없으면 기존 green 경로.
  const greenSubject = /녹색|초록|연두|green|슬라임|slime|잎|leaf|이끼|moss/.test(
    userPrompt.toLowerCase(),
  );
  // 참조 이미지가 있으면 그 본체 색을 분석 — 사용자가 "green" 이라 안 써도 참조
  // 캐릭터가 녹색 우세면 자동으로 마젠타 키로 폴백(녹색 본체 보존). 키워드 OR 결합.
  let refIsGreen = false;
  if (refId) {
    const rg = getGeneration(refId);
    if (rg) {
      try {
        refIsGreen = await isGreenDominant(path.join(DATA_DIR, rg.image_path), log);
      } catch {
        /* 분석 실패 시 키워드 경로 유지 */
      }
      if (refIsGreen) log(`make_spritesheet: ref ${refId} green-dominant → magenta key`);
    }
  }
  const chromaKeyColor: ChromaKeyColor = greenSubject || refIsGreen ? "magenta" : "green";

  // 피사체 종류·앵커 전략 해석 — 명시 param 우선, 없으면 키워드 추론 폴백.
  // subjectType 은 normalize 정렬·이펙트 가드의 결정적 입력 신호.
  const subjectType: SubjectType =
    (args.subjectType as SubjectType | undefined) ?? inferSubjectType(userPrompt, !!refId);
  const anchorStrategy: AnchorStrategy = (args.anchorStrategy as AnchorStrategy | undefined) ?? "auto";
  // auto → 구체 전략(normalize 의 resolveAnchor 와 동일 규칙). 프롬프트/피벗 산출용.
  const resolvedAnchor: Exclude<AnchorStrategy, "auto"> =
    anchorStrategy !== "auto" ? anchorStrategy : (subjectType === "effect" || subjectType === "object") ? "center" : "feet";

  const refGen = refId ? getGeneration(refId) : null;
  const refPath = refGen ? path.join(DATA_DIR, refGen.image_path) : null;

  // 참조 이미지가 캐릭터 시트이면 양손 오브젝트를 미리 분석 → 프롬프트에 명시 주입.
  const refHandDescription = (refPath && subjectType === "character")
    ? await analyzeRefHandObjects(refPath)
    : null;
  if (refHandDescription) log(`make_spritesheet: ref hand objects = ${refHandDescription}`);

  const isCharacter = subjectType === "character";
  const cx = Math.round(cellW / 2);

  // ⑧ 앵커 피벗(셀-로컬) 결정적 산출 — normalize 의 고정 목표선과 일치.
  // export(Phase 3) 가 이 좌표를 그대로 사용. paddingBottom/margin 은 normalize 와 동일 식.
  const paddingBottom = Math.round(cellH * PADDING_BOTTOM_RATIO);
  const anchorMargin = Math.round(Math.min(cellW, cellH) * CELL_MARGIN_RATIO);
  const anchorY =
    resolvedAnchor === "center"
      ? Math.round(cellH / 2)
      : resolvedAnchor === "top"
        ? anchorMargin
        : resolvedAnchor === "hip"
          ? Math.round(cellH - paddingBottom - 1 - cellH * 0.9 * 0.45)
          : cellH - paddingBottom - 1; // feet
  // anchorPivot: 저장·export 는 FINAL_CELL_PX(512) 공간 기준이므로 ×(512/384) 스케일.
  const pivotScale = FINAL_CELL_PX / CELL_PX;
  const anchorPivot = {
    x: Math.round(cx * pivotScale),
    y: Math.round(anchorY * pivotScale),
  };

  const retryEnabled = isCharacter;
  const spritesheetParams = {
    seamlessLoop, subjectType, anchorStrategy,
    directions: directions ?? undefined, anchor: anchorPivot,
    rows, cols, cellW: FINAL_CELL_PX, cellH: FINAL_CELL_PX, fps: 12,
  };

  let best: ToolResponse | null;
  let cumulativeMs: number;

  if (directions && directions > 1) {
    // ② 다방향 시트: 방향별 개별 Codex 호출 + 수직 stitch.
    // 단일 호출은 모델이 행별 facing 을 혼동하고 4방향×384px=1536px 가 캔버스 장축
    // 한계여서 방향 수가 늘면 막힌다 → 각 방향을 rows=1 단일 행으로 따로 생성한다.
    const dirList = directions === 2 ? ["LEFT", "RIGHT"] : ["DOWN", "LEFT", "RIGHT", "UP"];
    // 각 방향 호출은 cols×1 단일 행 — 그 행 전용 그리드 템플릿(cols×1)을 전달.
    const rowGridTemplatePath = await generateGridTemplate(cols, 1, cellW, cellH);
    const rowDecorated = await Promise.all(
      dirList.map(dir =>
        buildSpritePrompt({
          userPrompt, rows: 1, cols, cellW, cellH, canvasW, canvasH: cellH,
          wantsTransparent, chromaKeyColor, seamlessLoop,
          subjectType, resolvedAnchor, directions: 1,
          refPath, gridTemplatePath: rowGridTemplatePath, viewpoint, facing: dir,
          refHandDescription,
        }),
      ),
    );
    ({ best, cumulativeMs } = await runDirectionalSpritesheet({
      rowDecorated, dirList, refId, spritesheetParams,
      wantsTransparent, chromaKeyColor, rows, cols,
      canvasW, rowCanvasH: cellH,
      anchorStrategy, subjectType, resolvedAnchor,
      finalCellPx: FINAL_CELL_PX, sessionId, signal: extra.signal,
    }));
  } else {
    // directions=1(단일 방향) — 기존 단일 호출 흐름 그대로.
    const { decorated, overrideInputPaths } = await buildSpritePrompt({
      userPrompt, rows, cols, cellW, cellH, canvasW, canvasH,
      wantsTransparent, chromaKeyColor, seamlessLoop,
      subjectType, resolvedAnchor, directions,
      refPath, gridTemplatePath, viewpoint, facing,
      refHandDescription,
    });
    ({ best, cumulativeMs } = await runSpritesheetAttempts({
      name: "make_spritesheet", decorated, overrideInputPaths, refId, spritesheetParams, retryEnabled,
      wantsTransparent, chromaKeyColor, rows, cols, canvasW, canvasH,
      anchorStrategy, subjectType, resolvedAnchor,
      finalCellPx: FINAL_CELL_PX, sessionId, signal: extra.signal,
    }));
  }

  if (best?.structuredContent) {
    best.structuredContent.elapsedMs = cumulativeMs;
    best.structuredContent.width = cols * FINAL_CELL_PX;
    best.structuredContent.height = rows * FINAL_CELL_PX;
  }
  return best!;
}
