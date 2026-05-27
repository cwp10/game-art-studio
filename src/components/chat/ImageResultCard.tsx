"use client";

import {
  ChevronDown,
  Copy,
  Download,
  Edit3,
  Film,
  Layers,
  Link2,
  Loader2,
  Maximize2,
  RotateCw,
  Scissors,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Action =
  | "duplicate"
  | "download"
  | "copy_prompt"
  | "resize"
  | "remove_bg"
  | "edit"
  | "layer_split"
  | "sprite_split"
  | "reference";

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
  const [resizeAlignLeft, setResizeAlignLeft] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [lightboxLoaded, setLightboxLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  // 라이트박스: Esc 닫기
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // 라이트박스 열기: 큰 이미지 onLoad 전 placeholder 표시를 위해 로딩 상태 리셋
  function openLightbox() {
    setLightboxLoaded(false);
    setLightbox(true);
  }

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
    // a.click() 다운로드는 동기라 명확한 완료 시점이 없음 → 중복클릭 방지를 위해
    // 짧게 busy 표시(대용량 PNG 에서 연타 방지). 실제 다운로드는 브라우저가 비동기로 진행.
    if (downloading) return;
    setDownloading(true);
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `${generationId}.png`;
    a.click();
    onAction?.("download");
    setTimeout(() => setDownloading(false), 1200);
  }

  function pickResize(targetSize: number) {
    setResizeOpen(false);
    onAction?.("resize", { targetSize });
  }

  // 좁은 패널(메인 420px)에서 `right-0` 메뉴가 왼쪽으로 펼쳐지며 화면 밖으로 잘릴 수 있음.
  // 트리거 왼쪽 가용 공간이 메뉴 폭(120px)보다 좁으면 left 정렬로 전환해 뷰포트 안에 들어오게 함.
  function toggleResize() {
    if (!resizeOpen && resizeRef.current) {
      const rect = resizeRef.current.getBoundingClientRect();
      setResizeAlignLeft(rect.right - 120 < 8);
    }
    setResizeOpen(o => !o);
  }

  return (
    <>
    {/* 라이트박스 오버레이 */}
    {lightbox && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
        onClick={() => setLightbox(false)}
      >
        <button
          onClick={() => setLightbox(false)}
          className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/90"
          title="닫기 (Esc)"
        >
          <X size={20} />
        </button>
        {!lightboxLoaded && (
          <Loader2 size={32} className="absolute animate-spin text-white/70" aria-label="이미지 로딩 중" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={prompt ?? "generated image"}
          className={`max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl transition-opacity ${lightboxLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLightboxLoaded(true)}
          onClick={e => e.stopPropagation()}
        />
      </div>
    )}
    {/* overflow-hidden 을 figure 에서 빼야 [리사이즈 v] 드롭다운이 figcaption 밖으로
        펼쳐질 수 있음. img 자체에 rounded-t-xl 로 corner 깎임 처리. */}
    <figure className="rounded-xl border border-border bg-bg-card">
      {/* 카드 1개가 viewport 안에 들어가도록 height cap (60vh).
          가로 긴 비율(스프라이트 시트 등) 도 max-w-full 로 자연 fit. 클릭 시 라이트박스. */}
      <div
        className="block cursor-zoom-in overflow-hidden rounded-t-xl bg-black/10"
        onClick={openLightbox}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={prompt ?? "generated image"}
          className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full bg-black/30"
          width={width || undefined}
          height={height || undefined}
        />
      </div>
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
        {/* dimensions 와 액션 버튼을 두 줄로 분리 — 좁은 영역(편집 패널 열린 메인 420px)에서
            한 줄에 다 안 들어가 글자가 wrap 되던 문제 해결. 버튼들에 `whitespace-nowrap` +
            컨테이너 `flex-wrap` 으로 부족하면 다음 줄로. */}
        <div className="space-y-2 border-t border-border pt-2">
          <div className="text-text-muted/60">
            {width}×{height}
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onAction?.("edit")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="인페인트 — 영역을 brush 로 칠해서 부분 편집"
            >
              <Edit3 size={12} /> 편집
            </button>
            <div ref={resizeRef} className="relative">
              <button
                onClick={toggleResize}
                className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="명시적 픽셀 크기로 리사이즈 (sharp lanczos, 1초 이내, 결정적)"
                aria-haspopup="menu"
                aria-expanded={resizeOpen}
              >
                <Maximize2 size={12} /> 리사이즈 <ChevronDown size={10} />
              </button>
              {resizeOpen && (
                <div
                  role="menu"
                  className={`absolute z-10 mt-1 flex min-w-[120px] flex-col gap-0.5 rounded-lg border border-border bg-bg-panel p-1 shadow-lg ${resizeAlignLeft ? "left-0" : "right-0"}`}
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
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="배경 제거 (chroma key + 후처리로 투명 PNG)"
            >
              <Scissors size={12} /> 배경 제거
            </button>
            <button
              onClick={() => onAction?.("layer_split")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="레이어 분리 — 부위별로 색을 칠해 색별 PNG 로 추출"
            >
              <Layers size={12} /> 레이어
            </button>
            <button
              onClick={() => onAction?.("sprite_split")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="스프라이트 시트 분할 + GIF 미리보기 + 프레임 zip / GIF 다운로드"
            >
              <Film size={12} /> 스프라이트
            </button>
            <button
              onClick={() => onAction?.("reference")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="이 이미지를 다음 메시지의 reference 로 첨부 → 자연어로 변형 지시"
            >
              <Link2 size={12} /> 참조
            </button>
            <button
              onClick={() => onAction?.("duplicate")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="같은 프롬프트로 한 번 더 (variation 효과)"
            >
              <RotateCw size={12} /> 복제
            </button>
            <button
              onClick={download}
              disabled={downloading}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
              title="PNG 다운로드"
            >
              {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}{" "}
              {downloading ? "저장 중" : "저장"}
            </button>
          </div>
        </div>
      </figcaption>
    </figure>
    </>
  );
}
