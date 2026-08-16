/**
 * base idle 잠금 게이트 — 결정론적 검사.
 *
 * 정본(sprite-gen SKILL.md "Base Lock Gate (Stage 0, BLOCKING)")의 잠금 기준
 * 6가지 중 코드로 판정 가능한 것만 다룬다. 최종 y/n 은 사람이 누른다.
 * 자동 검사가 전부 통과해도 잠금이 자동으로 되지는 않는다 — 비율·스타일
 * 적합성과 캐릭터 정체성은 사람 몫이다.
 *
 * 배경 판정은 sprite-gen `sprite_gen/prepare.py` `detect_reference_background`
 * (Apache-2.0, Copyright 2026 Alex Kim) 의 이식이다. 상수와 판정 순서를 그대로
 * 따른다 — 값을 바꾸면 원본과 다른 결과가 나온다.
 */

/** 배경으로 인정할 테두리 색 거리(유클리드 RGB). */
const BACKGROUND_TOLERANCE = 48.0;
/** 테두리 링에서 불투명 픽셀이 이 비율 미만이면 투명 배경으로 본다. */
const BACKGROUND_MIN_OPAQUE_BORDER = 0.25;
/** 최다 색이 테두리를 이만큼 덮어야 평면으로 인정한다. */
const BACKGROUND_BORDER_COVERAGE = 0.75;
/** 알파가 이 값 이하이면 투명 취급. */
const ALPHA_TRANSPARENT_MAX = 16;

export type BackgroundInfo =
  | {
      mode: "flat";
      hex: string;
      rgb: [number, number, number];
      opaqueBorderFraction: number;
      borderCoverage: number;
    }
  | { mode: "transparent"; opaqueBorderFraction: number }
  | { mode: "heterogeneous"; opaqueBorderFraction: number; borderCoverage: number };

function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

/** 테두리 링 좌표. 2px 미만 변은 전체 픽셀을 링으로 본다. */
function borderCoordinates(width: number, height: number): Array<[number, number]> {
  if (width < 2 || height < 2) {
    const all: Array<[number, number]> = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) all.push([x, y]);
    return all;
  }
  const ring: Array<[number, number]> = [];
  for (let x = 0; x < width; x++) ring.push([x, 0], [x, height - 1]);
  for (let y = 1; y < height - 1; y++) ring.push([0, y], [width - 1, y]);
  return ring;
}

/**
 * 테두리 링으로 base 의 배경을 분류한다. 관측 가능한 세 모드를 돌려준다.
 * flat 만 배경색을 싣는다.
 */
export function detectBackgroundMode(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): BackgroundInfo {
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * width + x) * channels;
    return [raw[i], raw[i + 1], raw[i + 2], channels >= 4 ? raw[i + 3] : 255];
  };

  const ring = borderCoordinates(width, height);
  const opaque = ring.filter(([x, y]) => at(x, y)[3] > ALPHA_TRANSPARENT_MAX);
  const opaqueBorderFraction = ring.length > 0 ? opaque.length / ring.length : 0;

  if (opaqueBorderFraction < BACKGROUND_MIN_OPAQUE_BORDER) {
    return {
      mode: "transparent",
      opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
    };
  }

  // 16단계 버킷으로 양자화해 PNG/코덱 지터를 견딘 뒤, 최다 버킷의 평균으로 실제 색을 복원.
  const buckets = new Map<string, Array<[number, number, number]>>();
  for (const [x, y] of opaque) {
    const [r, g, b] = at(x, y);
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const list = buckets.get(key);
    if (list) list.push([r, g, b]);
    else buckets.set(key, [[r, g, b]]);
  }
  let members: Array<[number, number, number]> = [];
  for (const list of buckets.values()) if (list.length > members.length) members = list;

  const background: [number, number, number] = [
    Math.round(members.reduce((s, m) => s + m[0], 0) / members.length),
    Math.round(members.reduce((s, m) => s + m[1], 0) / members.length),
    Math.round(members.reduce((s, m) => s + m[2], 0) / members.length),
  ];

  const within = opaque.filter(([x, y]) => {
    const [r, g, b] = at(x, y);
    return colorDistance([r, g, b], background) <= BACKGROUND_TOLERANCE;
  }).length;
  const borderCoverage = within / opaque.length;

  if (borderCoverage < BACKGROUND_BORDER_COVERAGE) {
    return {
      mode: "heterogeneous",
      opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
      borderCoverage: Math.round(borderCoverage * 1000) / 1000,
    };
  }

  return {
    mode: "flat",
    hex: rgbToHex(background),
    rgb: background,
    opaqueBorderFraction: Math.round(opaqueBorderFraction * 1000) / 1000,
    borderCoverage: Math.round(borderCoverage * 1000) / 1000,
  };
}

/**
 * 반투명(안티앨리어싱) 픽셀 비율. 완전 투명(alpha=0)은 세지 않는다 —
 * 그건 잘라낸 배경이지 AA 가장자리가 아니다.
 *
 * 정본의 잠금 기준 3번은 "균일 블록 피치가 실측되고 AA 반투명 가장자리가
 * 없을 것"이다. 피치 실측은 ⑤(추출)에서 검출기를 포팅한 뒤 붙인다. 여기서는
 * AA 쪽만 본다 — 진짜 픽셀아트는 이 값이 0 에 가깝다.
 */
export function softAlphaFraction(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  if (channels < 4) return 0;
  const total = width * height;
  if (total === 0) return 0;
  let soft = 0;
  for (let i = 0; i < total; i++) {
    const a = raw[i * channels + 3];
    if (a > 0 && a < 255) soft++;
  }
  return soft / total;
}

export type BBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * 배경이 아닌 픽셀의 경계 상자. 배경 판정은 detectBackgroundMode 결과를 따른다:
 * flat 이면 그 색과의 거리로, 그 외에는 알파로만 가른다.
 *
 * heterogeneous 는 배경색을 특정할 수 없으므로 알파 기준으로 떨어진다 —
 * 불투명 그라디언트 배경에서는 bbox 가 캔버스 전체가 되고, 그건 잠금 기준 1번을
 * 실패시키는 관측 가능한 결과다.
 */
export function subjectBBox(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  background: BackgroundInfo,
): BBox | null {
  const key = background.mode === "flat" ? background.rgb : null;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const a = channels >= 4 ? raw[i + 3] : 255;
      if (a <= ALPHA_TRANSPARENT_MAX) continue;
      if (key && colorDistance([raw[i], raw[i + 1], raw[i + 2]], key) <= BACKGROUND_TOLERANCE) {
        continue;
      }
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** bbox 가 캔버스 가장자리에 닿으면 잘렸을 가능성이 있다(잠금 기준 1번). */
export function touchesEdge(bbox: BBox, width: number, height: number): boolean {
  return bbox.x0 === 0 || bbox.y0 === 0 || bbox.x1 === width - 1 || bbox.y1 === height - 1;
}
