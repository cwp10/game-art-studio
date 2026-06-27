/**
 * MCP 도구 핸들러 공용 인프라.
 *
 * server.ts 와 handlers/* 가 함께 쓰는 부수효과 없는 헬퍼만 모은다.
 * (server.ts 는 import 시 ensureDataDirs/server.connect 부수효과가 있으므로
 *  handler 가 server.ts 를 import 하면 순환·부트스트랩 재실행 문제가 생긴다 →
 *  공유 로직은 이 모듈에 둬서 양방향 import 를 끊는다.)
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { claudeRunSimple } from "../../cli/claude-cli.js";
import { selectImageBackend, type ImageJob } from "../../image-backend/index.js";
import {
  chromaKeyFile,
  fallbackBgRemove,
  detectFill,
  normalizeSpritesheetCells,
  type AnchorStrategy,
  type ChromaKeyColor,
  type SubjectType,
} from "../../image-backend/spritesheet-postprocess.js";
import { extractPoseGuideGrid, getCachedPoseRow, getMultiDirPoseGuide, DIR_NAMES, DIR_INDEX, type FrameAngle } from "../../image-backend/pose-reference.js";
import {
  buildDirectionPrompt,
  isLocomotion,
  isRunning,
  type Directions,
} from "../spritesheet-classify.js";
import { createGeneration, getGeneration, deleteGeneration, setGenerationDimensions } from "../../db/repo/generations.js";
import { createJob, updateJob } from "../../db/repo/jobs.js";
import { newGenerationId, newJobId } from "../../util/ids.js";
import {
  DATA_DIR,
  LOGS_DIR,
  imagePath as imagePathFor,
  jobDir as jobDirFor,
  toRelative,
  REFERENCE_DIR,
  TEMPLATES_DIR,
} from "../../util/paths.js";
import type { GenerationKind } from "../../../types/db.js";

// ─── logging ───────────────────────────────────────────────────────────────

const logPath = path.join(LOGS_DIR, "mcp-server.log");
export function log(line: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

/** 새 image job 의 generation/job id 쌍 생성. log·createJob 호출은 각 케이스가 별도 처리. */
export function newImageIds(): { generationId: string; jobId: string } {
  return { generationId: newGenerationId(), jobId: newJobId() };
}

/**
 * generation 행을 조회하고 절대 파일 경로를 함께 반환.
 * 없으면 throw — `const gen = getGeneration(id); if (!gen) throw …; const p = path.join(DATA_DIR, gen.image_path)`
 * 패턴을 대체한다.
 */
export function loadGenerationWithPath(id: string): { gen: ReturnType<typeof getGeneration> & object; filePath: string } {
  const gen = getGeneration(id);
  if (!gen) throw new Error(`generation not found: ${id}`);
  return { gen, filePath: path.join(DATA_DIR, gen.image_path) };
}

// ─── handler 공통 타입 ───────────────────────────────────────────────────────

export type LogFn = (msg: string) => void;

/** 각 케이스 핸들러에 전달되는 호출 컨텍스트. */
export type HandlerContext = { sessionId: string | null; log: LogFn };

/** 핸들러가 실제로 쓰는 extra 필드(abort signal)만 노린 최소 타입. */
export type HandlerExtra = { signal?: AbortSignal };

/** MCP 도구 응답 모양 (runImageTool / 직접 빌드 케이스 공통). */
export type ToolResponse = {
  content: { type: string; text: string }[];
  structuredContent: {
    generationId: string;
    imagePath: string;
    width: number;
    height: number;
    kind?: GenerationKind;
    elapsedMs: number;
  };
};

// ─── post-process helpers ────────────────────────────────────────────────────

/**
 * 투명 배경 후처리: chromaKeyFile → keyedOut=0이면 fallbackBgRemove 로 폴백.
 * generate_image / make_spritesheet / reskin_image 세 경로 공통 시퀀스.
 * cellArea 미지정 시 이미지 전체를 단일 셀로 간주(단일 이미지 경로).
 */
export async function applyTransparentPostProcess(
  filePath: string,
  chromaKey: ChromaKeyColor,
  cellArea?: number,
  aggressivePockets?: boolean,
): Promise<number> {
  const keyedOut = await chromaKeyFile(filePath, chromaKey, log, cellArea, aggressivePockets);
  if (keyedOut === 0) return await fallbackBgRemove(filePath, log);
  return keyedOut;
}

export type SpritePromptInput = {
  userPrompt: string;
  rows: number;
  cols: number;
  cellW: number;
  cellH: number;
  canvasW: number;
  canvasH: number;
  wantsTransparent: boolean;
  chromaKeyColor: ChromaKeyColor;
  seamlessLoop: boolean;
  subjectType: SubjectType;
  resolvedAnchor: Exclude<AnchorStrategy, "auto">;
  directions: Directions | null;
  refPath: string | null;
  gridTemplatePath: string;
  viewpoint?: string; // "side" | "topdown" | "isometric" | "2.5d-topdown", 기본 "side"
  facing?: string | null; // UI 명시 방향 — NL regex 감지보다 우선
  refHandDescription?: string | null; // 참조에서 추출한 "SCREEN-LEFT: X | SCREEN-RIGHT: Y" (화면 좌/우 기준)
};

/**
 * 참조 이미지에서 캐릭터가 든 오브젝트를 화면 좌/우 기준으로 분석해 반환.
 * 해부학적 좌우(거울 반전)는 정면 캐릭터에서 비전 모델이 혼동하므로, 모호함 없는
 * "화면상 위치"로 추출한다 — 생성 모델도 같은 참조를 보므로 좌/우가 1:1로 맞는다.
 * → "SCREEN-LEFT: X | SCREEN-RIGHT: Y" 형식. 분석 실패 시 null (생성은 계속).
 */
export async function analyzeRefHandObjects(refImagePath: string): Promise<string | null> {
  try {
    const result = await claudeRunSimple({
      systemPrompt: `You are analyzing a game character image to identify objects the character holds.
Report by SCREEN POSITION (which half of the image the object is on), NOT the character's anatomy.
Output ONLY a single line in this exact format (no extra text):
SCREEN-LEFT: <object> | SCREEN-RIGHT: <object>
Rules:
- SCREEN-LEFT = the object on the LEFT half of the image; SCREEN-RIGHT = the object on the RIGHT half.
- Be concise: 2-5 words per object (e.g. "flaming torch", "blood-stained war axe", "wooden shield", "empty")
- If a side has no held object, write "empty"
- Describe the OBJECT itself, not the action`,
      userMessage: `What does the character hold on each side of the image? Image path: ${refImagePath}`,
      allowedTools: ["Read"],
    });
    const line = result.trim().split("\n").find(l => l.includes("SCREEN-LEFT:") && l.includes("SCREEN-RIGHT:"));
    return line ?? null;
  } catch {
    return null;
  }
}

