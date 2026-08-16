/**
 * 모션 페이즈 가이드 — sprite_gen/prepare.py `RUN_PHASE_CYCLE` · `leg_points()` ·
 * `draw_motion_phase()` · `state_motion_phases()` 이식.
 *
 * 8프레임 로코모션 행의 레이아웃 가이드 칸마다 막대 인간 포즈 힌트를 그린다. 목적은
 * 발 접지·몸통 높이·다리 위상을 밀어주는 것이고, **최종 아트가 아니며 생성 결과에
 * 나타나서는 안 된다**(프롬프트가 그렇게 못박는다).
 *
 * 정본 체크리스트 3번이 이것을 요구한다: 로코모션 행에 단일 피크 포즈 앵커를 주면 한
 * 접지 포즈가 모든 프레임의 다리 위상을 고정한다. 양쪽 접지가 다 보이는 위상 참조가
 * 필요하고, 이 가이드가 그 후보 중 하나다(나머지는 접촉 시트·선택 사이클).
 *
 * **명시적 로코모션 실험 전용 옵트인이다.** 정본 자신이 *"다리 교대를 개선할 수는 있지만
 * 자연스러운 달리기 루프를 보장하지 않고, 시각 모션 QA 는 여전히 BLOCKING"* 이라고 적었다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */

export type MotionPhase = {
  name: string;
  bodyY: number;
  frontLeg: string;
  backLeg: string;
  note: string;
};

/** 달리기 한 주기 8프레임. 5번째부터는 좌우가 바뀐 같은 네 페이즈다. */
export const RUN_PHASE_CYCLE: readonly MotionPhase[] = [
  { name: "contact", bodyY: 0, frontLeg: "forward_straight", backLeg: "back_extended", note: "front foot contacts ground, back foot pushes off" },
  { name: "down", bodyY: 6, frontLeg: "under_bent", backLeg: "back_bent", note: "weight drops over planted foot" },
  { name: "passing", bodyY: 2, frontLeg: "under_vertical", backLeg: "passing_forward", note: "swing leg passes under body" },
  { name: "up", bodyY: -6, frontLeg: "back_lifted", backLeg: "forward_lifted", note: "body lifts before the opposite contact" },
  { name: "opposite_contact", bodyY: 0, frontLeg: "back_extended", backLeg: "forward_straight", note: "opposite foot contacts ground" },
  { name: "opposite_down", bodyY: 6, frontLeg: "back_bent", backLeg: "under_bent", note: "weight drops over the opposite planted foot" },
  { name: "opposite_passing", bodyY: 2, frontLeg: "passing_forward", backLeg: "under_vertical", note: "first leg passes under body" },
  { name: "opposite_up", bodyY: -6, frontLeg: "forward_lifted", backLeg: "back_lifted", note: "body lifts back toward frame 1" },
];

const PHASE_STATES = new Set(["running-right", "running-left", "run", "walk"]);
const PHASE_PREFIXES = ["running-front-", "running-back-", "walking-front-", "walking-back-"];

/**
 * 이 상태·프레임 수에 페이즈가 있는가. **8프레임이 아니면 빈 배열이다** — 원본 그대로다.
 * 주기 자체가 8단계(접지·down·passing·up ×2)라 다른 프레임 수에는 매핑이 없다.
 */
export function stateMotionPhases(state: string, frames: number): readonly MotionPhase[] {
  if (frames !== 8) return [];
  if (PHASE_STATES.has(state)) return RUN_PHASE_CYCLE;
  if (PHASE_PREFIXES.some(p => state.startsWith(p))) return RUN_PHASE_CYCLE;
  return [];
}

/**
 * Python `round()` — 반올림이 아니라 **은행가 반올림**(half to even)이다.
 * 원본 좌표가 전부 이 함수를 거치므로 JS `Math.round`(half up)를 쓰면 어긋난다.
 */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

type Point = [number, number];

function mirroredX(centerX: number, x: number, facing: string): number {
  return facing === "left" ? centerX - (x - centerX) : x;
}

