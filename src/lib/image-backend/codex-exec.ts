import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  IMAGES_DIR,
  LOGS_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  jobDir as jobDirFor,
} from "@/lib/util/paths";
import type {
  ImageBackend,
  ImageBackendKind,
  ImageJob,
  ImageResult,
  ProgressCallback,
} from "./index";
import { chromaKeyFile, lumaKeyFile, GREEN_SUBJECT_RE, VFX_EFFECT_RE, type ChromaKeyColor } from "./chroma-key";

/**
 * CodexExecBackend — `codex exec` 를 spawn 해서 imagegen 스킬을 자동 발동.
 *
 * M0 probe 결과 검증된 흐름:
 *  1. jobDir (`data/tmp/job-{id}`) 생성
 *  2. `codex exec --cd jobDir --sandbox workspace-write --skip-git-repo-check -`
 *     spawn 후 자연어 프롬프트를 stdin 으로 전달
 *  3. Codex 가 SKILL.md 를 읽고 built-in image_gen 도구 호출 (API 키 불필요, 구독 인증)
 *  4. 결과를 `~/.codex/generated_images/{session}/ig_<hash>.png` 에 저장 후
 *     SKILL.md 가이드에 따라 워크스페이스로 `cp` → `./output.png`
 *  5. 우리는 `./output.png` 를 `data/images/{generationId}.png` 로 이동
 */

const BUF_MAX = 500_000;       // stdout/stderr 로그 최대 유지 바이트 (디버깅용)
const KILL_DELAY_MS = 5_000;   // SIGTERM 후 SIGKILL 까지 대기 시간
const CODEX_TIMEOUT_MS = 600_000; // Codex 실행 최대 대기 시간 (10분). 초과 시 SIGTERM → 에러.

const PROMPT_HEADER =
  "You are a game art image generator. " +
  "If the prompt is already detailed and specific, follow it exactly without adding extra elements. " +
  "If the prompt is generic, add tasteful composition framing, lighting mood, and style clarity to improve quality. " +
  "Generate a single high-quality game asset image using the built-in image_gen tool. " +
  "Save the result as ./output.png in your current working directory. " +
  "Do not run remove_chroma_key.py or any background-removal script — the host pipeline handles all post-processing. " +
  "Do not create any other files. Do not write code. Do not explain. Just produce ./output.png.\n\n";

/**
 * Codex image_gen 은 정식 inpaint 가 아니라 image+prompt → 새 이미지 생성기.
 * 따라서 prompt 에 객체 묘사가 있으면 그걸 마스크 영역에 그대로 그려버림.
 * 지우기(erase) 의도가 잡히면 prompt 를 무시하고 객체 금지 템플릿으로 override 해야 한다.
 *
 * orchestrator 가 어떻게 refine 해도 잡히도록 keyword + 부정 패턴으로 보수적 매칭.
 * 사용자가 "더 큰 검" 같은 일반 replace 를 의도했다면 erase 키워드가 안 등장하므로 안전.
 */
function isEraseIntent(prompt: string): boolean {
  const p = prompt.toLowerCase();
  // 강한 erase 신호: "remove"+"object", "erase", "as if ... never", "no objects"
  if (/\b(erase|delete)\b/.test(p)) return true;
  if (/as if (the |it |nothing )?(object|it|nothing) (was )?never/.test(p)) return true;
  if (/no (new )?objects?/.test(p)) return true;
  if (/\bremove (the )?(object|unwanted|item)/.test(p)) return true;
  // 약한 신호 조합: background + (seamless | continuation | matching surrounding)
  if (/seamless/.test(p) && /background|surrounding/.test(p)) return true;
  return false;
}

