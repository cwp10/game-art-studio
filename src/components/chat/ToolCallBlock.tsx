"use client";

import { Check, ChevronDown, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { ToolCallState } from "./chat-state";

/** 진행 단계의 사람이 읽기 좋은 라벨. */
const STAGE_LABEL: Record<string, string> = {
  starting: "Codex 시작",
  skill_loading: "imagegen 스킬 로드",
  image_generating: "이미지 생성 중",
  recovering: "결과 회수 중",
  done: "완료",
};

type Props = { state: ToolCallState; onRetry?: () => void };

export function ToolCallBlock({ state, onRetry }: Props) {
  const [expanded, setExpanded] = useState(state.status !== "succeeded");
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (state.status !== "running") {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const isDone = state.status === "succeeded";
  const isError = state.status === "failed";

  return (
    <div className="rounded-xl border border-border bg-bg-card">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-sm text-text-muted hover:text-text-primary"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-mono text-xs">🔧 {state.name}</span>
        <span className="ml-auto text-xs">
          {state.status === "running" && <Loader2 className="inline animate-spin" size={12} />}
          {isDone && <Check className="inline text-[color:var(--success)]" size={12} />}
          {isError && <AlertCircle className="inline text-[color:var(--danger)]" size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-2">
          <ul className="space-y-1 text-xs">
            {state.progress.map((p, i) => (
              <li key={i} className="flex items-center gap-2 text-text-muted">
                <Check size={10} className="text-[color:var(--success)]" />
                <span>{STAGE_LABEL[p.stage] ?? p.stage}</span>
                {p.detail && <span className="text-text-muted/60">— {p.detail}</span>}
              </li>
            ))}
            {state.status === "running" && (
              <li className="flex items-center gap-2 text-text-primary">
                <Loader2 className="animate-spin" size={10} />
                <span className="shimmer">진행 중…</span>
                {elapsed > 0 && (
                  <span className="ml-auto tabular-nums text-text-muted/60">{elapsed}s</span>
                )}
              </li>
            )}
            {isError && state.error && (
              <li className="text-[color:var(--danger)]">⚠ {state.error}</li>
            )}
          </ul>
          {isError && onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 rounded border border-[color:var(--accent)]/50 px-3 py-1 text-xs text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
            >
              재생성 ▸
            </button>
          )}
        </div>
      )}
    </div>
  );
}