/** 다리 포즈 이름 → (무릎, 발) 좌표. 원본의 분기와 계수를 그대로 옮겼다. */
export function legPoints(
  root: Point,
  pose: string,
  facing: string,
  scale: number,
): { knee: Point; foot: Point } {
  const [rootX, rootY] = root;
  const forward = pyRound(34 * scale);
  const back = pyRound(32 * scale);
  const down = pyRound(54 * scale);
  const bend = pyRound(24 * scale);
  // 원본에 `lift = round(22 * scale)` 가 있으나 어느 분기에서도 쓰이지 않는다.
  // 원래 있던 dead code 이므로 이식하지 않고 여기 사실만 적는다.

  let knee: Point;
  let foot: Point;
  switch (pose) {
    case "forward_straight":
      knee = [rootX + pyRound(forward * 0.45), rootY + pyRound(down * 0.48)];
      foot = [rootX + forward, rootY + down];
      break;
    case "back_extended":
      knee = [rootX - pyRound(back * 0.45), rootY + pyRound(down * 0.48)];
      foot = [rootX - back, rootY + down];
      break;
    case "under_bent":
      knee = [rootX + pyRound(bend * 0.2), rootY + pyRound(down * 0.45)];
      foot = [rootX + pyRound(bend * 0.55), rootY + pyRound(down * 0.82)];
      break;
    case "back_bent":
      knee = [rootX - pyRound(bend * 0.65), rootY + pyRound(down * 0.42)];
      foot = [rootX - pyRound(bend * 0.2), rootY + pyRound(down * 0.78)];
      break;
    case "passing_forward":
      knee = [rootX + pyRound(bend * 0.45), rootY + pyRound(down * 0.35)];
      foot = [rootX + pyRound(bend * 0.1), rootY + pyRound(down * 0.63)];
      break;
    case "under_vertical":
      knee = [rootX, rootY + pyRound(down * 0.42)];
      foot = [rootX, rootY + pyRound(down * 0.88)];
      break;
    case "forward_lifted":
      knee = [rootX + pyRound(forward * 0.45), rootY + pyRound(down * 0.18)];
      foot = [rootX + pyRound(forward * 0.7), rootY + pyRound(down * 0.35)];
      break;
    case "back_lifted":
      knee = [rootX - pyRound(back * 0.45), rootY + pyRound(down * 0.18)];
      foot = [rootX - pyRound(back * 0.7), rootY + pyRound(down * 0.35)];
      break;
    default:
      knee = [rootX, rootY + pyRound(down * 0.45)];
      foot = [rootX, rootY + down];
  }
  if (facing === "left") {
    knee = [rootX - (knee[0] - rootX), knee[1]];
    foot = [rootX - (foot[0] - rootX), foot[1]];
  }
  return { knee, foot };
}

// ── PIL 래스터화 재현 ─────────────────────────────────────────────────────────
//
// 레이아웃 가이드의 통과 기준이 Python 출력과의 픽셀 동일이라(§6.2) 선·타원도 PIL 과
// 같은 알고리즘으로 그려야 한다. PIL 은 안티앨리어싱을 하지 않고, 굵은 선을 **사각형
// 폴리곤으로 바꿔 스캔라인 채우기**로 그린다 (Draw.c `ImagingDrawWideLine`).

/** PIL `ROUND_UP` — 0 에서 먼 쪽으로 반올림. */
function roundUp(f: number): number {
  return f >= 0 ? Math.floor(f + 0.5) : -Math.floor(Math.abs(f) + 0.5);
}

/** PIL `ROUND_DOWN` — 0 쪽으로 반올림. */
function roundDown(f: number): number {
  return f >= 0 ? Math.ceil(f - 0.5) : -Math.ceil(Math.abs(f) - 0.5);
}

export type Canvas = { raw: Buffer; width: number; height: number };
type RGB = readonly [number, number, number];

function setPixel(c: Canvas, x: number, y: number, color: RGB): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (y * c.width + x) * 3;
  c.raw[o] = color[0];
  c.raw[o + 1] = color[1];
  c.raw[o + 2] = color[2];
}

function hline(c: Canvas, x0: number, y: number, x1: number, color: RGB): void {
  if (y < 0 || y >= c.height || x1 < x0) return;
  for (let x = Math.max(0, x0); x <= Math.min(c.width - 1, x1); x++) setPixel(c, x, y, color);
}

type Edge = { x0: number; y0: number; ymin: number; ymax: number; dx: number };

function addEdge(x0: number, y0: number, x1: number, y1: number): Edge {
  return {
    x0,
    y0,
    ymin: Math.min(y0, y1),
    ymax: Math.max(y0, y1),
    dx: y0 === y1 ? 0 : (x1 - x0) / (y1 - y0),
  };
}

