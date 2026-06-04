/**
 * 보행 사이클 스틱 피겨 레퍼런스 이미지 생성.
 * sharp SVG 렌더링으로 각 프레임의 정확한 다리/팔 각도를 PNG로 출력.
 *
 * 레퍼런스 PNG(data/reference/pose-guided-{walk,run}-8dir.png)는
 * `pnpm gen:poses`(scripts/gen-pose-guides.ts)로 재생성한다 — buildPoseSvg/computePose 기하를
 * 바꾸면 반드시 재실행해야 프로덕션(extractPoseGuideGrid)에 반영된다.
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
 * 8방향 canonical order(게임 관례 확정). directionLabels(8) 행 순서와 1:1.
 *   short = 셀 라벨용 짧은 이름 / full = make_spritesheet 입력 방향명(DIR_INDEX 역매핑 키)
 *   angle = 보행 진행각 θ(도). walkX=cos θ(오른쪽+), walkY=sin θ(아래/전면+).
 * DIR_NAMES·DIR_WALK_ANGLE·DIR_INDEX를 전부 이 테이블에서 파생 — 순서가 한 곳뿐이라 드리프트 불가.
 */
const DIRECTIONS_8 = [
  { short: "DOWN",     full: "DOWN",       angle: 90 },
  { short: "DN-LEFT",  full: "DOWN-LEFT",  angle: 135 },
  { short: "LEFT",     full: "LEFT",       angle: 180 },
  { short: "UP-LEFT",  full: "UP-LEFT",    angle: 225 },
  { short: "UP",       full: "UP",         angle: 270 },
  { short: "UP-RIGHT", full: "UP-RIGHT",   angle: 315 },
  { short: "RIGHT",    full: "RIGHT",      angle: 0 },
  { short: "DN-RIGHT", full: "DOWN-RIGHT", angle: 45 },
] as const;

/** dirIndex(0~7) → 짧은 방향명. 셀 라벨·server.ts 다중방향 라벨링 공용. */
export const DIR_NAMES = DIRECTIONS_8.map(d => d.short);
/** make_spritesheet 입력 방향명(full) → dirIndex. server.ts parsedWalkDir 변환 공용. */
export const DIR_INDEX: Record<string, number> = Object.fromEntries(DIRECTIONS_8.map((d, i) => [d.full, i]));
const DIR_WALK_ANGLE = DIRECTIONS_8.map(d => d.angle);

/** 방향별 스크린 투영 성분. walkX 양수=오른쪽, walkY 양수=아래쪽(전면/시청자 쪽). */
function walkComponents(dirIndex: number) {
  const theta = deg2rad(DIR_WALK_ANGLE[dirIndex] ?? 0);
  return { walkX: Math.cos(theta), walkY: Math.sin(theta) };
}

// 연속 포즈 모델 상수
const STEP_W = 18;   // 정면/후면 최대 좌우 벌림(px). 순수 측면=0.
const DEPTH = 26;    // 정면/후면 전후(깊이) 발 오프셋 최대(px). 순수 측면=0.
// |walkX|이 이 값보다 크면 측면/대각선(swingAngle·발끝 회전·facing 코 사용), 작으면 정면/후면(depthY 사용). ≈cos(73°).
const SIDE_WALKX_THRESHOLD = 0.3;

/**
 * 한쪽 다리의 기하 + 각도 데이터. side=+1(왼/파랑), -1(오/빨강).
 * swingX = 화면 x 스윙각(수직 기준, 측면), lateral = 좌우 벌림(정면), depth = 전후(깊이).
 */
type LegPose = {
  side: 1 | -1;
  swingAngle: number;  // 수직 기준 스윙각(도). +면 화면 전진방향.
  lateral: number;     // 엉덩이 x 오프셋(px). 정면/후면에서 좌우 벌림.
  depthY: number;      // 발 y 오프셋(px). 전진발 아래(전면)/위(후면).
  isSwing: boolean;    // 공중(전진 중) 다리면 true → 무릎 굽힘.
};

