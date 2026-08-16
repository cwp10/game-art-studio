/**
 * `selected-cycle.ts` 가 정본 `compose_cycle.py` 와 같은 결과를 내는지.
 *
 * 라벨 **글리프는 정본과 다르다** (정본은 PIL 기본 폰트 = Pillow 12 부터 내장
 * FreeType, TS 에서 비트 동일 재현 불가). 그래서 대조는 두 갈래로 나눈다:
 * 레이아웃·라벨 띠·프레임 픽셀은 **픽셀 동일**을 요구하고, 라벨 띠 안의 글자 영역만
 * 제외한다. 그 경계를 테스트가 명시적으로 긋는다.
 *
 * 실행: npx tsx scripts/test-selected-cycle.ts
 */
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrames,
  labeledContactSheet,
  buildSelectedCycleManifest,
  CYCLE_GAP,
  CYCLE_LABEL_HEIGHT,
  type RawImage,
} from "../src/lib/sprite/selected-cycle";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const dir = mkdtempSync(join(tmpdir(), "cycle-"));

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

if (!existsSync(PY)) {
  console.log("  FAIL 파이썬 venv 없음 — 정본 대조를 못 했습니다");
  console.log("\n0 passed / 1 failed");
  process.exit(1);
}

void (async () => {

console.log("=== parseFrames: 정본과 같은 파싱·같은 거부 ===");
{
  const okCases = ["2,3,4,5", " 1 , 2 ", "7", "1,10,100"];
  const badCases = ["", "  ", ",,", "0", "-1", "2,0,4", "1,-2"];
  const refs = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, argparse
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.compose_cycle import parse_frames
cases = json.loads(sys.stdin.read())
out = []
for v in cases:
    try:
        out.append({"ok": True, "value": parse_frames(v)})
    except argparse.ArgumentTypeError as e:
        out.append({"ok": False, "error": str(e)})
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify([...okCases, ...badCases]) })) as Array<
    { ok: true; value: number[] } | { ok: false; error: string }
  >;

  [...okCases, ...badCases].forEach((v, i) => {
    const ref = refs[i];
    let ours: { ok: true; value: number[] } | { ok: false; error: string };
    try { ours = { ok: true, value: parseFrames(v) }; }
    catch (e) { ours = { ok: false, error: (e as Error).message }; }
    if (ref.ok !== ours.ok) {
      check(`parseFrames(${JSON.stringify(v)})`, false,
        `정본 ${ref.ok ? "통과" : "거부"} vs 우리 ${ours.ok ? "통과" : "거부"}`);
    } else if (ref.ok && ours.ok) {
      check(`parseFrames(${JSON.stringify(v)})`,
        JSON.stringify(ref.value) === JSON.stringify(ours.value),
        `${JSON.stringify(ours.value)} vs ${JSON.stringify(ref.value)}`);
    } else {
      const rErr = (ref as { error: string }).error;
      const oErr = (ours as { error: string }).error;
      check(`parseFrames(${JSON.stringify(v)}) 거부 문구`, rErr === oErr,
        `\n    우리: ${oErr}\n    정본: ${rErr}`);
    }
  });
}

