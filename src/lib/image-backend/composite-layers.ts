import sharp from "sharp";

/**
 * 씬 프리뷰어 레이어 합성. 각 레이어를 캔버스 크기로 contain-fit 리사이즈하고,
 * opacity(0~100)를 alpha 채널 배수로 적용한 뒤, 입력 순서대로(배열[0]=최하단) over 블렌딩한다.
 *
 * - contain-fit: 정확히 outputWidth×outputHeight 로 패딩(투명) → composite 시 중앙 정렬 보장.
 *   (fit:'inside' 는 패딩 없이 축소된 이미지 크기를 반환해 좌상단에 쏠림.)
 * - sharp composite 에는 opacity 옵션이 없으므로 raw RGBA alpha 채널을 직접 multiply 한다.
 *   sharp 는 straight(non-premultiplied) alpha 를 가정하므로 이 방식이 표준.
 */

/**
 * 레이어별 색보정 필터. 미지정/중립값이면 해당 sharp 연산을 스킵한다.
 * - brightness/saturation/contrast: %, 100=중립. hue: 도(°), 0=중립. blur: px, 0=없음.
 */
export interface LayerFilters {
  brightness?: number;
  saturation?: number;
  hue?: number;
  contrast?: number;
  blur?: number;
}

/** 필터가 모두 중립(또는 미지정)이면 true — 적용 시 화면이 바뀌지 않는다. */
function isNeutralFilters(f?: LayerFilters): boolean {
  if (!f) return true;
  const { brightness, saturation, hue, contrast, blur } = f;
  return (
    (brightness === undefined || brightness === 100) &&
    (saturation === undefined || saturation === 100) &&
    (hue === undefined || hue === 0) &&
    (contrast === undefined || contrast === 100) &&
    (blur === undefined || blur === 0)
  );
}

/**
 * 필터 체인을 sharp 인스턴스에 적용한다(in-place). 알파 보존이 핵심.
 * - modulate: brightness/saturation = v/100, hue = 도. (투명 픽셀 알파 보존됨.)
 * - contrast: linear(a=v/100, b=128*(1-a)). 스칼라 대신 채널별 배열형([a,a,a,1],[b,b,b,0])을
 *   써서 알파 채널엔 항등(a=1,b=0)을 적용 — 투명 배경이 불투명해지는 것을 방지한다.
 * - blur: sigma≈px/2. sharp 는 sigma<0.3 에서 throw 하므로 그 미만은 스킵.
 */
function applyFilters(chain: sharp.Sharp, f: LayerFilters): sharp.Sharp {
  const brightness = f.brightness ?? 100;
  const saturation = f.saturation ?? 100;
  const hue = f.hue ?? 0;
  const contrast = f.contrast ?? 100;
  const blur = f.blur ?? 0;

  if (brightness !== 100 || saturation !== 100 || hue !== 0) {
    chain.modulate({ brightness: brightness / 100, saturation: saturation / 100, hue });
  }
  if (contrast !== 100) {
    const a = contrast / 100;
    const b = 128 * (1 - a);
    chain.linear([a, a, a, 1], [b, b, b, 0]);
  }
  const sigma = blur / 2;
  if (sigma >= 0.3) {
    chain.blur(sigma);
  }
  return chain;
}

async function applyOpacity(buf: Buffer, opacity: number): Promise<Buffer> {
  if (opacity >= 100) return buf;
  const factor = Math.max(0, opacity) / 100;
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * factor);
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * x/y/scale/stretch/rotation/flip/filters 가 지정된 레이어를 배치한다.
 * - contain-fit 비율로 outputWidth×outputHeight 에 맞춘 크기(scale 배)를 기준으로,
 *   stretchW/H 로 비균일 늘이기(fit:'fill') → rotate → flipH(flop) → filters 순으로 변형한다.
 *   이 순서여야 rotate 의 투명 코너 채움·필터 색보정이 자연스럽게 합쳐진다.
 * - 좌상단 위치 = 캔버스 중앙 기준 오프셋: left=(outW-scaledW)/2+x, top=(outH-scaledH)/2+y.
 * - sharp 는 overlay 가 base 보다 크면(scale>1·stretch>1 이면) throw 하므로, 배치 사각형을 캔버스와
 *   교집합해 보이는 영역만 extract 한 뒤 그 좌상단에 합성한다(crop-to-visible-window). 음수 오프셋·
 *   오버사이즈·부분 이탈을 한 경로로 균일 처리. 교집합이 비면(완전 이탈) null 을 반환해 스킵.
 *   (_workspace/sharp-bounds-test.md 참조)
 */
