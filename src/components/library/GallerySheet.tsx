"use client";

import { Download, Edit3, Film, Image as ImageIcon, Layers, Maximize2, RotateCw, Scissors, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { listGenerations } from "@/lib/api/client";
import type { Generation, GenerationKind } from "@/types/db";

/**
 * 갤러리 시트 — 세션 무관 전체 generation 그리드. Cmd+G 또는 좌측 [🖼 갤러리] 로 토글.
 *
 * - 검색: prompt LIKE
 * - 필터: kind chips (전체 / text2img / inpaint / spritesheet)
 * - 클릭: 부모 onPick 으로 generationId 전달 (현재는 새 탭에서 원본 — v1.1 모달)
 *
 * 마스크/레이어 noise 는 repo 의 listGenerations 가 sessionId·kind 미지정 시 자동 제외.
 */

type Filter = "all" | GenerationKind;
const KIND_CHIPS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "text2img", label: "텍스트" },
  { key: "inpaint", label: "편집" },
  { key: "spritesheet", label: "스프라이트" },
];

/** 갤러리에서 호출하는 액션 — ChatLayout 의 handleAction 과 동일 type. */
type GalleryAction =
  | "duplicate"
  | "remove_bg"
  | "edit"
  | "layer_split"
  | "sprite_split"
  | "reference"
  | "resize";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 클릭한 액션을 부모(ChatLayout)에서 처리 — 갤러리는 자동 close. */
  onAction?: (
    action: GalleryAction,
    payload: { prompt?: string; generationId: string; width: number; height: number; targetSize?: number },
  ) => void;
};

export function GallerySheet({ open, onClose, onAction }: Props) {
  const [items, setItems] = useState<Generation[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Generation | null>(null);
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
    if (!open) return;
    if (selected) setSelected(null); else onClose();
  }, { enableOnFormTags: true, preventDefault: true }, [open, onClose, selected]);

  function pickAction(action: GalleryAction, opts?: { targetSize?: number }) {
    if (!selected || !onAction) return;
    onAction(action, {
      prompt: selected.prompt ?? undefined,
      generationId: selected.id,
      width: selected.width ?? 0,
      height: selected.height ?? 0,
      targetSize: opts?.targetSize,
    });
    setSelected(null);
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
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
            title="닫기"
          >
            <X size={14} />
          </button>
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
                <button
                  key={g.id}
                  onClick={() => setSelected(g)}
                  className="group block overflow-hidden rounded-lg border border-border bg-bg-card text-left transition-colors hover:border-[color:var(--accent)]/50"
                  title={g.prompt ?? ""}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/thumbnails/${g.id}`}
                    alt={g.prompt ?? "generation"}
                    className="block aspect-square w-full object-cover"
                    loading="lazy"
                  />
                  <div className="border-t border-border px-2 py-1 text-[10px] text-text-muted">
                    <div className="line-clamp-2 text-[11px] text-text-primary/80">
                      {g.prompt ?? "(no prompt)"}
                    </div>
                    <div className="mt-0.5 flex justify-between text-text-muted/60">
                      <span>{g.kind}</span>
                      <span>
                        {g.width}×{g.height}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="absolute inset-0 z-10 flex flex-col bg-bg-panel">
            <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
              <button
                onClick={() => setSelected(null)}
                className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="갤러리로 돌아가기"
              >
                ← 갤러리
              </button>
              <span className="text-xs text-text-muted/60">
                {selected.kind} · {selected.width}×{selected.height}
              </span>
              <button
                onClick={() => { setSelected(null); onClose(); }}
                className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="닫기"
              >
                <X size={14} />
              </button>
            </header>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/images/${selected.id}`}
                alt={selected.prompt ?? "generation"}
                className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full rounded-lg border border-border bg-black/10"
              />
              {selected.prompt && (
                <p className="rounded-lg border border-border bg-bg-card px-3 py-2 font-mono text-xs leading-relaxed text-text-muted">
                  {selected.prompt}
                </p>
              )}
              <div className="flex flex-wrap gap-1 text-xs">
                <button onClick={() => pickAction("edit")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <Edit3 size={12} /> 편집
                </button>
                <button onClick={() => pickAction("resize", { targetSize: 512 })} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <Maximize2 size={12} /> 512×512
                </button>
                <button onClick={() => pickAction("remove_bg")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <Scissors size={12} /> 배경 제거
                </button>
                <button onClick={() => pickAction("layer_split")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <Layers size={12} /> 레이어
                </button>
                <button onClick={() => pickAction("sprite_split")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <Film size={12} /> 스프라이트
                </button>
                <button onClick={() => pickAction("reference")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  참조로
                </button>
                <button onClick={() => pickAction("duplicate")} className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary">
                  <RotateCw size={12} /> 복제
                </button>
                <a
                  href={`/api/images/${selected.id}`}
                  download={`${selected.id}.png`}
                  className="flex h-8 items-center gap-1 rounded border border-border px-3 text-text-muted hover:text-text-primary"
                >
                  <Download size={12} /> 저장
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