console.log("\n=== 라벨 접촉 시트: 레이아웃 픽셀 동일 (글자 영역 제외) ===");
{
  const SRCS = [
    "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png",
    "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-1.png",
    "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-2.png",
  ].filter(existsSync);
  if (SRCS.length < 3) {
    check("실제 프레임 부족", false, `${SRCS.length}/3`);
  } else {
    const frames: Array<{ number: number; image: RawImage }> = [];
    for (let i = 0; i < SRCS.length; i++) {
      const { data, info } = await sharp(SRCS[i]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      frames.push({ number: i + 2, image: { data: Buffer.from(data), width: info.width, height: info.height } });
    }
    const ours = labeledContactSheet(frames);

    const outBin = join(dir, "sheet.bin");
    const meta = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.compose_cycle import contact_sheet
paths = json.loads(sys.stdin.read())
frames = [(i + 2, Image.open(p).convert("RGBA")) for i, p in enumerate(paths)]
sheet = contact_sheet(frames)
np.array(sheet).tofile(${JSON.stringify(outBin)})
print(json.dumps({"size": list(sheet.size)}))
`], { encoding: "utf8", input: JSON.stringify(SRCS.map(p => join(process.cwd(), p))), maxBuffer: 64 * 1024 * 1024 })) as { size: number[] };

    check("시트 크기 동일",
      ours.width === meta.size[0] && ours.height === meta.size[1],
      `${ours.width}x${ours.height} vs ${meta.size.join("x")}`);

    const ref = Buffer.from(readFileSync(outBin));
    if (ref.length !== ours.data.length) {
      check("시트 바이트 길이", false, `${ours.data.length} vs ${ref.length}`);
    } else {
      // 글자가 그려지는 영역만 제외한다: 라벨 띠 안 x∈[cellLeft+6, +cellW), y∈[gap+4, gap+labelH).
      // 정본 글리프는 y 6..14 에 그려지고 우리는 y 9..15 다 — 둘을 넉넉히 덮는 창을 뺀다.
      const cellW = Math.max(...frames.map(f => f.image.width));
      const isTextArea = (x: number, y: number): boolean => {
        if (y < CYCLE_GAP + 3 || y >= CYCLE_GAP + CYCLE_LABEL_HEIGHT) return false;
        for (let i = 0; i < frames.length; i++) {
          const left = CYCLE_GAP + i * (cellW + CYCLE_GAP);
          if (x >= left + 4 && x < left + cellW) return true;
        }
        return false;
      };
      let diff = 0;
      let textDiff = 0;
      let firstDiff = "";
      for (let y = 0; y < ours.height; y++) {
        for (let x = 0; x < ours.width; x++) {
          const i = (y * ours.width + x) * 3;
          if (ref[i] === ours.data[i] && ref[i + 1] === ours.data[i + 1] && ref[i + 2] === ours.data[i + 2]) continue;
          if (isTextArea(x, y)) { textDiff++; continue; }
          if (diff === 0) firstDiff = `(${x},${y}) py=${ref[i]},${ref[i+1]},${ref[i+2]} ts=${ours.data[i]},${ours.data[i+1]},${ours.data[i+2]}`;
          diff++;
        }
      }
      check("글자 영역 밖은 픽셀 동일", diff === 0, `${diff}px 불일치; 첫 위치 ${firstDiff}`);
      check("글자 영역에는 실제로 차이가 있다 (대조가 무의미하지 않다)", textDiff > 0, `${textDiff}px`);
      console.log(`  (참고) 시트 ${ours.width}x${ours.height}, 글자 영역 차이 ${textDiff}px`);
      // 눈으로 볼 수 있게 남긴다.
      await sharp(ours.data, { raw: { width: ours.width, height: ours.height, channels: 3 } })
        .png().toFile(join(dir, "ours.png"));
      await sharp(ref, { raw: { width: meta.size[0], height: meta.size[1], channels: 3 } })
        .png().toFile(join(dir, "canon.png"));
    }
  }
}

console.log("\n=== 선택 사이클 매니페스트 ===");
{
  const SRCS = [
    "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png",
    "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-2.png",
  ].filter(existsSync);
  if (SRCS.length < 2) {
    check("실제 프레임 부족", false);
  } else {
    const m = await buildSelectedCycleManifest({
      state: "left_idle",
      name: "left_idle-cycle",
      userFrames: [1, 3],
      framePaths: SRCS,
      selectionSource: "curation",
      durationMs: 125,
      contactPath: "qa/left_idle-cycle-contact.png",
    });
    check("1-based 와 0-based 를 함께 싣는다",
      JSON.stringify(m.selected_user_frames) === "[1,3]" &&
      JSON.stringify(m.selected_zero_based_frames) === "[0,2]");
    check("delay_ticks 는 duration/10 반올림", m.delay_ticks === 13, String(m.delay_ticks));
    check("원본마다 sha256 이 붙는다",
      m.source_frames.length === 2 && m.source_frames.every(s => /^[0-9a-f]{64}$/.test(s.sha256)));

    // 해시가 실제 파일 내용을 반영하는지 — 파이썬 hashlib 과 대조.
    const refHashes = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, hashlib
paths = json.loads(sys.stdin.read())
out = []
for p in paths:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    out.append(h.hexdigest())
print(json.dumps(out))
`], { encoding: "utf8", input: JSON.stringify(SRCS.map(p => join(process.cwd(), p))) })) as string[];
    check("sha256 이 정본 hashlib 과 같다",
      m.source_frames.every((s, i) => s.sha256 === refHashes[i]),
      `${m.source_frames.map(s => s.sha256.slice(0, 12))} vs ${refHashes.map(h => h.slice(0, 12))}`);

    check("kind·version 이 정본 계약 그대로",
      m.kind === "sprite-gen-selected-cycle" && m.version === 1);

    let threw = "";
    try {
      await buildSelectedCycleManifest({
        state: "s", name: "n", userFrames: [1, 2], framePaths: [SRCS[0]],
        selectionSource: "curation", durationMs: 100, contactPath: "x.png",
      });
    } catch (e) { threw = (e as Error).message; }
    check("번호와 경로 개수가 어긋나면 던진다", threw.includes("어긋납니다"), threw);
  }
}

void writeFileSync;
console.log(`\n${pass} passed / ${fail} failed`);
console.log(`(시각 확인용 시트: ${join(dir, "ours.png")}, ${join(dir, "canon.png")})`);
process.exit(fail === 0 ? 0 : 1);
})();
