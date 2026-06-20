import sharp from "sharp";

/**
 * 스프라이트시트 셀 단위 알파 마스크 이펙트.
 *
 * 각 셀을 개별 cellW×cellH 투명 캔버스 위에서 처리하므로 드롭 섀도우/글로우/아웃라인이
 * 셀 경계를 넘어 옆 셀로 번지지 않는다(블리딩 방지). 효과 레이어는 스프라이트 아래(under)에
 * 깔린다.
 *
 * 결정적 sharp 연산만 사용한다(codex 호출 없음). codex/sharp 경계 준수.
 */

export type SpriteEffect = "drop_shadow" | "outline" | "glow";

export interface SpriteEffectParams {
  color?: string; // hex, e.g. '#000000' — default '#000000'
  opacity?: number; // 0-100 — default 70
  blur?: number; // sigma — default 3
  offsetX?: number; // pixels, drop_shadow only — default 4
  offsetY?: number; // pixels, drop_shadow only — default 4
  thickness?: number; // pixels dilate, outline only — default 2
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

/** 단일 채널(그레이스케일) 알파 버퍼에 opacity(0~100) 배수를 곱한다. */
function scaleAlphaInPlace(data: Buffer, opacity: number): void {
  if (opacity >= 100) return;
  const factor = Math.max(0, opacity) / 100;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(data[i] * factor);
  }
}

/**
 * 처리된 알파 마스크(단일 채널 raw)를 고정색 RGB 와 결합해 컬러라이즈한 RGBA PNG 를 만든다.
 * tint 는 곱셈이라 평평한 색이 안 나오므로, 고정색 캔버스에 알파를 joinChannel 한다.
 */
