import { NextRequest } from "next/server";
import { createGeneration, getGeneration, linkGeneration } from "@/lib/db/repo/generations";
import { createMessage } from "@/lib/db/repo/messages";
import { selectImageBackend } from "@/lib/image-backend";
import { patchSpritesheetFrame } from "@/lib/image-backend/sprite-frame-patch";
import { detectSpriteGrid } from "@/lib/shared/detect-sprite-grid";
import { newGenerationId, newJobId } from "@/lib/util/ids";
import { ensureDataDirs, imagePath as imagePathFor, resolveImagePath, toRelative } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * POST /api/sprite-frame/regenerate — 스프라이트시트 단일 셀(프레임) 재생성.
 *
 * 시트에서 (row,col) 셀만 뽑아 codex 로 편집 후 동일 크기 새 시트를 만든다(다른 셀 불변).
 * patchSpritesheetFrame 이 추출→편집→chroma-key→합성을 담당. 결과는 새 kind='spritesheet' 행.
 *
 * 그리드 해석은 SpriteCanvas 와 일치시켜야 한다: params(rows/cols) 우선, 없으면 detectSpriteGrid
 * 폴백. (방향 시트는 gcd 역산이 잘못된 그리드를 잡아 셀 좌표가 어긋난다 — params 우선이 정합.)
 *
 * body: { sheetGenerationId, row, col, prompt }
 * 응답: { newSheetGenerationId, messageId, imageUrl, width, height, elapsedMs }
 *   messageId: assistant 메시지 id (session 미연결 시트면 null).
 */

type RegenBody = {
  sheetGenerationId?: string;
  row?: number;
  col?: number;
  prompt?: string;
};

export async function POST(req: NextRequest) {
  let body: RegenBody;
  try {
    body = (await req.json()) as RegenBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const { sheetGenerationId, row, col, prompt } = body;
  if (!sheetGenerationId || typeof sheetGenerationId !== "string") {
    return Response.json({ error: "sheetGenerationId required" }, { status: 400 });
  }
  if (!Number.isInteger(row) || (row as number) < 0) {
    return Response.json({ error: "row must be a non-negative integer" }, { status: 400 });
  }
  if (!Number.isInteger(col) || (col as number) < 0) {
    return Response.json({ error: "col must be a non-negative integer" }, { status: 400 });
  }
  if (prompt !== undefined && typeof prompt !== "string") {
    return Response.json({ error: "prompt must be a string" }, { status: 400 });
  }

  const original = getGeneration(sheetGenerationId);
  if (!original) {
    return Response.json({ error: "sheet generation not found" }, { status: 404 });
  }
  if (original.kind !== "spritesheet") {
    return Response.json({ error: "스프라이트시트만 지원합니다" }, { status: 400 });
  }

  const width = original.width ?? 0;
  const height = original.height ?? 0;

  // 그리드 해석 — SpriteCanvas 와 동일: params(make_spritesheet 영속) 우선, detectSpriteGrid 폴백.
  const p = original.params as { rows?: number; cols?: number };
  const detected = detectSpriteGrid(width, height);
  const rows = typeof p?.rows === "number" && p.rows >= 1 ? p.rows : detected?.rows ?? 0;
  const cols = typeof p?.cols === "number" && p.cols >= 1 ? p.cols : detected?.cols ?? 0;
  if (!rows || !cols) {
    return Response.json({ error: "그리드 감지 실패" }, { status: 400 });
  }

  // 비정사각 셀 지원 — width=cols*cellW 가 정확히 나뉘므로 floor 로 진짜 셀 크기 복원.
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);

  if ((row as number) >= rows || (col as number) >= cols) {
    return Response.json({ error: `row/col out of range (${rows}×${cols})` }, { status: 400 });
  }

  ensureDataDirs();

  const sheetImagePath = resolveImagePath(original.image_path);
  const newGenId = newGenerationId();
  const jobId = newJobId();
  const outPath = imagePathFor(newGenId);

  const backend = await selectImageBackend();
  const frameIndex = (row as number) * cols + (col as number);
  const { width: outW, height: outH, elapsedMs } = await patchSpritesheetFrame({
    sheetImagePath,
    cellW,
    cellH,
    row: row as number,
    col: col as number,
    rows,
    cols,
    totalFrames: rows * cols,
    frameIndex,
    prompt: prompt ?? "",
    backend,
    outPath,
    jobId,
  });

  // 새 행 — 원본 params(rows/cols/cellW/cellH/directions/anchor/fps…)를 보존해 reopen 시
  // SpriteCanvas 가 동일 그리드로 열린다(params 미보존 시 방향 시트 grid 가 깨짐).
  const gen = createGeneration({
    id: newGenId,
    session_id: original.session_id,
    message_id: null,
    kind: "spritesheet",
    prompt: prompt ?? null,
    input_image_ids: [sheetGenerationId],
    params: original.params,
    image_path: toRelative(outPath),
    width: outW,
    height: outH,
    backend: "codex_exec",
  });

  // assistant 메시지로 영속 — 재생성을 chat 타임라인의 tool_call/tool_result/image_ref 로 기록해
  // reopen·history 에서 ImageResultCard 가 렌더된다. chat/route 의 generation 영속 패턴과 동일.
  // session 미연결 시트(session_id=null)는 timeline 귀속처가 없으므로 generation 만 저장하고 스킵.
  let messageId: string | null = null;
  if (original.session_id) {
    const toolCallId = `regen_${newGenId}`;
    const assistantMsg = createMessage({
      session_id: original.session_id,
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: toolCallId,
          name: "mcp__imggen__regenerate_sprite_frame",
          args: { row, col, prompt: prompt ?? "" },
        },
        {
          type: "tool_result",
          tool_call_id: toolCallId,
          result: `Regenerated frame (row=${row as number}, col=${col as number}). image ref id "${newGenId}".`,
        },
        { type: "image_ref", generation_id: newGenId },
      ],
      claude_session_id: null,
    });
    linkGeneration(newGenId, { session_id: original.session_id, message_id: assistantMsg.id });
    messageId = assistantMsg.id;
  }

  return Response.json({
    newSheetGenerationId: gen.id,
    messageId,
    imageUrl: `/api/images/${gen.id}`,
    width: outW,
    height: outH,
    elapsedMs,
  });
}