/** PIL `polygon_generic` — 수평 스캔라인 교점 쌍을 채운다(even-odd 아님, 순서쌍). */
function fillPolygon(c: Canvas, vertices: Point[], color: RGB): void {
  const edges: Edge[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (a[1] === b[1]) continue; // 수평 변은 교점을 만들지 않는다
    edges.push(addEdge(a[0], a[1], b[0], b[1]));
  }
  if (edges.length === 0) return;
  let ymin = Math.min(...edges.map(e => e.ymin));
  let ymax = Math.max(...edges.map(e => e.ymax));
  if (ymin < 0) ymin = 0;
  if (ymax > c.height) ymax = c.height;

  // 변의 y 구간을 **반열림**으로 다룬다: 스캔라인이 꼭짓점을 정확히 지날 때 그 점을
  // 공유하는 두 변이 교점을 각각 내면 짝짓기가 한 칸씩 밀려 그 줄이 통째로 비어 버린다
  // (실측: 폭 5 대각선에서 y=6 한 줄만 7px → 1px). 폴리곤 전체의 마지막 줄만 예외로 둔다.
  const globalYmax = Math.max(...edges.map(e => e.ymax));
  for (let y = ymin; y <= ymax; y++) {
    const xs: number[] = [];
    for (const e of edges) {
      if (y < e.ymin || y > e.ymax) continue;
      if (y === e.ymax && e.ymax !== globalYmax) continue;
      xs.push((y - e.y0) * e.dx + e.x0);
    }
    if (xs.length === 0) continue;
    xs.sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i += 2) {
      hline(c, roundUp(xs[i - 1]), y, roundDown(xs[i]), color);
    }
  }
}

/** PIL `draw->line` — Bresenham, 폭 1. */
function drawThinLine(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: RGB): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let x = x0;
  let y = y0;
  if (dx >= dy) {
    let err = dx / 2;
    for (let i = 0; i <= dx; i++) {
      setPixel(c, x, y, color);
      err -= dy;
      if (err < 0) {
        y += sy;
        err += dx;
      }
      x += sx;
    }
  } else {
    let err = dy / 2;
    for (let i = 0; i <= dy; i++) {
      setPixel(c, x, y, color);
      err -= dx;
      if (err < 0) {
        x += sx;
        err += dy;
      }
      y += sy;
    }
  }
}

/** PIL `ImagingDrawWideLine` — 폭 > 1 이면 사각형 폴리곤을 채운다. */
export function drawWideLine(
  c: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGB,
  width: number,
): void {
  if (width <= 1) {
    drawThinLine(c, x0, y0, x1, y1, color);
    return;
  }
  const bigHyp = Math.hypot(x1 - x0, y1 - y0);
  if (bigHyp === 0) return;
  const smallHyp = (width - 1) / 2;
  const ratioMax = roundUp(smallHyp) / bigHyp;
  const ratioMin = roundDown(smallHyp) / bigHyp;
  const dxmin = roundDown(ratioMin * (y1 - y0));
  const dxmax = roundUp(ratioMax * (y1 - y0));
  const dymin = roundDown(ratioMin * (x1 - x0));
  const dymax = roundUp(ratioMax * (x1 - x0));
  fillPolygon(
    c,
    [
      [x0 - dxmin, y0 + dymax],
      [x1 - dxmin, y1 + dymax],
      [x1 + dxmax, y1 - dymin],
      [x0 + dxmax, y0 - dymin],
    ],
    color,
  );
}

/** PIL `draw.line(points, width)` — 이음매 처리 없이 구간마다 굵은 선. */
export function drawPolyline(c: Canvas, points: Point[], color: RGB, width: number): void {
  for (let i = 0; i + 1 < points.length; i++) {
    drawWideLine(c, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], color, width);
  }
}

/**
 * 행별 x 범위 — 1도 간격 샘플의 min/max. 볼록 곡선이라 이것으로 충분하다.
 *
 * 여기가 원본과 픽셀 동일이 아닌 **유일한 지점**이다 — 아래 drawEllipseOutline 주석 참조.
 */
function ellipseSpans(cx: number, cy: number, rx: number, ry: number): Map<number, [number, number]> {
  const spans = new Map<number, [number, number]>();
  if (rx < 0 || ry < 0) return spans;
  for (let deg = 0; deg < 360; deg++) {
    const t = (deg * Math.PI) / 180;
    const x = Math.round(cx + rx * Math.cos(t));
    const y = Math.round(cy + ry * Math.sin(t));
    const cur = spans.get(y);
    if (!cur) spans.set(y, [x, x]);
    else spans.set(y, [Math.min(cur[0], x), Math.max(cur[1], x)]);
  }
  return spans;
}

