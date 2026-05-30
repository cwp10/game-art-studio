"use client";

import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPreset, deletePreset, listPresets } from "@/lib/api/client";
import type { StylePreset } from "@/types/db";

/**
 * 스타일 프리셋 picker — Composer 안에서 클릭 시 팝오버.
 *
 * 선택된 preset 의 id 는 부모에 onChange 로 전달. 부모가 chip 으로 표시.
 * 새 preset 즉시 생성 (간단한 inline form). builtin 은 삭제 불가 (서버 측에서도 가드).
 */

type Props = {
  value: string | null;
  onChange: (presetId: string | null) => void;
  popoverDirection?: "up" | "down";
};

export function StylePresetPicker({ value, onChange, popoverDirection = "up" }: Props) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSuffix, setNewSuffix] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    listPresets().then(setPresets).catch(e => setErr((e as Error).message));
  }, [open]);

  // 바깥 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function saveNew() {
    setErr(null);
    if (!newName.trim() || !newSuffix.trim()) {
      setErr("이름과 prompt suffix 필수");
      return;
    }
    try {
      const p = await createPreset({ name: newName.trim(), prompt_suffix: newSuffix.trim() });
      setPresets(prev => [...prev, p].sort((a, b) => (b.is_builtin - a.is_builtin) || a.name.localeCompare(b.name)));
      onChange(p.id);
      setCreating(false);
      setNewName("");
      setNewSuffix("");
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function removePreset(id: string) {
    try {
      await deletePreset(id);
      setPresets(prev => prev.filter(p => p.id !== id));
      if (value === id) onChange(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div ref={popRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs leading-none ${
          value
            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
            : "border-border text-text-muted hover:text-text-primary"
        }`}
        title="스타일 프리셋 선택"
      >
        <Sparkles size={12} /> 스타일
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute left-0 z-20 w-[320px] rounded-xl border border-border bg-bg-panel p-2 shadow-xl ${popoverDirection === "down" ? "top-full mt-1" : "bottom-full mb-2"}`}
        >
          <div className="mb-1 flex items-center justify-between px-1 text-xs text-text-muted">
            <span>스타일 프리셋</span>
            <button
              onClick={() => setCreating(c => !c)}
              className="flex items-center gap-1 rounded p-1 hover:bg-bg-card hover:text-text-primary"
              title="새 프리셋 추가"
            >
              <Plus size={12} />
            </button>
          </div>
          {creating && (
            <div className="mb-2 space-y-1 rounded-lg border border-border bg-bg-card p-2 text-xs">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="이름 (예: 사이버펑크)"
                className="h-7 w-full rounded border border-border bg-bg-app px-2 text-text-primary"
              />
              <textarea
                value={newSuffix}
                onChange={e => setNewSuffix(e.target.value)}
                placeholder="prompt suffix (예: cyberpunk neon, futuristic, ...)"
                rows={2}
                className="block w-full resize-none rounded border border-border bg-bg-app px-2 py-1 text-text-primary"
              />
              <div className="flex justify-end gap-1">
                <button
                  onClick={() => { setCreating(false); setErr(null); }}
                  className="h-6 rounded border border-border px-2 text-text-muted hover:text-text-primary"
                >
                  취소
                </button>
                <button
                  onClick={saveNew}
                  className="h-6 rounded bg-[color:var(--accent)] px-2 text-white"
                >
                  저장
                </button>
              </div>
            </div>
          )}
          {err && <p className="mb-1 px-1 text-[11px] text-[color:var(--danger)]">{err}</p>}
          <div className="grid grid-cols-2 gap-1">
            {presets.map(p => {
              const active = value === p.id;
              return (
                <div
                  key={p.id}
                  className={`group relative rounded-lg border p-2 text-xs ${
                    active
                      ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20"
                      : "border-border bg-bg-card hover:border-[color:var(--accent)]/40"
                  }`}
                >
                  <button
                    onClick={() => { onChange(active ? null : p.id); setOpen(false); }}
                    className="block w-full text-left"
                  >
                    <div className="font-medium text-text-primary">
                      {active && "✓ "}
                      {p.name}
                    </div>
                    {p.description && (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-text-muted">
                        {p.description}
                      </div>
                    )}
                  </button>
                  {!p.is_builtin && (
                    <button
                      onClick={e => { e.stopPropagation(); removePreset(p.id); }}
                      className="absolute right-1 top-1 rounded p-0.5 text-text-muted opacity-0 hover:text-[color:var(--danger)] group-hover:opacity-100"
                      title="삭제"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