/**
 * 참조 이미지에서 캐릭터가 바라보는 방향을 분석 → FRONT/BACK/LEFT/RIGHT, 실패 시 null.
 * 정면 참조에 측면(facing RIGHT) 요청 같은 모순을, 핸들러가 참조 방향에 맞춰 정렬하는 데 사용.
 * (정면 참조는 모델의 강한 시각 앵커라 텍스트 측면 지시를 덮어쓰므로, 요청 facing 을 참조에 맞춘다.)
 */
export async function analyzeRefFacing(
  refImagePath: string,
): Promise<"FRONT" | "BACK" | "LEFT" | "RIGHT" | null> {
  try {
    const result = await claudeRunSimple({
      systemPrompt: `You determine which way a game character faces.
Output ONLY one word: FRONT, BACK, LEFT, or RIGHT.
- FRONT = faces the viewer (face and chest visible from the front)
- BACK = faces away (you see the back of the head/body)
- LEFT = pure side profile, facing screen-left
- RIGHT = pure side profile, facing screen-right
For a 3/4 view, pick the dominant component (mostly-front → FRONT, mostly-back → BACK).`,
      userMessage: `Which way does the character face? Image path: ${refImagePath}`,
      allowedTools: ["Read"],
    });
    const m = result.toUpperCase().match(/\b(FRONT|BACK|LEFT|RIGHT)\b/);
    return (m?.[1] as "FRONT" | "BACK" | "LEFT" | "RIGHT") ?? null;
  } catch {
    return null;
  }
}

/** 카메라 시점 규칙. side(기본)는 빈 문자열 — 모델 기본값 유지. */
function buildViewpointRule(viewpoint: string): string {
  if (viewpoint === "topdown") {
    return `CRITICAL CAMERA ANGLE — TOP-DOWN BIRD'S-EYE VIEW: The camera looks straight down from directly overhead. ` +
      `Render as seen from above: tops of heads/objects are visible, sides and feet are mostly hidden under the body. ` +
      `NO side-scroll perspective. The subject silhouette reads as if projected onto a horizontal ground plane. `;
  }
  if (viewpoint === "isometric") {
    return `CRITICAL CAMERA ANGLE — ISOMETRIC VIEW: Render in classic isometric projection (~45° diagonal, elevated viewpoint). ` +
      `Horizontal lines run diagonally. The scene has depth with both the top surface and one or two side faces of objects visible. ` +
      `Use the fixed isometric 2:1 angle standard in RPG/strategy games. NO straight side-scroll. `;
  }
  if (viewpoint === "2.5d-topdown") {
    return `CRITICAL CAMERA ANGLE — 2.5D TOP-DOWN PERSPECTIVE: Camera is elevated ~60-70° above horizontal, slightly behind and above the subject. ` +
      `Shows top-of-head and back of shoulders; ground/floor plane is prominent. ` +
      `Common in ARPG and MOBA games. NOT a straight side view, NOT fully overhead. `;
  }
  return "";
}

/**
 * make_spritesheet Codex 프롬프트 조립.
 * 포즈 가이드 로딩(async) + 모든 rule 문자열 조합 → { decorated, overrideInputPaths }.
 * 순수 문자열 조립 및 파일 읽기만 수행 — DB·이미지 생성 없음.
 */
