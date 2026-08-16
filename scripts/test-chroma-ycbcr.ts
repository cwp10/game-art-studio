/**
 * ycbcr 크로마 매팅 이식 테스트 — 정본과의 **바이트 동일성**이 판정 기준이다.
 *
 * 이 경로는 옵션이고 열화된 원본용이라(기본은 rgb), 단위 동작만 맞추면 "그럴듯한
 * 결과"에 속기 쉽다. 그래서 합성 케이스마다 sprite-gen 의 파이썬 구현을 같은
 * 입력으로 돌려 RGBA 를 통째로 대조한다. 파이썬 venv 가 없으면 대조는 건너뛰고
 * 동작 검사만 남는다(그 사실을 출력한다 — 조용히 통과시키지 않는다).
 *
 * 사용법: pnpm tsx scripts/test-chroma-ycbcr.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { decideChromaMode } from "../src/lib/sprite/chroma-mode";
import {
  detectBackgroundKeyYcc,
  keyResidueFractionYcc,
  removeChromaBackgroundYcbcr,
  rgbToYcc,
  smoothstep,
  type RGB,
} from "../src/lib/sprite/chroma-ycbcr";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const CANON_ROOT = "/Users/wonpyoung/Developer/workspace/sprite-gen";
const MAGENTA: readonly [number, number, number] = [255, 0, 255];

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

/** `key` 를 주면 그 케이스의 선언 키가 된다 (기본 마젠타). */
type Case = { name: string; width: number; height: number; raw: Buffer; key: RGB };

/** w×h RGBA 캔버스를 bg 로 채우고 painter 로 덧그린다. */
function canvas(
  name: string,
  w: number,
  h: number,
  bg: (x: number, y: number) => [number, number, number],
  painter?: (set: (x: number, y: number, c: [number, number, number]) => void) => void,
  key: RGB = MAGENTA,
): Case {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = bg(x, y);
      const i = (y * w + x) * 4;
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
      raw[i + 3] = 255;
    }
  }
  painter?.((x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    raw[i] = c[0];
    raw[i + 1] = c[1];
    raw[i + 2] = c[2];
    raw[i + 3] = 255;
  });
  return { name, width: w, height: h, raw, key };
}

function rect(
  set: (x: number, y: number, c: [number, number, number]) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
}

// ── 케이스 ────────────────────────────────────────────────────────────────
const PURE = MAGENTA;
const SKIN: [number, number, number] = [222, 176, 132];
const BLUE: [number, number, number] = [58, 110, 220];

const cases: Case[] = [
  // 1. 순수 키 평면 배경 — 검출 == 선언, 재매팅 분기 없음
  canvas("pure-flat", 40, 40, () => [...PURE] as [number, number, number], set => {
    rect(set, 12, 8, 28, 34, BLUE);
    rect(set, 16, 4, 24, 12, SKIN);
  }),
  // 2. 셰이딩된 키 배경 — 우리가 실제로 겪은 실패 형태(rgb 가 못 지우는 것)
  canvas(
    "shaded-key",
    40,
    40,
    (x, y) => {
      const t = (x + y) / 78;
      return [Math.round(255 - 60 * t), Math.round(26 * t), Math.round(255 - 90 * t)];
    },
    set => {
      rect(set, 12, 8, 28, 34, BLUE);
      rect(set, 16, 4, 24, 12, SKIN);
    },
  ),
  // 3. 피사체가 테두리에 닿음 — 최빈값을 뒤엎는 선언키 패밀리 bias 경로
  canvas("subject-touches-border", 40, 40, () => [...PURE] as [number, number, number], set => {
    rect(set, 0, 0, 34, 40, BLUE);
  }),
  // 4. 검은 배경인데 마젠타를 선언 — 검출 키가 선언 패밀리 밖(두 번째 분기)
  canvas("black-bg-magenta-declared", 40, 40, () => [8, 8, 10], set => {
    rect(set, 12, 8, 28, 34, BLUE);
  }),
  // 5. 내부 얼룩 두 종류로 플러드 필의 **연결성**을 가른다.
  //    - 순수 키 색 얼룩: 소프트 매트가 coverage 0 으로 먼저 지운다(플러드 이전).
  //    - 키 근처지만 매트를 통과하는 색(#CC1A90, CbCr 거리 61.9 — 실제로 codex 가
  //      그린 배경색이다): 매트는 통과하고 플러드 톨(88) 안에도 들지만, 테두리에
  //      연결되지 않아 살아남는다. 이쪽이 연결성이 지키는 것이다.
  canvas("interior-key-gem", 40, 40, () => [...PURE] as [number, number, number], set => {
    rect(set, 8, 8, 32, 32, BLUE);
    rect(set, 12, 12, 16, 16, [255, 0, 255]); // 순수 키 — 매트가 지움
    rect(set, 22, 22, 26, 26, [204, 26, 144]); // 키 근처 — 연결성으로 살아남음
  }),
  // 6. 고립 점과 핀홀 — cleanup 패스
  canvas("dots-and-pinholes", 40, 40, () => [...PURE] as [number, number, number], set => {
    rect(set, 10, 10, 30, 30, BLUE);
    rect(set, 19, 19, 20, 20, [...PURE] as [number, number, number]); // 1px 구멍
    set(4, 4, BLUE); // 고립 점
  }),
  // 7. 자가 진단 재매팅이 **실제로 발동**하는 케이스. 정본
  //    tests/test_chroma_ycbcr.py::test_self_diagnostic_rematte_is_reported 와 동일:
  //    피사체가 코너를 전부 차지해 테두리 표본이 빨강을 키로 오검출 → 그 키로
  //    매팅하면 피사체가 지워지고 초록 배경이 살아남는다(잔류 급등) → 선언 키로
  //    재매팅. 이 분기가 안 타면 폴백 경로는 미검증으로 남는다.
  canvas(
    "rematte-subject-crowds-corners",
    64,
    64,
    () => [200, 40, 40],
    set => {
      rect(set, 16, 16, 48, 48, [0, 255, 0]);
    },
    [0, 255, 0],
  ),
  // 8. JPEG 크로마 서브샘플링 흉내 — 키 주변 노이즈
  canvas(
    "chroma-noise",
    40,
    40,
    (x, y) => {
      const n = ((x * 7 + y * 13) % 11) - 5;
      return [Math.max(0, Math.min(255, 255 + n)), Math.max(0, Math.min(255, 6 + n)), Math.max(0, Math.min(255, 250 + n))];
    },
    set => {
      rect(set, 12, 12, 28, 28, BLUE);
    },
  ),
];

