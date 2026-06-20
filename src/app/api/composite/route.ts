import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";
import { runComposite } from "@/lib/image-backend/composite-runner";

export const runtime = "nodejs";

/**
 * POST /api/composite — 씬 프리뷰어. N 개 generation 레이어를 단일 PNG 로 합성해 generation 행으로 저장.
 *
 * Request:
 *   { layers: [{ generationId: string, opacity: number }], sessionId?: string,
 *     outputWidth?: number, outputHeight?: number }
 *   - layers 는 입력 순서대로 합성(배열[0]=최하단). opacity 0~100.
 *   - outputWidth/outputHeight 미지정 시 첫 레이어 이미지의 실제 크기로 폴백.
 *
 * Response:
 *   { generationId: string, imagePath: string, width: number, height: number }
 */

type CompositeLayerInput = {
  generationId?: string;
  opacity?: number;
  x?: number;
  y?: number;
  scale?: number;
};
type CompositeBody = {
  layers?: CompositeLayerInput[];
  sessionId?: string;
  outputWidth?: number;
  outputHeight?: number;
};

export async function POST(req: NextRequest) {
  let body: CompositeBody;
  try {
    body = (await req.json()) as CompositeBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!Array.isArray(body.layers) || body.layers.length === 0) {
    return Response.json({ error: "layers must be a non-empty array" }, { status: 400 });
  }

  // 라우트에 입력 검증(400/404 구분)을 유지 — 관찰 가능한 HTTP 계약.
  // 핵심 실행은 runComposite 에 위임해 MCP 도구와 동일 계약을 공유한다.
  for (const [i, l] of body.layers.entries()) {
    if (!l.generationId) {
      return Response.json({ error: `layers[${i}].generationId required` }, { status: 400 });
    }
    if (!getGeneration(l.generationId)) {
      return Response.json({ error: `generation not found: ${l.generationId}` }, { status: 404 });
    }
  }

  const result = await runComposite({
    layers: body.layers.map((l) => ({
      generationId: l.generationId as string,
      opacity: l.opacity,
      x: l.x,
      y: l.y,
      scale: l.scale,
    })),
    sessionId: body.sessionId,
    outputWidth: body.outputWidth,
    outputHeight: body.outputHeight,
  });

  return Response.json(result);
}
