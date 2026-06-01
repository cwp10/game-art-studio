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
  detectFill,
  isGreenDominant,
  normalizeSpritesheetCells,
  type AnchorStrategy,
  type ChromaKeyColor,
  type SubjectType,
} from "../image-backend/spritesheet-postprocess.js";
import { reorderSpritesheetFrames } from "../image-backend/spritesheet-reorder.js";
import { getCachedPoseRow } from "../image-backend/pose-reference.js";
import {
  inferSubjectType,
  buildDirectionPrompt,
  isLocomotion,
  isRunning,
  type Directions,
} from "./spritesheet-classify.js";
import { createGeneration, getGeneration, deleteGeneration, setGenerationDimensions } from "../db/repo/generations.js";
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
  REFERENCE_DIR,
  TEMPLATES_DIR,
} from "../util/paths.js";
import type { GenerationKind } from "../../types/db.js";

const RESIZE_TARGET_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;

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
      cols: { type: "integer", minimum: 1, maximum: 16, description: "가로 셀 개수. 방향 캐릭터 시트(directions≥2)는 최대 8 권장 — 12 이상은 모델이 발 교대를 제대로 못 그림." },
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
        enum: ["character", "effect"],
        description: "(선택) 시트 종류. 미지정 시 프롬프트 키워드로 추론.",
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
  styleReferenceId?: string;
  paletteOnly?: boolean;
  rows?: number;
  cols?: number;
  targetSize?: number;
  seamlessLoop?: boolean;
  subjectType?: SubjectType;
  anchorStrategy?: AnchorStrategy;
  directions?: Directions;
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

        // ② 방향 시트: directions 가 주어지면 rows=directions 로 강제(각 행=한 방향),
        // cols 는 방향당 프레임 수로 해석(그대로 사용). directions=1 은 단일 방향(기존 동작).
        const directions: Directions | null = args.directions ?? null;
        if (directions && rows !== directions) {
          log(`make_spritesheet directions=${directions}: rows ${rows} → ${directions}`);
          rows = directions;
        }

        // rows=1 이고 cols > 4 인 경우: 다행 그리드로 자동 변환.
        // (시스템 프롬프트가 잘못 지시하거나 사용자가 명시해도 방어)
        if (rows === 1 && cols > 4) {
          const n = cols;
          rows = Math.round(Math.sqrt(n));
          cols = Math.ceil(n / rows);
          log(`make_spritesheet auto-reshape: 1×${n} → ${rows}×${cols}`);
        }

        // 생성 셀 384px 고정 → codex 네이티브 장축(1536px) 안으로 캔버스가 들어온다.
        //   3×2:1152×768, 4×2:1536×768, 3×4:1152×1536, 4×4:1536×1536 — 모두 장축 ≤1536.
        // 최종 출력은 FINAL_CELL_PX(512)로 업스케일(후처리 normalize 후 1회). 384→512 = ×4/3.
        const CELL_PX = 384;       // codex 생성 셀 크기
        const FINAL_CELL_PX = 512; // 업스케일 후 최종 셀 크기 (DB params·export 기준)
        const cellH = CELL_PX;
        const cellW = CELL_PX;
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

        // ⑥ 녹색 캐릭터 키워드 감지 → 마젠타 키 폴백.
        // 명시적 녹색 색상 키워드만(고블린 등 모호어 제외) — 녹색 옷/슬라임이 chroma-key 에
        // 먹히는 회귀 방지. 키워드 없으면 기존 green 경로.
        const greenSubject = /녹색|초록|연두|green|슬라임|slime|잎|leaf|이끼|moss/.test(
          userPrompt.toLowerCase(),
        );
        // 참조 이미지가 있으면 그 본체 색을 분석 — 사용자가 "green" 이라 안 써도 참조
        // 캐릭터가 녹색 우세면 자동으로 마젠타 키로 폴백(녹색 본체 보존). 키워드 OR 결합.
        let refIsGreen = false;
        if (refId) {
          const rg = getGeneration(refId);
          if (rg) {
            try {
              refIsGreen = await isGreenDominant(path.join(DATA_DIR, rg.image_path), log);
            } catch {
              /* 분석 실패 시 키워드 경로 유지 */
            }
            if (refIsGreen) log(`make_spritesheet: ref ${refId} green-dominant → magenta key`);
          }
        }
        const chromaKeyColor: ChromaKeyColor = greenSubject || refIsGreen ? "magenta" : "green";

        // 투명 배경은 chroma-key 방식: 모델에게 키색 위에 그리게 하고 후처리로 keying.
        // 모델이 직접 알파를 그리면 흰색 fringe / 회색 잔재가 남음.
        const bgInstruction = wantsTransparent
          ? chromaKeyColor === "magenta"
            ? "CRITICAL background: Use a SOLID FLAT pure magenta (#ff00ff) chroma-key background filling every pixel that is NOT the character — no gradients, no shadows, no anti-aliasing fringe, crisp character silhouette. The post-processing pipeline will key out the magenta to produce true transparency."
            : "CRITICAL background: Use a SOLID FLAT pure green (#00ff00) chroma-key background filling every pixel that is NOT the character — no gradients, no shadows, no anti-aliasing fringe, crisp character silhouette. The post-processing pipeline will key out the green to produce true transparency."
          : "White background.";

        const isWalk = isLocomotion(userPrompt);
        const isRun = isRunning(userPrompt);
        const loopInstruction = seamlessLoop
          ? `INFINITE LOOP DESIGN (CRITICAL): These frames will play as [1→2→…→N→1→2→…] on repeat forever. ` +
            `Frame N is the frame that plays IMMEDIATELY BEFORE Frame 1 — they are adjacent in the cycle. ` +
            `Design a CLOSED CYCLE with no beginning and no end: ` +
            `• Walk/run: Frame N's pose flows naturally back into Frame 1's pose. ` +
            `• Idle/breathing: Frame N is a subtle mid-motion pose that flows directly into Frame 1's starting pose. ` +
            `• Attack/action: Frame N is the very last moment of recovery — the character is already returning to ready stance, so Frame 1's ready pose follows naturally. ` +
            `NEVER design a linear arc (wind-up → peak → stop). ALWAYS design a cycle (no visible start/end point). `
          : "";

        // 피사체 종류·앵커 전략 해석 — 명시 param 우선, 없으면 키워드 추론 폴백.
        // subjectType 은 normalize 정렬·이펙트 가드의 결정적 입력 신호.
        const subjectType: SubjectType =
          args.subjectType ?? inferSubjectType(userPrompt, !!refId);
        const anchorStrategy: AnchorStrategy = args.anchorStrategy ?? "auto";
        // auto → 구체 전략(normalize 의 resolveAnchor 와 동일 규칙). 프롬프트/피벗 산출용.
        const resolvedAnchor: Exclude<AnchorStrategy, "auto"> =
          anchorStrategy !== "auto" ? anchorStrategy : subjectType === "effect" ? "center" : "feet";
        // 가드·콘텐츠 열거·캐릭터 프레이밍은 subjectType 로 게이팅(앵커 전략과 무관).
        // 배치(placement)만 resolvedAnchor 로 분기 — character+center 도 캐릭터 프레이밍/가드 유지.
        const isCharacter = subjectType === "character";
        const cx = Math.round(cellW / 2);
        const cy = Math.round(cellH / 2);
        // (5) 배치 규칙 — 5전략별. character 의 center 는 "수직 중앙"(접지 언급 X),
        // effect 의 center 만 "VFX radiates symmetrically / no ground line" 문구.
        const placementRule = ((): string => {
          switch (resolvedAnchor) {
            case "feet":
              return `keep the feet on a consistent ground line and identical character height in every frame; only limbs and body parts move between frames, not the whole body. `;
            case "hip":
              return `keep the hip/waist near the cell center X=${cx}, Y=${cy} with the feet falling naturally below, and identical character height in every frame; only limbs and body parts move between frames. `;
            case "top":
              return `keep the top of the head near the cell's upper edge in every frame and identical character height; only limbs and body parts move between frames, not the whole body. `;
            case "center":
              return isCharacter
                ? `place the WHOLE character vertically centered so its visual center sits at the cell center X=${cx}, Y=${cy} in EVERY cell, identical character height; only limbs and body parts move between frames. `
                : `this is a visual effect / VFX, NOT a grounded character. ` +
                  `Place the effect so its OWN visual center sits exactly at the cell center X=${cx}, Y=${cy} in EVERY cell. ` +
                  `The effect's COMPLETE bounding box — INCLUDING any trailing tail, motion streak, after-image, sparks, and particles — must be vertically centered: ` +
                  `the topmost and bottommost drawn pixels must be EQUIDISTANT from the cell's top and bottom edges (equal empty rows above and below the whole shape). ` +
                  `The trailing tail must NOT reach or touch the bottom edge. ` +
                  `Do NOT rest it on the bottom edge, do NOT use any ground line, floor, or shadow plane — the effect floats centered and radiates symmetrically in all directions. `;
          }
        })();
        const anchorRule = `(5) ${isCharacter ? "CHARACTER" : "EFFECT"} ANCHOR — ${placementRule}`;

        // rule (1)/(3) 의 콘텐츠 열거는 시트 종류에 따라 분기.
        // character 시트는 발산 VFX 를 콘텐츠로 전제하면 안 됨(③) — 몸·무기·천만 나열.
        const containedContent = isCharacter
          ? "the character's body, weapon, and any flowing cape or robe"
          : "the subject and ALL of its effects, trails, particles, projectiles, beams, weapons, auras, and flowing capes/robes";
        const oversizeContent = isCharacter
          ? "especially a large pose or a wide weapon swing"
          : "especially a sweeping effect like a slash, blast, beam, or trail";

        // ③ 캐릭터 시트 이펙트 가드 — subjectType=character 면 anchor 무관하게 항상 주입.
        // 외부로 발산되는 액션/능력 VFX 만 금지, 캐릭터 고유 디자인은 허용.
        const effectGuard = isCharacter
          ? `Render the character's body and its INTRINSIC design only. ` +
            `Do NOT add action or ability visual effects: NO attack slash trails, ` +
            `NO spell or magic particles, NO projectiles, NO emitted auras around the body, ` +
            `NO motion lines, NO impact flashes, NO smoke, NO sparkles, NO extra decorative VFX. ` +
            `The character's OWN intrinsic material is fine (e.g. a robot's status lights or ` +
            `glowing core, a fire creature's flame body, a weapon that glows as part of its ` +
            `resting design). Any action or ability effect belongs on a SEPARATE effect sprite sheet. `
          : "";

        // ② 방향 라벨 지시 — 캐릭터 시트 + directions≥2 에서만 의미. 이펙트엔 주입 X.
        const directionPrompt =
          isCharacter && directions ? buildDirectionPrompt(directions, cols) : "";

        // ②-b 행(방향) 개수 강제 — 모델이 directions 행을 fewer 줄로 압축하는 회귀 방지.
        // directionPrompt 와 동일 가드(isCharacter && directions). 레이아웃 설명에 직접 주입.
        const rowCountRule =
          isCharacter && directions
            ? `The sheet MUST have EXACTLY ${rows} horizontal rows of cells (one row per direction), filled from top to bottom. ` +
              `Draw all ${rows} rows — do NOT compress, merge, or omit rows, do NOT leave any row empty, and keep EQUAL vertical spacing between the ${rows} rows. `
            : "";

        // ②-c 열(프레임) 개수 강제 — 모델이 cols 프레임을 fewer 열로 압축(중앙/끝 빈 열)하는 회귀 방지.
        // rowCountRule 과 동일 가드·대칭 문구. 각 방향 행이 cols 프레임을 가로로 빠짐없이 채우게 한다.
        const colCountRule =
          isCharacter && directions
            ? `Each row MUST contain EXACTLY ${cols} frames placed left to right, filling every column. ` +
              `Draw all ${cols} frames in every row — do NOT compress, merge, or omit frames, do NOT leave any column empty, and keep EQUAL horizontal spacing between the ${cols} frames. `
            : "";

        // 오브젝트 일관성 규칙 — 캐릭터 시트에서만 주입.
        const equipmentRule = isCharacter
          ? `OBJECT CONSISTENCY LOCK (non-negotiable): Every object the character holds, carries, or wears MUST appear fully visible and consistently present in EVERY SINGLE FRAME. ` +
            `Do NOT hide, shrink, omit, or occlude any held or worn object in any frame — even mid-swing or when the limb faces away from the viewer. ` +
            `If any carried object disappears or becomes invisible in a frame, that frame is incorrect. `
          : "";

        // 보행 캐릭터 시트: 포즈 레퍼런스 시트를 생성해 Codex 입력에 포함.
        const refGen = refId ? getGeneration(refId) : null;
        const refPath = refGen ? path.join(DATA_DIR, refGen.image_path) : null;

        // 보행 캐릭터: 방향×cols에 맞는 포즈 가이드를 생성해 Codex에 전달.
        // buildPoseSvg로 직접 생성 → cols에 맞는 완전한 사이클 보장.
        // 결과는 templates/ 에 캐시 — 동일 요청은 파일 재사용.
        let poseRefPath: string | null = null;
        let poseFrameAnglesText = "";
        if (isWalk && isCharacter && (!directions || directions === 1)) {
          const isRun = isRunning(userPrompt);
          try {
            const dirIndex = 6; // RIGHT(사이드뷰) 기본, 향후 파라미터로 확장
            const { path: guidePath, angles } = await getCachedPoseRow(dirIndex, cols, CELL_PX, TEMPLATES_DIR, isRun);
            poseRefPath = guidePath;
            // 프레임별 각도 텍스트 생성 — "col1: L+32°/R-32°(L-CONTACT), col2: ..."
            poseFrameAnglesText = angles
              .map(a => `col${a.col + 1}: L${a.leftDeg >= 0 ? "+" : ""}${a.leftDeg}°/R${a.rightDeg >= 0 ? "+" : ""}${a.rightDeg}°(${a.label})`)
              .join(", ");
            log(`make_spritesheet: pose guide → ${path.basename(guidePath)}`);
          } catch (e) {
            log(`make_spritesheet: pose guide failed (non-fatal): ${(e as Error).message}`);
          }
        }

        // 보행 사이클 다리 교차 규칙 — 걷기/달리기 캐릭터 시트에서만 주입.
        const walkCycleRule = isWalk && isCharacter
          ? `WALK CYCLE GAIT (CRITICAL, NON-NEGOTIABLE): ` +
            `This is a WALKING/RUNNING animation. You MUST depict the complete, natural gait cycle including EVERY phase: ` +
            `(1) CONTACT — left leg fully forward, right leg fully back; ` +
            `(2) CROSSOVER/MID-STANCE — both legs passing each other (legs close together, weight centered); ` +
            `(3) CONTACT — right leg fully forward, left leg fully back; ` +
            `(4) CROSSOVER/MID-STANCE — both legs passing each other again. ` +
            `This 4-phase pattern repeats. For more frames, subdivide each phase. ` +
            `The crossover frames (legs close/passing) are REQUIRED — they are what makes the motion look natural and smooth. ` +
            `NEVER produce a cycle where the legs stay extended in the same direction for multiple frames with no crossover. ` +
            `LEG VISIBILITY (CRITICAL): In EVERY frame, BOTH legs must be clearly visible and spatially separated. ` +
            `The gap between the two legs must be OBVIOUS — never draw them overlapping or merged into a single shape. ` +
            `For side views: one leg is visibly in FRONT of the other with clear fore/aft depth separation. ` +
            `For front/back views: one foot is visibly further FORWARD (lower in frame) while the other is back (higher). ` +
            `If the character has visible joints (knees, ankles), show those joints at different positions between the two legs in every frame. `
          : "";

        const poseRefInstruction = poseRefPath
          ? `POSE GUIDE (first attached image): The first attached image is the grid template with stick-figure skeletons already drawn inside each cell. ` +
            `Blue = left leg, Red = right leg. Each skeleton shows the EXACT leg angle required for that cell. ` +
            `You MUST render your character OVER these skeletons, matching the leg positions shown. ` +
            `The skeleton is your guide — replace it with the actual character while keeping the same leg angles. ` +
            (poseFrameAnglesText
              ? `EXACT LEG ANGLES PER COLUMN: ${poseFrameAnglesText}. ` +
                `These are the precise angles you MUST reproduce — positive=forward, negative=back. `
              : "")
          : "";

        const decorated =
          `${userPrompt}. ` +
          equipmentRule +
          walkCycleRule +
          poseRefInstruction +
          (poseRefPath || refPath
            ? `The last attached image is a GRID TEMPLATE — a blank canvas with thin gray lines marking the exact ${cols}×${rows} cell layout (${canvasW}×${canvasH} pixels, each cell ${cellW}×${cellH} pixels). `
            : `The attached image is a GRID TEMPLATE — a blank canvas with thin gray lines marking the exact ${cols}×${rows} cell layout (${canvasW}×${canvasH} pixels, each cell ${cellW}×${cellH} pixels). `) +
          `Generate a sprite sheet with EXACTLY the same dimensions as the template. ` +
          rowCountRule +
          colCountRule +
          `Place exactly one animation frame per cell, filling every cell. ` +
          `CRITICAL framing rules (apply to EVERY cell): ` +
          `(1) The ENTIRE frame content — ${containedContent} — must be FULLY contained within its own cell. NOT A SINGLE PIXEL may cross into a neighboring cell. ` +
          `(2) Keep a clear EMPTY margin of at least ${Math.round(Math.min(cellW, cellH) * 0.12)}px on all four sides of each cell — fit everything inside the central safe zone, never touching the cell edges. ` +
          `(3) If the content would be large (${oversizeContent}), SCALE THE WHOLE FRAME DOWN so it fits inside the cell with the margin — never let it sprawl across cell boundaries. ` +
          `(4) Use the SAME scale in every frame and keep ZERO positional drift between cells — the content stays anchored at the same spot, only the animation changes. ` +
          anchorRule +
          directionPrompt +
          effectGuard +
          loopInstruction +
          `Do NOT include the gray guide lines in the output — they are reference only. ` +
          bgInstruction;
        // 입력 이미지 순서: 포즈 가이드(있을 때) → char ref → grid(항상 마지막)
        const inputImages: string[] = [];
        if (poseRefPath) inputImages.push(poseRefPath);
        if (refPath) inputImages.push(refPath);
        inputImages.push(gridTemplatePath);
        const overrideInputPaths = inputImages;

        // ⑧ 앵커 피벗(셀-로컬) 결정적 산출 — normalize 의 고정 목표선과 일치.
        // export(Phase 3) 가 이 좌표를 그대로 사용. paddingBottom/margin 은 normalize 와 동일 식.
        const paddingBottom = Math.round(cellH * 0.03);
        const anchorMargin = Math.round(Math.min(cellW, cellH) * 0.05);
        const anchorY =
          resolvedAnchor === "center"
            ? Math.round(cellH / 2)
            : resolvedAnchor === "top"
              ? anchorMargin
              : resolvedAnchor === "hip"
                ? Math.round(cellH - paddingBottom - 1 - cellH * 0.9 * 0.45)
                : cellH - paddingBottom - 1; // feet
        // anchorPivot: 저장·export 는 FINAL_CELL_PX(512) 공간 기준이므로 ×(512/384) 스케일.
        // codex 프롬프트(anchorRule)는 위 cx/cellH(384 공간) 값을 그대로 쓴다.
        const pivotScale = FINAL_CELL_PX / CELL_PX;
        const anchorPivot = {
          x: Math.round(cx * pivotScale),
          y: Math.round(anchorY * pivotScale),
        };

        // ── 빈 셀 자동 재생성 루프 ──────────────────────────────────────────
        // 모델이 그리드를 100% 못 채우는 가챠(신뢰성 ~50%)를 재시도로 흡수한다.
        // 캐릭터 시트는 방향 수 관계없이 재시도 — 발 교차 등 품질이 1회로는 불안정.
        // 이펙트/오브젝트는 1회(그리드 충만도 실패 가능성이 낮고 과금 절약).
        const retryEnabled = isCharacter;
        const MAX_RETRIES = retryEnabled ? 2 : 0; // 총 최대 3시도(방향 시트), 1시도(그 외)
        const spritesheetParams = {
          seamlessLoop,
          subjectType,
          anchorStrategy,
          directions: directions ?? undefined,
          anchor: anchorPivot,
          rows,
          cols,
          cellW: FINAL_CELL_PX,
          cellH: FINAL_CELL_PX,
          fps: 12,
        };

        let best: Awaited<ReturnType<typeof runImageTool>> | null = null;
        let bestFilled = -1;
        let cumulativeMs = 0;
        let lastStats: Awaited<ReturnType<typeof detectFill>> | null = null;

        const cleanupResult = (r: Awaited<ReturnType<typeof runImageTool>>) => {
          const gid = r?.structuredContent?.generationId;
          if (!gid) return;
          try {
            const fp = imagePathFor(gid);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            deleteGeneration(gid);
            log(`make_spritesheet retry: discarded gen=${gid} (lower fill)`);
          } catch (e) {
            log(`make_spritesheet retry cleanup fail gen=${gid}: ${(e as Error).message}`);
          }
        };

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const mcpResult = await runImageTool({
            name,
            kind: "spritesheet",
            prompt: decorated,
            inputGenerationIds: refId ? [refId] : [],  // DB input_image_ids 추적용
            overrideInputPaths,                         // Codex 실제 입력 순서 제어
            params: spritesheetParams,
            sessionId,
            progressPrefix: retryEnabled ? `attempt ${attempt + 1}/${MAX_RETRIES + 1}` : undefined,
          });
          cumulativeMs += mcpResult?.structuredContent?.elapsedMs ?? 0;

          // ── 후처리 1단계: 리사이즈 + chroma-key (normalize 는 best 선택 후 1회만) ──
          // 1) 정확한 배수 크기로 강제 리사이즈 (셀 경계 픽셀-단위 정렬)
          // 2) wantsTransparent: chroma-key → alpha 0 변환
          const genId: string | undefined = mcpResult?.structuredContent?.generationId;
          let stats: Awaited<ReturnType<typeof detectFill>> | null = null;
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
                // cellW*cellH 를 enclosed-포켓 키아웃 임계 기준으로 전달(다리 사이 포켓 흡수).
                await chromaKeyFile(filePath, chromaKeyColor, log, cellW * cellH);
                log(`make_spritesheet chroma-keyed gen=${genId} key=${chromaKeyColor}`);
              }
              // 빈 셀 감지 — 방향 시트만(비방향은 항상 1회 채택이라 측정 불필요).
              if (retryEnabled) {
                stats = await detectFill(filePath, rows, cols, log);
              }
            } catch (e) {
              log(`make_spritesheet post-process fail: ${(e as Error).message}`);
            }
          }

          // best 선택: filledCells 가 더 크면 교체(이전 best 정리), 아니면 이번 결과 정리.
          // 비방향(stats=null)은 첫 결과를 그대로 best 로(MAX_RETRIES=0 이라 루프 1회).
          const filled = stats ? stats.filledCells : Number.MAX_SAFE_INTEGER;
          if (filled > bestFilled) {
            if (best) cleanupResult(best);
            best = mcpResult;
            bestFilled = filled;
            lastStats = stats;
          } else {
            cleanupResult(mcpResult);
          }

          if (!stats || stats.complete) break;
          log(
            `make_spritesheet attempt ${attempt + 1}/${MAX_RETRIES + 1}: ` +
              `${stats.filledCells}/${stats.expected} cells — ${stats.complete ? "complete" : "retrying"}`,
          );
        }

        // ── 후처리 2단계: best 에만 normalize 적용 → 최종 반환 ──
        const finalGenId: string | undefined = best?.structuredContent?.generationId;
        if (finalGenId) {
          const filePath = imagePathFor(finalGenId);
          try {
            // 셀 정규화: 연결 컴포넌트를 픽셀이 가장 많은 셀에 재배치 + 시트-전역 단일
            // scale-to-fit + 앵커 전략별 정렬. 셀 경계 이탈·잔재를 후처리로 흡수한다.
            await normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, {
              anchorStrategy,
              subjectType,
              log,
            });
            log(`make_spritesheet normalized gen=${finalGenId} (${rows}x${cols}) anchor=${resolvedAnchor}`);

            // 보행 사이클 프레임 재배열 — Claude Vision 으로 자연스러운 순서 추론.
            // 단일 방향 보행 캐릭터 시트(directions 없음 또는 1)에서만. 방향 시트(directions≥2)는
            // 각 행이 독립 방향이라 전체 재배열이 무의미하므로 스킵. 에러는 non-fatal(원본 유지).
            if (isWalk && isCharacter && (!directions || directions === 1)) {
              try {
                await reorderSpritesheetFrames(filePath, rows, cols, log);
              } catch (e) {
                log(`make_spritesheet reorder failed (non-fatal): ${(e as Error).message}`);
              }
            }

            // 업스케일: 384px/셀 → 512px/셀 (×4/3). codex 네이티브 안에서 생성한 뒤
            // sharp lanczos3 로 최종 출력 해상도를 확보.
            const upW = cols * FINAL_CELL_PX;
            const upH = rows * FINAL_CELL_PX;
            const upTmp = `${filePath}.up.tmp`;
            await sharp(filePath)
              .resize(upW, upH, { kernel: "lanczos3", fit: "fill" })
              .png()
              .toFile(upTmp);
            fs.renameSync(upTmp, filePath);
            // DB width/height 동기화 — runImageTool 이 기록한 생성 시점 크기를 업스케일 후 값으로 갱신.
            setGenerationDimensions(finalGenId, upW, upH);
            log(`make_spritesheet upscaled gen=${finalGenId} to ${upW}x${upH}`);
          } catch (e) {
            log(`make_spritesheet post-process fail: ${(e as Error).message}`);
          }
          // 미완으로 재시도 소진 시 경고(몇/몇 셀) — 무한루프·과금폭주 금지, best 로 진행.
          if (retryEnabled && lastStats && !lastStats.complete) {
            log(
              `make_spritesheet WARNING: ${MAX_RETRIES + 1} attempts exhausted, ` +
                `best fill ${lastStats.filledCells}/${lastStats.expected} cells (incomplete) — proceeding with best`,
            );
          }
        }

        // structuredContent: elapsedMs 누적값 + 업스케일 후 실제 치수로 갱신.
        if (best?.structuredContent) {
          best.structuredContent.elapsedMs = cumulativeMs;
          best.structuredContent.width = cols * FINAL_CELL_PX;
          best.structuredContent.height = rows * FINAL_CELL_PX;
        }
        return best!;
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

      case "reskin_image": {
        const inputId = requireString(args.inputGenerationId, "inputGenerationId");
        const inputGen = getGeneration(inputId);
        if (!inputGen) throw new Error(`generation not found: ${inputId}`);
        const inputPath = path.join(DATA_DIR, inputGen.image_path);

        const paletteOnly = args.paletteOnly === true;
        const styleRefId =
          typeof args.styleReferenceId === "string" && args.styleReferenceId
            ? args.styleReferenceId
            : null;
        const prompt = typeof args.prompt === "string" ? args.prompt : "";

        // 모드 결정: c(참조) > b(팔레트) > a(외형). c·b 외엔 prompt 가 사실상 필수.
        let styleRefPath: string | undefined;
        const inputGenerationIds = [inputId];
        let overrideInputPaths: string[] | undefined;
        if (styleRefId) {
          const styleGen = getGeneration(styleRefId);
          if (!styleGen) throw new Error(`style reference generation not found: ${styleRefId}`);
          styleRefPath = path.join(DATA_DIR, styleGen.image_path);
          // Codex 입력 순서: [base, styleRef] (codex-exec 의 reskin 분기와 일치).
          overrideInputPaths = [inputPath, styleRefPath];
          inputGenerationIds.push(styleRefId);
        }
        if (!styleRefId && !prompt) {
          throw new Error("reskin_image requires either a prompt or a styleReferenceId");
        }

        const isSheet = inputGen.kind === "spritesheet";
        // 시트면 입력 배경 상속(투명 여부) — 후처리 chroma-key/정렬에 사용.
        const wantsTransparent = isSheet ? await detectTransparentBg(inputPath) : false;

        // reskin 은 입력 시트 치수를 보존하므로 부모의 sprite 그리드 메타를 그대로 상속해
        // 영속한다(SpriteCanvas source-of-truth · 아틀라스 export). 구버전 시트는 값이
        // undefined → JSON.stringify 시 빠져 GCD 폴백(회귀 없음).
        const parentSheet =
          isSheet && inputGen.params && typeof inputGen.params === "object"
            ? (inputGen.params as Record<string, unknown>)
            : null;
        const inheritedSheetParams = parentSheet
          ? {
              subjectType: parentSheet.subjectType,
              anchorStrategy: parentSheet.anchorStrategy,
              anchor: parentSheet.anchor,
              directions: parentSheet.directions,
              rows: parentSheet.rows,
              cols: parentSheet.cols,
              cellW: parentSheet.cellW,
              cellH: parentSheet.cellH,
              fps: parentSheet.fps,
            }
          : {};

        const mcpResult = await runImageTool({
          name,
          kind: "reskin",
          // 시트를 리스킨한 결과는 그 자체가 시트 → 'spritesheet' 로 저장해야 재-리스킨·
          // 스프라이트 도구가 시트로 인식한다. 단일 입력은 'reskin' 유지. (codex 프롬프트는
          // 위 kind='reskin' 으로 선택되므로 영향 없음.)
          storeKind: isSheet ? "spritesheet" : "reskin",
          prompt,
          inputGenerationIds,
          overrideInputPaths,
          styleRefPath,
          paletteOnly,
          params: {
            ...inheritedSheetParams,
            mode: styleRefId ? "style_ref" : paletteOnly ? "palette" : "appearance",
            styleReferenceId: styleRefId,
            spritesheet: isSheet,
          },
          sessionId,
        });

        // 스프라이트시트 입력이면 후처리: resize → chroma-key → normalizeSpritesheetCells.
        // grid 는 결과 치수에서 detectSpriteGrid 로 역산. 감지 실패 시 단일처럼 폴백(스킵).
        if (isSheet) {
          const genId: string | undefined = mcpResult?.structuredContent?.generationId;
          if (genId) {
            const filePath = imagePathFor(genId);
            try {
              const meta = await sharp(filePath).metadata();
              const grid = detectSpriteGrid(meta.width ?? 0, meta.height ?? 0);
              if (!grid) {
                log(`reskin_image: grid detect failed (${meta.width}x${meta.height}), skip sheet post-process`);
              } else {
                const { rows, cols } = grid;
                const cellW = Math.floor((meta.width ?? 0) / cols);
                const cellH = Math.floor((meta.height ?? 0) / rows);
                const canvasW = cols * cellW;
                const canvasH = rows * cellH;
                const resizeTmp = `${filePath}.resize.tmp`;
                await sharp(filePath)
                  .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
                  .png()
                  .toFile(resizeTmp);
                fs.renameSync(resizeTmp, filePath);
                // chroma-key 제거 후 keyedOut=0이면 배경이 green이 아님(black 등).
                // 이 경우 normalizeSpritesheetCells 는 전체를 하나의 content로 인식해
                // scale=0.2 수준으로 축소시키므로 스킵한다.
                let keyedOut = 0;
                if (wantsTransparent) {
                  keyedOut = await chromaKeyFile(filePath, "green", log);
                }
                const parentSubject = inputGen.params?.subjectType;
                const reskinSubject: SubjectType = parentSubject === "effect" ? "effect" : "character";
                if (keyedOut > 0) {
                  await normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, {
                    subjectType: reskinSubject,
                    log,
                  });
                } else if (wantsTransparent) {
                  // reskin 출력에 green 배경 없음(black RGB 등) → 원본 alpha 마스크 적용.
                  // 원본을 결과와 동일 치수(canvasW×canvasH)로 리사이즈해서 읽어야 픽셀
                  // 인덱스가 일치한다(filePath 는 위에서 이미 canvasW×canvasH 로 리사이즈됨).
                  const { data: origData, info: origInfo } = await sharp(inputPath)
                    .resize(canvasW, canvasH, { kernel: "lanczos3", fit: "fill" })
                    .ensureAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                  const { data: reskinData } = await sharp(filePath)
                    .ensureAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                  // 원본 alpha → reskin 에 복사
                  for (let i = 0; i < origInfo.width * origInfo.height; i++) {
                    reskinData[i * 4 + 3] = origData[i * 4 + 3];
                  }
                  const tmpMask = `${filePath}.mask.tmp`;
                  await sharp(Buffer.from(reskinData), {
                    raw: { width: origInfo.width, height: origInfo.height, channels: 4 },
                  })
                    .png()
                    .toFile(tmpMask);
                  fs.renameSync(tmpMask, filePath);
                  log(`reskin_image: applied original alpha mask to reskin result`);
                } else {
                  log(`reskin_image: chroma-key keyedOut=0, skipping normalize (non-green background)`);
                }
                log(`reskin_image sheet post-process gen=${genId} ${cols}x${rows} transparent=${wantsTransparent} subject=${reskinSubject}`);
              }
            } catch (e) {
              log(`reskin_image post-process fail: ${(e as Error).message}`);
            }
          }
        }
        return mcpResult;
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

