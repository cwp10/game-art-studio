import { NextRequest } from "next/server";
import { listMessages } from "@/lib/db/repo/messages";
import { getGeneration } from "@/lib/db/repo/generations";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const messages = listMessages(id);
  // tool_result 블록에 실제 generation.kind 를 채워 클라이언트가 단일/시트를 정확히 판별하게 한다.
  // route.ts 는 생성마다 tool_result 직후 image_ref(신뢰 가능한 generation_id)를 push 하므로,
  // 직전 tool_result 에 그 image_ref 의 kind 를 paired 로 채운다. 레거시 메시지(저장된 result 에
  // kind 없음) 까지 보강. getGeneration 은 로컬 단일사용자 도구라 세션당 N 쿼리 무방.
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    let pendingToolResult: Extract<(typeof m.content)[number], { type: "tool_result" }> | null = null;
    for (const block of m.content) {
      if (block.type === "tool_result") {
        pendingToolResult = block;
      } else if (block.type === "image_ref") {
        if (pendingToolResult && pendingToolResult.kind === undefined) {
          const g = getGeneration(block.generation_id);
          if (g?.kind) pendingToolResult.kind = g.kind;
          if (g?.created_at) pendingToolResult.createdAt = g.created_at;
        }
        pendingToolResult = null;
      }
    }
  }
  return Response.json({ messages });
}
