import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";
import { runComposite } from "@/lib/image-backend/composite-runner";

export const runtime = "nodejs";

/**
 * POST /api/composite — 씬 프리뷰어. N 개 generation 레이어를 단일 PNG 로 합성해 generation 행으로 저장.
 *
 * Request:
 *   { layers: [{ generationId, opacity?, x?, y?, scale?, rotation?, flipH?, stretchW?, stretchH?,
 *                filters?: { brightness?, saturation?, hue?, contrast?, blur? } }],
 *     sessionId?: string, outputWidth?: number, outputHeight?: number }
 *   - layers 는 입력 순서대로 합성(배열[0]=최하단). opacity 0~100.
 *   - 레이어 변형은 resize/stretch → rotate → flipH → filters 순으로 굽고 opacity·x/y 로 배치한다.
 *     신규 필드(rotation/flipH/stretchW/stretchH/filters)는 전부 옵셔널, 미지정/중립이면 기존 동작.
 *   - outputWidth/outputHeight 미지정 시 첫 레이어 이미지의 실제 크기로 폴백.
 *
 * Response:
 *   { generationId: string, imagePath: string, width: number, height: number }
 */

type CompositeLayerFilters = {
  brightness?: number;
  saturation?: number;
  hue?: number;
  contrast?: number;
  blur?: number;
};
type CompositeLayerInput = {
  generationId?: string;
  opacity?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  flipH?: boolean;
  stretchW?: number;
  stretchH?: number;
  filters?: CompositeLayerFilters;
  targetW?: number;
  targetH?: number;
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
  console.log("[composite] body layers:", JSON.stringify(body.layers?.map(l => ({
    id: l.generationId, x: l.x, y: l.y, targetW: l.targetW, targetH: l.targetH,
    scale: l.scale, outW: body.outputWidth, outH: body.outputHeight,
  }))));
  if (!Array.isArray(body.layers) || body.layers.length === 0) {
    return Response.json({ error: "layers must be a non-empty array" }, { status: 400 });
  }

  // 라우트에 입력 검증(400/404 구분)을 유지 — 관찰 가능한 HTTP 계약.
  // 핵심 실행은 runComposite 에 위임해 MCP 도구와 동일 계약을 공유한다.
  try {
    for (const [i, l] of body.layers.entries()) {
      if (!l.generationId) {
        return Response.json({ error: `layers[${i}].generationId required` }, { status: 400 });
      }
      if (!getGeneration(l.generationId)) {
        return Response.json({ error: `generation not found: ${l.generationId}` }, { status: 404 });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[composite] validation error:", err);
    return Response.json({ error: `validation failed: ${msg}` }, { status: 500 });
  }

  let result;
  try {
    result = await runComposite({
      layers: body.layers.map((l) => ({
        generationId: l.generationId as string,
        opacity: l.opacity,
        x: l.x,
        y: l.y,
        scale: l.scale,
        rotation: l.rotation,
        flipH: l.flipH,
        stretchW: l.stretchW,
        stretchH: l.stretchH,
        filters: l.filters,
        targetW: l.targetW,
        targetH: l.targetH,
      })),
      sessionId: body.sessionId,
      outputWidth: body.outputWidth,
      outputHeight: body.outputHeight,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[composite] runComposite error:", err);
    return Response.json({ error: msg }, { status: 500 });
  }

  return Response.json(result);
}
