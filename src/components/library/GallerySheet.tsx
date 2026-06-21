"use client";

import { Download, FolderOpen, Image as ImageIcon, Paperclip, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { listGenerations } from "@/lib/api/client";
import type { Generation, GenerationKind } from "@/types/db";

/**
 * 갤러리 시트 — 세션 무관 전체 generation 그리드. Cmd+G 또는 좌측 [🖼 갤러리] 로 토글.
 *
 * - 검색: prompt LIKE / 필터: kind chips
 * - 각 썸네일: [첨부] 현재 세션에 reference 로 첨부(갤러리 닫힘) · [저장] PNG 다운로드
 *
 * 마스크/레이어 noise 는 repo 의 listGenerations 가 sessionId·kind 미지정 시 자동 제외.
 */

/** Electron 데스크톱 셸이 preload 로 주입하는 window.electronAPI(웹에선 undefined). */
type ElectronWindow = Window & { electronAPI?: { openImagesFolder: () => void } };

type Filter = "all" | GenerationKind;
const KIND_CHIPS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "text2img", label: "텍스트" },
  { key: "inpaint", label: "편집" },
  { key: "spritesheet", label: "스프라이트" },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** [첨부] → 부모(ChatLayout)가 이 이미지를 현재 대화에 결과 카드로 삽입(모든 기능 버튼 사용 가능). 갤러리는 자동 close. */
  onInsert?: (payload: { prompt?: string; generationId: string; width: number; height: number; kind?: string }) => void;
  generating?: boolean;
};

export function GallerySheet({ open, onClose, onInsert, generating }: Props) {
  const [items, setItems] = useState<Generation[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const opts: { search?: string; kind?: string } = {};
    if (search) opts.search = search;
    if (filter !== "all") opts.kind = filter;
    listGenerations(opts)
      .then(setItems)
      .catch(e => setErr((e as Error).message));
  }, [search, filter]);

  useEffect(() => {
    if (!open) return;
    refresh();
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open, refresh]);

  useHotkeys("esc", () => {
    if (open) onClose();
  }, { enableOnFormTags: true, preventDefault: true }, [open, onClose]);

  // [첨부] — 이 이미지를 현재 대화에 결과 카드로 삽입 후 갤러리 닫기(카드에서 모든 기능 사용).
  function attach(g: Generation) {
    onInsert?.({
      prompt: g.prompt ?? undefined,
      generationId: g.id,
      width: g.width ?? 0,
      height: g.height ?? 0,
      kind: g.kind,
    });
    onClose();
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-8 pt-16">
      <div
        role="dialog"
        aria-label="갤러리"
        className="flex max-h-[85vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-panel shadow-2xl"
      >
        <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
          <span className="flex items-center gap-1.5 font-medium text-text-primary">
            <ImageIcon size={14} /> 갤러리
          </span>
          <span className="ml-2 text-xs text-text-muted/60">{items.length}개 · Esc 닫기</span>
          <div className="ml-auto flex items-center gap-1">
            {typeof window !== "undefined" && (window as ElectronWindow).electronAPI && (
              <button
                onClick={() => (window as ElectronWindow).electronAPI?.openImagesFolder()}
                className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="images 폴더 열기"
              >
                <FolderOpen size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
              title="닫기"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card px-2 py-1">
            <Search size={12} className="text-text-muted" />
            <input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="prompt 검색…"
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1 text-xs">
            {KIND_CHIPS.map(c => (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                className={`rounded-full px-2 py-0.5 ${
                  filter === c.key
                    ? "bg-[color:var(--accent)]/20 text-text-primary"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {err && <p className="border-b border-border px-3 py-2 text-xs text-[color:var(--danger)]">{err}</p>}

        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="py-12 text-center text-sm text-text-muted/60">
              {search || filter !== "all" ? "결과 없음" : "아직 결과가 없어요."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {items.map(g => (
                <div
                  key={g.id}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-card transition-colors hover:border-[color:var(--accent)]/50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/thumbnails/${g.id}`}
                    alt={g.prompt ?? "generation"}
                    title={g.prompt ?? ""}
                    className="checkerboard block aspect-square w-full object-cover"
                    loading="lazy"
                  />
                  <div className="flex flex-1 flex-col gap-1 border-t border-border px-2 py-1.5 text-[10px] text-text-muted">
                    <div className="line-clamp-2 text-[11px] text-text-primary/80">
                      {g.prompt ?? "(no prompt)"}
                    </div>
                    <div className="flex justify-between text-text-muted/60">
                      <span>{g.kind}</span>
                      <span>
                        {g.width}×{g.height}
                      </span>
                    </div>
                    <div className="mt-0.5 flex gap-1">
                      <button
                        onClick={() => attach(g)}
                        disabled={generating}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        title={generating ? "생성 중에는 첨부할 수 없습니다" : "현재 대화에 카드로 추가 — 편집·리스킨·시트 등 기능 사용"}
                      >
                        <Paperclip size={12} /> 첨부
                      </button>
                      <a
                        href={`/api/images/${g.id}`}
                        download={`${g.id}.png`}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"
                        title="PNG 다운로드"
                      >
                        <Download size={12} /> 저장
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
