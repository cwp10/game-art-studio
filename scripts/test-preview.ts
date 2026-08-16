/**
 * ④c — 모션 QA 프리뷰(접촉 시트 + 클린 투명 GIF) 테스트.
 * sprite_gen/preview.py · gif_utils.py 와 맞는지 본다.
 *
 * GIF 는 손으로 쓴 기대값이 약하므로 세 겹으로 검증한다:
 *   1. 바이트 구조 직접 파싱 (헤더·NETSCAPE 루프·GCE disposal/투명 인덱스)
 *   2. sharp(libvips) 로 디코드 왕복 — 독립 디코더가 같은 그림을 내는가
 *   3. 원본 Pillow 의 `gif_report()` 대조 (sprite-gen venv 가 있을 때)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { RawImage } from "../src/lib/sprite/extract";
import { delayTicksToDurationMs, saveCleanGif } from "../src/lib/sprite/gif";
import {
  buildPreviews,
  checker,
  contactSheet,
  flatten,
  stackSheets,
} from "../src/lib/sprite/preview";
import {
  DEFAULT_CHROMA_TUNABLES,
  normalizeCell,
  type SpriteRequest,
} from "../src/lib/sprite/request";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const VENV = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SPRITE_GEN = "/Users/wonpyoung/Developer/workspace/sprite-gen";

/** RGBA 프레임. rect 영역만 불투명하게 채운다. */
function frame(
  w: number,
  h: number,
  rect: { x: number; y: number; w: number; h: number },
  rgb: [number, number, number],
  alpha = 255,
): RawImage {
  const data = Buffer.alloc(w * h * 4);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * w + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = alpha;
    }
  }
  return { data, width: w, height: h };
}

// ── GIF 구조 파서 (테스트 전용) ───────────────────────────────────────────────

type GifStructure = {
  version: string;
  width: number;
  height: number;
  hasGct: boolean;
  loop: number | null;
  frames: Array<{
    delayTicks: number;
    disposal: number;
    transparentFlag: boolean;
    transparentIndex: number;
    width: number;
    height: number;
    hasLct: boolean;
    minCodeSize: number;
  }>;
};

function parseGif(buf: Buffer): GifStructure {
  const version = buf.toString("ascii", 0, 6);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  let p = 13;
  if (hasGct) p += 3 * (1 << ((packed & 7) + 1));

  let loop: number | null = null;
  const frames: GifStructure["frames"] = [];
  let pendingGce: { delayTicks: number; disposal: number; transparentFlag: boolean; transparentIndex: number } | null =
    null;

  const skipSubBlocks = (): void => {
    while (buf[p] !== 0x00) p += buf[p] + 1;
    p += 1;
  };

  while (p < buf.length && buf[p] !== 0x3b) {
    if (buf[p] === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xf9) {
        const size = buf[p];
        const gcePacked = buf[p + 1];
        pendingGce = {
          disposal: (gcePacked >> 2) & 0x07,
          transparentFlag: (gcePacked & 0x01) !== 0,
          delayTicks: buf.readUInt16LE(p + 2),
          transparentIndex: buf[p + 4],
        };
        p += size + 1;
        skipSubBlocks();
      } else if (label === 0xff) {
        const size = buf[p];
        const id = buf.toString("ascii", p + 1, p + 1 + size);
        p += size + 1;
        if (id === "NETSCAPE2.0") {
          // sub-block: [size=3] 0x01 loopLo loopHi
          loop = buf.readUInt16LE(p + 2);
        }
        skipSubBlocks();
      } else {
        skipSubBlocks();
      }
    } else if (buf[p] === 0x2c) {
      const fw = buf.readUInt16LE(p + 5);
      const fh = buf.readUInt16LE(p + 7);
      const imgPacked = buf[p + 9];
      const hasLct = (imgPacked & 0x80) !== 0;
      p += 10;
      if (hasLct) p += 3 * (1 << ((imgPacked & 7) + 1));
      const minCodeSize = buf[p];
      p += 1;
      skipSubBlocks();
      frames.push({
        delayTicks: pendingGce?.delayTicks ?? 0,
        disposal: pendingGce?.disposal ?? 0,
        transparentFlag: pendingGce?.transparentFlag ?? false,
        transparentIndex: pendingGce?.transparentIndex ?? 0,
        width: fw,
        height: fh,
        hasLct,
        minCodeSize,
      });
      pendingGce = null;
    } else {
      throw new Error(`알 수 없는 블록 0x${buf[p].toString(16)} @${p}`);
    }
  }
  return { version, width, height, hasGct, loop, frames };
}

