// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `anatomy.py` 이식 — 실루엣 해부.
// 원본: sprite-gen/sprite_gen/anatomy.py (Apache-2.0)

/**
 * 호흡 변형이 **어디까지 미쳐야 하는지**를 기하로 정한다. AI 개입 0.
 *
 * "가슴선 하나" 로 정의하려는 접근은 임의 몬스터에 일반화되지 않는다 — 가슴은
 * 해부학 개념이라 버섯(몸통에 얼굴)·박쥐(옆으로 뻗은 날개)·슬라임(목이 없음)에서
 * 서로 다른 것을 뜻한다. 그래서 이 모듈은 **변형시키면 안 되는 영역**을 찾는다:
 *
 *   · 목  — 폭 프로파일의 병목. 있으면 그 위는 머리다.
 *   · 얼굴 — 좌우 대칭 눈쌍. 목이 없거나 목이 얼굴을 관통할 때 이쪽이 경계를 정한다.
 *   · 부속 — 몸통 반폭을 크게 넘는 가로 질량(날개·긴 팔). 늘리지 말고 밀어야 한다.
 *
 * 셋 다 실패해도 **조용히 넘어가지 않는다** — 무엇으로 판정했는지(`neckSource`)와
 * 무엇을 못 찾았는지(`face === null`)가 결과에 그대로 남는다.
 */

import {
  ALPHA_SOLID,
  maskComponents,
  smoothProfile,
  solidAlphaBBox,
  type Box,
  type Frame,
} from "@/lib/sprite/silhouette";

/** 부속 인정 임계 — 최대반폭이 몸통반폭의 이 배를 넘어야 "옆으로 뻗은 것". */
export const APPENDAGE_RATIO = 1.3;
/** 병목 인정 임계 — prominence 가 최대폭의 이 비율을 넘어야 진짜 목이다. */
export const BOTTLENECK_PROMINENCE = 0.06;
const EYE_MAX_EXTENT = 0.2;
const EYE_ASPECT: [number, number] = [0.4, 2.5];
const EYE_MIN_AREA = 0.002;
const EYE_MAX_AREA = 0.06;
const EYE_TOP_LIMIT = 0.65;
const DARK_QUANTILE = 0.3;

export type Anatomy = {
  width: number;
  height: number;
  /** 몸통 세로축 (알파 무게중심 x), 콘텐츠 bbox 기준. */
  axis_x: number;
  /** 정수리 기준 행. */
  neck_row: number;
  neck_source: "bottleneck" | "shoulder-gradient";
  /** 이 위는 변형하지 않는다 (목과 얼굴 중 아래쪽). */
  rigid_row: number;
  rigid_source: "neck" | "face" | "manual";
  /** 진폭 정규화 기준 — 병목이 진짜일 때만 목. */
  basis_row: number;
  torso_half: number;
  max_half: number;
  torso_source: "auto" | "manual";
  face: [number, number] | null;
  warnings: string[];
};

/** 최대반폭이 몸통반폭을 크게 넘는가 = 날개·긴 팔이 있는가. */
export function hasAppendage(a: Anatomy): boolean {
  return a.max_half >= APPENDAGE_RATIO * a.torso_half;
}

/** 발바닥 기준(0=발, 1=정수리) 강체 경계 — 프레임 높이가 달라도 쓸 수 있다. */
export function rigidU(a: Anatomy): number {
  return 1.0 - a.rigid_row / Math.max(1, a.height - 1);
}

export function basisRows(a: Anatomy): number {
  return Math.max(1, a.height - a.basis_row);
}

function alphaAt(f: Frame, x: number, y: number): number {
  return f.data[(y * f.width + x) * 4 + 3];
}

/** 몸통 세로축 = 불투명 픽셀 x 무게중심 (box 상대 좌표). 정수 나눗셈이다. */
export function axisCentroid(f: Frame, box: Box): number {
  const [x0, y0, x1, y1] = box;
  let total = 0;
  let acc = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (alphaAt(f, x, y) >= ALPHA_SOLID) {
        acc += x - x0;
        total += 1;
      }
    }
  }
  return Math.floor(acc / Math.max(1, total));
}

/**
 * 행별 '몸통 중심 런' 폭.
 *
 * 행 전체 불투명 픽셀을 세면 박쥐 날개처럼 옆으로 뻗은 부속이 폭을 지배한다.
 * 몸통 축을 지나는 **연속 런**만 재면 떨어져 있는 부속이 배제된다.
 */
