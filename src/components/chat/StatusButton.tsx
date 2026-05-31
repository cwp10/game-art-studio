"use client";

import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Settings2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ToolStatus = { ok: boolean; version?: string; error?: string };
type Status = { claude: ToolStatus; codex: ToolStatus; mcp: ToolStatus };

const TOOL_LABELS: Record<keyof Status, string> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  mcp: "MCP 서버",
};

const ERROR_HINTS: Record<keyof Status, string> = {
  claude: "claude CLI가 PATH에 없습니다. https://claude.ai/code 에서 설치하세요.",
  codex: "codex CLI가 PATH에 없습니다. npm install -g @openai/codex 로 설치하세요.",
  mcp: "MCP 서버를 시작할 수 없습니다. node·tsx·data 폴더를 확인하세요.",
};

function Dot({ ok, loading }: { ok: boolean; loading: boolean }) {
  if (loading) return <Loader2 size={12} className="animate-spin text-text-muted" />;
  return ok
    ? <CheckCircle2 size={12} className="text-[color:var(--success)]" />
    : <XCircle size={12} className="text-[color:var(--danger)]" />;
}

export function StatusButton() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  async function fetchStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/status");
      setStatus(await res.json());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStatus(); }, []);

  useEffect(() => {
    if (open && !status) fetchStatus();
  }, [open, status]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const hasIssue = status && Object.values(status).some(s => !s.ok);
  const allOk = status && Object.values(status).every(s => s.ok);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 rounded p-1.5 text-text-muted hover:bg-bg-card hover:text-text-primary"
        title="연결 상태"
      >
        {status && (
          <span className={`h-1.5 w-1.5 rounded-full ${allOk ? "bg-[color:var(--success)]" : "bg-[color:var(--danger)]"}`} />
        )}
        <Settings2 size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border border-border bg-bg-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-primary">연결 상태</span>
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
              title="새로고침"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          <div className="divide-y divide-border">
            {(Object.keys(TOOL_LABELS) as Array<keyof Status>).map(key => {
              const s = status?.[key];
              return (
                <div key={key} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Dot ok={s?.ok ?? false} loading={loading || !status} />
                    <span className="flex-1 text-xs text-text-primary">{TOOL_LABELS[key]}</span>
                    {s?.version && (
                      <span className="text-[10px] text-text-muted/60">{s.version}</span>
                    )}
                  </div>
                  {s && !s.ok && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[color:var(--danger)]/80">
                      <AlertCircle size={10} className="mt-0.5 shrink-0" />
                      {s.error === "not found" || s.error === "timeout"
                        ? ERROR_HINTS[key]
                        : s.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {!status && !loading && (
            <p className="px-3 py-3 text-center text-xs text-text-muted/60">
              새로고침을 눌러 확인하세요.
            </p>
          )}
        </div>
      )}

      {hasIssue && !open && (
        <div className="absolute right-0 top-full z-40 mt-1 flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[color:var(--danger)]/30 bg-bg-panel px-2.5 py-1.5 text-[11px] text-[color:var(--danger)]/80 shadow-md">
          <AlertCircle size={11} />
          일부 도구 연결이 끊겼습니다.
        </div>
      )}
    </div>
  );
}