/**
 * 스프라이트 시트 이미지 크기에서 rows × cols 를 역산 (gcd 기반).
 * make_spritesheet 는 정사각 셀(cellW=cellH=min(512, floor(2048/max(rows,cols)))) 을 쓰므로
 * gcd(width,height) 의 약수 중 64~512 px 범위에서 rows/cols 가 1~16 정수가 되는 셀 크기를 찾는다.
 *
 * NOTE: src/components/editor/SpriteCanvas.tsx 의 detectSpriteGrid 와 동일 로직.
 *       한 쪽을 고치면 다른 쪽도 동기화할 것.
 */
function detectSpriteGrid(
  width: number,
  height: number,
): { rows: number; cols: number } | null {
  if (!width || !height) return null;
  const g = gcd(width, height);
  const divs: number[] = [];
  for (let d = 1; d * d <= g; d++) {
    if (g % d === 0) {
      divs.push(d);
      if (d !== g / d) divs.push(g / d);
    }
  }
  divs.sort((a, b) => b - a);
  for (const d of divs) {
    if (d < 64 || d > 512) continue;
    const c = width / d;
    const r = height / d;
    if (c >= 1 && c <= 16 && r >= 1 && r <= 16 && Number.isInteger(c) && Number.isInteger(r)) {
      return { rows: r, cols: c };
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
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
  sessionId: string | null;
  /** 진행 보고 detail 에 붙일 접두사(예: 재시도 "attempt 2/3"). 사용자가 재시도 중임을 알게. */
  progressPrefix?: string;
}) {
  const { name, kind, storeKind, prompt, inputGenerationIds, extraInputPaths, overrideInputPaths, styleRefPath, paletteOnly, params, sessionId, progressPrefix } = spec;
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
  const job: ImageJob = { id: jobId, generationId, kind, prompt, inputImagePaths, styleRefPath, paletteOnly, params };
  const result = await backend.execute(job, (stage, detail) => {
    const d = progressPrefix ? `[${progressPrefix}]${detail ? " " + detail : ""}` : detail;
    log(`  ${jobId} stage=${stage}${d ? " " + d : ""}`);
    appendProgress(stage, d);
  });

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
  // 긴 변(가로·세로 중 큰 쪽)을 targetSize 로 맞추고 비율 유지 — fit:"inside" + 양변 targetSize.
  // 실제 출력 치수는 sharp 가 반환하는 info 에서 받는다(정사각 아님).
  const info = await sharp(inputPath)
    .resize(spec.targetSize, spec.targetSize, { kernel: "lanczos3", fit: "inside" })
    .png()
    .toFile(destPath);
  const outW = info.width;
  const outH = info.height;
  const elapsedMs = Math.round(performance.now() - startedAt);

  // generations.kind CHECK 제약: text2img|img2img|upscale|remove_bg|inpaint|spritesheet|mask|layer|external.
  // resize 는 'upscale' 의미가 가장 가까워 그대로 재활용 (의미가 약간 늘어남: 원본보다 작아도
  // 같은 kind 로 분류 — kind enum 확장은 별도 마이그레이션 필요).
  const gen = createGeneration({
    id: generationId,
    session_id: spec.sessionId,
    message_id: null,
    kind: "upscale",
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
