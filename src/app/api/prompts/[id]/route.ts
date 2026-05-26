import { NextRequest } from "next/server";
import { bumpPromptUse, deletePrompt, getPrompt, updatePrompt } from "@/lib/db/repo/prompt-library";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const prompt = getPrompt(id);
  if (!prompt) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ prompt });
}

type PatchBody = { title?: string; body?: string; tags?: string[]; use?: true };

/** PATCH: 일반 편집 또는 `{use: true}` 로 use_count bump (단축어). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = getPrompt(id);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.use) {
    bumpPromptUse(id);
    return Response.json({ prompt: getPrompt(id) });
  }
  const updated = updatePrompt(id, {
    title: body.title,
    body: body.body,
    tags: body.tags ? body.tags.map(t => t.trim()).filter(Boolean) : undefined,
  });
  return Response.json({ prompt: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getPrompt(id)) return Response.json({ error: "not found" }, { status: 404 });
  deletePrompt(id);
  return Response.json({ ok: true });
}
