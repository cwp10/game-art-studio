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
import {
  chromaKeyFile,
  fallbackBgRemove,
  type AnchorStrategy,
  type ChromaKeyColor,
  type SubjectType,
} from "../image-backend/spritesheet-postprocess.js";
import {
  type Directions,
} from "./spritesheet-classify.js";
import { createGeneration, getGeneration, setGenerationDimensions } from "../db/repo/generations.js";
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
  TEMPLATES_DIR,
} from "../util/paths.js";
import type { GenerationKind } from "../../types/db.js";
import { handleMakeSpritesheet } from "./handlers/spritesheet-handler.js";
import { handleReskinImage } from "./handlers/reskin-handler.js";
import { handleGenerateNormalMap } from "./handlers/normal-map-handler.js";

const RESIZE_TARGET_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;

ensureDataDirs();
const logPath = path.join(LOGS_DIR, "mcp-server.log");
function log(line: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

/**
 * generation 행을 조회하고 절대 파일 경로를 함께 반환.
 * 없으면 throw — `const gen = getGeneration(id); if (!gen) throw …; const p = path.join(DATA_DIR, gen.image_path)`
 * 패턴을 대체한다.
 */
function loadGenerationWithPath(id: string): { gen: ReturnType<typeof getGeneration> & object; filePath: string } {
  const gen = getGeneration(id);
  if (!gen) throw new Error(`generation not found: ${id}`);
  return { gen, filePath: path.join(DATA_DIR, gen.image_path) };
}

/** 새 image job 의 generation/job id 쌍 생성. log·createJob 호출은 각 케이스가 별도 처리. */
function newImageIds(): { generationId: string; jobId: string } {
  return { generationId: newGenerationId(), jobId: newJobId() };
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
      rows: {
        type: "integer", minimum: 1, maximum: 4,
        description: "세로 셀 개수. CELL_PX=384 기준 최대 4셀(1536px).",
      },
      cols: {
        type: "integer", minimum: 1, maximum: 4,
        description: "가로 셀 개수. 최대 4셀. 방향 캐릭터 시트는 최대 4×4=16셀.",
      },
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
      subjectType: {
        type: "string",
        enum: ["character", "effect", "object"],
        description: "(선택) 시트 종류. character=캐릭터, object=아이템/무기, effect=VFX. 미지정 시 프롬프트 키워드로 추론.",
      },
      anchorStrategy: {
        type: "string",
        enum: ["auto", "feet", "hip", "center", "top"],
        description: "(선택) 세로 정렬 기준. 기본 auto=캐릭터는 발/이펙트는 중앙.",
      },
      directions: {
        type: "integer",
        enum: [1, 2, 4, 8],
        description: "(선택) 방향 수. 지정 시 rows=방향수, cols=방향당 프레임수로 해석. 캐릭터 시트 전용.",
      },
      viewpoint: {
        type: "string",
        enum: ["side", "topdown", "isometric", "2.5d-topdown"],
        description:
          "(선택) 카메라 시점. side=사이드스크롤(기본), topdown=탑다운 버드아이뷰, " +
          "isometric=45도 아이소메트릭, 2.5d-topdown=2.5D 약간 위에서 내려보는 탑다운. " +
          "[spritesheet: ...] 디렉티브의 viewpoint 값을 그대로 전달.",
      },
      facing: {
        type: "string",
        enum: ["DOWN", "LEFT", "RIGHT", "UP", "DOWN-LEFT", "DOWN-RIGHT", "UP-LEFT", "UP-RIGHT"],
        description:
          "(선택) 캐릭터가 바라보는 방향. directions=1(단일 방향) 시트에서 [spritesheet: facing=X] 디렉티브가 있을 때 전달. " +
          "NL 프롬프트 방향 감지보다 우선 적용됨.",
      },
      ...SESSION_PROP,
    },
    required: ["prompt", "rows", "cols"],
  },
  make_emote_sheet: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "추가 캐릭터 묘사나 지시 (선택)" },
      inputGenerationId: { type: "string", description: "참조 캐릭터 이미지 generation ID (필수)" },
      emotions: {
        type: "array",
        items: { type: "string" },
        description: "표정 목록 (기본: neutral, happy, sad, angry, surprised, fearful)",
      },
      ...SESSION_PROP,
    },
    required: ["inputGenerationId"],
  },
  make_tileset: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "타일 묘사 (예: 'grass field', 'stone floor')" },
      tileSize: {
        type: "integer",
        enum: [64, 128, 256, 512],
        description: "최종 타일 크기 px (기본: 128). 생성 후 sharp resize 적용.",
      },
      ...SESSION_PROP,
    },
    required: ["prompt"],
  },
  generate_normal_map: {
    type: "object" as const,
    properties: {
      inputGenerationId: { type: "string", description: "원본 이미지 generation ID" },
      strength: {
        type: "number",
        description: "노멀맵 강도 배율 (0.5–2.0, 기본 1.0)",
      },
      ...SESSION_PROP,
    },
    required: ["inputGenerationId"],
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
          "긴 변(가로·세로 중 큰 쪽)을 맞출 픽셀. 비율 유지 (정사각 아님). 작으면 다운스케일, 크면 업스케일.",
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
      extractObject: {
        type: "boolean",
        description:
          "true면 마스크 영역 오브젝트를 투명 배경으로 추출 (layer_extract). false(기본)면 오브젝트를 제거하고 배경 채우기 (inpaint).",
      },
      autoRestore: {
        type: "boolean",
        description:
          "extractObject=true 일 때 가려진 부분을 AI 가 자동 복원할지 여부 (기본 true). false 면 가려진 부분을 복원하지 않고 보이는 영역만 추출.",
      },
      ...SESSION_PROP,
    },
    required: ["prompt", "inputGenerationId"],
  },
  reskin_image: {
    type: "object" as const,
    properties: {
      inputGenerationId: {
        type: "string",
        description:
          "리스킨 대상 이미지의 generation id (필수). 단일 이미지/스프라이트시트 모두 가능 — 대상 kind 로 시트 여부 자동 판별.",
      },
      prompt: {
        type: "string",
        description:
          "(선택) 원하는 스킨 설명. 모드 a(외형 교체)·b(색 팔레트)의 본문, 모드 c(참조 전이)의 추가 지시.",
      },
      styleReferenceId: {
        type: "string",
        description:
          "(선택, 모드 c) 화풍/팔레트를 가져올 스타일 참조 이미지의 generation id. 지정 시 [대상, 참조] 2장으로 스타일 전이.",
      },
      paletteOnly: {
        type: "boolean",
        description:
          "(선택, 모드 b) true 면 형태·선을 100% 유지하고 색 팔레트만 prompt 대로 교체.",
      },
      ...SESSION_PROP,
    },
    required: ["inputGenerationId"],
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
    name: "make_emote_sheet",
    description:
      "캐릭터 참조 이미지를 받아 여러 표정/감정 변형을 그리드로 생성. " +
      "inputGenerationId 필수. 표정 수에 따라 자동으로 그리드 크기 결정. " +
      "60–120초 소요.",
    inputSchema: SCHEMAS.make_emote_sheet,
  },
  {
    name: "make_tileset",
    description:
      "텍스트 프롬프트로 seamless tileable 게임 맵 타일 텍스처를 생성. " +
      "좌우·상하 엣지가 이어지도록 프롬프트 특화. best-effort seamlessness. " +
      "60–120초 소요.",
    inputSchema: SCHEMAS.make_tileset,
  },
  {
    name: "generate_normal_map",
    description:
      "기존 이미지에서 Normal Map을 생성. Sharp 기반 Sobel 필터로 결정적 처리, " +
      "Codex 호출 없음(1초 이내). RGB 인코딩: R=X기울기, G=Y기울기, B=255.",
    inputSchema: SCHEMAS.generate_normal_map,
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
      "기존 이미지를 긴 변(가로·세로 중 큰 쪽) 기준 픽셀로 리사이즈 (비율 유지, 정사각 아님). sharp lanczos 보간법. " +
      "codex 호출 X, 1초 이내, 결정적. 사용자가 64/256/512/1024/2048/4096/8192 같은 숫자를 " +
      "직접 지정했거나 리사이즈를 요청한 경우.",
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
  {
    name: "reskin_image",
    description:
      "기존 이미지/스프라이트시트의 외형을 바꿔 새 버전을 생성 (구조·포즈는 유지). 3모드: " +
      "(a) prompt 만 → 외형 교체(색·재질·테마만, 포즈/실루엣/구도 유지). " +
      "(b) paletteOnly=true → 형태 100% 유지, 색 팔레트만 prompt 대로 교체. " +
      "(c) styleReferenceId → 참조 이미지의 화풍/팔레트를 대상에 전이. " +
      "대상이 스프라이트시트면 셀 정렬·투명화 후처리가 자동 적용된다(단일 이미지는 후처리 없음).",
    inputSchema: SCHEMAS.reskin_image,
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
  extractObject?: boolean;
  autoRestore?: boolean;
  styleReferenceId?: string;
  paletteOnly?: boolean;
  rows?: number;
  cols?: number;
  targetSize?: number;
  emotions?: string[];
  tileSize?: number;
  strength?: number;
  seamlessLoop?: boolean;
  subjectType?: SubjectType;
  anchorStrategy?: AnchorStrategy;
  directions?: Directions;
  viewpoint?: string;
  sessionId?: string;
};

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as CallArgs;
  const sessionId = args.sessionId ?? null;

  try {
    switch (name) {
      case "generate_image": {
        // 사용자가 배경을 명시하지 않으면 기본 투명 배경.
        // 오케스트레이터가 빠뜨려도 서버 측에서 한 번 더 보장.
        const rawPrompt = requireString(args.prompt, "prompt");

        // 투명 배경 여부 판단: 흰/컬러 배경 명시가 없으면 transparent.
        // 장면·환경 묘사가 있으면 오케스트레이터가 transparent 를 추가했더라도 무시.
        const hasSceneDesc = /도시|city|거리|street|숲|forest|하늘|sky|해변|beach|던전|dungeon|실내|indoor|야외|outdoor|네온|neon|사이버|cyber|빗|비\s*내리|눈\s*내리|우천|landscape|배경/.test(
          rawPrompt.toLowerCase(),
        );
        const wantsTransparentGen =
          !hasSceneDesc &&
          !/white\s*(bg|background)|흰\s*배경/.test(rawPrompt.toLowerCase()) &&
          ((/transparent|투명/i.test(rawPrompt)) || !(/배경|background/i.test(rawPrompt)));

        // 녹색 피사체 감지 → magenta key, 아니면 green key.
        const genGreenSubject = /녹색|초록|연두|green|슬라임|slime|leaf|이끼|moss/.test(
          rawPrompt.toLowerCase(),
        );
        const genChromaKey: ChromaKeyColor = genGreenSubject ? "magenta" : "green";

        // 투명 배경이면 chroma-key 배경 주입 (모델이 직접 알파를 그리면 edge fringe가 남음).
        const genBgInstruction = wantsTransparentGen
          ? genChromaKey === "magenta"
            ? "\nCRITICAL background: Use a SOLID FLAT pure magenta (#ff00ff) chroma-key background filling every pixel that is NOT the subject — no gradients, no shadows, crisp silhouette. Post-processing will key out the magenta to produce true transparency."
            : "\nCRITICAL background: Use a SOLID FLAT pure green (#00ff00) chroma-key background filling every pixel that is NOT the subject — no gradients, no shadows, crisp silhouette. Post-processing will key out the green to produce true transparency."
          : "";

        const prompt = ensureTransparentDefault(rawPrompt) + genBgInstruction;
        const genResult = await runImageTool({
          name,
          kind: "text2img",
          prompt,
          inputGenerationIds: [],
          sessionId,
          signal: extra.signal,
        });

        // 투명 배경 후처리: chroma-key 제거 → fallback flood-fill
        if (wantsTransparentGen) {
          const genId: string | undefined = genResult?.structuredContent?.generationId;
          if (genId) {
            const filePath = imagePathFor(genId);
            try {
              const ckOut = await applyTransparentPostProcess(filePath, genChromaKey);
              log(`generate_image chroma-keyed gen=${genId} key=${genChromaKey} keyedOut=${ckOut}`);
            } catch (e) {
              log(`generate_image post-process fail: ${(e as Error).message}`);
            }
          }
        }
        return genResult;
      }

      case "make_spritesheet":
        return await handleMakeSpritesheet(args as Record<string, unknown>, { signal: extra.signal }, { sessionId, log });

      case "edit_image":
        return await runImageTool({
          name,
          kind: "img2img",
          prompt: requireString(args.prompt, "prompt"),
          inputGenerationIds: [requireString(args.inputGenerationId, "inputGenerationId")],
          sessionId,
          signal: extra.signal,
        });

      case "upscale_image":
        return await runImageTool({
          name,
          kind: "upscale",
          prompt: "Upscale to approximately 2x resolution preserving all detail.",
          inputGenerationIds: [requireString(args.inputGenerationId, "inputGenerationId")],
          sessionId,
          signal: extra.signal,
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
          signal: extra.signal,
        });
      }

      case "inpaint_image": {
        const inputId = requireString(args.inputGenerationId, "inputGenerationId");
        const prompt = requireString(args.prompt, "prompt");
        const ids = args.maskGenerationId ? [inputId, args.maskGenerationId] : [inputId];
        const isExtract = args.extractObject === true;
        // extractObject=true → 마스크 영역 오브젝트를 투명 배경으로 추출(layer_extract).
        // 기본(false/undefined) → 오브젝트 제거 + 배경 채우기(inpaint).
        // autoRestore=false → 가려진 부분 복원 안 함(텍스트 기반 추출에서만 유효).
        return await runImageTool({
          name,
          kind: isExtract ? "layer_extract" : "inpaint",
          prompt,
          inputGenerationIds: ids,
          params: isExtract && args.autoRestore === false ? { autoRestore: false } : undefined,
          sessionId,
          signal: extra.signal,
        });
      }

      case "reskin_image":
        return await handleReskinImage(args as Record<string, unknown>, { signal: extra.signal }, { sessionId, log });

      case "make_emote_sheet": {
        const inputGenerationId = requireString(args.inputGenerationId, "inputGenerationId");
        const userPrompt = typeof args.prompt === "string" ? args.prompt : "";
        const emotions: string[] =
          Array.isArray(args.emotions) && args.emotions.length > 0
            ? (args.emotions as string[])
            : ["neutral", "happy", "sad", "angry", "surprised", "fearful"];

        const n = emotions.length;
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);

        // API 한계 검증 — 생성 캔버스 실측 최대 1536px(CELL_PX=384 × 4).
        const CELL_PX_E = 384;
        if (Math.max(rows, cols) * CELL_PX_E > 1536) {
          throw new Error(
            `make_emote_sheet: ${n}개 표정 → ${rows}×${cols}그리드 캔버스(${cols * CELL_PX_E}×${rows * CELL_PX_E}px)가 한계(1536px) 초과.`,
          );
        }

        const refGen = getGeneration(inputGenerationId);
        if (!refGen) throw new Error(`make_emote_sheet: generation ${inputGenerationId} 없음`);
        const refPath = path.join(DATA_DIR, refGen.image_path);

        const emotionLayout = emotions
          .map((e, i) => {
            const r = Math.floor(i / cols) + 1;
            const c = (i % cols) + 1;
            return `row${r}-col${c}=${e}`;
          })
          .join(", ");

        const gridTemplatePath = await generateGridTemplate(cols, rows, 384, 384);

        const prompt =
          `${rows}×${cols} emotion sheet, same character from reference, ` +
          `different facial expressions per cell: ${emotionLayout}. ` +
          (userPrompt ? `${userPrompt}. ` : "") +
          `transparent background`;

        return await runImageTool({
          name,
          kind: "emote_sheet",
          prompt,
          inputGenerationIds: [inputGenerationId],
          overrideInputPaths: [refPath, gridTemplatePath],
          params: {
            rows, cols,
            cellW: 512, cellH: 512,
            emotions,
            fps: 4,
            seamlessLoop: false,
          },
          sessionId,
          signal: extra.signal,
        });
      }

      case "make_tileset": {
        const userPrompt = requireString(args.prompt, "prompt");
        const VALID_SIZES = [64, 128, 256, 512] as const;
        const tileSize: 64 | 128 | 256 | 512 =
          VALID_SIZES.includes(Number(args.tileSize) as 64 | 128 | 256 | 512)
            ? (Number(args.tileSize) as 64 | 128 | 256 | 512)
            : 128;

        // 모델 네이티브 해상도로 생성 후 sharp resize → tileSize
        const result = await runImageTool({
          name,
          kind: "tileset",
          prompt: userPrompt,
          inputGenerationIds: [],
          params: { tileSize },
          sessionId,
          signal: extra.signal,
        });

        // post-process: tileSize 로 리사이즈. structuredContent.imagePath 는 /api URL 이므로
        // 실제 파일은 imagePathFor(genId) 로 접근하고 tmp→rename 후 dimensions 갱신.
        const genId = result?.structuredContent?.generationId;
        if (genId && result.structuredContent.width !== tileSize) {
          const filePath = imagePathFor(genId);
          const tmp = `${filePath}.tile.tmp`;
          await sharp(filePath)
            .resize(tileSize, tileSize, { kernel: "lanczos3", fit: "fill" })
            .png()
            .toFile(tmp);
          fs.renameSync(tmp, filePath);
          setGenerationDimensions(genId, tileSize, tileSize);
          result.structuredContent.width = tileSize;
          result.structuredContent.height = tileSize;
          log(`make_tileset resized gen=${genId} to ${tileSize}x${tileSize}`);
        }

        return result;
      }

      case "generate_normal_map":
        return await handleGenerateNormalMap(args as Record<string, unknown>, { signal: extra.signal }, { sessionId, log });

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

// ─── post-process helpers ────────────────────────────────────────────────────

/**
 * 투명 배경 후처리: chromaKeyFile → keyedOut=0이면 fallbackBgRemove 로 폴백.
 * generate_image / make_spritesheet / reskin_image 세 경로 공통 시퀀스.
 * cellArea 미지정 시 이미지 전체를 단일 셀로 간주(단일 이미지 경로).
 */
async function applyTransparentPostProcess(
  filePath: string,
  chromaKey: ChromaKeyColor,
  cellArea?: number,
): Promise<number> {
  const keyedOut = await chromaKeyFile(filePath, chromaKey, log, cellArea);
  if (keyedOut === 0) return await fallbackBgRemove(filePath, log);
  return keyedOut;
}

function ensureTransparentDefault(prompt: string): string {
  if (/배경|background|transparent|투명/i.test(prompt)) return prompt;
  return prompt.replace(/[.,]?\s*$/, "") + ", transparent background";
}


/**
 * 스프라이트 시트 레퍼런스용 그리드 PNG.
 *   - 외곽 셀 경계: 회색 1px (#cccccc) — 모델에게 셀 레이아웃만 시각적으로 전달.
 * 내부 safe-zone 박스는 v2 까지 그려넣었지만 모델이 그대로 출력에 복사하는
 * 부작용 → v3 부터는 그리지 않고 후처리(normalizeSpritesheetCells)로 패딩 강제.
 * data/templates/sprite-grid-v3-{cols}x{rows}x{cellW}x{cellH}.png 에 자동 캐싱(런타임 생성).
 */
async function generateGridTemplate(
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
): Promise<string> {
  const w = cols * cellW;
  const h = rows * cellH;
  const cachePath = path.join(
    TEMPLATES_DIR,
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

  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  await sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(cachePath);
  log(`generateGridTemplate v3: ${cols}x${rows} cell=${cellW}x${cellH} saved → ${cachePath}`);
  return cachePath;
}

async function runImageTool(spec: {
  name: string;
  /** codex 프롬프트 선택용 kind (buildNaturalPrompt). */
  kind: GenerationKind;
  /** generation 행에 저장할 kind. 미지정 시 kind 와 동일. 프롬프트 kind 와 저장 kind 가
   *  달라야 할 때 사용(예: reskin 으로 만든 시트는 프롬프트는 'reskin', 저장은 'spritesheet'). */
  storeKind?: GenerationKind;
  prompt: string;
  inputGenerationIds: string[];
  extraInputPaths?: string[];
  /** Codex 에 실제로 전달할 이미지 경로 순서를 완전히 override.
   *  설정하면 inputGenerationIds + extraInputPaths 자동 조합을 무시. */
  overrideInputPaths?: string[];
  /** reskin 모드(c): 스타일 참조 이미지 절대 경로. */
  styleRefPath?: string;
  /** reskin 모드(b): 색 팔레트만 교체. */
  paletteOnly?: boolean;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  sessionId: string | null;
  /** 진행 보고 detail 에 붙일 접두사(예: 재시도 "attempt 2/3"). 사용자가 재시도 중임을 알게. */
  progressPrefix?: string;
}) {
  const { name, kind, storeKind, prompt, inputGenerationIds, extraInputPaths, overrideInputPaths, styleRefPath, paletteOnly, params, signal, sessionId, progressPrefix } = spec;
  const persistedKind = storeKind ?? kind;

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

  const { generationId, jobId } = newImageIds();

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
  const job: ImageJob = { id: jobId, generationId, kind, prompt, inputImagePaths, styleRefPath, paletteOnly, params };
  const result = await backend.execute(job, (stage, detail) => {
    const d = progressPrefix ? `[${progressPrefix}]${detail ? " " + detail : ""}` : detail;
    log(`  ${jobId} stage=${stage}${d ? " " + d : ""}`);
    appendProgress(stage, d);
  }, signal);

  const gen = createGeneration({
    id: generationId,
    session_id: sessionId,
    message_id: null, // Claude orchestration 경로에서는 message_id 사후 연결.
    kind: persistedKind,
    prompt,
    input_image_ids: inputGenerationIds,
    params, // 생성 메타(seamlessLoop / reskin mode·styleReferenceId 등) 영속화.
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
      kind: persistedKind,
      elapsedMs: result.elapsedMs,
    },
  };
}

/**
 * sharp lanczos 기반 결정적 리사이즈 — codex 호출 X. ImageBackend 우회.
 * 긴 변 기준 비율 유지(fit=inside). 알파 보존. backend='direct' 로 generation 행 작성.
 */
async function runResizeTool(spec: {
  inputGenerationId: string;
  targetSize: number;
  sessionId: string | null;
}) {
  const { filePath: inputPath } = loadGenerationWithPath(spec.inputGenerationId);

  const { generationId, jobId } = newImageIds();
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
  // 긴 변(가로·세로 중 큰 쪽)을 targetSize 로 맞추고 비율 유지 — fit:"inside" + 양변 targetSize.
  // 실제 출력 치수는 sharp 가 반환하는 info 에서 받는다(정사각 아님).
  const info = await sharp(inputPath)
    .resize(spec.targetSize, spec.targetSize, { kernel: "lanczos3", fit: "inside" })
    .png()
    .toFile(destPath);
  const outW = info.width;
  const outH = info.height;
  const elapsedMs = Math.round(performance.now() - startedAt);

  const gen = createGeneration({
    id: generationId,
    session_id: spec.sessionId,
    message_id: null,
    kind: "resize",
    prompt: `Resize longest side to ${spec.targetSize}px (→ ${outW}×${outH}, aspect preserved)`,
    input_image_ids: [spec.inputGenerationId],
    image_path: toRelative(destPath),
    width: outW,
    height: outH,
    backend: "direct",
  });
  updateJob(jobId, {
    status: "succeeded",
    result: { generationId: gen.id, elapsedMs },
    ended_at: Date.now(),
  });

  log(`resize_image done job=${jobId} gen=${gen.id} ${outW}x${outH} (longest=${spec.targetSize}) ${elapsedMs}ms`);

  return {
    content: [
      {
        type: "text",
        text:
          `Resized image ${gen.id} (${outW}×${outH}, longest side ${spec.targetSize}px, ${elapsedMs}ms). ` +
          `Show it with image ref id "${gen.id}".`,
      },
    ],
    structuredContent: {
      generationId: gen.id,
      imagePath: `/api/images/${gen.id}`,
      width: outW,
      height: outH,
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
  const { filePath: inputPath } = loadGenerationWithPath(spec.inputGenerationId);
  const { generationId, jobId } = newImageIds();
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
  () => log(`mcp server started (data=${DATA_DIR})`),
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