export function widthProfile(f: Frame, box: Box, cx: number): number[] {
  const [x0, y0, x1, y1] = box;
  const width = x1 - x0;
  const out: number[] = [];
  for (let y = y0; y < y1; y++) {
    let seed: number | null = null;
    if (alphaAt(f, x0 + cx, y) >= ALPHA_SOLID) {
      seed = cx;
    } else {
      let best: number | null = null;
      for (let i = 0; i < width; i++) {
        if (
          alphaAt(f, x0 + i, y) >= ALPHA_SOLID &&
          (best === null || Math.abs(i - cx) < Math.abs(best - cx))
        ) {
          best = i;
        }
      }
      seed = best;
    }
    if (seed === null) {
      out.push(0);
      continue;
    }
    let lo = seed;
    while (lo > 0 && alphaAt(f, x0 + lo - 1, y) >= ALPHA_SOLID) lo--;
    let hi = seed;
    while (hi < width - 1 && alphaAt(f, x0 + hi + 1, y) >= ALPHA_SOLID) hi++;
    out.push(hi - lo + 1);
  }
  return out;
}

/**
 * 국소 최소와 그 prominence — 양옆으로 다시 올라가는 높이 중 작은 쪽.
 * 도트 계단이 만드는 얕은 최소는 병목이 아니다.
 */
export function bottleneckProminences(profile: number[]): Array<[number, number]> {
  const n = profile.length;
  if (n < 3) return [];
  const out: Array<[number, number]> = [];
  for (let i = 1; i < n - 1; i++) {
    if (profile[i] > profile[i - 1] || profile[i] > profile[i + 1]) continue;
    const left = Math.max(...profile.slice(0, i));
    const right = Math.max(...profile.slice(i + 1));
    out.push([i, Math.min(left, right) - profile[i]]);
  }
  return out;
}

function bestBottleneck(profile: number[], u0: number, u1: number): number | null {
  const n = profile.length;
  const lo = Math.trunc(n * u0);
  const hi = Math.trunc(n * u1);
  const peak = profile.length > 0 ? Math.max(...profile) : 0;
  const cand = bottleneckProminences(profile).filter(([i]) => lo <= i && i < hi);
  if (cand.length === 0) return null;
  // 파이썬 `max` 는 동점이면 **먼저 온 것**을 남긴다 — 부등호를 엄격히 둬야 같다.
  let bestI = cand[0][0];
  let bestP = cand[0][1];
  for (const [i, p] of cand) {
    if (p > bestP) {
      bestP = p;
      bestI = i;
    }
  }
  return bestP >= BOTTLENECK_PROMINENCE * peak ? bestI : null;
}

/**
 * 아래로 갈수록 실루엣이 가장 급히 넓어지는 행 = 어깨선.
 * 목이 아예 없는 실루엣(골렘)의 대체값이라 **정규화 기준으로는 쓰지 않는다.**
 */
