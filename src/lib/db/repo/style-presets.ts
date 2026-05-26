import { getDb } from "@/lib/db/client";
import { newPresetId } from "@/lib/util/ids";
import type { StylePreset } from "@/types/db";

type Row = {
  id: string;
  name: string;
  description: string | null;
  prompt_suffix: string;
  negative_suffix: string | null;
  default_params: string | null;
  is_builtin: 0 | 1;
  created_at: number;
  updated_at: number;
};

function rowToPreset(r: Row): StylePreset {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    prompt_suffix: r.prompt_suffix,
    negative_suffix: r.negative_suffix,
    default_params: r.default_params ? (JSON.parse(r.default_params) as Record<string, unknown>) : null,
    is_builtin: r.is_builtin,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listPresets(): StylePreset[] {
  const rows = getDb()
    .prepare("SELECT * FROM style_presets ORDER BY is_builtin DESC, name ASC")
    .all() as Row[];
  return rows.map(rowToPreset);
}

export function getPreset(id: string): StylePreset | null {
  const row = getDb().prepare("SELECT * FROM style_presets WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToPreset(row) : null;
}

export function getPresetByName(name: string): StylePreset | null {
  const row = getDb().prepare("SELECT * FROM style_presets WHERE name = ?").get(name) as Row | undefined;
  return row ? rowToPreset(row) : null;
}

export function createPreset(input: {
  id?: string;
  name: string;
  description?: string | null;
  prompt_suffix: string;
  negative_suffix?: string | null;
  default_params?: Record<string, unknown> | null;
  is_builtin?: 0 | 1;
}): StylePreset {
  const now = Date.now();
  const id = input.id ?? newPresetId();
  getDb()
    .prepare(
      `INSERT INTO style_presets
       (id, name, description, prompt_suffix, negative_suffix, default_params, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.description ?? null,
      input.prompt_suffix,
      input.negative_suffix ?? null,
      input.default_params ? JSON.stringify(input.default_params) : null,
      input.is_builtin ?? 0,
      now,
      now,
    );
  return getPreset(id)!;
}

export function updatePreset(
  id: string,
  patch: Partial<Pick<StylePreset, "name" | "description" | "prompt_suffix" | "negative_suffix" | "default_params">>,
): StylePreset | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
  if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
  if (patch.prompt_suffix !== undefined) { fields.push("prompt_suffix = ?"); values.push(patch.prompt_suffix); }
  if (patch.negative_suffix !== undefined) { fields.push("negative_suffix = ?"); values.push(patch.negative_suffix); }
  if (patch.default_params !== undefined) {
    fields.push("default_params = ?");
    values.push(patch.default_params ? JSON.stringify(patch.default_params) : null);
  }
  if (!fields.length) return getPreset(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb().prepare(`UPDATE style_presets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getPreset(id);
}

export function deletePreset(id: string): void {
  getDb().prepare("DELETE FROM style_presets WHERE id = ?").run(id);
}

/** 멱등 upsert by name — seed 용. 같은 이름 존재 시 prompt_suffix/description 만 갱신. */
export function upsertBuiltinPreset(input: {
  name: string;
  description: string;
  prompt_suffix: string;
  negative_suffix?: string;
  default_params?: Record<string, unknown>;
}): StylePreset {
  const existing = getPresetByName(input.name);
  if (existing) {
    return updatePreset(existing.id, {
      description: input.description,
      prompt_suffix: input.prompt_suffix,
      negative_suffix: input.negative_suffix ?? null,
      default_params: input.default_params ?? null,
    })!;
  }
  return createPreset({ ...input, is_builtin: 1 });
}
