/**
 * 배경 방식 결정 레코드 — 프롬프트와 후처리가 **같은 한 번의 판단**을 따르게 한다.
 *
 * **정본에 없는 확장이다.** sprite-gen 은 VFX 를 다루지 않아 크로마만 있다. 다만 정본이
 * 크로마 키 선택을 다루는 방식(무엇을 왜 골랐는지 request 에 기록하고 하류는 재판정하지
 * 않는다)을 그대로 따른다.
 *
 * ## 왜 필요한가 — 실측
 *
 * 초록 위에 알파 0→1 그라디언트를 굽고 정본 3패스를 돌리면 **부분 알파가 하나도 나오지
 * 않는다.** 11개 표본 전부 0 또는 1이고, 중간 구간은 불투명으로 굳으면서 초록이 색에
 * 남는다(G=255). 같은 내용을 검정 위에 놓고 luma 를 걸면 11/11 을 정확히 복원한다.
 *
 * 원리 문제가 아니라 **튜닝**이다. `keyThreshold=96` 하드컷이 옅은 구간을 삭제하고,
 * `unmixReach=4` 가 넓은 그라디언트에 닿지 않는다. 둘 다 "불투명 실루엣 + 얇은 AA
 * 가장자리" 전제이며 캐릭터에는 정확히 맞다. 정본은 반투명을 **프롬프트로 금지**해
 * (`TRANSPARENCY_ARTIFACT_RULES`: glow·aura·halo·blur 금지) 이 문제를 피한다.
 *
 * ## 오분류의 위험이 비대칭이다
 *
 *   크로마 배경 + 크로마 (지금) — 이펙트 알파가 이진 계단. 나쁘지만 그림은 남는다
 *   검정 배경  + 크로마        — 아무것도 안 지워진다. 눈에 바로 보인다
 *   크로마 배경 + luma         — **파괴적.** 초록(luma 255)이 전부 불투명으로 남고
 *                                어두운 소재는 소멸한다
 *
 * 그래서 luma 는 반드시 `verifyLumaBackground` 를 통과한 뒤에만 건다.
 */
import sharp from "sharp";
import { VFX_EFFECT_RE, type ChromaKeyColor } from "@/lib/image-backend/chroma-key";

export type BackgroundMode = "chroma" | "luma";

export type BackgroundDecision = {
  mode: BackgroundMode;
  /** `mode: "chroma"` 일 때만 의미가 있다. */
  keyColor: ChromaKeyColor;
  selection: "auto" | "manual";
  /** 왜 이렇게 정했는지 — 사후에 짚을 수 있어야 한다. */
  reason: string;
};

/**
 * 배경 방식을 **한 번** 정한다. 프롬프트 빌더와 후처리가 이 레코드를 읽는다.
 *
 * `subjectType` 은 판정의 입력 중 하나일 뿐 결정 자체가 아니다 — 정본 규칙대로 만든
 * 하드엣지 슬래시 이펙트는 불투명이라 크로마가 맞고, 반투명 오라를 두른 캐릭터는 luma 가
 * 맞다. 그래서 이펙트이면서 **VFX 어휘가 실제로 나올 때만** luma 로 간다.
 */
export function decideBackgroundMode(input: {
  prompt: string;
  subjectType?: string | null;
  /** 참조 이미지 본체가 녹색 우세인가 — 크로마 키 색 폴백의 입력. */
  refIsGreen?: boolean;
  /** 사람이 지정한 값. 있으면 자동 판정을 건너뛴다. */
  override?: BackgroundMode;
  /** 사람이 지정한 크로마 키 색. */
  keyColorOverride?: ChromaKeyColor;
  /** 프롬프트 키워드로 판정한 녹색 소재 여부. */
  greenSubject?: boolean;
}): BackgroundDecision {
  const keyColor: ChromaKeyColor =
    input.keyColorOverride ?? (input.greenSubject || input.refIsGreen ? "magenta" : "green");

  if (input.override) {
    return {
      mode: input.override,
      keyColor,
      selection: "manual",
      reason: `사람이 ${input.override} 로 지정`,
    };
  }

  const isEffect = input.subjectType === "effect";
  const looksVfx = VFX_EFFECT_RE.test(input.prompt);
  if (isEffect && looksVfx) {
    return {
      mode: "luma",
      keyColor,
      selection: "auto",
      reason:
        "이펙트 + VFX 어휘 — 크로마는 넓은 반투명에서 부분 알파를 내지 못한다" +
        "(하드컷 96 이 옅은 구간을 지우고 unmixReach 4 가 그라디언트에 닿지 않는다)",
    };
  }
  if (isEffect) {
    return {
      mode: "chroma",
      keyColor,
      selection: "auto",
      reason: "이펙트지만 VFX 어휘가 없다 — 하드엣지 스프라이트로 보고 크로마를 쓴다",
    };
  }
  return {
    mode: "chroma",
    keyColor,
    selection: "auto",
    reason: `${input.subjectType ?? "unknown"} — 불투명 실루엣 전제, 크로마`,
  };
}

/** 배경을 검정으로 볼 상한. 이보다 밝으면 luma 를 걸면 안 된다. */
const LUMA_BACKGROUND_MAX = 24;

export type LumaVerdict = {
  ok: boolean;
  /** 테두리 픽셀 luma 의 중앙값. */
  medianBorderLuma: number;
  reason: string;
};

/**
 * luma 를 걸기 전 배경이 실제로 검정인지 확인한다.
 *
 * 정본은 크로마에 대해 *"변환 후 소재색이 보존됐는지 확인하는 것이 계약의 일부"* 라고
 * 못박는다. luma 는 반대 방향으로 같은 위험이 있다 — 배경이 검정이 아니면 배경 전체가
 * 불투명하게 남고 소재는 알파가 깎인다. 그래서 **키를 걸기 전에** 막는다.
 *
 * 테두리 한 줄만 본다: 피사체는 안전 여백 안에 있으므로 테두리는 배경이어야 한다.
 */
export async function verifyLumaBackground(filePath: string): Promise<LumaVerdict> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const lumas: number[] = [];
  const at = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    lumas.push(at(x, 0), at(x, h - 1));
  }
  for (let y = 1; y < h - 1; y++) {
    lumas.push(at(0, y), at(w - 1, y));
  }
  lumas.sort((a, b) => a - b);
  const median = lumas[Math.floor(lumas.length / 2)] ?? 0;
  const ok = median <= LUMA_BACKGROUND_MAX;
  return {
    ok,
    medianBorderLuma: median,
    reason: ok
      ? `테두리 luma 중앙값 ${median} ≤ ${LUMA_BACKGROUND_MAX} — 검정 배경 확인`
      : `테두리 luma 중앙값 ${median} > ${LUMA_BACKGROUND_MAX} — 배경이 검정이 아니다. ` +
        `luma 를 걸면 배경이 불투명하게 남고 어두운 소재의 알파가 깎인다`,
  };
}
