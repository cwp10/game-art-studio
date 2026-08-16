// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen 의 실루엣 헬퍼 이식.
// 원본: sprite_gen/segment.py (mask_components, smooth_profile),
//       sprite_gen/extract.py (solid_alpha_bbox) — Apache-2.0

/**
 * `anatomy` 가 쓰는 실루엣 도구 셋.
 *
 * `segment.py` 자체는 미이식이다(projection + DP 최적 절단은 정본에서도 opt-in).
 * 여기 옮긴 둘은 그 모듈에 **얹혀 있을 뿐** 세그먼테이션과 무관한 순수 함수다 —
 * 정본도 같은 이유로 anatomy 이식 때 사본을 늘리지 않으려 segment 로 모았다.
 */

export type Frame = { data: Uint8Array; width: number; height: number };
export type Box = [number, number, number, number];

/** 불투명 판정 문턱. 픽셀 언페이크 경로와 같은 기준이어야 한다(원본 주석). */
export const ALPHA_SOLID = 128;

/**
 * α >= threshold 픽셀만의 bbox — AA 프린지를 제외한 실 콘텐츠 범위.
 *
 * any-alpha bbox 를 쓰면 프린지가 범위를 부풀린다. 정본이 실사고로 확인한 지점이라
 * (2026-07-17, 150프레임 중 141프레임 폭 +1~4px) 문턱을 낮추면 안 된다.
 */
export function solidAlphaBBox(f: Frame, threshold = ALPHA_SOLID): Box | null {
  let x0 = f.width;
  let y0 = f.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (f.data[(y * f.width + x) * 4 + 3] < threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * 불리언 마스크의 4-이웃 연결요소 → bbox 목록.
 *
 * `maxArea` 는 **너무 큰 덩어리를 후보에서 아예 뺀다**. 눈 검출처럼 "작고 컴팩트한
 * 것만" 찾는 쪽은 이 상한이 있어야 아웃라인·팔 같은 큰 어두운 영역이 걸러진다 —
 * bbox 로 사후 필터하면 픽셀 수가 아니라 외접 사각형을 재게 되어 판정이 달라진다.
 */
export function maskComponents(
  mask: boolean[],
  w: number,
  h: number,
  minArea = 1,
  maxArea: number | null = null,
): Box[] {
  const visited = new Uint8Array(mask.length);
  const boxes: Box[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    const stack = [seed];
    visited[seed] = 1;
    let minx = 1 << 30;
    let miny = 1 << 30;
    let maxx = -1;
    let maxy = -1;
    let area = 0;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      area += 1;
      const x = cur % w;
      const y = (cur - x) / w;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      if (x > 0 && mask[cur - 1] && !visited[cur - 1]) {
        visited[cur - 1] = 1;
        stack.push(cur - 1);
      }
      if (x < w - 1 && mask[cur + 1] && !visited[cur + 1]) {
        visited[cur + 1] = 1;
        stack.push(cur + 1);
      }
      if (y > 0 && mask[cur - w] && !visited[cur - w]) {
        visited[cur - w] = 1;
        stack.push(cur - w);
      }
      if (y < h - 1 && mask[cur + w] && !visited[cur + w]) {
        visited[cur + w] = 1;
        stack.push(cur + w);
      }
    }
    if (area >= minArea && (maxArea === null || area <= maxArea)) {
      boxes.push([minx, miny, maxx + 1, maxy + 1]);
    }
  }
  return boxes;
}

/** 박스 이동평균 — 압축 잡음·얇은 틈을 억제한다. */
export function smoothProfile(profile: number[], window: number): number[] {
  if (window < 1 || profile.length === 0) return profile;
  const length = profile.length;
  const half = Math.floor(window / 2);
  const out = new Array<number>(length).fill(0);
  for (let i = 0; i < length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(length - 1, i + half);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += profile[k];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}
