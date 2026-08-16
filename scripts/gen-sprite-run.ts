/**
 * ④a — 플랜 구동 생성 CLI. 실제 codex 를 부른다.
 *
 *   pnpm gen:sprite-run --base=<generationId> --dir=DOWN --frames=4 --action="walk cycle"
 *
 * base 가 잠겨 있지 않으면 --base 로 준 generation 을 잠근다(①). 결과 파일과 경고를
 * 그대로 찍는다 — 조용한 성공/실패가 없어야 한다.
 *
 * 프롬프트는 params.rawPrompt 로 통과시킨다. row-prompt.ts 가 이미 완결된 사양이라
 * buildSpritesheetPrompt 의 틀로 다시 감싸면 계약이 둘이 된다.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { createGeneration, getGeneration, getLockedBase, lockBaseGeneration } from "@/lib/db/repo/generations";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { buildSpriteRequest } from "@/lib/sprite/build-request";
import { runSpritePlan, type GenerateFn } from "@/lib/sprite/run-plan";
import { newGenerationId, newJobId } from "@/lib/util/ids";
import { DATA_DIR, toRelative } from "@/lib/util/paths";

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback !== undefined) return fallback;
  console.error(`--${name}= 이 필요합니다`);
  process.exit(2);
}

/** generation 의 절대 파일 경로. image_path 는 DATA_DIR 상대다. */
function absPath(generationId: string): string {
  const gen = getGeneration(generationId);
  if (!gen) throw new Error(`generation ${generationId} 이(가) 없습니다`);
  return path.isAbsolute(gen.image_path) ? gen.image_path : path.join(DATA_DIR, gen.image_path);
}

void (async () => {
  const baseId = arg("base");
  const uiDirection = arg("dir", "DOWN");
  const frames = Number(arg("frames", "4"));
  const actionPrompt = arg("action");
  const characterId = arg("character", "run");
  const description = arg("description", "");

  // ① base 잠금 — 잠겨 있지 않으면 잠근다.
  if (getLockedBase(null)?.id !== baseId) {
    lockBaseGeneration(baseId, null);
    console.log(`base 잠금: ${baseId}`);
  }
  const basePath = absPath(baseId);
  console.log(`base 파일: ${basePath}`);

  const workDir = path.join(DATA_DIR, "sprite-runs", `${characterId}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  console.log(`작업 디렉터리: ${workDir}`);

  const { request, warnings } = await buildSpriteRequest({
    characterId,
    description,
    baseImagePath: basePath,
    uiDirection,
    frames,
    loop: true,
    actionPrompt,
  });
  for (const w of warnings) console.log(`  경고: ${w}`);
  console.log(
    `크로마 키: ${request.chromaKey.name} ${request.chromaKey.hex} (${request.chromaKey.selection})`,
  );
  console.log(`상태: ${Object.keys(request.states).join(", ")}`);

  const backend = await selectImageBackend();

  const generate: GenerateFn = async spec => {
    const t0 = Date.now();
    console.log(`\n생성 ${spec.state} (${spec.role}) refs=${spec.inputPaths.length}`);
    for (const p of spec.inputPaths) console.log(`    ref: ${path.basename(p)}`);

    const job: ImageJob = {
      id: newJobId(),
      generationId: newGenerationId(),
      kind: "spritesheet",
      prompt: spec.prompt,
      inputImagePaths: spec.inputPaths,
      params: { rawPrompt: true, state: spec.state, role: spec.role, planDriven: true },
    };
    createJob({
      id: job.id,
      session_id: null,
      kind: "codex_image",
      args: { state: spec.state, role: spec.role },
    });
    try {
      const result = await backend.execute(job, (stage, detail) => {
        console.log(`    ${stage}${detail ? ` — ${detail}` : ""}`);
      });
      const gen = createGeneration({
        id: job.generationId,
        session_id: null,
        message_id: null,
        kind: "spritesheet",
        prompt: spec.prompt,
        params: { state: spec.state, role: spec.role, planDriven: true },
        image_path: toRelative(result.imagePath),
        width: result.width,
        height: result.height,
        backend: "codex_exec",
      });
      updateJob(job.id, {
        status: "succeeded",
        result: { generationId: gen.id },
        ended_at: Date.now(),
      });
      console.log(
        `  → ${gen.id} ${result.width}x${result.height} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return {
        generationId: gen.id,
        imagePath: result.imagePath,
        width: result.width,
        height: result.height,
      };
    } catch (e) {
      updateJob(job.id, {
        status: "failed",
        error: (e as Error).message,
        ended_at: Date.now(),
      });
      throw e;
    }
  };

  const result = await runSpritePlan(request, {
    generate,
    workDir,
    lockedBasePath: basePath,
    log: m => console.log(`  ${m}`),
  });

  console.log("\n=== 결과 ===");
  for (const [state, row] of Object.entries(result.rows)) {
    console.log(`  ${state}: ${row.generationId} frames=${row.frameCount}`);
    console.log(`    ${row.imagePath}`);
  }
  for (const [dir, a] of Object.entries(result.anchors)) {
    console.log(`  앵커 ${dir}: ${a.state}#${a.index} (${a.source})`);
    console.log(`    ${a.path}`);
  }
  for (const m of result.skippedMirrors) console.log(`  미러 생략: ${m.direction} ← ${m.mirrorOf}`);
  if (result.warnings.length === 0) console.log("  경고 없음");
  for (const w of result.warnings) console.log(`  경고: ${w}`);
})();
