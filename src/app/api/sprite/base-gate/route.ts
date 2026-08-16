import { NextRequest } from "next/server";
import {
  getGeneration,
  getLockedBase,
  lockBaseGeneration,
} from "@/lib/db/repo/generations";
import { inspectBaseImage } from "@/lib/sprite/base-gate";
import { resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";

/**
 * base 잠금 게이트 — 정본에서 **BLOCKING** 인 유일한 앞단이다.
 *
 * *"약한 idle 앵커는 모든 상태를 오염시킨다 — 비율·스타일·정체성 드리프트가 모든 행에
 * 누적된다. 행 생성 전에 y/n 을 답하라."* 그리고 *"'일단 이 정도면 됨'은 통과가 아니다.
 * 드리프트는 행이 시작되면 커지기만 한다."*
 *
 * **자동 검사는 6기준 중 3개뿐이다**(배경·전신·픽셀아트). 비율/스타일 적합성, 캐릭터
 * 정체성, 작은 크기에서의 실루엣 가독성은 기계가 판정할 수 없어 사람이 확인한다.
 * 그래서 `autoPass` 는 잠금이 아니다 — 최종 y/n 은 사람이 누른다.
 *
 * GET  ?generationId=...        — 검사 결과 + 현재 잠금 상태
 * POST { generationId, lock }   — 잠금
 */

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("generationId");
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const pixelArt = req.nextUrl.searchParams.get("pixelArt") === "true";

  const locked = getLockedBase(sessionId);
  if (!id) {
    // 후보 없이 현재 잠금 상태만 묻는 경우.
    return Response.json({ ok: true, locked: locked ? { id: locked.id } : null });
  }

  const gen = getGeneration(id);
  if (!gen?.image_path) {
    return Response.json({ error: `generation ${id} 없음` }, { status: 404 });
  }

  let inspection;
  try {
    inspection = await inspectBaseImage(resolveImagePath(gen.image_path), { pixelArt });
  } catch (e) {
    return Response.json({ error: `검사 실패: ${(e as Error).message}` }, { status: 500 });
  }

  return Response.json({
    ok: true,
    generationId: id,
    locked: locked ? { id: locked.id, isThis: locked.id === id } : null,
    inspection,
  });
}

type Body = { generationId?: string; sessionId?: string | null; lock?: boolean };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.generationId) {
    return Response.json({ error: "generationId 가 필요합니다" }, { status: 400 });
  }
  const gen = getGeneration(body.generationId);
  if (!gen) return Response.json({ error: `generation ${body.generationId} 없음` }, { status: 404 });

  // 잠금은 사람의 판단이다 — autoPass 를 서버가 다시 확인해 막지 않는다. 정본도
  // 자동 검사를 통과 조건으로 쓰지 않고, 사람이 6기준을 보고 y/n 을 누른다.
  lockBaseGeneration(body.generationId, body.sessionId ?? null);
  const locked = getLockedBase(body.sessionId ?? null);
  return Response.json({ ok: true, locked: locked ? { id: locked.id } : null });
}
