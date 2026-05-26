/**
 * CLI 헬퍼: ImageBackend 단독 검증.
 *   pnpm tsx scripts/gen.ts "<prompt>" [--kind=text2img|spritesheet]
 *
 * Next.js 가 띄워져 있지 않아도 동작. M1 의 단독 검증 도구.
 */

import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { newJobId, newGenerationId } from "@/lib/util/ids";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { createGeneration } from "@/lib/db/repo/generations";
import { toRelative } from "@/lib/util/paths";

async function main() {
  const args = process.argv.slice(2);
  const prompt = args.find(a => !a.startsWith("--"));
  if (!prompt) {
    console.error('usage: pnpm tsx scripts/gen.ts "<prompt>" [--kind=text2img]');
    process.exit(2);
  }
  const kind = (args.find(a => a.startsWith("--kind="))?.split("=")[1] ??
    "text2img") as ImageJob["kind"];

  const job: ImageJob = {
    id: newJobId(),
    generationId: newGenerationId(),
    kind,
    prompt,
  };

  console.log(`[gen] job=${job.id} generation=${job.generationId} kind=${kind}`);
  console.log(`[gen] prompt: ${prompt}`);

  createJob({ id: job.id, session_id: null, kind: "codex_image", args: { prompt, kind } });
  const backend = await selectImageBackend();

  try {
    const result = await backend.execute(job, (stage, detail) => {
      console.log(`[gen]  ${stage}${detail ? ` — ${detail}` : ""}`);
    });

    const gen = createGeneration({
      id: job.generationId,
      session_id: null,
      message_id: null,
      kind,
      prompt,
      params: {},
      image_path: toRelative(result.imagePath),
      width: result.width,
      height: result.height,
      backend: "codex_exec",
    });

    updateJob(job.id, { status: "succeeded", result: { generationId: gen.id }, ended_at: Date.now() });
    console.log(`[gen] ✅ saved → ${result.imagePath} (${result.width}×${result.height}, ${(result.elapsedMs / 1000).toFixed(1)}s)`);
  } catch (e) {
    const msg = (e as Error).message;
    updateJob(job.id, { status: "failed", error: msg, ended_at: Date.now() });
    console.error(`[gen] ❌ ${msg}`);
    process.exit(1);
  }
}

main();
