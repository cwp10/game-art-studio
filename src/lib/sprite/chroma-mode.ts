/**
 * 크로마 경로 자동 판정 — **이식이 아니라 우리 앱을 위한 다리다.**
 *
 * 정본은 `chroma.mode` 를 `rgb`(기본) / `ycbcr`(opt-in) 두 값으로 두고, 어느 쪽을
 * 쓸지는 **사람이 CLI 플래그로** 정한다: *"ycbcr is for degraded sources
 * (shaded/gradient backgrounds, JPEG chroma noise), not a general upgrade"*
 * (sprite-gen docs/chroma-alpha.md). 우리에겐 그 플래그를 켤 자리가 없다.
 *
 * 그래서 사람이 눈으로 하던 판정("이 원본이 열화됐나?")을 **측정으로** 대신한다.
 * 판정 기준은 임의로 고른 값이 아니라 rgb 경로가 실제로 실패하는 조건 그 자체다:
 *
 *   rgb 경로의 하드 키 컷은 `colorDistance(픽셀, 선언키) <= keyThreshold(96)` 인
 *   픽셀만 지운다. 배경의 실제 색이 선언 키에서 그보다 멀면 배경은 **한 픽셀도**
 *   안 지워진다. 그 경우가 정확히 정본이 말하는 "열화된 원본"이다.
 *
 * 실측(2026-08-16, codex imagegen 행 5장):
 *
 *   | 선언 키 | 실제 배경      | 거리  | rgb 하드컷 |
 *   |---------|----------------|-------|-----------|
 *   | cyan ×4 | rgb(5,247,252) | 9~13  | 통과      |
 *   | magenta | rgb(204,26,144)| 124.9 | **실패**  |
 *
 * 시안은 잘 나오고 마젠타 한 건이 크게 어긋났다. 표본이 작아 마젠타가 구조적으로
 * 취약한지는 **모른다** — 그래서 색을 보고 정하지 않고 매번 잰다.
 *
 * 실제 배경 키 검출은 정본의 `detectBackgroundKeyYcc`(테두리 CbCr 최빈)를 그대로
 * 쓴다. 우리가 따로 재면 두 개의 다른 "배경색"이 생긴다.
 */

import { DEFAULT_KEY_THRESHOLD } from "@/lib/sprite/chroma-clean";
import { detectBackgroundKeyYcc, type RGB } from "@/lib/sprite/chroma-ycbcr";

export type ChromaMode = "rgb" | "ycbcr";

export type ChromaModeDecision = {
  mode: ChromaMode;
  /** 테두리에서 검출한 실제 배경 키. */
  detectedKey: [number, number, number];
  declaredKey: RGB;
  /** 검출 키와 선언 키의 RGB 유클리드 거리 — rgb 하드컷이 쓰는 척도와 같다. */
  distance: number;
  threshold: number;
  reason: string;
};

/** RGB 유클리드 거리 — `chroma-clean.colorDistance` 와 같은 척도. */
function distance(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 이 raw 스트립에 어느 크로마 경로를 쓸지 정한다.
 *
 * 판정은 **경고로 표면화되어야 한다** — 조용히 경로가 갈리면 나중에 결과가 달라진
 * 이유를 못 찾는다. 호출자는 `reason` 을 로그·응답에 남긴다.
 */
export function decideChromaMode(
  data: Uint8Array,
  width: number,
  height: number,
  declaredKey: RGB,
  keyThreshold: number = DEFAULT_KEY_THRESHOLD,
): ChromaModeDecision {
  const detectedKey = detectBackgroundKeyYcc(data, width, height, declaredKey);
  const d = distance(detectedKey, declaredKey);
  const hex = (c: readonly number[]): string =>
    `#${c.map(v => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

  if (d > keyThreshold) {
    return {
      mode: "ycbcr",
      detectedKey,
      declaredKey,
      distance: d,
      threshold: keyThreshold,
      reason:
        `배경 ${hex(detectedKey)} 이 선언 키 ${hex(declaredKey)} 에서 ${d.toFixed(1)} 떨어져 ` +
        `하드컷 임계 ${keyThreshold} 를 넘습니다 — rgb 경로로는 배경이 지워지지 않아 ycbcr 을 씁니다`,
    };
  }
  return {
    mode: "rgb",
    detectedKey,
    declaredKey,
    distance: d,
    threshold: keyThreshold,
    reason: `배경 ${hex(detectedKey)} 이 선언 키에서 ${d.toFixed(1)} — 하드컷 범위 안이라 rgb 를 씁니다`,
  };
}
