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
  console.log("=== curatedSequence — selected 가 권위 필드 ===");
  check("큐레이션 없으면 0..n-1", curatedSequence(4, null).join(",") === "0,1,2,3");
  check("선택을 그대로 따른다", curatedSequence(4, { selected: [2, 3] }).join(",") === "2,3");
  check("순서도 selected 가 표현한다", curatedSequence(4, { selected: [3, 2, 1, 0] }).join(",") === "3,2,1,0");
  check(
    "빈 selected 는 전체 프레임 (정본: absent/empty → all frames in order)",
    curatedSequence(4, { selected: [] }).join(",") === "0,1,2,3",
  );
  check(
    "order 는 표시 전용 — 해석이 무시한다",
    curatedSequence(4, { selected: [1, 0], order: [3, 2, 1, 0] }).join(",") === "1,0",
  );
  check(
    "프레임 공간이 바뀐 큐레이션은 fail-loud (조용히 필터링하지 않는다)",
    kindOf(() => curatedSequence(4, { selected: [0, 1, 7] })) === "curation-stale",
  );
  check(
    "curation-stale 은 broken",
    (() => {
      try {
        curatedSequence(4, { selected: [9] });
        return false;
      } catch (e) {
        return e instanceof AnchorUnavailable && e.pending === false;
      }
    })(),
  );

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
          curation: { selected: [3] },
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
          curation: { selected: [2, 0, 1, 3] },
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
    // 빈 selected 는 "전체 프레임"을 뜻하므로(정본) 빈 시퀀스를 만들지 못한다.
    // empty-sequence 는 행이 프레임 0개로 추출된 경우다.
    const c = ctx({
      rows: { down_idle: { generationId: "g1", frameCount: 0, curation: null } },
    });
    check(
      "프레임 0개로 추출된 행은 empty-sequence",
      kindOf(() => resolveAnchor(c, "down")) === "empty-sequence",
    );
  }
  {
    const c = ctx({
      rows: {
        down_idle: { generationId: "g1", frameCount: 2, curation: { selected: [] } },
      },
    });
    check(
      "빈 selected 는 전체 프레임이므로 앵커는 0",
      resolveAnchor(c, "down").index === 0,
    );
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
          curation: { selected: [0, 2, 3] },
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
      // 입력은 추출된 프레임이다 — 셀 크기, 알파 있음.
      const cell = 32;
      const raw = Buffer.alloc(cell * cell * 4);
      for (let y = 12; y < 20; y++) {
        for (let x = 10; x < 18; x++) {
          const o = (y * cell + x) * 4;
          raw[o] = 200;
          raw[o + 1] = 100;
          raw[o + 2] = 50;
          raw[o + 3] = 255;
        }
      }
      const frame = join(dir, "frame-0.png");
      await sharp(raw, { raw: { width: cell, height: cell, channels: 4 } })
        .png()
        .toFile(frame);

      const dest = join(dir, "anchor.png");
      const r = await bakeAnchorImage({ framePath: frame, destPath: dest });
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

      const empty = join(dir, "empty.png");
      await sharp({
        create: { width: cell, height: cell, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toFile(empty);
      let threw = "";
      try {
        await bakeAnchorImage({ framePath: empty, destPath: join(dir, "x.png") });
      } catch (e) {
        threw = e instanceof AnchorUnavailable ? e.kind : String(e);
      }
      check("빈 프레임은 empty-content 로 실패한다", threw === "empty-content", threw);
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
    saveCuration(rowId, { selected: [2, 1, 3], order: [2, 0, 1, 3] });
    const c = getCuration(rowId);
    check("큐레이션 왕복", c?.selected.join(",") === "2,1,3" && c?.order?.join(",") === "2,0,1,3");
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

    // 이 검사는 "스코프에 잠긴 base 가 없다"를 전제한다. 개발 DB 를 공유하므로 그
    // 전제를 스스로 만들어야 한다 — 예전에는 test-base-gate 가 잠금을 걷어낸 덕에
    // 우연히 성립했고(테스트 실행 순서 의존), 그 테스트가 잠금을 되돌리자 깨졌다.
    const { getLockedBase, unlockBaseScope } = await import("../src/lib/db/repo/generations");
    const priorBase = getLockedBase(null)?.id ?? null;
    unlockBaseScope(null);
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
    // 더미 base 를 잠그면서 걷어낸 실제 잠금을 되돌린다. 더미 행을 지우는 것만으로는
    // 사람이 게이트에서 잠근 base 가 돌아오지 않는다 — 그러면 다음 생성이 조용히
    // "base 자동 잠금 (게이트 미검토)" 로 빠진다.
    if (priorBase) lockBaseGeneration(priorBase, null);
    check(
      "테스트 전 잠겨 있던 base 를 되돌렸다",
      (getLockedBase(null)?.id ?? null) === priorBase,
      `prior=${priorBase} now=${getLockedBase(null)?.id ?? "null"}`,
    );
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