async function colorize(
  alphaRaw: Buffer,
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const solid = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: color.r, g: color.g, b: color.b },
    },
  })
    .raw()
    .toBuffer();
  return sharp(solid, { raw: { width, height, channels: 3 } })
    .joinChannel(alphaRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** 셀의 알파 채널을 단일 채널 raw 로 추출. */
async function extractAlphaRaw(cellPng: Buffer): Promise<Buffer> {
  return sharp(cellPng).ensureAlpha().extractChannel("alpha").raw().toBuffer();
}

/**
 * 한 셀의 effect 레이어(컬러라이즈된 RGBA PNG)를 만든다.
 * drop_shadow/glow/outline 모두 알파 마스크 → 변형(blur/dilate) → colorize → opacity.
 * 반환: { layer, offsetX, offsetY } — 셀 캔버스에서 effect 를 합성할 오프셋.
 */
async function buildEffectLayer(
  cellPng: Buffer,
  cellW: number,
  cellH: number,
  effect: SpriteEffect,
  p: Required<
    Pick<SpriteEffectParams, "opacity" | "blur" | "offsetX" | "offsetY" | "thickness">
  > & { color: { r: number; g: number; b: number } },
): Promise<{ layer: Buffer; offsetX: number; offsetY: number }> {
  const alpha = await extractAlphaRaw(cellPng);

  if (effect === "drop_shadow") {
    const blurred = await sharp(alpha, { raw: { width: cellW, height: cellH, channels: 1 } })
      .blur(p.blur > 0 ? p.blur : 0.3)
      .raw()
      .toBuffer();
    scaleAlphaInPlace(blurred, p.opacity);
    const layer = await colorize(blurred, cellW, cellH, p.color);
    return { layer, offsetX: p.offsetX, offsetY: p.offsetY };
  }

  if (effect === "glow") {
    const blurred = await sharp(alpha, { raw: { width: cellW, height: cellH, channels: 1 } })
      .blur(p.blur > 0 ? p.blur : 0.3)
      .raw()
      .toBuffer();
    scaleAlphaInPlace(blurred, p.opacity);
    const layer = await colorize(blurred, cellW, cellH, p.color);
    return { layer, offsetX: 0, offsetY: 0 };
  }

  // outline: 알파 팽창(dilate) 근사 = blur(thickness) 후 threshold(1) 로 가장자리를 두껍게.
  // threshold 로 0/255 이진화 → 스프라이트 윤곽 밖으로 thickness 만큼 번진 단단한 림.
  // threshold 는 결과를 3채널 sRGB 로 승격하므로 toColourspace('b-w') 로 다시 단일 채널로 되돌린다.
  // (안 그러면 colorize 의 joinChannel 이 1채널을 기대하는데 3채널 버퍼가 들어와 throw.)
  const dilated = await sharp(alpha, { raw: { width: cellW, height: cellH, channels: 1 } })
    .blur(p.thickness > 0 ? p.thickness : 0.3)
    .threshold(1)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  scaleAlphaInPlace(dilated, p.opacity);
  const layer = await colorize(dilated, cellW, cellH, p.color);
  return { layer, offsetX: 0, offsetY: 0 };
}

export async function applySpritesheetEffect(params: {
  inputPath: string;
  effect: SpriteEffect;
  effectParams: SpriteEffectParams;
  cols: number;
  rows: number;
  outPath: string;
}): Promise<{ width: number; height: number }> {
  const { inputPath, effect, effectParams, cols, rows, outPath } = params;

  const meta = await sharp(inputPath).metadata();
  const imageW = meta.width ?? 0;
  const imageH = meta.height ?? 0;
  if (!imageW || !imageH) {
    throw new Error("could not read input image dimensions");
  }
  if (imageW % cols !== 0 || imageH % rows !== 0) {
    // 스프라이트시트는 항상 정수 배수로 생성되므로 정상 입력에선 발생하지 않는다.
    // floor 로 진행하되 셀 정렬이 어긋날 수 있어 경고.
    // eslint-disable-next-line no-console
    console.warn(
      `[sprite-effect] non-integer cell geometry: ${imageW}x${imageH} / ${cols}x${rows}`,
    );
  }
  const cellW = Math.floor(imageW / cols);
  const cellH = Math.floor(imageH / rows);

  const color = parseHexColor(effectParams.color ?? "#000000");
  const p = {
    color,
    opacity: effectParams.opacity ?? 70,
    blur: effectParams.blur ?? 3,
    offsetX: effectParams.offsetX ?? 4,
    offsetY: effectParams.offsetY ?? 4,
    thickness: effectParams.thickness ?? 2,
  };

  // 출력 캔버스(전체 시트 크기) — 셀별 처리 결과를 제자리에 합성.
  const sheetComposites: { input: Buffer; left: number; top: number; blend: "over" }[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellLeft = col * cellW;
      const cellTop = row * cellH;
      const cellPng = await sharp(inputPath)
        .extract({ left: cellLeft, top: cellTop, width: cellW, height: cellH })
        .ensureAlpha()
        .png()
        .toBuffer();

      const { layer, offsetX, offsetY } = await buildEffectLayer(
        cellPng,
        cellW,
        cellH,
        effect,
        p,
      );

      // 셀 전용 투명 캔버스: effect 를 아래(under)에 offset 위치로, 스프라이트를 위에 그대로.
      // offset 으로 셀 경계를 넘는 부분은 sharp 가 클립한다(블리딩 방지). 음수/이탈 모두 안전.
      const cellEffectInputs: { input: Buffer; left: number; top: number; blend: "over" }[] = [
        { input: layer, left: offsetX, top: offsetY, blend: "over" },
        { input: cellPng, left: 0, top: 0, blend: "over" },
      ];
      const composedCell = await sharp({
        create: {
          width: cellW,
          height: cellH,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(cellEffectInputs)
        .png()
        .toBuffer();

      sheetComposites.push({ input: composedCell, left: cellLeft, top: cellTop, blend: "over" });
    }
  }

  await sharp({
    create: {
      width: imageW,
      height: imageH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(sheetComposites)
    .png()
    .toFile(outPath);

  return { width: imageW, height: imageH };
}
