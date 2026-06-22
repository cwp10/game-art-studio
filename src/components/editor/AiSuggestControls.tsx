"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";

export type AiSuggestion = { title: string; body: string };

export function AiSuggestButton({
  loading,
  onClick,
  compact = false,
  disabled = false,
}: {
  loading: boolean;
  onClick: () => void;
  /** 레이어 캔버스 등 공간이 좁은 패널용 소형 변형 (h-6 / 11px). 기본값 h-7 / xs. */
  compact?: boolean;
  disabled?: boolean;
}) {
  const sz = compact ? 11 : 12;
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      title={disabled ? "Claude 모드에서만 사용 가능" : undefined}
      className={`ml-auto flex ${compact ? "h-6 text-[11px]" : "h-7 text-xs"} items-center gap-1 rounded-md border px-2 ${
        loading
          ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
          : "border-border text-text-muted hover:text-text-primary"
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {loading ? <Loader2 size={sz} className="animate-spin" /> : <Sparkles size={sz} />}
      {loading ? "생각 중…" : "AI 제안"}
    </button>
  );
}

export function AiSuggestDropdown({
  suggestions,
  onSelect,
  onClose,
  width = "w-[340px]",
  placement = "top",
}: {
  suggestions: AiSuggestion[];
  onSelect: (body: string) => void;
  onClose: () => void;
  width?: string;
  /** "top"(기본) = 버튼 아래로 열림. "bottom" = 위로 열림(하단 바 등 화면 아래쪽 버튼용). */
  placement?: "top" | "bottom";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`absolute right-0 z-30 ${placement === "bottom" ? "bottom-full mb-1" : "top-full mt-1"} ${width} space-y-1 rounded-xl border border-border bg-bg-panel p-2 shadow-xl`}
    >
      {suggestions.map((s, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-lg border border-border bg-bg-card p-2 text-xs"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-primary">{s.title}</div>
            <div className="mt-0.5 text-[11px] text-text-muted/80">{s.body}</div>
          </div>
          <button
            onClick={() => onSelect(s.body)}
            className="shrink-0 rounded border border-[color:var(--accent)]/50 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
          >
            선택
          </button>
        </div>
      ))}
    </div>
  );
}
