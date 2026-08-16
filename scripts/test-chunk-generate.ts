/**
 * 청크 생성이 계약을 지키는지 — 분할·합성·격자 게이트.
 *
 * 정본에 없는 모듈이라 대조 상대가 없다. 대신 **실측이 강제한 계약**을 고정한다:
 * 청크를 그냥 붙이면 연결요소 분리가 어긋나므로 거터가 있어야 하고, 합성 스트립에서
 * 프레임 수만큼 컴포넌트가 나와야 하며, 격자가 없는 청크는 재시도돼야 한다.
 *
 * 실행: npx tsx scripts/test-chunk-generate.ts
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import {
  planChunks,
  joinChunks,
  generateChunkedRow,
  CHUNK_GUTTER,
  MAX_CHUNK_FRAMES,
  type RawImage,
} from "../src/lib/sprite/chunk-generate";
import { removeChromaBackgroundYcbcr } from "../src/lib/sprite/chroma-ycbcr";
import { extractComponentImages, tightenComponents } from "../src/lib/sprite/extract";
import { detectPixelGrid } from "../src/lib/sprite/pixel-grid";

const CHROMA: [number, number, number] = [255, 0, 255];
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

void (async () => {

console.log("=== 청크 분할 ===");
{
  const cases: Array<[number, number, number[]]> = [
    [1, 2, [1]],
    [2, 2, [2]],
    [3, 2, [2, 1]],
    [4, 2, [2, 2]],
    [5, 2, [2, 2, 1]],
    [8, 2, [2, 2, 2, 2]],
    [4, 1, [1, 1, 1, 1]],
    [6, 3, [3, 3]],
  ];
  for (const [n, size, want] of cases) {
    check(`planChunks(${n}, ${size})`, JSON.stringify(planChunks(n, size)) === JSON.stringify(want),
      JSON.stringify(planChunks(n, size)));
  }
  check("기본 청크 크기는 2 (3부터 격자가 붕괴한다)", MAX_CHUNK_FRAMES === 2);
  let threw = "";
  try { planChunks(0); } catch (e) { threw = (e as Error).message; }
  check("0프레임은 거부", threw.includes("1 이상"), threw);
}

console.log("\n=== 스트립 합성 ===");
{
  const mk = (w: number, h: number, v: number): RawImage => {
    const data = Buffer.alloc(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      data[p * 4] = v; data[p * 4 + 1] = v; data[p * 4 + 2] = v; data[p * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  };
  const s = joinChunks([mk(100, 80, 10), mk(120, 60, 20)], CHROMA);
  check("폭 = 청크합 + 거터×(n+1)",
    s.width === 100 + 120 + CHUNK_GUTTER * 3, `${s.width}`);
  check("높이 = 최대 청크 높이", s.height === 80);
  // 좌측 거터는 크로마
  const at = (x: number, y: number): number[] => {
    const i = (y * s.width + x) * 4;
    return [s.data[i], s.data[i + 1], s.data[i + 2], s.data[i + 3]];
  };
  check("거터가 크로마로 채워진다", JSON.stringify(at(5, 40)) === JSON.stringify([255, 0, 255, 255]),
    JSON.stringify(at(5, 40)));
  check("첫 청크가 거터 뒤에서 시작", at(CHUNK_GUTTER, 40)[0] === 10);
  // 바닥 정렬: 둘째 청크(높이 60)는 위쪽 20행이 크로마
  const x2 = CHUNK_GUTTER * 2 + 100;
  check("낮은 청크는 바닥 정렬 (위쪽은 크로마)",
    at(x2 + 5, 5)[0] === 255 && at(x2 + 5, 79)[0] === 20,
    `${JSON.stringify(at(x2 + 5, 5))} / ${JSON.stringify(at(x2 + 5, 79))}`);
  let threw = "";
  try { joinChunks([], CHROMA); } catch (e) { threw = (e as Error).message; }
  check("빈 청크 목록은 거부", threw.includes("청크가 없습니다"));
}

console.log("\n=== 실제 이미지: 합성 스트립에서 프레임 수만큼 분리된다 ===");
{
  const BASE = "data/images/euaom92zbh0jrchz.png";
  if (!existsSync(BASE)) {
    check("base 이미지 없음", false, BASE);
  } else {
    // base 를 2프레임 청크처럼 쓴다 — 한 청크에 캐릭터 2개.
    const { data, info } = await sharp(BASE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mkChunk = (n: number): RawImage => {
      const GAP = 100;
      const w = info.width * n + GAP * (n - 1);
      const out = Buffer.alloc(w * info.height * 4);
      for (let p = 0; p < w * info.height; p++) {
        out[p * 4] = 255; out[p * 4 + 1] = 0; out[p * 4 + 2] = 255; out[p * 4 + 3] = 255;
      }
      for (let y = 0; y < info.height; y++) {
        for (let k = 0; k < n; k++) {
          data.copy(out, (y * w + k * (info.width + GAP)) * 4, y * info.width * 4, (y + 1) * info.width * 4);
        }
      }
      return { data: out, width: w, height: info.height };
    };

    // 4프레임 = 2청크 × 2프레임
    const joined = joinChunks([mkChunk(2), mkChunk(2)], CHROMA);
    check("4프레임 합성 스트립 생성", joined.width > 0 && joined.height === info.height);

    const cleaned = Buffer.from(joined.data);
    removeChromaBackgroundYcbcr(cleaned, joined.width, joined.height, CHROMA, []);
    const g = extractComponentImages({ data: cleaned, width: joined.width, height: joined.height }, 4);
    check("컴포넌트 4개로 분리된다 (거터가 제 역할을 한다)", g !== null && g.images.length === 4,
      g ? `${g.images.length}개` : "null");
    if (g) {
      const tight = tightenComponents(g.images);
      const pitches = tight.map(c =>
        detectPixelGrid({ data: new Uint8Array(c.data), width: c.width, height: c.height }).pitch[0],
      );
      check("모든 컴포넌트에서 격자가 살아 있다", pitches.every(p => p >= 2),
        JSON.stringify(pitches.map(p => Number(p.toFixed(2)))));
      console.log(`  (참고) 컴포넌트 피치 ${JSON.stringify(pitches.map(p => Number(p.toFixed(2))))}`);
    }

    // 대조군: 거터 없이 붙이면 분리가 어긋난다 (실측이 이 설계를 강제했다)
    const noGutter = joinChunks([mkChunk(2), mkChunk(2)], CHROMA, 0);
    const c2 = Buffer.from(noGutter.data);
    removeChromaBackgroundYcbcr(c2, noGutter.width, noGutter.height, CHROMA, []);
    const g2 = extractComponentImages({ data: c2, width: noGutter.width, height: noGutter.height }, 4);
    const widths = g2 ? tightenComponents(g2.images).map(c => c.width) : [];
    const gutterWidths = g ? tightenComponents(g.images).map(c => c.width) : [];
    check("거터 없이 붙이면 컴포넌트 폭이 달라진다 (거터가 필요한 이유)",
      JSON.stringify(widths) !== JSON.stringify(gutterWidths) || widths.length !== 4,
      `거터없음 ${JSON.stringify(widths)} vs 거터있음 ${JSON.stringify(gutterWidths)}`);
  }
}

console.log("\n=== 격자 게이트와 재시도 ===");
{
  // 격자가 있는/없는 청크를 흉내내는 스텁.
  const gridded = (k: number): RawImage => {
    const W = 24 * k, H = 24 * k;
    const data = Buffer.alloc(W * H * 4);
    let s = 13579;
    const cells: number[][] = [];
    for (let ly = 0; ly < 24; ly++) {
      const row: number[] = [];
      for (let lx = 0; lx < 24; lx++) { s = (s * 1103515245 + 12345) & 0x7fffffff; row.push((s >> 16) & 255); }
      cells.push(row);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = cells[Math.floor(y / k)][Math.floor(x / k)];
      const i = (y * W + x) * 4;
      data[i] = v; data[i + 1] = (v * 3) & 255; data[i + 2] = (v * 7) & 255; data[i + 3] = 255;
    }
    return { data, width: W, height: H };
  };
  const smooth = (): RawImage => {
    const W = 192, H = 192;
    const data = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.round((x / W) * 255); data[i + 1] = Math.round((y / H) * 255);
      data[i + 2] = 128; data[i + 3] = 255;
    }
    return { data, width: W, height: H };
  };

  // 첫 시도는 격자 없음, 둘째 시도는 격자 있음 → 재시도가 성공해야 한다.
  let calls = 0;
  const r1 = await generateChunkedRow({
    frameCount: 4, chromaRgb: CHROMA, label: "t",
    generateChunk: async (_i, _f, attempt) => { calls++; return attempt === 1 ? smooth() : gridded(8); },
  });
  check("실패한 청크는 재시도된다", r1.attempts.every(a => a.attempts === 2), JSON.stringify(r1.attempts));
  check("재시도로 격자를 얻으면 채택", r1.attempts.every(a => a.accepted && a.pitch[0] >= 2),
    JSON.stringify(r1.attempts.map(a => a.pitch)));
  check("경고 없음", r1.warnings.length === 0, JSON.stringify(r1.warnings));
  check("청크 수 = 2 (4프레임/2)", r1.chunks.length === 2 && calls === 4);

  // 계속 실패하면 최대 시도 후 사유를 남기고 그대로 쓴다.
  const r2 = await generateChunkedRow({
    frameCount: 2, chromaRgb: CHROMA, label: "t", maxAttempts: 3,
    generateChunk: async () => smooth(),
  });
  check("최대 시도까지 재시도", r2.attempts[0].attempts === 3, JSON.stringify(r2.attempts));
  check("실패해도 행을 죽이지 않는다", r2.chunks.length === 1 && r2.strip.width > 0);
  check("실패 사유를 남긴다", r2.warnings.length === 1 && r2.warnings[0].includes("격자를 못 냈습니다"),
    JSON.stringify(r2.warnings));
  check("accepted=false 로 기록", r2.attempts[0].accepted === false);

  // 첫 시도에 성공하면 재시도하지 않는다.
  const r3 = await generateChunkedRow({
    frameCount: 2, chromaRgb: CHROMA, generateChunk: async () => gridded(8),
  });
  check("첫 시도 성공이면 1회만", r3.attempts[0].attempts === 1);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
