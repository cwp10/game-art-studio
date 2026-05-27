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
            `OBJECT REMOVAL TASK. I am attaching TWO images: ` +
            `(1) the original image, and (2) a mask where the RED region marks an ` +
            `unwanted object that must be ERASED.\n\n` +
            `Produce an output image where:\n` +
            `- The unwanted object (red-marked region in image 2) is COMPLETELY REMOVED ` +
            `from image 1.\n` +
            `- The empty space is filled ONLY with the simplest, flattest continuation ` +
            `of the immediately adjacent background pixels.\n` +
            `- ABSOLUTELY NO new objects, clouds, trees, grass tufts, flowers, rocks, ` +
            `animals, people, or any other features may appear in the previously-masked ` +
            `area — even if similar objects exist nearby.\n` +
            `- Example: if the masked area is in the sky and surrounding sky has clouds, ` +
            `the masked area must be filled with PLAIN BLUE SKY ONLY (no clouds).\n` +
            `- Example: if the masked area is on grass with nearby flowers, fill with ` +
            `UNIFORM PLAIN GRASS ONLY (no flowers).\n` +
            `- Everything OUTSIDE the red-marked region must be IDENTICAL to image 1.\n` +
            `- The result must look natural, as if the unwanted object never existed.\n` +
            `- Do not include the red color or the mask in the output.`
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
      //   inputCount >= 2 → [0] = 그리드 템플릿, [1] = 참조 캐릭터
      //   inputCount === 1 → [0] = 그리드 템플릿
      // Codex 는 image[0] 을 primary 로 인식 → 그리드를 먼저 넣어 캔버스 구조를 강제.
      const inputCount = job.inputImagePaths?.length ?? 0;
      const seamlessLoop = job.params?.seamlessLoop === true;

      // 루프 사이클 규칙 — seamlessLoop=true 일 때만 삽입.
      // "Frame N → Frame 1" 이 끊김 없이 이어지도록 AI 에게 명시적 설계 지침 전달.
      const loopRule = seamlessLoop
        ? `SEAMLESS LOOP (CRITICAL): Frame N must flow back into Frame 1 without any visible jump cut. ` +
          `Frame 1 = neutral/ready pose. Middle frames = peak of action. Frame N = recovery pose matching Frame 1. ` +
          `For walk/run: complete gait cycle — left-right footfall must return to exact Frame 1 foot position. `
        : "";

      if (inputCount >= 2) {
        // [0] 그리드 템플릿, [1] 참조 캐릭터
        return (
          PROMPT_HEADER +
          `I am attaching TWO images:\n` +
          `(1) GRID TEMPLATE — this is the OUTPUT CANVAS. ` +
          `It shows a blank ${job.prompt.match(/(\d+)[×x](\d+)/)?.[0] ?? "N×M"} grid with thin gray cell lines. ` +
          `Your output PNG must have EXACTLY the same pixel dimensions as this template, ` +
          `with one sequential animation frame drawn inside each cell.\n` +
          `(2) REFERENCE CHARACTER — reproduce this character's exact visual style, colors, outfit, ` +
          `and proportions in every frame. Only the pose/action changes between frames.\n\n` +
          `Task: ${job.prompt}\n\n` +
          `Rules: fill every cell of the grid (image 1) with exactly one sequential frame. ` +
          `Each frame contains the reference character (image 2) performing a different step of the animation. ` +
          `Each character must be fully contained within its own cell. ` +
          loopRule
        );
      }
      if (inputCount === 1) {
        // [0] 그리드 템플릿만
        return (
          PROMPT_HEADER +
          `The attached image is the OUTPUT CANVAS — a blank grid with thin gray cell lines. ` +
          `Your output PNG must have EXACTLY the same pixel dimensions as this template. ` +
          `Task: ${job.prompt}\n` +
          `Draw one sequential animation frame inside each cell of the grid. ` +
          `Each character must be fully contained within its own cell. ` +
          loopRule
        );
      }
      // 그리드 템플릿 없음 (fallback)
      return (
        PROMPT_HEADER +
        `Generate a single PNG containing a sprite sheet: ${job.prompt}. ` +
        `Uniform cell size, evenly spaced grid, one animation frame per cell. ` +
        loopRule
      );
    }
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
 * 단순 #00ff00 chroma key. remove_bg 도구가 codex 에게 그 색 위에 다시 그리게
 * 지시했으므로 여기서 그 색 픽셀만 알파 0 으로 친다. anti-aliased fringe 도 잡으려고
 * 넉넉한 threshold (R<80, G>180, B<80).
 */
async function chromaKeyGreen(filePath: string): Promise<void> {
  const img = sharp(filePath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < 80 && g > 180 && b < 80) {
      data[i + 3] = 0;
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
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });

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
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
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
    // 로그 저장용 버퍼는 최신 500KB 만 유지 (디버깅에 충분).
    const BUF_MAX = 500_000;

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
      resolve => child.once("exit", (code, sig) => resolve({ code, signal: sig })),
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
