import { NextRequest } from "next/server";
import { createPreset, listPresets } from "@/lib/db/repo/style-presets";

export const runtime = "nodejs";

/** GET /api/presets — builtin 우선 + 이름 정렬. */
export async function GET() {
  return Response.json({ presets: listPresets() });
}

type CreateBody = {
  name?: string;
  description?: string;
  prompt_suffix?: string;
  negative_suffix?: string;
  default_params?: Record<string, unknown>;
};

/** POST /api/presets — 사용자 정의 preset 생성 (is_builtin=0). */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.name?.trim()) return Response.json({ error: "name required" }, { status: 400 });
  if (!body.prompt_suffix?.trim()) return Response.json({ error: "prompt_suffix required" }, { status: 400 });
  try {
    const preset = createPreset({
      name: body.name.trim(),
      description: body.description?.trim() || null,
      prompt_suffix: body.prompt_suffix.trim(),
      negative_suffix: body.negative_suffix?.trim() || null,
      default_params: body.default_params ?? null,
      is_builtin: 0,
    });
    return Response.json({ preset });
  } catch (e) {
    // UNIQUE name 위배 등.
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