export async function buildSpritePrompt(
  p: SpritePromptInput,
): Promise<{ decorated: string; overrideInputPaths: string[] }> {
  const { userPrompt, rows, cols, cellW, cellH, canvasW, canvasH,
    wantsTransparent, chromaKeyColor, seamlessLoop,
    subjectType, resolvedAnchor, directions, refPath, gridTemplatePath, viewpoint, facing,
    refHandDescription } = p;
  const normalizedViewpoint = viewpoint ?? "side";

  const isCharacter = subjectType === "character";
  const isObject = subjectType === "object";
  const isWalk = isLocomotion(userPrompt);
  const isRun = isRunning(userPrompt);
  const isSingleDirection = !directions || directions === 1;
  const cx = Math.round(cellW / 2);
  const cy = Math.round(cellH / 2);

  // UI에서 명시한 facing 이 있으면 NL 파싱 없이 직접 사용 (오케스트레이터 방향 오해 방지)
  function detectWalkDirFromNL(): string {
    if (/facing left|face left|to the left|왼쪽|left[\s-]facing/i.test(userPrompt)) return "LEFT";
    if (/facing right|face right|to the right|오른쪽|right[\s-]facing/i.test(userPrompt)) return "RIGHT";
    if (/facing down-left/i.test(userPrompt)) return "DOWN-LEFT";
    if (/facing down-right/i.test(userPrompt)) return "DOWN-RIGHT";
    if (/facing up-left/i.test(userPrompt)) return "UP-LEFT";
    if (/facing up-right/i.test(userPrompt)) return "UP-RIGHT";
    if (/facing down(?!-)|face down|front.?view|정면/i.test(userPrompt)) return "DOWN";
    if (/facing up(?!-)|face up|back.?view|후면/i.test(userPrompt)) return "UP";
    return "RIGHT";
  }
  const parsedWalkDir = isSingleDirection ? (facing || detectWalkDirFromNL()) : null;
  // side walk gait rules(toe direction)은 LEFT/RIGHT에만 적용
  const singleDirWalkDir = (parsedWalkDir === "LEFT" || parsedWalkDir === "RIGHT") ? parsedWalkDir : null;

  // ── 배경·루프 지시 ──────────────────────────────────────────────────────
  const bgInstruction = wantsTransparent
    ? chromaKeyColor === "magenta"
      ? "CRITICAL background: Use a SOLID FLAT pure magenta (#ff00ff) chroma-key background filling every pixel that is NOT the subject — no gradients, no shadows, no anti-aliasing fringe, crisp subject silhouette. The post-processing pipeline will key out the magenta to produce true transparency."
      : "CRITICAL background: Use a SOLID FLAT pure green (#00ff00) chroma-key background filling every pixel that is NOT the subject — no gradients, no shadows, no anti-aliasing fringe, crisp subject silhouette. The post-processing pipeline will key out the green to produce true transparency."
    : "White background.";

  const loopInstruction = seamlessLoop
    ? `INFINITE LOOP (CRITICAL): Frames play [1→2→…→N→1→2…] forever — Frame N leads directly back into Frame 1. ` +
      `Design a CLOSED CYCLE: Walk/run — Frame N flows into Frame 1's pose. Idle — Frame N is mid-motion flowing into Frame 1. Attack — Frame N is the final recovery moment returning toward Frame 1's ready stance. ` +
      `NEVER design a linear arc (wind-up → peak → stop). ALWAYS a seamless cycle. `
    : "";

  // ── 앵커·콘텐츠 규칙 ────────────────────────────────────────────────────
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
          : isObject
          ? `center the object so its visual center sits exactly at the cell center X=${cx}, Y=${cy} in EVERY cell. ` +
            `Keep the object at a CONSISTENT scale across all frames — only the animated aspect (rotation angle, deformation, etc.) changes between frames. ` +
            `The object's complete bounding box must be vertically and horizontally centered; do NOT rest it on the bottom edge or use any ground line. `
          : `this is a visual effect / VFX, NOT a grounded character. ` +
            `Place the effect so its OWN visual center sits exactly at the cell center X=${cx}, Y=${cy} in EVERY cell. ` +
            `The effect's COMPLETE bounding box — INCLUDING any trailing tail, motion streak, after-image, sparks, and particles — must be vertically centered: ` +
            `the topmost and bottommost drawn pixels must be EQUIDISTANT from the cell's top and bottom edges (equal empty rows above and below the whole shape). ` +
            `The trailing tail must NOT reach or touch the bottom edge. ` +
            `Do NOT rest it on the bottom edge, do NOT use any ground line, floor, or shadow plane — the effect floats centered and radiates symmetrically in all directions. `;
    }
  })();
  const anchorRule = `(5) ${isCharacter ? "CHARACTER" : isObject ? "OBJECT" : "EFFECT"} ANCHOR — ${placementRule}`;

  const containedContent = isCharacter
    ? "the character's body, weapon, and any flowing cape or robe"
    : isObject
    ? "the complete object, including its texture, decorations, materials, and any intrinsic glow or inset effects"
    : "the subject and ALL of its effects, trails, particles, projectiles, beams, weapons, auras, and flowing capes/robes";
  const oversizeContent = isCharacter
    ? "especially a large pose or a wide weapon swing"
    : isObject
    ? "especially the object at an extreme angle or with a wide decorative extension"
    : "especially a sweeping effect like a slash, blast, beam, or trail";

  const effectGuard = isCharacter
    ? `Render the character's body and its INTRINSIC design only. ` +
      `Do NOT add action or ability visual effects: NO attack slash trails, ` +
      `NO spell or magic particles, NO projectiles, NO emitted auras around the body, ` +
      `NO motion lines, NO impact flashes, NO smoke, NO sparkles, NO extra decorative VFX. ` +
      `The character's OWN intrinsic material is fine (e.g. a robot's status lights or ` +
      `glowing core, a fire creature's flame body, a weapon that glows as part of its ` +
      `resting design). Any action or ability effect belongs on a SEPARATE effect sprite sheet. `
    : "";

  const directionPrompt = isCharacter && directions ? buildDirectionPrompt(directions, cols) : "";
  const rowCountRule = isCharacter && directions
    ? `The sheet MUST have EXACTLY ${rows} horizontal rows of cells (one row per direction), filled from top to bottom. ` +
      `Draw all ${rows} rows — do NOT compress, merge, or omit rows, do NOT leave any row empty, and keep EQUAL vertical spacing between the ${rows} rows. `
    : "";
  const colCountRule = isCharacter && directions
    ? `Each row MUST contain EXACTLY ${cols} frames placed left to right, filling every column. ` +
      `Draw all ${cols} frames in every row — do NOT compress, merge, or omit frames, do NOT leave any column empty, and keep EQUAL horizontal spacing between the ${cols} frames. `
    : "";
  const equipmentRule = isCharacter
    ? `OBJECT VISIBILITY: Every held, carried, or worn object MUST be fully visible in EVERY frame — never hidden, shrunk, or omitted, even mid-swing or when the limb faces away. ` +
      `BACK-MOUNTED ACCESSORIES (bow, quiver, cape, shield, backpack, wings, scabbard): MUST protrude from the back in every frame — never absorbed into the body outline in side, rear, or 3/4 poses. ` +
      `ARM-MOUNTED ITEMS (shield, buckler, bracer): MUST remain visible even when that arm swings backward — never fully covered by the body silhouette. ` +
      (() => {
        if (refHandDescription) {
          // 화면 좌/우 기준 — 요청 facing 은 참조 방향에 정렬돼 있으므로(handler 방안 A),
          // 참조의 좌/우 위치가 생성 시트에도 그대로 보존된다. 해부학 좌우 단정은 피해 반전 버그 차단.
          const sl = refHandDescription.match(/SCREEN-LEFT:\s*([^|]+)/i)?.[1]?.trim() ?? "";
          const sr = refHandDescription.match(/SCREEN-RIGHT:\s*([^|]+)/i)?.[1]?.trim() ?? "";
          const parts: string[] = [];
          if (sl && sl.toLowerCase() !== "empty") parts.push(`the arm on the LEFT side holds "${sl}"`);
          if (sr && sr.toLowerCase() !== "empty") parts.push(`the arm on the RIGHT side holds "${sr}"`);
          if (parts.length > 0) {
            return `PERMANENT ARM ASSIGNMENT (non-negotiable, matched to the reference image): in the reference, ${parts.join("; ")} ` +
              `(LEFT side / RIGHT side = which half of the image, same orientation as the reference). ` +
              `Each object is LOCKED to that same arm and that same side of the body for the ENTIRE animation — it NEVER crosses to the other arm or the other side at any frame. ` +
              `When the torso twists or the arm swings behind the body, the object MOVES WITH ITS ARM and stays visible on its side. ` +
              `Any cross-over swap is a CRITICAL ERROR — verify against the reference image. `;
          }
        }
        if (refPath) {
          return `REFERENCE ARM LOCK: Every held object in the reference MUST stay in the SAME arm in ALL frames — no swaps at any point. `;
        }
        return `ARM CONSISTENCY: Whichever arm holds each object in frame 1 holds it in ALL frames — arm swaps are a CRITICAL ERROR. `;
      })()
    : "";

  // ── 포즈 가이드 로딩 (걷기 캐릭터) ─────────────────────────────────────
  // 셀 하나의 각도 텍스트. foreAft(정면/후면)면 깊이 문구, 측면/대각선이면 L/R 각도.
  // (DOWN/UP은 leftDeg/rightDeg=0이지만 foreAft가 설정돼 각도 대신 전후 깊이 텍스트로 표시 → "L+0°/R+0°" 미출력.)
  const fmtCell = (a: FrameAngle) =>
    a.foreAft
      ? `${a.foreAft}(${a.label})`
      : `L${a.leftDeg >= 0 ? "+" : ""}${a.leftDeg}°/R${a.rightDeg >= 0 ? "+" : ""}${a.rightDeg}°(${a.label})`;

  let poseRefPath: string | null = null;
  let poseFrameAnglesText = "";
  // 단일방향 평탄 각도 배열 — buildFrameNarrative(per-frame 서술)용으로 try 블록 밖에 노출.
  let poseFrameAngles: FrameAngle[] | null = null;
  if (isWalk && isCharacter && isSingleDirection) {
    // DIR_INDEX(full 방향명→dirIndex)는 pose-reference.ts DIRECTIONS_8에서 파생 — 순서 단일 소스.
    const dirIndex = DIR_INDEX[parsedWalkDir ?? "RIGHT"] ?? 6;
    // 단일방향: 평탄 배열을 rows에 따라 셀 위치 라벨링.
    const toAngleText = (angles: FrameAngle[], r: number) =>
      angles
        .map((a, i) =>
          (r > 1 ? `row${Math.floor(i / cols) + 1}col${(i % cols) + 1}` : `col${a.col + 1}`) +
          `: ${fmtCell(a)}`,
        )
        .join(", ");
    try {
      const { path: guidePath, angles } = await extractPoseGuideGrid(
        dirIndex, cols, rows, cellW, REFERENCE_DIR, TEMPLATES_DIR, isRun,
      );
      poseRefPath = guidePath;
      poseFrameAnglesText = toAngleText(angles, rows);
      poseFrameAngles = angles;
      log(`make_spritesheet: pose guide → ${path.basename(guidePath)}`);
    } catch (e) {
      log(`make_spritesheet: pose guide reference unavailable (${(e as Error).message}), falling back to SVG`);
      try {
        const { path: guidePath, angles } = await getCachedPoseRow(dirIndex, cols, cellW, TEMPLATES_DIR, isRun);
        poseRefPath = guidePath;
        poseFrameAnglesText = toAngleText(angles, 1);
        poseFrameAngles = angles;
        log(`make_spritesheet: pose guide (SVG fallback) → ${path.basename(guidePath)}`);
      } catch (e2) {
        log(`make_spritesheet: pose guide failed (non-fatal): ${(e2 as Error).message}`);
      }
    }
  } else if (isWalk && isCharacter && !isSingleDirection && directions) {
    // T3: 다중방향(2/4/8) 가이드. dirIndices는 directionLabels(n) 순서와 1:1 대응.
    //   2 → [LEFT, RIGHT] / 4 → [DOWN, LEFT, RIGHT, UP] / 8 → [DOWN..DN-RIGHT].
    const dirIndices: number[] =
      directions === 2 ? [2, 6]
      : directions === 4 ? [0, 2, 6, 4]
      // directions===8 → 8행×384px=3072px가 캔버스 한계(1536px)를 넘어 상류 검증(~488줄)에서
      // 이미 throw → 이 분기는 도달 불가. 향후 8방향 분할 생성(4×2) 대비 매핑만 보존.
      : [0, 1, 2, 3, 4, 5, 6, 7];
    try {
      const { path: guidePath, rows: guideRows } = await getMultiDirPoseGuide(
        dirIndices, cols, cellW, TEMPLATES_DIR, isRun,
      );
      poseRefPath = guidePath;
      // 구조화된 행(행=방향)을 방향명 포함 라벨로 직렬화. row.dirIndex로 이름 조회(행 위치 아님).
      poseFrameAnglesText = guideRows
        .map((row, r) =>
          row.angles
            .map((a, c) => `row${r + 1}(${DIR_NAMES[row.dirIndex]}) col${c + 1}: ${fmtCell(a)}`)
            .join(", "),
        )
        .join("; ");
      log(`make_spritesheet: multidir pose guide → ${path.basename(guidePath)}`);
    } catch (e) {
      log(`make_spritesheet: multidir pose guide failed (non-fatal): ${(e as Error).message}`);
    }
  }

  // buildFrameNarrative: 각 프레임을 사람이 읽기 쉬운 narrative로 변환.
  // foreAft(정면/후면)는 발 높이차로, 측면/대각선은 L/R 스윙각과 stride 위상으로 서술.
  const buildFrameNarrative = (frameAngles: FrameAngle[], numRows: number, numCols: number): string => {
    const descs = frameAngles.map((a, i) => {
      const pos = numRows > 1
        ? `row${Math.floor(i / numCols) + 1}col${(i % numCols) + 1}`
        : `col${i + 1}`;
      if (a.foreAft) {
        const isContact = a.label.includes("CONTACT");
        const hint = isContact ? "(≥15% cell height apart)" : "(slightly different heights)";
        return `${pos}[${a.label}]: ${a.foreAft} ${hint}`;
      }
      const lA = a.leftDeg;
      const rA = a.rightDeg;
      const phase = Math.abs(lA) >= 15 ? "MAX STRIDE" : Math.abs(lA) <= 5 ? "CROSSOVER" : "mid-stride";
      return `${pos}[${a.label}/${phase}]: L=${lA >= 0 ? "+" : ""}${lA}°(${lA > 5 ? "FWD" : lA < -5 ? "BACK" : "~0"}), R=${rA >= 0 ? "+" : ""}${rA}°(${rA > 5 ? "FWD" : rA < -5 ? "BACK" : "~0"})`;
    });
    return `MANDATORY FRAME SEQUENCE: ${descs.join("; ")}. `;
  };

  // ── 보행 사이클 규칙 ────────────────────────────────────────────────────
  const walkCycleRule = isWalk && isCharacter
    ? `ANIMATION VARIETY (CRITICAL): Each of the ${cols * rows} frames shows a visually distinct pose — legs advance continuously through the gait cycle. Avoid frames that look identical or near-identical to any other frame. Avoid repeating the same pose across multiple cells. ` +
      `WALK CYCLE GAIT (CRITICAL, NON-NEGOTIABLE): ` +
      `This is a WALKING/RUNNING animation. You MUST depict the complete, natural gait cycle including EVERY phase: ` +
      `(1) CONTACT — left leg fully forward, right leg fully back; ` +
      `(2) CROSSOVER/MID-STANCE — both legs passing each other (legs close together, weight centered); ` +
      `(3) CONTACT — right leg fully forward, left leg fully back; ` +
      `(4) CROSSOVER/MID-STANCE — both legs passing each other again. ` +
      `This 4-phase pattern covers exactly ONE complete gait cycle. All ${cols * rows} frames span exactly one cycle — subdivide each phase finely when there are more frames. ` +
      `Crossover frames (legs close/passing) are required — they produce natural, smooth motion. ` +
      `Avoid a cycle where legs stay extended in the same direction for multiple consecutive frames with no crossover. ` +
      `LEG VISIBILITY (CRITICAL): In every frame, both legs are clearly visible and spatially separated — the gap between them is obvious. For side views: one leg is visibly in FRONT of the other with clear fore/aft depth. For front/back views: one foot is clearly further forward (lower in frame) while the other is back (higher). Show knee and ankle joints at visibly different positions between the two legs. Avoid overlapping or merging the two legs into a single shape in any frame. ` +
      (parsedWalkDir && !singleDirWalkDir
        ? `WALKING DIRECTION (CRITICAL): The character walks toward screen-${parsedWalkDir}. ` +
          `The character faces screen-${parsedWalkDir} in every frame. Avoid reversing or mirroring the facing direction. ` +
          (poseRefPath ? `Use the FACING CUE nub in the pose guide to confirm the correct facing. ` : "")
        : "") +
      (singleDirWalkDir
        ? `FOOT/TOE DIRECTION (CRITICAL): The character walks toward screen-${singleDirWalkDir}. ` +
          `Both feet and toes point toward screen-${singleDirWalkDir} in every frame. ` +
          `In stride/contact frames both legs extend — one forward, one backward. ` +
          `Avoid showing only one leg extending. Avoid feet or toes pointing opposite to the walking direction. ` +
          `STRIDE DEPTH (CRITICAL): The forward/leading leg is always drawn IN FRONT OF the trailing leg — the leading boot visibly overlaps the back boot. ` +
          `STRIDE ALTERNATION (CRITICAL): The two contact phases MUST be visually distinct — ` +
          `one contact frame has the LEFT boot as the leading (front) boot; the other contact frame has the RIGHT boot as the leading (front) boot. ` +
          `Both boots take turns being the leading boot. Avoid showing the same boot in front in every contact frame. ` +
          `LEG ANGLES (CRITICAL, NON-NEGOTIABLE): ` +
          `The LEFT leg and the RIGHT leg have DIFFERENT angles in every single frame. ` +
          `CONTACT frames: LEFT and RIGHT legs are at OPPOSITE angles — when LEFT is forward (+angle), RIGHT is back (−angle) at equal magnitude, and vice versa. ` +
          `Typical contact stride: one leg at approximately +25° to +35°, the other at −25° to −35°. ` +
          `MID-STANCE/CROSSOVER frames: both legs near vertical (0°) but still at slightly different positions — e.g. LEFT at +5°, RIGHT at −5° — they are crossing. ` +
          `Avoid identical leg angles in any frame. Avoid symmetric leg poses — matched angles indicate a static T-pose, not a walk cycle. ` +
          `CROSSING DEPTH SWAP (CRITICAL): In every crossover/mid-stance frame, the leg that was in the foreground during the previous contact moves visibly to the background as the opposite leg comes forward — the fore/aft depth order swaps at every cross. Avoid crossing frames where the legs only close together without changing which is in front. Avoid keeping the same leg in the foreground before and after the crossover. Avoid merged or fused legs during the passing phase — both legs remain individually visible with clear spatial separation throughout the cross. `
        : parsedWalkDir === "DOWN" || parsedWalkDir === "UP"
        ? `FRONT/BACK LEG DEPTH RULE (CRITICAL): For this front/back-facing walk, leg separation is shown as DEPTH, not side-to-side angles. ` +
          `CONTACT frames: ONE foot is drawn LOWER in the frame (stepped forward toward the camera) and the OTHER foot is drawn HIGHER (pulled back away from the camera). ` +
          `The vertical gap between the two feet must be OBVIOUS — at least 15% of the cell height. ` +
          `CROSSOVER frames: both feet near the same height but at slightly different vertical positions. In every frame, the two feet are at different heights. Avoid placing both feet at exactly the same vertical position — that indicates a T-pose, not a walk. `
        : parsedWalkDir
        ? `LEG ANGLES (CRITICAL, NON-NEGOTIABLE): ` +
          `The LEFT leg and the RIGHT leg have DIFFERENT angles in every single frame. ` +
          `CONTACT frames: LEFT and RIGHT legs are at OPPOSITE angles — when LEFT is forward (+angle), RIGHT is back (−angle), and vice versa. ` +
          `Typical contact stride: one leg ~+20° to +32°, the other ~−20° to −32°. ` +
          `CROSSOVER frames: both legs near 0° but still slightly different — e.g. LEFT +5°, RIGHT −5°. ` +
          `Avoid identical leg angles in any frame. Avoid symmetric poses — they indicate a static T-pose, not a walk cycle. `
        : "") +
      (rows > 1 && parsedWalkDir
        ? `MULTI-ROW CONTINUITY (CRITICAL): In a ${cols}×${rows} grid, each row continues the animation from the previous row. ` +
          `The leading foot at the start of each row alternates — opposite to the previous row's starting foot. ` +
          `row1col1 = L-CONTACT (left foot forward); row2col1 = R-CONTACT (right foot forward)` +
          (rows > 2 ? `; row3col1 = L-CONTACT again` : "") +
          `. Every row is visually distinct from every other row. Avoid copying or repeating poses from one row to another. ` +
          `Row 2 continues directly from where row 1 ended — row2col1 shows the RIGHT foot as the leading/forward foot. Avoid treating row 2 as a new or restarted animation cycle. Avoid drawing row2col1 with the left foot forward. Avoid repeating the same opening pose from row1col1 in row2col1. `
        : "")
    : "";

  // ── 액션 애니메이션 규칙 (걷기/달리기 외 캐릭터 동작) ──────────────────────
  const actionPhaseDesc = (() => {
    if (cols === 2)
      return `Column 1 = wind-up (body weight BACK, weapon/limb drawn back, knees bent under tension). ` +
             `Column 2 = strike/release (body FULLY EXTENDED FORWARD, weapon/limb at maximum reach, weight on front foot). `;
    if (cols === 3)
      return `Column 1 = anticipation (body weight BACK, weapon raised/drawn back, torso coiled). ` +
             `Column 2 = strike apex (body LUNGED FULLY FORWARD, weapon at maximum extension, weight entirely on front foot, torso tilted into the blow). ` +
             `Column 3 = recovery/follow-through (weapon past peak, body decelerating, weight rebalancing toward neutral). `;
    if (cols === 4)
      return `Column 1 = ready/neutral stance. ` +
             `Column 2 = wind-up (body coiling back, weapon drawn). ` +
             `Column 3 = strike apex (body fully lunged, weapon extended). ` +
             `Column 4 = recovery (returning to neutral). `;
    return `Spread the full action arc evenly across all ${cols} columns: start neutral → build anticipation → reach peak exertion → recover to neutral. `;
  })();

  const actionAnimRule = !isWalk && isCharacter && cols >= 2
    ? `ACTION ANIMATION — DISTINCT POSES REQUIRED (CRITICAL): This is an action animation, NOT a static image. ` +
      `Each of the ${cols * rows} frames MUST show a dramatically different body pose. ` +
      `If any two frames look similar or identical, those frames are WRONG. ` +
      (rows === 1 ? actionPhaseDesc : "") +
      `The body pose change between consecutive frames MUST be OBVIOUS and EXAGGERATED — ` +
      `subtle head tilts or minor arm shifts are NOT enough. Show full-body commitment to each phase. ` +
      `All ${cols * rows} frames cover EXACTLY ONE complete action cycle from start to finish — not a partial action, not two repetitions. `
    : "";

  // ── 액션 다행 연속성 규칙 ─────────────────────────────────────────────
  // 다행 공격 애니메이션: 모델이 각 행을 독립 사이클로 취급하는 것을 방지.
  // walkCycleRule 의 MULTI-ROW CONTINUITY 와 동일 개념 — 공격 전용.
  const actionMultiRowRule = (() => {
    if (isWalk || !isCharacter || cols < 2 || rows <= 1) return "";
    const total = cols * rows;
    const getPhase = (idx: number): string => {
      const t = (idx - 1) / (total - 1);
      if (idx === 1) return "neutral/ready";
      if (t < 0.25) return "anticipation";
      if (t < 0.5) return "wind-up (peak tension)";
      if (t < 0.65) return "STRIKE APEX (max extension)";
      if (t < 0.82) return "follow-through";
      return "recovery";
    };
    const rowDescs = Array.from({ length: rows }, (_, r) => {
      const phases = Array.from({ length: cols }, (_, c) => {
        const frameNum = r * cols + c + 1;
        return `col${c + 1}=frame${frameNum}[${getPhase(frameNum)}]`;
      }).join(", ");
      return `Row ${r + 1}: ${phases}`;
    }).join("; ");
    return `ACTION CYCLE — ROW CONTINUITY (CRITICAL): All ${total} frames read left→right then top→bottom form ONE unbroken action cycle — NOT ${rows} separate cycles. ` +
      `Row 2 starts exactly where Row 1 left off — it is NOT a reset or a new cycle. ` +
      `PER-FRAME PHASE MAP: ${rowDescs}. ` +
      `Every row MUST look completely different from every other row — identical row poses are a CRITICAL ERROR. `;
  })();

  const poseRefInstruction = poseRefPath
    ? `POSE GUIDE (first attached image): The first attached image is the grid template with stick-figure skeletons already drawn inside each cell. ` +
      `CRITICAL COLOR CODING — Blue skeleton line = LEFT leg (character's own left); Red skeleton line = RIGHT leg (character's own right). ` +
      `FACING CUE — the short nub protruding from the head marks the FACING direction: orient the character to face the way the nub points (this disambiguates left-facing vs right-facing side views). A dark/filled head with no nub = back view (facing away). Do NOT draw the nub itself as a spike or feature — it only indicates which way the character looks. ` +
      `Each skeleton shows the EXACT per-leg angle required for that cell. ` +
      `You MUST render your character OVER these skeletons so that the LEFT leg matches the BLUE angle and the RIGHT leg matches the RED angle — independently and precisely. ` +
      `Do NOT swap left and right legs. Do NOT average or blend the two angles into a single symmetric pose. Do NOT use the same angle for both legs. ` +
      `The skeleton is your binding reference — replace it with the actual character while keeping each leg's angle exactly as shown by its color. ` +
      (poseFrameAnglesText
        ? (poseFrameAngles ? buildFrameNarrative(poseFrameAngles, rows, cols) : "") +
          `EXACT PER-LEG ANGLES PER CELL (${rows > 1 ? `${cols}×${rows} grid, read left→right then top→bottom` : `columns`}): ${poseFrameAnglesText}. ` +
          (rows > 1
            ? `ROW CONTINUITY (CRITICAL): This grid is ONE continuous animation sequence — each row continues from where the previous row ended. ` +
              `The leading foot at the start of each row alternates: row1col1 = L-CONTACT, row2col1 = R-CONTACT` +
              (rows > 2 ? `, row3col1 = L-CONTACT, and so on` : "") +
              `. Every row MUST look visually DISTINCT from every other row — never copy, mirror, or repeat poses across rows. `
            : "") +
          `L = LEFT leg angle, R = RIGHT leg angle. Positive = forward` +
          (singleDirWalkDir ? ` (screen-${singleDirWalkDir}, the walking direction)` : "") +
          `, negative = back. ` +
          `Each cell specifies a DIFFERENT angle for L and R — you MUST match both independently. ` +
          `When L and R have OPPOSITE signs (one positive, one negative), it is a contact/stride frame: draw maximum separation with clearly different fore/aft positions. ` +
          `When L and R have SIMILAR signs (both near 0°), it is a crossover frame: draw both legs close together but still at their specified angles, never merged into one silhouette. ` +
          `Some cells (front/back-facing rows) use a depth note instead of an angle, because their legs swing toward/away from the camera, not sideways. ` +
          `'fwd(lower)' = draw that foot CLEARLY LOWER in the frame (stepped forward toward the viewer) — in CONTACT frames, this foot must be at least 15% of the cell height lower than the other foot. ` +
          `'fwd(higher)' = draw that foot CLEARLY HIGHER in the frame (stepped forward away from the viewer, back-facing walk). ` +
          `'back(lower)' / 'back(higher)' = the trailing foot at the opposite position. ` +
          `In ALL CONTACT frames, the two feet must have an OBVIOUS height difference — never draw both feet at the same vertical position. `
        : "")
    : "";

  // ── 입력 이미지 순서 + 최종 조립 ────────────────────────────────────────
  const overrideInputPaths: string[] = [];
  if (poseRefPath) overrideInputPaths.push(poseRefPath);
  if (refPath) overrideInputPaths.push(refPath);
  overrideInputPaths.push(gridTemplatePath);

  const viewpointRule = buildViewpointRule(normalizedViewpoint);

  // 단일 방향 시트: facing을 프롬프트 최우선 지시로 끌어올려 모델 기본 편향(측면 캐릭터를
  // 반대로 그리는 경향)을 누른다. 흩어진 screen-DIR 문구보다 앞쪽 단일 블록이 더 강하게 먹힌다.
  const screenDirLabel: Record<string, string> = {
    RIGHT: "SCREEN-RIGHT — the viewer's right-hand side (the → direction)",
    LEFT: "SCREEN-LEFT — the viewer's left-hand side (the ← direction)",
    DOWN: "toward the viewer (front view, walking down the screen)",
    UP: "away from the viewer (back view, walking up the screen)",
    "DOWN-LEFT": "toward the viewer's lower-left (3/4 front-left)",
    "DOWN-RIGHT": "toward the viewer's lower-right (3/4 front-right)",
    "UP-LEFT": "away toward the viewer's upper-left (3/4 back-left)",
    "UP-RIGHT": "away toward the viewer's upper-right (3/4 back-right)",
  };
  const facingDirective =
    isCharacter && isSingleDirection && parsedWalkDir
      ? `CRITICAL FACING DIRECTION (READ THIS FIRST — it overrides any default drawing tendency): ` +
        `In EVERY single frame the character faces and moves toward ${screenDirLabel[parsedWalkDir] ?? parsedWalkDir}. ` +
        (refPath
          ? `The attached reference image is a DESIGN reference ONLY — use it for the character's appearance, colors, outfit, equipment, and proportions, but IGNORE the reference's own facing and pose: redraw the character facing ${screenDirLabel[parsedWalkDir] ?? parsedWalkDir} even if the reference faces a different way. `
          : "") +
        (singleDirWalkDir
          ? `This is a pure side view: the nose, face, chest, and leading foot all point ${singleDirWalkDir}, ` +
            `while the back, ponytail/hair, cape, and trailing limbs stream toward the OPPOSITE side. ` +
            `Do NOT mirror, flip, or reverse this orientation — if the character ends up facing the other way, the ENTIRE sheet is WRONG and must be redrawn facing ${singleDirWalkDir}. `
          : `Keep this exact orientation in every frame — do NOT mirror or flip it. `) +
        (rows > 1
          ? `ALL ${rows} rows in this sheet face the SAME direction: ${parsedWalkDir}. ` +
            `Starting a new row does NOT change the facing direction — every row, every frame faces ${parsedWalkDir}. `
          : "")
      : "";

  // userPrompt 안의 facing 문구를 실제 parsedWalkDir 에 맞춰 정규화.
  // 오케스트레이터가 "facing RIGHT (side view)"를 접두사에 박았는데 handler 가 참조 방향에 맞춰
  // facing 을 DOWN 으로 override 하면, 접두사(RIGHT)와 주입 블록(DOWN)이 한 프롬프트에서 충돌한다.
  // 접두사의 facing 표현을 parsedWalkDir 기준으로 덮어써 모순을 제거. (replacer 함수로 $ 치환 회피.)
  const sanitizedUserPrompt =
    isCharacter && isSingleDirection && parsedWalkDir
      ? userPrompt.replace(
          /facing\s+(DOWN-LEFT|DOWN-RIGHT|UP-LEFT|UP-RIGHT|LEFT|RIGHT|UP|DOWN)\b(\s*\([^)]*\))?/gi,
          () => `facing ${screenDirLabel[parsedWalkDir] ?? parsedWalkDir}`,
        )
      : userPrompt;

  const decorated =
    `${sanitizedUserPrompt}. ` +
    facingDirective +
    viewpointRule +
    equipmentRule +
    walkCycleRule +
    actionAnimRule +
    actionMultiRowRule +
    poseRefInstruction +
    (overrideInputPaths.length > 1
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

  return { decorated, overrideInputPaths };
}

