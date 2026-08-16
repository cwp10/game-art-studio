import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { getDb } from "@/lib/db/client";
import { selectImageBackend } from "@/lib/image-backend";
import { stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";
import {
  ensurePrimaryTake,
  nextRerollLabel,
  pickTake,
  recordTake,
  assertSafeTakeLabel,
  RerollFailed,
  type RowTake,
} from "@/lib/sprite/reroll";
import { recomposeCuratedAtlas } from "@/lib/sprite/recompose";
import { ensureDataDirs, imagePath, resolveImagePath, toRelative } from "@/lib/util/paths";
import { newGenerationId } from "@/lib/util/ids";

export const runtime = "nodejs";

/**
 * 행 리롤 — 한 상태의 행을 **한 번 더 생성해 후보로 병기한다.**
 *
 * 정본 `reroll.py` 의 계약이 "교체가 아니라 후보 추가" 라는 점이 핵심이다. 기존 행은
 * 그대로 두고 새 테이크를 옆에 쌓으며, 어느 것을 쓸지는 사람이 고른다.
 *
 * - `POST`   `{ atlasGenerationId, state, label? }` → 새 후보를 생성해 목록에 넣는다.
 * - `PUT`    `{ atlasGenerationId, state, label }`  → 그 후보를 합성에 쓰고 재합성한다.
 * - `GET`    `?atlasGenerationId=…`                → 상태별 후보 목록.
 *
 * 후보는 `params.rowTakes[state]` 에 쌓이고, 지금 쓰는 것은 기존
 * `params.rowGenerationIds[state]` 그대로다 — 고르기는 그 포인터를 바꾸는 것뿐이라
 * 스키마가 늘지 않고 원래 행도 목록에 남아 언제든 되돌릴 수 있다.
 */

type Body = { atlasGenerationId?: string; state?: string; label?: string };

type AtlasParams = {
  rowGenerationIds?: Record<string, string>;
  rowTakes?: Record<string, RowTake[]>;
  states?: string[];
  request?: SpriteRequest;
  motionQa?: { qaDir?: string };
  anchors?: Record<string, { path?: string }>;
};

function loadAtlas(id: string): { atlas: ReturnType<typeof getGeneration>; params: AtlasParams } {
  const atlas = getGeneration(id);
  if (!atlas) throw new RerollFailed(`generation ${id} 없음`);
  const params = (atlas.params ?? {}) as AtlasParams;
  if (!params.rowGenerationIds || !params.request) {
    throw new RerollFailed(
      `${id} 는 플랜 구동 시트가 아닙니다 — 리롤은 행 generation 이 있는 시트에서만 됩니다`,
    );
  }
  return { atlas, params };
}

function saveParams(atlasId: string, params: AtlasParams): void {
  getDb().prepare("UPDATE generations SET params = ? WHERE id = ?").run(JSON.stringify(params), atlasId);
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("atlasGenerationId");
  if (!id) return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });
  try {
    const { params } = loadAtlas(id);
    const out: Record<string, { current: string; takes: RowTake[] }> = {};
    for (const [state, current] of Object.entries(params.rowGenerationIds ?? {})) {
      out[state] = { current, takes: params.rowTakes?.[state] ?? [] };
    }
    return Response.json({ ok: true, rows: out });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.atlasGenerationId || !body.state) {
    return Response.json({ error: "atlasGenerationId 와 state 가 필요합니다" }, { status: 400 });
  }
  try {
    const { atlas, params } = loadAtlas(body.atlasGenerationId);
    const state = body.state;
    const currentRowId = params.rowGenerationIds?.[state];
    if (!currentRowId) {
      return Response.json({ error: `상태 '${state}' 의 행이 없습니다` }, { status: 400 });
    }
    const currentRow = getGeneration(currentRowId);
    if (!currentRow?.prompt) {
      return Response.json(
        { error: `행 ${currentRowId} 에 프롬프트 기록이 없어 같은 행을 다시 만들 수 없습니다` },
        { status: 400 },
      );
    }

    // refs 는 정본 `identity_ref` 규칙을 따른다 — 방향 런의 행이면 그 방향 앵커를,
    // 없으면 base 를 붙이고, 거기에 레이아웃 가이드를 더한 두 장이다.
    const refs: string[] = [];
    const direction = stateDirection(state, params.request?.directions ?? null);
    const anchorPath = direction ? params.anchors?.[direction]?.path : undefined;
    if (anchorPath && existsSync(anchorPath)) {
      refs.push(anchorPath);
    } else {
      const baseId = (atlas!.input_image_ids ?? [])[0];
      const base = baseId ? getGeneration(baseId) : null;
      if (base?.image_path) {
        const p = resolveImagePath(base.image_path);
        if (existsSync(p)) refs.push(p);
      }
    }
    const qaDir = params.motionQa?.qaDir;
    if (qaDir) {
      const guide = join(dirname(qaDir), `guide-${state}.png`);
      if (existsSync(guide)) refs.push(guide);
    }
    if (refs.length === 0) {
      return Response.json(
        { error: "리롤 참조 이미지를 하나도 찾지 못했습니다 — base 도 가이드도 없습니다" },
        { status: 400 },
      );
    }

    const label = body.label ?? nextRerollLabel(params.rowTakes?.[state]);
    assertSafeTakeLabel(label);

    ensureDataDirs();
    const newId = newGenerationId();
    const outPath = imagePath(newId);
    const backend = await selectImageBackend();
    const res = await backend.execute(
      {
        id: newId,
        generationId: newId,
        kind: "spritesheet",
        prompt: currentRow.prompt,
        inputImagePaths: refs,
        // 행 프롬프트는 이미 완성된 사양이다 — 헤더만 붙이고 그대로 통과시킨다.
        params: { rawPrompt: true, state, planDriven: true, rerollOf: currentRowId },
      },
      () => {},
    );
    const meta = await sharp(res.imagePath).metadata();
    createGeneration({
      id: newId,
      session_id: atlas!.session_id,
      message_id: null,
      kind: "spritesheet",
      prompt: currentRow.prompt,
      input_image_ids: [],
      params: { rawPrompt: true, state, planDriven: true, rerollOf: currentRowId, curation: { selected: [] } },
      image_path: toRelative(outPath),
      width: meta.width ?? res.width,
      height: meta.height ?? res.height,
      backend: "codex_exec",
    });

    const frames = params.request?.states[state]?.frames ?? 0;
    // 현재 행을 먼저 등재한다 — 안 하면 첫 리롤 뒤 원래 행으로 돌아갈 길이 사라진다.
    const seeded = ensurePrimaryTake(params.rowTakes?.[state], currentRowId, frames);
    const takes = recordTake(seeded, { label, generationId: newId, frames });
    saveParams(body.atlasGenerationId, {
      ...params,
      rowTakes: { ...(params.rowTakes ?? {}), [state]: takes },
    });

    return Response.json({
      ok: true,
      state,
      label,
      generationId: newId,
      // 합성 대상은 **바꾸지 않는다** — 후보로만 쌓인다. 고르기는 PUT 이다.
      current: currentRowId,
      takes,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.atlasGenerationId || !body.state || !body.label) {
    return Response.json({ error: "atlasGenerationId·state·label 이 필요합니다" }, { status: 400 });
  }
  try {
    const { params } = loadAtlas(body.atlasGenerationId);
    const state = body.state;
    const take = pickTake(params.rowTakes?.[state], body.label);
    saveParams(body.atlasGenerationId, {
      ...params,
      rowGenerationIds: { ...(params.rowGenerationIds ?? {}), [state]: take.generationId },
    });
    // 포인터만 바꾸면 시트는 옛 그림 그대로다 — 정본 Output Contract 와 같은 이유로
    // 여기서 반드시 다시 굽는다.
    const recomposed = await recomposeCuratedAtlas(body.atlasGenerationId);
    return Response.json({ ok: true, state, picked: take, recomposed });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
