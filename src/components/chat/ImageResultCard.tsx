"use client";

import {
  ChevronDown,
  Copy,
  Download,
  Edit3,
  Maximize2,
  RotateCw,
  Scissors,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Action = "duplicate" | "download" | "copy_prompt" | "resize" | "remove_bg" | "edit";

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  prompt?: string;
  onAction?: (action: Action, opts?: { targetSize?: number }) => void;
};

/** plan §S3 의 [업스케일] 단일 버튼을 명시적 픽셀 크기 6개 드롭다운으로 확장. */
const RESIZE_OPTIONS = [64, 128, 256, 512, 1024, 2048] as const;

export function ImageResultCard({ generationId, imageUrl, width, height, prompt, onAction }: Props) {
  const [copied, setCopied] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  // 드롭다운: 바깥 클릭 시 닫기
  useEffect(() => {
    if (!resizeOpen) return;
    function onDocClick(e: MouseEvent) {
      if (resizeRef.current && !resizeRef.current.contains(e.target as Node)) {
        setResizeOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [resizeOpen]);

  function copyPrompt() {
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
    onAction?.("copy_prompt");
  }

  function download() {
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `${generationId}.png`;
    a.click();
    onAction?.("download");
  }

  function pickResize(targetSize: number) {
    setResizeOpen(false);
    onAction?.("resize", { targetSize });
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-bg-card">
      <a href={imageUrl} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={prompt ?? "generated image"}
          className="block h-auto w-full max-w-full bg-black/30"
          width={width || undefined}
          height={height || undefined}
        />
      </a>
      <figcaption className="space-y-2 px-4 py-3 text-xs">
        {prompt && (
          <div className="flex items-start gap-2">
            <button
              onClick={copyPrompt}
              className="mt-0.5 rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="프롬프트 복사"
            >
              <Copy size={12} />
            </button>
            <p className="flex-1 font-mono text-[11px] leading-relaxed text-text-muted">
              {copied ? "복사됨" : prompt}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-border pt-2">
          <span className="text-text-muted/60">
            {width}×{height}
          </span>
          <div className="ml-auto flex gap-1">
            <button
              onClick={() => onAction?.("edit")}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="인페인트 — 영역을 brush 로 칠해서 부분 편집"
            >
              <Edit3 size={12} /> 편집
            </button>
            <div ref={resizeRef} className="relative">
              <button
                onClick={() => setResizeOpen(o => !o)}
                className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="명시적 픽셀 크기로 리사이즈 (sharp lanczos, 1초 이내, 결정적)"
                aria-haspopup="menu"
                aria-expanded={resizeOpen}
              >
                <Maximize2 size={12} /> 리사이즈 <ChevronDown size={10} />
              </button>
              {resizeOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-10 mt-1 flex min-w-[120px] flex-col gap-0.5 rounded-lg border border-border bg-bg-panel p-1 shadow-lg"
                >
                  {RESIZE_OPTIONS.map(n => {
                    const dir = width && n > width ? "↑" : width && n < width ? "↓" : "·";
                    return (
                      <button
                        key={n}
                        onClick={() => pickResize(n)}
                        role="menuitem"
                        className="flex items-center justify-between rounded px-2 py-1.5 text-left text-xs text-text-muted hover:bg-bg-card hover:text-text-primary"
                      >
                        <span>
                          {n}×{n}
                        </span>
                        <span className="ml-3 text-text-muted/40">{dir}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={() => onAction?.("remove_bg")}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="배경 제거 (chroma key + 후처리로 투명 PNG)"
            >
              <Scissors size={12} /> 배경 제거
            </button>
            <button
              onClick={() => onAction?.("duplicate")}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="같은 프롬프트로 한 번 더 (variation 효과)"
            >
              <RotateCw size={12} /> 복제
            </button>
            <button
              onClick={download}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="PNG 다운로드"
            >
              <Download size={12} /> 저장
            </button>
          </div>
        </div>
      </figcaption>
    </figure>
  );
}