function steepestWidening(profile: number[], u0: number, u1: number): number {
  const n = profile.length;
  const lo = Math.max(1, Math.trunc(n * u0));
  const hi = Math.max(2, Math.trunc(n * u1));
  let bestI = lo;
  let bestV = -Infinity;
  for (let i = lo; i < hi; i++) {
    const v = profile[i] - profile[i - 1];
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  return bestI;
}

export function detectNeck(profile: number[]): [number, "bottleneck" | "shoulder-gradient"] {
  const n = profile.length;
  const smooth = smoothProfile(
    profile.map(v => v),
    2 * Math.max(1, Math.floor(n / 40)) + 1,
  );
  const row = bestBottleneck(smooth, 0.05, 0.7);
  if (row !== null) return [row, "bottleneck"];
  return [steepestWidening(smooth, 0.05, 0.6), "shoulder-gradient"];
}

/**
 * 좌우 대칭 눈쌍으로 얼굴 세로 구간 [top, bottom] 을 찾는다.
 *
 * 눈은 가장 어두운 **작고 컴팩트한** 덩어리이면서 축에 대해 거울 대칭인 쌍이다.
 * 두 조건을 **동시에** 요구하는 게 핵심이다 — 어둡기만 보면 아웃라인이, 대칭만
 * 보면 좌우 팔이 걸린다(정본 실측: 컴팩트 제약 없이 골렘 양팔이 눈으로 잡혔다).
 */
export function detectFace(f: Frame, box: Box, cx: number): [number, number] | null {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const lums: Array<[number, number]> = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = ((y0 + j) * f.width + (x0 + i)) * 4;
      if (f.data[o + 3] >= ALPHA_SOLID) {
        lums.push([0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2], j * w + i]);
      }
    }
  }
  if (lums.length === 0) return null;
  const values = lums.map(([v]) => v).sort((a, b) => a - b);
  const threshold = values[0] + DARK_QUANTILE * (values[values.length - 1] - values[0]);
  const area = lums.length;
  const mask = new Array<boolean>(w * h).fill(false);
  for (const [v, idx] of lums) if (v <= threshold) mask[idx] = true;

  type Blob = [number, number, number, number, number]; // x0,y0,x1,y1,area(bbox)
  const blobs: Blob[] = [];
  for (const [bx0, by0, bx1, by1] of maskComponents(
    mask,
    w,
    h,
    Math.max(4, Math.trunc(EYE_MIN_AREA * area)),
    Math.trunc(EYE_MAX_AREA * area),
  )) {
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    if (bh > EYE_MAX_EXTENT * h || bw > EYE_MAX_EXTENT * w) continue;
    if (!(EYE_ASPECT[0] <= bw / bh && bw / bh <= EYE_ASPECT[1])) continue;
    if (by0 > EYE_TOP_LIMIT * h) continue;
    blobs.push([bx0, by0, bx1, by1, bw * bh]);
  }

  let best: { score: [number, number]; top: number; bot: number } | null = null;
  for (let i = 0; i < blobs.length; i++) {
    const a = blobs[i];
    for (let k = i + 1; k < blobs.length; k++) {
      const b = blobs[k];
      const amid = (a[0] + a[2]) / 2;
      const bmid = (b[0] + b[2]) / 2;
      const da = amid - cx;
      const db = bmid - cx;
      // 눈은 축을 **사이에 두고** 있다. 이 조건이 없으면 한쪽 눈 + 축 위의 입이
      // 짝으로 잡혀 얼굴 구간이 입 아래까지 늘어난다(정본 실측: 버섯).
      if (da * db >= 0 || Math.min(Math.abs(da), Math.abs(db)) < 0.05 * w) continue;
      if (Math.abs((amid + bmid) / 2 - cx) > 0.08 * w) continue;
      if (Math.abs(amid - bmid) < 0.1 * w) continue;
      if (Math.max(a[4], b[4]) > 2.5 * Math.min(a[4], b[4])) continue;
      if (Math.min(a[3], b[3]) < Math.max(a[1], b[1])) continue;
      // 큰 쌍 우선, 같으면 축에 더 대칭인 쌍 (파이썬 튜플 비교와 같은 사전식).
      const score: [number, number] = [a[4] + b[4], -Math.abs(da + db)];
      const better =
        best === null ||
        score[0] > best.score[0] ||
        (score[0] === best.score[0] && score[1] > best.score[1]);
      if (better) {
        best = { score, top: Math.min(a[1], b[1]), bot: Math.max(a[3], b[3]) - 1 };
      }
    }
  }
  if (best === null) return null;
  // 눈 아래 입까지 여유를 준다 — 눈만 지키고 입이 흔들리면 표정이 깨진다.
  const span = best.bot - best.top;
  return [best.top, Math.min(h - 1, best.bot + Math.max(1, pyRoundHalfEven(span * 0.7)))];
}

/** 파이썬 `round()` — 은행가 반올림. */
function pyRoundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** (몸통 반폭 중앙값, 실루엣 최대 반폭) — 둘의 비가 부속의 존재량이다. */
export function torsoMetrics(
  f: Frame,
  box: Box,
  cx: number,
  profile: number[],
  rowLo: number,
  rowHi: number,
): [number, number] {
  const [x0, y0, x1, y1] = box;
  const band: number[] = [];
  for (let r = Math.max(0, rowLo); r < Math.min(profile.length, rowHi); r++) {
    if (profile[r]) band.push(profile[r]);
  }
  // 파이썬은 sorted(band)[len//2] — 짝수여도 위쪽을 고른다(중앙값 평균이 아니다).
  const torso =
    band.length > 0
      ? Math.floor([...band].sort((a, b) => a - b)[Math.floor(band.length / 2)] / 2)
      : Math.floor((x1 - x0) / 4);
  let maxHalf = 0;
  for (let j = Math.max(0, rowLo); j < Math.min(y1 - y0, rowHi); j++) {
    for (let i = 0; i < x1 - x0; i++) {
      if (alphaAt(f, x0 + i, y0 + j) >= ALPHA_SOLID) {
        maxHalf = Math.max(maxHalf, Math.abs(i - cx));
      }
    }
  }
  return [Math.max(1, torso), Math.max(1, maxHalf)];
}

