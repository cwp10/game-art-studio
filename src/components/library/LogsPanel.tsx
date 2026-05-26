"use client";

import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

/**
 * 로그 패널 — data/logs/*.log viewer. Cmd+L 토글.
 *
 * 좌측 파일 목록 (mtime DESC) + 우측 선택 파일의 마지막 300 줄 (auto refresh 가능).
 * codex stdout / claude stream / mcp 서버 로그 디버깅 용.
 */

type LogFile = { name: string; size: number; mtime: number };

type Props = {
  open: boolean;
  onClose: () => void;
};

export function LogsPanel({ open, onClose }: Props) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  const refreshFiles = useCallback(async () => {
    try {
      const r = await fetch("/api/logs");
      const { files } = (await r.json()) as { files: LogFile[] };
      setFiles(files);
      if (!selected && files.length > 0) setSelected(files[0].name);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshFiles();
  }, [open, refreshFiles]);

  // SSE streaming — init 이벤트로 초기 tail + append 로 새 줄. autoRefresh off 면 SSE
  // 안 띄우고 1회 GET 만.
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    const scrollBottom = () => {
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    };
    const decode = (s: string) => s.replace(/\\n/g, "\n");

    if (!autoRefresh) {
      // 1회 fetch.
      fetch(`/api/logs?file=${encodeURIComponent(selected)}&lines=300`)
        .then(r => r.ok ? r.text() : Promise.reject(new Error(r.statusText)))
        .then(text => { if (!cancelled) { setBody(text); setTimeout(scrollBottom, 0); } })
        .catch(e => { if (!cancelled) setErr((e as Error).message); });
      return () => { cancelled = true; };
    }

    const url = `/api/logs?file=${encodeURIComponent(selected)}&stream=1`;
    const es = new EventSource(url);
    es.addEventListener("init", (ev: MessageEvent) => {
      if (cancelled) return;
      setBody(decode(ev.data));
      setTimeout(scrollBottom, 0);
    });
    es.addEventListener("append", (ev: MessageEvent) => {
      if (cancelled) return;
      setBody(prev => prev + decode(ev.data));
      setTimeout(scrollBottom, 0);
    });
    es.addEventListener("error", () => {
      // EventSource 가 자동 재연결 시도. 사용자 메시지만.
      if (!cancelled) setErr("스트림 연결 오류 — 자동 재시도");
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, [open, selected, autoRefresh]);

  useHotkeys("esc", () => { if (open) onClose(); }, { enableOnFormTags: true, preventDefault: true }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-label="로그"
        className="flex h-[60vh] w-full max-w-[1080px] overflow-hidden rounded-2xl border border-border bg-bg-panel shadow-2xl"
      >
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-border">
          <header className="flex h-10 items-center gap-1 border-b border-border px-2 text-xs">
            <span className="font-medium text-text-primary">📜 로그</span>
            <span className="ml-auto text-text-muted/60">{files.length}</span>
            <button
              onClick={refreshFiles}
              className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
              title="새로고침"
            >
              <RefreshCw size={11} />
            </button>
          </header>
          <ul className="flex-1 space-y-0.5 overflow-y-auto p-1 text-xs">
            {files.map(f => (
              <li key={f.name}>
                <button
                  onClick={() => setSelected(f.name)}
                  className={`block w-full truncate rounded px-2 py-1 text-left ${
                    selected === f.name
                      ? "bg-[color:var(--accent)]/20 text-text-primary"
                      : "text-text-muted hover:bg-bg-card hover:text-text-primary"
                  }`}
                  title={`${f.name} · ${(f.size / 1024).toFixed(1)}KB`}
                >
                  {f.name}
                </button>
              </li>
            ))}
            {files.length === 0 && (
              <li className="px-2 py-2 text-text-muted/60">로그 없음</li>
            )}
          </ul>
        </aside>

        <div className="flex flex-1 flex-col">
          <header className="flex h-10 items-center gap-2 border-b border-border px-3 text-xs">
            <span className="font-mono text-text-primary">{selected ?? "(파일 선택)"}</span>
            <label className="ml-auto flex items-center gap-1 text-text-muted">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="size-3 accent-[color:var(--accent)]"
              />
              자동 새로고침 (2s)
            </label>
            <button
              onClick={onClose}
              className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
              title="닫기"
            >
              <X size={12} />
            </button>
          </header>
          {err && <p className="border-b border-border px-3 py-1 text-xs text-[color:var(--danger)]">{err}</p>}
          <pre
            ref={bodyRef}
            className="flex-1 overflow-auto bg-bg-app p-3 font-mono text-[11px] leading-snug text-text-muted"
          >
            {body || "—"}
          </pre>
        </div>
      </div>
    </div>
  );
}