function buildInpaintPrompt(job: ImageJob): string {
  const hasMask = (job.inputImagePaths?.length ?? 0) >= 2;
  if (hasMask) {
    // 지우기(erase) 의도 감지 — Codex image_gen 은 정식 inpaint 가 아니어서
    // prompt 에 객체명이 한 번이라도 등장하면 그걸 다시 그림. orchestrator 가
    // "fluffy white clouds, wildflowers..." 같은 장면 묘사를 추가하면 모델이
    // 그 객체들을 마스크 영역에 다시 그려넣어 "전혀 안 지워짐" 현상이 발생.
    // 따라서 erase 의도가 잡히면 orchestrator 의 prompt 를 무시하고 강한
    // 객체 금지 템플릿으로 override.
    if (isEraseIntent(job.prompt)) {
      return (
        PROMPT_HEADER +
        `OBJECT REMOVAL. I am attaching TWO images: ` +
        `(1) the original image, and (2) a mask where the RED region marks an element to remove.\n\n` +
        `Remove the red-masked element and fill the vacated area with whatever is naturally behind it: ` +
        `body parts or clothing if the element was in front of the character, ` +
        `background scenery if it was in front of the background, ` +
        `or transparent pixels if it was in front of empty space. ` +
        `Preserve the character's art style, colors, and anatomy as seen outside the red region. ` +
        `Everything outside the red-masked region must be pixel-identical to image 1. ` +
        `Do not include the red color or the mask in the output.`
      );
    }
    return (
      PROMPT_HEADER +
      `I am attaching TWO images: (1) the original image, and ` +
      `(2) a mask where the RED region marks the area to be replaced. ` +
      `Replace ONLY the red region with: ${job.prompt}. ` +
      `Preserve everything outside the red region exactly as in the original. ` +
      `Do not include the red color or the mask itself in the output.`
    );
  }
  return (
    PROMPT_HEADER +
    `Edit the attached image: ${job.prompt}. Preserve everything outside the requested change.`
  );
}

/**
 * 프롬프트에서 chroma-key 색을 결정. 녹색 피사체/이펙트면 magenta, 아니면 green.
 * remove_bg/layer_extract 의 생성 프롬프트(배경색 지시)와 후처리(키아웃 색)가
 * 반드시 동일 색을 쓰도록 단일 소스로 둔다 — 두 곳이 어긋나면 배경이 안 날아간다.
 */
function detectKeyColor(prompt: string): ChromaKeyColor {
  return GREEN_SUBJECT_RE.test(prompt) ? "magenta" : "green";
}

/** 배경 방식 결정: VFX 이펙트 → 검은 배경 + 루미넌스 키, 그 외 → 크로마키. */
function detectBgMode(prompt: string): "luma" | "chroma" {
  return VFX_EFFECT_RE.test(prompt) ? "luma" : "chroma";
}

