import { NextRequest } from "next/server";
import { listGenerations } from "@/lib/db/repo/generations";
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
  const generations = listGenerations({ sessionId, kind, limit, search });
  return Response.json({ generations });
}
