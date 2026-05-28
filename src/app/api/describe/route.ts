import { NextRequest } from "next/server";
import fs from "node:fs";
import { claudeRunSimple } from "@/lib/cli/claude-cli";
import { getGeneration } from "@/lib/db/repo/generations";
import { resolveImagePath } from "@/lib/util/paths";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/describe { generationId } → { prompt }
 *
 * 이미지를 비전(claude Read 도구)으로 분석해, ChatGPT/DALL·E 등 외부 t2i 모델에 그대로
 * 쓸 수 있는 영어 프롬프트를 추출한다. 저장된 원본 프롬프트(한국어 자연어 지시)와 무관하게
 * 픽셀에서 뽑으므로 업로드 이미지에도 동작.
 */

const SYSTEM_PROMPT = `You are an expert at writing prompts for text-to-image models (ChatGPT/DALL·E, Midjourney, Stable Diffusion).
You will be given the path to an image. Use the Read tool to view it, then write a single prompt that would recreate it.
Rules:
- Output ONLY the prompt. No preamble, no explanation, no markdown, no surrounding quotes.
- One paragraph, English.
- Cover: subject, art style/medium, composition/pose/angle, color palette, lighting/mood, and notable details (e.g. transparent background, pixel art, sprite sheet layout) when present.`;

type Body = { generationId?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const id = body.generationId?.trim();
  if (!id) return Response.json({ error: "generationId required" }, { status: 400 });

  const gen = getGeneration(id);
  if (!gen) return Response.json({ error: "generation not found" }, { status: 404 });
  const imagePath = resolveImagePath(gen.image_path);
  if (!fs.existsSync(imagePath)) return Response.json({ error: "image file missing" }, { status: 410 });

  try {
    const raw = await claudeRunSimple({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `Image path: ${imagePath}`,
      allowedTools: ["Read"],
      signal: req.signal,
    });
    const prompt = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!prompt) return Response.json({ error: "empty description" }, { status: 502 });
    return Response.json({ prompt });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
