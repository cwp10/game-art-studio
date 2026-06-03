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

/**
 * CodexExecBackend — `codex exec` 를 spawn 해서 imagegen 스킬을 자동 발동.
 *
 * M0 probe 결과 검증된 흐름:
 *  1. jobDir (`data/tmp/job-{id}`) 생성
 *  2. `codex exec --cd jobDir --sandbox workspace-write --skip-git-repo-check "<자연어>"` spawn
 *  3. Codex 가 SKILL.md 를 읽고 built-in image_gen 도구 호출 (API 키 불필요, 구독 인증)
 *  4. 결과를 `~/.codex/generated_images/{session}/ig_<hash>.png` 에 저장 후
 *     SKILL.md 가이드에 따라 워크스페이스로 `cp` → `./output.png`
 *  5. 우리는 `./output.png` 를 `data/images/{generationId}.png` 로 이동
 */

const BUF_MAX = 500_000;       // stdout/stderr 로그 최대 유지 바이트 (디버깅용)
const KILL_DELAY_MS = 5_000;   // SIGTERM 후 SIGKILL 까지 대기 시간
const CODEX_TIMEOUT_MS = 360_000; // Codex 실행 최대 대기 시간 (6분). 초과 시 SIGTERM → 에러.

const PROMPT_HEADER =
  "Use the imagegen skill. " +
  "Save the result as a PNG file at the path ./output.png in your current working directory. " +
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

