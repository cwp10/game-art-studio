/**
 * 8프레임 달리기 사이클의 R-CONTACT 절반(프레임 5~8)만 별도 생성 테스트.
 *
 * 가설: row restart bias 없이 R-CONTACT부터 시작하는 4×1을 생성하면
 *       모델이 오른발 앞 포즈를 올바르게 그릴 수 있는가?
 *
 * 사용법: pnpm tsx scripts/test-r-half.ts [dirIndex=6]
 */
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { getCachedPoseRow, computeFrameAngles } from "@/lib/image-backend/pose-reference";
import { generateGridTemplate } from "@/lib/mcp/handlers/shared";
import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { newJobId, newGenerationId } from "@/lib/util/ids";
import { createJob, updateJob } from "@/lib/db/repo/jobs";
import { createGeneration } from "@/lib/db/repo/generations";
import { DATA_DIR } from "@/lib/util/paths";
import { toRelative } from "@/lib/util/paths";

const TEMPLATES_DIR = path.join(DATA_DIR, "templates");
const IMAGES_DIR = path.join(DATA_DIR, "images");

const DIR_LABELS: Record<number, string> = {
  0: "DOWN", 1: "DOWN-LEFT", 2: "LEFT", 3: "UP-LEFT",
  4: "UP", 5: "UP-RIGHT", 6: "RIGHT", 7: "DOWN-RIGHT",
};

function buildFrameNarrativeSimple(angles: ReturnType<typeof computeFrameAngles>): string {
  const descs = angles.map((a, i) => {
    const pos = `col${i + 1}`;
    const lA = a.leftDeg;
    const rA = a.rightDeg;
    const phase = Math.abs(lA) >= 15 ? "MAX STRIDE" : Math.abs(lA) <= 5 ? "CROSSOVER" : "mid-stride";
    const leadingLeg =
      a.label === "L-CONTACT" ? " — LEADING LEG: LEFT foot FORWARD / right foot BACK" :
      a.label === "R-CONTACT" ? " — LEADING LEG: RIGHT foot FORWARD / left foot BACK" : "";
    return `${pos}[${a.label}/${phase}]: L=${lA >= 0 ? "+" : ""}${lA}°(${lA > 5 ? "FWD" : lA < -5 ? "BACK" : "~0"}), R=${rA >= 0 ? "+" : ""}${rA}°(${rA > 5 ? "FWD" : rA < -5 ? "BACK" : "~0"})${leadingLeg}`;
  });
  return `MANDATORY FRAME SEQUENCE: ${descs.join("; ")}. `;
}

