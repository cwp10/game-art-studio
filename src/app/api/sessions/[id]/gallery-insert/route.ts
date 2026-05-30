import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";
import { createMessage } from "@/lib/db/repo/messages";

export const runtime = "nodejs";

/**
 * POST /api/sessions/:id/gallery-insert
 * 갤러리에서 가져온 이미지를 세션에 메시지 쌍(user + assistant)으로 영속화.
 * 재실행 후 listMessages 로 복원 가능.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await ctx.params;
  const { generationId } = (await req.json()) as { generationId: string };

  const gen = getGeneration(generationId);
  if (!gen) return Response.json({ error: "generation not found" }, { status: 404 });

  const toolCallId = "gc-" + generationId;
  const userText = gen.prompt?.slice(0, 80) || "🖼 갤러리에서 추가";

  createMessage({
    session_id: sessionId,
    role: "user",
    content: [{ type: "text", text: userText }],
  });

  createMessage({
    session_id: sessionId,
    role: "assistant",
    content: [
      { type: "tool_call", id: toolCallId, name: "gallery_insert", args: {} },
      {
        type: "tool_result",
        tool_call_id: toolCallId,
        result: {
          generationId: gen.id,
          width: gen.width ?? 0,
          height: gen.height ?? 0,
          kind: gen.kind,
        },
      },
      { type: "image_ref", generation_id: gen.id },
    ],
  });

  return Response.json({ ok: true });
}