async function placeWithTransform(
  imagePath: string,
  outputWidth: number,
  outputHeight: number,
  x: number,
  y: number,
  scale: number,
  rotation: number,
  stretchW: number,
  stretchH: number,
  flipH: boolean,
  filters?: LayerFilters,
): Promise<{ input: Buffer; left: number; top: number } | null> {
  // 1) scale: contain 비율을 유지하며 scale 배 캔버스에 맞춘다(fit:'inside').
  const scaledTargetW = Math.max(1, Math.round(outputWidth * scale));
  const scaledTargetH = Math.max(1, Math.round(outputHeight * scale));
  let chain = sharp(imagePath)
    .ensureAlpha()
    .resize(scaledTargetW, scaledTargetH, { fit: "inside" });
  // 2) stretch: 비균일 늘이기. fit:'inside' 는 비율을 보존하므로 stretch 는 별도 fill 리사이즈로 적용.
  //    현재 크기를 메타로 읽어 stretchW/H 를 곱한 목표 크기로 fit:'fill'(비율 무시) 리사이즈한다.
  if (stretchW !== 1 || stretchH !== 1) {
    const pre = await chain.png().toBuffer();
    const preMeta = await sharp(pre).metadata();
    const tw = Math.max(1, Math.round((preMeta.width ?? scaledTargetW) * stretchW));
    const th = Math.max(1, Math.round((preMeta.height ?? scaledTargetH) * stretchH));
    chain = sharp(pre).resize(tw, th, { fit: "fill" });
  }
  // 3) rotate: 0이 아닐 때만. sharp rotate 는 바운딩 박스를 확장해 투명 배경으로 채운다.
  if (rotation !== 0) {
    chain.rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  // 4) flipH: 좌우반전 = sharp flop()(flip()은 상하반전이므로 주의).
  if (flipH) {
    chain.flop();
  }
  // 5) filters: 중립이 아니면 색보정을 굽는다(알파 보존).
  if (filters && !isNeutralFilters(filters)) {
    chain = applyFilters(chain, filters);
  }
  const scaled = await chain.png().toBuffer();
  const meta = await sharp(scaled).metadata();
  const scaledW = meta.width ?? scaledTargetW;
  const scaledH = meta.height ?? scaledTargetH;

  const left = Math.round((outputWidth - scaledW) / 2 + x);
  const top = Math.round((outputHeight - scaledH) / 2 + y);

  // 배치 사각형 ∩ 캔버스.
  const ix = Math.max(0, left);
  const iy = Math.max(0, top);
  const ix2 = Math.min(outputWidth, left + scaledW);
  const iy2 = Math.min(outputHeight, top + scaledH);
  const iw = ix2 - ix;
  const ih = iy2 - iy;
  if (iw <= 0 || ih <= 0) return null; // 완전히 캔버스 밖.

  // 교집합 영역을 스케일된 레이어 좌표계로 환산해 extract.
  const cropLeft = ix - left;
  const cropTop = iy - top;
  if (cropLeft === 0 && cropTop === 0 && iw === scaledW && ih === scaledH) {
    // 완전히 캔버스 안 — extract 불필요.
    return { input: scaled, left: ix, top: iy };
  }
  const cropped = await sharp(scaled)
    .extract({ left: cropLeft, top: cropTop, width: iw, height: ih })
    .png()
    .toBuffer();
  return { input: cropped, left: ix, top: iy };
}

export async function mergeImages(params: {
  layers: {
    imagePath: string;
    opacity: number;
    x?: number;
    y?: number;
    scale?: number;
    rotation?: number;
    stretchW?: number;
    stretchH?: number;
    flipH?: boolean;
    filters?: LayerFilters;
  }[];
  outputWidth: number;
  outputHeight: number;
  outPath: string;
}): Promise<{ width: number; height: number }> {
  const { layers, outputWidth, outputHeight, outPath } = params;

  const compositeInputs: { input: Buffer; blend: "over"; left?: number; top?: number }[] = [];
  for (const layer of layers) {
    const rotation = layer.rotation ?? 0;
    const stretchW = layer.stretchW ?? 1;
    const stretchH = layer.stretchH ?? 1;
    const flipH = layer.flipH ?? false;
    // 변형/필터가 하나라도 비중립이면 placeWithTransform 경로. 모두 중립이면 기존 contain-fit 경로로
    // 떨어져 하위호환을 보장한다(필터만 지정된 레이어가 폴백으로 새지 않도록 게이트에 포함).
    const hasTransform =
      layer.x !== undefined ||
      layer.y !== undefined ||
      layer.scale !== undefined ||
      rotation !== 0 ||
      stretchW !== 1 ||
      stretchH !== 1 ||
      flipH ||
      !isNeutralFilters(layer.filters);
    if (hasTransform) {
      const placed = await placeWithTransform(
        layer.imagePath,
        outputWidth,
        outputHeight,
        layer.x ?? 0,
        layer.y ?? 0,
        layer.scale ?? 1,
        rotation,
        stretchW,
        stretchH,
        flipH,
        layer.filters,
      );
      if (!placed) continue; // 완전히 캔버스 밖 — 스킵.
      const withOpacity = await applyOpacity(placed.input, layer.opacity);
      compositeInputs.push({ input: withOpacity, blend: "over", left: placed.left, top: placed.top });
      continue;
    }
    // x/y/scale 미지정 — 기존 contain-fit 중앙 정렬 경로 (backward compat).
    const fitted = await sharp(layer.imagePath)
      .ensureAlpha()
      .resize(outputWidth, outputHeight, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const withOpacity = await applyOpacity(fitted, layer.opacity);
    compositeInputs.push({ input: withOpacity, blend: "over" });
  }

  await sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toFile(outPath);

  return { width: outputWidth, height: outputHeight };
}
