#!/usr/bin/env -S node --import tsx
/**
 * MCP stdio 서버 — Claude CLI 가 `--mcp-config data/mcp.json` 로 붙어 도구를 호출한다.
 *
 * 도구 (M3 1차):
 *  - generate_image(prompt, kind?) → { generationId, imagePath, width, height, elapsedMs }
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
import { createGeneration } from "../db/repo/generations.js";
import { createJob, updateJob } from "../db/repo/jobs.js";
import { newGenerationId, newJobId } from "../util/ids.js";
import { DATA_DIR, LOGS_DIR, ensureDataDirs, toRelative } from "../util/paths.js";
import type { GenerationKind } from "../../types/db.js";

ensureDataDirs();
const logPath = path.join(LOGS_DIR, "mcp-server.log");
function log(line: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

const GENERATE_IMAGE_SCHEMA = {
  type: "object" as const,
  properties: {
    prompt: {
      type: "string",
      description:
        "이미지 생성을 위한 자연어 프롬프트. 가능한 한 구체적이고 시각적이게.",
    },
    kind: {
      type: "string",
      enum: ["text2img", "img2img", "upscale", "remove_bg", "inpaint", "spritesheet"],
      description: "기본 text2img. 첨부 이미지가 있으면 img2img/inpaint 등.",
    },
    sessionId: {
      type: "string",
      description:
        "(선택) image-generator 의 session id. DB 의 generation 행에 연결하기 위해 호출자가 전달.",
    },
  },
  required: ["prompt"],
} as const;

const server = new Server(
  { name: "image-generator-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "게임 에셋용 이미지를 생성한다. Codex 의 imagegen 스킬을 백엔드로 사용. " +
        "60–120초 소요. 한 호출당 PNG 1장. 응답에는 generationId 가 포함되며 " +
        "UI 는 그 id 로 /api/images/{id} 를 통해 이미지를 표시한다.",
      inputSchema: GENERATE_IMAGE_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: rawArgs } = req.params;
  if (name !== "generate_image") {
    throw new Error(`unknown tool: ${name}`);
  }
  const args = (rawArgs ?? {}) as {
    prompt?: string;
    kind?: GenerationKind;
    sessionId?: string;
  };
  if (!args.prompt || typeof args.prompt !== "string") {
    throw new Error("prompt is required");
  }
  const kind: GenerationKind = args.kind ?? "text2img";
  const sessionId = args.sessionId ?? null;

  const generationId = newGenerationId();
  const jobId = newJobId();

  log(`generate_image start job=${jobId} gen=${generationId} kind=${kind} session=${sessionId}`);
  createJob({
    id: jobId,
    session_id: sessionId,
    kind: "codex_image",
    args: { prompt: args.prompt, kind, generationId, viaMcp: true },
  });

  try {
    const backend = await selectImageBackend();
    const job: ImageJob = {
      id: jobId,
      generationId,
      kind,
      prompt: args.prompt,
    };
    // Codex 진행 단계는 M4 에서 채널화. 지금은 로그만.
    const result = await backend.execute(job, (stage, detail) => {
      log(`  ${jobId} stage=${stage}${detail ? " " + detail : ""}`);
    });

    const gen = createGeneration({
      id: generationId,
      session_id: sessionId,
      message_id: null, // Claude orchestration 경로에서는 message_id 사후 연결.
      kind,
      prompt: args.prompt,
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

    log(`generate_image done job=${jobId} gen=${gen.id} ${result.width}x${result.height} ${result.elapsedMs}ms`);

    // Claude 에게 돌려줄 응답. 추가 도구 호출 유도를 피하려고 텍스트 본문은 짧게.
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
      // 구조화된 결과도 함께 제공 (클라이언트가 사용할 수 있음)
      structuredContent: {
        generationId: gen.id,
        imagePath: `/api/images/${gen.id}`,
        width: result.width,
        height: result.height,
        elapsedMs: result.elapsedMs,
      },
    };
  } catch (err) {
    const msg = (err as Error).message;
    updateJob(jobId, { status: "failed", error: msg, ended_at: Date.now() });
    log(`generate_image FAIL job=${jobId} ${msg}`);
    return {
      isError: true,
      content: [{ type: "text", text: `Image generation failed: ${msg}` }],
    };
  }
});

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