(async () => {
  console.log("=== checker — 체커 배경 ===");
  {
    const c = checker(40, 40);
    const at = (x: number, y: number): number => c.data[(y * 40 + x) * 3];
    check("(0,0) 은 밝은 칸 235", at(0, 0) === 235);
    check("(16,0) 은 어두운 칸 210", at(16, 0) === 210);
    check("(0,16) 은 어두운 칸 210", at(0, 16) === 210);
    check("(16,16) 은 다시 밝은 칸", at(16, 16) === 235);
    check("칸 크기는 16 — (15,0) 은 아직 밝다", at(15, 0) === 235);
    check("회색조라 3채널이 같다", c.data[0] === c.data[1] && c.data[1] === c.data[2]);
  }

  console.log("=== flatten — 체커 위 합성 ===");
  {
    const f = frame(32, 32, { x: 0, y: 0, w: 8, h: 8 }, [255, 0, 0]);
    const out = flatten(f);
    check("불투명 픽셀은 그대로", out.data[0] === 255 && out.data[1] === 0 && out.data[2] === 0);
    const idx = (20 * 32 + 20) * 3;
    check("빈 곳은 체커가 보인다", out.data[idx] === 235 || out.data[idx] === 210);
  }
  {
    const half = frame(32, 32, { x: 0, y: 0, w: 4, h: 4 }, [0, 0, 0], 128);
    const out = flatten(half);
    // dst=235(밝은 칸), src=0, a=128 → round((0*128 + 235*127)/255) = 117
    check("부분 알파는 램프로 섞인다", out.data[0] === 117, `got ${out.data[0]}`);
  }

  console.log("=== contactSheet — 기하 ===");
  {
    const frames = [
      frame(64, 64, { x: 0, y: 0, w: 10, h: 10 }, [255, 0, 0]),
      frame(64, 64, { x: 0, y: 0, w: 10, h: 10 }, [0, 255, 0]),
      frame(64, 64, { x: 0, y: 0, w: 10, h: 10 }, [0, 0, 255]),
    ];
    const s = contactSheet(frames);
    check("폭 = n*cw + (n+1)*gap", s.width === 3 * 64 + 4 * 4, `got ${s.width}`);
    check("높이 = ch + 2*gap", s.height === 64 + 8, `got ${s.height}`);
    const px = (x: number, y: number): [number, number, number] => {
      const i = (y * s.width + x) * 3;
      return [s.data[i], s.data[i + 1], s.data[i + 2]];
    };
    check("gap 은 흰색", px(0, 0).every(v => v === 255));
    check("첫 프레임은 (gap,gap)", px(4, 4)[0] === 255 && px(4, 4)[1] === 0);
    check("둘째 프레임은 cw+gap 만큼 오른쪽", px(4 + 64 + 4, 4)[1] === 255);
    check("셋째 프레임", px(4 + 2 * (64 + 4), 4)[2] === 255);
  }

  console.log("=== stackSheets — 세로 스택 ===");
  {
    const a = contactSheet([frame(32, 32, { x: 0, y: 0, w: 4, h: 4 }, [255, 0, 0])]);
    const b = contactSheet([
      frame(32, 32, { x: 0, y: 0, w: 4, h: 4 }, [0, 255, 0]),
      frame(32, 32, { x: 0, y: 0, w: 4, h: 4 }, [0, 255, 0]),
    ]);
    const st = stackSheets([a, b]);
    check("폭 = max(시트 폭) + 2*gap", st.width === Math.max(a.width, b.width) + 16);
    check("높이 = 시트 합 + gap*(n+1)", st.height === a.height + b.height + 8 * 3);
    const at = (x: number, y: number): number => st.data[(y * st.width + x) * 3];
    check("첫 시트는 (gap,gap)", at(8, 8) === 255);
    check("둘째 시트는 그 아래", st.data[((8 + a.height + 8) * st.width + 8) * 3 + 1] === 255);
  }

  console.log("=== delayTicksToDurationMs ===");
  {
    check("14 tick = 140ms", delayTicksToDurationMs(14) === 140);
    let threw = false;
    try {
      delayTicksToDurationMs(0);
    } catch {
      threw = true;
    }
    check("0 이하는 fail-loud", threw);
  }

  const dir = await mkdtemp(join(tmpdir(), "gif-test-"));
  try {
    console.log("=== GIF 바이트 구조 ===");
    const gifFrames = [
      frame(48, 48, { x: 4, y: 4, w: 32, h: 32 }, [220, 40, 40]),
      frame(48, 48, { x: 10, y: 10, w: 8, h: 8 }, [40, 220, 40]),
      frame(48, 48, { x: 20, y: 20, w: 16, h: 16 }, [40, 40, 220]),
    ];
    const gifPath = join(dir, "loop.gif");
    await saveCleanGif(gifFrames, gifPath, { durationMs: 250, loop: 0 });
    const g = parseGif(await readFile(gifPath));
    check("GIF89a", g.version === "GIF89a", g.version);
    check("논리 화면 크기", g.width === 48 && g.height === 48);
    check("전역 팔레트 있음", g.hasGct);
    check("NETSCAPE2.0 루프 = 0(무한)", g.loop === 0, String(g.loop));
    check("프레임 수", g.frames.length === 3, String(g.frames.length));
    check("disposal 은 전부 2", g.frames.every(f => f.disposal === 2));
    check("투명 플래그가 켜져 있다", g.frames.every(f => f.transparentFlag));
    check("투명 인덱스는 255 전용", g.frames.every(f => f.transparentIndex === 255));
    check("250ms → 25 tick", g.frames.every(f => f.delayTicks === 25));
    check("프레임마다 로컬 팔레트", g.frames.every(f => f.hasLct));
    check("LZW 최소 코드 크기 8", g.frames.every(f => f.minCodeSize === 8));

    {
      const nonLoop = join(dir, "once.gif");
      await saveCleanGif(gifFrames, nonLoop, { durationMs: 125, loop: 1 });
      const ng = parseGif(await readFile(nonLoop));
      check("loop=1 이 그대로 실린다", ng.loop === 1, String(ng.loop));
      check("125ms → 13 tick(반올림)", ng.frames[0].delayTicks === 13);
    }

    console.log("=== GIF 디코드 왕복 (sharp/libvips) ===");
    {
      const { data, info } = await sharp(gifPath, { animated: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pageH = (info as { pageHeight?: number }).pageHeight ?? info.height;
      check("프레임 3장으로 디코드된다", info.height === pageH * 3, `h=${info.height} page=${pageH}`);
      const px = (f: number, x: number, y: number): number[] => {
        const i = ((f * pageH + y) * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2], info.channels === 4 ? data[i + 3] : 255];
      };
      const near = (a: number[], b: number[], tol = 4): boolean =>
        a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);
      check("프레임0 색 복원", near(px(0, 8, 8), [220, 40, 40]), JSON.stringify(px(0, 8, 8)));
      check("프레임1 색 복원", near(px(1, 12, 12), [40, 220, 40]), JSON.stringify(px(1, 12, 12)));
      check("프레임2 색 복원", near(px(2, 24, 24), [40, 40, 220]), JSON.stringify(px(2, 24, 24)));
      // disposal 2 의 존재 이유: 프레임1 은 프레임0 이 칠했던 (8,8) 을 비워야 한다.
      check("disposal 2 — 이전 프레임이 비치지 않는다", px(1, 8, 8)[3] === 0, JSON.stringify(px(1, 8, 8)));
      check("프레임2 도 이전 잔상 없음", px(2, 12, 12)[3] === 0, JSON.stringify(px(2, 12, 12)));
      check("투명 배경이 알파 0", px(0, 45, 45)[3] === 0);
    }

    console.log("=== buildPreviews — 상태별 산출 ===");
    {
      const cell = normalizeCell({ size: 64 });
      const request: SpriteRequest = {
        version: 1,
        character: { id: "aurora", description: "d", anchorGenerationId: "x" },
        cell,
        chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
        chroma: DEFAULT_CHROMA_TUNABLES,
        states: {
          down_idle: { frames: 2, fps: 4, loop: true, action: "idle" },
          down_attack: { frames: 2, fps: 8, loop: false, action: "attack" },
        },
      };
      const cellFrame = (rgb: [number, number, number]): RawImage =>
        frame(64, 64, { x: 8, y: 8, w: 24, h: 24 }, rgb);
      const qaDir = join(dir, "qa");
      const res = await buildPreviews({
        request,
        framesByState: {
          down_idle: [cellFrame([200, 30, 30]), cellFrame([30, 200, 30])],
          down_attack: [cellFrame([30, 30, 200]), cellFrame([200, 200, 30])],
        },
        qaDir,
      });
      check("ok", res.ok, JSON.stringify(res.states));
      check("상태 2개", res.states.length === 2);
      check("fps 4 → 25 tick", res.states[0].delayTicks === 25, String(res.states[0].delayTicks));
      check("fps 8 → 13 tick", res.states[1].delayTicks === 13, String(res.states[1].delayTicks));
      check("loop 이 상태를 따른다", res.states[0].loop === true && res.states[1].loop === false);
      check("all-contact 가 나온다", !!res.allContactPath && existsSync(res.allContactPath));
      check("접촉 시트 파일", existsSync(join(qaDir, "down_idle-contact.png")));
      check("GIF 파일", existsSync(join(qaDir, "down_attack.gif")));
      const ng = parseGif(await readFile(join(qaDir, "down_attack.gif")));
      check("loop:false 상태는 GIF loop=1", ng.loop === 1, String(ng.loop));
    }
    {
      const cell = normalizeCell({ size: 64 });
      const request: SpriteRequest = {
        version: 1,
        character: { id: "a", description: "d", anchorGenerationId: "x" },
        cell,
        chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
        chroma: DEFAULT_CHROMA_TUNABLES,
        states: { s: { frames: 1, fps: 6, loop: true, action: "a" } },
      };
      const res = await buildPreviews({
        request,
        framesByState: { s: [] },
        qaDir: join(dir, "qa-empty"),
      });
      check("프레임 없는 상태는 ok:false", !res.ok && res.states[0].note === "no frame files");
    }

    console.log("=== 원본 Pillow gif_report 대조 ===");
    if (!existsSync(VENV)) {
      console.log("  SKIP  sprite-gen venv 없음");
      skipped++;
    } else {
      // 같은 프레임을 PNG 로 내려 원본 save_clean_gif 로도 굽고, 두 GIF 를 원본
      // gif_report() 로 읽어 비교한다. 우리 인코더의 계약(프레임 수·딜레이·루프·투명·
      // disposal)이 원본과 같은지는 원본의 리포터가 판정해야 한다.
      const pngDir = join(dir, "png");
      await mkdir(pngDir, { recursive: true });
      for (let i = 0; i < gifFrames.length; i++) {
        await sharp(gifFrames[i].data, {
          raw: { width: gifFrames[i].width, height: gifFrames[i].height, channels: 4 },
        })
          .png()
          .toFile(join(pngDir, `f${i}.png`));
      }
      const py = join(dir, "report.py");
      await writeFile(
        py,
        [
          "import json, sys",
          "from pathlib import Path",
          "from PIL import Image",
          "from sprite_gen.gif_utils import save_clean_gif, gif_report",
          "png_dir = Path(sys.argv[1]); ours = Path(sys.argv[2]); ref = Path(sys.argv[3])",
          "frames = [Image.open(png_dir / f'f{i}.png').convert('RGBA') for i in range(3)]",
          "save_clean_gif(frames, ref, duration_ms=250, loop=0)",
          "print(json.dumps({'ours': gif_report(ours), 'ref': gif_report(ref)}, default=str))",
        ].join("\n"),
        "utf8",
      );
      const refGif = join(dir, "ref.gif");
      const out = execFileSync(VENV, [py, pngDir, gifPath, refGif], {
        cwd: SPRITE_GEN,
        encoding: "utf8",
      });
      const report = JSON.parse(out.trim().split("\n").pop()!) as {
        ours: { frames: number; delay_ticks: number[]; loop: number; transparent: boolean; disposal: string[] };
        ref: { frames: number; delay_ticks: number[]; loop: number; transparent: boolean; disposal: string[] };
      };
      check("프레임 수가 원본과 같다", report.ours.frames === report.ref.frames, JSON.stringify(report));
      check(
        "delay_ticks 가 원본과 같다",
        JSON.stringify(report.ours.delay_ticks) === JSON.stringify(report.ref.delay_ticks),
        `${JSON.stringify(report.ours.delay_ticks)} vs ${JSON.stringify(report.ref.delay_ticks)}`,
      );
      check("loop 이 원본과 같다", report.ours.loop === report.ref.loop);
      check("Pillow 가 투명으로 읽는다", report.ours.transparent === true);
      check(
        "disposal 이 원본과 같다",
        JSON.stringify(report.ours.disposal) === JSON.stringify(report.ref.disposal),
        `${JSON.stringify(report.ours.disposal)} vs ${JSON.stringify(report.ref.disposal)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed / ${failed} failed / ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
