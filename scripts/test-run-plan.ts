/**
 * ④a Task 2·3 — 플랜 실행기 테스트. 가짜 생성기를 주입해 codex 없이 검증한다.
 *
 * 확인 대상: stage 순서 · 액션 행에 base 금지 · 앵커 베이크 시점 · 미러 생략 ·
 * 실측 프레임 수 · 실패 전파.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpriteRequest } from "../src/lib/sprite/build-request";
import { runSpritePlan, type GenerateFn } from "../src/lib/sprite/run-plan";

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

/**
 * frames 개 덩어리가 놓인 마젠타 크로마 시트. 캔버스 치수는 자유롭게 준다 —
 * 추출이 raw 치수와 무관하다는 것이 이 테스트의 핵심이다.
 */
async function fakeSheet(dest: string, frames: number, w: number, h: number): Promise<void> {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = 255;
    raw[i * 4 + 1] = 0;
    raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = 255;
  }
  const slot = w / frames;
  for (let f = 0; f < frames; f++) {
    const x0 = Math.round(f * slot + slot * 0.25);
    const x1 = Math.round(f * slot + slot * 0.75);
    for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.85); y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        raw[o] = 200;
        raw[o + 1] = 100;
        raw[o + 2] = 50;
        raw[o + 3] = 255;
      }
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(dest);
}

