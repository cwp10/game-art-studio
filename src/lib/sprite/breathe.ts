// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `breathe.py` 이식 — 결정론 호흡(봉투 기반 스쿼시&스트레치).
// 원본: sprite-gen/sprite_gen/breathe.py (Apache-2.0)

/**
 * 앵커 프레임 하나에서 호흡 애니메이션을 **계산으로** 만든다. AI 개입 0 —
 * 같은 입력이면 항상 같은 출력.
 *
 * ## 왜 분할선이 아니라 봉투인가
 *
 * 수평 분할선 위의 행을 정수 px 내리는 구 방식은 실제로 **2상태 토글**이 되어
 * (정본 실측: idle 6프레임이 `f0==f2==f4`) 호흡이 아니라 1px 진동으로 읽혔다.
 * 머리를 잘라 붙이면 단면이 목에 가로선으로 드러난다. **붙이는 연산이 있는 한
 * 이음매는 없앨 수 없다.** 그래서 자르지 않고 전체에 연속 변형장 하나를 걸고,
 * 그 강도를 목(또는 얼굴 아래)에서 0 으로 떨군다:
 *
 *     env(y) = 발끝램프(y) × 강체테이퍼(y)      // 0 = 원본 그대로, 1 = 최대 변형
 *     g(y,t) = depth · norm · wave(t - lag·u(y)) · env(y)
 *     sx(y)  = 1 + g                            // 가로
 *     sy(y)  = 1 / (1 + g)                      // 세로 (면적 보존)
 *
 * ## 불변식 (테스트가 지키는 것)
 *
 * 1. **강체 구간은 항등이다 — 근사가 아니다.** env=0 인 행은 g=0 이라 가로 사상이
 *    원본 좌표 그대로이고 sy=1 이라 누적 높이가 정확히 1씩 는다. 그 구간은 프레임
 *    간 **비트 동일**하다 — 눈·입이 몇 도트뿐인 픽셀아트에서 3% 세로 신장도 표정을
 *    뭉개므로 이게 핵심 계약이다.
 * 2. **가로 사상은 단조다.** 밀도 적분이라 접힘이 구조적으로 불가능하다.
 * 3. **몸통 축 열이 고정점이다.** bbox 중앙을 기준으로 잡으면 축이 중앙과 다른
 *    캐릭터가 변형 0 에서도 밀린다(정본 실사고 2026-07-25).
 * 4. **격자를 벗어나는 연산이 없다.** 세로는 행 정수 복제/삭제, 가로는 정수 열 사상.
 *    보간·블렌딩이 한 번도 없으므로 출력이 항상 정수 도트다.
 * 5. **루프 길이 불변.** 출력 프레임 수 = 입력 프레임 수.
 */

import { analyze, rigidU, basisRows, hasAppendage, type Anatomy } from "@/lib/sprite/anatomy";
import { solidAlphaBBox, type Box, type Frame } from "@/lib/sprite/silhouette";

/** 강체 경계에서 강도가 0 이 되기까지의 테이퍼 반폭(콘텐츠 높이 비율) — 이음매를 없앤다. */
export const TAPER = 0.055;
/** 발끝 고정 램프 — 아래쪽 이 비율만큼은 강도가 0 에서 올라온다(발이 안 뜬다). */
export const FOOT = 0.28;
/** 행당 변형 상한. 넘으면 조용히 깎지 않고 멈춘다. */
export const MAX_ROW_STRAIN = 0.25;
/** 기본 진폭 — 몸통 높이 대비 총 신장량. */
export const DEFAULT_DEPTH = 0.06;
/** 진행파 위상지연 — 몸통 윗부분이 늦게 밀어올려 머리가 한 박자 늦게 온다. */
export const DEFAULT_LAG = 0.1;
/** 한 호흡이 부드럽게 읽히는 최소 프레임 수. */
export const SMOOTH_CYCLE_FRAMES = 6;

export class BreatheFailed extends Error {}

/** 한 호흡의 기본 파형. 2차 하모닉을 살짝 섞어 정점이 뾰족해진다(들숨의 어택). */
export function wave(t: number): number {
  return 0.86 * Math.sin(2 * Math.PI * t) + 0.14 * Math.sin(4 * Math.PI * t);
}

