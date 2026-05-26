"use client";

import { ArrowDown, ArrowRight, Download, FileArchive, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * SpriteCanvas — 스프라이트 시트를 N×M 그리드로 분할 + GIF 미리보기 + zip/GIF 다운로드.
 *
 * 모든 동작은 클라이언트 사이드 (canvas + gif.js + jszip 동적 import). 백엔드 호출 X,
 * DB 저장 X — 단순 다운로드 도구. 분할 결과를 generation 으로 남기는 건 v1 결정상 제외.
 *
 * GIF 워커: `gif.js` 가 worker 스크립트를 별도로 요구. `package.json` 의 postinstall 이
 * `public/gif.worker.js` 로 복사 — 빌드 산출물에 포함됨.
 */

type Order = "row" | "col";

type Props = {
  parentGenerationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  maxDisplayPx?: number;
  onCancel: () => void;
};

export function SpriteCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  maxDisplayPx = 1200,
  onCancel,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [order, setOrder] = useState<Order>("row");
  const [fps, setFps] = useState(12);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifBusy, setGifBusy] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<null | "zip" | "gif">(null);

  // 캔버스 표시 크기 — 부모 sizer 폭 안에 맞춤. 한 번 측정.
  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const w = Math.max(200, sizer.clientWidth - 24);
    const h = Math.max(200, sizer.clientHeight - 320); // toolbar/preview 자리 확보
    setAvail({ w, h });
  }, []);

  const cap = avail ? Math.min(maxDisplayPx, avail.w, avail.h) : maxDisplayPx;
  const scale = Math.min(1, cap / Math.max(imageWidth, imageHeight));
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

  // 1. 원본 이미지 load
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImgLoaded(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // 2. base 캔버스 redraw
  useEffect(() => {
    const c = baseRef.current;
    const img = imgRef.current;
    if (!c || !img || !imgLoaded) return;
    c.width = displayW;
    c.height = displayH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.drawImage(img, 0, 0, displayW, displayH);
  }, [imgLoaded, displayW, displayH]);

  // 셀 크기 (원본 해상도 기준)
  const cellW = Math.floor(imageWidth / cols);
  const cellH = Math.floor(imageHeight / rows);
  const frameCount = rows * cols;

  // ── 분할 프레임 생성 ────────────────────────────────────────────────────────
  // imgRef + rows/cols/order 가 바뀔 때마다 재계산 → state. 캔버스 N개를 만들어 thumbnail
  // / GIF 빌드에 그대로 사용. 한 cell ~256×256 × 16 = 1MB level — 메모리 OK.
  const [frames, setFrames] = useState<HTMLCanvasElement[]>([]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !imgLoaded) {
      setFrames([]);
      return;
    }
    const out: HTMLCanvasElement[] = [];
    const push = (cx: number, cy: number) => {
      const c = document.createElement("canvas");
      c.width = cellW;
      c.height = cellH;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, cx * cellW, cy * cellH, cellW, cellH, 0, 0, cellW, cellH);
      out.push(c);
    };
    if (order === "row") {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) push(c, r);
    } else {
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) push(c, r);
    }
    setFrames(out);
  }, [imgLoaded, rows, cols, order, cellW, cellH]);

  // thumbnail dataUrl 캐시 — frames 변경 시만 재계산.
  const thumbs = useMemo(() => frames.map(f => f.toDataURL("image/png")), [frames]);

  // ── GIF 빌드 ────────────────────────────────────────────────────────────────
  // frames / fps 가 변하면 자동 rebuild (debounce 300ms). 이전 url 은 revoke.
  useEffect(() => {
    if (frames.length === 0) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setGifBusy(true);
      setGifError(null);
      try {
        const GIF = (await import("gif.js")).default;
        // 첫 프레임 크기 기준 — 모든 셀 동일 크기 보장.
        const gif = new GIF({
          workers: 2,
          workerScript: "/gif.worker.js",
          quality: 10,
          width: cellW,
          height: cellH,
          transparent: 0x000000,
        });
        const delay = Math.max(20, Math.round(1000 / fps));
        for (const f of frames) gif.addFrame(f, { delay });
        const blob: Blob = await new Promise((resolve, reject) => {
          gif.on("finished", (b: Blob) => resolve(b));
          gif.on("abort", () => reject(new Error("aborted")));
          gif.render();
        });
        if (cancelled) return;
        setGifUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      } catch (e) {
        if (!cancelled) setGifError((e as Error).message);
      } finally {
        if (!cancelled) setGifBusy(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [frames, fps, cellW, cellH]);

  // 언마운트 시 마지막 url cleanup
  useEffect(() => () => { if (gifUrl) URL.revokeObjectURL(gifUrl); }, [gifUrl]);

  // ── downloads ─────────────────────────────────────────────────────────────
  async function downloadZip() {
    if (frames.length === 0 || downloading) return;
    setDownloading("zip");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const pad = String(frames.length - 1).length;
      frames.forEach((c, i) => {
        const dataUrl = c.toDataURL("image/png");
        const base64 = dataUrl.slice("data:image/png;base64,".length);
        zip.file(`${parentGenerationId}-${String(i).padStart(pad, "0")}.png`, base64, { base64: true });
      });
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `${parentGenerationId}-frames.zip`);
    } finally {
      setDownloading(null);
    }
  }

  async function downloadGif() {
    if (!gifUrl || downloading) return;
    setDownloading("gif");
    try {
      const r = await fetch(gifUrl);
      const blob = await r.blob();
      triggerDownload(blob, `${parentGenerationId}.gif`);
    } finally {
      setDownloading(null);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <span className="font-medium text-text-primary">🎬 스프라이트 분할</span>
        <span className="text-xs text-text-muted/60">
          {imageWidth}×{imageHeight} · parent {parentGenerationId.slice(0, 6)}…
        </span>
        <button
          onClick={onCancel}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div ref={sizerRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="text-xs text-text-muted">
          행·열을 지정해서 시트를 N×M 프레임으로 분할합니다. 클라이언트 처리 — DB 저장 없음.
        </p>

        {/* 원본 + 그리드 overlay */}
        <div
          className="relative mx-auto shrink-0 select-none rounded-lg border border-border bg-bg-card"
          style={{ width: displayW, height: displayH }}
        >
          <canvas
            ref={baseRef}
            className="absolute inset-0"
            width={displayW}
            height={displayH}
          />
          <GridOverlay rows={rows} cols={cols} w={displayW} h={displayH} />
        </div>

        {/* 분할 설정 */}
        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">행</span>
              <input
                type="number"
                min={1}
                max={16}
                value={rows}
                onChange={e => setRows(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">열</span>
              <input
                type="number"
                min={1}
                max={16}
                value={cols}
                onChange={e => setCols(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <span className="text-text-muted/70">
              셀 {cellW}×{cellH} · {frameCount}프레임
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-12 text-text-muted">순서</span>
            <button
              onClick={() => setOrder("row")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                order === "row"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
              title="가로 → 세로 (행 우선)"
            >
              <ArrowRight size={12} /> 가로
            </button>
            <button
              onClick={() => setOrder("col")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                order === "col"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
              title="세로 → 가로 (열 우선)"
            >
              <ArrowDown size={12} /> 세로
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-text-muted">FPS</span>
            <input
              type="range"
              min={1}
              max={30}
              value={fps}
              onChange={e => setFps(Number(e.target.value))}
              className="flex-1 accent-[color:var(--accent)]"
            />
            <span className="w-10 text-right tabular-nums text-text-muted/80">{fps}</span>
          </div>
        </div>

        {/* 분할 프레임 + GIF 미리보기 */}
        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="text-text-muted">분할 결과 ({thumbs.length}프레임)</div>
          <div className="grid grid-cols-4 gap-1">
            {thumbs.map((src, i) => (
              <div
                key={i}
                className="overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`frame ${i}`} className="block aspect-square w-full" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-text-muted">GIF</span>
            <div className="flex h-20 flex-1 items-center justify-center overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]">
              {gifBusy ? (
                <span className="text-text-muted/60">생성 중…</span>
              ) : gifError ? (
                <span className="text-[color:var(--danger)]">{gifError}</span>
              ) : gifUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={gifUrl} alt="gif preview" className="block h-full w-auto" />
              ) : (
                <span className="text-text-muted/60">대기</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        <button
          onClick={onCancel}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 닫기
        </button>
        <button
          onClick={downloadZip}
          disabled={frames.length === 0 || !!downloading}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-card disabled:opacity-40"
        >
          <FileArchive size={14} /> {downloading === "zip" ? "..." : "프레임 zip"}
        </button>
        <button
          onClick={downloadGif}
          disabled={!gifUrl || !!downloading}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          <Download size={14} /> {downloading === "gif" ? "..." : "GIF 저장"}
        </button>
      </footer>
    </aside>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 revoke 시 일부 브라우저가 download 취소 — 1초 후 revoke.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 그리드 overlay — pointer 통과, 시각적 셀 경계만.
function GridOverlay({ rows, cols, w, h }: { rows: number; cols: number; w: number; h: number }) {
  const vLines = Array.from({ length: cols - 1 }, (_, i) => ((i + 1) * w) / cols);
  const hLines = Array.from({ length: rows - 1 }, (_, i) => ((i + 1) * h) / rows);
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
    >
      {vLines.map((x, i) => (
        <line
          key={`v${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={h}
          stroke="rgba(168, 85, 247, 0.7)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ))}
      {hLines.map((y, i) => (
        <line
          key={`h${i}`}
          x1={0}
          y1={y}
          x2={w}
          y2={y}
          stroke="rgba(168, 85, 247, 0.7)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ))}
    </svg>
  );
}