export type SpritesheetAttemptsSpec = {
  name: string;
  decorated: string;
  overrideInputPaths: string[];
  refId: string | null;
  spritesheetParams: Record<string, unknown>;
  retryEnabled: boolean;
  wantsTransparent: boolean;
  chromaKeyColor: ChromaKeyColor;
  rows: number;
  cols: number;
  canvasW: number;
  canvasH: number;
  anchorStrategy: AnchorStrategy;
  subjectType: SubjectType;
  resolvedAnchor: Exclude<AnchorStrategy, "auto">;
  finalCellPx: number;
  sessionId: string | null;
  signal?: AbortSignal;
};

/**
 * 스프라이트시트 시도 루프 + 후처리.
 *   1. 최대 MAX_RETRIES+1 회 codex 생성 → 리사이즈 → chroma-key → detectFill
 *   2. filledCells 기준으로 best 선택 (낮은 시도는 파일·DB 정리)
 *   3. best 에만 normalizeSpritesheetCells + 업스케일(cellPx→finalCellPx) 적용
 */
export async function runSpritesheetAttempts(
  spec: SpritesheetAttemptsSpec,
): Promise<{ best: Awaited<ReturnType<typeof runImageTool>> | null; cumulativeMs: number }> {
  const {
    name, decorated, overrideInputPaths, refId, spritesheetParams, retryEnabled,
    wantsTransparent, chromaKeyColor, rows, cols, canvasW, canvasH,
    anchorStrategy, subjectType, resolvedAnchor, finalCellPx, sessionId, signal,
  } = spec;
  const MAX_RETRIES = retryEnabled ? 2 : 0;
  const cellArea = Math.floor(canvasW / cols) * Math.floor(canvasH / rows);

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
    let mcpResult: Awaited<ReturnType<typeof runImageTool>>;
    try {
      mcpResult = await runImageTool({
        name,
        kind: "spritesheet",
        prompt: decorated,
        inputGenerationIds: refId ? [refId] : [],
        overrideInputPaths,
        params: spritesheetParams,
        sessionId,
        progressPrefix: retryEnabled ? `attempt ${attempt + 1}/${MAX_RETRIES + 1}` : undefined,
        signal,
      });
    } catch (e) {
      const isTimeout = (e as Error).message?.includes("timed out");
      if (isTimeout && retryEnabled && attempt < MAX_RETRIES) {
        log(`make_spritesheet attempt ${attempt + 1}/${MAX_RETRIES + 1}: Codex timeout — retrying`);
        continue;
      }
      throw e;
    }
    cumulativeMs += mcpResult?.structuredContent?.elapsedMs ?? 0;

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
          await applyTransparentPostProcess(filePath, chromaKeyColor, cellArea);
          log(`make_spritesheet chroma-keyed gen=${genId} key=${chromaKeyColor}`);
        }
        if (retryEnabled) {
          stats = await detectFill(filePath, rows, cols, log);
        }
      } catch (e) {
        log(`make_spritesheet post-process fail: ${(e as Error).message}`);
      }
    }

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
        `${stats.filledCells}/${stats.expected} cells — retrying`,
    );
  }

  // best 에만 normalize + 업스케일 적용
  const finalGenId: string | undefined = best?.structuredContent?.generationId;
  if (finalGenId) {
    const filePath = imagePathFor(finalGenId);
    try {
      await normalizeSpritesheetCells(filePath, rows, cols, wantsTransparent, {
        anchorStrategy,
        subjectType,
        log,
      });
      log(`make_spritesheet normalized gen=${finalGenId} (${rows}x${cols}) anchor=${resolvedAnchor}`);

      const upW = cols * finalCellPx;
      const upH = rows * finalCellPx;
      const upTmp = `${filePath}.up.tmp`;
      await sharp(filePath)
        .resize(upW, upH, { kernel: "lanczos3", fit: "fill" })
        .png()
        .toFile(upTmp);
      fs.renameSync(upTmp, filePath);
      setGenerationDimensions(finalGenId, upW, upH);
      log(`make_spritesheet upscaled gen=${finalGenId} to ${upW}x${upH}`);
    } catch (e) {
      log(`make_spritesheet post-process fail: ${(e as Error).message}`);
    }
    if (retryEnabled && lastStats && !lastStats.complete) {
      log(
        `make_spritesheet WARNING: ${MAX_RETRIES + 1} attempts exhausted, ` +
          `best fill ${lastStats.filledCells}/${lastStats.expected} cells (incomplete) — proceeding with best`,
      );
    }
  }

  return { best, cumulativeMs };
}

