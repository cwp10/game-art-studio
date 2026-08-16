/**
 * 모션 QA 프리뷰 — sprite_gen/preview.py 이식.
 *
 * 상태마다 다음을 쓴다:
 *   qa/<state>-contact.png  — 프레임을 좌→우로 늘어놓아 모션을 읽을 수 있게
 *   qa/<state>.gif          — 상태 fps 로 재생(루프)
 *   qa/all-contact.png      — 모든 상태를 한 상태당 한 줄로 쌓은 것
 *
 * 이것들은 **QA 계측기이지 런타임 에셋이 아니다.** 런타임 SSoT 는
 * `sprite-sheet-alpha.png` 위의 `manifest.json.frame_layout` 그대로다.
 *
 * 정적 QA 로는 부족하다는 것이 이 도구의 존재 이유다 — 프레임 수가 맞고 알파가 깨끗하고
 * 정체성이 일관돼도 애니메이션이 쓰레기일 수 있다(`docs/qa-motion.md`, BLOCKING).
 * contact sheet 는 검사용 체커 배경을 쓰고, GIF 는 투명을 보존한다(공유용).
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import type { RawImage } from "@/lib/sprite/extract";
import { delayTicksToDurationMs, saveCleanGif } from "@/lib/sprite/gif";
import type { SpriteRequest } from "@/lib/sprite/request";

const CHECKER_SQUARE = 16;
const CONTACT_GAP = 4;
const STACK_GAP = 8;

/** 투명 픽셀과 남은 프린지가 둘 다 보이도록 하는 중립 체커. */
export function checker(width: number, height: number, square = CHECKER_SQUARE): RawImage {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      const v = light ? 235 : 210;
      const i = (y * width + x) * 3;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return { data, width, height };
}

/** 프레임을 체커 위에 합성해 RGB 로 만든다. */
export function flatten(frame: RawImage): RawImage {
  const out = checker(frame.width, frame.height);
  for (let i = 0; i < frame.width * frame.height; i++) {
    const a = frame.data[i * 4 + 3];
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      const src = frame.data[i * 4 + c];
      const dst = out.data[i * 3 + c];
      out.data[i * 3 + c] = Math.round((src * a + dst * (255 - a)) / 255);
    }
  }
  return out;
}

/** RGB 이미지를 RGB 캔버스에 좌상단 기준으로 붙인다. */
function pasteRgb(dst: RawImage, src: RawImage, left: number, top: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= dst.height) continue;
    src.data.copy(
      dst.data,
      (dy * dst.width + left) * 3,
      y * src.width * 3,
      (y + 1) * src.width * 3,
    );
  }
}

/** 프레임을 좌→우로 늘어놓은 접촉 시트. 흰 배경, 프레임 사이 gap. */
export function contactSheet(frames: RawImage[], gap = CONTACT_GAP): RawImage {
  const cw = Math.max(...frames.map(f => f.width));
  const ch = Math.max(...frames.map(f => f.height));
  const n = frames.length;
  const width = n * cw + (n + 1) * gap;
  const height = ch + 2 * gap;
  const data = Buffer.alloc(width * height * 3, 255);
  const sheet: RawImage = { data, width, height };
  let x = gap;
  for (const f of frames) {
    pasteRgb(sheet, flatten(f), x, gap);
    x += cw + gap;
  }
  return sheet;
}

/** 상태별 시트를 세로로 쌓는다. */
export function stackSheets(sheets: RawImage[], gap = STACK_GAP): RawImage {
  const width = Math.max(...sheets.map(s => s.width)) + 2 * gap;
  const height = sheets.reduce((sum, s) => sum + s.height, 0) + gap * (sheets.length + 1);
  const data = Buffer.alloc(width * height * 3, 255);
  const stacked: RawImage = { data, width, height };
  let y = gap;
  for (const s of sheets) {
    pasteRgb(stacked, s, gap, y);
    y += s.height + gap;
  }
  return stacked;
}

async function writeRgb(img: RawImage, destPath: string): Promise<void> {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .png()
    .toFile(destPath);
}

export type PreviewState = {
  state: string;
  ok: boolean;
  note?: string;
  frames?: number;
  fps?: number;
  delayTicks?: number;
  loop?: boolean;
  contactPath?: string;
  gifPath?: string;
};

export type PreviewResult = {
  ok: boolean;
  qaDir: string;
  states: PreviewState[];
  allContactPath?: string;
};

/**
 * 상태별 접촉 시트 + GIF, 그리고 전체 스택 시트를 만든다.
 *
 * 한 상태라도 실패하면 전체를 실패로 낸다 — 깨진 상태 위에 `ok: true` 를 얹지 않는다
 * (No Silent Fallback). 원본 `_run_guarded` 의 `all_ok` 와 같다.
 */
export async function buildPreviews(opts: {
  request: SpriteRequest;
  framesByState: Record<string, RawImage[]>;
  qaDir: string;
  /** 모든 GIF 딜레이를 이 tick(1/100초)으로 덮어쓴다. */
  delayTicks?: number;
}): Promise<PreviewResult> {
  const { request, framesByState, qaDir } = opts;
  await mkdir(qaDir, { recursive: true });

  const states: PreviewState[] = [];
  const sheets: RawImage[] = [];

  for (const [state, frames] of Object.entries(framesByState)) {
    if (frames.length === 0) {
      states.push({ state, ok: false, note: "no frame files" });
      continue;
    }
    const meta = request.states[state];
    const fps = meta?.fps || 6;
    const loop = meta?.loop ?? true;

    const sheet = contactSheet(frames);
    const contactPath = join(qaDir, `${state}-contact.png`);
    await writeRgb(sheet, contactPath);
    sheets.push(sheet);

    const durationMs = opts.delayTicks
      ? delayTicksToDurationMs(opts.delayTicks)
      : Math.max(1, Math.round(1000 / fps));
    const gifPath = join(qaDir, `${state}.gif`);
    await saveCleanGif(frames, gifPath, { durationMs, loop: loop ? 0 : 1 });

    states.push({
      state,
      ok: true,
      frames: frames.length,
      fps,
      delayTicks: Math.round(durationMs / 10),
      loop,
      contactPath,
      gifPath,
    });
  }

  let allContactPath: string | undefined;
  if (sheets.length > 0) {
    allContactPath = join(qaDir, "all-contact.png");
    await writeRgb(stackSheets(sheets), allContactPath);
  }

  const ok = states.length > 0 && states.every(s => s.ok);
  return { ok, qaDir, states, allContactPath };
}