/** 한 다리의 포즈 성분 계산. side: +1=왼(파랑), -1=오(빨강). */
function computeLeg(side: 1 | -1, phase: number, walkX: number, walkY: number, A: number): LegPose {
  const cosp = Math.cos(phase);
  // swingAngle: walkY=0(측면)에서 OLD 사이드뷰 공식과 정확히 동일.
  const swingAngle = side * A * walkX * cosp;
  // lateral: 정면/후면 최대(±STEP_W), 순수 측면 0. side로 좌우 벌림.
  const lateral = side * STEP_W * Math.abs(walkY);
  // depthY: 전진 중인 발이 전면(walkY>0)이면 아래로, 후면(walkY<0)이면 위로.
  const depthY = side * DEPTH * walkY * cosp;
  // swing(공중) 다리 = 전진 중(각도 증가, d/dφ>0). 위상만으로 판정 — 방향 부호(walkX/walkY)에
  // 곱하면 LEFT/UP 등 음수 성분 방향에서 위상이 반전돼 frame 0 앞다리가 뒤바뀐다(버그).
  const isSwing = -side * Math.sin(phase) > 0;
  return { side, swingAngle, lateral, depthY, isSwing };
}

/**
 * frame/totalFrames/dirIndex/isRun → 두 다리 + 위상 데이터를 동시에 산출.
 * 이미지 렌더(buildPoseSvg)와 각도 텍스트(computeFrameAngles/extractPoseGuideGrid)의 단일 소스.
 */
export function computePose(frame: number, totalFrames: number, dirIndex: number, isRun: boolean) {
  const A = isRun ? 48 : 32;
  const phase = (2 * Math.PI * frame) / totalFrames;
  const { walkX, walkY } = walkComponents(dirIndex);
  const left = computeLeg(1, phase, walkX, walkY, A);
  const right = computeLeg(-1, phase, walkX, walkY, A);
  return { phase, walkX, walkY, A, left, right };
}

/** 정강이(lower leg) 각도. swing(공중) 다리는 굽혀 정강이 들어올림, stance는 곧게. */
function lowerLegAngle(leg: LegPose, isRun: boolean): number {
  if (isRun) {
    // isSwing=FALSE → 접지/앞다리: shin 완만히 앞으로(0.5×). isSwing=TRUE → 스윙/뒷다리: heel kick(-0.9×).
    return !leg.isSwing ? leg.swingAngle * 0.5 : leg.swingAngle * -0.9;
  }
  // walk: swing 다리는 정강이를 안쪽으로 굽혀 stance와 분리(passing 겹침 해소), stance는 곧게.
  return leg.isSwing ? leg.swingAngle - leg.side * 26 : leg.swingAngle * 0.15;
}

/**
 * 8프레임 보행 사이클의 frame 번호(0~7)에 해당하는 스틱 피겨 SVG 생성.
 * transparent=true 이면 배경 없이 투명 — 그리드 셀 합성용.
 * dirIndex(0~7)는 8방향 순서(directionLabels(8)). 기본값 6 = RIGHT(기존 사이드뷰).
 *
 * 연속 포즈 모델: 측면/대각선/정면/후면을 하나의 computePose 경로로 통합.
 * walkY=0(측면)이면 OLD 사이드뷰와 동일(무릎 굽힘 차등 외), walkX=0(정면/후면)이면
 * 좌우로 벌린 다리 + 전진발 깊이, 대각선은 셋 모두 부분 적용(진짜 3/4).
 */