export function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1.0 : 0.0;
  const u = Math.min(1.0, Math.max(0.0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * (env(u), 진폭 정규화 계수) — u = 0(발바닥) … 1(정수리).
 *
 * 정규화가 필요한 이유: 테이퍼·발끝램프가 변형 구간을 갉아먹으므로 그대로 두면
 * 강체 경계가 낮은 캐릭터일수록 호흡이 작아진다. `sum(env)` 로 나눠 총 신장량이
 * 항상 `depth × 기준높이` 가 되게 한다 — 진폭 숫자가 캐릭터와 무관하게 같은 뜻을 갖는다.
 */
export function envelope(
  anat: Anatomy,
  taper = TAPER,
  foot = FOOT,
): { env: (u: number) => number; norm: number } {
  const height = anat.height;
  const ru = rigidU(anat);
  const band = Math.max(1.5, taper * height) / Math.max(1, height);
  const footTop = foot * ru;
  const env = (u: number): number =>
    smoothstep(0.0, footTop, u) * (1.0 - smoothstep(ru - band, ru + band, u));
  let total = 0;
  for (let j = 0; j < height; j++) total += env(j / Math.max(1, height - 1));
  const norm = total > 1e-6 ? basisRows(anat) / total : 0.0;
  return { env, norm };
}

/**
 * 부속 보호 가중 p(x) — 1 이면 그 열은 가로로 안 늘어난다(콘텐츠 bbox 상대 x).
 *
 * 자동 밴드는 부속이 **실재할 때만** 켜지고 램프 끝을 max_half 에 앵커한다. 수동
 * 밴드는 무조건 켜지고 램프를 밴드 자체에 앵커한다 — 블롭(max_half ≈ torso_half)에서
 * 자동 램프는 몸 끝까지 완만해 밴드를 좁혀도 보호가 1 에 도달하지 못했다(정본 실측
 * 2026-07-30 문어: 밴드 12→4 에 출력 차이가 바이트 22개).
 */
export function protect(anat: Anatomy): (x: number) => number {
  const cx = anat.axis_x;
  if (anat.torso_source === "manual") {
    const t0 = anat.torso_half;
    const t1 = t0 + 2.0;
    return (x: number) => smoothstep(t0, t1, Math.abs(x - cx));
  }
  if (!hasAppendage(anat)) return () => 0.0;
  const t0 = anat.torso_half * 1.15;
  const t1 = Math.max(t0 + 1.0, anat.max_half * 0.95);
  return (x: number) => smoothstep(t0, t1, Math.abs(x - cx));
}

/** 행당 최대 변형 — MAX_ROW_STRAIN 초과 여부 판정용. */
export function rowStrain(anat: Anatomy, depth: number): number {
  const { env, norm } = envelope(anat);
  let peak = 0;
  for (let j = 0; j < anat.height; j++) {
    peak = Math.max(peak, env(j / Math.max(1, anat.height - 1)));
  }
  return depth * norm * peak;
}

// ── 외곽선 1px 다듬기 ────────────────────────────────────────────────

type RGBA = [number, number, number, number];

function px(f: Frame, x: number, y: number): RGBA {
  const o = (y * f.width + x) * 4;
  return [f.data[o], f.data[o + 1], f.data[o + 2], f.data[o + 3]];
}

function setPx(f: Frame, x: number, y: number, c: RGBA): void {
  const o = (y * f.width + x) * 4;
  f.data[o] = c[0];
  f.data[o + 1] = c[1];
  f.data[o + 2] = c[2];
  f.data[o + 3] = c[3];
}

/**
 * 다듬기의 '외곽선 어두움' 판정 — 외곽선과 어두운 음영을 갈라야 한다.
 * 정본 실측(문어 idle 왼쪽 볼): 외곽선 lum 0~13, 어두운 음영 73~92, 내부 112+.
 * 구 문턱 96 은 음영까지 외곽선으로 세어 다듬기가 발화하지 않았다. 60 이 두 군집을 가른다.
 */
function isDarkPixel(p: RGBA): boolean {
  return p[3] !== 0 && 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] < 60.0;
}

/**
 * 실루엣 외곽선 2px 를 **안쪽점 기준** 1px 로 정규화하는 1패스.
 *
 * 세로 스쿼시&스트레치는 정수 행 복제/삭제라 가파른 대각선 외곽선이 국소적으로
 * 2px 두께가 되고 위상마다 위치를 바꿔 "간헐 2줄 검은점" 으로 읽힌다. 실루엣 끝에서
 * '어두움-어두움-내부색' 3연속을 만나면 **바깥 픽셀을 제거**해 이웃 행들과 정렬된
 * 안쪽 선만 남긴다.
 *
 * 안전 필터(제거가 새 결함을 만들면 안 된다):
 *   · 제거 자리의 이웃이 불투명 내부색이면 실루엣 끝에 내부색이 노출된다 → 제외
 *   · 이웃 양쪽이 남는 어두운 픽셀이면 어두운 선 **중간에 구멍**이 난다 → 제외
 *   · 이웃이 같은 패스에서 함께 제거되면 안전(돌출 열/행이 통째로 사라짐)
 * 제외가 다른 후보의 안전성을 바꾸므로 고정점까지 반복한다.
 */
function thinOutlinePass(out: Frame): number {
  const w = out.width;
  const h = out.height;
  const op = (x: number, y: number): boolean =>
    x >= 0 && x < w && y >= 0 && y < h && px(out, x, y)[3] !== 0;
  const dark = (x: number, y: number): boolean => op(x, y) && isDarkPixel(px(out, x, y));

  const cand = new Map<string, "h" | "v">();
  const key = (x: number, y: number) => `${x},${y}`;

  for (let x = 0; x < w; x++) {
    const ys: number[] = [];
    for (let y = 0; y < h; y++) if (op(x, y)) ys.push(y);
    if (ys.length === 0) continue;
    const t0 = ys[0];
    const b0 = ys[ys.length - 1];
    if (t0 + 2 <= b0 && dark(x, t0) && dark(x, t0 + 1) && op(x, t0 + 2) && !dark(x, t0 + 2)) {
      cand.set(key(x, t0), "v");
    }
    if (b0 - 2 >= t0 && dark(x, b0) && dark(x, b0 - 1) && op(x, b0 - 2) && !dark(x, b0 - 2)) {
      cand.set(key(x, b0), "v");
    }
  }

  const rowLo = new Map<number, number>();
  const rowHi = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let x = 0; x < w; x++) if (op(x, y)) xs.push(x);
    if (xs.length === 0) continue;
    const l0 = xs[0];
    const r0 = xs[xs.length - 1];
    rowLo.set(y, l0);
    rowHi.set(y, r0);
    if (l0 + 2 <= r0 && dark(l0, y) && dark(l0 + 1, y) && op(l0 + 2, y) && !dark(l0 + 2, y)) {
      if (!cand.has(key(l0, y))) cand.set(key(l0, y), "h");
    }
    if (r0 - 2 >= l0 && dark(r0, y) && dark(r0 - 1, y) && op(r0 - 2, y) && !dark(r0 - 2, y)) {
      if (!cand.has(key(r0, y))) cand.set(key(r0, y), "h");
    }
  }

  // 1px 단독 돌출점 — 그 행의 어두운 끝점이 위아래 행 끝보다 정확히 1px 바깥으로
  // 튀어나온 경우(가로 매핑 반올림이 행마다 갈린 아티팩트). 점을 지우고 **안쪽 자리에
  // 그 색을 그대로 그린다**. 가로 한정 — 세로 1px 계단은 작가 의도(머리 스파이크)와
  // 구분이 안 돼 건드리지 않는다.
  const moves = new Map<string, RGBA>();
  for (const y of [...rowLo.keys()].sort((a, b) => a - b)) {
    const upLo = rowLo.get(y - 1);
    const dnLo = rowLo.get(y + 1);
    const m = rowLo.get(y) as number;
    if (
      upLo !== undefined &&
      dnLo !== undefined &&
      Math.min(upLo, dnLo) - m === 1 &&
      dark(m, y) &&
      op(m + 1, y)
    ) {
      if (!cand.has(key(m, y))) cand.set(key(m, y), "h");
      if (!dark(m + 1, y)) moves.set(key(m + 1, y), px(out, m, y));
    }
    const upHi = rowHi.get(y - 1);
    const dnHi = rowHi.get(y + 1);
    const r = rowHi.get(y) as number;
    if (
      upHi !== undefined &&
      dnHi !== undefined &&
      r - Math.max(upHi, dnHi) === 1 &&
      dark(r, y) &&
      op(r - 1, y)
    ) {
      if (!cand.has(key(r, y))) cand.set(key(r, y), "h");
      if (!dark(r - 1, y)) moves.set(key(r - 1, y), px(out, r, y));
    }
  }

  // 안전 필터 고정점. 파이썬은 `sorted(drop)` 순회 — 좌표 튜플 사전식이라 (x, y) 순.
  const drop = new Set(cand.keys());
  const parse = (k: string): [number, number] => {
    const [a, b] = k.split(",");
    return [Number(a), Number(b)];
  };
  let changed = true;
  while (changed) {
    changed = false;
    const sorted = [...drop].sort((A, B) => {
      const [ax, ay] = parse(A);
      const [bx, by] = parse(B);
      return ax !== bx ? ax - bx : ay - by;
    });
    for (const p of sorted) {
      const [x, y] = parse(p);
      const neigh: Array<[number, number]> =
        cand.get(p) === "h"
          ? [
              [x, y - 1],
              [x, y + 1],
            ]
          : [
              [x - 1, y],
              [x + 1, y],
            ];
      let keptDark = 0;
      let ok = true;
      for (const [nx, ny] of neigh) {
        if (!op(nx, ny) || drop.has(key(nx, ny))) continue;
        if (dark(nx, ny)) keptDark += 1;
        else {
          ok = false; // 내부색이 실루엣 끝으로 노출된다
          break;
        }
      }
      if (!ok || keptDark >= 2) {
        drop.delete(p);
        changed = true;
        break;
      }
    }
  }

  for (const p of drop) {
    const [x, y] = parse(p);
    setPx(out, x, y, [0, 0, 0, 0]);
  }
  let applied = drop.size;
  for (const [k, color] of moves) {
    if (!drop.has(k)) {
      const [x, y] = parse(k);
      setPx(out, x, y, color);
      applied += 1;
    }
  }
  return applied;
}