// ── 순수 함수 검사 (정본 상수·수식) ────────────────────────────────────────
console.log("\n[단위] 색공간·smoothstep");
{
  const [luma, cb, cr] = rgbToYcc(255, 0, 255);
  check("rgbToYcc(#FF00FF) luma", Math.abs(luma - 105.315) < 1e-6, `${luma}`);
  check("rgbToYcc(#FF00FF) cb", Math.abs(cb - ((255 - luma) * 0.564 + 128)) < 1e-9, `${cb}`);
  check("rgbToYcc(#FF00FF) cr", Math.abs(cr - ((255 - luma) * 0.713 + 128)) < 1e-9, `${cr}`);
  check("smoothstep 하단 클램프", smoothstep(24, 72, 0) === 0);
  check("smoothstep 상단 클램프", smoothstep(24, 72, 100) === 1);
  check("smoothstep 중점 = 0.5", Math.abs(smoothstep(24, 72, 48) - 0.5) < 1e-12);
  check("smoothstep 퇴화 구간", smoothstep(72, 24, 50) === 0);
}

// ── 동작 검사 ─────────────────────────────────────────────────────────────
console.log("\n[동작] 배경 제거 결과");
type Result = { alpha: Uint8Array; opaque: number; warnings: string[]; out: Uint8Array };
const ours = new Map<string, Result>();

for (const c of cases) {
  const buf = new Uint8Array(c.raw);
  const warnings: string[] = [];
  removeChromaBackgroundYcbcr(buf, c.width, c.height, c.key, warnings);
  const alpha = new Uint8Array(c.width * c.height);
  let opaque = 0;
  for (let p = 0; p < c.width * c.height; p++) {
    alpha[p] = buf[p * 4 + 3];
    if (alpha[p] > 10) opaque++;
  }
  ours.set(c.name, { alpha, opaque, warnings, out: buf });
}

function alphaAt(name: string, x: number, y: number): number {
  const c = cases.find(k => k.name === name) as Case;
  return (ours.get(name) as Result).alpha[y * c.width + x];
}

