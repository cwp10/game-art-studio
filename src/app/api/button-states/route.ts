import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import {
  generateButtonState,
  type ButtonState,
  type ButtonStateParams,
} from "@/lib/image-backend/button-states";
import { newGenerationId } from "@/lib/util/ids";
import {
  ensureDataDirs,
  imagePath as imagePathFor,
  resolveImagePath,
  toRelative,
} from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/button-states — 원본 이미지에서 normal/hover/pressed 3종 버튼 상태
 * 스프라이트를 생성한다. 각각 별도 generation(kind='button_state')으로 저장한다.
 * 결정적 sharp 연산만 사용(codex 호출 없음).
 *
 * 세 작업은 순차 처리한다(Promise.all 아님) — sharp 메모리 부담 고려.
 *
 * Request:
 *   { generationId: string, sessionId?: string|null,
 *     hoverBrightness?, hoverSaturation?, pressedBrightness?, pressedSaturation?, pressedScale? }
 * Response:
 *   { normal:  { generationId, imagePath, width, height },
 *     hover:   { generationId, imagePath, width, height },
 *     pressed: { generationId, imagePath, width, height } }
 */

type Body = {
  generationId?: string;
  sessionId?: string | null;
  hoverBrightness?: number;
  hoverSaturation?: number;
  pressedBrightness?: number;
  pressedSaturation?: number;
  pressedScale?: number;
};

type StateResult = {
  generationId: string;
  imagePath: string;
  width: number;
  height: number;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.generationId) {
    return Response.json({ error: "generationId required" }, { status: 400 });
  }

  const gen = getGeneration(body.generationId);
  if (!gen) {
    return Response.json({ error: `generation not found: ${body.generationId}` }, { status: 400 });
  }

  const srcPath = resolveImagePath(gen.image_path);
  try {
    await fs.access(srcPath);
  } catch {
    return Response.json({ error: `source image file not found: ${gen.image_path}` }, { status: 400 });
  }

  const params: ButtonStateParams = {
    hoverBrightness: body.hoverBrightness,
    hoverSaturation: body.hoverSaturation,
    pressedBrightness: body.pressedBrightness,
    pressedSaturation: body.pressedSaturation,
    pressedScale: body.pressedScale,
  };

  ensureDataDirs();

  // 출력은 모두 원본 크기 — 실제 파일 메타데이터에서 읽는다(DB 값이 비어있을 수 있음).
  const srcMeta = await sharp(srcPath).metadata();
  const width = srcMeta.width ?? gen.width ?? 0;
  const height = srcMeta.height ?? gen.height ?? 0;

  // 세 상태를 순차 처리한다(Promise.all 아님) — sharp 메모리 부담 고려.
  const states: ButtonState[] = ["normal", "hover", "pressed"];
  const results: Partial<Record<ButtonState, StateResult>> = {};

  for (const state of states) {
    let buf: Buffer;
    try {
      buf = await generateButtonState(srcPath, state, params);
    } catch (e) {
      const msg = (e as Error).message;
      // 파라미터 범위 초과는 입력 오류(400).
      if (msg.includes("out of range")) {
        return Response.json({ error: msg }, { status: 400 });
      }
      return Response.json({ error: `button-states failed (${state}): ${msg}` }, { status: 500 });
    }

    const newId = newGenerationId();
    const outPath = imagePathFor(newId);
    await fs.writeFile(outPath, buf);

    createGeneration({
      id: newId,
      session_id: body.sessionId ?? null,
      message_id: null,
      kind: "button_state",
      backend: "direct",
      prompt: `버튼 상태: ${state}`,
      input_image_ids: [body.generationId],
      params: {
        state,
        hoverBrightness: params.hoverBrightness,
        hoverSaturation: params.hoverSaturation,
        pressedBrightness: params.pressedBrightness,
        pressedSaturation: params.pressedSaturation,
        pressedScale: params.pressedScale,
        sourceId: body.generationId,
      },
      image_path: toRelative(outPath),
      width,
      height,
    });

    results[state] = {
      generationId: newId,
      imagePath: `/api/images/${newId}`,
      width,
      height,
    };
  }

  return Response.json({
    normal: results.normal,
    hover: results.hover,
    pressed: results.pressed,
  });
}