void (async () => {
  const dir = await mkdtemp(join(tmpdir(), "runplan-"));
  try {
    const { request } = await buildSpriteRequest({
      characterId: "aurora",
      description: "small fox mage",
      baseImagePath: null,
      uiDirection: "DOWN",
      frames: 4,
      loop: true,
      actionPrompt: "walk cycle",
    });

    const basePath = join(dir, "base.png");
    await fakeSheet(basePath, 1, 512, 512);

    const calls: Array<{ state: string; role: string; inputPaths: string[] }> = [];
    const generate: GenerateFn = async spec => {
      calls.push({ state: spec.state, role: spec.role, inputPaths: [...spec.inputPaths] });
      const out = join(dir, `${spec.state}.png`);
      const frames = request.states[spec.state].frames;
      // 가이드(1024x256)와 다른 치수로 낸다 — codex 실측 동작과 같다.
      await fakeSheet(out, frames, 1774, 887);
      return { generationId: `gen_${spec.state}`, imagePath: out, width: 1774, height: 887 };
    };

    const result = await runSpritePlan(request, {
      generate,
      workDir: dir,
      lockedBasePath: basePath,
      log: () => {},
    });

    console.log("=== 생성 순서 ===");
    check("두 번 생성한다 (앵커 1 + 행 1)", calls.length === 2, `${calls.length}`);
    check("앵커가 먼저", calls[0].state === "down_idle" && calls[0].role === "direction-anchor");
    check("행이 나중", calls[1].state === "down_action" && calls[1].role === "action-row");

    console.log("=== ref 계약 ===");
    check("앵커 행에 base 가 붙는다", calls[0].inputPaths.includes(basePath));
    check("액션 행에 base 가 없다", !calls[1].inputPaths.includes(basePath));
    check(
      "액션 행에 앵커 파일이 붙는다",
      calls[1].inputPaths.some(p => p.includes("anchor")),
      calls[1].inputPaths.join(","),
    );
    check(
      "두 호출 다 레이아웃 가이드가 붙는다",
      calls.every(c => c.inputPaths.some(p => p.includes("guide"))),
    );
    check(
      "가이드가 마지막 (정본 ref 순서: 앵커 → 가이드)",
      calls[1].inputPaths[calls[1].inputPaths.length - 1].includes("guide"),
    );

    console.log("=== 결과 ===");
    check("행 두 개가 기록된다", Object.keys(result.rows).length === 2);
    check("프레임 수가 기록된다", result.rows.down_action.frameCount === 4);
    check("components 로 추출된다", result.rows.down_action.method === "components");
    check("프레임 파일이 4개", result.rows.down_action.framePaths.length === 4);
    check("앵커가 기록된다", result.anchors.down !== undefined);
    check("앵커 source 는 default", result.anchors.down.source === "default");
    check("앵커 index 는 0 (큐레이션 없음)", result.anchors.down.index === 0);
    check(
      "앵커 파일이 실재한다",
      (await sharp(result.anchors.down.path).metadata()).width !== undefined,
    );

    console.log("=== 추출이 raw 치수를 무관하게 만든다 ===");
    {
      // 가이드는 1024x256 인데 출력은 1774x887 이다. 그래도 프레임은 request 셀 규격으로
      // 나온다 — request.cell 은 추출의 **출력 규격**이지 입력 치수가 아니다.
      for (const p of result.rows.down_idle.framePaths) {
        const m = await sharp(p).metadata();
        check(
          `프레임이 셀 규격 ${request.cell.width}x${request.cell.height}`,
          m.width === request.cell.width && m.height === request.cell.height,
          `${m.width}x${m.height}`,
        );
        break;
      }
      const anchorMeta = await sharp(result.anchors.down.path).metadata();
      check(
        "앵커가 배경 조각이 아니다 (콘텐츠가 셀보다 작다)",
        (anchorMeta.width ?? 0) < request.cell.width * 8,
        `${anchorMeta.width}x${anchorMeta.height}`,
      );
    }

    console.log("=== 프레임 수를 못 맞추면 행 차단 ===");
    {
      let threw = "";
      let generated = 0;
      const one = join(dir, "one.png");
      await fakeSheet(one, 1, 800, 400);
      try {
        await runSpritePlan(request, {
          generate: async () => {
            generated++;
            return { generationId: "g", imagePath: one, width: 800, height: 400 };
          },
          workDir: dir,
          lockedBasePath: basePath,
          log: () => {},
        });
      } catch (e) {
        threw = String(e);
      }
      check(
        "컴포넌트가 부족하면 차단된다",
        threw.includes("could not extract 4 sprite components"),
        threw,
      );
      check("액션 행을 생성하지 않는다", generated === 1, `${generated}`);
    }

    console.log("=== 미러는 생성하지 않는다 ===");
    {
      const { request: mreq } = await buildSpriteRequest({
        characterId: "a",
        description: "d",
        baseImagePath: null,
        uiDirection: "RIGHT",
        frames: 4,
        loop: true,
        actionPrompt: "walk",
        mirrorFrom: "LEFT",
      });
      const mcalls: string[] = [];
      const r = await runSpritePlan(mreq, {
        generate: async spec => {
          mcalls.push(spec.state);
          const out = join(dir, `m-${spec.state}.png`);
          await fakeSheet(out, mreq.states[spec.state].frames, 1200, 600);
          return { generationId: `g_${spec.state}`, imagePath: out, width: 1, height: 1 };
        },
        workDir: dir,
        lockedBasePath: basePath,
        log: () => {},
      });
      check("left 는 생성하지 않는다", !mcalls.some(s => s.startsWith("left")), mcalls.join(","));
      check("미러가 계약으로 기록된다", r.skippedMirrors.some(m => m.direction === "left"));
    }

    console.log("=== 방향 계약 없는 런 (REF) ===");
    {
      const { request: freq } = await buildSpriteRequest({
        characterId: "a",
        description: "d",
        baseImagePath: null,
        uiDirection: "REF",
        frames: 4,
        loop: true,
        actionPrompt: "walk",
      });
      const fcalls: string[] = [];
      const r = await runSpritePlan(freq, {
        generate: async spec => {
          fcalls.push(spec.state);
          const out = join(dir, `f-${spec.state}.png`);
          await fakeSheet(out, freq.states[spec.state].frames, 1200, 600);
          return { generationId: `g_${spec.state}`, imagePath: out, width: 1, height: 1 };
        },
        workDir: dir,
        lockedBasePath: basePath,
        log: () => {},
      });
      check("단일 행만 생성", fcalls.length === 1 && fcalls[0] === "action", fcalls.join(","));
      check("앵커 없음", Object.keys(r.anchors).length === 0);
      check("행이 기록된다", r.rows.action !== undefined);
      check("REF 모드임이 경고로 남는다", r.warnings.some(w => w.includes("REF")));
    }

    console.log("=== 실패 전파 ===");
    {
      let threw = "";
      try {
        await runSpritePlan(request, {
          generate: async () => {
            throw new Error("codex 실패");
          },
          workDir: dir,
          lockedBasePath: basePath,
          log: () => {},
        });
      } catch (e) {
        threw = String(e);
      }
      check("생성 실패는 전파된다 (조용히 계속하지 않는다)", threw.includes("codex 실패"), threw);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
