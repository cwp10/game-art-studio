#!/usr/bin/env -S node --import tsx
/**
 * MCP stdio 서버 — Claude CLI 가 `--mcp-config data/mcp.json` 로 붙어 도구를 호출한다.
 *
 * 도구 (M4):
 *  - generate_image(prompt)              text→image (기본)
 *  - make_spritesheet(prompt, rows, cols) text→image, 그리드 스프라이트 시트
 *  - edit_image(prompt, inputGenerationId)         img2img 자유 편집
 *  - upscale_image(inputGenerationId)              codex 기반 해상도 업스케일 (자연어 "업스케일" fallback)
 *  - resize_image(inputGenerationId, targetSize)   sharp lanczos 결정적 리사이즈, 1초 이내 (드롭다운 버튼)
 *  - remove_background(inputGenerationId)          배경 제거 (chroma key → sharp 후처리)
 *  - inpaint_image(prompt, inputGenerationId, maskGenerationId?) 부분 편집 (마스크 옵션은 M4-UI)
 *
 * 모든 도구는 동일한 응답 모양:
 *   text: 'Generated image <id> (WxH, T.Ts). Show it with image ref id "<id>".'
 *   structuredContent: { generationId, imagePath, width, height, elapsedMs }
 *
 * 책임 경계:
 *  - 이 프로세스가 PNG 생성과 DB(generation/job) 행 작성의 owner.
 *  - Next 라우트는 generationId 만 받아 message.content 의 image_ref 블록에 박는다.
 *  - Next 와 별도 프로세스이지만 같은 SQLite 파일을 WAL 모드로 공유.
 *
 * 디버깅: stderr 는 Claude CLI 가 흡수하므로 우리는 `data/logs/mcp-server.log` 로 직접 append.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
// tsx 가 tsconfig paths 를 해석하지 않으므로 상대 경로 import.
// 이 파일은 stdio 진입점이라 별도 빌드 없이 `node --import tsx` 로 실행된다.
import { selectImageBackend, type ImageJob } from "../image-backend/index.js";
import { createGeneration, getGeneration } from "../db/repo/generations.js";
import { createJob, updateJob } from "../db/repo/jobs.js";
import { newGenerationId, newJobId } from "../util/ids.js";
import {
  DATA_DIR,
  IMAGES_DIR,
  LOGS_DIR,
  ensureDataDirs,
  imagePath as imagePathFor,
  jobDir as jobDirFor,
  toRelative,
} from "../util/paths.js";
import type { GenerationKind } from "../../types/db.js";

const RESIZE_TARGET_SIZES = [64, 128, 256, 512, 1024, 2048] as const;

ensureDataDirs();
const logPath = path.join(LOGS_DIR, "mcp-server.log");
function log(line: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

// ─── tool schemas ────────────────────────────────────────────────────────────

const PROMPT_PROP = {
  prompt: {
    type: "string",
    description: "이미지 생성·편집을 위한 자연어 프롬프트. 구체적이고 시각적이게.",
  },
} as const;

const SESSION_PROP = {
  sessionId: {
    type: "string",
    description:
      "(선택) image-generator 의 session id. 결과 generation 을 그 세션에 연결하기 위해 호출자가 전달.",
  },
} as const;

const INPUT_GEN_PROP = {
  inputGenerationId: {
    type: "string",
    description:
      "편집·업스케일·배경제거·인페인트의 입력 이미지 generation id. 이전 turn 또는 사용자 첨부 결과의 id.",
  },
} as const;

const SCHEMAS = {
  generate_image: {
    type: "object" as const,
    properties: { ...PROMPT_PROP, ...SESSION_PROP },
    required: ["prompt"],
  },
  make_spritesheet: {
    type: "object" as const,
    properties: {
      ...PROMPT_PROP,
      rows: { type: "integer", minimum: 1, maximum: 16, description: "세로 셀 개수" },
      cols: { type: "integer", minimum: 1, maximum: 16, description: "가로 셀 개수" },
      ...SESSION_PROP,
    },
    required: ["prompt", "rows", "cols"],
  },
  edit_image: {
    type: "object" as const,
    properties: { ...PROMPT_PROP, ...INPUT_GEN_PROP, ...SESSION_PROP },
    required: ["prompt", "inputGenerationId"],
  },
  upscale_image: {
    type: "object" as const,
    properties: { ...INPUT_GEN_PROP, ...SESSION_PROP },
    required: ["inputGenerationId"],
  },
  resize_image: {
    type: "object" as const,
    properties: {
      ...INPUT_GEN_PROP,
      targetSize: {
        type: "integer",
        enum: [...RESIZE_TARGET_SIZES],
        description:
          "결과 PNG 의 가로·세로 픽셀 (정사각). 원본보다 작으면 다운스케일, 크면 업스케일.",
      },
      ...SESSION_PROP,
    },
    required: ["inputGenerationId", "targetSize"],
  },
  remove_background: {
    type: "object" as const,
    properties: { ...INPUT_GEN_PROP, ...SESSION_PROP },
    required: ["inputGenerationId"],
  },
  inpaint_image: {
    type: "object" as const,
    properties: {
      ...PROMPT_PROP,
      ...INPUT_GEN_PROP,
      maskGenerationId: {
        type: "string",
        description:
          "(선택) 변경 영역을 빨갛게 칠한 마스크 PNG 의 generation id. 미제공 시 전역 편집과 동일.",
      },
      ...SESSION_PROP,
    },
    required: ["prompt", "inputGenerationId"],
  },
} as const;

const TOOLS = [
  {
    name: "generate_image",
    description:
      "text→image. 새 이미지를 만들 때 기본. 60–120초. " +
      "응답의 generationId 로 UI 가 /api/images/{id} 에 접근.",
    inputSchema: SCHEMAS.generate_image,
  },
  {
    name: "make_spritesheet",
    description:
      "그리드 형태의 스프라이트 시트를 단일 PNG 로 생성. " +
      "rows × cols 셀이 균일하게 배치, 투명 배경. " +
      '예: rows=4, cols=4 → 16 프레임 한 장.',
    inputSchema: SCHEMAS.make_spritesheet,
  },
  {
    name: "edit_image",
    description:
      "기존 이미지를 자연어로 편집. inputGenerationId 가 필수. " +
      '후속 메시지("더 어둡게", "검을 크게") 처리에 사용.',
    inputSchema: SCHEMAS.edit_image,
  },
  {
    name: "upscale_image",
    description:
      "기존 이미지를 codex 의 image-to-image 로 더 높은 해상도로 재생성 (~2배). " +
      "60–120초. 명시적 픽셀 크기(예: 512px) 가 지정된 경우엔 resize_image 를 우선.",
    inputSchema: SCHEMAS.upscale_image,
  },
  {
    name: "resize_image",
    description:
      "기존 이미지를 명시적 픽셀 해상도로 리사이즈 (정사각). sharp lanczos 보간법. " +
      "codex 호출 X, 1초 이내, 결정적. 사용자가 64/128/256/512/1024/2048 같은 숫자를 " +
      "직접 지정했거나 [리사이즈 N×N] 버튼을 누른 경우.",
    inputSchema: SCHEMAS.resize_image,
  },
  {
    name: "remove_background",
    description:
      "기존 이미지의 배경을 제거. Codex 가 #00ff00 chroma-key 위에 다시 그리고 " +
      "후처리로 그 색만 투명화. 깔끔한 단색 배경에서 가장 잘 동작.",
    inputSchema: SCHEMAS.remove_background,
  },
  {
    name: "inpaint_image",
    description:
      "이미지의 특정 영역만 편집. 전역 편집은 edit_image 가 권장. " +
      "maskGenerationId 가 있으면 그 영역만 다시 그림.",
    inputSchema: SCHEMAS.inpaint_image,
  },
];

// ─── server bootstrap ────────────────────────────────────────────────────────

const server = new Server(
  { name: "image-generator-mcp", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ─── handlers ────────────────────────────────────────────────────────────────

type CallArgs = {
  prompt?: string;
  inputGenerationId?: string;
  maskGenerationId?: string;
  rows?: number;
  cols?: number;
  targetSize?: number;
  sessionId?: string;
};

server.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as CallArgs;
  const sessionId = args.sessionId ?? null;

  try {
    switch (name) {
      case "generate_image":
        return await runImageTool({
          name,
          kind: "text2img",
          prompt: requireString(args.prompt, "prompt"),
          inputGenerationIds: [],
          sessionId,
        });

      case "make_spritesheet": {
        const rows = requireInt(args.rows, "rows");
        const cols = requireInt(args.cols, "cols");
        const userPrompt = requireString(args.prompt, "prompt");
        // cellHeight: 2048 기준 정사각형. rows=1(가로 배치)은 가로를 1.5배 넓혀 동작이 잘리지 않게.
        const cellH = rows === 1
          ? 768
          : Math.min(512, Math.floor(2048 / Math.max(rows, cols)));
        const cellW = rows === 1
          ? Math.min(Math.round(cellH * 2), Math.floor(6144 / cols))
          : cellH;
        const canvasW = cols * cellW;
        const canvasH = rows * cellH;
        const decorated =
          `${userPrompt}. ` +
          `Single PNG, exactly ${canvasW}×${canvasH} pixels, ` +
          `${rows}×${cols} animation sprite sheet grid, each cell exactly ${cellW}×${cellH} pixels. ` +
          `CRITICAL pivot rules: ` +
          `(1) character's hip/waist is ALWAYS anchored at the exact horizontal and vertical center of every cell — X=${Math.round(cellW / 2)}, Y=${Math.round(cellH / 2)} within each cell; ` +
          `(2) feet always on the same ground line across all frames; ` +
          `(3) same character scale and height in every frame — no shrinking or growing; ` +
          `(4) zero positional drift between frames — only limbs and body parts move, not the whole character; ` +
          `(5) each character fully contained within its cell with 5% margin on all sides. ` +
          `White background.`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcpResult = await runImageTool({
          name,
          kind: "spritesheet",
          prompt: decorated,
          inputGenerationIds: [],
          sessionId,
        }) as any;
        // 생성 후 정확한 배수 크기로 강제 리사이즈 — 셀 경계 보장.
        const genId: string | undefined = mcpResult?.structuredContent?.generationId;
        if (genId) {
          const filePath = imagePathFor(genId);
          const tmpPath = `${filePath}.tmp`;
          try {
            await sharp(filePath)
              .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
              .png()
              .toFile(tmpPath);
            fs.renameSync(tmpPath, filePath);
            log(`make_spritesheet resized gen=${genId} to ${canvasW}x${canvasH}`);
          } catch (e) {
            log(`make_spritesheet resize fail: ${(e as Error).message}`);
            try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
          }
        }
        return mcpResult;
      }

      case "edit_image":
        return await runImageTool({
          name,
          kind: "img2img",
          prompt: requireString(args.prompt, "prompt"),
          inputGenerationIds: [requireString(args.inputGenerationId, "inputGenerationId")],
          sessionId,
        });

      case "upscale_image":
        return await runImageTool({
          name,
          kind: "upscale",
          prompt: "Upscale to approximately 2x resolution preserving all detail.",
          inputGenerationIds: [requireString(args.inputGenerationId, "inputGenerationId")],
          sessionId,
        });

      case "resize_image": {
        const inputId = requireString(args.inputGenerationId, "inputGenerationId");
        const targetSize = requireInt(args.targetSize, "targetSize");
        if (!(RESIZE_TARGET_SIZES as readonly number[]).includes(targetSize)) {
          throw new Error(
            `targetSize must be one of ${RESIZE_TARGET_SIZES.join(", ")} (got ${targetSize})`,
          );
        }
        return await runResizeTool({ inputGenerationId: inputId, targetSize, sessionId });
      }

      case "remove_background":
        return await runImageTool({
          name,
          kind: "remove_bg",
          prompt: "Remove the background, keep the subject sharp and intact.",
          inputGenerationIds: [requireString(args.inputGenerationId, "inputGenerationId")],
          sessionId,
        });

      case "inpaint_image": {
        const inputId = requireString(args.inputGenerationId, "inputGenerationId");
        const prompt = requireString(args.prompt, "prompt");
        const ids = args.maskGenerationId ? [inputId, args.maskGenerationId] : [inputId];
        return await runImageTool({
          name,
          kind: "inpaint",
          prompt,
          inputGenerationIds: ids,
          sessionId,
        });
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    log(`tool ${name} FAIL: ${msg}`);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool ${name} failed: ${msg}` }],
    };
  }
});

// ─── shared executor ─────────────────────────────────────────────────────────

async function runImageTool(spec: {
  name: string;
  kind: GenerationKind;
  prompt: string;
  inputGenerationIds: string[];
  sessionId: string | null;
}) {
  const { name, kind, prompt, inputGenerationIds, sessionId } = spec;

  // inputGenerationId → 실제 PNG 경로로 해석
  const inputImagePaths: string[] = [];
  for (const gid of inputGenerationIds) {
    const g = getGeneration(gid);
    if (!g) throw new Error(`generation not found: ${gid}`);
    inputImagePaths.push(path.join(DATA_DIR, g.image_path));
  }

  const generationId = newGenerationId();
  const jobId = newJobId();

  log(
    `${name} start job=${jobId} gen=${generationId} kind=${kind} ` +
      `session=${sessionId} inputs=[${inputGenerationIds.join(",")}]`,
  );
  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "codex_image",
    args: { tool: name, prompt, kind, generationId, inputGenerationIds, viaMcp: true },
  });

  // progress.jsonl 채널 — Next 의 progress-tail 헬퍼가 polling 으로 읽는다.
  // 도구 시작 직전에 빈 파일을 만들어 두면 tail 이 stat 실패를 덜 겪는다.
  const progressPath = path.join(jobDirFor(jobId), "progress.jsonl");
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, "");
  function appendProgress(stage: string, detail?: string): void {
    const line = JSON.stringify({ ts: Date.now(), stage, detail }) + "\n";
    try {
      fs.appendFileSync(progressPath, line);
    } catch (e) {
      log(`  ${jobId} progress append fail: ${(e as Error).message}`);
    }
  }

  const backend = await selectImageBackend();
  const job: ImageJob = { id: jobId, generationId, kind, prompt, inputImagePaths };
  const result = await backend.execute(job, (stage, detail) => {
    log(`  ${jobId} stage=${stage}${detail ? " " + detail : ""}`);
    appendProgress(stage, detail);
  });

  const gen = createGeneration({
    id: generationId,
    session_id: sessionId,
    message_id: null, // Claude orchestration 경로에서는 message_id 사후 연결.
    kind,
    prompt,
    input_image_ids: inputGenerationIds,
    image_path: toRelative(result.imagePath),
    width: result.width,
    height: result.height,
    backend: "codex_exec",
  });
  updateJob(jobId, {
    status: "succeeded",
    result: { generationId: gen.id, elapsedMs: result.elapsedMs },
    ended_at: Date.now(),
  });

  log(`${name} done job=${jobId} gen=${gen.id} ${result.width}x${result.height} ${result.elapsedMs}ms`);

  return {
    content: [
      {
        type: "text",
        text:
          `Generated image ${gen.id} (${result.width}×${result.height}, ` +
          `${(result.elapsedMs / 1000).toFixed(1)}s). ` +
          `Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width: result.width,
      height: result.height,
      elapsedMs: result.elapsedMs,
    },
  };
}

/**
 * sharp lanczos 기반 결정적 리사이즈 — codex 호출 X. ImageBackend 우회.
 * 정사각 fit=fill. 알파 보존. backend='direct' 로 generation 행 작성.
 */
