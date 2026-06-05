/**
 * reskin_image 핸들러.
 *
 * 3모드: (a) prompt 만 → 외형 교체 / (b) paletteOnly → 색 팔레트만 / (c) styleReferenceId → 화풍 전이.
 * 대상이 스프라이트시트면(또는 케이스 3 참조 시트) 셀 정렬·투명화 후처리가 자동 적용된다.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { getGeneration } from "../../db/repo/generations.js";
import { DATA_DIR, imagePath as imagePathFor } from "../../util/paths.js";
import { detectSpriteGrid } from "../../shared/detect-sprite-grid.js";
import { normalizeSpritesheetCells, type SubjectType } from "../../image-backend/spritesheet-postprocess.js";
import {
  applyTransparentPostProcess,
  detectTransparentBg,
  loadGenerationWithPath,
  requireString,
  runImageTool,
  type HandlerContext,
  type HandlerExtra,
  type ToolResponse,
} from "./shared.js";

export async function handleReskinImage(
  args: Record<string, unknown>,
  extra: HandlerExtra,
  ctx: HandlerContext,
): Promise<ToolResponse> {
  const { sessionId, log } = ctx;
  const inputId = requireString(args.inputGenerationId, "inputGenerationId");
  const { gen: inputGen, filePath: inputPath } = loadGenerationWithPath(inputId);

  const paletteOnly = args.paletteOnly === true;
  const styleRefId =
    typeof args.styleReferenceId === "string" && args.styleReferenceId
      ? args.styleReferenceId
      : null;
  const prompt = typeof args.prompt === "string" ? args.prompt : "";

  // 모드 결정: c(참조) > b(팔레트) > a(외형). c·b 외엔 prompt 가 사실상 필수.
  // 참조(styleRef) = 외형 소스, 베이스(input) = 포즈 소스.
  let styleRefPath: string | undefined;
  const inputGenerationIds = [inputId];
  let overrideInputPaths: string[] | undefined;
  const isSheet = inputGen.kind === "spritesheet";
  // styleGen/refIsSheet 를 블록 밖(메타 상속·후처리)에서 참조하기 위해 스코프 확장.
  let styleGen: ReturnType<typeof getGeneration> | undefined;
  let refIsSheet = false;
  if (styleRefId) {
    styleGen = getGeneration(styleRefId);
    if (!styleGen) throw new Error(`style reference generation not found: ${styleRefId}`);
    const rawStyleRefPath = path.join(DATA_DIR, styleGen.image_path);

    refIsSheet =
      styleGen.kind === "spritesheet" ||
      (!!styleGen.width &&
        !!styleGen.height &&
        detectSpriteGrid(styleGen.width, styleGen.height) !== null);

    styleRefPath = rawStyleRefPath;
    if (refIsSheet && !isSheet) {
      // 케이스 3: 베이스=단일, 참조=시트. 첫 프레임 크롭하지 않고 참조 시트 전체를
      // 포즈 소스로 사용한다. 입력 순서 [참조 시트(포즈), 베이스(외형)] — Image 1 의
      // 그리드/포즈가 결과 구조를 결정하므로 참조 시트를 Image 1 로 둔다.
      overrideInputPaths = [rawStyleRefPath, inputPath];
    } else {
      // 케이스 1·2: [베이스(포즈 소스), 참조(외형 소스)]. 베이스를 Image 1 로 유지.
      overrideInputPaths = [inputPath, rawStyleRefPath];
    }
    inputGenerationIds.push(styleRefId);
  }
  if (!styleRefId && !prompt) {
    throw new Error("reskin_image requires either a prompt or a styleReferenceId");
  }

  // 케이스 3: 베이스가 단일이지만 참조가 시트 → 결과도 시트.
  const effectiveIsSheet = isSheet || refIsSheet;

  // 시트면 배경 상속(투명 여부) — 후처리 chroma-key/정렬에 사용. 케이스 3 은
  // 포즈 소스(참조 시트)의 투명 여부를 따른다.
  const wantsTransparent = effectiveIsSheet
    ? await detectTransparentBg(isSheet ? inputPath : styleRefPath!)
    : false;

  // reskin 은 시트 치수를 보존하므로 sprite 그리드 메타를 그대로 상속해 영속한다
  // (SpriteCanvas source-of-truth · 아틀라스 export). 케이스 1·2 는 베이스 시트,
  // 케이스 3 은 참조 시트(styleGen)의 params 를 상속한다. 구버전 시트는 값이
  // undefined → JSON.stringify 시 빠져 GCD 폴백(회귀 없음).
  const sheetParamsSource =
    isSheet && inputGen.params && typeof inputGen.params === "object"
      ? (inputGen.params as Record<string, unknown>)
      : !isSheet && refIsSheet && styleGen?.params && typeof styleGen.params === "object"
        ? (styleGen.params as Record<string, unknown>)
        : null;
  const inheritedSheetParams = sheetParamsSource
    ? {
        subjectType: sheetParamsSource.subjectType,
        anchorStrategy: sheetParamsSource.anchorStrategy,
        anchor: sheetParamsSource.anchor,
        directions: sheetParamsSource.directions,
        rows: sheetParamsSource.rows,
        cols: sheetParamsSource.cols,
        cellW: sheetParamsSource.cellW,
        cellH: sheetParamsSource.cellH,
        fps: sheetParamsSource.fps,
      }
    : {};

  const mcpResult = await runImageTool({
    name: "reskin_image",
    kind: "reskin",
    // 시트를 리스킨한 결과는 그 자체가 시트 → 'spritesheet' 로 저장해야 재-리스킨·
    // 스프라이트 도구가 시트로 인식한다. 단일 입력은 'reskin' 유지. (codex 프롬프트는
    // 위 kind='reskin' 으로 선택되므로 영향 없음.) 케이스 3 도 결과가 시트이므로 포함.
    storeKind: effectiveIsSheet ? "spritesheet" : "reskin",
    prompt,
    inputGenerationIds,
    overrideInputPaths,
    styleRefPath,
    paletteOnly,
    params: {
      ...inheritedSheetParams,
      mode: styleRefId ? "style_ref" : paletteOnly ? "palette" : "appearance",
      styleReferenceId: styleRefId,
      spritesheet: effectiveIsSheet,
      refIsSheet: !isSheet && refIsSheet, // codex-exec 케이스 3 분기 플래그
    },
    sessionId,
    signal: extra.signal,
  });

  // 결과가 시트(케이스 1·2·3)면 후처리: resize → chroma-key → normalizeSpritesheetCells.
  // grid 는 결과 치수에서 detectSpriteGrid 로 역산. 감지 실패 시 단일처럼 폴백(스킵).
  if (effectiveIsSheet) {
    const genId: string | undefined = mcpResult?.structuredContent?.generationId;
    if (genId) {
      const filePath = imagePathFor(genId);
      try {
        const meta = await sharp(filePath).metadata();
        const grid = detectSpriteGrid(meta.width ?? 0, meta.height ?? 0);
        if (!grid) {
          log(`reskin_image: grid detect failed (${meta.width}x${meta.height}), skip sheet post-process`);
        } else {
          const { rows, cols } = grid;
          const cellW = Math.floor((meta.width ?? 0) / cols);
          const cellH = Math.floor((meta.height ?? 0) / rows);
          const canvasW = cols * cellW;
          const canvasH = rows * cellH;
          const resizeTmp = `${filePath}.resize.tmp`;
          await sharp(filePath)
            .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
            .png()
            .toFile(resizeTmp);
          fs.renameSync(resizeTmp, filePath);
          // chroma-key 제거 후 keyedOut=0이면 배경이 green이 아님(black 등).
          // 이 경우 normalizeSpritesheetCells 는 전체를 하나의 content로 인식해
          // scale=0.2 수준으로 축소시키므로 스킵한다.
          let keyedOut = 0;
          if (wantsTransparent) {
            keyedOut = await applyTransparentPostProcess(filePath, "green");
          }
          const parentSubject = inputGen.params?.subjectType;
          const reskinSubject: SubjectType = parentSubject === "effect" ? "effect" : "character";
          if (keyedOut > 0) {
            await normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, {
              subjectType: reskinSubject,
              log,
            });
          } else if (wantsTransparent && isSheet) {
            // 케이스 1·2(베이스=시트)에서만: reskin 출력에 green 배경 없음(black RGB 등)
            // → 베이스 시트의 원본 alpha 마스크를 적용. 케이스 3 은 베이스가 단일이라
            // 픽셀 인덱스가 시트와 불일치 → 이 폴백을 쓰지 않는다(아래 skip 으로 폴백).
            // 원본을 결과와 동일 치수(canvasW×canvasH)로 리사이즈해서 읽어야 픽셀
            // 인덱스가 일치한다(filePath 는 위에서 이미 canvasW×canvasH 로 리사이즈됨).
            const { data: origData, info: origInfo } = await sharp(inputPath)
              .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            const { data: reskinData } = await sharp(filePath)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            // 원본 alpha → reskin 에 복사
            for (let i = 0; i < origInfo.width * origInfo.height; i++) {
              reskinData[i * 4 + 3] = origData[i * 4 + 3];
            }
            const tmpMask = `${filePath}.mask.tmp`;
            await sharp(Buffer.from(reskinData), {
              raw: { width: origInfo.width, height: origInfo.height, channels: 4 },
            })
              .png()
              .toFile(tmpMask);
            fs.renameSync(tmpMask, filePath);
            log(`reskin_image: applied original alpha mask to reskin result`);
          } else {
            log(`reskin_image: chroma-key keyedOut=0, skipping normalize (non-green background)`);
          }
          log(`reskin_image sheet post-process gen=${genId} ${cols}x${rows} transparent=${wantsTransparent} subject=${reskinSubject}`);
        }
      } catch (e) {
        log(`reskin_image post-process fail: ${(e as Error).message}`);
      }
    }
  }
  return mcpResult;
}
