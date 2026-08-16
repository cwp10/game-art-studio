/**
 * ③ Task 4·5 — 앵커 해석과 베이크 테스트.
 *
 * 핵심 단언: 큐레이션 시퀀스 헤드는 **index 0 이 아니다**. 앞 프레임을 제외/재정렬하면
 * 앵커가 따라 움직여야 한다 (sprite-gen 2026-07-19 실사고).
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnchorUnavailable,
  curatedSequence,
  resolveAnchor,
  type AnchorContext,
} from "../src/lib/sprite/anchor";
import { bakeAnchorImage, contentBBox } from "../src/lib/sprite/anchor-image";
import { normalizeDirections } from "../src/lib/sprite/directions";
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
function kindOf(fn: () => unknown): string {
  try {
    fn();
    return "(no throw)";
  } catch (e) {
    return e instanceof AnchorUnavailable ? e.kind : `(${String(e)})`;
  }
}

const S = (frames = 4): StateSpec => ({ frames, fps: 4, loop: true, action: "a" });

function ctx(
  opts: {
    rows?: AnchorContext["rows"];
    picks?: AnchorContext["picks"];
    states?: Record<string, StateSpec>;
  } = {},
): AnchorContext {
  const states = opts.states ?? { down_idle: S(4), down_walk: S(8) };
  const directions = normalizeDirections({ set: ["down"], mirror: { left: "down" } }, states)!;
  const request: SpriteRequest = {
    version: 1,
    character: { id: "a", description: "d", anchorGenerationId: "gen_base" },
    cell: normalizeCell({}),
    chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
    chroma: DEFAULT_CHROMA_TUNABLES,
    states,
    directions,
  };
  return { request, picks: opts.picks ?? {}, rows: opts.rows ?? {} };
}

void (async () => {
  console.log("=== curatedSequence ===");
  check("큐레이션 없으면 0..n-1", curatedSequence(4, null).join(",") === "0,1,2,3");
  check(
    "제외를 뺀다",
    curatedSequence(4, { order: [0, 1, 2, 3], excluded: [0, 1] }).join(",") === "2,3",
  );
  check(
    "재정렬을 따른다",
    curatedSequence(4, { order: [3, 2, 1, 0], excluded: [] }).join(",") === "3,2,1,0",
  );
  check(
    "재정렬 + 제외",
    curatedSequence(4, { order: [3, 2, 1, 0], excluded: [3] }).join(",") === "2,1,0",
  );
  check(
    "order 길이가 안 맞으면 무시하고 원본 순서",
    curatedSequence(4, { order: [1, 0], excluded: [] }).join(",") === "0,1,2,3",
  );
  check("전부 제외면 빈 배열", curatedSequence(2, { order: [0, 1], excluded: [0, 1] }).length === 0);

  console.log("=== resolveAnchor — 기본 경로 (큐레이션 시퀀스 헤드) ===");
  {
    const c = ctx({ rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } } });
    const a = resolveAnchor(c, "down");
    check(
      "큐레이션 없으면 index 0",
      a.index === 0 && a.state === "down_idle" && a.source === "default",
    );
  }
  {
    // 실사고 재현: 0·1·2 를 제외했으면 앵커는 3 이다.
    const c = ctx({
      rows: {
        down_idle: {
          generationId: "g1",
          frameCount: 4,
          curation: { order: [0, 1, 2, 3], excluded: [0, 1, 2] },
        },
      },
    });
    check(
      "앞 프레임을 제외하면 앵커가 따라 움직인다 (index 0 아님)",
      resolveAnchor(c, "down").index === 3,
    );
  }
  {
    const c = ctx({
      rows: {
        down_idle: {
          generationId: "g1",
          frameCount: 4,
          curation: { order: [2, 0, 1, 3], excluded: [] },
        },
      },
    });
    check("재정렬하면 시퀀스 헤드가 앵커", resolveAnchor(c, "down").index === 2);
  }

  console.log("=== resolveAnchor — pending (오류색 금지) ===");
  {
    const c = ctx({ rows: {} });
    check(
      "앵커 행 미생성은 row-not-generated",
      kindOf(() => resolveAnchor(c, "down")) === "row-not-generated",
    );
    try {
      resolveAnchor(c, "down");
    } catch (e) {
      check("row-not-generated 는 pending", e instanceof AnchorUnavailable && e.pending === true);
    }
  }
  {
    const c = ctx({ states: { down_walk: S(8) }, rows: {} });
    check(
      "앵커 상태 자체가 없으면 no-anchor-row",
      kindOf(() => resolveAnchor(c, "down")) === "no-anchor-row",
    );
    try {
      resolveAnchor(c, "down");
    } catch (e) {
      check("no-anchor-row 도 pending", e instanceof AnchorUnavailable && e.pending === true);
    }
  }

  console.log("=== resolveAnchor — broken ===");
  {
    const c = ctx({ rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } } });
    check("생성 목록에 없는 방향", kindOf(() => resolveAnchor(c, "up")) === "unknown-direction");
    try {
      resolveAnchor(c, "up");
    } catch (e) {
      check("unknown-direction 은 broken", e instanceof AnchorUnavailable && e.pending === false);
    }
  }
  {
    const c = ctx({
      rows: {
        down_idle: {
          generationId: "g1",
          frameCount: 2,
          curation: { order: [0, 1], excluded: [0, 1] },
        },
      },
    });
    check("전부 제외하면 empty-sequence", kindOf(() => resolveAnchor(c, "down")) === "empty-sequence");
  }

  console.log("=== resolveAnchor — 지정(pin) ===");
  {
    const c = ctx({
      rows: {
        down_idle: { generationId: "g1", frameCount: 4, curation: null },
        down_walk: { generationId: "g2", frameCount: 8, curation: null },
      },
      picks: { down: { generationId: "g2", index: 5 } },
    });
    const a = resolveAnchor(c, "down");
    check("지정이 기본값을 이긴다", a.source === "picked" && a.state === "down_walk" && a.index === 5);
  }
  {
    const c = ctx({
      rows: {
        down_idle: {
          generationId: "g1",
          frameCount: 4,
          curation: { order: [0, 1, 2, 3], excluded: [1] },
        },
      },
      picks: { down: { generationId: "g1", index: 1 } },
    });
    check("제외된 프레임 지정은 pick-missing", kindOf(() => resolveAnchor(c, "down")) === "pick-missing");
  }
  {
    const c = ctx({
      rows: { down_idle: { generationId: "g1", frameCount: 4, curation: null } },
      picks: { down: { generationId: "gone", index: 0 } },
    });
    check(
      "사라진 generation 지정은 pick-unknown-generation",
      kindOf(() => resolveAnchor(c, "down")) === "pick-unknown-generation",
    );
    check(
      "조용한 폴백이 아니다 (기본값으로 돌아가지 않는다)",
      kindOf(() => resolveAnchor(c, "down")) !== "(no throw)",
    );
  }
  {
    const states = { down_idle: S(4), down_walk: S(8), right_idle: S(4) };
    const directions = normalizeDirections({ set: ["down", "right"], mirror: {} }, states)!;
    const c: AnchorContext = {
      request: {
        version: 1,
        character: { id: "a", description: "d", anchorGenerationId: "gb" },
        cell: normalizeCell({}),
        chroma: DEFAULT_CHROMA_TUNABLES,
        chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
        states,
        directions,
      },
      picks: { down: { generationId: "gr", index: 0 } },
      rows: {
        down_idle: { generationId: "g1", frameCount: 4, curation: null },
        right_idle: { generationId: "gr", frameCount: 4, curation: null },
      },
    };
    check(
      "다른 방향 프레임 지정은 pick-wrong-direction",
      kindOf(() => resolveAnchor(c, "down")) === "pick-wrong-direction",
    );
  }

  console.log("=== contentBBox ===");
  {
    const w = 32;
    const h = 32;
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 12; y < 20; y++) {
      for (let x = 10; x < 18; x++) {
        const o = (y * w + x) * 4;
        raw[o] = 200;
        raw[o + 1] = 100;
        raw[o + 2] = 50;
        raw[o + 3] = 255;
      }
    }
    const box = contentBBox(raw, w, h, 4)!;
    check(
      "bbox 가 콘텐츠를 정확히 감싼다",
      box.x0 === 10 && box.y0 === 12 && box.x1 === 17 && box.y1 === 19,
      JSON.stringify(box),
    );
  }
  {
    // 알파 39 는 콘텐츠가 아니다 (프린지). 40 부터 콘텐츠.
    const w = 8;
    const h = 8;
    const raw = Buffer.alloc(w * h * 4);
    raw[(1 * w + 1) * 4 + 3] = 39;
    raw[(4 * w + 4) * 4 + 3] = 40;
    const box = contentBBox(raw, w, h, 4)!;
    check(
      "알파 39 는 제외, 40 은 포함",
      box.x0 === 4 && box.y0 === 4 && box.x1 === 4 && box.y1 === 4,
      JSON.stringify(box),
    );
  }
  check("전부 투명이면 null", contentBBox(Buffer.alloc(4 * 4 * 4), 4, 4, 4) === null);

  console.log("=== bakeAnchorImage ===");
  {
    const dir = await mkdtemp(join(tmpdir(), "anchor-"));
    try {
      // 4셀 가로 시트(각 32x32). 셀 2 에만 8x8 콘텐츠를 둔다.
      const cols = 4;
      const cw = 32;
      const ch = 32;
      const raw = Buffer.alloc(cols * cw * ch * 4);
      for (let y = 12; y < 20; y++) {
        for (let x = 2 * cw + 10; x < 2 * cw + 18; x++) {
          const o = (y * cols * cw + x) * 4;
          raw[o] = 200;
          raw[o + 1] = 100;
          raw[o + 2] = 50;
          raw[o + 3] = 255;
        }
      }
      const sheet = join(dir, "row.png");
      await sharp(raw, { raw: { width: cols * cw, height: ch, channels: 4 } })
        .png()
        .toFile(sheet);

      const dest = join(dir, "anchor.png");
      const r = await bakeAnchorImage({
        sheetPath: sheet,
        cell: normalizeCell({ size: 32 }),
        cols,
        index: 2,
        destPath: dest,
      });
      check(
        "콘텐츠 크기 8x8",
        r.contentSize[0] === 8 && r.contentSize[1] === 8,
        JSON.stringify(r.contentSize),
      );
      check("×8 확대 = 64x64", r.width === 64 && r.height === 64);
      const meta = await sharp(dest).metadata();
      check("파일 치수가 일치", meta.width === 64 && meta.height === 64);

      // NEAREST 검증: 확대 결과에 원본에 없던 중간색이 없어야 한다.
      const out = await sharp(dest).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let interpolated = 0;
      for (let i = 0; i < out.info.width * out.info.height; i++) {
        const o = i * out.info.channels;
        const opaque = out.data[o + 3] === 255;
        const exact = out.data[o] === 200 && out.data[o + 1] === 100 && out.data[o + 2] === 50;
        if (opaque && !exact) interpolated++;
      }
      check("NEAREST — 보간된 중간색이 없다", interpolated === 0, `${interpolated} px`);

      let threw = false;
      try {
        await bakeAnchorImage({
          sheetPath: sheet,
          cell: normalizeCell({ size: 32 }),
          cols,
          index: 0,
          destPath: join(dir, "x.png"),
        });
      } catch {
        threw = true;
      }
      check("빈 셀은 empty-content 로 실패한다 (조용히 빈 이미지를 내지 않는다)", threw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("=== DB — 큐레이션과 지정 ===");
  {
    const {
      clearAnchorPick,
      createGeneration,
      deleteGeneration,
      getAnchorPicks,
      getCuration,
      lockBaseGeneration,
      pinAnchorFrame,
      saveCuration,
    } = await import("../src/lib/db/repo/generations");
    const { newGenerationId } = await import("../src/lib/util/ids");

    const rowId = newGenerationId();
    createGeneration({
      id: rowId,
      session_id: null,
      message_id: null,
      kind: "spritesheet",
      prompt: "down_idle row",
      image_path: "data/images/anchor-row.png",
      params: { source: "test" },
    });

    check("저장 전에는 큐레이션 없음", getCuration(rowId) === null);
    saveCuration(rowId, { order: [2, 0, 1, 3], excluded: [0] });
    const c = getCuration(rowId);
    check("큐레이션 왕복", c?.order.join(",") === "2,0,1,3" && c?.excluded.join(",") === "0");
    const { getGeneration } = await import("../src/lib/db/repo/generations");
    check(
      "큐레이션 저장이 기존 params 를 보존한다",
      getGeneration(rowId)?.params?.source === "test",
      JSON.stringify(getGeneration(rowId)?.params),
    );
    check(
      "저장된 큐레이션으로 시퀀스 헤드가 2 가 된다",
      curatedSequence(4, c)[0] === 2,
      JSON.stringify(curatedSequence(4, c)),
    );

    let threw = false;
    try {
      pinAnchorFrame(null, "down", { generationId: rowId, index: 1 });
    } catch {
      threw = true;
    }
    check("잠긴 base 없이 pin 하면 throw", threw);

    const baseId = newGenerationId();
    createGeneration({
      id: baseId,
      session_id: null,
      message_id: null,
      kind: "text2img",
      prompt: "base",
      image_path: "data/images/base.png",
    });
    lockBaseGeneration(baseId, null);

    check("지정 전에는 빈 객체", Object.keys(getAnchorPicks(null)).length === 0);
    pinAnchorFrame(null, "down", { generationId: rowId, index: 1 });
    pinAnchorFrame(null, "right", { generationId: rowId, index: 3 });
    const picks = getAnchorPicks(null);
    check(
      "지정 왕복",
      picks.down?.generationId === rowId && picks.down?.index === 1 && picks.right?.index === 3,
      JSON.stringify(picks),
    );

    clearAnchorPick(null, "down");
    const after = getAnchorPicks(null);
    check("clear 는 그 방향만 지운다", after.down === undefined && after.right?.index === 3);

    deleteGeneration(rowId);
    deleteGeneration(baseId);
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