/** 안쪽점 기준 다듬기를 고정점까지 반복 — 한 패스의 제거가 새 돌출점을 만들 수 있다. */
function thinOutline1px(out: Frame): void {
  while (thinOutlinePass(out) > 0) {
    /* 각 패스가 불투명 픽셀을 단조 감소시키므로 종료가 보장된다 */
  }
}

// ── 워프 ─────────────────────────────────────────────────────────────

/**
 * 한 위상 t 의 프레임 — 캔버스 크기 불변, 발바닥 고정.
 *
 * `depthX` 는 가로 성분의 독립 진폭이다. `undefined` 면 depth 를 따르고(레거시와
 * 바이트 동일), 0 이면 가로 사상이 전 위상 항등이다. 파형·봉투·지연은 두 축이
 * 공유한다 — 축마다 다른 건 스칼라뿐이다.
 */
export function warp(
  frame: Frame,
  anat: Anatomy,
  depth: number,
  lag: number,
  t: number,
  depthX?: number,
): Frame {
  const box = solidAlphaBBox(frame);
  if (!box) return { data: Uint8Array.from(frame.data), width: frame.width, height: frame.height };
  const [bx0, by0, bx1, by1] = box as Box;
  const width = bx1 - bx0;
  const height = by1 - by0;
  const canvasW = frame.width;
  const canvasH = frame.height;
  const anchorX = bx0 + anat.axis_x;
  const baseline = by1;

  const srcAt = (i: number, j: number): RGBA => px(frame, bx0 + i, by0 + j);

  const { env, norm } = envelope(anat);
  const pOf = protect(anat);
  const ru = rigidU(anat);
  const dxAmp = depthX === undefined ? depth : depthX;

  const gain = (u: number, d: number): number => {
    const e = env(u);
    if (e <= 0.0) return 0.0;
    return d * norm * wave(t - lag * Math.min(1.0, u / Math.max(1e-6, ru))) * e;
  };

  // 세로 누적 — j=0 이 정수리
  const heights: number[] = [];
  let acc = 0.0;
  for (let j = 0; j < height; j++) {
    const g = gain(1.0 - j / Math.max(1, height - 1), depth);
    acc += g === 0.0 ? 1.0 : 1.0 / (1.0 + g);
    heights.push(acc);
  }
  const total = Math.max(1, Math.floor(acc + 0.5));

  const out: Frame = {
    data: new Uint8Array(canvasW * canvasH * 4),
    width: canvasW,
    height: canvasH,
  };
  let yCursor = baseline - total;
  let prev = 0;
  let clipped = 0;
  let deformed = false;

  for (let j = 0; j < height; j++) {
    const u = 1.0 - j / Math.max(1, height - 1);
    const cur = Math.floor(heights[j] + 0.5);
    const reps = Math.max(0, cur - prev);
    prev = cur;
    if (reps === 0) continue;
    const g = gain(u, dxAmp);
    if (reps !== 1) deformed = true;

    let rowMap: Array<[number, number]>;
    if (g === 0.0) {
      // 변형 없음 = 원본 위치 그대로. 축 고정점 사상의 g→0 극한과 정확히 같다.
      rowMap = Array.from({ length: width }, (_, i) => [bx0 + i, i] as [number, number]);
    } else {
      deformed = true;
      const dens: number[] = [];
      for (let i = 0; i < width; i++) dens.push(Math.max(0.05, 1.0 + g * (1.0 - pOf(i))));
      const edge = [0.0];
      for (const d of dens) edge.push(edge[edge.length - 1] + d);
      const origin = edge[anat.axis_x]; // 축을 고정점으로 — 여기가 anchorX 에 박힌다
      // half-up 반올림을 명시한다: 파이썬 기본 round() 는 은행가 반올림이라
      // .5 경계에서 갈린다. 원본도 floor(x + 0.5) 로 고정해 뒀다.
      const lo = Math.floor(edge[0] - origin + 0.5);
      const hi = Math.floor(edge[width] - origin + 0.5);
      rowMap = [];
      let i = 0;
      for (let ox = lo; ox < hi; ox++) {
        while (i < width - 1 && edge[i + 1] - origin <= ox) i += 1;
        rowMap.push([anchorX + ox, i]);
      }
      // 외곽선 보존: 가로 축소 위상에서 forward 밀도매핑이 실루엣 양끝 열을 통째로
      // 떨궈 1px 외곽선이 사라진다(정본 실측: 발끝 플리커). 이 행의 최말단 불투명
      // 소스 열을 출력 양끝 불투명 픽셀에 그대로 실어 항상 1px 외곽선이 남게 한다.
      const opCols: number[] = [];
      for (let k = 0; k < width; k++) if (srcAt(k, j)[3]) opCols.push(k);
      if (opCols.length > 0 && rowMap.length > 0) {
        const opLo = opCols[0];
        const opHi = opCols[opCols.length - 1];
        for (let k = rowMap.length - 1; k >= 0; k--) {
          if (srcAt(rowMap[k][1], j)[3]) {
            rowMap[k] = [rowMap[k][0], opHi];
            break;
          }
        }
        for (let k = 0; k < rowMap.length; k++) {
          if (srcAt(rowMap[k][1], j)[3]) {
            rowMap[k] = [rowMap[k][0], opLo];
            break;
          }
        }
      }
    }

    for (let r = 0; r < reps; r++) {
      const yy = yCursor + r;
      for (const [ox, si] of rowMap) {
        const pixel = srcAt(si, j);
        if (!pixel[3]) continue;
        if (yy >= 0 && yy < canvasH && ox >= 0 && ox < canvasW) setPx(out, ox, yy, pixel);
        else clipped += 1;
      }
    }
    yCursor += reps;
  }

  if (clipped) {
    // 조용히 자르지 않는다 — 정수리나 옆구리가 셀 밖으로 나가면 스프라이트가 망가지고,
    // 그건 여백이나 진폭을 사람이 정해야 하는 문제다.
    throw new BreatheFailed(
      `breathe: 늘어난 프레임이 셀 밖으로 나가 불투명 픽셀 ${clipped}개가 잘린다 ` +
        `(셀 ${canvasW}x${canvasH}, 콘텐츠 ${bx0},${by0}-${bx1},${by1}). ` +
        "셀 여백을 늘리거나 depth 를 낮춰라.",
    );
  }
  if (deformed) thinOutline1px(out);
  return out;
}

