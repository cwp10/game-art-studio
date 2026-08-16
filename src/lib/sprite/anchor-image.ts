/**
 * 앵커 ref 이미지 베이크 — sprite_gen/anchor.py `anchor_image()` 이식.
 *
 * 콘텐츠 bbox 로 crop 한 뒤 ×scale 니어리스트 확대. 픽셀 데이터는 그대로이고, 작은 셀
 * 스프라이트를 image_gen 이 읽을 수 있게 키우기만 한다. NEAREST 여야 한다 — 보간하면
 * 도트 경계가 흐려져 레퍼런스의 픽셀 밀도가 왜곡되고, 그것이 곧 생성 행의 스타일이 된다.
 *
 * **입력은 추출된 프레임이다**(원본 `bake_frame` 과 같은 위치). raw 시트를 셀로 잘라
 * 넣으면 알파가 없어 콘텐츠 크롭이 셀 전체가 되고, 배경 조각이 앵커가 된다.
 *
 * **파생 캐시다** — 생성 직전마다 큐레이션 진실에서 다시 굽고 그 자리를 덮어쓴다.
 * 정적 스냅샷을 재사용하면 사용자가 프레임을 편집·제외한 순간 소리 없이 낡는다.
 */
import sharp from "sharp";
import { AnchorUnavailable } from "@/lib/sprite/anchor";

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

export type BakeResult = { contentSize: [number, number]; width: number; height: number };

export async function bakeAnchorImage(opts: {
  /** 추출된 프레임 PNG (셀 크기, 알파 있음). */
  framePath: string;
  destPath: string;
  scale?: number;
}): Promise<BakeResult> {
  const scale = opts.scale ?? ANCHOR_SCALE;
  const { data, info } = await sharp(opts.framePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const box = contentBBox(data, info.width, info.height, info.channels);
  if (!box) {
    throw new AnchorUnavailable(
      "empty-content",
      `anchor: baked anchor frame ${opts.framePath} is empty (no visible pixels)`,
    );
  }
  const contentW = box.x1 - box.x0 + 1;
  const contentH = box.y1 - box.y0 + 1;

  await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels as 1 | 2 | 3 | 4,
    },
  })
    .extract({ left: box.x0, top: box.y0, width: contentW, height: contentH })
    .resize(contentW * scale, contentH * scale, { kernel: "nearest" })
    .png()
    .toFile(opts.destPath);

  return { contentSize: [contentW, contentH], width: contentW * scale, height: contentH * scale };
}
