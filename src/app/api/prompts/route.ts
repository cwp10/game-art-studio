import { NextRequest } from "next/server";
import { createPrompt, listPrompts } from "@/lib/db/repo/prompt-library";

export const runtime = "nodejs";

/** GET /api/prompts?search=...&tag=... — 검색 + tag 필터. use_count DESC 정렬. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const prompts = listPrompts({
    search: sp.get("search") ?? undefined,
    tag: sp.get("tag") ?? undefined,
  });
  return Response.json({ prompts });
}

type CreateBody = { title?: string; body?: string; tags?: string[] };

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.title?.trim()) return Response.json({ error: "title required" }, { status: 400 });
  if (!body.body?.trim()) return Response.json({ error: "body required" }, { status: 400 });
  const prompt = createPrompt({
    title: body.title.trim(),
    body: body.body.trim(),
    tags: (body.tags ?? []).map(t => t.trim()).filter(Boolean),
  });
  return Response.json({ prompt });
}
