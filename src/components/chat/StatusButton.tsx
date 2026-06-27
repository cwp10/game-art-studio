"use client";

import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Settings2, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOrchestratorContext } from "@/lib/context/orchestrator-context";

type ToolStatus = { ok: boolean; version?: string; error?: string };
type Status = { claude: ToolStatus; codex: ToolStatus; mcp: ToolStatus };

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

function StatusRow({ label, status, loading, hint }: {
  label: string;
  status?: ToolStatus;
  loading: boolean;
  hint: string;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Dot ok={status?.ok ?? false} loading={loading || !status} />
        <span className="flex-1 text-xs text-text-primary">{label}</span>
        {status?.version && (
          <span className="max-w-[80px] truncate text-[10px] text-text-muted/60">{status.version}</span>
        )}
      </div>
      {status && !status.ok && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[color:var(--danger)]/80">
          <AlertCircle size={10} className="mt-0.5 shrink-0" />
          {status.error === "not found" || status.error === "timeout" ? hint : status.error}
        </p>
      )}
    </div>
  );
}

export function StatusButton() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { isCodex, toggleOrchestrator } = useOrchestratorContext();
  const claudeEnabled = !isCodex;

  async function runCleanup() {
    setClearing(true);
    setClearMsg(null);
    try {
      const res = await fetch("/api/cleanup", { method: "DELETE" });
      const { deleted } = await res.json();
      const { orphanGenerations, orphanFiles, unmatchedThumbs, tmp } = deleted as Record<string, number>;
      const segments = [
        orphanGenerations && `세션없는 생성 ${orphanGenerations}개`,
        orphanFiles && `고아 파일 ${orphanFiles}개`,
        unmatchedThumbs && `미매칭 썸네일 ${unmatchedThumbs}개`,
        tmp && `tmp ${tmp}개`,
      ].filter(Boolean);
      setClearMsg(segments.length ? `${segments.join(" · ")} 삭제` : "정리할 항목이 없습니다");
    } catch {
      setClearMsg("정리 실패");
    } finally {
      setClearing(false);
    }
  }

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStatus();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        title="도구 상태"
      >
        {(status || isCodex) && (
          <span className={`h-1.5 w-1.5 rounded-full ${
            isCodex
              ? "bg-[color:var(--warning)]"
              : allOk
                ? "bg-[color:var(--success)]"
                : "bg-[color:var(--danger)]"
          }`} />
        )}
        <Settings2 size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border border-border bg-bg-panel shadow-xl">
          {/* 헤더 */}
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-primary">도구 상태</span>
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
              title="새로고침"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          {/* 이미지 생성 도구 — 항상 활성 */}
          <div className="divide-y divide-border">
            <StatusRow label="Codex CLI" status={status?.codex} loading={loading} hint={ERROR_HINTS.codex} />
            <StatusRow label="MCP 서버" status={status?.mcp} loading={loading} hint={ERROR_HINTS.mcp} />
          </div>

          {/* Claude 오케스트레이션 — 선택적 */}
          <div className="border-t border-border px-3 pb-3 pt-2.5">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted/50">
              Claude 오케스트레이션
            </p>
            <div className="flex items-center gap-2">
              <Dot ok={status?.claude.ok ?? false} loading={loading || !status} />
              <span className="flex-1 text-xs text-text-primary">Claude CLI</span>
              {status?.claude.version && (
                <span className="max-w-[80px] truncate text-[10px] text-text-muted/60">{status.claude.version}</span>
              )}
              <button
                onClick={toggleOrchestrator}
                title={claudeEnabled ? "Claude 오케스트레이션 끄기" : "Claude 오케스트레이션 켜기"}
                className={`relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  claudeEnabled ? "bg-[color:var(--accent)]" : "bg-border"
                }`}
              >
                <span className={`absolute h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                  claudeEnabled ? "translate-x-[18px]" : "translate-x-[2px]"
                }`} />
              </button>
            </div>
            {status?.claude && !status.claude.ok && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[color:var(--danger)]/80">
                <AlertCircle size={10} className="mt-0.5 shrink-0" />
                {status.claude.error === "not found" || status.claude.error === "timeout"
                  ? ERROR_HINTS.claude
                  : status.claude.error}
              </p>
            )}
            <p className={`mt-1.5 text-[10px] ${claudeEnabled ? "text-[color:var(--success)]/80" : "text-text-muted/50"}`}>
              {claudeEnabled ? "✓ 제안·맥락 이해 활성" : "이미지 생성만 가능 · 제안 불가"}
            </p>
          </div>

          {!status && !loading && (
            <p className="border-t border-border px-3 py-3 text-center text-xs text-text-muted/60">
              새로고침을 눌러 확인하세요.
            </p>
          )}

          {/* 파일 정리 */}
          <div className="border-t border-border px-3 py-2.5">
            <button
              onClick={runCleanup}
              disabled={clearing}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
            >
              {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              파일 정리
              <span className="ml-auto text-[10px] text-text-muted/50">고아 · tmp</span>
            </button>
            {clearMsg && (
              <p className="mt-1 text-center text-[11px] text-text-muted/60">{clearMsg}</p>
            )}
          </div>
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
