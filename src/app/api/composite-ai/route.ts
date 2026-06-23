import { NextRequest } from "next/server";
import { getGeneration, createGeneration } from "@/lib/db/repo/generations";
import { runComposite } from "@/lib/image-backend/composite-runner";
import { selectImageBackend, type ImageJob } from "@/lib/image-backend";
import { newGenerationId, newJobId } from "@/lib/util/ids";
import { resolveImagePath, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/composite-ai — AI 합성. /api/composite 와 동일하게 N 개 레이어를 sharp 로 먼저
 * 평탄화한 뒤, 그 결과 PNG 를 Codex img2img 로 한 번 더 재생성해 자연스럽게 합성한다.
 *
 * 처리 흐름:
 *   1. runComposite() 로 sharp 평탄화 → intermediate generation(kind='composite').
 *      (HTTP 우회 없이 in-process 호출. /api/composite 와 동일 계약.)
 *   2. 평탄화 결과의 절대 파일 경로를 Codex 에 입력으로 전달(img2img).
 *      ⚠️ runComposite 의 imagePath 는 URL("/api/images/{id}") 이므로 그대로 쓰면 안 된다 —
 *         getGeneration(...).image_path → resolveImagePath() 로 실제 파일 경로를 얻는다.
 *   3. Codex 결과를 generation 행(kind='img2img', backend='codex_exec')으로 저장.
 *
 * Request: /api/composite 와 동일 + prompt(필수).
 * Response: { generationId, imagePath, width, height } (최종 img2img generation 기준).
 *
 * 주의: intermediate(composite)와 최종(img2img) 두 개의 generation 행이 생성된다 — 둘 다 갤러리에 노출됨.
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
type CompositeAiBody = {
  layers?: CompositeLayerInput[];
  sessionId?: string;
  outputWidth?: number;
  outputHeight?: number;
  prompt?: string;
};

export async function POST(req: NextRequest) {
  let body: CompositeAiBody;
  try {
    body = (await req.json()) as CompositeAiBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!Array.isArray(body.layers) || body.layers.length === 0) {
    return Response.json({ error: "layers must be a non-empty array" }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return Response.json({ error: "prompt required" }, { status: 400 });
  }

  // /api/composite 와 동일한 입력 검증(400/404 구분) — 관찰 가능한 HTTP 계약 유지.
  for (const [i, l] of body.layers.entries()) {
    if (!l.generationId) {
      return Response.json({ error: `layers[${i}].generationId required` }, { status: 400 });
    }
    if (!getGeneration(l.generationId)) {
      return Response.json({ error: `generation not found: ${l.generationId}` }, { status: 404 });
    }
  }

  // 1. sharp 평탄화 — runComposite 에 위임(/api/composite 와 동일 핵심).
  const flattened = await runComposite({
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

  // 2. 평탄화 결과의 절대 파일 경로 해석 — runComposite 의 imagePath 는 URL 이므로 사용 금지.
  const flatGen = getGeneration(flattened.generationId);
  if (!flatGen) {
    return Response.json({ error: "flattened generation missing" }, { status: 500 });
  }
  const inputPath = resolveImagePath(flatGen.image_path);

  // 3. Codex img2img — chat/route.ts·composite-runner 패턴을 따른다.
  //    PROMPT_HEADER 는 buildNaturalPrompt(img2img)가 자동으로 붙이므로 직접 prepend 하지 않는다.
  const generationId = newGenerationId();
  const job: ImageJob = {
    id: newJobId(),
    generationId,
    kind: "img2img",
    prompt: body.prompt.trim(),
    inputImagePaths: [inputPath],
  };

  const backend = await selectImageBackend();
  const result = await backend.execute(job, () => {});

  // 4. generation 행 작성 (kind='img2img', backend='codex_exec').
  createGeneration({
    id: generationId,
    session_id: body.sessionId ?? null,
    message_id: null,
    kind: "img2img",
    backend: "codex_exec",
    prompt: body.prompt.trim(),
    input_image_ids: [flattened.generationId],
    params: { aiComposite: true, layers: body.layers, compositeBaseId: flattened.generationId },
    image_path: toRelative(result.imagePath),
    width: result.width,
    height: result.height,
  });

  // 5. 응답 — /api/composite 와 동일 shape.
  return Response.json({
    generationId,
    imagePath: `/api/images/${generationId}`,
    width: result.width,
    height: result.height,
  });
}
