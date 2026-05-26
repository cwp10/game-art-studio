import { NextRequest } from "next/server";
import { createSession, listSessions } from "@/lib/db/repo/sessions";

export const runtime = "nodejs";

export async function GET() {
  const sessions = listSessions();
  return Response.json({ sessions });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const s = createSession(body.title ?? "새 세션");
  return Response.json({ session: s }, { status: 201 });
}
