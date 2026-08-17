import { NextRequest } from "next/server";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeRunSimple } from "@/lib/cli/claude-cli";
import { getGeneration } from "@/lib/db/repo/generations";
import { extractRowFrames } from "@/lib/sprite/extract";
import { gaitOrderPrompt, parseGaitOrder, isNoOpSuggestion } from "@/lib/sprite/gait-order";
import { labeledContactSheet } from "@/lib/sprite/selected-cycle";
import type { SpriteRequest } from "@/lib/sprite/request";
import { DATA_DIR, resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/sprite/gait-order { atlasGenerationId, state } → 프레임 순서 **제안**
 *
 * 걷기·달리기 행의 프레임 순서를 비전 모델에 판정받는다. 자동으로 적용하지 않는다 —
 * 정본은 자동 프레임 순서 선택을 약속하지 말라고 못박고(`locomotion-curation.md`),
 * 모션 실패는 재타이밍이 아니라 행 재생성으로 고치라고 한다(`qa-motion.md`). 그래서
 * 이 라우트는 세 판정 중 하나를 돌려줄 뿐이고, 채택은 사람이 한다.
 *
 * 비전에 넘기는 것은 **번호가 찍힌 접촉 시트**다. 정본이 휴머노이드 행을 독립 비전
 * 모델에 넘겨 판정받기를 권하는 그 산출물이고, 번호가 있어야 모델의 답을 사람이 화면과
 * 대조할 수 있다.
 *
 * 프레임은 아틀라스가 아니라 **raw 행에서 다시 추출**한다. 아틀라스는 이미 큐레이션이
 * 반영돼 있어 인덱스 공간이 원본과 다르고, 그 위에서 나온 순서를 사이드카에 저장하면
 * 두 번 적용된다.
 */

type Body = { atlasGenerationId?: string; state?: string };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const atlasId = body.atlasGenerationId;
  const state = body.state;
  if (!atlasId || !state) {
    return Response.json({ error: "atlasGenerationId 와 state 가 필요합니다" }, { status: 400 });
  }

  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });

  const rowIds = atlas.params?.rowGenerationIds as Record<string, string> | undefined;
  const request = atlas.params?.request as SpriteRequest | undefined;
  if (!rowIds || !request) {
    return Response.json(
      { error: "플랜 구동 시트가 아닙니다 (rowGenerationIds/request 없음)" },
      { status: 400 },
    );
  }
  const rowId = rowIds[state];
  const rowGen = rowId ? getGeneration(rowId) : null;
  if (!rowGen?.image_path) {
    return Response.json({ error: `상태 '${state}' 의 행을 찾을 수 없습니다` }, { status: 404 });
  }

  try {
    // 재합성과 같은 인자로 뽑는다 — 여기서 다른 프레임을 보면 제안한 번호가 시트와 어긋난다.
    const extracted = await extractRowFrames({
      sheetPath: resolveImagePath(rowGen.image_path),
      frameCount: request.states[state]?.frames ?? 0,
      cell: request.cell,
      chromaKey: request.chromaKey.rgb,
      chromaMode: "auto",
      chroma: {
        keyThreshold: request.chroma.keyThreshold,
        unmixReach: request.chroma.unmixReach,
        spillMaxFraction: request.chroma.spillMaxFraction,
      },
      ...(request.fit ? { fit: request.fit } : {}),
      label: state,
    });
    const frames = extracted.frames;
    if (frames.length < 2) {
      return Response.json(
        { error: `프레임이 ${frames.length}장이라 순서를 판정할 것이 없습니다` },
        { status: 400 },
      );
    }

    // 접촉 시트는 파생 캐시다 — 매번 다시 굽는다. 모델이 Read 로 열 수 있게 파일로 쓴다.
    const sheet = labeledContactSheet(
      frames.map((image, i) => ({ number: i + 1, image })),
    );
    const dir = path.join(DATA_DIR, "sprite-runs", "gait-order");
    await mkdir(dir, { recursive: true });
    const sheetPath = path.join(dir, `${rowId}-contact.png`);
    await writeFile(
      sheetPath,
      await sharp(sheet.data, { raw: { width: sheet.width, height: sheet.height, channels: 3 } })
        .png()
        .toBuffer(),
    );

    const raw = await claudeRunSimple({
      systemPrompt:
        "You judge sprite animation frame order from a contact sheet. " +
        "Use the Read tool to view the image before answering. Output only the JSON object asked for.",
      userMessage: `${gaitOrderPrompt(state, frames.length)}\n\nImage path: ${sheetPath}`,
      allowedTools: ["Read"],
      signal: req.signal,
    });

    // 검증에서 던지면 그대로 실패로 낸다 — 알 수 없는 답을 제안으로 보여주지 않는다.
    const suggestion = parseGaitOrder(raw, frames.length);

    return Response.json({
      ok: true,
      state,
      frameCount: frames.length,
      suggestion,
      noop: isNoOpSuggestion(suggestion, frames.length),
      contactSheet: sheetPath,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