async function main() {
  const dirIndex = parseInt(process.argv[2] ?? "6", 10);
  const dirLabel = DIR_LABELS[dirIndex] ?? "RIGHT";
  const COLS = 4;
  const ROWS = 1;
  const CELL_PX = 384;

  console.log(`[test-r-half] dirIndex=${dirIndex} dir=${dirLabel} cols=${COLS}`);

  // 1. R-CONTACT 절반 포즈 가이드 생성 (startFrame=4, totalCycle=8)
  console.log("[test-r-half] R-half 포즈 가이드 생성...");
  const { path: poseGuidePath, angles } = await getCachedPoseRow(
    dirIndex, COLS, CELL_PX, TEMPLATES_DIR, true /* isRun */, 4 /* startFrame */, 8 /* totalCycle */
  );
  console.log(`[test-r-half] 포즈 가이드: ${poseGuidePath}`);
  console.log("[test-r-half] 각도:", angles.map(a => `${a.label}(L=${a.leftDeg},R=${a.rightDeg})`).join(", "));

  // 2. 그리드 템플릿 생성
  const gridPath = await generateGridTemplate(COLS, ROWS, CELL_PX, CELL_PX);
  console.log(`[test-r-half] 그리드 템플릿: ${gridPath}`);

  // 3. 프롬프트 빌드
  const frameNarrative = buildFrameNarrativeSimple(angles);
  const prompt =
    `pixel art bare-skinned male character in briefs/underwear, leaning body slightly forward, ` +
    `arms pumping vigorously, fast running sprint cycle, ` +
    `SINGLE DIRECTION ONLY — facing RIGHT (pure side view). Every frame must face RIGHT. ` +
    `Transparent background, pixel art, 16-bit style, sharp pixels. ` +
    `I am attaching TWO images: ` +
    `(1) BASE POSE REFERENCE — a stick-figure skeleton strip showing the SECOND HALF (frames 5-8) of an 8-frame run cycle. ` +
    `Frame 1 = R-CONTACT (RIGHT foot is at MAXIMUM FORWARD extension). ` +
    `Frame 4 = returning toward L-CONTACT. ` +
    `(2) GRID TEMPLATE — the OUTPUT CANVAS. Your output must match its exact 4×1 pixel dimensions. ` +
    `CRITICAL: This is the SECOND HALF of an 8-frame run cycle. ` +
    `The animation STARTS AT R-CONTACT — the RIGHT foot is forward in frame 1. ` +
    `The LEFT foot is forward in frame 1 is a CRITICAL ERROR. ` +
    `${frameNarrative}` +
    `POSE GUIDE (first attached image): Blue skeleton = LEFT leg. Red skeleton = RIGHT leg. ` +
    `col1 has the RED (right) leg at maximum FORWARD extension — match this exactly. ` +
    `col1 must show the right heel reaching AHEAD of the body center. ` +
    `FRAME CONSISTENCY: Torso, head, and body proportions identical across all 4 frames. ` +
    `Only limbs change. ` +
    `WALK CYCLE GAIT: 4 frames spanning the SECOND HALF only — R-CONTACT → mid-stride → CROSSOVER → mid-stride. ` +
    `CRITICAL background: SOLID FLAT pure green (#00ff00) chroma-key background. ` +
    `The gray guide lines are reference only — avoid rendering them in the output. ` +
    `Generate exactly one 4×1 sprite sheet. Each cell is ${CELL_PX}×${CELL_PX}px. Output = ${COLS * CELL_PX}×${ROWS * CELL_PX}px.`;

  // 4. codex 호출
  const jobId = newJobId();
  const generationId = newGenerationId();
  const kind = "spritesheet" as const;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  createJob({
    id: jobId,
    session_id: null,
    kind: "codex_image",
    args: { tool: "test-r-half", prompt, kind, generationId },
  });

  console.log(`[test-r-half] codex 시작 job=${jobId}...`);
  const backend = await selectImageBackend();
  const job: ImageJob = {
    id: jobId,
    generationId,
    kind,
    prompt,
    inputImagePaths: [poseGuidePath, gridPath],
  };

  try {
    const result = await backend.execute(job, (stage, detail) => {
      console.log(`[test-r-half]  ${stage}${detail ? " — " + detail : ""}`);
    });

    createGeneration({
      id: generationId,
      session_id: null,
      message_id: null,
      kind,
      prompt,
      input_image_ids: [],
      params: { testRHalf: true },
      image_path: toRelative(result.imagePath),
      width: result.width,
      height: result.height,
      backend: "codex_exec",
    });
    updateJob(jobId, { status: "succeeded", result: { generationId }, ended_at: Date.now() });

    console.log(`[test-r-half] ✅ 완료 → ${result.imagePath} (${result.width}×${result.height})`);

    // 포즈 가이드와 나란히 비교하기 위해 출력 경로 알려주기
    console.log(`[test-r-half] 포즈 가이드: ${poseGuidePath}`);
    console.log(`[test-r-half] 결과 이미지: ${result.imagePath}`);
  } catch (e) {
    const msg = (e as Error).message;
    updateJob(jobId, { status: "failed", error: msg, ended_at: Date.now() });
    console.error(`[test-r-half] ❌ ${msg}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
