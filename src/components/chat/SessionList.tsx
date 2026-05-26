"use client";

import { Plus, MessageSquare, Trash2 } from "lucide-react";
import type { Session } from "@/types/db";

type Props = {
  sessions: Session[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export function SessionList({ sessions, activeId, onNew, onSelect, onDelete }: Props) {
  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-border bg-bg-panel/50">
      <div className="border-b border-border p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-card px-3 py-2 text-sm font-medium hover:border-[color:var(--accent)]/60"
        >
          <Plus size={14} /> 새 세션
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-text-muted">아직 세션이 없어요.</p>
        )}
        <ul className="space-y-1">
          {sessions.map(s => {
            const active = s.id === activeId;
            return (
              <li key={s.id}>
                <div
                  className={`group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    active ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/60 hover:text-text-primary"
                  }`}
                >
                  <button
                    onClick={() => onSelect(s.id)}
                    className="flex flex-1 items-center gap-2 truncate text-left"
                  >
                    <MessageSquare size={12} className="shrink-0" />
                    <span className="truncate">{s.title || "(제목 없음)"}</span>
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`"${s.title}" 세션을 삭제할까요?`)) onDelete(s.id);
                    }}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    title="삭제"
                  >
                    <Trash2 size={12} className="text-text-muted hover:text-[color:var(--danger)]" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="border-t border-border p-3 text-[10px] text-text-muted/60">
        <p>로컬 전용 · 데이터는 ./data/ 에 저장</p>
      </div>
    </aside>
  );
}
