#!/usr/bin/env -S node --import tsx
/**
 * MCP stdio 서버 — Claude CLI 가 `--mcp-config data/mcp.json` 로 붙어 도구를 호출한다.
 *
 * 도구 (M4):
 *  - generate_image(prompt)              text→image (기본)
 *  - make_spritesheet(prompt, rows, cols) text→image, 그리드 스프라이트 시트
 *  - edit_image(prompt, inputGenerationId)         img2img 자유 편집
 *  - upscale_image(inputGenerationId)              해상도 업스케일
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
// tsx 가 tsconfig paths 를 해석하지 않으므로 상대 경로 import.
// 이 파일은 stdio 진입점이라 별도 빌드 없이 `node --import tsx` 로 실행된다.
import { selectImageBackend, type ImageJob } from "../image-backend/index.js";
import { createGeneration, getGeneration } from "../db/repo/generations.js";
import { createJob, updateJob } from "../db/repo/jobs.js";
import { newGenerationId, newJobId } from "../util/ids.js";
import {
  DATA_DIR,
  LOGS_DIR,
  ensureDataDirs,
  jobDir as jobDirFor,
  toRelative,
} from "../util/paths.js";
import type { GenerationKind } from "../../types/db.js";

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
    description: "기존 이미지를 더 높은 해상도로 재생성 (~2배).",
    inputSchema: SCHEMAS.upscale_image,
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
  { name: "image-generator-mcp", version: "0.2.0" },
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
        // grid 구조를 prompt 에 명시적으로 박아줘서 codex 가 분할 가능한 그리드를 생성하게 한다.
        const decorated =
          `${userPrompt}. Single image containing a ${rows}x${cols} grid (${rows * cols} cells), ` +
          `uniform cell size, evenly spaced, transparent background.`;
        return await runImageTool({
          name,
          kind: "spritesheet",
          prompt: decorated,
          inputGenerationIds: [],
          sessionId,
        });
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
