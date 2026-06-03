"use client";

import { Download, Image as ImageIcon, Loader2, MessageSquare, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Session } from "@/types/db";

type Props = {
  sessions: Session[];
  activeId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenGallery: () => void;
  /** true 이면 생성 중 — 세션 전환·새 세션 버튼 비활성. */
  generating?: boolean;
};

export function SessionList({ sessions, activeId, search, onSearch, onNew, onSelect, onDelete, onRename, onOpenGallery, generating }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [exportingId, setExportingId] = useState<string | null>(null);

  function exportSession(s: Session) {
    setExportingId(s.id);
    const a = document.createElement("a");
    a.href = `/api/export?sessionId=${encodeURIComponent(s.id)}`;
    a.download = `session-${s.id}.zip`;
    a.click();
    // 다운로드 시작 후 바로 해제 — 실제 완료 감지는 불필요.
    setTimeout(() => setExportingId(null), 1500);
  }

  function startEdit(s: Session) {
    setEditingId(s.id);
    setDraft(s.title || "");
  }
  function commitEdit(s: Session) {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== s.title) onRename(s.id, trimmed);
    setEditingId(null);
  }

  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-border bg-bg-panel/50">
      <div className="space-y-2 border-b border-border p-3">
        <button
          onClick={onNew}
          disabled={generating}
          title={generating ? "생성 중에는 세션을 전환할 수 없어요" : undefined}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-card px-3 py-2 text-sm font-medium hover:border-[color:var(--accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={14} /> 새 세션
        </button>
        <button
          onClick={onOpenGallery}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-[color:var(--accent)]/40 hover:text-text-primary"
          title="갤러리 (Cmd+G)"
        >
          <ImageIcon size={12} /> 갤러리
        </button>
        <div className="flex items-center gap-1 rounded-md border border-border bg-bg-card px-2 py-1">
          <Search size={11} className="text-text-muted" />
          <input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="세션 검색"
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted/60 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-text-muted">아직 세션이 없어요.</p>
        )}
        <ul className="space-y-1">
          {sessions.map(s => {
            const active = s.id === activeId;
            const editing = editingId === s.id;
            const blocked = generating && !active; // 생성 중 + 비활성 세션 → 클릭 차단
            return (
              <li key={s.id}>
                <div
                  className={`group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    active
                      ? "bg-bg-card text-text-primary"
                      : blocked
                        ? "cursor-not-allowed text-text-muted/40"
                        : "text-text-muted hover:bg-bg-card/60 hover:text-text-primary"
                  }`}
                  title={blocked ? "생성 중에는 세션을 전환할 수 없어요" : undefined}
                >
                  {editing ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onFocus={e => e.target.select()}
                      onBlur={() => commitEdit(s)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEdit(s);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      className="flex-1 rounded border border-[color:var(--accent)]/60 bg-bg-app px-1.5 py-0.5 text-sm text-text-primary focus:outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => !blocked && onSelect(s.id)}
                      onDoubleClick={() => !blocked && startEdit(s)}
                      disabled={blocked}
                      className="flex flex-1 items-center gap-2 truncate text-left disabled:cursor-not-allowed"
                    >
                      {active && generating
                        ? <Loader2 size={12} className="shrink-0 animate-spin text-[color:var(--accent)]" />
                        : <MessageSquare size={12} className="shrink-0" />
                      }
                      <span className="truncate">{s.title || "(제목 없음)"}</span>
                    </button>
                  )}
                  {!editing && !blocked && (
                    <>
                      <button
                        onClick={() => startEdit(s)}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        title="제목 수정"
                      >
                        <Pencil size={12} className="text-text-muted hover:text-text-primary" />
                      </button>
                      <button
                        onClick={() => exportSession(s)}
                        disabled={exportingId === s.id}
                        className="opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-100"
                        title="ZIP 내보내기"
                      >
                        {exportingId === s.id
                          ? <Loader2 size={12} className="animate-spin text-[color:var(--accent)]" />
                          : <Download size={12} className="text-text-muted hover:text-text-primary" />
                        }
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
                    </>
                  )}
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
