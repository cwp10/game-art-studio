"use client";

import { Copy, Download, RotateCw } from "lucide-react";
import { useState } from "react";

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  prompt?: string;
  onAction?: (action: "duplicate" | "download" | "copy_prompt") => void;
};

export function ImageResultCard({ generationId, imageUrl, width, height, prompt, onAction }: Props) {
  const [copied, setCopied] = useState(false);

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
              onClick={() => onAction?.("duplicate")}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="같은 프롬프트로 복제"
            >
              <RotateCw size={12} /> 복제
            </button>
            <button
              onClick={download}
              className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="저장"
            >
              <Download size={12} /> 저장
            </button>
          </div>
        </div>
      </figcaption>
    </figure>
  );
}
