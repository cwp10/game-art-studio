import { NextRequest } from "next/server";
import { listMessages } from "@/lib/db/repo/messages";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const messages = listMessages(id);
  return Response.json({ messages });
}