/**
 * `draw.ellipse(bbox, outline, width)` — 바깥 타원과 안쪽 타원 사이의 띠.
 *
 * **이식한 렌더러 중 유일하게 원본과 픽셀 동일이 아니다.** 선·팔·척추·접지선은 전부
 * 바이트 동일인데 이 타원만 다르다.
 *
 * PIL 은 타원을 각도로 샘플링한 점들의 폴리곤으로 그린다 — 그래서 지름 29 원의 꼭대기
 * 줄이 1px 이 아니라 **7px 로 평평하다**(여러 각도가 같은 y 로 반올림된다). 같은 모델을
 * 쓰되 반올림 규칙을 맞추지 못했다: 후보 여럿을 원본 덤프에 대고 맞춰 봤으나
 * (round/trunc/floor 조합, 1도·0.5도 스텝, 폴리라인·스팬 렌더) 어느 것도 일치하지
 * 않았다. 지금 것이 그중 가장 가깝고, 우리 링이 원본보다 **한 픽셀 두껍다**(원본이
 * 그리는 픽셀을 빠뜨리지는 않는다 — 항상 상위집합이다).
 *
 * 실측 잔차는 8프레임 256셀 가이드에서 528/524288 px(0.101%)이고 전부 이 타원이다.
 * `scripts/test-layout-guide.ts` 가 이 값을 상한으로 잠가 조용히 벌어지지 않게 한다.
 */
export function drawEllipseOutline(
  c: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGB,
  width: number,
): void {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const outer = ellipseSpans(cx, cy, (x1 - x0) / 2, (y1 - y0) / 2);
  const inner = ellipseSpans(cx, cy, (x1 - x0) / 2 - width, (y1 - y0) / 2 - width);
  for (const [y, [left, right]] of outer) {
    const hole = inner.get(y);
    for (let x = left; x <= right; x++) {
      if (hole && x > hole[0] && x < hole[1]) continue;
      setPixel(c, x, y, color);
    }
  }
}

// ── 페이즈 그리기 ────────────────────────────────────────────────────────────

const SPINE: RGB = [0x6b, 0x72, 0x80];
const FRONT_ARM: RGB = [0x94, 0xa3, 0xb8];
const BACK_ARM: RGB = [0xcb, 0xd5, 0xe1];
const FRONT_LEG: RGB = [0xef, 0x44, 0x44];
const BACK_LEG: RGB = [0x25, 0x63, 0xeb];
const GROUND: RGB = [0xcb, 0xd5, 0xe1];

/** 한 칸에 막대 인간 하나. 좌표·색·굵기 전부 원본 그대로다. */
export function drawMotionPhase(
  c: Canvas,
  slotLeft: number,
  cellWidth: number,
  cellHeight: number,
  phase: MotionPhase,
  facing: string,
): void {
  const scale = Math.min(cellWidth / 192, cellHeight / 208);
  const centerX = slotLeft + Math.floor(cellWidth / 2);
  const hipY = pyRound(cellHeight * 0.52 + phase.bodyY * scale);
  const shoulderY = hipY - pyRound(42 * scale);
  const headY = shoulderY - pyRound(26 * scale);

  const headR = pyRound(11 * scale);
  drawEllipseOutline(
    c,
    centerX - headR,
    headY - headR,
    centerX + headR,
    headY + headR,
    SPINE,
    Math.max(1, pyRound(2 * scale)),
  );
  drawWideLine(c, centerX, shoulderY, centerX, hipY, SPINE, Math.max(2, pyRound(3 * scale)));

  const frontArm: Point = [
    mirroredX(centerX, centerX - pyRound(26 * scale), facing),
    shoulderY + pyRound(30 * scale),
  ];
  const backArm: Point = [
    mirroredX(centerX, centerX + pyRound(26 * scale), facing),
    shoulderY + pyRound(18 * scale),
  ];
  const armWidth = Math.max(1, pyRound(2 * scale));
  drawWideLine(c, centerX, shoulderY, frontArm[0], frontArm[1], FRONT_ARM, armWidth);
  drawWideLine(c, centerX, shoulderY, backArm[0], backArm[1], BACK_ARM, armWidth);

  const hip: Point = [centerX, hipY];
  const front = legPoints(hip, phase.frontLeg, facing, scale);
  const back = legPoints(hip, phase.backLeg, facing, scale);
  const legWidth = Math.max(2, pyRound(4 * scale));
  drawPolyline(c, [hip, front.knee, front.foot], FRONT_LEG, legWidth);
  drawPolyline(c, [hip, back.knee, back.foot], BACK_LEG, legWidth);

  const groundY = pyRound(cellHeight * 0.52 + 54 * scale + phase.bodyY * scale);
  drawWideLine(
    c,
    slotLeft + pyRound(34 * scale),
    groundY,
    slotLeft + cellWidth - pyRound(34 * scale),
    groundY,
    GROUND,
    1,
  );
}
