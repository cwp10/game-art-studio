import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { getGeneration } from "@/lib/db/repo/generations";
import type { PreviewState } from "@/lib/sprite/preview";

export const runtime = "nodejs";

/**
 * GET /api/sprite/qa?atlasGenerationId=... — 모션 QA 산출물 목록
 * GET /api/sprite/qa?atlasGenerationId=...&file=<basename> — 그 파일
 *
 * 접촉 시트와 GIF 는 **큐레이션 이전의 추출 프레임 전체**로 만든다(정본
 * `preview_animation.py` 가 `frames/` 를 읽는 것과 같다). 사람이 이것을 보고 어느
 * 프레임을 뺄지 정하므로 판정 입력은 편집 전이어야 한다. 큐레이션 반영본은 아틀라스와
 * 매니페스트다.
 *
 * 파일 서빙은 **화이트리스트**다 — generation params 에 기록된 경로와 정확히 일치할
 * 때만 읽는다. 사용자 입력으로 경로를 조립하지 않으므로 traversal 이 성립하지 않는다.
 */

type MotionQa = {
  ok: boolean;
  qaDir: string;
  allContact?: string;
  states: PreviewState[];
};

function allowedPaths(qa: MotionQa): Map<string, string> {
  const out = new Map<string, string>();
  const add = (p: string | undefined): void => {
    if (p) out.set(path.basename(p), p);
  };
  add(qa.allContact);
  for (const s of qa.states) {
    add(s.contactPath);
    add(s.gifPath);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const atlasId = req.nextUrl.searchParams.get("atlasGenerationId");
  if (!atlasId) return Response.json({ error: "atlasGenerationId 가 필요합니다" }, { status: 400 });

  const atlas = getGeneration(atlasId);
  if (!atlas) return Response.json({ error: `generation ${atlasId} 없음` }, { status: 404 });

  const qa = atlas.params?.motionQa as MotionQa | undefined;
  if (!qa) {
    return Response.json(
      { error: "이 시트에는 모션 QA 산출물이 없습니다 (플랜 구동 경로로 다시 생성하세요)" },
      { status: 404 },
    );
  }

  const file = req.nextUrl.searchParams.get("file");
  if (file) {
    const abs = allowedPaths(qa).get(file);
    if (!abs) return Response.json({ error: "알 수 없는 QA 파일" }, { status: 404 });
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      return Response.json({ error: "QA 파일이 사라졌습니다 — 시트를 다시 생성하세요" }, { status: 410 });
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": file.endsWith(".gif") ? "image/gif" : "image/png",
        // 런 디렉터리가 타임스탬프로 갈리므로 같은 URL 이 다른 내용이 되지 않는다.
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const url = (p: string | undefined): string | null =>
    p ? `/api/sprite/qa?atlasGenerationId=${atlasId}&file=${encodeURIComponent(path.basename(p))}` : null;

  return Response.json({
    ok: qa.ok,
    allContact: url(qa.allContact),
    states: qa.states.map(s => ({
      state: s.state,
      ok: s.ok,
      note: s.note,
      frames: s.frames,
      fps: s.fps,
      loop: s.loop,
      contact: url(s.contactPath),
      gif: url(s.gifPath),
    })),
  });
}
