/**
 * 앵커 ref 이미지 베이크 — sprite_gen/anchor.py `anchor_image()` 이식.
 *
 * 셀 크롭 → 콘텐츠 bbox 크롭 → ×8 NEAREST 확대. 픽셀 데이터는 그대로이고, 작은 셀
 * 스프라이트를 image_gen 이 읽을 수 있게 키우기만 한다. 보간하면 도트 경계가 흐려져
 * 레퍼런스의 픽셀 밀도가 왜곡되고, 그것이 곧 생성 행의 스타일이 된다.
 *
 * **파생 캐시다** — 생성 직전마다 큐레이션 진실에서 다시 굽고 그 자리를 덮어쓴다.
 * 정적 스냅샷을 재사용하면 사용자가 프레임을 편집·제외한 순간 소리 없이 낡고, 이후
 * 생성 행 전부가 옛 정체성을 물려받는다 (sprite-gen 실사고 2026-07-19).
 *
 * 원본과의 차이: 원본 `bake_frame` 은 이미 추출된 프레임 파일에 픽셀 편집·변형·
 * pixel-unfake 재양자화를 다시 적용한다. 우리에게 그 편집 레이어가 없고 내용 기반
 * 추출은 후속 단계이므로, 여기서는 시트 PNG + 셀 기하 + 인덱스로 셀을 자른다.
 */
import sharp from "sharp";
import { AnchorUnavailable } from "@/lib/sprite/anchor";
import type { CellSpec } from "@/lib/sprite/request";

export const ANCHOR_SCALE = 8;
/** 콘텐츠 crop 기준 — 프린지 알파를 콘텐츠로 세지 않는다. */
export const CONTENT_ALPHA_FLOOR = 40;

export type BBox = { x0: number; y0: number; x1: number; y1: number };

export function contentBBox(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  floor: number = CONTENT_ALPHA_FLOOR,
): BBox | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = channels >= 4 ? raw[(y * width + x) * channels + 3] : 255;
      if (a < floor) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export type BakeResult = {
  contentSize: [number, number];
  width: number;
  height: number;
  /**
   * 원본에 알파 채널이 있었는지. **false 면 콘텐츠 크롭이 아무 일도 하지 않았다** —
   * `ensureAlpha()` 가 전 픽셀을 255 로 채우므로 bbox 가 항상 셀 전체가 된다.
   *
   * 실측(2026-08-16): codex `image_gen` 결과 PNG 는 `channels: 3, hasAlpha: false` 이고
   * 1254x1254 사과에서 bbox 가 정확히 셀 전체로 나왔다. 즉 raw 생성물에는 이 크롭이
   * 무의미하며, 크로마 배경을 알파로 바꾼 뒤(추출 단계 이후)에만 유효하다. ①의 AA 검사가
   * 같은 이유로 unmeasured 였던 것과 같은 함정이라 조용히 통과시키지 않고 드러낸다.
   */
  sourceHasAlpha: boolean;
};

export async function bakeAnchorImage(opts: {
  sheetPath: string;
  cell: CellSpec;
  cols: number;
  index: number;
  destPath: string;
  scale?: number;
}): Promise<BakeResult> {
  const scale = opts.scale ?? ANCHOR_SCALE;
  const col = opts.index % opts.cols;
  const row = Math.floor(opts.index / opts.cols);

  // ensureAlpha() 전에 원본을 봐야 한다 — 그 뒤에는 알파 유무를 구분할 수 없다.
  const sourceHasAlpha = (await sharp(opts.sheetPath).metadata()).hasAlpha === true;

  const cellBuf = await sharp(opts.sheetPath)
    .extract({
      left: col * opts.cell.width,
      top: row * opts.cell.height,
      width: opts.cell.width,
      height: opts.cell.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const box = contentBBox(
    cellBuf.data,
    cellBuf.info.width,
    cellBuf.info.height,
    cellBuf.info.channels,
  );
  if (!box) {
    throw new AnchorUnavailable(
      "empty-content",
      `anchor: baked anchor frame #${opts.index} is empty (no visible pixels)`,
    );
  }
  const contentW = box.x1 - box.x0 + 1;
  const contentH = box.y1 - box.y0 + 1;

  await sharp(cellBuf.data, {
    raw: {
      width: cellBuf.info.width,
      height: cellBuf.info.height,
      channels: cellBuf.info.channels as 1 | 2 | 3 | 4,
    },
  })
    .extract({ left: box.x0, top: box.y0, width: contentW, height: contentH })
    .resize(contentW * scale, contentH * scale, { kernel: "nearest" })
    .png()
    .toFile(opts.destPath);

  return {
    contentSize: [contentW, contentH],
    width: contentW * scale,
    height: contentH * scale,
    sourceHasAlpha,
  };
}