/**
 * 한 프레임에서 호흡 사이클을 굽는다.
 *
 * 위상은 `breaths / frames` 간격으로 균등하다 — 출력 프레임 수가 입력과 같고
 * 호흡이 그 안에서 `breaths` 회 딱 떨어진다(불변식 5).
 */
export function breatheCycle(
  frame: Frame,
  opts: {
    frames: number;
    breaths?: number;
    depth?: number;
    depthX?: number;
    lag?: number;
    anat?: Anatomy;
  },
): Frame[] {
  const frames = opts.frames;
  if (frames < 1) throw new BreatheFailed("breathe: 프레임 수는 1 이상이어야 한다");
  const breaths = opts.breaths ?? 1;
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const lag = opts.lag ?? DEFAULT_LAG;
  const anat = opts.anat ?? analyze(frame);
  const strain = rowStrain(anat, depth);
  if (strain > MAX_ROW_STRAIN) {
    throw new BreatheFailed(
      `breathe: 행당 변형 ${strain.toFixed(3)} 이 상한 ${MAX_ROW_STRAIN} 을 넘는다 — depth 를 낮춰라`,
    );
  }
  const out: Frame[] = [];
  for (let i = 0; i < frames; i++) {
    out.push(warp(frame, anat, depth, lag, (breaths * i) / frames, opts.depthX));
  }
  return out;
}
