import { NextRequest } from "next/server";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { selectImageBackend } from "@/lib/image-backend";
import { removeChromaBackground } from "@/lib/sprite/chroma-clean";
import { removeChromaBackgroundYcbcr } from "@/lib/sprite/chroma-ycbcr";
import { decideChromaMode } from "@/lib/sprite/chroma-mode";
import { interpolateBetween, type RgbImage } from "@/lib/sprite/interpolate";
import type { SpriteRequest } from "@/lib/sprite/request";
import { ensureDataDirs, imagePath, resolveImagePath, toRelative } from "@/lib/util/paths";
import { newGenerationId } from "@/lib/util/ids";

export const runtime = "nodejs";

/**
 * 프레임 보간 — 두 프레임 **사이**의 중간 포즈를 생성해 새 후보로 남긴다.
 *
 * 정본 `interpolate.py` 의 계약: 산출물은 최종 프레임이 아니라 **raw 단계 생성물**이고,
 * 논리 프레임은 언제나 기존 결정론 추출이 굽는다. 생성을 감싸는 두 결정론 단계가 본체다 —
 * 참조 쌍 정합(정적 몸 픽셀을 같은 자리에 두어 모델이 "움직인 부위만 다른 두 장" 으로
 * 읽게 한다)과 결과 스케일 정규화(생성형은 피사체를 다른 크기로 그린다).
 *
 * body: `{ atlasGenerationId, state, indexA, indexB, t? }`
 *
 * 결과는 **행에 자동으로 끼워 넣지 않는다.** 중간 프레임 한 장을 generation 으로 남기고
 * 그 id 를 돌려준다 — 어디에 쓸지는 사람이 정한다(정본도 테이크로 병기하고 픽/기각은
 * 사람 몫이다).
 */

type Body = {
  atlasGenerationId?: string;
  state?: string;
  indexA?: number;
  indexB?: number;
  t?: number;
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const { atlasGenerationId, state } = body;
  if (!atlasGenerationId || !state || body.indexA === undefined || body.indexB === undefined) {
    return Response.json(
      { error: "atlasGenerationId·state·indexA·indexB 가 필요합니다" },
      { status: 400 },
    );
  }
  const workdir = await mkdtemp(join(tmpdir(), "tween-"));
  try {
    const atlas = getGeneration(atlasGenerationId);
    if (!atlas) return Response.json({ error: `generation ${atlasGenerationId} 없음` }, { status: 404 });
    const params = (atlas.params ?? {}) as {
      request?: SpriteRequest;
      rowGenerationIds?: Record<string, string>;
    };
    const request = params.request;
    const rowId = params.rowGenerationIds?.[state];
    if (!request || !rowId) {
      return Response.json(
        { error: `${atlasGenerationId} 는 플랜 구동 시트가 아니거나 상태 '${state}' 의 행이 없습니다` },
        { status: 400 },
      );
    }
    const rowGen = getGeneration(rowId);
    if (!rowGen?.image_path) {
      return Response.json({ error: `행 generation ${rowId} 의 이미지가 없습니다` }, { status: 400 });
    }

    // 스트립의 크로마를 지운 뒤 넘긴다 — 정합·분리가 알파 위에서 돈다.
    // 경로는 이미지를 재서 정한다(`auto`), 저장된 단일 값을 믿지 않는다.
    const { data, info } = await sharp(resolveImagePath(rowGen.image_path))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const chromaRgb = request.chromaKey.rgb;
    const decision = decideChromaMode(data, info.width, info.height, chromaRgb, request.chroma.keyThreshold);
    if (decision.mode === "ycbcr") {
      removeChromaBackgroundYcbcr(data, info.width, info.height, chromaRgb, []);
    } else {
      removeChromaBackground(data, info.width, info.height, chromaRgb, {
        keyThreshold: request.chroma.keyThreshold,
        unmixReach: request.chroma.unmixReach,
        spillMaxFraction: request.chroma.spillMaxFraction,
      });
    }

    const backend = await selectImageBackend();
    const result = await interpolateBetween({
      strip: { data: Buffer.from(data), width: info.width, height: info.height },
      frameCount: request.states[state]?.frames ?? 0,
      indexA: body.indexA,
      indexB: body.indexB,
      chromaRgb,
      chromaName: request.chromaKey.name,
      chromaHex: request.chromaKey.hex,
      characterDescription: request.character.description,
      t: body.t ?? 0.5,
      interpolator: async (a: RgbImage, b: RgbImage, _t, prompt): Promise<RgbImage> => {
        const refA = join(workdir, "ref-a.png");
        const refB = join(workdir, "ref-b.png");
        await sharp(Buffer.from(a.data), { raw: { width: a.width, height: a.height, channels: 3 } })
          .png().toFile(refA);
        await sharp(Buffer.from(b.data), { raw: { width: b.width, height: b.height, channels: 3 } })
          .png().toFile(refB);
        const tmpId = `tween_${Date.now().toString(36)}`;
        const res = await backend.execute(
          {
            id: tmpId,
            generationId: tmpId,
            kind: "img2img",
            // 보간 프롬프트는 이미 완성된 사양이다 — 헤더만 붙이고 그대로 통과시킨다.
            prompt,
            inputImagePaths: [refA, refB],
            params: { rawPrompt: true },
          },
          () => {},
        );
        const g = await sharp(res.imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        await rm(res.imagePath, { force: true });
        return { data: new Uint8Array(g.data), width: g.info.width, height: g.info.height };
      },
    });

    ensureDataDirs();
    const genId = newGenerationId();
    const outPath = imagePath(genId);
    await sharp(Buffer.from(result.mid.data), {
      raw: { width: result.mid.width, height: result.mid.height, channels: 3 },
    }).png().toFile(outPath);
    createGeneration({
      id: genId,
      session_id: atlas.session_id,
      message_id: null,
      kind: "img2img",
      prompt: result.prompt,
      input_image_ids: [rowId],
      params: {
        tween: {
          atlasGenerationId,
          state,
          indexA: body.indexA,
          indexB: body.indexB,
          t: body.t ?? 0.5,
          label: result.label,
          chromaMode: decision.mode,
        },
      },
      image_path: toRelative(outPath),
      width: result.mid.width,
      height: result.mid.height,
      backend: "codex_exec",
    });

    // 시트에 자동으로 끼우지 않는다 — 어디에 쓸지는 사람이 정한다.
    return Response.json({
      ok: true,
      generationId: genId,
      label: result.label,
      state,
      width: result.mid.width,
      height: result.mid.height,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
