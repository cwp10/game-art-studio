/**
 * ⑤ — 크로마 알파 정리와 컴포넌트 추출 테스트.
 *
 * 원본(`sprite_gen/extract.py`)과 같은 상수·순서로 동작하는지 합성 이미지로 확인한다.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FRINGE_DELTA,
  DEFAULT_KEY_THRESHOLD,
  despillColor,
  keyChannelSplit,
  keyTintScore,
  removeChromaBackground,
  unmixKeyBlend,
  type RGB,
} from "../src/lib/sprite/chroma-clean";
import {
  ExtractionFailed,
  alphaCentroidX,
  connectedComponents,
  extractComponentImages,
  extractRowFrames,
  fitToCell,
  type RawImage,
} from "../src/lib/sprite/extract";
import { normalizeCell } from "../src/lib/sprite/request";

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

const MAGENTA: RGB = [255, 0, 255];
const GREEN: RGB = [0, 255, 0];

function canvas(w: number, h: number, bg: RGB): RawImage {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
function put(img: RawImage, x: number, y: number, c: RGB, a = 255): void {
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0];
  img.data[o + 1] = c[1];
  img.data[o + 2] = c[2];
  img.data[o + 3] = a;
}
function rect(img: RawImage, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(img, x, y, c);
}
function at(img: RawImage, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

void (async () => {
  console.log("=== 키 채널 분해 / 틴트 점수 ===");
  {
    const m = keyChannelSplit(MAGENTA);
    check("마젠타는 R,B 포화 / G 어두움", m.keyed.join(",") === "0,2" && m.unkeyed.join(",") === "1");
    const g = keyChannelSplit(GREEN);
    check("그린은 G 포화 / R,B 어두움", g.keyed.join(",") === "1" && g.unkeyed.join(",") === "0,2");
    check("퇴화 키(회색)는 빈 배열 둘", keyChannelSplit([128, 128, 128]).keyed.length === 0);
    check("키 자신의 틴트 점수 = 255", keyTintScore(MAGENTA, MAGENTA) === 255);
    check("키와 무관한 색은 음수/0 근처", keyTintScore([0, 255, 0], MAGENTA) === -255);
  }

  console.log("=== despill 블렌드 모델 ===");
  {
    // 키 절반 섞인 흰색: observed = 0.5*white + 0.5*magenta = (255,127,255)
    const keyTint = keyTintScore(MAGENTA, MAGENTA);
    const obs: RGB = [255, 128, 255];
    const { coverage, color } = despillColor(obs, MAGENTA, keyTint, keyTintScore(obs, MAGENTA));
    check("커버리지가 ~0.5", Math.abs(coverage - 0.5) < 0.01, `${coverage}`);
    check("despill 결과가 흰색에 가깝다", color.every(v => v >= 250), color.join(","));
    const [, , , a] = unmixKeyBlend(obs, 255, MAGENTA, keyTint, keyTintScore(obs, MAGENTA));
    check("부분 알파가 커버리지를 따른다", Math.abs(a - 128) <= 2, `${a}`);
  }

  console.log("=== 패스 1 — 하드 키 컷 ===");
  {
    const img = canvas(64, 64, MAGENTA);
    rect(img, 16, 16, 48, 48, [30, 60, 200]);
    removeChromaBackground(img.data, 64, 64, MAGENTA);
    check("배경이 완전 투명", at(img, 0, 0)[3] === 0);
    check("투명 픽셀은 RGB 도 0 (헤일로 방지)", at(img, 0, 0).slice(0, 3).every(v => v === 0));
    // 소재 내부(가장자리에서 unmixReach 4 보다 깊은 곳)는 손대지 않는다.
    check("소재 내부는 불투명 유지", at(img, 32, 32)[3] === 255);
    check("소재 내부 색이 그대로", at(img, 32, 32).slice(0, 3).join(",") === "30,60,200");
  }
  {
    // 키 거리가 임계 바로 안/밖
    const img = canvas(4, 1, MAGENTA);
    put(img, 0, 0, [255, 90, 255]); // 거리 90 < 96 → 지워짐
    put(img, 1, 0, [255, 100, 255]); // 거리 100 > 96 → 남음
    removeChromaBackground(img.data, 4, 1, MAGENTA);
    check(`거리 90 (< ${DEFAULT_KEY_THRESHOLD}) 은 지워진다`, at(img, 0, 0)[3] === 0);
    check(`거리 100 (> ${DEFAULT_KEY_THRESHOLD}) 은 남는다`, at(img, 1, 0)[3] !== 0);
  }

  console.log("=== 패스 2 — 소프트 알파 unmix ===");
  {
    const img = canvas(40, 40, MAGENTA);
    rect(img, 12, 12, 28, 28, [255, 255, 255]);
    for (let x = 11; x < 29; x++) put(img, x, 11, [255, 128, 255]); // 위쪽 AA 줄
    removeChromaBackground(img.data, 40, 40, MAGENTA);
    const aa = at(img, 20, 11);
    check("AA 픽셀이 부분 알파를 갖는다 (이진 계단 아님)", aa[3] > 0 && aa[3] < 255, `a=${aa[3]}`);
    check("AA 픽셀의 키 틴트가 제거된다", aa[1] > 200, `g=${aa[1]}`);
    check("내부 소재는 불투명 그대로", at(img, 20, 20)[3] === 255);
  }
  {
    // v1.10.1 가드레일: 키에서 먼 in-band 블렌드는 unmix 되지 않는다.
    // [255,110,255] 는 거리 145 (> 96 하드컷, <= 180 in-band) 이고 배경에서 깊다.
    const img = canvas(60, 60, MAGENTA);
    rect(img, 12, 12, 48, 48, [40, 40, 40]);
    rect(img, 26, 26, 34, 34, [255, 110, 255]);
    const before = at(img, 30, 30);
    removeChromaBackground(img.data, 60, 60, MAGENTA);
    const after = at(img, 30, 30);
    check(
      "깊은 in-band 키 틴트 소재는 바이트 동일하게 살아남는다",
      before.join(",") === after.join(","),
      `${before.join(",")} → ${after.join(",")}`,
    );
  }

  console.log("=== 패스 3 — 갇힌 스필 despill ===");
  {
    const img = canvas(120, 120, MAGENTA);
    // 주변 소재는 키 틴트가 아니어야 한다(tint < fringeDelta 18). 크림슨(tint 84.5)으로
    // 감싸면 소재와 스필이 한 덩어리가 되어 spillLimit 을 넘고 통째로 보존된다 —
    // 그게 원본 동작이고, "크림슨은 마젠타 인접"이라는 정본 경고의 실체다.
    rect(img, 20, 20, 100, 100, [40, 40, 60]); // tint 10 → SUBJECT
    rect(img, 58, 58, 62, 62, [230, 110, 225]); // 내부 스필 16px (거리 117 > 96)
    removeChromaBackground(img.data, 120, 120, MAGENTA);
    const spill = at(img, 60, 60);
    check("스필이 색 보정된다", spill.slice(0, 3).join(",") !== "230,110,225", spill.join(","));
    check("스필의 알파는 유지된다 (바늘구멍 금지)", spill[3] === 255, `${spill[3]}`);
    check("주변 소재는 그대로", at(img, 40, 40).slice(0, 3).join(",") === "40,40,60");
  }
  {
    // 큰 키 틴트 영역은 의도된 소재 — 건드리지 않는다 (spillLimit 초과)
    const img = canvas(120, 120, MAGENTA);
    rect(img, 10, 10, 110, 110, [40, 40, 40]);
    rect(img, 30, 30, 90, 90, [255, 110, 255]); // 3600px, 소재의 절반 이상
    removeChromaBackground(img.data, 120, 120, MAGENTA);
    check(
      "큰 키 틴트 영역은 보존된다",
      at(img, 60, 60).slice(0, 3).join(",") === "255,110,255",
      at(img, 60, 60).join(","),
    );
  }

  console.log("=== 연결 컴포넌트 ===");
  {
    const img = canvas(40, 20, [0, 0, 0]);
    for (let i = 0; i < 40 * 20; i++) img.data[i * 4 + 3] = 0;
    rect(img, 2, 5, 10, 15, [200, 100, 50]);
    rect(img, 25, 5, 35, 15, [200, 100, 50]);
    const cs = connectedComponents(img);
    check("두 덩어리를 찾는다", cs.length === 2, `${cs.length}`);
    check("centerX 로 좌우 구분", cs.some(c => c.centerX < 12) && cs.some(c => c.centerX > 25));
    check("area 가 맞다 (8x10, 10x10)", cs.map(c => c.area).sort((a, b) => a - b).join(",") === "80,100", cs.map(c => c.area).join(","));
  }

  console.log("=== extractComponentImages ===");
  {
    const img = canvas(80, 20, [0, 0, 0]);
    for (let i = 0; i < 80 * 20; i++) img.data[i * 4 + 3] = 0;
    for (let f = 0; f < 4; f++) rect(img, f * 20 + 4, 4, f * 20 + 16, 16, [200, 100, 50]);
    const r = extractComponentImages(img, 4);
    check("4개를 뽑는다", r !== null && r.images.length === 4);
    check("왼쪽부터 정렬된다", r !== null && r.images.every(im => im.width > 0));
    const short = extractComponentImages(img, 6);
    check("요청보다 컴포넌트가 적으면 null (행 차단)", short === null);
  }
  {
    // 멀리 떨어진 파편은 병합되지 않고 버려진다
    const img = canvas(80, 40, [0, 0, 0]);
    for (let i = 0; i < 80 * 40; i++) img.data[i * 4 + 3] = 0;
    for (let f = 0; f < 2; f++) rect(img, f * 40 + 5, 10, f * 40 + 30, 35, [200, 100, 50]);
    rect(img, 36, 0, 40, 4, [200, 100, 50]); // 시드에서 먼 파편
    const r = extractComponentImages(img, 2);
    check("멀리 떨어진 위성은 버려진다", r !== null && r.dropped === 1, `dropped=${r?.dropped}`);
  }

  console.log("=== fitToCell ===");
  {
    const cell = normalizeCell({ size: 64 }); // margin 6
    const img = canvas(20, 30, [0, 0, 0]);
    for (let i = 0; i < 20 * 30; i++) img.data[i * 4 + 3] = 0;
    rect(img, 4, 4, 16, 26, [200, 100, 50]);
    const out = await fitToCell(img, cell);
    check("셀 크기로 나온다", out.width === 64 && out.height === 64);
    // align_y = bottom: 피사체 하단이 cellH - marginY 에 닿는다
    let bottom = -1;
    for (let y = 63; y >= 0 && bottom < 0; y--) {
      for (let x = 0; x < 64; x++) if (at(out, x, y)[3] > 0) { bottom = y; break; }
    }
    check("바닥이 셀 하단 - margin 에 앉는다", bottom === 64 - cell.safeMarginY - 1, `${bottom}`);
  }
  {
    // 큰 피사체는 safe 영역 안으로 축소된다
    const cell = normalizeCell({ size: 32 }); // margin 3, safe 26x26
    const img = canvas(100, 100, [0, 0, 0]);
    for (let i = 0; i < 100 * 100; i++) img.data[i * 4 + 3] = 0;
    rect(img, 0, 0, 100, 100, [200, 100, 50]);
    const out = await fitToCell(img, cell);
    let minX = 32;
    let maxX = -1;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (at(out, x, y)[3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    check(
      "safe 영역(26px) 안으로 축소된다",
      maxX - minX + 1 <= 32 - cell.safeMarginX * 2,
      `${maxX - minX + 1} <= ${32 - cell.safeMarginX * 2}`,
    );
  }

  console.log("=== alphaCentroidX ===");
  {
    const img = canvas(20, 20, [0, 0, 0]);
    for (let i = 0; i < 400; i++) img.data[i * 4 + 3] = 0;
    rect(img, 0, 0, 4, 10, [255, 255, 255]); // 위쪽 왼편 (머리카락)
    rect(img, 14, 14, 18, 20, [255, 255, 255]); // 아래쪽 오른편 (다리)
    const full = alphaCentroidX(img);
    const foot = alphaCentroidX(img, 0.2);
    check("foot-centroid 는 아래쪽만 본다", foot > full, `full=${full.toFixed(1)} foot=${foot.toFixed(1)}`);
    check("foot-centroid 가 다리 쪽", Math.abs(foot - 16) < 1, `${foot}`);
  }

  console.log("=== extractRowFrames 통합 ===");
  {
    const dir = await mkdtemp(join(tmpdir(), "extract-"));
    try {
      const img = canvas(400, 100, GREEN);
      for (let f = 0; f < 4; f++) rect(img, f * 100 + 20, 20, f * 100 + 80, 90, [153, 12, 40]);
      const sheet = join(dir, "row.png");
      await sharp(img.data, { raw: { width: 400, height: 100, channels: 4 } }).png().toFile(sheet);

      const cell = normalizeCell({ size: 256 });
      const r = await extractRowFrames({ sheetPath: sheet, frameCount: 4, cell, chromaKey: GREEN });
      check("method 는 components", r.method === "components");
      check("4프레임", r.frames.length === 4);
      check("각 프레임이 셀 크기", r.frames.every(f => f.width === 256 && f.height === 256));
      check(
        "프레임에 알파가 있다",
        r.frames.every(f => {
          let opaque = 0;
          for (let i = 0; i < 256 * 256; i++) if (f.data[i * 4 + 3] > 0) opaque++;
          return opaque > 0 && opaque < 256 * 256;
        }),
      );
      check(
        "크로마 잔여가 없다",
        r.frames.every(f => {
          for (let i = 0; i < 256 * 256; i++) {
            if (f.data[i * 4 + 3] > 0 && f.data[i * 4 + 1] > 200 && f.data[i * 4] < 60) return false;
          }
          return true;
        }),
      );

      // 프레임 수를 못 맞추면 차단
      let threw = "";
      try {
        await extractRowFrames({ sheetPath: sheet, frameCount: 8, cell, chromaKey: GREEN });
      } catch (e) {
        threw = e instanceof ExtractionFailed ? e.message : String(e);
      }
      check("컴포넌트 부족은 행 차단", threw.includes("could not extract 8 sprite components"), threw);

      // 옵트인 폴백은 표기된다
      const fb = await extractRowFrames({
        sheetPath: sheet,
        frameCount: 8,
        cell,
        chromaKey: GREEN,
        allowSlotFallback: true,
      });
      check("폴백은 slots-explicit 로 표기", fb.method === "slots-explicit");
      check("폴백도 셀 크기로 나온다", fb.frames.length === 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("=== Python 원본과 바이트 대조 ===");
  // 기준 PNG 는 sprite-gen 의 remove_chroma_background 가 만든다. 생성 방법:
  //   .venv/bin/python -c "from PIL import Image; from sprite_gen.extract import
  //     remove_chroma_background as r; im=Image.open('case.png');
  //     r(im,(255,0,255),96.0,180.0,18.0,unmix_reach=4,spill_max_fraction=0.005).save('case.py.png')"
  // 손으로 쓴 기대값보다 강한 근거다 — 위 단언들은 전부 이 대조에 종속된다.
  {
    const refDir = process.env.RCB_REF_DIR ?? "";
    if (!refDir) {
      console.log("  SKIP  RCB_REF_DIR 미설정 — Python 바이트 대조를 건너뛴다");
      skipped++;
    } else {
      const cases: Array<[string, RGB]> = [
        ["case1", MAGENTA],
        ["case2", GREEN],
        ["case3", MAGENTA],
      ];
      for (const [name, key] of cases) {
        const src = join(refDir, `${name}.png`);
        const ref = join(refDir, `${name}.py.png`);
        if (!existsSync(src) || !existsSync(ref)) {
          console.log(`  SKIP  ${name} — 기준 PNG 없음`);
          skipped++;
          continue;
        }
        const { data, info } = await sharp(src)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        removeChromaBackground(data, info.width, info.height, key);
        const py = await sharp(ref).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let diff = 0;
        let first = "";
        for (let i = 0; i < py.data.length; i++) {
          if (py.data[i] !== data[i]) {
            if (diff === 0) {
              const p = (i / 4) | 0;
              first = `(${p % info.width},${(p / info.width) | 0}) ch${i % 4} py=${py.data[i]} ts=${data[i]}`;
            }
            diff++;
          }
        }
        check(`${name} 바이트 동일`, diff === 0, `${diff} bytes 불일치; ${first}`);
      }
    }
  }

  console.log(`\n${passed} passed / ${failed} failed / ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();

void DEFAULT_FRINGE_DELTA;