/** 유저 프롬프트에서 배경색 지정 문구를 제거 — 파이프라인 배경 지시와 충돌 방지 */
function stripBgHints(prompt: string): string {
  return prompt
    .replace(/,?\s*(against|on)\s+(a\s+)?(pure\s+)?(white|black|green|magenta)\s+background[^,.;]*/gi, "")
    .replace(/,?\s*with\s+(transparent\s+)?(white|black|green|magenta)?\s*transparent\s+background[^,.;]*/gi, "")
    .replace(/,?\s*with\s+transparent(\s+(white|black|green|magenta))?\s+background[^,.;]*/gi, "")
    .replace(/,?\s*transparent\s+(white|black|green|magenta)?\s*background[^,.;]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildLayerExtractPrompt(job: ImageJob): string {
  // 입력: [원본 이미지, 마스크 PNG] — 마스크의 RED 영역이 추출할 오브젝트 힌트
  // 추출 대상이 녹색이면 magenta 배경으로 그리게 지시(후처리도 같은 색으로 키아웃).
  const key = detectKeyColor(job.prompt);
  const hex = key === "magenta" ? "#ff00ff" : "#00ff00";
  const hasMask = (job.inputImagePaths?.length ?? 0) >= 2;
  if (hasMask) {
    // job.prompt 에서 " 레이어 추출" 접미사·adjustPrompt 부가어를 제거하고 부위명만 추출.
    const partName = job.prompt.replace(/\s*레이어 추출.*/i, "").replace(/,\s*transparent background.*/i, "").trim();
    const partHint = partName && partName !== "선택 영역"
      ? ` The red-marked region represents "${partName}" — use this as additional context to identify the correct boundaries.`
      : "";
    return (
      PROMPT_HEADER +
      `OBJECT EXTRACTION. I am attaching TWO images: ` +
      `(1) the original image, and (2) a mask where the RED region marks the object to extract.\n\n` +
      `Extract the red-marked object and place it on a flat solid ${hex} chroma-key background.${partHint} ` +
      `Show ONLY the extracted object — infer its complete and accurate boundary ` +
      `(the brush stroke is approximate; use visual context to find the true edges). ` +
      `Preserve the object's original colors, shading, and art style exactly. ` +
      `Everything outside the extracted object must be solid ${hex} ${key} with no gradients or shadows. ` +
      `After Codex saves it as ./output.png, the post-processing pipeline will key out the ${key}.`
    );
  }
  // 마스크 없음: job.prompt 가 부위명 (예: "머리띠", "눈", "몸통")
  const restoreSentence = job.params?.autoRestore !== false
    ? ` If any part of "${job.prompt}" is hidden or occluded by other elements,` +
      ` naturally recreate those hidden parts so the extracted result looks complete.`
    : "";
  return (
    PROMPT_HEADER +
    `OBJECT EXTRACTION. From the attached image, extract "${job.prompt}"` +
    ` and place it on a flat solid ${hex} chroma-key background.\n\n` +
    `Find and extract ONLY the "${job.prompt}" — identify its exact location and boundaries in the image.` +
    restoreSentence +
    ` Preserve the original art style, colors, shading, and details exactly.` +
    ` Everything outside the extracted "${job.prompt}" must be solid ${hex} ${key} with no gradients or shadows.` +
    ` After Codex saves it as ./output.png, the post-processing pipeline will key out the ${key}.`
  );
}

function buildSpritesheetPrompt(job: ImageJob): string {
  // 이미지 첨부 순서 (server.ts overrideInputPaths 기준):
  //   inputCount === 1 → [0] 그리드 템플릿만
  //   inputCount === 2 → [0] 참조 이미지(char ref 또는 pose guide), [1] 그리드 템플릿
  //   inputCount >= 3  → [0] 포즈 가이드, [1] 참조 캐릭터, [2] 그리드 템플릿
  // 그리드 템플릿은 항상 마지막 이미지.
  const inputCount = job.inputImagePaths?.length ?? 0;
  const seamlessLoop = job.params?.seamlessLoop === true;

  // 루프 사이클 규칙 — seamlessLoop=true 일 때만 삽입.
  // "Frame N 직후 Frame 1이 재생"되므로 두 프레임이 인접해야 한다는 관점으로 지시.
  const loopRule = seamlessLoop
    ? `INFINITE LOOP DESIGN: These frames loop forever as [1→2→…→N→1→2→…]. ` +
      `Frame N plays immediately before Frame 1 — design a closed cycle with no visible start or end. ` +
      `Walk/run: Frame N's foot position is the natural step just before Frame 1's foot position resumes. ` +
      `Idle: Frame N is a mid-breath moment that flows directly into Frame 1. ` +
      `NEVER a linear arc. ALWAYS a cycle. `
    : "";

  if (inputCount >= 3) {
    // [0] 포즈 레퍼런스, [1] 참조 캐릭터, [2] 그리드 템플릿
    const gridDim = job.prompt.match(/(\d+)[×x](\d+)/)?.[0] ?? "N×M";
    return (
      PROMPT_HEADER +
      `I am attaching THREE images:\n` +
      `(1) BASE POSE REFERENCE — a stick-figure skeleton strip showing the exact leg/arm angles per column. ` +
      `Use it ONLY as a form guide for leg positions and stride alternation. Do NOT copy its colors or style.\n` +
      `(2) REFERENCE CHARACTER — reproduce this character's exact visual style, colors, outfit, ` +
      `and proportions in every frame.\n` +
      `(3) GRID TEMPLATE — the OUTPUT CANVAS. ` +
      `Your output PNG must match its exact pixel dimensions, one animation frame per cell in the ${gridDim} grid.\n\n` +
      `Task: ${job.prompt}\n\n` +
      `Rules: fill every cell of the grid (image 3) with exactly one sequential frame. ` +
      `Each frame shows image 2's character in the corresponding pose from image 1. ` +
      `Each character must be fully contained within its own cell. ` +
      loopRule
    );
  }

  if (inputCount >= 2) {
    // [0] 참조 이미지(캐릭터 ref 또는 포즈 가이드), [1] 그리드 템플릿
    const gridDim = job.prompt.match(/(\d+)[×x](\d+)/)?.[0] ?? "N×M";
    return (
      PROMPT_HEADER +
      `I am attaching TWO images:\n` +
      `(1) REFERENCE IMAGE — either a character reference (reproduce its exact visual style, colors, outfit) ` +
      `or a pose guide (use it only for leg/arm angles, do not copy its style).\n` +
      `(2) GRID TEMPLATE — this is the OUTPUT CANVAS. ` +
      `It shows a blank ${gridDim} grid with thin gray cell lines. ` +
      `Your output PNG must have EXACTLY the same pixel dimensions as this template, ` +
      `with one sequential animation frame drawn inside each cell.\n\n` +
      `Task: ${job.prompt}\n\n` +
      `Rules: fill every cell of the grid (image 2) with exactly one sequential frame. ` +
      `Each frame's content must be fully contained within its own cell. ` +
      loopRule
    );
  }
  if (inputCount === 1) {
    // [0] 그리드 템플릿만. 피사체가 캐릭터일 수도 이펙트(VFX)일 수도 있으므로 "character"
    // 로 단정하지 않는다 — 단정하면 슬래시/폭발 같은 이펙트 시트에도 캐릭터가 끼어든다.
    return (
      PROMPT_HEADER +
      `The attached image is the OUTPUT CANVAS — a blank grid with thin gray cell lines. ` +
      `Your output PNG must have EXACTLY the same pixel dimensions as this template. ` +
      `Task: ${job.prompt}\n` +
      `Draw one sequential animation frame inside each cell of the grid. ` +
      `Render exactly what the task describes and nothing more — ` +
      `if the task is a visual effect/VFX (slash, explosion, magic, impact, etc.), ` +
      `draw ONLY that effect with NO character or figure unless the task explicitly asks for one. ` +
      `Each frame's content must be fully contained within its own cell. ` +
      loopRule
    );
  }
  // 그리드 템플릿 없음 (fallback)
  return (
    PROMPT_HEADER +
    `Generate a single PNG containing a sprite sheet: ${job.prompt}. ` +
    `Uniform cell size, evenly spaced grid, one animation frame per cell. ` +
    `Render exactly what the task describes — if it is a visual effect/VFX, ` +
    `draw ONLY the effect with no character unless explicitly requested. ` +
    loopRule
  );
}

function buildReskinPrompt(job: ImageJob): string {
  // 3모드 분기 (server.ts reskin_image 핸들러가 결정):
  //   (c) styleRefPath 있음 → inputImagePaths=[base, styleRef] 2장, 참조 화풍 전이
  //   (b) paletteOnly=true  → 형태 100% 유지, 색 팔레트만 교체
  //   (a) 그 외 (prompt만)  → 외형 교체 (포즈/실루엣/구도 유지, 색·재질·테마만)
  // 스프라이트시트 대상이면 셀 구조·프레임수·포즈 유지 문구를 추가 (params.spritesheet).
  const isSheet = job.params?.spritesheet === true;
  const sheetRule = isSheet
    ? `This is a SPRITE SHEET: preserve the exact grid layout, the same number of cells/frames, ` +
      `and the per-frame poses. Re-skin every frame identically and keep each frame's character ` +
      `fully inside its own cell. `
    : "";

  if (job.styleRefPath) {
    // (c) 베이스(Image 1) = 포즈 소스, 참조(Image 2) = 외형 소스.
    const extra = job.prompt ? `Additional guidance: ${job.prompt}. ` : "";
    const refIsSheet = job.params?.refIsSheet === true;
    if (isSheet) {
      // 케이스 1: 베이스 시트 포즈 유지 × 참조 외형 교체 → 시트 출력
      return (
        PROMPT_HEADER +
        `I am attaching TWO images:\n` +
        `Image 1 = POSE SHEET — a base spritesheet. Each cell shows a DIFFERENT pose and direction. ` +
        `Preserve EVERY cell's unique pose, facing direction, body angle, and grid layout EXACTLY.\n` +
        `Image 2 = CHARACTER REFERENCE — this character's appearance (face, outfit, colors, proportions) ` +
        `must COMPLETELY REPLACE the character in every cell of Image 1.\n\n` +
        `Task: Redraw every cell of Image 1 using Image 2's character in each corresponding pose. ` +
        `The character in every cell must look IDENTICAL to Image 2 — NOT Image 1. ` +
        `Each cell must keep its own UNIQUE pose exactly as shown in Image 1. Do NOT repeat the same pose across cells. ` +
        `Same grid dimensions as Image 1. Transparent background. ` +
        extra
      );
    }
    if (refIsSheet) {
      // 케이스 3: 참조 시트 포즈 × 베이스 단일 외형 → 시트 출력.
      // 입력 순서 [참조 시트(Image 1=포즈), 베이스(Image 2=외형)] (server.ts 가 구성).
      return (
        PROMPT_HEADER +
        `I am attaching TWO images:\n` +
        `Image 1 = POSE SHEET — a spritesheet showing multiple poses/directions. ` +
        `Preserve EVERY cell's unique pose, facing direction, body angle, and grid layout EXACTLY.\n` +
        `Image 2 = CHARACTER REFERENCE — this character's appearance (face, outfit, colors, proportions) ` +
        `must fill every cell of Image 1's grid.\n\n` +
        `Task: Redraw every cell of Image 1 using Image 2's character in each corresponding pose. ` +
        `The character in every cell must look IDENTICAL to Image 2 — NOT Image 1. ` +
        `Each cell must keep its own UNIQUE pose exactly as shown in Image 1. Do NOT repeat the same pose across cells. ` +
        `Same grid dimensions as Image 1. Transparent background. ` +
        extra
      );
    }
    // 케이스 2: 베이스 단일 포즈 유지 × 참조 외형 교체 → 단일 출력
    return (
      PROMPT_HEADER +
      `I am attaching TWO images:\n` +
      `Image 1 = POSE REFERENCE — use its EXACT pose, body angle, and composition.\n` +
      `Image 2 = CHARACTER REFERENCE — this character's appearance (face, outfit, colors, proportions) ` +
      `must COMPLETELY REPLACE the character shown in Image 1.\n\n` +
      `Task: Redraw Image 1's pose using Image 2's character. ` +
      `The output character must look IDENTICAL to Image 2 — NOT Image 1. ` +
      `Only the pose and body angle are taken from Image 1. ` +
      `Same dimensions as Image 1. Transparent background. ` +
      extra
    );
  }
  if (job.paletteOnly) {
    // (b) 팔레트만 교체
    return (
      PROMPT_HEADER +
      `Recolor only: keep every shape/line/form pixel-identical; ` +
      `change ONLY the color palette to ${job.prompt}. No structural changes. Same dimensions. ` +
      sheetRule
    );
  }
  // (a) 외형 교체
  return (
    PROMPT_HEADER +
    `Re-skin the attached character to: ${job.prompt}. ` +
    `Keep the EXACT same pose, silhouette, proportions, composition, framing — ` +
    `change only colors, materials, textures, outfit theme. Same dimensions. ` +
    sheetRule
  );
}

function buildEmoteSheetPrompt(job: ImageJob): string {
  const inputCount = job.inputImagePaths?.length ?? 0;
  if (inputCount >= 2) {
    // [0] 참조 캐릭터, [1] 그리드 템플릿
    return (
      PROMPT_HEADER +
      `I am attaching TWO images:\n` +
      `(1) REFERENCE CHARACTER — reproduce this character's exact visual style, colors, outfit, and proportions in every cell.\n` +
      `(2) GRID TEMPLATE — the OUTPUT CANVAS with thin gray cell lines. Your output PNG must match its exact pixel dimensions.\n\n` +
      `Task: ${job.prompt}\n\n` +
      `Rules: draw the SAME character in each cell, only the FACIAL EXPRESSION changes. ` +
      `Keep the body pose, outfit, and proportions identical across all cells. ` +
      `Transparent background.`
    );
  }
  return PROMPT_HEADER + `Generate an emotion expression sheet: ${job.prompt}. Transparent background.`;
}

// mask/layer/external 은 외부 업로드·레이어 행이라 codex 로 생성되지 않음 — 도달 시 버그.
// normal_map 은 sharp 결정적 처리(server.ts)라 codex 미경유.
const promptBuilders: Partial<Record<string, (job: ImageJob) => string>> = {
  text2img: (job) => PROMPT_HEADER + `Generate an image: ${job.prompt}`,
  img2img: (job) => {
    // srcHasTransparent: 원본이 투명 배경이면 Codex 가 결과를 흰색으로 채우는 경향이 있어
    // (composite-ai 합성 흐름) #00ff00 green 위에 그리게 지시하고 후처리에서 키아웃한다.
    const greenSuffix = job.params?.srcHasTransparent
      ? ` Place the subject on a flat solid #00ff00 green chroma-key background. The post-processing pipeline will remove the green.`
      : ``;
    return PROMPT_HEADER + `Use the attached image as a reference. Generate a new image: ${job.prompt}.${greenSuffix}`;
  },
  inpaint: buildInpaintPrompt,
  upscale: (job) => PROMPT_HEADER + `Upscale the attached image to higher resolution while preserving all detail. ${job.prompt}`,
  remove_bg: (job) => {
    // VFX 이펙트(연기·불꽃·글로우 등): 검은 배경 → 루미넌스 키.
    // 캐릭터·오브젝트: green/magenta 크로마키 배경 → 크로마키.
    if (detectBgMode(job.prompt) === "luma") {
      return (
        PROMPT_HEADER +
        `Regenerate the attached VFX effect on a flat solid #000000 pure black background ` +
        `(no gradients, no glow bleed onto background). After Codex saves it as ./output.png, ` +
        `the post-processing pipeline will apply luminance keying. ${stripBgHints(job.prompt)} ` +
        `CRITICAL: background must be #000000 pure black only — ignore any other background color mentioned above.`
      );
    }
    const key = detectKeyColor(job.prompt);
    const hex = key === "magenta" ? "#ff00ff" : "#00ff00";
    return (
      PROMPT_HEADER +
      `Regenerate the attached subject on a flat solid ${hex} chroma-key background ` +
      `(no shadows, no gradients, crisp edges). After Codex saves it as ./output.png, ` +
      `the post-processing pipeline will key out the ${key}. ${stripBgHints(job.prompt)} ` +
      `CRITICAL: background must be ${hex} only — ignore any other background color mentioned above.`
    );
  },
  layer_extract: buildLayerExtractPrompt,
  spritesheet: buildSpritesheetPrompt,
  reskin: buildReskinPrompt,
  emote_sheet: buildEmoteSheetPrompt,
  tileset: (job) =>
    PROMPT_HEADER +
    `Generate a seamless tileable game texture: ${job.prompt}. ` +
    `CRITICAL: this texture must tile perfectly in all 4 directions — left edge must seamlessly match ` +
    `the right edge, top edge must match the bottom edge, with no visible seams when tiled. ` +
    `Use flat uniform lighting with no vignettes, gradients, or darkening near the edges. ` +
    `2D game-ready top-down or side-view tile asset.`,
};

function buildNaturalPrompt(job: ImageJob): string {
  const builder = promptBuilders[job.kind];
  if (builder) return builder(job);
  throw new Error(`buildNaturalPrompt: unsupported kind '${job.kind}'`);
}

/** stdout 한 줄을 보고 어떤 단계에 와 있는지 추정. */
function inferStage(
  line: string,
): "image_generating" | "recovering" | null {
  if (line.includes("generated_images") && line.includes("find")) return "image_generating";
  if (line.includes("generated_images") && line.includes("cp ")) return "recovering";
  if (line.includes("Done.") && !line.includes("ok")) return null;
  return null;
}

/**
 * chroma-key 처리 (in-place). prompt 에서 키색 자동 감지 — 녹색 피사체면 magenta, 아니면 green.
 * 생성 프롬프트(detectKeyColor 로 배경색 지시)와 동일 색을 키아웃해야 배경이 제대로 날아간다.
 *
 * 공유 적응형 구현(chroma-key.ts 의 chromaKeyFile)에 위임한다. 과거에는 codex-exec 가
 * 단순 greenness-feather 별도 구현을, spritesheet-postprocess 가 적응형(테두리-connected
 * 배경만 키아웃·flood-fill 본체 보호·despill) 구현을 따로 갖고 있었다. 두 경로가 동일
 * 알고리즘을 쓰도록 통합했다.
 *
 * 단일 이미지 경로(remove_bg/layer_extract)이므로 cellArea 는 미지정(=전체 N) 으로
 * 둔다 — enclosed 배경 포켓 흡수 임계가 단일 이미지 기준으로 올바르게 잡힌다. 반환 keyedOut
 * 카운트는 이 경로에서 쓰지 않으므로 버린다.
 */
async function chromaKeyAuto(filePath: string, prompt: string): Promise<void> {
  await chromaKeyFile(filePath, detectKeyColor(prompt));
}

/**
 * 원본 이미지가 투명 배경(PNG alpha)인지 판정.
 * Codex image_gen 은 투명 입력을 받으면 결과를 #00ff00 chroma-key 위에 그리는
 * 경향이 있어, inpaint 결과에도 chromaKeyGreen 을 적용할지 결정하는 데 쓴다.
 *
 * 전체 픽셀 스캔은 큰 이미지에서 느리므로 100×100 으로 다운샘플 후 판정한다.
 * 다운샘플은 알파의 부분 투명을 평균내므로 alpha<255 임계는 보수적으로 동작
 * (완전 불투명 시트만 false 가 됨).
 */
export async function hasTransparentBackground(imagePath: string): Promise<boolean> {
  const { data, info } = await sharp(imagePath, { limitInputPixels: false })
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels < 4) return false;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] < 255) return true;
  }
  return false;
}