export type DirectionalSheetSpec = {
  /** 방향별(행별) buildSpritePrompt 결과. dirList 순서와 1:1. */
  rowDecorated: { decorated: string; overrideInputPaths: string[] }[];
  /** 위→아래 행 순서의 facing 라벨(directions=2: [LEFT,RIGHT], directions=4: [DOWN,LEFT,RIGHT,UP]). */
  dirList: string[];
  refId: string | null;
  spritesheetParams: Record<string, unknown>;
  wantsTransparent: boolean;
  chromaKeyColor: ChromaKeyColor;
  rows: number;
  cols: number;
  /** 단일 행(rows=1) 생성 캔버스. canvasW = cols*cellPx, rowCanvasH = cellPx. */
  canvasW: number;
  rowCanvasH: number;
  anchorStrategy: AnchorStrategy;
  subjectType: SubjectType;
  resolvedAnchor: Exclude<AnchorStrategy, "auto">;
  finalCellPx: number;
  sessionId: string | null;
  signal?: AbortSignal;
};

/**
 * 다방향 시트(directions>1)를 방향별 개별 Codex 호출 + 수직 stitch 로 생성.
 *   1. dirList 각 방향마다 rows=1 단일 행 시트를 runImageTool 로 생성(재시도·후처리 없음).
 *   2. 각 행 raw PNG 를 canvasW×rowCanvasH 로 정규화한 뒤 sharp 로 수직 stitch
 *      → 첫 generation 파일(최종 결과)에 rows 행 시트를 1장으로 합성.
 *   3. 합쳐진 시트에 후처리(chroma-key → normalize → 업스케일)를 1회만 적용.
 *   4. 잉여 generation(2번째 이후)·임시 파일은 정리.
 *
 * 분리 호출 근거: 단일 호출은 모델이 행별 facing 을 혼동하고 4방향×384px=1536px 가
 * gpt-image-2 장축 한계여서 방향 수가 늘면 캔버스가 한계에 막힌다.
 */