async function runResizeTool(spec: {
  inputGenerationId: string;
  targetSize: number;
  sessionId: string | null;
}) {
  const inputGen = getGeneration(spec.inputGenerationId);
  if (!inputGen) throw new Error(`generation not found: ${spec.inputGenerationId}`);
  const inputPath = path.join(DATA_DIR, inputGen.image_path);

  const generationId = newGenerationId();
  const jobId = newJobId();
  const destPath = imagePathFor(generationId);

  log(
    `resize_image start job=${jobId} gen=${generationId} ` +
      `input=${spec.inputGenerationId} target=${spec.targetSize} session=${spec.sessionId}`,
  );
  createJob({
    id: jobId,
    session_id: spec.sessionId,
    kind: "codex_image", // 스키마 CHECK 제약상 codex_image 그대로 (의미: image-producing job)
    args: {
      tool: "resize_image",
      inputGenerationId: spec.inputGenerationId,
      targetSize: spec.targetSize,
      generationId,
      viaMcp: true,
    },
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const startedAt = performance.now();
  await sharp(inputPath)
    .resize(spec.targetSize, spec.targetSize, { kernel: "lanczos3", fit: "fill" })
    .png()
    .toFile(destPath);
  const elapsedMs = Math.round(performance.now() - startedAt);

  // generations.kind CHECK 제약: text2img|img2img|upscale|remove_bg|inpaint|spritesheet.
  // resize 는 'upscale' 의미가 가장 가까워 그대로 재활용 (의미가 약간 늘어남: 원본보다 작아도
  // 같은 kind 로 분류 — kind enum 확장은 별도 마이그레이션 필요).
  const gen = createGeneration({
    id: generationId,
    session_id: spec.sessionId,
    message_id: null,
    kind: "upscale",
    prompt: `Resize to ${spec.targetSize}×${spec.targetSize}`,
    input_image_ids: [spec.inputGenerationId],
    image_path: toRelative(destPath),
    width: spec.targetSize,
    height: spec.targetSize,
    backend: "direct",
  });
  updateJob(jobId, {
    status: "succeeded",
    result: { generationId: gen.id, elapsedMs },
    ended_at: Date.now(),
  });

  log(`resize_image done job=${jobId} gen=${gen.id} ${spec.targetSize}x${spec.targetSize} ${elapsedMs}ms`);

  return {
    content: [
      {
        type: "text",
        text:
          `Resized image ${gen.id} (${spec.targetSize}×${spec.targetSize}, ${elapsedMs}ms). ` +
          `Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width: spec.targetSize,
      height: spec.targetSize,
      elapsedMs,
    },
  };
}

// ─── input helpers ───────────────────────────────────────────────────────────

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
}
function requireInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${name} must be an integer`);
  return v;
}

// 환경변수 / cwd 정상화. mcp.json 에서 cwd 가 지정되지 않아도 동작하도록.
if (process.env.IMAGEGEN_DATA_DIR == null && process.env.IMAGEGEN_MCP_CWD) {
  process.chdir(process.env.IMAGEGEN_MCP_CWD);
}

const transport = new StdioServerTransport();
server.connect(transport).then(
  () => log(`mcp server connected (data=${DATA_DIR})`),
  err => {
    log(`mcp server connect failed: ${(err as Error).message}`);
    process.exit(1);
  },
);

process.on("SIGTERM", () => {
  log("SIGTERM received, exiting");
  process.exit(0);
});
process.on("SIGINT", () => {
  log("SIGINT received, exiting");
  process.exit(0);
});
