/**
 * 배경 방식 결정 레코드 테스트.
 *
 * 요점 둘:
 *   1. 결정이 **한 곳**에서 나고 근거가 남는다 — 프롬프트와 후처리가 어긋날 수 없다.
 *   2. luma 는 배경이 실제로 검정일 때만 걸린다 — 오분류가 파괴적이라 사전에 막는다.
 *
 * 실측 근거(이 파일 아래 "알파 복원" 절)도 함께 잠근다: 크로마는 넓은 반투명에서
 * 부분 알파를 내지 못하고 luma 는 낸다. 이 차이가 확장의 유일한 이유이므로,
 * 튜너블이 바뀌어 전제가 무너지면 여기서 실패해야 한다.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { removeChromaBackground } from "../src/lib/sprite/chroma-clean";
import { lumaKeyFile } from "../src/lib/image-backend/chroma-key";
import { decideBackgroundMode, verifyLumaBackground } from "../src/lib/sprite/background-mode";

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

/** 흰 소재를 배경 위에 알파 a 로 합성한 **불투명** 이미지(생성기가 내는 형태). */
function gradient(bg: [number, number, number], w = 256, h = 8): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = x / (w - 1);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(255 * a + bg[c] * (1 - a));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

void (async () => {
  console.log("=== decideBackgroundMode — 결정은 한 번, 근거를 남긴다 ===");
  {
    const d = decideBackgroundMode({ prompt: "폭발 이펙트", subjectType: "effect" });
    check("이펙트 + VFX 어휘 → luma", d.mode === "luma", JSON.stringify(d));
    check("근거가 남는다", d.reason.length > 0);
    check("auto 판정으로 표기", d.selection === "auto");
  }
  {
    // 정본 규칙대로 만든 하드엣지 이펙트는 불투명이다 — luma 가 어두운 부분을 깎는다.
    const d = decideBackgroundMode({ prompt: "sword slash trail", subjectType: "effect" });
    check("이펙트지만 VFX 어휘 없음 → chroma", d.mode === "chroma", JSON.stringify(d));
  }
  {
    const d = decideBackgroundMode({ prompt: "불꽃을 두른 기사", subjectType: "character" });
    check("캐릭터는 VFX 어휘가 있어도 chroma", d.mode === "chroma", JSON.stringify(d));
  }
  {
    const d = decideBackgroundMode({ prompt: "여우 마법사", subjectType: "character" });
    check("기본은 chroma", d.mode === "chroma");
    check("녹색 소재 없으면 green 키", d.keyColor === "green");
  }
  {
    const d = decideBackgroundMode({ prompt: "슬라임", subjectType: "character", greenSubject: true });
    check("녹색 소재면 magenta 키", d.keyColor === "magenta");
  }
  {
    const d = decideBackgroundMode({ prompt: "슬라임", subjectType: "character", refIsGreen: true });
    check("참조가 녹색 우세여도 magenta", d.keyColor === "magenta");
  }
  {
    const d = decideBackgroundMode({ prompt: "여우 마법사", subjectType: "character", override: "luma" });
    check("사람 지정이 자동을 이긴다", d.mode === "luma");
    check("manual 로 표기", d.selection === "manual");
  }

  const dir = await mkdtemp(join(tmpdir(), "bgmode-"));
  try {
    console.log("=== verifyLumaBackground — 오분류를 키 걸기 전에 막는다 ===");
    const write = async (name: string, raw: Buffer, w = 256, h = 8): Promise<string> => {
      const p = join(dir, name);
      await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(p);
      return p;
    };
    /** 배경 위에 가운데 밝은 덩어리 하나 — 테두리는 배경으로 남는다(실제 시트의 형태). */
    const blobOn = (bg: [number, number, number], w = 64, h = 64): Buffer => {
      const buf = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
          for (let c = 0; c < 3; c++) buf[i + c] = inside ? 240 : bg[c];
          buf[i + 3] = 255;
        }
      }
      return buf;
    };
    {
      const v = await verifyLumaBackground(await write("black.png", blobOn([0, 0, 0]), 64, 64));
      check("검정 배경은 통과", v.ok, v.reason);
    }
    {
      // 크로마 배경에 luma 를 걸면 초록이 전부 불투명으로 남는 **파괴적** 오분류다.
      const v = await verifyLumaBackground(await write("green.png", blobOn([0, 255, 0]), 64, 64));
      check("초록 배경은 차단", !v.ok, v.reason);
      check("중앙값이 근거로 남는다", v.medianBorderLuma > 200, String(v.medianBorderLuma));
    }
    {
      const v = await verifyLumaBackground(await write("gray.png", blobOn([40, 40, 40]), 64, 64));
      check("짙은 회색도 차단 (배경이 반투명해진다)", !v.ok, v.reason);
    }
    {
      // 글로우가 테두리 절반 이상으로 번지면 차단된다 — 프롬프트가 금지한 상황이고,
      // 그대로 luma 를 걸면 번진 부분이 불투명하게 남는다.
      const w = 64;
      const h = 64;
      const buf = blobOn([0, 0, 0], w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (y > h / 4) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) buf[i + c] = Math.max(buf[i + c], 60);
          }
        }
      }
      const v = await verifyLumaBackground(await write("bleed.png", buf, w, h));
      check("테두리 절반 이상이 밝으면 차단", !v.ok, v.reason);
    }

    console.log("=== 알파 복원 실측 — 확장의 유일한 근거 ===");
    const probes = [0.04, 0.16, 0.31, 0.63, 0.78];
    const idxOf = (a: number): number => Math.round(a * 255);
    {
      // 크로마: 하드컷 96 이 옅은 구간을 지우고, unmixReach 4 가 넓은 그라디언트에
      // 닿지 않아 나머지는 불투명으로 남는다 → 부분 알파가 나오지 않는다.
      const buf = gradient([0, 255, 0]);
      removeChromaBackground(buf, 256, 8, [0, 255, 0]);
      const alphas = probes.map(a => buf[(4 * 256 + idxOf(a)) * 4 + 3] / 255);
      const partial = alphas.filter(v => v > 0.02 && v < 0.98).length;
      check(
        `크로마는 부분 알파를 내지 못한다 (0/${probes.length})`,
        partial === 0,
        alphas.map(v => v.toFixed(2)).join(", "),
      );
    }
    {
      const p = await write("luma-src.png", gradient([0, 0, 0]));
      await lumaKeyFile(p);
      const out = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let worst = 0;
      for (const a of probes) {
        const got = out.data[(4 * 256 + idxOf(a)) * 4 + 3] / 255;
        worst = Math.max(worst, Math.abs(got - a));
      }
      check(`luma 는 ${probes.length}개 표본을 오차 0.01 안으로 복원`, worst <= 0.01, `최대오차 ${worst.toFixed(3)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
