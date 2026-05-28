import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { listGenerations } from "@/lib/db/repo/generations";
import { resolveImagePath } from "@/lib/util/paths";
import type { GenerationKind } from "@/types/db";

export const runtime = "nodejs";

const KINDS: GenerationKind[] = ["text2img", "img2img", "upscale", "remove_bg", "inpaint", "spritesheet"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const kindRaw = url.searchParams.get("kind");
  const kind = kindRaw && KINDS.includes(kindRaw as GenerationKind) ? (kindRaw as GenerationKind) : undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? "200");
  // 원본 파일이 사라진(수동 삭제 등) 행은 갤러리에서 제외 — 썸네일 stale 표시·선택 시 410 방지.
  const generations = listGenerations({ sessionId, kind, limit, search }).filter(g =>
    existsSync(resolveImagePath(g.image_path)),
  );
  return Response.json({ generations });
}
