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
      inputGenerationId: {
        type: "string",
        description:
          "(선택) 참조 이미지의 generation id. 캐릭터 스타일 참조 및 배경 색상 자동 상속에 사용. " +
          "사용자가 [reference: <id>] 를 첨부했을 때 이 값을 전달.",
      },
      seamlessLoop: {
        type: "boolean",
        description:
          "true 면 마지막 프레임이 첫 프레임으로 자연스럽게 이어지는 완전한 루프 사이클로 생성. " +
          "걷기/달리기 사이클, 아이들, 공격 모션 등 반복 재생이 필요한 경우 true.",
      },
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
  seamlessLoop?: boolean;
  sessionId?: string;
};

server.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as CallArgs;
  const sessionId = args.sessionId ?? null;

  try {
    switch (name) {
      case "generate_image": {
        // 사용자가 배경을 명시하지 않으면 기본 투명 배경.
        // 오케스트레이터가 빠뜨려도 서버 측에서 한 번 더 보장.
        const rawPrompt = requireString(args.prompt, "prompt");
        const prompt = ensureTransparentDefault(rawPrompt);
        return await runImageTool({
          name,
          kind: "text2img",
          prompt,
          inputGenerationIds: [],
          sessionId,
        });
      }

      case "make_spritesheet": {
        let rows = requireInt(args.rows, "rows");
        let cols = requireInt(args.cols, "cols");
        const userPrompt = requireString(args.prompt, "prompt");
        const seamlessLoop = args.seamlessLoop === true;
        const refId = typeof args.inputGenerationId === "string" && args.inputGenerationId
          ? args.inputGenerationId
          : null;

        // rows=1 이고 cols > 4 인 경우: 다행 그리드로 자동 변환.
        // (시스템 프롬프트가 잘못 지시하거나 사용자가 명시해도 방어)
        if (rows === 1 && cols > 4) {
          const n = cols;
          rows = Math.round(Math.sqrt(n));
          cols = Math.ceil(n / rows);
          log(`make_spritesheet auto-reshape: 1×${n} → ${rows}×${cols}`);
        }

        // cellHeight: 2048 기준 정사각형. rows=1(4프레임 이하 가로 배치)은 가로를 1.5배 넓혀 동작이 잘리지 않게.
        const cellH = rows === 1
          ? 768
          : Math.min(512, Math.floor(2048 / Math.max(rows, cols)));
        const cellW = rows === 1
          ? Math.min(Math.round(cellH * 2), Math.floor(6144 / cols))
          : cellH;
        const canvasW = cols * cellW;
        const canvasH = rows * cellH;

        // 그리드 템플릿 PNG 생성 (흰 배경 + 회색 선) — Codex 에게 레이아웃 시각적으로 전달
        const gridTemplatePath = await generateGridTemplate(cols, rows, cellW, cellH);

        // ── 배경 결정 우선순위 ──────────────────────────────────────────────
        // 1. 사용자가 프롬프트에 명시("transparent", "투명", "white background", "흰 배경") → 그대로
        // 2. 참조 이미지가 투명 배경 → 상속
        // 3. 기본 → 흰 배경
        // ── 배경 결정 우선순위 ──────────────────────────────────────────────
        // 1. 사용자가 프롬프트에 명시("white background", "흰 배경" 등) → 흰 배경
        // 2. 사용자가 "transparent/투명" 명시 → 투명
        // 3. 참조 이미지가 있으면 그 배경 상속
        // 4. 기본 → 투명 (게임 에셋 기본값)
        const hasExplicitBgKeyword = /transparent|투명|white\s*bg|흰\s*배경|white\s*background/.test(
          userPrompt.toLowerCase(),
        );
        let wantsTransparent = true; // 기본값: 투명
        if (/white\s*bg|흰\s*배경|white\s*background/.test(userPrompt.toLowerCase())) {
          wantsTransparent = false;
        } else if (/transparent|투명/.test(userPrompt.toLowerCase())) {
          wantsTransparent = true;
        } else if (!hasExplicitBgKeyword && refId) {
          const refGen = getGeneration(refId);
          if (refGen) {
            const refPath = path.join(DATA_DIR, refGen.image_path);
            wantsTransparent = await detectTransparentBg(refPath);
            log(
              `make_spritesheet: ref=${refId} transparent=${wantsTransparent} (inherited from reference bg)`,
            );
          }
        }

        // 투명 배경은 chroma-key 방식: 모델에게 #00ff00 위에 그리게 하고 후처리로 keying.
        // 모델이 직접 알파를 그리면 흰색 fringe / 회색 잔재가 남음.
        const bgInstruction = wantsTransparent
          ? "CRITICAL background: Use a SOLID FLAT pure green (#00ff00) chroma-key background filling every pixel that is NOT the character — no gradients, no shadows, no anti-aliasing fringe, crisp character silhouette. The post-processing pipeline will key out the green to produce true transparency."
          : "White background.";

        const loopInstruction = seamlessLoop
          ? `INFINITE LOOP DESIGN (CRITICAL): These frames will play as [1→2→…→N→1→2→…] on repeat forever. ` +
            `Frame N is the frame that plays IMMEDIATELY BEFORE Frame 1 — they are adjacent in the cycle. ` +
            `Design a CLOSED CYCLE with no beginning and no end: ` +
            `• Walk/run: cover exactly one complete gait period. ` +
            `  Example 8-frame walk: (1) left-heel-strike (2) left-mid-stance (3) right-toe-off (4) right-swing (5) right-heel-strike (6) right-mid-stance (7) left-toe-off (8) left-swing → loops back to (1). ` +
            `  The foot contact pattern in Frame N must be the natural predecessor of Frame 1's foot contact. ` +
            `• Idle/breathing: Frame N is a subtle mid-motion pose that flows directly into Frame 1's starting pose. ` +
            `• Attack/action: Frame N is the very last moment of recovery — the character is already returning to ready stance, so Frame 1's ready pose follows naturally. ` +
            `NEVER design a linear arc (wind-up → peak → stop). ALWAYS design a cycle (no visible start/end point). `
          : "";

        const decorated =
          `${userPrompt}. ` +
          `The attached image is a GRID TEMPLATE — a blank canvas with thin gray lines marking the exact ${cols}×${rows} cell layout (${canvasW}×${canvasH} pixels, each cell ${cellW}×${cellH} pixels). ` +
          `Generate a sprite sheet with EXACTLY the same dimensions as the template. ` +
          `Place exactly one animation frame per cell, filling every cell. ` +
          `CRITICAL framing rules (apply to EVERY cell): ` +
          `(1) The ENTIRE frame content — the character AND all spell effects, magic, auras, particles, projectiles, weapons, and flowing capes/robes — must be FULLY contained within its own cell. NOT A SINGLE PIXEL may cross into a neighboring cell. ` +
          `(2) Keep a clear EMPTY margin of at least ${Math.round(Math.min(cellW, cellH) * 0.12)}px on all four sides of each cell — fit everything inside the central safe zone, never touching the cell edges. ` +
          `(3) If a spell or effect would be large, SCALE IT DOWN so it stays inside the cell — never let an effect sprawl across cell boundaries. An effect belongs to the SAME cell as the character casting it. ` +
          `(4) character's hip/waist is centered at X=${Math.round(cellW / 2)}, Y=${Math.round(cellH / 2)} within each cell; ` +
          `(5) feet always on the same ground line across all frames; ` +
          `(6) same character scale and height in every frame — no shrinking or growing; ` +
          `(7) zero positional drift between frames — only limbs and body parts move, not the whole character. ` +
          loopInstruction +
          `Do NOT include the gray guide lines in the output — they are reference only. ` +
          bgInstruction;
        // 이미지 순서: 그리드 템플릿(index 0) → 참조 캐릭터(index 1, 있을 때만).
        // Codex 는 image[0] 을 primary 로 인식하므로 그리드를 먼저 넣어
        // "이 캔버스의 각 셀을 채워라" 의도를 강하게 전달.
        // 참조 캐릭터가 있을 때 image[1] 로 넣어 스타일 힌트를 준다.
        const refGen = refId ? getGeneration(refId) : null;
        const refPath = refGen ? path.join(DATA_DIR, refGen.image_path) : null;
        const overrideInputPaths = refPath
          ? [gridTemplatePath, refPath]   // [grid, ref]
          : [gridTemplatePath];            // [grid only]

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcpResult = await runImageTool({
          name,
          kind: "spritesheet",
          prompt: decorated,
          inputGenerationIds: refId ? [refId] : [],  // DB input_image_ids 추적용
          overrideInputPaths,                         // Codex 실제 입력 순서 제어
          params: { seamlessLoop },
          sessionId,
        }) as any;
        // ── 후처리 파이프라인 ──────────────────────────────────────────────
        // 1) 정확한 배수 크기로 강제 리사이즈 (셀 경계 픽셀-단위 정렬)
        // 2) wantsTransparent: #00ff00 chroma-key → alpha 0 변환
        const genId: string | undefined = mcpResult?.structuredContent?.generationId;
        if (genId) {
          const filePath = imagePathFor(genId);
          try {
            const resizeTmp = `${filePath}.resize.tmp`;
            await sharp(filePath)
              .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
              .png()
              .toFile(resizeTmp);
            fs.renameSync(resizeTmp, filePath);
            log(`make_spritesheet resized gen=${genId} to ${canvasW}x${canvasH}`);

            if (wantsTransparent) {
              await chromaKeyGreenFile(filePath);
              log(`make_spritesheet chroma-keyed gen=${genId}`);
            }
            // 셀 정규화: 연결 컴포넌트를 픽셀이 가장 많은 셀에 재배치 + 발 라인/가로
            // 중심 정렬. 격자 경계를 넘어 그려진 캐릭터의 이탈·잔재를 후처리로 흡수한다.
            await normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent);
            log(`make_spritesheet normalized gen=${genId} (${rows}x${cols})`);
          } catch (e) {
            log(`make_spritesheet post-process fail: ${(e as Error).message}`);
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

      case "remove_background": {
        const inputId = requireString(args.inputGenerationId, "inputGenerationId");
        const inputGen = getGeneration(inputId);
        // 스프라이트 시트는 배경이 항상 흰색 → Codex 없이 sharp 로 직접 흰 픽셀 투명화.
        // Codex 방식(chroma-key)은 전체 시트를 보고 첫 프레임만 재생성하는 문제가 있다.
        if (inputGen?.kind === "spritesheet") {
          return await runWhiteBgRemoveTool({ inputGenerationId: inputId, sessionId });
        }
        return await runImageTool({
          name,
          kind: "remove_bg",
          prompt: "Remove the background, keep the subject sharp and intact.",
          inputGenerationIds: [inputId],
          sessionId,
        });
      }

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

/**
 * generate_image 서버 측 배경 기본값 보정.
 *
 * 사용자(또는 오케스트레이터)가 프롬프트에 배경 관련 키워드를 전혀 넣지 않은
 * 경우에만 "transparent background" 를 끝에 부착. 사용자가 흰 배경이든 숲
 * 배경이든 직접 지정했다면 그 의도를 절대 덮어쓰지 않는다.
 *
 * 감지 키워드:
 *   - "배경" (예: "흰 배경", "숲 배경", "투명 배경") — 한국어 배경 언급
 *   - "background" — 영문 배경 언급
 *   - "transparent", "투명" — 투명 명시 (배경 단어 없이도 의도 명확)
 */
function ensureTransparentDefault(prompt: string): string {
  if (/배경|background|transparent|투명/i.test(prompt)) return prompt;
  return prompt.replace(/[.,]?\s*$/, "") + ", transparent background";
}

/**
 * 이미지가 투명 배경을 가졌는지 빠르게 감지.
 *
 * 알파 채널이 없으면 즉시 false. 있으면 네 꼭짓점 픽셀 샘플링으로 판단.
 * 게임 캐릭터 에셋은 보통 꼭짓점이 배경이므로 충분히 정확하다.
 */
async function detectTransparentBg(imagePath: string): Promise<boolean> {
  const meta = await sharp(imagePath).metadata();
  if (!meta.hasAlpha) return false;
  const w = meta.width ?? 2;
  const h = meta.height ?? 2;
  const corners = [
    { left: 0, top: 0 },
    { left: Math.max(0, w - 1), top: 0 },
    { left: 0, top: Math.max(0, h - 1) },
    { left: Math.max(0, w - 1), top: Math.max(0, h - 1) },
  ];
  for (const { left, top } of corners) {
    const px = await sharp(imagePath)
      .extract({ left, top, width: 1, height: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    if (px[3] < 10) return true; // 꼭짓점 픽셀이 투명 → 투명 배경
  }
  return false;
}

/**
 * 스프라이트 시트 레퍼런스용 그리드 PNG.
 *   - 외곽 셀 경계: 회색 1px (#cccccc) — 모델에게 셀 레이아웃만 시각적으로 전달.
 * 내부 safe-zone 박스는 v2 까지 그려넣었지만 모델이 그대로 출력에 복사하는
 * 부작용 → v3 부터는 그리지 않고 후처리(normalizeSpritesheetCells)로 패딩 강제.
 * data/templates/sprite-grid-v3-{cols}x{rows}x{cellW}x{cellH}.png 에 캐싱.
 */
async function generateGridTemplate(
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
): Promise<string> {
  const w = cols * cellW;
  const h = rows * cellH;
  const templatesDir = path.join(DATA_DIR, "templates");
  const cachePath = path.join(
    templatesDir,
    `sprite-grid-v3-${cols}x${rows}x${cellW}x${cellH}.png`,
  );
  if (fs.existsSync(cachePath)) return cachePath;

  // RGB 흰 배경
  const pixels = Buffer.alloc(w * h * 3, 255);
  const gray = 204; // #cccccc — 외곽 셀 경계

  // 외곽 셀 경계 (1px)
  for (let col = 0; col <= cols; col++) {
    const px = Math.min(col * cellW, w - 1);
    for (let y = 0; y < h; y++) {
      const i = (y * w + px) * 3;
      pixels[i] = gray; pixels[i + 1] = gray; pixels[i + 2] = gray;
    }
  }
  for (let row = 0; row <= rows; row++) {
    const py = Math.min(row * cellH, h - 1);
    for (let x = 0; x < w; x++) {
      const i = (py * w + x) * 3;
      pixels[i] = gray; pixels[i + 1] = gray; pixels[i + 2] = gray;
    }
  }

  fs.mkdirSync(templatesDir, { recursive: true });
  await sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(cachePath);
  log(`generateGridTemplate v3: ${cols}x${rows} cell=${cellW}x${cellH} saved → ${cachePath}`);
  return cachePath;
}

/**
 * #00ff00 chroma-key 처리 (in-place). greenness(= g - max(r,b)) 기반 feather:
 *   - greenness 강함 → alpha 0 (완전 키)
 *   - greenness 약함(anti-alias fringe) → 그린 채널 탈채도 + greenness 비례 알파 감쇠
 * 색만 빼고 불투명하게 두면 어두운 헤일로 링이 남으므로 fringe 의 알파를 함께 깎는다.
 *
 * NOTE: src/lib/image-backend/codex-exec.ts 의 chromaKeyGreen 과 동일 알고리즘. 둘 중
 *       하나를 고치면 반드시 다른 쪽도 동기화할 것 (픽셀 루프 한정, fs 처리는 각자 다름).
 */
async function chromaKeyGreenFile(filePath: string): Promise<void> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
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
  const tmpPath = filePath + ".chroma.tmp";
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch as 1 | 2 | 3 | 4 },
  })
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
}

/**
 * 스프라이트 시트 후처리 (글로벌 connected components 기반):
 *   1. 시트 전체에 대해 4-connectivity flood fill → 컴포넌트 라벨링
 *   2. 각 컴포넌트를 "가장 많은 픽셀이 있는 셀" 에 통째로 할당
 *      → 캐릭터가 셀 경계를 넘어 그려져도 발끝/날개 등이 잘리지 않음
 *   3. 셀별로: 메인 컴포넌트(가장 큰 것) 식별 + 메인 bbox + 5% margin 안의
 *      보존 대상 작은 컴포넌트 결정. 메인의 10% 미만이면서 bbox 밖이면 제거.
 *   4. 보존 컴포넌트의 union bbox 영역을 글로벌 좌표로 추출
 *   5. 가로: 메인 컴포넌트의 무게중심 x 를 셀 가로 중심에 정렬
 *      세로: 메인 컴포넌트 y 의 95th percentile 을 발 라인으로 추정, 셀 하단 정렬
 *      (시트 경계 안에 클램프 — 셀 경계 침범은 의도적으로 허용)
 */
async function normalizeSpritesheetCells(
  filePath: string,
  rows: number,
  cols: number,
  wantsTransparent: boolean,
): Promise<void> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const N = W * H;
  const paddingBottom = Math.round(cellH * 0.03);
  const margin = Math.round(Math.min(cellW, cellH) * 0.05);

  const isContent = (i: number) => {
    if (wantsTransparent) return data[i + 3] > 10;
    return !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
  };

  // 1. 시트 전체 마스크
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (isContent(i * ch)) mask[i] = 1;
  }

  // 2. 글로벌 4-connectivity 라벨링
  const labels = new Int32Array(N);
  const sizes: number[] = [0];
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    labels[start] = next;
    let size = 0;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0 && mask[p - 1] === 1 && labels[p - 1] === 0) {
        labels[p - 1] = next;
        stack.push(p - 1);
      }
      if (x < W - 1 && mask[p + 1] === 1 && labels[p + 1] === 0) {
        labels[p + 1] = next;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - W] === 1 && labels[p - W] === 0) {
        labels[p - W] = next;
        stack.push(p - W);
      }
      if (y < H - 1 && mask[p + W] === 1 && labels[p + W] === 0) {
        labels[p + W] = next;
        stack.push(p + W);
      }
    }
    sizes.push(size);
    next++;
  }
  if (sizes.length <= 1) {
    log(`normalizeSpritesheetCells: empty sheet, skipping`);
    return;
  }

  // 3. 컴포넌트별 픽셀 인덱스 + bbox + 셀별 픽셀 카운트
  const compPixels: number[][] = Array.from({ length: sizes.length }, () => []);
  const compCellCount: Map<number, number>[] = Array.from({ length: sizes.length }, () => new Map());
  const compMinX = new Int32Array(sizes.length).fill(W);
  const compMinY = new Int32Array(sizes.length).fill(H);
  const compMaxX = new Int32Array(sizes.length).fill(-1);
  const compMaxY = new Int32Array(sizes.length).fill(-1);
  for (let i = 0; i < N; i++) {
    const l = labels[i];
    if (l === 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    compPixels[l].push(i);
    if (x < compMinX[l]) compMinX[l] = x;
    if (y < compMinY[l]) compMinY[l] = y;
    if (x > compMaxX[l]) compMaxX[l] = x;
    if (y > compMaxY[l]) compMaxY[l] = y;
    const ci = Math.floor(y / cellH) * cols + Math.floor(x / cellW);
    compCellCount[l].set(ci, (compCellCount[l].get(ci) ?? 0) + 1);
  }

  // 4. 각 컴포넌트 → 가장 많은 픽셀이 있는 셀에 할당
  const labelsPerCell = new Map<number, number[]>();
  for (let l = 1; l < sizes.length; l++) {
    let maxCount = 0;
    let assigned = 0;
    for (const [ci, count] of compCellCount[l]) {
      if (count > maxCount) {
        maxCount = count;
        assigned = ci;
      }
    }
    if (!labelsPerCell.has(assigned)) labelsPerCell.set(assigned, []);
    labelsPerCell.get(assigned)!.push(l);
  }

  type Layer = { input: Buffer; top: number; left: number };
  const layers: Layer[] = [];

  // 5. 셀별 처리
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellIdx = r * cols + c;
      const cellX0 = c * cellW;
      const cellY0 = r * cellH;
      const assigned = labelsPerCell.get(cellIdx);
      if (!assigned || assigned.length === 0) continue;

      // 메인 = 가장 큰 컴포넌트
      let mainLabel = assigned[0];
      let maxSize = sizes[mainLabel];
      for (const l of assigned) {
        if (sizes[l] > maxSize) {
          maxSize = sizes[l];
          mainLabel = l;
        }
      }

      // 메인 bbox + 5% margin (글로벌 좌표)
      const exMinX = compMinX[mainLabel] - margin;
      const exMinY = compMinY[mainLabel] - margin;
      const exMaxX = compMaxX[mainLabel] + margin;
      const exMaxY = compMaxY[mainLabel] + margin;

      // 보존할 컴포넌트: 메인 + (큰 컴포넌트 OR 메인 bbox 안의 centroid)
      const minKeep = Math.max(4, Math.floor(maxSize * 0.1));
      const keep: number[] = [mainLabel];
      for (const l of assigned) {
        if (l === mainLabel) continue;
        if (sizes[l] >= minKeep) {
          keep.push(l);
          continue;
        }
        let sx = 0, sy = 0;
        for (const idx of compPixels[l]) {
          sx += idx % W;
          sy += Math.floor(idx / W);
        }
        const cx = sx / compPixels[l].length;
        const cy = sy / compPixels[l].length;
        if (cx >= exMinX && cx <= exMaxX && cy >= exMinY && cy <= exMaxY) {
          keep.push(l);
        }
      }

      // 보존 컴포넌트의 union bbox (글로벌)
      let bMinX = W, bMinY = H, bMaxX = -1, bMaxY = -1;
      for (const l of keep) {
        if (compMinX[l] < bMinX) bMinX = compMinX[l];
        if (compMinY[l] < bMinY) bMinY = compMinY[l];
        if (compMaxX[l] > bMaxX) bMaxX = compMaxX[l];
        if (compMaxY[l] > bMaxY) bMaxY = compMaxY[l];
      }
      if (bMaxX < 0) continue;

      const keepSet = new Set(keep);
      const bbW = bMaxX - bMinX + 1;
      const bbH = bMaxY - bMinY + 1;
      const bbBuf = Buffer.alloc(bbW * bbH * 4);
      for (let y = 0; y < bbH; y++) {
        for (let x = 0; x < bbW; x++) {
          const gx = bMinX + x;
          const gy = bMinY + y;
          const li = gy * W + gx;
          const di = (y * bbW + x) * 4;
          if (mask[li] === 0 || !keepSet.has(labels[li])) {
            bbBuf[di + 3] = 0;
            continue;
          }
          const gi = li * ch;
          bbBuf[di] = data[gi];
          bbBuf[di + 1] = data[gi + 1];
          bbBuf[di + 2] = data[gi + 2];
          bbBuf[di + 3] = ch === 4 ? data[gi + 3] : 255;
        }
      }

      const layerPng = await sharp(bbBuf, { raw: { width: bbW, height: bbH, channels: 4 } })
        .png()
        .toBuffer();

      // Shape-aware 본체 추출 — 메인 컴포넌트의 y행별 픽셀 수 분포 분석.
      // 캐릭터 본체(어깨~다리)는 일정한 두께로 연속, 이펙트(불꽃 호/검기/폭발)는
      // 행별 픽셀 수가 적음. row count 가 max 의 일정 비율 이상인 행만 "본체" 로
      // 간주해 발 라인/가로 중심을 계산. → 이펙트 길이/방향 영향에서 자유로움.
      const rowCounts = new Int32Array(H);
      const rowSumX = new Float64Array(H);
      for (const idx of compPixels[mainLabel]) {
        const px = idx % W;
        const py = Math.floor(idx / W);
        rowCounts[py]++;
        rowSumX[py] += px;
      }
      let rowMax = 0;
      for (let y = 0; y < H; y++) {
        if (rowCounts[y] > rowMax) rowMax = rowCounts[y];
      }
      const bodyThreshold = Math.max(2, Math.floor(rowMax * 0.25));

      // 본체 영역의 가장 아래 y = 발 라인 / 본체 픽셀의 가로 무게중심
      let footY = compMaxY[mainLabel];
      let bodySumX = 0;
      let bodyCount = 0;
      for (let y = compMaxY[mainLabel]; y >= compMinY[mainLabel]; y--) {
        if (rowCounts[y] >= bodyThreshold) {
          if (bodyCount === 0) footY = y; // 가장 처음 발견한 본체 행 = 가장 아래
          bodySumX += rowSumX[y];
          bodyCount += rowCounts[y];
        }
      }
      // 본체 검출 실패(전체가 얇은 이펙트) 시 메인 픽셀 전체로 폴백
      const mainCenterX = bodyCount > 0
        ? bodySumX / bodyCount
        : compPixels[mainLabel].reduce((s, idx) => s + (idx % W), 0) / compPixels[mainLabel].length;

      // 가로: 본체 무게중심 x 를 셀 가로 중심에
      const layerCenterX = mainCenterX - bMinX;
      const desiredLeft = Math.round(cellX0 + cellW / 2 - layerCenterX);

      // 세로: 본체 발 라인을 셀 하단 paddingBottom 위에
      const targetFootY = cellY0 + cellH - paddingBottom - 1;
      const layerFootY = footY - bMinY;
      const desiredTop = Math.round(targetFootY - layerFootY);

      // 시트 경계 안으로 클램프 (셀 경계 침범은 허용 — 크게 그려진 캐릭터/이펙트 보존)
      const left = Math.max(0, Math.min(W - bbW, desiredLeft));
      const top = Math.max(0, Math.min(H - bbH, desiredTop));
      layers.push({ input: layerPng, top, left });
    }
  }

  // 빈 캔버스 위에 모두 합성 (배경: 투명 또는 흰)
  const bg = wantsTransparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : { r: 255, g: 255, b: 255, alpha: 1 };
  const tmpPath = filePath + ".norm.tmp";
  await sharp({
    create: { width: W, height: H, channels: 4, background: bg },
  })
    .composite(layers)
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
  log(`normalizeSpritesheetCells: ${cols}x${rows} cells normalized, ${layers.length} non-empty`);
}

