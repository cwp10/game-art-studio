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

function buildNaturalPrompt(job: ImageJob): string {
  switch (job.kind) {
    case "text2img":
      return PROMPT_HEADER + `Generate an image: ${job.prompt}`;
    case "img2img":
      return (
        PROMPT_HEADER +
        `Use the attached image as a reference. Generate a new image: ${job.prompt}`
      );
    case "inpaint":
      return (
        PROMPT_HEADER +
        `Edit the attached image: ${job.prompt}. Preserve everything outside the requested change.`
      );
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
    case "spritesheet":
      return (
        PROMPT_HEADER +
        `Generate a single PNG containing a sprite sheet of: ${job.prompt}. ` +
        `Uniform cell size, transparent background, evenly spaced grid.`
      );
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
    const args = [
      "exec",
      "--cd",
      workDir,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...attachedImages.flatMap(p => ["-i", p]),
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

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf += text;
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
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
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

    // 메타데이터
    const meta = await sharp(destPath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const elapsedMs = Math.round(performance.now() - startedAt);
    onProgress("done", `${width}×${height}, ${(elapsedMs / 1000).toFixed(1)}s`);

    return {
      imagePath: destPath,
      width,
      height,
      elapsedMs,
      rawStdoutTail: stdoutBuf.slice(-1000),
    };
  }
}
