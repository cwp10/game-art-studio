/**
 * ② Task 2·3 — 크로마 키 자동 선택 테스트.
 * 합성 이미지로 배경 제외·스페클 필터·삭제 반경 게이트를 검증한다.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundMask,
  chooseChromaKey,
  sampleReference,
  subjectPixels,
} from "../src/lib/sprite/chroma-key";
import { detectBackgroundMode } from "../src/lib/sprite/base-gate";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** w×h RGBA 캔버스를 bg 로 채우고 painter 로 덧그린다. */
function canvas(
  w: number,
  h: number,
  bg: [number, number, number],
  painter?: (set: (x: number, y: number, c: [number, number, number]) => void) => void,
): { raw: Buffer; width: number; height: number; channels: number } {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = bg[0];
    raw[i * 4 + 1] = bg[1];
    raw[i * 4 + 2] = bg[2];
    raw[i * 4 + 3] = 255;
  }
  painter?.((x, y, c) => {
    const i = (y * w + x) * 4;
    raw[i] = c[0];
    raw[i + 1] = c[1];
    raw[i + 2] = c[2];
    raw[i + 3] = 255;
  });
  return { raw, width: w, height: h, channels: 4 };
}

async function writePng(dir: string, name: string, img: ReturnType<typeof canvas>): Promise<string> {
  const p = join(dir, name);
  await sharp(img.raw, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(p);
  return p;
}

void (async () => {
  console.log("=== backgroundMask — 평면 크로마 배경 ===");
  {
    // 64x64 마젠타 배경 + 중앙 20x20 파란 사각형
    const img = canvas(64, 64, [255, 0, 255], set => {
      for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
    });
    const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
    check("배경이 flat 으로 판정", bg.mode === "flat", bg.mode);
    const mask = backgroundMask(img.raw, img.width, img.height, img.channels, bg);
    check("모서리는 배경", mask[0] === true);
    check("사각형 중앙은 소재", mask[32 * 64 + 32] === false);
    const bgCount = mask.filter(Boolean).length;
    // 소재 20x20=400 에서 팽창 2px 이 사방을 갉아먹는다 → 배경은 64*64-400 보다 크다
    check("배경 마스크가 팽창으로 소재를 갉는다", bgCount > 64 * 64 - 400, `bg=${bgCount}`);
  }

  console.log("=== subjectPixels — 배경 제외와 스페클 필터 ===");
  {
    const img = canvas(64, 64, [255, 0, 255], set => {
      for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
      set(10, 10, [233, 7, 202]); // 고립된 스필 스페클 — 제외되어야 한다
    });
    const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
    const px = subjectPixels(img.raw, img.width, img.height, img.channels, bg);
    check("소재 픽셀이 잡힌다", px.length > 0, `n=${px.length}`);
    check("마젠타 배경은 소재에 없다", !px.some(p => p[0] > 200 && p[1] < 60 && p[2] > 200));
    check("고립 스페클은 제외된다", !px.some(p => p[0] === 233 && p[1] === 7 && p[2] === 202));
    check(
      "모든 소재 픽셀이 파란 사각형 색",
      px.every(p => p[0] === 30 && p[1] === 60 && p[2] === 200),
    );
  }

  console.log("=== subjectPixels — 근백색 제외 ===");
  {
    const img = canvas(64, 64, [255, 0, 255], set => {
      for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [250, 250, 250]);
    });
    const bg = detectBackgroundMode(img.raw, img.width, img.height, img.channels);
    const px = subjectPixels(img.raw, img.width, img.height, img.channels, bg);
    check("전 채널 244 초과는 소재에서 빠진다", px.length === 0, `n=${px.length}`);
  }

  console.log("=== sampleReference — 파일 경로 경유 ===");
  {
    const dir = await mkdtemp(join(tmpdir(), "chroma-"));
    try {
      const img = canvas(64, 64, [255, 0, 255], set => {
        for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) set(x, y, [30, 60, 200]);
      });
      const r = await sampleReference(await writePng(dir, "base.png", img));
      check("파일에서 소재 픽셀을 뽑는다", r.pixels.length > 0, `n=${r.pixels.length}`);
      check("배경 모드가 함께 온다", r.background.mode === "flat", r.background.mode);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  {
    const r = await sampleReference("/nonexistent/path/base.png");
    check("없는 파일은 absent 로 떨어진다", r.background.mode === "absent" && r.pixels.length === 0);
  }

  console.log("=== chooseChromaKey — 수동 지정 ===");
  {
    const k = await chooseChromaKey(null, "#00FF00");
    check("수동 지정은 그대로 통과", k.hex === "#00FF00" && k.selection === "manual", k.hex);
    check("후보 목록의 이름을 되찾는다", k.name === "green", k.name);
    const lower = await chooseChromaKey(null, "#00ff00");
    check("소문자 입력도 대문자 헥스로 정규화", lower.hex === "#00FF00", lower.hex);
    const m = await chooseChromaKey(null, "#123456");
    check("후보에 없는 색은 manual 이름", m.name === "manual");
    let threw = false;
    try {
      await chooseChromaKey(null, "not-a-color");
    } catch {
      threw = true;
    }
    check("잘못된 헥스는 거부", threw);
  }

  console.log("=== chooseChromaKey — 참조 없음 폴백 ===");
  {
    const k = await chooseChromaKey(null, "auto");
    check("참조 없으면 마젠타 폴백", k.hex === "#FF00FF" && k.selection === "fallback");
    check("폴백 사유가 남는다", (k.selectionReason ?? "").includes("no base reference"));
  }

  console.log("=== chooseChromaKey — 소재색에서 먼 키를 고른다 ===");
  {
    const dir = await mkdtemp(join(tmpdir(), "chroma-auto-"));
    try {
      // 흰 배경 + 진한 크림슨 소재. 마젠타는 R 이 높아 크림슨과 인접 → 그린이 안전하다.
      const img = canvas(64, 64, [254, 254, 254], set => {
        for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) set(x, y, [153, 12, 40]);
      });
      const k = await chooseChromaKey(await writePng(dir, "crimson.png", img), "auto");
      check("크림슨 소재에는 마젠타를 고르지 않는다", k.hex !== "#FF00FF", `got ${k.hex}`);
      check("selection 은 auto", k.selection === "auto");
      check("후보 4종이 모두 기록된다", (k.candidates ?? []).length === 4);
      check(
        "근거가 기록된다",
        typeof k.score === "number" && typeof k.minSubjectDistance === "number",
      );
      const magenta = (k.candidates ?? []).find(c => c.name === "magenta");
      check(
        "마젠타의 삭제 반경 통과 여부가 기록된다",
        magenta !== undefined && typeof magenta.clearsEraseRadius === "boolean",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("=== chooseChromaKey — 어떤 후보도 안전하지 않으면 경고 ===");
  {
    const dir = await mkdtemp(join(tmpdir(), "chroma-warn-"));
    try {
      // 흰 배경에 네 후보 각각의 근처 색을 한 덩어리씩 깔아 어느 키도 반경을
      // 벗어나지 못하게 한다.
      const blobs: Array<[number, [number, number, number]]> = [
        [4, [250, 10, 250]],
        [20, [10, 250, 10]],
        [36, [10, 250, 250]],
        [52, [10, 77, 250]],
      ];
      const img = canvas(64, 64, [254, 254, 254], set => {
        for (const [ox, c] of blobs) {
          for (let y = 24; y < 40; y++) for (let x = ox; x < ox + 10; x++) set(x, y, c);
        }
      });
      const k = await chooseChromaKey(await writePng(dir, "rainbow.png", img), "auto");
      check(
        "안전한 후보가 없으면 경고가 붙는다",
        typeof k.warning === "string" && k.warning.length > 0,
        `warning=${k.warning}`,
      );
      check("경고가 있어도 키는 선택된다", k.hex.length === 7);
      check("사유가 반경 미통과를 밝힌다", (k.selectionReason ?? "").includes("no candidate clears"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
