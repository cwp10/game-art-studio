/**
 * ⑥ 최소판 — 아틀라스 합성과 런타임 매니페스트 테스트.
 * sprite_gen/compose_atlas.py 의 배치·계약과 맞는지 본다.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
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

console.log("=== 큐레이션 반영 — Output Contract 경계 ===");
{
  // 큐레이션 없음 = 추출 순서 그대로. **명시적 기본값이지 조용한 폴백이 아니다.**
  const r = composeAtlas({
    request: req({ a: S(4, 6, true) }),
    framesByState: { a: [frame(1000, 11), frame(1000, 22), frame(1000, 33), frame(1000, 44)] },
  });
  check("큐레이션 없으면 curation_applied=false", r.manifest.curation_applied === false);
  check("프레임 4개 그대로", r.manifest.animation.rows.a.frames === 4);
}
{
  // 프레임 0 을 뺀 큐레이션 → 아틀라스가 3칸으로 좁아지고 첫 칸이 원래 1번이 된다.
  const r = composeAtlas({
    request: req({ a: S(4, 6, true) }),
    framesByState: { a: [frame(4096, 11), frame(4096, 22), frame(4096, 33), frame(4096, 44)] },
    curationByState: { a: { selected: [1, 2, 3] } },
  });
  check("curation_applied=true", r.manifest.curation_applied === true);
  check("프레임 수가 큐레이션을 따른다", r.manifest.animation.rows.a.frames === 3);
  check("columns 가 좁아진다", r.manifest.animation.columns === 3);
  check("아틀라스 폭도 좁아진다", r.atlas.width === 3 * 64, `${r.atlas.width}`);
  check("durations_ms 길이도 3", r.manifest.animation.rows.a.durations_ms.length === 3);
  check("rect 3개", r.manifest.frame_layout.rows.a.length === 3);
  const px = (x: number, y: number): number => r.atlas.data[(y * r.atlas.width + x) * 4];
  check("첫 칸이 원래 프레임 1", px(0, 0) === 22, `${px(0, 0)}`);
  check("둘째 칸이 원래 프레임 2", px(64, 0) === 33);
  check("셋째 칸이 원래 프레임 3", px(128, 0) === 44);
}
{
  // 재정렬도 그대로 구워진다 — selected 는 재생 순서다.
  const r = composeAtlas({
    request: req({ a: S(3, 6, true) }),
    framesByState: { a: [frame(4096, 11), frame(4096, 22), frame(4096, 33)] },
    curationByState: { a: { selected: [2, 0, 1] } },
  });
  const px = (x: number): number => r.atlas.data[x * 4];
  check("재생 순서대로 배치", px(0) === 33 && px(64) === 11 && px(128) === 22);
}
{
  // 빈 selected 는 기본값으로 떨어진다(정본 state_plan 과 같다).
  const r = composeAtlas({
    request: req({ a: S(2, 6, true) }),
    framesByState: { a: [frame(4096, 11), frame(4096, 22)] },
    curationByState: { a: { selected: [] } },
  });
  check("빈 selected 는 전체 순서", r.manifest.animation.rows.a.frames === 2);
  check("빈 selected 는 curation_applied=false", r.manifest.curation_applied === false);
}
{
  // 인덱스 공간이 바뀐(재추출된) 큐레이션은 던진다 — 다른 프레임을 조용히 굽지 않는다.
  let threw = "";
  try {
    composeAtlas({
      request: req({ a: S(2, 6, true) }),
      framesByState: { a: [frame(4096, 11), frame(4096, 22)] },
      curationByState: { a: { selected: [0, 5] } },
    });
  } catch (e) {
    threw = String(e);
  }
  check("범위 밖 인덱스는 fail-loud", threw.includes("curation"), threw);
}
{
  // 상태마다 큐레이션이 다를 수 있고, 하나만 있어도 applied 다.
  const r = composeAtlas({
    request: req({ a: S(3, 6, true), b: S(3, 6, true) }),
    framesByState: {
      a: [frame(4096, 11), frame(4096, 22), frame(4096, 33)],
      b: [frame(4096, 44), frame(4096, 55), frame(4096, 66)],
    },
    curationByState: { a: { selected: [0, 2] }, b: null },
  });
  check("상태별로 다른 프레임 수", r.manifest.animation.rows.a.frames === 2 && r.manifest.animation.rows.b.frames === 3);
  check("columns 는 최대치", r.manifest.animation.columns === 3);
  check("한 상태만 큐레이션돼도 applied", r.manifest.curation_applied === true);
  const px = (x: number, y: number): number => r.atlas.data[(y * r.atlas.width + x) * 4];
  check("a 의 둘째 칸은 원래 프레임 2", px(64, 0) === 33);
  check("a 행의 남는 칸은 투명", r.atlas.data[(0 * r.atlas.width + 128) * 4 + 3] === 0);
}

void (async () => {

  // ── 호흡 레이어 (정본 compose_atlas 의 breathe 굽기) ──────────────────
  //
  // 실제 프레임으로 본다 — 합성 블록은 해부가 성립하지 않아 계약을 못 잰다.
  {
    const src = "data/sprite-runs/sprite-1786909158013/frames-left_idle/frame-0.png";
    if (!existsSync(src)) {
      check("호흡 검증용 실제 프레임 없음", false, src);
    } else {
      const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const real = (): RawImage => ({ data: Buffer.from(data), width: info.width, height: info.height });
      const bigCell = normalizeCell({ size: info.width });
      const bigReq = (states: Record<string, StateSpec>): SpriteRequest => ({
        ...req(states),
        cell: bigCell,
      });
      const seq = [real(), real(), real(), real()];

      // 대조군: 호흡이 꺼진 행은 예전과 **바이트 동일**이어야 한다.
      const off = composeAtlas({
        request: bigReq({ a: S(4, 6, true) }),
        framesByState: { a: seq },
        curationByState: { a: { selected: [0, 1, 2, 3] } },
      });
      check("호흡이 꺼지면 매니페스트에 breathe 키가 없다", !("breathe" in off.manifest.animation.rows.a));

      const on = composeAtlas({
        request: bigReq({ a: S(4, 6, true) }),
        framesByState: { a: seq },
        curationByState: { a: { selected: [0, 1, 2, 3], breathe: { depth: 0.06, breaths: 1 } } },
      });
      check("호흡을 켜도 칸 수·크기는 그대로", on.atlas.width === off.atlas.width && on.atlas.height === off.atlas.height);
      check("호흡을 켜면 시트가 달라진다", !on.atlas.data.equals(off.atlas.data));

      const cellAt = (r: { atlas: RawImage }, col: number): Buffer => {
        const out = Buffer.alloc(bigCell.width * bigCell.height * 4);
        for (let y = 0; y < bigCell.height; y++) {
          const s0 = (y * r.atlas.width + col * bigCell.width) * 4;
          r.atlas.data.copy(out, y * bigCell.width * 4, s0, s0 + bigCell.width * 4);
        }
        return out;
      };
      // 같은 프레임 4장이지만 위상이 달라 칸마다 그림이 다르다.
      const cells = [0, 1, 2, 3].map(c => cellAt(on, c));
      const uniq = new Set(cells.map(c => c.toString("base64"))).size;
      check("위상이 다르면 칸도 다르다", uniq === 4, `유니크 ${uniq}/4`);
      // **위상 0 도 굽는다** — lag 때문에 t=0 도 항등이 아니다. 건너뛰면 이 칸만
      // 원본이 되어 매 루프 시작에서 튄다 (정본이 실측으로 못박은 지점).
      check("위상 0 칸도 원본과 다르다", !cells[0].equals(cellAt(off, 0)));

      // 굽기가 실제로 쓴 해부가 매니페스트에 남는다.
      const rep = on.manifest.animation.rows.a.breathe;
      check("해부 보고가 실린다", !!rep?.anatomy, JSON.stringify(rep));
      check("사이드카 캐시가 없으면 drift 없음", rep?.matches_sidecar === true && rep?.sidecar_drift === null);

      // 잘못된 설정은 조용히 꺼지지 않고 던진다.
      let threw = "";
      try {
        composeAtlas({
          request: bigReq({ a: S(4, 6, true) }),
          framesByState: { a: seq },
          curationByState: { a: { selected: [0, 1, 2, 3], breathe: { breaths: 12 } } },
        });
      } catch (e) { threw = String(e); }
      check("범위 밖 breaths 는 fail-loud", threw.includes("범위") && threw.includes("12"), threw);
    }
  }


  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
