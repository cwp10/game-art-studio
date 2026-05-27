"use client";

import { ArrowLeft, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  bumpPromptUse,
  createPrompt,
  deletePrompt,
  listPrompts,
  updatePrompt,
} from "@/lib/api/client";
import type { PromptLibraryItem } from "@/types/db";

/**
 * 프롬프트 라이브러리 모달 시트 — Cmd+K 로 토글 (호출은 ChatLayout 의 hotkey).
 *
 * - 검색 (title + body LIKE)
 * - tag 필터 (현재는 자유 입력 tag union 으로 추출)
 * - 새 prompt 인라인 작성
 * - 항목 클릭 → Composer 에 prefill + bump use_count
 * - 변수 템플릿: body 에 {{변수명}} 포함 시 사용 버튼 클릭 → 변수 입력 패널 → 보간 후 prefill
 */

/** {{변수명}} 패턴에서 고유한 변수 이름을 순서대로 추출. */
function extractVars(body: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of body.matchAll(/\{\{([^}]+)\}\}/g)) {
    const name = m[1].trim();
    if (!seen.has(name)) { seen.add(name); result.push(name); }
  }
  return result;
}

/** 변수 값을 채워 보간된 문자열 반환. 미입력 변수는 원본 {{...}} 그대로 유지. */
function interpolate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{([^}]+)\}\}/g, (_, name) => values[name.trim()] ?? `{{${name}}}`);
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** 선택 시 Composer 에 prefill (modal 도 자동 닫힘). */
  onUse: (text: string) => void;
};

