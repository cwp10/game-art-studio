"use client";

import { ArrowLeft, Download, Layers, Loader2 } from "lucide-react";
import { useState } from "react";

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  onResult: (result: { generationId: string; imageUrl: string; width: number; height: number }) => void;
  onClose: () => void;
};

export function NormalMapPanel({ generationId, imageUrl, width, height, onResult, onClose }: Props) {
  const [strength, setStrength] = useState(1.0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ generationId: string; imageUrl: string; width: number; height: number } | null>(null);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/normal-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId, strength }),
      });
      const data = await res.json() as { newGenerationId?: string; imageUrl?: string; width?: number; height?: number; error?: string };
      if (!res.ok || !data.newGenerationId) {
        setError(data.error ?? "노멀맵 생성에 실패했습니다.");
        return;
      }
      const r = { generationId: data.newGenerationId, imageUrl: data.imageUrl!, width: data.width!, height: data.height! };
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.imageUrl;
    a.download = `${result.generationId}_normalmap.png`;
    a.click();
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-[50px] flex-none items-center gap-3 border-b border-border px-3.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
          title="대화로 돌아가기"
        >
          <ArrowLeft size={14} /> 대화로 돌아가기
        </button>
        <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Layers size={14} /> 노멀맵 생성
        </span>
      </header>

      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* 원본 + 결과 나란히 */}
        <div className={`grid gap-3 ${result ? "grid-cols-2" : "grid-cols-1"}`}>
          <div className="space-y-1">
            <p className="text-[11px] text-text-muted">원본</p>
            <div className="checkerboard overflow-hidden rounded-lg border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="원본" className="block w-full object-contain" style={{ maxHeight: 320 }} />
            </div>
            <p className="text-[11px] text-text-muted/60">{width}×{height}</p>
          </div>
          {result && (
            <div className="space-y-1">
              <p className="text-[11px] text-text-muted">노멀맵</p>
              <div className="checkerboard overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={result.imageUrl} alt="노멀맵" className="block w-full object-contain" style={{ maxHeight: 320 }} />
              </div>
              <p className="text-[11px] text-text-muted/60">{result.width}×{result.height}</p>
            </div>
          )}
        </div>

        {/* Strength 슬라이더 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs text-text-muted">강도 (strength)</label>
            <span className="text-xs tabular-nums text-text-primary">{strength.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={2.0}
            step={0.1}
            value={strength}
            onChange={e => { setStrength(parseFloat(e.target.value)); setResult(null); }}
            className="w-full accent-[color:var(--accent)]"
          />
          <div className="flex justify-between text-[10px] text-text-muted/50">
            <span>0.5 (부드러움)</span>
            <span>2.0 (강조)</span>
          </div>
        </div>

        {error && <p className="text-xs text-[color:var(--danger)]">{error}</p>}
      </div>

      <footer className="mx-auto flex w-full max-w-[1200px] flex-wrap gap-2 border-t border-border p-3">
        {result && (
          <button
            onClick={download}
            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
          >
            <Download size={14} /> 저장
          </button>
        )}
        {result && (
          <button
            onClick={() => onResult(result)}
            className="flex h-9 flex-[2] items-center justify-center gap-1 rounded-lg border border-[color:var(--accent)]/50 text-sm text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
          >
            채팅에 추가
          </button>
        )}
        <button
          onClick={generate}
          disabled={busy}
          className="flex h-9 flex-[2] items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? <><Loader2 size={14} className="animate-spin" /> 생성 중…</> : <><Layers size={14} /> 노멀맵 생성</>}
        </button>
      </footer>
    </aside>
  );
}