function buildNaturalPrompt(job: ImageJob): string {
  switch (job.kind) {
    case "text2img":
      return PROMPT_HEADER + `Generate an image: ${job.prompt}`;
    case "img2img":
      return (
        PROMPT_HEADER +
        `Use the attached image as a reference. Generate a new image: ${job.prompt}`
      );
    case "inpaint": {
      // 2개 첨부: [원본, 마스크]. 1개: 마스크 없는 전역 inpaint (edit_image 와 사실상 동등).
      // probe-codex-inpaint.mjs 에서 검증된 정확한 자연어 사용.
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
    case "upscale":
      return (
        PROMPT_HEADER +
        `Upscale the attached image to higher resolution while preserving all detail. ${job.prompt}`
      );
    case "remove_bg":
      return (
        PROMPT_HEADER +
        `Regenerate the attached subject on a flat solid #00ff00 chroma-key background ` +
        `(no shadows, no gradients, crisp edges). After Codex saves it as ./output.png, ` +
        `the post-processing pipeline will key out the green. ${job.prompt}`
      );
    case "spritesheet": {
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
    case "reskin": {
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
        // (c) 참조 스타일 전이
        return (
          PROMPT_HEADER +
          `I am attaching TWO images.\n` +
          `Image 1 = base (keep its pose/structure/layout/composition).\n` +
          `Image 2 = style reference.\n` +
          `Re-skin image 1 with image 2's visual style/material/palette. ` +
          `Keep image 1's exact pose and composition. Same dimensions. ` +
          (job.prompt ? `Additional guidance: ${job.prompt}. ` : "") +
          sheetRule
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
    case "emote_sheet": {
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

    case "tileset":
      return (
        PROMPT_HEADER +
        `Generate a seamless tileable game texture: ${job.prompt}. ` +
        `CRITICAL: this texture must tile perfectly in all 4 directions — left edge must seamlessly match ` +
        `the right edge, top edge must match the bottom edge, with no visible seams when tiled. ` +
        `Use flat uniform lighting with no vignettes, gradients, or darkening near the edges. ` +
        `2D game-ready top-down or side-view tile asset.`
      );

    // mask/layer/external 은 외부 업로드·레이어 행이라 codex 로 생성되지 않음 — 도달 시 버그.
    // normal_map 은 sharp 결정적 처리(server.ts)라 codex 미경유.
    default:
      throw new Error(`buildNaturalPrompt: unsupported kind '${job.kind}'`);
  }
}

/** stdout 한 줄을 보고 어떤 단계에 와 있는지 추정. */
function inferStage(
  line: string,
): "skill_loading" | "image_generating" | "recovering" | null {
  if (line.includes("imagegen/SKILL.md")) return "skill_loading";
  if (line.includes("generated_images") && line.includes("find")) return "image_generating";
  if (line.includes("generated_images") && line.includes("cp ")) return "recovering";
  if (line.includes("Done.") && !line.includes("ok")) return null;
  return null;
}

/**
 * #00ff00 chroma-key 처리 (in-place). greenness(= g - max(r,b)) 기반 feather:
 *   - greenness 강함 → alpha 0 (완전 키)
 *   - greenness 약함(anti-alias fringe) → 그린 채널 탈채도 + greenness 비례 알파 감쇠
 * 색만 빼고 불투명하게 두면 어두운 헤일로 링이 남으므로 fringe 의 알파를 함께 깎는다.
 *
 * NOTE: 단일 이미지 remove_bg 전용. 스프라이트시트는 더 강한 후처리(테두리-connected
 *       배경만 키아웃·적응형 임계값·green/magenta 일반화)를 쓰는 별도 구현
 *       src/lib/image-backend/spritesheet-postprocess.ts 의 chromaKeyFile 을 사용한다.
 */
async function chromaKeyGreen(filePath: string): Promise<void> {
  const img = sharp(filePath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const greenness = g - Math.max(r, b);
    // 확실한 키 픽셀 → 완전 투명
    if (greenness > 40 && g > 90) {
      data[i + 3] = 0;
      continue;
    }
    // fringe — 탈채도 후 greenness(5~40)를 알파 감쇠(1→0)로 매핑.
    // 캐릭터에 의도된 녹색이 있으면 같이 영향받지만 게임 캐릭터에서는 드물다.
    if (data[i + 3] > 0 && greenness > 5) {
      data[i + 1] = Math.max(r, b);
      const fade = 1 - Math.min(1, (greenness - 5) / 35);
      data[i + 3] = Math.round(data[i + 3] * fade);
    }
  }
  // 결과를 임시 경로에 쓰고 atomically rename — destPath 가 sharp 의 read 와 동일 파일이면
  // truncation race 위험.
  const tmpPath = filePath + ".chroma.tmp";
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: channels as 1 | 2 | 3 | 4 },
  })
    .png()
    .toFile(tmpPath);
  await fs.rename(tmpPath, filePath);
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
async function hasTransparentBackground(imagePath: string): Promise<boolean> {
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
    // `-i, --image <FILE>...` 는 multi-value 옵션이라 그 뒤의 positional 인자도
    // file 로 흡수해버린다. attached image 가 있으면 `--` 로 옵션 종료를 명시해서
    // prompt 가 PROMPT positional 로 들어가도록 한다.
    const args = [
      "exec",
      "--cd",
      workDir,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...attachedImages.flatMap(p => ["-i", p]),
      ...(attachedImages.length > 0 ? ["--"] : []),
      naturalPrompt,
    ];

    onProgress("starting", `codex exec (job ${job.id})`);

    const startedAt = performance.now();
    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
    });

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
          setTimeout(() => child.kill("SIGKILL"), KILL_DELAY_MS).unref();
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
          setTimeout(() => child.kill("SIGKILL"), KILL_DELAY_MS).unref();
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
      `# codex exec args:\n${JSON.stringify(args, null, 2)}\n\n# stdout:\n${stdoutBuf}\n\n# stderr:\n${stderrBuf}`,
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
      // fallback: 가장 최근의 .png 파일을 채택
      const entries = await fs.readdir(workDir);
      const pngs = entries.filter(e => e.toLowerCase().endsWith(".png"));
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

    // remove_bg 후처리: prompt 에서 #00ff00 chroma-key 위에 다시 그리도록 지시했으므로
    // 그 픽셀들을 투명화. anti-aliased fringe 까지 잡으려고 넉넉한 threshold 사용.
    if (job.kind === "remove_bg") {
      onProgress("recovering", "chroma key post-process");
      await chromaKeyGreen(destPath);
    }

    // inpaint 후처리: 원본이 투명 배경이면 Codex 가 결과를 #00ff00 위에 그려버리므로
    // (remove_bg 와 동일한 이유) 같은 chroma-key 로 배경을 다시 투명화한다.
    // 원본이 불투명이면 inpaint 결과도 불투명이라 키아웃하지 않는다.
    if (job.kind === "inpaint" && job.inputImagePaths?.[0]) {
      const parentHasAlpha = await hasTransparentBackground(job.inputImagePaths[0]);
      if (parentHasAlpha) {
        onProgress("recovering", "chroma key post-process (transparent parent)");
        await chromaKeyGreen(destPath);
      }
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