async function runImageTool(spec: {
  name: string;
  kind: GenerationKind;
  prompt: string;
  inputGenerationIds: string[];
  extraInputPaths?: string[];
  /** Codex 에 실제로 전달할 이미지 경로 순서를 완전히 override.
   *  설정하면 inputGenerationIds + extraInputPaths 자동 조합을 무시. */
  overrideInputPaths?: string[];
  params?: Record<string, unknown>;
  sessionId: string | null;
}) {
  const { name, kind, prompt, inputGenerationIds, extraInputPaths, overrideInputPaths, params, sessionId } = spec;

  // overrideInputPaths 가 있으면 그대로 사용 — 호출자가 순서를 직접 제어.
  // 없으면 inputGenerationIds → 경로 변환 후 extraInputPaths 를 뒤에 추가.
  let inputImagePaths: string[];
  if (overrideInputPaths) {
    inputImagePaths = overrideInputPaths;
  } else {
    inputImagePaths = [];
    for (const gid of inputGenerationIds) {
      const g = getGeneration(gid);
      if (!g) throw new Error(`generation not found: ${gid}`);
      inputImagePaths.push(path.join(DATA_DIR, g.image_path));
    }
    if (extraInputPaths?.length) {
      inputImagePaths.push(...extraInputPaths);
    }
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
  const job: ImageJob = { id: jobId, generationId, kind, prompt, inputImagePaths, params };
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

/**
 * 스프라이트 시트 전용 배경 제거 — Codex 호출 없이 sharp 로 흰 픽셀을 직접 투명화.
 *
 * Codex chroma-key 방식은 "피사체 하나를 #00ff00 위에 재생성" 지시를 사용하므로
 * 스프라이트 시트 전체 대신 첫 프레임만 처리하는 문제가 있다.
 * 스프라이트 시트의 배경은 항상 흰색(또는 격자선 회색)이므로
 * 픽셀 값이 R>240 && G>240 && B>240 이면 alpha=0 으로 치환한다.
 */
async function runWhiteBgRemoveTool(spec: {
  inputGenerationId: string;
  sessionId: string | null;
}) {
  const inputGen = getGeneration(spec.inputGenerationId);
  if (!inputGen) throw new Error(`generation not found: ${spec.inputGenerationId}`);

  const inputPath = path.join(DATA_DIR, inputGen.image_path);
  const generationId = newGenerationId();
  const jobId = newJobId();
  const destPath = imagePathFor(generationId);

  log(
    `remove_background(white-sharp) start job=${jobId} gen=${generationId} ` +
      `input=${spec.inputGenerationId} session=${spec.sessionId}`,
  );
  createJob({
    id: jobId,
    session_id: spec.sessionId,
    kind: "codex_image",
    args: {
      tool: "remove_background",
      inputGenerationId: spec.inputGenerationId,
      generationId,
      viaMcp: true,
    },
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const startedAt = performance.now();

  // 흰색·연회색 픽셀(R>240 && G>240 && B>240)을 alpha=0 으로 투명화.
  // 스프라이트 격자선(~#cccccc, 204)도 이 범위를 벗어나므로 같이 제거된다.
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 4 (RGBA)
  for (let i = 0; i < data.length; i += ch) {
    if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) {
      data[i + 3] = 0;
    }
  }
  const tmpPath = `${destPath}.tmp`;
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch as 1 | 2 | 3 | 4 },
  })
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, destPath);

  const elapsedMs = Math.round(performance.now() - startedAt);
  const meta = await sharp(destPath).metadata();
  const width = meta.width ?? info.width;
  const height = meta.height ?? info.height;

  const gen = createGeneration({
    id: generationId,
    session_id: spec.sessionId,
    message_id: null,
    kind: "remove_bg",
    prompt: "Remove white background (spritesheet)",
    input_image_ids: [spec.inputGenerationId],
    image_path: toRelative(destPath),
    width,
    height,
    backend: "direct",
  });
  updateJob(jobId, {
    status: "succeeded",
    result: { generationId: gen.id, elapsedMs },
    ended_at: Date.now(),
  });

  log(
    `remove_background(white-sharp) done job=${jobId} gen=${gen.id} ` +
      `${width}x${height} ${elapsedMs}ms`,
  );

  return {
    content: [
      {
        type: "text",
        text:
          `Generated image ${gen.id} (${width}×${height}, ${(elapsedMs / 1000).toFixed(1)}s). ` +
          `Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width,
      height,
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
