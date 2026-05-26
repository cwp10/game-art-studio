import { NextRequest } from "next/server";
import { deletePreset, getPreset, updatePreset } from "@/lib/db/repo/style-presets";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const preset = getPreset(id);
  if (!preset) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ preset });
}

type PatchBody = {
  name?: string;
  description?: string | null;
  prompt_suffix?: string;
  negative_suffix?: string | null;
  default_params?: Record<string, unknown> | null;
};

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = getPreset(id);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  if (existing.is_builtin) return Response.json({ error: "builtin preset is read-only" }, { status: 403 });
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const updated = updatePreset(id, body);
    return Response.json({ preset: updated });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = getPreset(id);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  if (existing.is_builtin) return Response.json({ error: "builtin preset cannot be deleted" }, { status: 403 });
  deletePreset(id);
  return Response.json({ ok: true });
}
