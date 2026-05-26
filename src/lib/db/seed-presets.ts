import type Database from "better-sqlite3";
import { newPresetId } from "@/lib/util/ids";

/**
 * builtin 스타일 프리셋 5종. 게임 에셋 도구의 대표적 스타일.
 *
 * 멱등성: name UNIQUE 제약 + INSERT OR IGNORE → 같은 name 이 이미 있으면 무시.
 * 사용자가 builtin 의 prompt_suffix 를 수정하면 보존 (덮어쓰지 않음).
 *
 * db client init 에서 호출. repo 를 우회해 직접 SQL — 순환 import 회피.
 */

export type BuiltinPresetSeed = {
  name: string;
  description: string;
  prompt_suffix: string;
  negative_suffix?: string;
};

export const BUILTIN_PRESETS: BuiltinPresetSeed[] = [
  {
    name: "픽셀아트",
    description: "16비트 시대 픽셀 게임 스타일 (예: 슈퍼 닌텐도)",
    prompt_suffix: "pixel art, 16-bit style, crisp pixels, limited color palette, retro game aesthetic",
    negative_suffix: "smooth, antialiased, photorealistic",
  },
  {
    name: "도트",
    description: "더 작은 픽셀 (8x8 ~ 32x32 셀)",
    prompt_suffix: "dot art, 8-bit, tiny sprite, pixelated, low resolution, retro 80s arcade style",
    negative_suffix: "smooth, high resolution, photorealistic",
  },
  {
    name: "수채화",
    description: "부드러운 색 번짐, 종이 질감",
    prompt_suffix: "watercolor painting, soft bleed, paper texture, painterly brushstrokes, light and airy",
    negative_suffix: "pixelated, digital, sharp edges",
  },
  {
    name: "셀쉐이딩",
    description: "애니메이션 스타일 두꺼운 선 + 평평한 채색",
    prompt_suffix: "cel shading, thick black outlines, flat shading, anime style, bold colors, 2D illustration",
    negative_suffix: "realistic, gradient shading, photorealistic",
  },
  {
    name: "미니멀",
    description: "단순한 도형 + 제한된 색상, 모바일 게임 아이콘 풍",
    prompt_suffix: "minimalist, flat design, simple shapes, limited palette, clean vector illustration, mobile game icon style",
    negative_suffix: "detailed, photorealistic, busy composition",
  },
];

/**
 * 멱등 seed. name UNIQUE 제약 + INSERT OR IGNORE 로 중복 안 들어감.
 * 호출자: getDb().init().
 */
export function seedBuiltinPresets(db: Database.Database): void {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO style_presets
       (id, name, description, prompt_suffix, negative_suffix, default_params, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
  );
  for (const p of BUILTIN_PRESETS) {
    stmt.run(newPresetId(), p.name, p.description, p.prompt_suffix, p.negative_suffix ?? null, now, now);
  }
}