function buildPoseSvg(frame: number, totalFrames = 8, transparent = false, dirIndex = 6, isRun = false): string {
  const pose = computePose(frame, totalFrames, dirIndex, isRun);
  const { phase, walkX, walkY, left, right } = pose;

  const elements: string[] = [];

  if (!transparent) {
    elements.push(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);
  }

  const isBack = walkY < -0.5; // 후면 우세 → 등(뒤통수) 어둡게.

  // 레이블 (불투명 모드에서만)
  if (!transparent) {
    const cosp = Math.cos(phase);
    const isContact = Math.abs(cosp) > 0.85;
    const isCrossover = Math.abs(cosp) < 0.15;
    const dirName = DIR_NAMES[dirIndex] ?? "?";
    const phaseLabel = isContact ? "CONTACT" : isCrossover ? "PASSING" : `f${frame}`;
    elements.push(`<text x="${W/2}" y="16" text-anchor="middle" fill="#aaaaff" font-family="monospace" font-size="11">${dirName} ${phaseLabel}</text>`);
  }

  // 머리 — 후면은 어둡게 채워 등(뒤통수)을 표현. 다리 색은 legend(파랑=왼,빨강=오) 유지.
  const headColor = isBack ? "#7a6038" : "#f0c080";
  elements.push(circle(CX, HEAD_Y, HEAD_R, headColor));

  // facing 단서(코): 후면이 아니고 좌우 진행 성분이 있으면 머리에서 진행방향으로 짧게 돌출.
  // 순수 측면(LEFT↔RIGHT)·전면 대각은 머리·몸통이 대칭이라 발끝만으론 좌우 구분이 약함 →
  // 모델이 facing을 안정적으로 읽도록 코를 추가. 정면/후면(walkX≈0)은 머리색으로 이미 구분.
  if (!isBack && Math.abs(walkX) > SIDE_WALKX_THRESHOLD) {
    // 실제 진행방향(walkX,walkY)으로 코를 꺾어 대각선 방향을 명확히 표현.
    // endpoint 각도 관례: 0°=아래, 90°=오른쪽. atan2(walkX,walkY)가 이 관례와 일치.
    const faceDeg = (Math.atan2(walkX, walkY) * 180) / Math.PI;
    const noseStart = endpoint(CX, HEAD_Y, faceDeg, HEAD_R * 0.4);
    const noseEnd   = endpoint(CX, HEAD_Y, faceDeg, HEAD_R + 8);
    elements.push(line(noseStart.x, noseStart.y, noseEnd.x, noseEnd.y, headColor, 6));
  }

  // 목 + 어깨 가로선
  elements.push(line(CX, NECK_Y, CX, SHOULDER_Y, "#f0c080", 4));
  elements.push(line(CX - 20, SHOULDER_Y, CX + 20, SHOULDER_Y, "#f0c080", 4));

  // 팔: 다리와 반대 위상으로 스윙(측면). 정면/후면은 좌우 약하게 흔들림.
  const A = pose.A;
  const armMult = isRun ? 0.85 : 0.6;
  const cosp = Math.cos(phase);
  const leftArmAngle  = -A * armMult * walkX * cosp;
  const rightArmAngle =  A * armMult * walkX * cosp;
  // 정면/후면 팔 좌우 흔들림(swingAngle이 0이라 별도 성분).
  const armLateral = STEP_W * 0.55 * Math.abs(walkY) * cosp;

  // 달리기: 몸통 앞으로 기울음 (어깨가 엉덩이보다 진행방향 앞으로).
  const leanX = isRun ? 10 * Math.sign(walkX) : 0;
  const shoulderX = CX + leanX;

  // 왼팔(파랑)
  const lShoulder = { x: shoulderX - 20, y: SHOULDER_Y };
  const lElbow = endpoint(lShoulder.x + armLateral, lShoulder.y, leftArmAngle, UPPER_ARM);
  const lHand  = endpoint(lElbow.x, lElbow.y, leftArmAngle * (isRun ? 0.8 : 0.5), LOWER_ARM);
  elements.push(line(lShoulder.x, lShoulder.y, lElbow.x, lElbow.y, "#80c0f0", 4));
  elements.push(line(lElbow.x, lElbow.y, lHand.x, lHand.y, "#80c0f0", 3));

  // 오른팔(빨강)
  const rShoulder = { x: shoulderX + 20, y: SHOULDER_Y };
  const rElbow = endpoint(rShoulder.x - armLateral, rShoulder.y, rightArmAngle, UPPER_ARM);
  const rHand  = endpoint(rElbow.x, rElbow.y, rightArmAngle * (isRun ? 0.8 : 0.5), LOWER_ARM);
  elements.push(line(rShoulder.x, rShoulder.y, rElbow.x, rElbow.y, "#f08080", 4));
  elements.push(line(rElbow.x, rElbow.y, rHand.x, rHand.y, "#f08080", 3));

  // 몸통
  elements.push(line(shoulderX, SHOULDER_Y, CX, HIP_Y, "#f0c080", 5));
  elements.push(circle(CX, HIP_Y, 5, "#f0c080"));

  // 다리 한쪽 렌더 헬퍼. hipX는 좌우 벌림(lateral) 적용된 엉덩이 x.
  // walkY=0(측면)이면 lateral=depthY=0 → OLD 사이드뷰와 동일.
  function renderLeg(leg: LegPose, color: string, jointColor: string) {
    const hipX = CX + leg.lateral;
    const knee = endpoint(hipX, HIP_Y, leg.swingAngle, UPPER_LEG);
    const shin = lowerLegAngle(leg, isRun);
    const foot = endpoint(knee.x, knee.y, shin, LOWER_LEG);
    // 깊이: 전진발(전면)은 아래로, 후면은 위로. 발 + 발끝 y 동시 이동.
    const footY = foot.y + leg.depthY;
    elements.push(line(hipX, HIP_Y, knee.x, knee.y, color, 6));
    elements.push(line(knee.x, knee.y, foot.x, footY, color, 5));
    elements.push(circle(knee.x, knee.y, 5, jointColor));
    // 발끝: 진행방향(walkX,walkY)의 스크린 방향으로 꺾는다 — 측면=수평, 대각선=대각
    // (예: DOWN-RIGHT는 우하향). endpoint 각도(수직 기준): RIGHT=90°, DOWN-RIGHT=45°.
    // walkY를 무시한 수평 발끝이 "대각으로 걷는데 발은 옆" 방향 불일치를 일으키던 문제 수정.
    if (Math.abs(walkX) > SIDE_WALKX_THRESHOLD) {
      const faceDeg = (Math.atan2(walkX, walkY) * 180) / Math.PI;
      const tip = endpoint(foot.x, footY, faceDeg + leg.swingAngle * 0.2, 14);
      elements.push(line(foot.x, footY, tip.x, tip.y, color, 4));
    } else {
      // 발끝을 바깥쪽으로(왼발 왼쪽, 오른발 오른쪽) — 정면/후면 자연스러운 발 방향.
      elements.push(line(foot.x, footY, foot.x + leg.side * 9, footY, color, 4));
    }
  }

  renderLeg(left,  "#4fc3f7", "#4fc3f7");
  renderLeg(right, "#ef5350", "#ef5350");

  if (!transparent) {
    const txt = legAngleText(left, right, walkX, walkY);
    elements.push(`<text x="4" y="${H - 20}" fill="#4fc3f7" font-family="monospace" font-size="10">L:${txt.l}</text>`);
    elements.push(`<text x="${W - 64}" y="${H - 20}" fill="#ef5350" font-family="monospace" font-size="10">R:${txt.r}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${elements.join("")}</svg>`;
}

/**
 * depthY → 전후(fore/aft) 분류. fwd=진행방향 발(depthY*walkY>0). |depthY|<2px=중립(mid).
 * UP(walkY<0)에서는 화면 아래(depthY>0)가 후방이므로 walkY로 부호 보정해야 한다(버그).
 * verbose=true면 화면 높이 단서(lower/higher) 병기. legAngleText·poseToFrameAngle 공용 소스.
 */
function classifyForeAft(depthY: number, verbose: boolean, walkY = 1): string {
  if (Math.abs(depthY) < 2) return "mid";
  const isFwd = depthY * walkY > 0;
  if (verbose) return isFwd
    ? (walkY >= 0 ? "fwd(lower)" : "fwd(higher)")
    : (walkY >= 0 ? "back(higher)" : "back(lower)");
  return isFwd ? "fwd" : "back";
}

/**
 * 두 다리 → 셀 내 디버그 각도 텍스트(이미지 라벨용).
 * 측면/대각선(walkX 유의): 스윙각. 정면/후면(walkX≈0): 전후(fwd/back) 오프셋 언어.
 */
function legAngleText(left: LegPose, right: LegPose, walkX: number, walkY: number) {
  if (Math.abs(walkX) < SIDE_WALKX_THRESHOLD) {
    // 정면/후면: 깊이(depthY) 부호로 fore/aft.
    return { l: classifyForeAft(left.depthY, false, walkY), r: classifyForeAft(right.depthY, false, walkY) };
  }
  return {
    l: `${left.swingAngle >= 0 ? "+" : ""}${left.swingAngle.toFixed(0)}°`,
    r: `${right.swingAngle >= 0 ? "+" : ""}${right.swingAngle.toFixed(0)}°`,
  };
}

/** 프레임 하나의 다리 각도/위상 데이터. */
export type FrameAngle = {
  col: number;          // 0-based 컬럼 인덱스
  leftDeg: number;      // 왼발 스윙각(양수=전진, 음수=후진). 정면/후면은 0이라 무의미.
  rightDeg: number;     // 오른발 스윙각
  label: string;        // "L-CONTACT" | "PASSING" | "R-CONTACT" | "f{n}"
  /** 정면/후면 전후 오프셋 텍스트(예 "L foot fwd(lower)/R foot back(higher)"). 측면이면 null. */
  foreAft: string | null;
};

/** 한 프레임의 computePose 결과 → FrameAngle(각도 텍스트의 단일 소스). */
function poseToFrameAngle(col: number, totalFrames: number, dirIndex: number, isRun: boolean): FrameAngle {
  const { walkX, walkY, left, right, phase } = computePose(col, totalFrames, dirIndex, isRun);
  const leftDeg = Math.round(left.swingAngle);
  const rightDeg = Math.round(right.swingAngle);
  const cosP = Math.cos(phase);
  const absC = Math.abs(cosP);
  // 정면/후면(walkX≈0): 스윙각 0이라 degenerate → 전후(fore/aft) 오프셋 언어로.
  if (Math.abs(walkX) < SIDE_WALKX_THRESHOLD) {
    // L-CONTACT = 왼발이 진행방향 앞(depthY*walkY>0). UP(walkY<0)에서 부호 보정 필수.
    const label = absC > 0.85 ? (left.depthY * walkY > 0 ? "L-CONTACT" : "R-CONTACT") : absC < 0.15 ? "PASSING" : `f${col}`;
    return { col, leftDeg, rightDeg, label, foreAft: `L foot ${classifyForeAft(left.depthY, true, walkY)}/R foot ${classifyForeAft(right.depthY, true, walkY)}` };
  }
  // L-CONTACT = 왼발이 진행방향 앞. LEFT(walkX<0)에서 swingAngle 부호가 뒤집히므로 sign(walkX) 보정.
  const label = absC > 0.85 ? (leftDeg * Math.sign(walkX) > 0 ? "L-CONTACT" : "R-CONTACT") : absC < 0.15 ? "PASSING" : `f${col}`;
  return { col, leftDeg, rightDeg, label, foreAft: null };
}

/**
 * cols 프레임 사이클의 각도 배열을 계산. computePose와 동일 소스(이미지와 영원히 일치).
 * dirIndex 기본값 6=RIGHT(기존 단일행 fallback 동작 유지).
 */
export function computeFrameAngles(cols: number, isRun = false, dirIndex = 6): FrameAngle[] {
  return Array.from({ length: cols }, (_, c) => poseToFrameAngle(c, cols, dirIndex, isRun));
}

/**
 * pose-guided-walk-8dir.png(또는 run 변형)에서 dirIndex 행의 프레임을 추출해
 * cols×rows 그리드로 재배열한 포즈 가이드 PNG를 반환.
 *
 * 소스는 8방향×8프레임 고정(3072×3072, 셀=384×384).
 * totalFrames = cols×rows 개를 8 소스 프레임에서 균등 샘플링.
 *
 * @returns { path, angles } — 캐시 파일 경로 + 프레임별 각도 데이터
 */
export async function extractPoseGuideGrid(
  dirIndex: number,
  cols: number,
  rows: number,
  cellSize: number,
  referenceDir: string,
  templatesDir: string,
  isRun = false,
): Promise<{ path: string; angles: FrameAngle[] }> {
  const type = isRun ? "run" : "walk";
  const cacheFile = `${templatesDir}/pose-${type}-dir${dirIndex}-${cols}x${rows}.png`;
  const totalFrames = cols * rows;
  const SOURCE_COLS = 8; // 소스 시트 열 수 (방향당 프레임 수 = 샘플링 범위)
  const SOURCE_ROWS = 8; // 소스 시트 행 수 (방향 수 = dirIndex 유효 범위)

  // Math.floor로 균등 분할 — Math.round는 경계값(i=totalFrames-1)에서 wrap 발생.
  const srcCols = Array.from({ length: totalFrames }, (_, i) =>
    Math.floor((i * SOURCE_COLS) / totalFrames),
  );

  // angles는 실제 추출 srcCol의 위상(SOURCE_COLS=8 기준)에서 computePose로 직접 산출 —
  // 이미지(소스 8프레임)와 동일 위상이라야 텍스트↔이미지 일치.
  const angles: FrameAngle[] = srcCols.map((srcCol, i) => ({
    ...poseToFrameAngle(srcCol, SOURCE_COLS, dirIndex, isRun),
    col: i,
  }));

  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  if (existsSync(cacheFile)) return { path: cacheFile, angles };

  mkdirSync(templatesDir, { recursive: true });

  const refFile = `${referenceDir}/pose-guided-${type}-8dir.png`;
  const meta = await sharp(refFile).metadata();
  const srcCellW = Math.round((meta.width ?? 3072) / SOURCE_COLS);
  const srcCellH = Math.round((meta.height ?? 3072) / SOURCE_ROWS);

  // 소스 시트에서 dirIndex 행의 각 프레임을 추출 후 cellSize로 리사이즈
  const frames = await Promise.all(
    srcCols.map(srcCol =>
      sharp(refFile)
        .extract({ left: srcCol * srcCellW, top: dirIndex * srcCellH, width: srcCellW, height: srcCellH })
        .resize(cellSize, cellSize)
        .png()
        .toBuffer(),
    ),
  );

  // cols×rows 그리드로 배치 (reading order: 왼→오, 위→아래)
  const composites = frames.map((buf, i) => ({
    input: buf,
    left: (i % cols) * cellSize,
    top: Math.floor(i / cols) * cellSize,
    blend: "over" as const,
  }));

  const buf = await sharp({
    create: { width: cols * cellSize, height: rows * cellSize, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  writeFileSync(cacheFile, buf);
  return { path: cacheFile, angles };
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
  const angles = computeFrameAngles(cols, isRun, dirIndex);

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

/**
 * 다중방향(2/4/8) 포즈 가이드: 출력 행마다 다른 dirIndex를 매핑해 n행×cols열 가이드 PNG 생성.
 * 행 dirIndex는 dirIndices(directionLabels(n) 순서와 정확히 일치)로 전달받는다.
 *   n=2 → [2,6] / n=4 → [0,2,6,4] / n=8 → [0..7].
 * buildPoseSvg로 직접 렌더(전제 PNG 불필요) — 각 행은 cols 프레임 완전 사이클.
 *
 * NOTE: 다중방향 포즈 가이드의 codex 생성 효과는 모델 의존·미검증(메모리 경고 준수).
 *
 * @returns { path, rows } — 캐시 파일 경로 + 행별(=방향별) 프레임 각도 데이터
 */
export async function getMultiDirPoseGuide(
  dirIndices: number[],
  cols: number,
  cellSize: number,
  templatesDir: string,
  isRun = false,
): Promise<{ path: string; rows: { dirIndex: number; angles: FrameAngle[] }[] }> {
  const type = isRun ? "run" : "walk";
  const rows = dirIndices.length;
  // dirIndices(0~7 각 한 자리)를 키에 포함 — 같은 행 수의 다른 방향셋이 캐시 충돌하지 않게.
  const cacheFile = `${templatesDir}/pose-${type}-multidir${dirIndices.join("")}-c${cols}.png`;

  const rowsData = dirIndices.map(dirIndex => ({
    dirIndex,
    angles: computeFrameAngles(cols, isRun, dirIndex),
  }));

  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  if (existsSync(cacheFile)) return { path: cacheFile, rows: rowsData };

  mkdirSync(templatesDir, { recursive: true });

  const skelH = Math.round(cellSize * 0.65);
  const skelW = Math.round(skelH * (W / H));
  const offsetX = Math.round((cellSize - skelW) / 2);
  const offsetY = Math.round((cellSize - skelH) * 0.35);

  const composites: { input: Buffer; left: number; top: number; blend: "over" }[] = [];
  for (let r = 0; r < rows; r++) {
    const dirIndex = dirIndices[r];
    for (let c = 0; c < cols; c++) {
      const svg = buildPoseSvg(c, cols, true, dirIndex, isRun);
      const buf = await sharp(Buffer.from(svg)).resize(skelW, skelH).png().toBuffer();
      composites.push({
        input: buf,
        left: c * cellSize + offsetX,
        top: r * cellSize + offsetY,
        blend: "over",
      });
    }
  }

  const buf = await sharp({
    create: { width: cols * cellSize, height: rows * cellSize, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  writeFileSync(cacheFile, buf);
  return { path: cacheFile, rows: rowsData };
}

/**
 * 레퍼런스 PNG 재생성용: 8방향(행)×totalCols(열) 그리드 SVG/PNG 합성 버퍼 반환.
 * scripts/gen-pose-guides.ts가 사용. 셀=cellSize, 흰 배경 + 옅은 그리드선 + 투명 스켈레톤 중앙 배치.
 */
export async function buildEightDirReferenceSheet(cellSize: number, isRun: boolean): Promise<Buffer> {
  const SOURCE_DIRS = 8;
  const SOURCE_FRAMES = 8;
  const skelH = Math.round(cellSize * 0.65);
  const skelW = Math.round(skelH * (W / H));
  const offsetX = Math.round((cellSize - skelW) / 2);
  const offsetY = Math.round((cellSize - skelH) * 0.35);
  const canvas = SOURCE_DIRS * cellSize;

  // 옅은 그리드선(OLD 레퍼런스와 동일: 204,204,204)
  const gridLines: string[] = [];
  for (let i = 1; i < SOURCE_DIRS; i++) {
    gridLines.push(`<line x1="${i * cellSize}" y1="0" x2="${i * cellSize}" y2="${canvas}" stroke="#cccccc" stroke-width="1"/>`);
    gridLines.push(`<line x1="0" y1="${i * cellSize}" x2="${canvas}" y2="${i * cellSize}" stroke="#cccccc" stroke-width="1"/>`);
  }
  const gridSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">${gridLines.join("")}</svg>`;
  const gridBuf = await sharp(Buffer.from(gridSvg)).png().toBuffer();

  const composites: { input: Buffer; left: number; top: number; blend: "over" }[] = [
    { input: gridBuf, left: 0, top: 0, blend: "over" },
  ];
  for (let dir = 0; dir < SOURCE_DIRS; dir++) {
    for (let f = 0; f < SOURCE_FRAMES; f++) {
      const svg = buildPoseSvg(f, SOURCE_FRAMES, true, dir, isRun);
      const buf = await sharp(Buffer.from(svg)).resize(skelW, skelH).png().toBuffer();
      composites.push({
        input: buf,
        left: f * cellSize + offsetX,
        top: dir * cellSize + offsetY,
        blend: "over",
      });
    }
  }

  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
