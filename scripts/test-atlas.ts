/**
 * ⑥ 최소판 — 아틀라스 합성과 런타임 매니페스트 테스트.
 * sprite_gen/compose_atlas.py 의 배치·계약과 맞는지 본다.
 */
import { composeAtlas, DEFAULT_MIN_USED_PIXELS } from "../src/lib/sprite/atlas";
import type { RawImage } from "../src/lib/sprite/extract";
import {
  DEFAULT_CHROMA_TUNABLES,
  normalizeCell,
  type SpriteRequest,
  type StateSpec,
} from "../src/lib/sprite/request";

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

const cell = normalizeCell({ size: 64 });

/** 셀 크기 프레임. filled 만큼 불투명 픽셀을 채운다. */
function frame(filled = 1000, tag = 200): RawImage {
  const data = Buffer.alloc(cell.width * cell.height * 4);
  for (let i = 0; i < Math.min(filled, cell.width * cell.height); i++) {
    data[i * 4] = tag;
    data[i * 4 + 1] = 100;
    data[i * 4 + 2] = 50;
    data[i * 4 + 3] = 255;
  }
  return { data, width: cell.width, height: cell.height };
}

const S = (frames: number, fps: number, loop: boolean): StateSpec => ({
  frames,
  fps,
  loop,
  action: "a",
});

function req(states: Record<string, StateSpec>): SpriteRequest {
  return {
    version: 1,
    character: { id: "aurora", description: "d", anchorGenerationId: "x" },
    cell,
    chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
    chroma: DEFAULT_CHROMA_TUNABLES,
    states,
  };
}

console.log("=== 배치 — 상태당 한 행 ===");
{
  const r = composeAtlas({
    request: req({ down_idle: S(4, 4, true), down_action: S(3, 8, false) }),
    framesByState: {
      down_idle: [frame(), frame(), frame(), frame()],
      down_action: [frame(), frame(), frame()],
    },
  });
  check("에러 없음", r.errors.length === 0, r.errors.join(" | "));
  check("columns = 최대 프레임 수", r.manifest.animation.columns === 4);
  check("아틀라스 폭 = columns * cellW", r.atlas.width === 4 * 64);
  check("아틀라스 높이 = 상태 수 * cellH", r.atlas.height === 2 * 64);
  check("행 인덱스가 순서대로", r.manifest.animation.rows.down_action.row === 1);
}

console.log("=== frame_layout — 절대 사각형 ===");
{
  const r = composeAtlas({
    request: req({ a: S(2, 6, true), b: S(2, 6, true) }),
    framesByState: { a: [frame(), frame()], b: [frame(), frame()] },
  });
  const fl = r.manifest.frame_layout;
  check("sheetWidth/Height 가 아틀라스와 일치", fl.sheetWidth === 128 && fl.sheetHeight === 128);
  check("a 행 rect 2개", fl.rows.a.length === 2);
  check("a[0] 은 (0,0)", fl.rows.a[0].x === 0 && fl.rows.a[0].y === 0);
  check("a[1] 은 (64,0)", fl.rows.a[1].x === 64 && fl.rows.a[1].y === 0);
  check("b[0] 은 (0,64) — 다음 행", fl.rows.b[0].x === 0 && fl.rows.b[0].y === 64);
  check("rect 크기는 셀 크기", fl.rows.a[0].w === 64 && fl.rows.a[0].h === 64);
}

console.log("=== durations_ms 가 프레임별 표시 시간의 SSoT ===");
{
  const r = composeAtlas({
    request: req({ idle: S(4, 4, true), attack: S(4, 8, false) }),
    framesByState: { idle: [frame(), frame(), frame(), frame()], attack: [frame(), frame(), frame(), frame()] },
  });
  check("fps 4 → 250ms", r.manifest.animation.rows.idle.durations_ms.every(d => d === 250));
  check("fps 8 → 125ms", r.manifest.animation.rows.attack.durations_ms.every(d => d === 125));
  check("길이가 프레임 수와 같다", r.manifest.animation.rows.idle.durations_ms.length === 4);
  check("loop 이 상태를 따른다", r.manifest.animation.rows.idle.loop === true);
  check("non-loop 도 반영", r.manifest.animation.rows.attack.loop === false);
}

console.log("=== Runtime Contract 필수 필드 ===");
{
  const r = composeAtlas({
    request: req({ idle: S(1, 6, true) }),
    framesByState: { idle: [frame()] },
    atlasName: "sprite-sheet-alpha.png",
  });
  const m = r.manifest;
  check("game_input", m.game_input === "sprite-sheet-alpha.png");
  check("degraded_static_fallback 은 false", m.degraded_static_fallback === false);
  check("engine 은 component-row", m.engine === "component-row");
  check("cell 이 실린다", m.cell.width === 64);
  check("chroma_key 가 실린다", m.chroma_key.hex === "#00FF00");
  check("characterId", m.characterId === "aurora");
}

console.log("=== 빈/어긋난 프레임은 에러 ===");
{
  const r = composeAtlas({
    request: req({ idle: S(2, 6, true) }),
    framesByState: { idle: [frame(), frame(DEFAULT_MIN_USED_PIXELS - 1)] },
  });
  check("희소 프레임이 에러로 잡힌다", r.errors.some(e => e.includes("too sparse")), r.errors.join(" | "));
}
{
  const wrong: RawImage = { data: Buffer.alloc(32 * 32 * 4), width: 32, height: 32 };
  const r = composeAtlas({
    request: req({ idle: S(2, 6, true) }),
    framesByState: { idle: [frame(), wrong] },
  });
  check("셀 크기가 다르면 에러", r.errors.some(e => e.includes("expected 64x64")), r.errors.join(" | "));
  check("어긋난 프레임은 rect 에서 빠진다", r.manifest.frame_layout.rows.idle.length === 1);
}

console.log("=== 픽셀이 실제로 그 자리에 놓인다 ===");
{
  const r = composeAtlas({
    request: req({ a: S(2, 6, true), b: S(1, 6, true) }),
    framesByState: { a: [frame(64 * 64, 11), frame(64 * 64, 22)], b: [frame(64 * 64, 33)] },
  });
  const px = (x: number, y: number): number => r.atlas.data[(y * r.atlas.width + x) * 4];
  check("a[0] 의 태그가 (0,0)", px(0, 0) === 11);
  check("a[1] 의 태그가 (64,0)", px(64, 0) === 22);
  check("b[0] 의 태그가 (0,64)", px(0, 64) === 33);
  check("b 행의 빈 칸은 투명", r.atlas.data[(64 * r.atlas.width + 64) * 4 + 3] === 0);
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