check("pure-flat: 코너 배경 투명", alphaAt("pure-flat", 0, 0) === 0);
check("pure-flat: 피사체 불투명", alphaAt("pure-flat", 20, 20) === 255);
check(
  "shaded-key: 셰이딩 배경도 코너 투명 (rgb 경로가 실패하는 지점)",
  alphaAt("shaded-key", 0, 0) === 0 && alphaAt("shaded-key", 39, 39) === 0,
  `(0,0)=${alphaAt("shaded-key", 0, 0)} (39,39)=${alphaAt("shaded-key", 39, 39)}`,
);
check("shaded-key: 피사체 보존", alphaAt("shaded-key", 20, 20) === 255);
check(
  "subject-touches-border: 피사체가 테두리를 채워도 안 지워짐",
  (ours.get("subject-touches-border") as Result).opaque > 34 * 40 * 0.8,
  `opaque=${(ours.get("subject-touches-border") as Result).opaque}`,
);
check(
  "interior-key-gem: 순수 키 얼룩은 매트가 지움 (플러드 이전)",
  alphaAt("interior-key-gem", 14, 14) === 0,
  `alpha=${alphaAt("interior-key-gem", 14, 14)}`,
);
check(
  "interior-key-gem: 키 근처 얼룩은 연결성으로 살아남음",
  alphaAt("interior-key-gem", 24, 24) > 0,
  `alpha=${alphaAt("interior-key-gem", 24, 24)}`,
);
check("interior-key-gem: 바깥 배경은 투명", alphaAt("interior-key-gem", 0, 0) === 0);
check(
  "dots-and-pinholes: 1px 핀홀이 메워짐",
  alphaAt("dots-and-pinholes", 19, 19) === 255,
  `alpha=${alphaAt("dots-and-pinholes", 19, 19)}`,
);
check(
  "dots-and-pinholes: 고립 점이 지워짐",
  alphaAt("dots-and-pinholes", 4, 4) === 0,
  `alpha=${alphaAt("dots-and-pinholes", 4, 4)}`,
);
check(
  "chroma-noise: 노이즈 낀 키 배경 제거",
  alphaAt("chroma-noise", 0, 0) === 0 && alphaAt("chroma-noise", 39, 0) === 0,
);
check("chroma-noise: 피사체 보존", alphaAt("chroma-noise", 20, 20) === 255);

console.log("\n[동작] 자가 진단 재매팅 폴백 (정본 test_self_diagnostic_rematte_is_reported)");
{
  const r = ours.get("rematte-subject-crowds-corners") as Result;
  check("폴백이 경고로 표면화된다 (조용하지 않다)", r.warnings.length > 0, JSON.stringify(r.warnings));
  check(
    "선언 키(초록) 영역이 지워진다",
    alphaAt("rematte-subject-crowds-corners", 32, 32) === 0,
    `alpha=${alphaAt("rematte-subject-crowds-corners", 32, 32)}`,
  );
  check(
    "오검출된 키(빨강) 피사체가 살아남는다",
    alphaAt("rematte-subject-crowds-corners", 4, 4) === 255,
    `alpha=${alphaAt("rematte-subject-crowds-corners", 4, 4)}`,
  );
}

console.log("\n[동작] 키 검출과 잔류 지표");
{
  const c = cases.find(k => k.name === "pure-flat") as Case;
  const det = detectBackgroundKeyYcc(new Uint8Array(c.raw), c.width, c.height, MAGENTA);
  check("pure-flat 검출 키 == 선언 키", det[0] === 255 && det[1] === 0 && det[2] === 255, `${det}`);
}
{
  const c = cases.find(k => k.name === "black-bg-magenta-declared") as Case;
  const det = detectBackgroundKeyYcc(new Uint8Array(c.raw), c.width, c.height, MAGENTA);
  check("검은 배경 검출 키는 마젠타가 아님", !(det[0] === 255 && det[1] === 0 && det[2] === 255), `${det}`);
}
{
  const c = cases.find(k => k.name === "pure-flat") as Case;
  const r = ours.get("pure-flat") as Result;
  check(
    "pure-flat 잔류 비율 0",
    keyResidueFractionYcc(r.out, c.width, c.height, MAGENTA) === 0,
    `${keyResidueFractionYcc(r.out, c.width, c.height, MAGENTA)}`,
  );
}

// ── auto 판정 (우리 앱용 다리 — 정본에 없다) ──────────────────────────────
console.log("\n[auto] 경로 자동 판정 — rgb 하드컷이 통하는가로 정한다");
{
  const clean = cases.find(k => k.name === "pure-flat") as Case;
  const d1 = decideChromaMode(new Uint8Array(clean.raw), clean.width, clean.height, MAGENTA);
  check("순수 평면 키 → rgb (정본 기본과 같은 경로)", d1.mode === "rgb", `${d1.mode} 거리=${d1.distance.toFixed(1)}`);

  // 실제로 실패했던 그 배경색으로 채운 스트립.
  const degraded = canvas("auto-degraded", 40, 40, () => [204, 26, 144], set => {
    rect(set, 12, 8, 28, 34, BLUE);
  });
  const d2 = decideChromaMode(new Uint8Array(degraded.raw), degraded.width, degraded.height, MAGENTA);
  check(
    "열화 배경 #CC1A90 → ycbcr",
    d2.mode === "ycbcr",
    `${d2.mode} 거리=${d2.distance.toFixed(1)}`,
  );
  check("판정에 근거가 담긴다", d2.reason.includes("96") && d2.reason.includes("하드컷"), d2.reason);

  // 임계 바로 아래 — rgb 를 유지해야 한다(경계에서 함부로 갈아타지 않는다).
  const nearKey: [number, number, number] = [255, 60, 200];
  const near = canvas("auto-near", 40, 40, () => nearKey, set => {
    rect(set, 12, 8, 28, 34, BLUE);
  });
  const d3 = decideChromaMode(new Uint8Array(near.raw), near.width, near.height, MAGENTA);
  check(
    `임계 아래(거리 ${d3.distance.toFixed(1)}) → rgb 유지`,
    d3.distance <= 96 ? d3.mode === "rgb" : d3.mode === "ycbcr",
    `${d3.mode}`,
  );
}