export async function runDirectionalSpritesheet(
  spec: DirectionalSheetSpec,
): Promise<{ best: Awaited<ReturnType<typeof runImageTool>> | null; cumulativeMs: number }> {
  const {
    rowDecorated, dirList, refId, spritesheetParams,
    wantsTransparent, chromaKeyColor, rows, cols, canvasW, rowCanvasH,
    anchorStrategy, subjectType, resolvedAnchor, finalCellPx, sessionId, signal,
  } = spec;

  const cellArea = Math.floor(canvasW / cols) * rowCanvasH;
  const rowResults: Awaited<ReturnType<typeof runImageTool>>[] = [];
  const rowPaths: string[] = [];
  let cumulativeMs = 0;

  // 각 방향(행) 생성 — rows=1 단일 행. 방향별 독립 호출(각 호출 CODEX_TIMEOUT_MS 적용).
  for (let i = 0; i < dirList.length; i++) {
    const { decorated, overrideInputPaths } = rowDecorated[i];
    const rowResult = await runImageTool({
      name: "make_spritesheet",
      kind: "spritesheet",
      prompt: decorated,
      inputGenerationIds: refId ? [refId] : [],
      overrideInputPaths,
      params: spritesheetParams,
      sessionId,
      progressPrefix: `direction ${i + 1}/${dirList.length}: ${dirList[i]}`,
      signal,
    });
    cumulativeMs += rowResult?.structuredContent?.elapsedMs ?? 0;
    const gid = rowResult?.structuredContent?.generationId;
    if (!gid) throw new Error(`make_spritesheet directional: row ${i} produced no generation`);
    const fp = imagePathFor(gid);
    // 각 행을 단일 행 캔버스(canvasW×rowCanvasH)로 정규화 — stitch 폭/높이 일치 보장.
    const rowTmp = `${fp}.row.tmp`;
    await sharp(fp)
      .resize(canvasW, rowCanvasH, { kernel: "lanczos3", fit: "fill" })
      .png()
      .toFile(rowTmp);
    fs.renameSync(rowTmp, fp);
    rowResults.push(rowResult);
    rowPaths.push(fp);
    log(`make_spritesheet directional: row ${i + 1}/${dirList.length} (${dirList[i]}) gen=${gid}`);
  }

  // 첫 generation 파일을 최종 결과로 삼아 수직 stitch.
  const best = rowResults[0];
  const finalGenId = best?.structuredContent?.generationId;
  if (!finalGenId) return { best: null, cumulativeMs };
  const finalPath = imagePathFor(finalGenId);
  const totalH = rowCanvasH * rows;

  const rowBuffers = await Promise.all(rowPaths.map(p => sharp(p).toBuffer()));
  const stitchTmp = `${finalPath}.stitch.tmp`;
  await sharp({
    create: { width: canvasW, height: totalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(rowBuffers.map((input, i) => ({ input, top: i * rowCanvasH, left: 0 })))
    .png()
    .toFile(stitchTmp);
  fs.renameSync(stitchTmp, finalPath);
  log(`make_spritesheet directional: stitched ${rows} rows → ${canvasW}x${totalH} gen=${finalGenId}`);

  // 잉여 generation(2번째 행 이후) 파일·DB 정리.
  for (let i = 1; i < rowResults.length; i++) {
    const gid = rowResults[i]?.structuredContent?.generationId;
    if (!gid) continue;
    try {
      const fp = imagePathFor(gid);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      deleteGeneration(gid);
    } catch (e) {
      log(`make_spritesheet directional cleanup fail gen=${gid}: ${(e as Error).message}`);
    }
  }

  // 후처리 1회: chroma-key → normalize → 업스케일 (stitch 된 최종 시트에만).
  try {
    if (wantsTransparent) {
      await applyTransparentPostProcess(finalPath, chromaKeyColor, cellArea);
      log(`make_spritesheet directional chroma-keyed gen=${finalGenId} key=${chromaKeyColor}`);
    }
    await normalizeSpritesheetCells(finalPath, rows, cols, wantsTransparent, {
      anchorStrategy,
      subjectType,
      log,
    });
    log(`make_spritesheet directional normalized gen=${finalGenId} (${rows}x${cols}) anchor=${resolvedAnchor}`);

    const upW = cols * finalCellPx;
    const upH = rows * finalCellPx;
    const upTmp = `${finalPath}.up.tmp`;
    await sharp(finalPath)
      .resize(upW, upH, { kernel: "lanczos3", fit: "fill" })
      .png()
      .toFile(upTmp);
    fs.renameSync(upTmp, finalPath);
    setGenerationDimensions(finalGenId, upW, upH);
    log(`make_spritesheet directional upscaled gen=${finalGenId} to ${upW}x${upH}`);
  } catch (e) {
    log(`make_spritesheet directional post-process fail: ${(e as Error).message}`);
  }

  return { best, cumulativeMs };
}

/**
 * 이미지가 투명 배경을 가졌는지 빠르게 감지.
 *
 * 알파 채널이 없으면 즉시 false. 있으면 네 꼭짓점 픽셀 샘플링으로 판단.
 * 게임 캐릭터 에셋은 보통 꼭짓점이 배경이므로 충분히 정확하다.
 */
export async function detectTransparentBg(imagePath: string): Promise<boolean> {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ch = 4; // RGBA (ensureAlpha 보장)
  const offsets = [
    0,
    (w - 1) * ch,
    (h - 1) * w * ch,
    ((h - 1) * w + (w - 1)) * ch,
  ];
  return offsets.some(o => data[o + 3] < 10);
}

/**
 * 스프라이트 시트 레퍼런스용 그리드 PNG.
 *   - 외곽 셀 경계: 회색 1px (#cccccc) — 모델에게 셀 레이아웃만 시각적으로 전달.
 * 내부 safe-zone 박스는 v2 까지 그려넣었지만 모델이 그대로 출력에 복사하는
 * 부작용 → v3 부터는 그리지 않고 후처리(normalizeSpritesheetCells)로 패딩 강제.
 * data/templates/sprite-grid-v3-{cols}x{rows}x{cellW}x{cellH}.png 에 자동 캐싱(런타임 생성).
 */
export async function generateGridTemplate(
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

export async function runImageTool(spec: {
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
}): Promise<ToolResponse> {
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

// ─── input helpers ───────────────────────────────────────────────────────────

export function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
}
export function requireInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${name} must be an integer`);
  return v;
}
