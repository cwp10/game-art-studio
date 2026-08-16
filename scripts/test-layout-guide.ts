/**
 * ② Task 4 — 레이아웃 가이드 픽셀 대조.
 *
 * 기준 PNG 는 sprite-gen `draw_guide()` 가 만든다. 경로는 GUIDE_REF_DIR 로 준다:
 *
 *   .venv/bin/python -c "... draw_guide(out/'sq256-f4.png', 'idle', 4, normalize_cell({},256,None)) ..."
 *
 * 기준이 없으면 SKIP 하고 성공으로 치지 않는다 — 조용한 통과를 막는다.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderLayoutGuideBuffer } from "../src/lib/sprite/layout-guide";
import {
  drawWideLine,
  legPoints,
  RUN_PHASE_CYCLE,
  stateMotionPhases,
} from "../src/lib/sprite/motion-phase";
import { normalizeCell, type RawCell } from "../src/lib/sprite/request";

const REF_DIR = process.env.GUIDE_REF_DIR ?? "";

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

void (async () => {
  console.log("=== 기하 (기준 PNG 없이도 검증 가능) ===");
  {
    const cell = normalizeCell({});
    const g = renderLayoutGuideBuffer(4, cell);
    check("캔버스는 frames*cellW x cellH", g.width === 1024 && g.height === 256);
    check("RGB 3채널", g.raw.length === 1024 * 256 * 3);
    const at = (x: number, y: number): string => {
      const o = (y * g.width + x) * 3;
      return `#${[g.raw[o], g.raw[o + 1], g.raw[o + 2]]
        .map(v => v.toString(16).padStart(2, "0"))
        .join("")}`;
    };
    check("배경은 #f6f6f6", at(140, 140) === "#f6f6f6", at(140, 140));
    check("셀 좌상단은 테두리 #333333", at(0, 0) === "#333333", at(0, 0));
    check("테두리 두께 3 — x=2 는 테두리", at(2, 128) === "#333333", at(2, 128));
    check("테두리 두께 3 — x=3 은 배경", at(3, 128) === "#f6f6f6", at(3, 128));
    check("safe 사각형 좌변 #2f80ed", at(24, 128) === "#2f80ed", at(24, 128));
    check("safe 두께 2 — x=25 도 safe", at(25, 128) === "#2f80ed", at(25, 128));
    check("safe 두께 2 — x=26 은 배경", at(26, 128) === "#f6f6f6", at(26, 128));
    check("중앙선 #b8c8e8", at(128, 128) === "#b8c8e8", at(128, 128));
    // 원본의 비대칭: safe 아래변은 y=231, 중앙선은 y=232 까지 내려간다.
    check("중앙선이 safe 아래변보다 1px 더 내려간다", at(128, 232) === "#b8c8e8", at(128, 232));
    check("y=233 은 배경", at(128, 233) === "#f6f6f6", at(128, 233));
    check("두 번째 셀의 좌테두리", at(256, 128) === "#333333", at(256, 128));
  }
  {
    let threw = false;
    try {
      renderLayoutGuideBuffer(0, normalizeCell({}));
    } catch {
      threw = true;
    }
    check("frames 0 은 거부", threw);
  }

  console.log("=== Python 기준 PNG 픽셀 대조 ===");
  const CASES: Array<[string, [RawCell, number, number | null], number]> = [
    ["sq256-f4", [{}, 256, null], 4],
    ["sq128-f6", [{ size: 128 }, 128, null], 6],
    ["rect192x208-f4", [{ width: 192, height: 208 }, 256, null], 4],
    ["sq256-m40-f8", [{}, 256, 40], 8],
  ];
  if (!REF_DIR) {
    console.log("  SKIP  GUIDE_REF_DIR 미설정 — Python 기준 대조를 건너뛴다");
    skipped += CASES.length;
  } else {
    for (const [label, cellArgs, frames] of CASES) {
      const refPath = join(REF_DIR, `${label}.png`);
      if (!existsSync(refPath)) {
        console.log(`  SKIP  ${label} — 기준 PNG 없음 (${refPath})`);
        skipped++;
        continue;
      }
      const cell = normalizeCell(cellArgs[0], cellArgs[1], cellArgs[2]);
      const mine = renderLayoutGuideBuffer(frames, cell);
      const ref = await sharp(refPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (ref.info.width !== mine.width || ref.info.height !== mine.height) {
        check(
          `${label} 치수 일치`,
          false,
          `ref ${ref.info.width}x${ref.info.height} vs ${mine.width}x${mine.height}`,
        );
        continue;
      }
      let diff = 0;
      let firstDiff = "";
      for (let i = 0; i < ref.data.length; i++) {
        if (ref.data[i] !== mine.raw[i]) {
          if (diff === 0) {
            const px = (i / 3) | 0;
            firstDiff = `첫 차이 (${px % mine.width},${(px / mine.width) | 0}) ref=${ref.data[i]} mine=${mine.raw[i]}`;
          }
          diff++;
        }
      }
      check(`${label} 픽셀 동일`, diff === 0, `${diff} bytes 불일치; ${firstDiff}`);
    }
  }

  // ── 모션 페이즈 가이드 (옵트인) ────────────────────────────────────────────
  console.log("=== stateMotionPhases — 8프레임 로코모션만 ===");
  check("run 8f → 8단계", stateMotionPhases("run", 8).length === 8);
  check("walk 8f → 8단계", stateMotionPhases("walk", 8).length === 8);
  check("running-front-right 8f", stateMotionPhases("running-front-right", 8).length === 8);
  check("walking-back-left 8f", stateMotionPhases("walking-back-left", 8).length === 8);
  check("run 4f → 없음 (원본과 동일)", stateMotionPhases("run", 4).length === 0);
  check("run 6f → 없음", stateMotionPhases("run", 6).length === 0);
  check("idle 8f → 없음", stateMotionPhases("idle", 8).length === 0);
  check("attack 8f → 없음", stateMotionPhases("attack", 8).length === 0);

  console.log("=== RUN_PHASE_CYCLE — 주기의 뒷절반이 앞절반의 좌우 반전 ===");
  {
    const c = RUN_PHASE_CYCLE;
    check("몸통 높이 0,6,2,-6 이 두 번", [0, 6, 2, -6, 0, 6, 2, -6].every((v, i) => c[i].bodyY === v));
    for (let i = 0; i < 4; i++) {
      check(
        `${c[i].name} ↔ ${c[i + 4].name} 다리 교대`,
        c[i].frontLeg === c[i + 4].backLeg && c[i].backLeg === c[i + 4].frontLeg,
      );
    }
  }

  console.log("=== legPoints — left facing 은 x 를 중심 대칭 ===");
  {
    const r = legPoints([100, 50], "forward_straight", "right", 1);
    const l = legPoints([100, 50], "forward_straight", "left", 1);
    check("발이 반대쪽으로", 100 - (r.foot[0] - 100) === l.foot[0], `${r.foot[0]} / ${l.foot[0]}`);
    check("무릎도 반대쪽으로", 100 - (r.knee[0] - 100) === l.knee[0]);
    check("y 는 그대로", r.foot[1] === l.foot[1] && r.knee[1] === l.knee[1]);
    check("앞다리는 앞으로 뻗는다", r.foot[0] > 100);
    check("뒷다리는 뒤로 뻗는다", legPoints([100, 50], "back_extended", "right", 1).foot[0] < 100);
  }

  console.log("=== 굵은 선 래스터화 — PIL 실측 대조 ===");
  {
    // sprite-gen venv 의 PIL 이 `line(((5,5),(30,34)), width=5)` 로 낸 행별 x 범위.
    // 우리 fillPolygon 이 꼭짓점을 두 번 세면 y=6 이 7px → 1px 로 무너진다.
    const expected: Array<[number, number, number]> = [
      [4, 7, 7], [5, 5, 8], [6, 3, 9], [7, 4, 10], [8, 5, 10], [9, 6, 11],
      [10, 6, 12], [11, 7, 13], [12, 8, 14], [13, 9, 15], [14, 10, 16], [15, 11, 16],
      [16, 12, 17], [17, 12, 18], [18, 13, 19], [19, 14, 20], [20, 15, 21], [21, 16, 22],
      [22, 17, 23], [23, 18, 23], [24, 19, 24], [25, 19, 25], [26, 20, 26], [27, 21, 27],
      [28, 22, 28], [29, 23, 29], [30, 24, 29], [31, 25, 30], [32, 25, 31], [33, 26, 32],
      [34, 27, 30], [35, 28, 28],
    ];
    const c = { raw: Buffer.alloc(40 * 40 * 3, 255), width: 40, height: 40 };
    drawWideLine(c, 5, 5, 30, 34, [0, 0, 0], 5);
    let bad = 0;
    let firstBad = "";
    for (const [y, lo, hi] of expected) {
      const xs: number[] = [];
      for (let x = 0; x < 40; x++) if (c.raw[(y * 40 + x) * 3] === 0) xs.push(x);
      const ok = xs.length > 0 && xs[0] === lo && xs[xs.length - 1] === hi;
      if (!ok) {
        if (!bad) firstBad = `y=${y} 기대 ${lo}..${hi}, 실제 ${xs.length ? `${xs[0]}..${xs[xs.length - 1]}` : "없음"}`;
        bad++;
      }
    }
    check("PIL 굵은 선과 모든 행이 일치", bad === 0, `${bad}행 불일치; ${firstBad}`);
  }

  console.log("=== 가이드에 얹기 — 옵트인이고 기본은 안 그린다 ===");
  {
    const cell = { width: 256, height: 256, safeMarginX: 24, safeMarginY: 24 };
    const plain = renderLayoutGuideBuffer(8, cell);
    const off = renderLayoutGuideBuffer(8, { ...cell, motionPhaseState: undefined });
    check("motionPhaseState 없으면 기존 가이드 그대로", plain.raw.equals(off.raw));

    const on = renderLayoutGuideBuffer(8, { ...cell, motionPhaseState: "run" });
    check("켜면 달라진다", !plain.raw.equals(on.raw));

    // 8프레임이 아니면 켜도 그리지 않는다 — 원본 state_motion_phases 와 같다.
    const four = renderLayoutGuideBuffer(4, cell);
    const fourOn = renderLayoutGuideBuffer(4, { ...cell, motionPhaseState: "run" });
    check("4프레임은 켜도 그대로", four.raw.equals(fourOn.raw));

    // 로코모션이 아니면 켜도 그리지 않는다.
    const idleOn = renderLayoutGuideBuffer(8, { ...cell, motionPhaseState: "idle" });
    check("idle 은 켜도 그대로", plain.raw.equals(idleOn.raw));

    const hasColor = (buf: Buffer, rgb: [number, number, number]): boolean => {
      for (let i = 0; i < buf.length; i += 3) {
        if (buf[i] === rgb[0] && buf[i + 1] === rgb[1] && buf[i + 2] === rgb[2]) return true;
      }
      return false;
    };
    check("앞다리 빨강이 그려진다", hasColor(on.raw, [0xef, 0x44, 0x44]));
    check("뒷다리 파랑이 그려진다", hasColor(on.raw, [0x25, 0x63, 0xeb]));
    check("머리·척추 회색이 그려진다", hasColor(on.raw, [0x6b, 0x72, 0x80]));

    const left = renderLayoutGuideBuffer(8, { ...cell, motionPhaseState: "running-left" });
    check("left facing 은 다른 그림", !on.raw.equals(left.raw));
  }

  console.log("=== 모션 페이즈 잔차 — 타원만 다르고 상한을 넘지 않는다 ===");
  {
    // 기준 PNG: draw_guide(..., motion_phase_guides=True). PHASE_REF_DIR 로 준다.
    // 선·팔·척추·접지선은 바이트 동일이고, 머리 타원만 원본보다 한 픽셀 두껍다
    // (motion-phase.ts drawEllipseOutline 주석 참조). 실측 상한을 잠가 둔다.
    const phaseRef = process.env.PHASE_REF_DIR ?? "";
    const cases: Array<[string, number, number, number, number, number, number]> = [
      ["run", 8, 256, 256, 24, 24, 528],
      ["running-left", 8, 256, 256, 24, 24, 528],
      ["walking-front-right", 8, 192, 208, 18, 19, 408],
      ["run", 4, 256, 256, 24, 24, 0],
    ];
    if (!phaseRef) {
      console.log("  SKIP  PHASE_REF_DIR 미설정 — 모션 페이즈 잔차 대조를 건너뛴다");
      skipped++;
    } else {
      for (const [state, frames, w, h, mx, my, bound] of cases) {
        const file = join(phaseRef, `${state}-${frames}-${w}x${h}.png`);
        if (!existsSync(file)) {
          console.log(`  SKIP  ${state} ${frames}f — 기준 PNG 없음`);
          skipped++;
          continue;
        }
        const ref = await sharp(file).raw().toBuffer({ resolveWithObject: true });
        const ours = renderLayoutGuideBuffer(frames, {
          width: w,
          height: h,
          safeMarginX: mx,
          safeMarginY: my,
          motionPhaseState: state,
        });
        let diff = 0;
        let onlyEllipse = true;
        for (let i = 0; i < ours.raw.length; i += 3) {
          if (ref.data[i] === ours.raw[i] && ref.data[i + 1] === ours.raw[i + 1] && ref.data[i + 2] === ours.raw[i + 2]) {
            continue;
          }
          diff++;
          // 우리가 원본보다 더 그린 머리·척추 색만 허용한다.
          const oursIsHead = ours.raw[i] === 0x6b && ours.raw[i + 1] === 0x72 && ours.raw[i + 2] === 0x80;
          if (!oursIsHead) onlyEllipse = false;
        }
        check(`${state} ${frames}f 잔차 ${diff} ≤ ${bound}`, diff <= bound, `${diff}`);
        if (diff > 0) check(`${state} ${frames}f 차이는 머리 타원뿐`, onlyEllipse);
      }
    }
  }

  console.log(`\n${passed} passed / ${failed} failed / ${skipped} skipped`);
  if (failed > 0) process.exit(1);
})();