export class CodexExecBackend implements ImageBackend {
  readonly kind: ImageBackendKind = "codex_exec";

  async execute(
    job: ImageJob,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ImageResult> {
    ensureDataDirs();
    const workDir = jobDirFor(job.id);
    await fs.mkdir(workDir, { recursive: true });

    // img2img/inpaint 등 입력 이미지가 있으면 workDir 로 복사 (codex 가 직접 접근 가능하게)
    const attachedImages: string[] = [];
    if (job.inputImagePaths?.length) {
      for (let i = 0; i < job.inputImagePaths.length; i++) {
        const src = job.inputImagePaths[i];
        const dst = path.join(workDir, `input${i}${path.extname(src) || ".png"}`);
        await fs.copyFile(src, dst);
        attachedImages.push(dst);
      }
    }

    const naturalPrompt = buildNaturalPrompt(job);
    // 프롬프트는 stdin 으로 전달한다. Windows 인자 재파싱 및 `exec <COMMAND> [ARGS]`
    // 대체 파서가 프롬프트 단어를 명령으로 오인하는 문제를 피한다.
    // `-i, --image <FILE>...` 는 multi-value 옵션이라, attached image 가 있으면
    // `--` 로 옵션 종료를 명시한 뒤 stdin sentinel `-` 를 positional 로 둔다.
    const args = [
      "exec",
      "--cd",
      workDir,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-c", `model_reasoning_effort="high"`,
      ...attachedImages.flatMap(p => ["-i", p]),
      ...(attachedImages.length > 0 ? ["--"] : []),
      "-",
    ];

    onProgress("starting", `codex exec (job ${job.id})`);

    const startedAt = performance.now();
    // Windows에서 shell:true로 .cmd를 실행하면 인수가 재파싱돼 프롬프트가 쪼개진다.
    // codex.cmd는 node로 codex.js를 실행하는 래퍼이므로 node를 직접 스폰한다.
    const isWin = process.platform === "win32";
    let spawnCmd: string;
    let spawnArgs: string[];
    if (isWin) {
      const npmBin = process.env.npm_config_prefix
        ?? `${process.env.APPDATA}\\npm`;
      const codexJs = `${npmBin}\\node_modules\\@openai\\codex\\bin\\codex.js`;
      spawnCmd = process.execPath; // node.exe
      spawnArgs = [codexJs, ...args];
    } else {
      spawnCmd = "codex";
      spawnArgs = args;
    }
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
      shell: false,
    });
    child.stdin!.end(naturalPrompt);

