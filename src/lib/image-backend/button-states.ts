import sharp from "sharp";

/**
 * 버튼 상태 스프라이트 생성. 결정적 sharp 연산만 사용한다(codex 호출 없음).
 * codex/sharp 경계 준수 — 밝기/채도/축소는 모두 재해석 없는 결정적 변형이다.
 *
 *   normal  : 원본 그대로
 *   hover   : modulate(brightness↑, saturation↑) — 밝고 선명하게
 *   pressed : modulate(brightness↓, saturation↓) + pressedScale 만큼 축소 후
 *             원본 크기 투명 캔버스 중앙에 배치 — 눌려 들어간 느낌
 */

export type ButtonState = "normal" | "hover" | "pressed";

export interface ButtonStateParams {
  hoverBrightness?: number; // 0.5~2.0, 기본 1.25
  hoverSaturation?: number; // 0.5~2.0, 기본 1.15
  pressedBrightness?: number; // 0.5~2.0, 기본 0.75
  pressedSaturation?: number; // 0.5~2.0, 기본 0.85
  pressedScale?: number; // 0.80~1.0, 기본 0.95 (눌린 느낌 축소)
}

const DEFAULTS: Required<ButtonStateParams> = {
  hoverBrightness: 1.25,
  hoverSaturation: 1.15,
  pressedBrightness: 0.75,
  pressedSaturation: 0.85,
  pressedScale: 0.95,
};

/** modulate brightness/saturation 허용 범위. 벗어나면 throw. */
function assertModulateRange(name: string, value: number): void {
  if (value < 0.5 || value > 2.0) {
    throw new Error(`${name} out of range (0.5~2.0): ${value}`);
  }
}

/**
 * 단일 버튼 상태 PNG Buffer 를 생성한다. 출력은 항상 원본 크기(originalW×originalH).
 *
 * @throws 파라미터가 허용 범위를 벗어나면 "out of range" 메시지로 throw.
 */
export async function generateButtonState(
  inputPath: string,
  state: ButtonState,
  params?: ButtonStateParams,
): Promise<Buffer> {
  const p = { ...DEFAULTS, ...params };

  if (state === "normal") {
    // 원본을 충실히 복제 — 변형 없음.
    return sharp(inputPath).png().toBuffer();
  }

  if (state === "hover") {
    assertModulateRange("hoverBrightness", p.hoverBrightness);
    assertModulateRange("hoverSaturation", p.hoverSaturation);
    return sharp(inputPath)
      .ensureAlpha()
      .modulate({ brightness: p.hoverBrightness, saturation: p.hoverSaturation })
      .png()
      .toBuffer();
  }

  // pressed
  assertModulateRange("pressedBrightness", p.pressedBrightness);
  assertModulateRange("pressedSaturation", p.pressedSaturation);
  if (p.pressedScale < 0.8 || p.pressedScale > 1.0) {
    throw new Error(`pressedScale out of range (0.80~1.0): ${p.pressedScale}`);
  }

  const meta = await sharp(inputPath).metadata();
  const originalW = meta.width ?? 0;
  const originalH = meta.height ?? 0;

  // 축소 크기를 한 번만 계산해 resize 와 중앙 오프셋에 동일하게 사용한다.
  const scaledW = Math.max(1, Math.round(originalW * p.pressedScale));
  const scaledH = Math.max(1, Math.round(originalH * p.pressedScale));

  const scaled = await sharp(inputPath)
    .ensureAlpha()
    .modulate({ brightness: p.pressedBrightness, saturation: p.pressedSaturation })
    .resize(scaledW, scaledH)
    .png()
    .toBuffer();

  const left = Math.round((originalW - scaledW) / 2);
  const top = Math.round((originalH - scaledH) / 2);

  return sharp({
    create: {
      width: originalW,
      height: originalH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: scaled, left, top }])
    .png()
    .toBuffer();
}
