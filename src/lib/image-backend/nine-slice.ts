import sharp from "sharp";

/**
 * 9-slice 이미지 처리. 결정적 sharp 연산만 사용한다(codex 호출 없음). codex/sharp 경계 준수.
 *
 * 이미지를 inset(left/right/top/bottom 픽셀) 기준으로 9개 구역으로 나눈다:
 *
 *   ┌──────┬─────────────┬──────┐
 *   │  TL  │     TC      │  TR  │
 *   ├──────┼─────────────┼──────┤
 *   │  ML  │     MC      │  MR  │
 *   ├──────┼─────────────┼──────┤
 *   │  BL  │     BC      │  BR  │
 *   └──────┴─────────────┴──────┘
 *
 * 코너(TL/TR/BL/BR)는 고정 크기, 가로 엣지(TC/BC)는 가로로, 세로 엣지(ML/MR)는
 * 세로로, 중앙(MC)은 양방향으로 늘어난다.
 */

export interface NineSliceInset {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** inset 으로 나뉜 9개 구역의 소스 추출 좌표/크기. */
interface Region {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 소스 이미지(W×H)와 inset 으로 9개 구역의 추출 사각형을 계산. */
function sourceRegions(W: number, H: number, inset: NineSliceInset): Region[] {
  const { left: l, right: r, top: t, bottom: b } = inset;
  const midW = W - l - r;
  const midH = H - t - b;
  return [
    { name: "TL", x: 0, y: 0, w: l, h: t },
    { name: "TC", x: l, y: 0, w: midW, h: t },
    { name: "TR", x: W - r, y: 0, w: r, h: t },
    { name: "ML", x: 0, y: t, w: l, h: midH },
    { name: "MC", x: l, y: t, w: midW, h: midH },
    { name: "MR", x: W - r, y: t, w: r, h: midH },
    { name: "BL", x: 0, y: H - b, w: l, h: b },
    { name: "BC", x: l, y: H - b, w: midW, h: b },
    { name: "BR", x: W - r, y: H - b, w: r, h: b },
  ];
}

/** inset 이 이미지 크기를 초과하면 throw. */
function assertInsetFits(W: number, H: number, inset: NineSliceInset): void {
  if (inset.left + inset.right >= W || inset.top + inset.bottom >= H) {
    throw new Error("inset exceeds image dimensions");
  }
}

/**
 * 함수 1: 원본과 동일 크기·내용의 9-slice 그리드 PNG. 피스 경계에 1px 구분선(gray
 * #888 반투명)을 그려 슬라이스 영역을 시각적으로 표시한다.
 */
export async function makeNineSliceGrid(
  inputPath: string,
  inset: NineSliceInset,
): Promise<Buffer> {
  const meta = await sharp(inputPath).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  assertInsetFits(W, H, inset);

  const { left: l, right: r, top: t, bottom: b } = inset;

  // 원본 위치(소스 좌표 = 대상 좌표)에 그대로 composite — 그리드 결과는 원본과 동일.
  const regions = sourceRegions(W, H, inset);
  const pieces: sharp.OverlayOptions[] = [];
  for (const reg of regions) {
    if (reg.w < 1 || reg.h < 1) continue;
    const piece = await sharp(inputPath)
      .extract({ left: reg.x, top: reg.y, width: reg.w, height: reg.h })
      .png()
      .toBuffer();
    pieces.push({ input: piece, left: reg.x, top: reg.y });
  }

  // 슬라이스 경계선 — 세로선 x=l, x=W-r / 가로선 y=t, y=H-b. gray #888 반투명.
  const lines: string[] = [];
  const stroke = `stroke="#888888" stroke-opacity="0.6" stroke-width="1"`;
  for (const x of [l, W - r]) {
    if (x > 0 && x < W) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" ${stroke} />`);
  }
  for (const y of [t, H - b]) {
    if (y > 0 && y < H) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" ${stroke} />`);
  }
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join("")}</svg>`,
  );
  pieces.push({ input: overlay, left: 0, top: 0 });

  return sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(pieces)
    .png()
    .toBuffer();
}

/**
 * 함수 2: 9-slice 스케일. 코너는 고정, 엣지/중앙은 늘려 targetW×targetH 로 리사이즈.
 * fit:'fill' — 비율 무시(9-slice 는 의도적으로 비율 깨짐).
 */
export async function scaleWithNineSlice(
  inputPath: string,
  inset: NineSliceInset,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  const meta = await sharp(inputPath).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  assertInsetFits(W, H, inset);

  const { left: l, right: r, top: t, bottom: b } = inset;
  const srcMidW = W - l - r;
  const srcMidH = H - t - b;
  const dstMidW = targetW - l - r;
  const dstMidH = targetH - t - b;

  const src = sourceRegions(W, H, inset);
  const byName = (n: string) => src.find((s) => s.name === n)!;

  // 각 대상 구역: 추출할 소스 사각형 + 대상 위치 + 대상 크기.
  // 코너는 native 크기 유지. 가로 엣지는 dstMidW, 세로 엣지는 dstMidH 로 늘림.
  const targets: Array<{ region: Region; dstX: number; dstY: number; dstW: number; dstH: number }> = [
    { region: byName("TL"), dstX: 0, dstY: 0, dstW: l, dstH: t },
    { region: byName("TC"), dstX: l, dstY: 0, dstW: dstMidW, dstH: t },
    { region: byName("TR"), dstX: targetW - r, dstY: 0, dstW: r, dstH: t },
    { region: byName("ML"), dstX: 0, dstY: t, dstW: l, dstH: dstMidH },
    { region: byName("MC"), dstX: l, dstY: t, dstW: dstMidW, dstH: dstMidH },
    { region: byName("MR"), dstX: targetW - r, dstY: t, dstW: r, dstH: dstMidH },
    { region: byName("BL"), dstX: 0, dstY: targetH - b, dstW: l, dstH: b },
    { region: byName("BC"), dstX: l, dstY: targetH - b, dstW: dstMidW, dstH: b },
    { region: byName("BR"), dstX: targetW - r, dstY: targetH - b, dstW: r, dstH: b },
  ];

  // srcMidW/srcMidH 가 0 이면 가로/세로 엣지·중앙 구역 자체가 존재하지 않으므로 건너뛴다.
  void srcMidW;
  void srcMidH;

  const pieces: sharp.OverlayOptions[] = [];
  for (const tgt of targets) {
    const { region, dstX, dstY, dstW, dstH } = tgt;
    if (region.w < 1 || region.h < 1) continue; // 소스 0px 구역 skip
    if (dstW < 1 || dstH < 1) continue; // 대상 0px 구역 skip
    const piece = await sharp(inputPath)
      .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
      .resize(dstW, dstH, { fit: "fill" })
      .png()
      .toBuffer();
    pieces.push({ input: piece, left: dstX, top: dstY });
  }

  return sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(pieces)
    .png()
    .toBuffer();
}