    // AbortSignal 연결
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        throw new DOMException("aborted", "AbortError");
      }
      signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          // SIGKILL은 Windows에서 지원하지 않으므로 SIGTERM만 사용
          if (!isWin) setTimeout(() => child.kill("SIGKILL"), KILL_DELAY_MS).unref();
        },
        { once: true },
      );
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastStage: ReturnType<typeof inferStage> = null;
    let lineBuf = "";
    let stderrLineBuf = "";
    // codex 는 SKILL.md(~6KB) + 실행 로그를 stderr 에 쏟아내므로 메모리 누적 방지.
    // 로그 저장용 버퍼는 최신 BUF_MAX 만 유지 (디버깅에 충분).

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf += text;
      if (stdoutBuf.length > BUF_MAX) stdoutBuf = stdoutBuf.slice(-BUF_MAX);
      lineBuf += text;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        const stage = inferStage(line);
        if (stage && stage !== lastStage) {
          lastStage = stage;
          onProgress(stage);
        }
      }
    });
    // inferStage 패턴(SKILL.md, generated_images find/cp)은 모두 stderr 에 출력됨.
    // stdout 에는 마지막 ./output.png 한 줄만 오므로 stderr 도 라인 단위로 파싱.
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > BUF_MAX) stderrBuf = stderrBuf.slice(-BUF_MAX);
      stderrLineBuf += text;
      let idx: number;
      while ((idx = stderrLineBuf.indexOf("\n")) !== -1) {
        const line = stderrLineBuf.slice(0, idx);
        stderrLineBuf = stderrLineBuf.slice(idx + 1);
        const stage = inferStage(line);
        if (stage && stage !== lastStage) {
          lastStage = stage;
          onProgress(stage);
        }
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          if (!isWin) setTimeout(() => child.kill("SIGKILL"), KILL_DELAY_MS).unref();
          reject(new Error(`Codex timed out after ${CODEX_TIMEOUT_MS / 1000}s`));
        }, CODEX_TIMEOUT_MS);
        timer.unref();
        child.once("exit", (code, sig) => {
          clearTimeout(timer);
          resolve({ code, signal: sig });
        });
      },
    );

    // 로그 덤프 (디버깅용. data/logs/{jobId}.log)
    const logFile = path.join(LOGS_DIR, `codex-${job.id}.log`);
    await fs.writeFile(
      logFile,
      `# codex exec args:\n${JSON.stringify(args, null, 2)}\n\n# prompt stdin:\n${naturalPrompt}\n\n# stdout:\n${stdoutBuf}\n\n# stderr:\n${stderrBuf}`,
    );

    if (exit.code !== 0) {
      throw new Error(
        `codex exec exited with code ${exit.code} (signal ${exit.signal}). See ${logFile}`,
      );
    }

    // workDir 에서 output.png 찾기
    onProgress("recovering", "scanning workdir");
    const outputCandidate = path.join(workDir, "output.png");
    let pickedPath: string | null = null;
    try {
      await fs.stat(outputCandidate);
      pickedPath = outputCandidate;
    } catch {
      // fallback: 가장 최근의 .png 파일을 채택.
      // 단, workDir 로 복사된 입력 이미지(input0.png, input1.png …)는 제외한다.
      // codex 가 조용히 실패해 output.png 를 못 만들면 입력 파일이 "가장 최근 PNG"로
      // 잘못 선택되어 입력이 곧 결과로 반환되는 silent wrong-output 버그를 막는다.
      const entries = await fs.readdir(workDir);
      const pngs = entries.filter(
        e => e.toLowerCase().endsWith(".png") && !/^input\d*\.png$/i.test(e),
      );
      if (pngs.length === 0) {
        throw new Error(`No PNG produced in ${workDir}. See ${logFile}`);
      }
      // mtime 으로 가장 최근
      const stats = await Promise.all(
        pngs.map(async e => ({ name: e, mtime: (await fs.stat(path.join(workDir, e))).mtimeMs })),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      pickedPath = path.join(workDir, stats[0].name);
    }

    // 최종 위치로 이동
    const destPath = imagePathFor(job.generationId);
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    await fs.rename(pickedPath, destPath);

    // remove_bg 후처리: VFX 이펙트 → 루미넌스 키, 캐릭터/오브젝트 → 크로마키.
    // layer_extract 는 항상 크로마키(마스크 기반 추출이라 VFX 경우가 없음).
    if (job.kind === "remove_bg") {
      if (detectBgMode(job.prompt) === "luma") {
        onProgress("recovering", "luma key post-process");
        const lumaKeyedOut = await lumaKeyFile(destPath);
        await fs.appendFile(logFile, `\n# lumaKeyFile: keyedOut=${lumaKeyedOut}`);
      } else {
        onProgress("recovering", "chroma key post-process");
        await chromaKeyAuto(destPath, job.prompt);
      }
    }
    if (job.kind === "layer_extract") {
      onProgress("recovering", "chroma key post-process");
      await chromaKeyAuto(destPath, job.prompt);
    }

    // inpaint 후처리: 원본이 투명 배경이면 Codex 가 결과를 #00ff00 위에 그려버리므로
    // (remove_bg 와 동일한 이유) green chroma-key 로 배경을 다시 투명화한다.
    // 이 녹색은 모델이 자발적으로 그리는 것(프롬프트 지시 아님)이라 항상 green 으로 고정.
    // 원본이 불투명이면 inpaint 결과도 불투명이라 키아웃하지 않는다.
    if (job.kind === "inpaint" && job.inputImagePaths?.[0]) {
      const parentHasAlpha = await hasTransparentBackground(job.inputImagePaths[0]);
      if (parentHasAlpha) {
        onProgress("recovering", "chroma key post-process (transparent parent)");
        await chromaKeyFile(destPath, "green");
      }
    }

    // img2img 후처리: srcHasTransparent=true(원본 투명 배경, composite-ai 합성)면
    // 프롬프트에서 #00ff00 green 위에 그리도록 지시했으므로 green 을 키아웃해 투명 복원.
    if (job.kind === "img2img" && job.params?.srcHasTransparent) {
      onProgress("recovering", "chroma key post-process (transparent parent)");
      await chromaKeyFile(destPath, "green");
    }

    // 메타데이터
    const meta = await sharp(destPath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const elapsedMs = Math.round(performance.now() - startedAt);
    onProgress("done", `${width}×${height}, ${(elapsedMs / 1000).toFixed(1)}s`);

    // 성공 시 workDir 정리. 실패 시에는 input 이미지 등 디버깅 자료가 남아있으므로 유지.
    // (실패는 위 throw 로 빠져나가므로 여기까지 오면 항상 성공.)
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

    return {
      imagePath: destPath,
      width,
      height,
      elapsedMs,
      rawStdoutTail: stdoutBuf.slice(-1000),
    };
  }
}
