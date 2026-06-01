/**
 * 보행 사이클 스틱 피겨 레퍼런스 이미지 생성.
 * sharp SVG 렌더링으로 각 프레임의 정확한 다리/팔 각도를 PNG로 출력.
 */
import sharp from "sharp";

const W = 192;
const H = 256;

// 인체 비율 (픽셀)
const HEAD_R = 16;
const TORSO_LEN = 60;
const UPPER_LEG = 50;
const LOWER_LEG = 45;
const UPPER_ARM = 38;
const LOWER_ARM = 32;

// 시작점
const CX = W / 2;
const HEAD_Y = 28;
const NECK_Y = HEAD_Y + HEAD_R + 4;
const SHOULDER_Y = NECK_Y + 10;
const HIP_Y = SHOULDER_Y + TORSO_LEN;

function deg2rad(d: number) { return d * Math.PI / 180; }

function endpoint(x: number, y: number, angleDeg: number, len: number) {
  const r = deg2rad(angleDeg);
  return { x: x + Math.sin(r) * len, y: y + Math.cos(r) * len };
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, w = 5) {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}

function circle(cx: number, cy: number, r: number, color: string) {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}"/>`;
}

/**
 * 8방향 시트의 dirIndex(0~7) → walkAngle θ(도). directionLabels(8) 순서:
 *   0:DOWN(90) 1:DOWN-LEFT(135) 2:LEFT(180) 3:UP-LEFT(225)
 *   4:UP(270)  5:UP-RIGHT(315)  6:RIGHT(0)  7:DOWN-RIGHT(45)
 */
const DIR_WALK_ANGLE = [90, 135, 180, 225, 270, 315, 0, 45];

/** 방향별 스크린 투영 성분. walkX 양수=오른쪽, walkY 양수=아래쪽. */
function walkComponents(dirIndex: number) {
  const theta = deg2rad(DIR_WALK_ANGLE[dirIndex] ?? 0);
  return { walkX: Math.cos(theta), walkY: Math.sin(theta) };
}

/**
 * 8프레임 보행 사이클의 frame 번호(0~7)에 해당하는 스틱 피겨 SVG 생성.
 * transparent=true 이면 배경 없이 투명 — 그리드 셀 합성용.
 * dirIndex(0~7)는 8방향 순서(directionLabels(8)). 기본값 6 = RIGHT(기존 사이드뷰).
 */
