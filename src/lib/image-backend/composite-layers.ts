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
 * x/y/scale 가 지정된 레이어를 배치한다.
 * - contain-fit 비율로 outputWidth×outputHeight 에 맞춘 크기(fitW×fitH)를 scale 배율로 키운다.
 * - 좌상단 위치 = 캔버스 중앙 기준 오프셋: left=(outW-scaledW)/2+x, top=(outH-scaledH)/2+y.
 * - sharp 는 overlay 가 base 보다 크면(scale>1 이면 항상) throw 하므로, 배치 사각형을 캔버스와
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
): Promise<{ input: Buffer; left: number; top: number } | null> {
  // fit:'inside' 로 contain 비율을 유지하며 scale 배 캔버스에 맞춘다 → 실제 크기는 비율에 따라
  // 폭/높이 중 한쪽이 목표에 닿는다. 정확한 결과 크기는 버퍼 메타로 다시 읽는다.
  const scaledTargetW = Math.max(1, Math.round(outputWidth * scale));
  const scaledTargetH = Math.max(1, Math.round(outputHeight * scale));
  const chain = sharp(imagePath).ensureAlpha();
  // 회전이 0이 아닐 때만 적용 — sharp rotate 는 바운딩 박스를 확장해 투명 배경으로 채운다.
  if (rotation !== 0) {
    chain.rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  const scaled = await chain
    .resize(scaledTargetW, scaledTargetH, { fit: "inside" })
    .png()
    .toBuffer();
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
  layers: { imagePath: string; opacity: number; x?: number; y?: number; scale?: number; rotation?: number }[];
  outputWidth: number;
  outputHeight: number;
  outPath: string;
}): Promise<{ width: number; height: number }> {
  const { layers, outputWidth, outputHeight, outPath } = params;

  const compositeInputs: { input: Buffer; blend: "over"; left?: number; top?: number }[] = [];
  for (const layer of layers) {
    const rotation = layer.rotation ?? 0;
    const hasTransform =
      layer.x !== undefined || layer.y !== undefined || layer.scale !== undefined || rotation !== 0;
    if (hasTransform) {
      const placed = await placeWithTransform(
        layer.imagePath,
        outputWidth,
        outputHeight,
        layer.x ?? 0,
        layer.y ?? 0,
        layer.scale ?? 1,
        rotation,
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