export function PromptLibrarySheet({ open, onClose, onUse }: Props) {
  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newTags, setNewTags] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  // 인라인 편집 중인 prompt id + draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; body: string; tags: string }>({
    title: "", body: "", tags: "",
  });
  // 변수 채우기 단계
  const [fillingItem, setFillingItem] = useState<PromptLibraryItem | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  const searchRef = useRef<HTMLInputElement>(null);
  const firstVarRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listPrompts({ search: search || undefined, tag: tag || undefined })
      .then(setItems)
      .catch(e => setErr((e as Error).message));
  }, [search, tag]);

  useEffect(() => {
    if (!open) return;
    refresh();
    setFocusIdx(0);
    setFillingItem(null);
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open, refresh]);

  // 변수 입력 패널 열릴 때 첫 input 에 포커스
  useEffect(() => {
    if (fillingItem) setTimeout(() => firstVarRef.current?.focus(), 50);
  }, [fillingItem]);

  const allTags = Array.from(new Set(items.flatMap(i => i.tags))).sort();

  useHotkeys("esc", () => {
    if (!open) return;
    if (fillingItem) { setFillingItem(null); return; }
    onClose();
  }, { enableOnFormTags: true, preventDefault: true }, [open, fillingItem, onClose]);
  useHotkeys(
    "down",
    () => setFocusIdx(i => Math.min(items.length - 1, i + 1)),
    { enableOnFormTags: true, preventDefault: true, enabled: open && !fillingItem },
    [items.length, open, fillingItem],
  );
  useHotkeys(
    "up",
    () => setFocusIdx(i => Math.max(0, i - 1)),
    { enableOnFormTags: true, preventDefault: true, enabled: open && !fillingItem },
    [open, fillingItem],
  );
  useHotkeys(
    "enter",
    () => { const it = items[focusIdx]; if (it && open && !fillingItem) handleUse(it); },
    { enableOnFormTags: false, preventDefault: true, enabled: open && !fillingItem },
    [focusIdx, items, open, fillingItem],
  );

  function handleUse(it: PromptLibraryItem) {
    const vars = extractVars(it.body);
    if (vars.length > 0) {
      // 변수가 있으면 채우기 패널로
      setFillingItem(it);
      setVarValues(Object.fromEntries(vars.map(v => [v, ""])));
      return;
    }
    applyUse(it, it.body);
  }

  function applyUse(it: PromptLibraryItem, finalText: string) {
    onUse(finalText);
    bumpPromptUse(it.id).catch(() => {});
    onClose();
  }

  function submitVars() {
    if (!fillingItem) return;
    const filled = interpolate(fillingItem.body, varValues);
    applyUse(fillingItem, filled);
  }

  async function saveNew() {
    setErr(null);
    if (!newTitle.trim() || !newBody.trim()) { setErr("제목과 본문 필수"); return; }
    try {
      const tags = newTags.split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean);
      await createPrompt({ title: newTitle.trim(), body: newBody.trim(), tags });
      setCreating(false);
      setNewTitle("");
      setNewBody("");
      setNewTags("");
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await deletePrompt(id);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function startEdit(it: PromptLibraryItem) {
    setEditingId(it.id);
    setEditDraft({ title: it.title, body: it.body, tags: it.tags.join(", ") });
  }
  async function saveEdit() {
    if (!editingId) return;
    setErr(null);
    try {
      const tags = editDraft.tags.split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean);
      await updatePrompt(editingId, {
        title: editDraft.title.trim(),
        body: editDraft.body.trim(),
        tags,
      });
      setEditingId(null);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-8 pt-20">
      <div
        role="dialog"
        aria-label="프롬프트 라이브러리"
        className="flex max-h-[80vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-panel shadow-2xl"
      >
        {/* ── 변수 채우기 패널 ── */}
        {fillingItem ? (
          <VarFillPanel
            item={fillingItem}
            values={varValues}
            firstRef={firstVarRef}
            onChange={(name, val) => setVarValues(prev => ({ ...prev, [name]: val }))}
            onBack={() => setFillingItem(null)}
            onApply={submitVars}
          />
        ) : (
          <>
            <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
              <span className="font-medium text-text-primary">📚 프롬프트 라이브러리</span>
              <span className="ml-2 text-xs text-text-muted/60">↑↓ 탐색 · Enter 사용 · Esc 닫기</span>
              <button
                onClick={() => setCreating(c => !c)}
                className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="새로 추가"
              >
                <Plus size={12} /> 새로 추가
              </button>
              <button
                onClick={onClose}
                className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="닫기"
              >
                <X size={14} />
              </button>
            </header>

            <div className="border-b border-border p-3">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card px-2 py-1">
                <Search size={12} className="text-text-muted" />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="검색…"
                  className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none"
                />
              </div>
              {allTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <button
                    onClick={() => setTag(null)}
                    className={`rounded-full px-2 py-0.5 ${
                      tag === null
                        ? "bg-[color:var(--accent)]/20 text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    전체
                  </button>
                  {allTags.map(t => (
                    <button
                      key={t}
                      onClick={() => setTag(t === tag ? null : t)}
                      className={`rounded-full px-2 py-0.5 ${
                        tag === t
                          ? "bg-[color:var(--accent)]/20 text-text-primary"
                          : "text-text-muted hover:text-text-primary"
                      }`}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {creating && (
              <div className="space-y-2 border-b border-border bg-bg-card/40 p-3 text-xs">
                <input
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="제목 (예: RPG 검사 캐릭터)"
                  className="h-8 w-full rounded border border-border bg-bg-app px-2 text-sm text-text-primary"
                />
                <textarea
                  value={newBody}
                  onChange={e => setNewBody(e.target.value)}
                  placeholder="본문 — 변수는 {{변수명}} 으로 표기 (예: {{캐릭터명}} 스타일의 도트 스프라이트)"
                  rows={3}
                  className="block w-full resize-none rounded border border-border bg-bg-app px-2 py-1 text-sm text-text-primary"
                />
                <input
                  value={newTags}
                  onChange={e => setNewTags(e.target.value)}
                  placeholder="태그 (쉼표로 구분, # 생략 가능) — 예: character, pixel-art"
                  className="h-8 w-full rounded border border-border bg-bg-app px-2 text-sm text-text-primary"
                />
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => { setCreating(false); setErr(null); }}
                    className="h-7 rounded border border-border px-2 text-text-muted hover:text-text-primary"
                  >
                    취소
                  </button>
                  <button
                    onClick={saveNew}
                    className="h-7 rounded bg-[color:var(--accent)] px-3 font-medium text-white"
                  >
                    저장
                  </button>
                </div>
              </div>
            )}
            {err && <p className="border-b border-border px-3 py-2 text-xs text-[color:var(--danger)]">{err}</p>}

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {items.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-muted/60">
                  {search || tag ? "결과 없음" : "비어 있음. + 로 첫 prompt 를 추가하세요."}
                </p>
              ) : (
                items.map((it, idx) => {
                  const active = idx === focusIdx;
                  const editing = editingId === it.id;
                  const vars = extractVars(it.body);
                  return (
                    <div
                      key={it.id}
                      onMouseEnter={() => setFocusIdx(idx)}
                      className={`group rounded-lg border p-3 ${
                        active && !editing ? "border-[color:var(--accent)] bg-[color:var(--accent)]/10" : "border-border bg-bg-card"
                      }`}
                    >
                      {editing ? (
                        <div className="space-y-2 text-xs">
                          <input
                            value={editDraft.title}
                            onChange={e => setEditDraft(d => ({ ...d, title: e.target.value }))}
                            placeholder="제목"
                            className="h-8 w-full rounded border border-border bg-bg-app px-2 text-sm text-text-primary"
                          />
                          <textarea
                            value={editDraft.body}
                            onChange={e => setEditDraft(d => ({ ...d, body: e.target.value }))}
                            placeholder="본문 — {{변수명}} 으로 변수 지정 가능"
                            rows={3}
                            className="block w-full resize-none rounded border border-border bg-bg-app px-2 py-1 text-sm text-text-primary"
                          />
                          <input
                            value={editDraft.tags}
                            onChange={e => setEditDraft(d => ({ ...d, tags: e.target.value }))}
                            placeholder="태그 (쉼표 구분)"
                            className="h-8 w-full rounded border border-border bg-bg-app px-2 text-sm text-text-primary"
                          />
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => setEditingId(null)}
                              className="h-7 rounded border border-border px-2 text-text-muted hover:text-text-primary"
                            >
                              취소
                            </button>
                            <button
                              onClick={saveEdit}
                              className="h-7 rounded bg-[color:var(--accent)] px-3 font-medium text-white"
                            >
                              저장
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text-primary">{it.title}</span>
                              {vars.length > 0 && (
                                <span
                                  className="rounded bg-[color:var(--accent)]/15 px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--accent)]"
                                  title={`변수: ${vars.join(", ")}`}
                                >
                                  {`{{…}}`}
                                </span>
                              )}
                              {it.use_count > 0 && (
                                <span className="text-[10px] text-text-muted/60">{it.use_count}회 사용</span>
                              )}
                            </div>
                            <p className="mt-1 line-clamp-2 font-mono text-[11px] text-text-muted">
                              <BodyPreview body={it.body} />
                            </p>
                            {it.tags.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-text-muted/70">
                                {it.tags.map(t => <span key={t}>#{t}</span>)}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => handleUse(it)}
                              className="h-7 rounded border border-border bg-[color:var(--accent)] px-3 text-xs font-medium text-white hover:opacity-90"
                            >
                              ▶ 사용
                            </button>
                            <button
                              onClick={() => startEdit(it)}
                              className="rounded p-1 text-text-muted opacity-0 hover:text-text-primary group-hover:opacity-100"
                              title="편집"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => remove(it.id)}
                              className="rounded p-1 text-text-muted opacity-0 hover:text-[color:var(--danger)] group-hover:opacity-100"
                              title="삭제"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 변수 채우기 패널 ────────────────────────────────────────────────────────

type VarFillPanelProps = {
  item: PromptLibraryItem;
  values: Record<string, string>;
  firstRef: React.RefObject<HTMLInputElement>;
  onChange: (name: string, val: string) => void;
  onBack: () => void;
  onApply: () => void;
};

function VarFillPanel({ item, values, firstRef, onChange, onBack, onApply }: VarFillPanelProps) {
  const vars = extractVars(item.body);

  // 미리보기: 현재 입력값으로 보간
  const preview = interpolate(item.body, values);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onApply();
    }
  }

  return (
    <>
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <button
          onClick={onBack}
          className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="돌아가기"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="font-medium text-text-primary">{item.title}</span>
        <span className="ml-auto text-xs text-text-muted/60">변수 채우기</span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 변수 입력 필드들 */}
        <div className="space-y-3">
          {vars.map((name, i) => (
            <div key={name}>
              <label className="mb-1 block text-xs font-medium text-text-muted">
                <span className="font-mono text-[color:var(--accent)]">{`{{${name}}}`}</span>
              </label>
              <input
                ref={i === 0 ? firstRef : undefined}
                type="text"
                value={values[name] ?? ""}
                onChange={e => onChange(name, e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`${name} 입력…`}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-3 text-sm text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none"
              />
            </div>
          ))}
        </div>

        {/* 미리보기 */}
        <div>
          <p className="mb-1 text-xs text-text-muted">미리보기</p>
          <div className="rounded-lg border border-border bg-bg-app px-3 py-2 font-mono text-[11px] text-text-muted whitespace-pre-wrap break-words">
            <BodyPreview body={preview} />
          </div>
        </div>
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        <button
          onClick={onBack}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ← 돌아가기
        </button>
        <button
          onClick={onApply}
          className="h-9 flex-[2] rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white"
          title="⌘Enter"
        >
          ✓ 적용 <span className="ml-1 text-xs opacity-60">⌘↵</span>
        </button>
      </footer>
    </>
  );
}

// ── body 미리보기: {{변수}} 를 하이라이트 ──────────────────────────────────

function BodyPreview({ body }: { body: string }) {
  const parts = body.split(/(\{\{[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\{\{[^}]+\}\}$/.test(part) ? (
          <span key={i} className="text-[color:var(--accent)]">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
