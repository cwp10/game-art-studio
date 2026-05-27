/**
 * 결정적(픽셀-퍼펙트) 색교체 — 리스킨 모드 b의 "정밀" 경로.
 *
 * codex img2img(재생성)와 달리 형태를 100% 보존: 모든 픽셀은 제자리에 있고
 * 색상만 바뀐다. 스프라이트 음영·그라데이션·안티에일리어싱 가장자리를 살리기 위해
 * HSL 색공간에서 **색조(H)·채도(S)만 교체하고 명도(L)는 유지**한다.
 *
 * 매핑은 first-match-wins 순서. 회색(저채도) 픽셀은 기본 제외 → 외곽선·하이라이트가
 * 물들지 않는다(매핑의 from 이 회색이면 명도 밴드로 매칭해 포함 가능).
 */

import sharp from "sharp";

export type ColorMapping = {
  /** 원본에서 바꿀 대표 색 (#rrggbb). */
  from: string;
  /** 바꿀 타깃 색 (#rrggbb). */
  to: string;
  /** 색조 매칭 허용 오차(도, 0~180). 미지정 시 기본 25. */
  tolerance?: number;
};

export type RecolorOptions = {
  /** true 면 회색(저채도) 픽셀도 매핑 대상에 포함. 기본 false. */
  includeGrays?: boolean;
};

/** 저채도 컷오프 — 이 미만이면 "회색 계열"로 간주. */
const SAT_MIN = 0.12;
/** 회색 매핑 시 명도 밴드(±). */
const GRAY_LIGHTNESS_TOL = 0.18;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** RGB(0~255) → HSL(h:0~360, s:0~1, l:0~1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** HSL → RGB(0~255 반올림). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** 색조 원형 거리(0~180도). */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

type CompiledMapping = {
  fromGray: boolean;
  fromHue: number;
  fromSat: number;
  fromLight: number;
  toHue: number;
  toSat: number;
  tolerance: number;
};

/**
 * 매핑 배열로 PNG 버퍼를 색교체. 입력 형태/알파를 보존하고 PNG 버퍼를 반환.
 * 유효 매핑이 0개면 입력을 그대로 PNG 로 재인코딩해 반환.
 */
export async function recolorImage(
  input: Buffer,
  mappings: ColorMapping[],
  opts: RecolorOptions = {},
): Promise<Buffer> {
  const compiled: CompiledMapping[] = [];
  for (const m of mappings) {
    const from = hexToRgb(m.from);
    const to = hexToRgb(m.to);
    if (!from || !to) continue;
    const [fh, fs, fl] = rgbToHsl(...from);
    const [th, ts] = rgbToHsl(...to);
    compiled.push({
      fromGray: fs < SAT_MIN,
      fromHue: fh,
      fromSat: fs,
      fromLight: fl,
      toHue: th,
      toSat: ts,
      tolerance: m.tolerance != null ? Math.max(0, Math.min(180, m.tolerance)) : 25,
    });
  }

  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (compiled.length === 0) {
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
  }

  const includeGrays = opts.includeGrays === true;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // 완전 투명은 건너뜀
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const pixelGray = s < SAT_MIN;
    if (pixelGray && !includeGrays) continue;

    let hit: CompiledMapping | null = null;
    for (const c of compiled) {
      if (c.fromGray) {
        // 회색→색: 저채도 + 명도 밴드로 매칭 (includeGrays 일 때만 의미)
        if (pixelGray && Math.abs(l - c.fromLight) <= GRAY_LIGHTNESS_TOL) {
          hit = c;
          break;
        }
      } else if (!pixelGray && hueDist(h, c.fromHue) <= c.tolerance) {
        hit = c;
        break;
      }
    }
    if (!hit) continue;

    // 명도(L) 유지, 색조는 타깃으로 교체. 채도는 원본의 음영 변화를 보존하기 위해
    // (to.s - from.s) 만큼 가산 시프트 후 클램프.
    const newS = Math.max(0, Math.min(1, s + (hit.toSat - hit.fromSat)));
    const [nr, ng, nb] = hslToRgb(hit.toHue, newS, l);
    data[i] = nr;
    data[i + 1] = ng;
    data[i + 2] = nb;
    // 알파 보존
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}
