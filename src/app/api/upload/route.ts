import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import sharp from "sharp";
import { createGeneration, getGeneration } from "@/lib/db/repo/generations";
import { newGenerationId } from "@/lib/util/ids";
import { IMAGES_DIR, ensureDataDirs, imagePath as imagePathFor, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/upload — 클라이언트에서 만든 이미지(인페인트 마스크 등) 를 업로드.
 *
 * 마스크 캔버스 컴포넌트가 그린 PNG 를 base64 dataUrl 로 보내면 여기서 generation 행을
 * 만들어 generationId 를 돌려준다. 그 id 를 `ChatRequest.maskGenerationId` 로 박아
 * /api/chat 을 호출하면 라우트가 본문에 `[mask: <id>]` marker 를 prefix → Claude 가
 * inpaint_image 의 maskGenerationId 로 사용.
 *
 * body:
 *   { kind: "mask", parentGenerationId, dataUrl: "data:image/png;base64,..." }
 *
 * 응답:
 *   { generationId }
 */

type UploadBody = {
  kind?: "mask";
  parentGenerationId?: string;
  dataUrl?: string;
};

export async function POST(req: NextRequest) {
  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.kind !== "mask") {
    return Response.json({ error: "kind must be 'mask'" }, { status: 400 });
  }
  if (!body.parentGenerationId) {
    return Response.json({ error: "parentGenerationId required" }, { status: 400 });
  }
  if (!body.dataUrl || !body.dataUrl.startsWith("data:image/png;base64,")) {
    return Response.json({ error: "dataUrl must be a PNG base64 data URL" }, { status: 400 });
  }

  const parent = getGeneration(body.parentGenerationId);
  if (!parent) {
    return Response.json({ error: "parent generation not found" }, { status: 404 });
  }

  const buf = Buffer.from(body.dataUrl.slice("data:image/png;base64,".length), "base64");
  if (buf.length === 0) {
    return Response.json({ error: "empty PNG body" }, { status: 400 });
  }

  ensureDataDirs();
  const generationId = newGenerationId();
  const destPath = imagePathFor(generationId);
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.writeFile(destPath, buf);

  // 실제 해상도 검증
  const meta = await sharp(destPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // 마스크는 generations.kind 'inpaint' 재활용 + params.kindHint='mask' 로 구분.
  // (스키마의 CHECK enum 변경 마이그레이션 회피.) lineage 는 input_image_ids=[parent].
  const gen = createGeneration({
    id: generationId,
    session_id: parent.session_id,
    message_id: null,
    kind: "inpaint",
    prompt: null,
    input_image_ids: [parent.id],
    params: { kindHint: "mask" },
    image_path: toRelative(destPath),
    width,
    height,
    backend: "external",
  });

  return Response.json({ generationId: gen.id, width: gen.width, height: gen.height });
}