export class AnatomyFailed extends Error {}

/**
 * 한 프레임의 실루엣 해부 — 검출 SSoT.
 *
 * 사람이 준 값(`rigidRow`/`axisX`/`torsoHalf`)이 있으면 덮어쓰되 **자동 검출은 그대로
 * 수행해 관측값으로 남긴다**. 값 하나에 출처만 auto/manual 로 갈릴 뿐 진실은 하나다.
 */
export function analyze(
  f: Frame,
  opts: { rigidRow?: number; axisX?: number; torsoHalf?: number } = {},
): Anatomy {
  const box = solidAlphaBBox(f);
  if (!box) throw new AnatomyFailed("anatomy: 프레임에 불투명 콘텐츠가 없다");
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  let cx = axisCentroid(f, box);
  if (opts.axisX !== undefined) {
    if (!(opts.axisX >= 0 && opts.axisX < w)) {
      throw new AnatomyFailed(`anatomy: axis_x ${opts.axisX} 가 콘텐츠 폭 ${w} 밖이다`);
    }
    if (opts.axisX !== cx) cx = Math.trunc(opts.axisX);
  }
  const profile = widthProfile(f, box, cx);
  const [neckRow, neckSource] = detectNeck(profile);
  const face = detectFace(f, box, cx);

  const warnings: string[] = [];
  const autoCx = axisCentroid(f, box);
  if (opts.axisX !== undefined && opts.axisX !== autoCx) {
    warnings.push(`axis-x-override: auto ${autoCx} -> manual ${opts.axisX}`);
  }
  let autoRigid = Math.max(neckRow, face ? face[1] + 1 : 0);
  autoRigid = Math.min(autoRigid, Math.trunc(h * 0.8)); // 몸통이 통째로 사라지지는 않게
  let rigidSource: Anatomy["rigid_source"] = face && face[1] + 1 > neckRow ? "face" : "neck";
  if (opts.rigidRow !== undefined) {
    if (!(opts.rigidRow > 0 && opts.rigidRow < h)) {
      throw new AnatomyFailed(`anatomy: rigid_row ${opts.rigidRow} 가 콘텐츠 높이 ${h} 밖이다`);
    }
    if (opts.rigidRow !== autoRigid) {
      warnings.push(`rigid-row-override: auto ${autoRigid} -> manual ${opts.rigidRow}`);
    }
    autoRigid = opts.rigidRow;
    rigidSource = "manual";
  }

  // 진폭 정규화 기준: 병목이 **진짜일 때만** 목을 쓴다. 슬라임처럼 폭 프로파일이
  // 단조 증가라 병목이 없으면 (H - neck) 이 실제 변형 구간의 몇 배가 되어 폭주한다.
  const basisRow = neckSource === "bottleneck" ? neckRow : autoRigid;
  if (neckSource !== "bottleneck") {
    warnings.push(
      "neck-absent: 폭 프로파일에 병목이 없어 어깨-기울기로 대체했다 " +
        `(정규화 기준은 강체 경계 ${autoRigid} 사용)`,
    );
  }
  if (face === null) {
    warnings.push("face-absent: 대칭 눈쌍을 못 찾아 목만으로 경계를 정했다");
  }

  const [autoTorso, maxHalf] = torsoMetrics(f, box, cx, profile, autoRigid, h);
  let torso = autoTorso;
  let torsoSource: Anatomy["torso_source"] = "auto";
  if (opts.torsoHalf !== undefined) {
    if (!(opts.torsoHalf >= 1 && opts.torsoHalf <= w)) {
      throw new AnatomyFailed(`anatomy: torso_half ${opts.torsoHalf} 가 범위 [1, ${w}] 밖이다`);
    }
    if (opts.torsoHalf !== torso) {
      warnings.push(`torso-half-override: auto ${torso} -> manual ${opts.torsoHalf}`);
    }
    torso = Math.trunc(opts.torsoHalf);
    torsoSource = "manual";
  }
  return {
    width: w,
    height: h,
    axis_x: cx,
    neck_row: neckRow,
    neck_source: neckSource,
    rigid_row: autoRigid,
    rigid_source: rigidSource,
    basis_row: basisRow,
    torso_half: torso,
    max_half: maxHalf,
    torso_source: torsoSource,
    face,
    warnings,
  };
}