// ── 정본 대조 (바이트 동일성) ─────────────────────────────────────────────
async function canonParity(): Promise<void> {
console.log("\n[정본 대조] sprite-gen remove_chroma_background_ycbcr 와 RGBA 바이트 비교");
if (!existsSync(PY)) {
  console.log(`  SKIP  파이썬 venv 없음 (${PY}) — 바이트 대조를 못 했습니다`);
  failed++; // 조용히 통과시키지 않는다
  console.log("  FAIL  정본 대조 미실행");
} else {
  const dir = mkdtempSync(join(tmpdir(), "ycc-parity-"));
  try {
    for (const c of cases) {
      const png = join(dir, `${c.name}.png`);
      const outNpy = join(dir, `${c.name}.raw`);
      await sharp(c.raw, { raw: { width: c.width, height: c.height, channels: 4 } })
        .png()
        .toFile(png);
      const script = `
import sys, numpy as np
from PIL import Image
from sprite_gen.extract import remove_chroma_background_ycbcr
img = Image.open(${JSON.stringify(png)}).convert("RGBA")
notes = []
out = remove_chroma_background_ycbcr(img, (${c.key[0]}, ${c.key[1]}, ${c.key[2]}), notes)
np.array(out).tofile(${JSON.stringify(outNpy)})
sys.stdout.write("|".join(notes))
`;
      const notesOut = execFileSync(PY, ["-c", script], { cwd: CANON_ROOT, encoding: "utf8" });
      const canon = readFileSync(outNpy);
      const oursBuf = Buffer.from((ours.get(c.name) as Result).out);
      const same = canon.equals(oursBuf);
      let detail = "";
      if (!same) {
        let firstDiff = -1;
        for (let i = 0; i < Math.min(canon.length, oursBuf.length); i++) {
          if (canon[i] !== oursBuf[i]) {
            firstDiff = i;
            break;
          }
        }
        let diffs = 0;
        for (let i = 0; i < canon.length; i++) if (canon[i] !== oursBuf[i]) diffs++;
        const p = Math.floor(firstDiff / 4);
        detail =
          `${diffs}B 차이, 첫 위치 byte ${firstDiff} = px(${p % c.width},${Math.floor(p / c.width)})` +
          `ch${firstDiff % 4} canon=${canon[firstDiff]} ours=${oursBuf[firstDiff]}`;
      }
      check(`${c.name}: RGBA 바이트 동일`, same, detail);

      const canonNotes = notesOut ? notesOut.split("|").filter(Boolean) : [];
      const oursNotes = (ours.get(c.name) as Result).warnings;
      check(
        `${c.name}: 폴백 경고 개수 일치 (${canonNotes.length})`,
        canonNotes.length === oursNotes.length,
        `canon=${canonNotes.length} ours=${oursNotes.length}`,
      );
    }

    // 실제 생성물 — 우리가 실제로 실패했던 앵커 행. 합성이 아닌 진짜 열화 원본.
    const realPath = "data/images/svvconnkg2s3m5w0.png";
    if (existsSync(realPath)) {
      const { data, info } = await sharp(realPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const buf = new Uint8Array(data);
      removeChromaBackgroundYcbcr(buf, info.width, info.height, MAGENTA);
      const outRaw = join(dir, "real.raw");
      const script = `
import numpy as np
from PIL import Image
from sprite_gen.extract import remove_chroma_background_ycbcr
img = Image.open(${JSON.stringify(join(process.cwd(), realPath))}).convert("RGBA")
np.array(remove_chroma_background_ycbcr(img, (255, 0, 255), [])).tofile(${JSON.stringify(outRaw)})
`;
      execFileSync(PY, ["-c", script], { cwd: CANON_ROOT });
      check(
        "실제 앵커 행(1774×887, 배경 #CC1A90): RGBA 바이트 동일",
        readFileSync(outRaw).equals(Buffer.from(buf)),
      );
    } else {
      console.log(`  SKIP  실제 앵커 행 없음 (${realPath})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
}

void canonParity().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
