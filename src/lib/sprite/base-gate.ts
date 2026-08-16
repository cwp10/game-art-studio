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