function buildPoseSvg(frame: number, totalFrames = 8, transparent = false, dirIndex = 6, isRun = false): string {
  // 달리기: 보폭 각도 크게, 무릎 높이 들어올림, 팔 펌핑 강하게, 몸통 앞으로 기울음
  const A = isRun ? 48 : 32;
  const phase = (2 * Math.PI * frame) / totalFrames;
  const { walkX } = walkComponents(dirIndex);

  const elements: string[] = [];

  if (!transparent) {
    elements.push(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);
  }

  // 정면/후면 모드: 순수 DOWN(0)/UP(4)만. 대각선(1/3/5/7)은 |walkX|==|walkY| 라
  // 부동소수 비교에 의존하지 않고 인덱스로 직접 게이트 → 항상 사이드뷰로 빠진다.
  const isFrontBack = dirIndex === 0 || dirIndex === 4;
  const isBack = dirIndex === 4; // UP — 후면 표현

  // 레이블 (불투명 모드에서만)
  if (!transparent) {
    const cosp = Math.cos(phase);
    const isContact = Math.abs(cosp) > 0.85;
    const isCrossover = Math.abs(cosp) < 0.15;
    const dirName = ["DOWN", "DN-LEFT", "LEFT", "UP-LEFT", "UP", "UP-RIGHT", "RIGHT", "DN-RIGHT"][dirIndex] ?? "?";
    const phaseLabel = isContact ? "CONTACT" : isCrossover ? "CROSSOVER" : `f${frame}`;
    elements.push(`<text x="${W/2}" y="16" text-anchor="middle" fill="#aaaaff" font-family="monospace" font-size="11">${dirName} ${phaseLabel}</text>`);
  }

  // 머리 — 후면은 어둡게 채워 등(뒤통수)을 표현. 다리 색은 legend(파랑=왼,빨강=오) 유지.
  const headColor = isBack ? "#7a6038" : "#f0c080";
  elements.push(circle(CX, HEAD_Y, HEAD_R, headColor));

  // 목
  elements.push(line(CX, NECK_Y, CX, SHOULDER_Y, "#f0c080", 4));

  // 어깨 가로선
  elements.push(line(CX - 20, SHOULDER_Y, CX + 20, SHOULDER_Y, "#f0c080", 4));

  if (isFrontBack) {
    // ── 정면/후면 모드 (DOWN/UP) ──
    // 다리가 수직으로 내려오되 좌우 발 위치가 교차. leftLegPhase=cos(phase).
    const leftLegPhase = Math.cos(phase);
    const LEG_TOTAL = UPPER_LEG + LOWER_LEG;
    const STEP_W = 18;          // 좌우 발 기본 벌림
    const forwardOffset = leftLegPhase * 8; // 앞 발이 약간 안쪽으로
    const DEPTH = 6;            // 앞 발이 더 아래로(깊이) — 가시적 px

    // 팔: 정면/후면도 좌우로 약간 흔들림(수직 기준 좌우 스윙)
    const armSwing = leftLegPhase * 10;
    const lShoulderF = { x: CX - 20, y: SHOULDER_Y };
    const rShoulderF = { x: CX + 20, y: SHOULDER_Y };
    const lHandF = { x: lShoulderF.x - 2 + armSwing, y: SHOULDER_Y + UPPER_ARM + LOWER_ARM * 0.7 };
    const rHandF = { x: rShoulderF.x + 2 - armSwing, y: SHOULDER_Y + UPPER_ARM + LOWER_ARM * 0.7 };
    elements.push(line(lShoulderF.x, lShoulderF.y, lHandF.x, lHandF.y, "#80c0f0", 4));
    elements.push(line(rShoulderF.x, rShoulderF.y, rHandF.x, rHandF.y, "#f08080", 4));

    // 몸통
    elements.push(line(CX, SHOULDER_Y, CX, HIP_Y, "#f0c080", 5));
    elements.push(circle(CX, HIP_Y, 5, "#f0c080"));

    // 왼발(파랑): leftLegPhase>0 이면 앞으로 → 약간 아래(깊이)
    const lFootX = CX - STEP_W + forwardOffset;
    const lFootY = HIP_Y + LEG_TOTAL + Math.abs(leftLegPhase) * (leftLegPhase > 0 ? DEPTH : 0);
    const lKneeF = { x: CX - STEP_W * 0.6, y: HIP_Y + UPPER_LEG };
    elements.push(line(CX, HIP_Y, lKneeF.x, lKneeF.y, "#4fc3f7", 6));
    elements.push(line(lKneeF.x, lKneeF.y, lFootX, lFootY, "#4fc3f7", 5));
    elements.push(circle(lKneeF.x, lKneeF.y, 5, "#4fc3f7"));
    elements.push(line(lFootX, lFootY, lFootX - 7, lFootY, "#4fc3f7", 4)); // 발끝

    // 오른발(빨강): rightLegPhase = -leftLegPhase
    const rFootX = CX + STEP_W - forwardOffset;
    const rFootY = HIP_Y + LEG_TOTAL + Math.abs(leftLegPhase) * (leftLegPhase < 0 ? DEPTH : 0);
    const rKneeF = { x: CX + STEP_W * 0.6, y: HIP_Y + UPPER_LEG };
    elements.push(line(CX, HIP_Y, rKneeF.x, rKneeF.y, "#ef5350", 6));
    elements.push(line(rKneeF.x, rKneeF.y, rFootX, rFootY, "#ef5350", 5));
    elements.push(circle(rKneeF.x, rKneeF.y, 5, "#ef5350"));
    elements.push(line(rFootX, rFootY, rFootX + 7, rFootY, "#ef5350", 4)); // 발끝

    if (!transparent) {
      elements.push(`<text x="4" y="${H - 20}" fill="#4fc3f7" font-family="monospace" font-size="10">L</text>`);
      elements.push(`<text x="${W - 20}" y="${H - 20}" fill="#ef5350" font-family="monospace" font-size="10">R</text>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${elements.join("")}</svg>`;
  }

  // ── 사이드뷰 모드 (LEFT/RIGHT + 대각선) ──
  const leftLegAngle  =  A * walkX * Math.cos(phase);
  const rightLegAngle = -A * walkX * Math.cos(phase);
  const armMult = isRun ? 0.85 : 0.6;
  const leftArmAngle  = -A * armMult * walkX * Math.cos(phase);
  const rightArmAngle =  A * armMult * walkX * Math.cos(phase);

  // 달리기: 몸통 앞으로 10° 기울음 (어깨가 엉덩이보다 앞으로)
  const leanX = isRun ? 10 * Math.sign(walkX) : 0;
  const shoulderX = CX + leanX;

  // 왼팔
  const lShoulder = { x: shoulderX - 20, y: SHOULDER_Y };
  const lElbow = endpoint(lShoulder.x, lShoulder.y, leftArmAngle, UPPER_ARM);
  const lHand  = endpoint(lElbow.x, lElbow.y, leftArmAngle * (isRun ? 0.8 : 0.5), LOWER_ARM);
  elements.push(line(lShoulder.x, lShoulder.y, lElbow.x, lElbow.y, "#80c0f0", 4));
  elements.push(line(lElbow.x, lElbow.y, lHand.x, lHand.y, "#80c0f0", 3));

  // 오른팔
  const rShoulder = { x: shoulderX + 20, y: SHOULDER_Y };
  const rElbow = endpoint(rShoulder.x, rShoulder.y, rightArmAngle, UPPER_ARM);
  const rHand  = endpoint(rElbow.x, rElbow.y, rightArmAngle * (isRun ? 0.8 : 0.5), LOWER_ARM);
  elements.push(line(rShoulder.x, rShoulder.y, rElbow.x, rElbow.y, "#f08080", 4));
  elements.push(line(rElbow.x, rElbow.y, rHand.x, rHand.y, "#f08080", 3));

  // 몸통 (달리기: 기울어진 어깨 → 엉덩이)
  elements.push(line(shoulderX, SHOULDER_Y, CX, HIP_Y, "#f0c080", 5));
  elements.push(circle(CX, HIP_Y, 5, "#f0c080"));

  // 달리기 무릎/발 각도:
  // 앞 다리(leg angle > 0): 발을 앞으로 강하게 차올림 (lower leg 0.5×)
  // 뒷 다리(leg angle < 0): 뒤꿈치 킥 — lower leg 가 위/뒤로 접힘 (-0.9×)
  function lowerLegAngle(legAngle: number): number {
    if (!isRun) return legAngle * 0.3;
    return legAngle > 0 ? legAngle * 0.5 : legAngle * -0.9;
  }

  // 왼쪽 다리 (파란색)
  const lKnee = endpoint(CX, HIP_Y, leftLegAngle, UPPER_LEG);
  const lFoot = endpoint(lKnee.x, lKnee.y, lowerLegAngle(leftLegAngle), LOWER_LEG);
  elements.push(line(CX, HIP_Y, lKnee.x, lKnee.y, "#4fc3f7", 6));
  elements.push(line(lKnee.x, lKnee.y, lFoot.x, lFoot.y, "#4fc3f7", 5));
  elements.push(circle(lKnee.x, lKnee.y, 5, "#4fc3f7"));
  const lFootTip = endpoint(lFoot.x, lFoot.y, 90 + leftLegAngle * 0.2, 14 * (walkX >= 0 ? 1 : -1));
  elements.push(line(lFoot.x, lFoot.y, lFootTip.x, lFootTip.y, "#4fc3f7", 4));

  // 오른쪽 다리 (빨간색)
  const rKnee = endpoint(CX, HIP_Y, rightLegAngle, UPPER_LEG);
  const rFoot = endpoint(rKnee.x, rKnee.y, lowerLegAngle(rightLegAngle), LOWER_LEG);
  elements.push(line(CX, HIP_Y, rKnee.x, rKnee.y, "#ef5350", 6));
  elements.push(line(rKnee.x, rKnee.y, rFoot.x, rFoot.y, "#ef5350", 5));
  elements.push(circle(rKnee.x, rKnee.y, 5, "#ef5350"));
  const rFootTip = endpoint(rFoot.x, rFoot.y, 90 + rightLegAngle * 0.2, 14 * (walkX >= 0 ? 1 : -1));
  elements.push(line(rFoot.x, rFoot.y, rFootTip.x, rFootTip.y, "#ef5350", 4));

  if (!transparent) {
    elements.push(`<text x="4" y="${H - 20}" fill="#4fc3f7" font-family="monospace" font-size="10">L:${leftLegAngle.toFixed(0)}°</text>`);
    elements.push(`<text x="${W - 50}" y="${H - 20}" fill="#ef5350" font-family="monospace" font-size="10">R:${rightLegAngle.toFixed(0)}°</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${elements.join("")}</svg>`;
}

/** 단일 프레임 포즈 PNG 버퍼 반환 */
export async function generatePoseFrame(frame: number, totalFrames = 8): Promise<Buffer> {
  const svg = buildPoseSvg(frame, totalFrames);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 8방향 시트의 총 방향 수 — 행별 dirIndex 매핑 기준. */
const TOTAL_DIRECTIONS = 8;

/**
 * 그리드 템플릿 각 셀에 해당 프레임의 스틱 피겨 포즈를 합성한 가이드 템플릿 반환.
 * 같은 컬럼(= 같은 보행 위상)에 같은 프레임 포즈를 넣어 프레임별 다리 각도를
 * Codex가 명확히 인식하게 한다.
 *
 * startDirIndex 가 0(또는 undefined 이외)이고 rows === 8 이면 각 행을 해당
 * 방향(directionLabels(8) 순서: DOWN→…→DN-RIGHT)의 스켈레톤으로 채운다.
 * startDirIndex 가 undefined 이거나 rows !== 8 이면 모든 행을 RIGHT(dirIndex=6,
 * 기존 사이드뷰)로 채운다 — 단일 방향 시트의 기존 동작.
 */
export async function generatePoseGuidedTemplate(
  gridTemplatePath: string,
  rows: number,
  cols: number,
  cellW: number,
  cellH: number,
  startDirIndex?: number,
  isRun = false,
): Promise<Buffer> {
  const skelH = Math.round(cellH * 0.65);
  const skelW = Math.round(skelH * (W / H));
  const offsetX = Math.round((cellW - skelW) / 2);
  const offsetY = Math.round((cellH - skelH) * 0.35);

  const perRowDirections = startDirIndex !== undefined && rows === TOTAL_DIRECTIONS;
  const dirForRow = (r: number) => (perRowDirections ? r : 6);

  const poseRows = await Promise.all(
    Array.from({ length: rows }, async (_, r) => {
      const dir = dirForRow(r);
      return Promise.all(
        Array.from({ length: cols }, async (_, c) => {
          const svg = buildPoseSvg(c, cols, true, dir, isRun);
          return sharp(Buffer.from(svg)).resize(skelW, skelH).png().toBuffer();
        }),
      );
    }),
  );

  // 그리드 템플릿 위에 각 셀에 해당 (행,열) 포즈 합성
  const composites: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      composites.push({
        input: poseRows[r][c],
        left: c * cellW + offsetX,
        top: r * cellH + offsetY,
        blend: "over",
      });
    }
  }

  return sharp(gridTemplatePath).composite(composites).png().toBuffer();
}

/** 프레임 하나의 다리 각도 데이터. */
export type FrameAngle = {
  col: number;          // 0-based 컬럼 인덱스
  leftDeg: number;      // 왼발 각도 (양수=앞, 음수=뒤)
  rightDeg: number;     // 오른발 각도
  label: string;        // "L-CONTACT" | "CROSSOVER" | "R-CONTACT" | "f{n}"
};

/** cols 프레임 사이클의 각도 배열을 계산. buildPoseSvg와 동일한 공식. */
export function computeFrameAngles(cols: number, isRun = false): FrameAngle[] {
  const A = isRun ? 48 : 32;
  return Array.from({ length: cols }, (_, c) => {
    const phase = (2 * Math.PI * c) / cols;
    const cosP = Math.cos(phase);
    const leftDeg  = Math.round(A * cosP);
    const rightDeg = Math.round(-A * cosP);
    const absC = Math.abs(cosP);
    const label = absC > 0.85
      ? (leftDeg > 0 ? "L-CONTACT" : "R-CONTACT")
      : absC < 0.15 ? "CROSSOVER" : `f${c}`;
    return { col: c, leftDeg, rightDeg, label };
  });
}

/**
 * 특정 방향(dirIndex) × cols프레임 포즈 가이드 행을 생성해 캐시 파일로 반환.
 * buildPoseSvg로 직접 생성 — cols에 맞는 완전한 사이클 보장.
 *
 * @returns { path, angles } — 캐시 파일 경로 + 프레임별 각도 데이터
 */
export async function getCachedPoseRow(
  dirIndex: number,
  cols: number,
  cellSize: number,
  templatesDir: string,
  isRun = false,
): Promise<{ path: string; angles: FrameAngle[] }> {
  const type = isRun ? "run" : "walk";
  const cacheFile = `${templatesDir}/pose-${type}-dir${dirIndex}-c${cols}.png`;
  const angles = computeFrameAngles(cols, isRun);

  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  if (existsSync(cacheFile)) return { path: cacheFile, angles };

  mkdirSync(templatesDir, { recursive: true });

  const skelH = Math.round(cellSize * 0.65);
  const skelW = Math.round(skelH * (W / H));
  const offsetX = Math.round((cellSize - skelW) / 2);
  const offsetY = Math.round((cellSize - skelH) * 0.35);

  const frames = await Promise.all(
    Array.from({ length: cols }, async (_, c) => {
      const svg = buildPoseSvg(c, cols, true, dirIndex, isRun);
      return sharp(Buffer.from(svg)).resize(skelW, skelH).png().toBuffer();
    }),
  );

  const composites = frames.map((buf, c) => ({
    input: buf,
    left: c * cellSize + offsetX,
    top: offsetY,
    blend: "over" as const,
  }));

  const buf = await sharp({
    create: { width: cols * cellSize, height: cellSize, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  writeFileSync(cacheFile, buf);
  return { path: cacheFile, angles };
}

/** N프레임 보행 사이클 포즈를 가로로 이어붙인 레퍼런스 시트 PNG 버퍼 반환 */
export async function generateWalkPoseSheet(totalFrames = 8): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: totalFrames }, (_, i) => generatePoseFrame(i, totalFrames))
  );
  const composites = frames.map((buf, i) => ({
    input: buf,
    left: i * W,
    top: 0,
  }));
  return sharp({
    create: { width: W * totalFrames, height: H, channels: 4, background: { r: 26, g: 26, b: 46, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
