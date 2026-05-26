import { NextRequest } from "next/server";
import { deleteSession, getSession, renameSession } from "@/lib/db/repo/sessions";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = getSession(id);
  if (!s) return new Response("not found", { status: 404 });
  return Response.json({ session: s });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (body.title) renameSession(id, body.title);
  return Response.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteSession(id);
  return Response.json({ ok: true });
}
