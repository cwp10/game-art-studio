"use client";

import { ArrowDown, ArrowRight, Download, FileArchive, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
  // 레퍼런스 그리드(7열×6행) 기본값
  const [rows, setRows] = useState(6);
  const [cols, setCols] = useState(7);
  const [order, setOrder] = useState<Order>("row");
  const [fps, setFps] = useState(12);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifBusy, setGifBusy] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<null | "zip" | "gif">(null);
  const [offsets, setOffsets] = useState<{ x: number; y: number }[]>([]);
  const [dragging, setDragging] = useState<{
    idx: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const w = Math.max(200, sizer.clientWidth - 24);
    const h = Math.max(200, sizer.clientHeight - 320);
    setAvail({ w, h });
  }, []);

  // 가로폭 기준으로 등비 축소 — 가로로 긴 스프라이트시트에서 세로가 찌그러지지 않도록.
  const scale = avail
    ? Math.min(1, avail.w / imageWidth)
    : Math.min(1, maxDisplayPx / imageWidth);
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

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

  const cellW = Math.floor(imageWidth / cols);
  const cellH = Math.floor(imageHeight / rows);
  const frameCount = rows * cols;

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffsets(Array.from({ length: out.length }, () => ({ x: 0, y: 0 })));
  }, [imgLoaded, rows, cols, order, cellW, cellH]);

  // offset 적용된 프레임 — GIF·zip·썸네일 공통 사용
  const adjustedFrames = useMemo(() => {
    if (frames.length === 0 || offsets.length !== frames.length) return frames;
    return frames.map((frame, i) => {
      const off = offsets[i] ?? { x: 0, y: 0 };
      if (off.x === 0 && off.y === 0) return frame;
      const c = document.createElement("canvas");
      c.width = cellW;
      c.height = cellH;
      const ctx = c.getContext("2d");
      if (!ctx) return frame;
      ctx.drawImage(frame, off.x, off.y);
      return c;
    });
  }, [frames, offsets, cellW, cellH]);

  const thumbs = useMemo(
    () => adjustedFrames.map(f => f.toDataURL("image/png")),
    [adjustedFrames],
  );

  // 드래그 — window 이벤트로 썸네일 밖에서도 추적
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      setOffsets(prev =>
        prev.map((o, i) =>
          i === dragging.idx ? { x: dragging.origX + dx, y: dragging.origY + dy } : o,
        ),
      );
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // bounding box 기반 자동 정렬 — bottom 기준으로 발 라인 통일
  function autoAlign() {
    if (frames.length === 0) return;
    const boxes = frames.map(frame => {
      const ctx = frame.getContext("2d");
      if (!ctx) return { maxY: frame.height };
      const { data, width, height } = ctx.getImageData(0, 0, frame.width, frame.height);
      let maxY = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
          const isBg = a < 10 || (r > 240 && g > 240 && b > 240);
          if (!isBg && y > maxY) maxY = y;
        }
      }
      return { maxY };
    });

    const maxBottom = Math.max(...boxes.map(b => b.maxY));
    setOffsets(boxes.map(box => ({ x: 0, y: maxBottom - box.maxY })));
  }

  function resetOffsets() {
    setOffsets(Array.from({ length: frames.length }, () => ({ x: 0, y: 0 })));
  }

  // GIF 빌드
  useEffect(() => {
    if (adjustedFrames.length === 0) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setGifBusy(true);
      setGifError(null);
      try {
        const GIF = (await import("gif.js")).default;
        const gif = new GIF({
          workers: 2,
          workerScript: "/gif.worker.js",
          quality: 10,
          width: cellW,
          height: cellH,
          transparent: 0x000000 as unknown as string,
        });
        const delay = Math.max(20, Math.round(1000 / fps));
        for (const f of adjustedFrames) gif.addFrame(f, { delay });
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
  }, [adjustedFrames, fps, cellW, cellH]);

  useEffect(() => () => { if (gifUrl) URL.revokeObjectURL(gifUrl); }, [gifUrl]);

  async function downloadZip() {
    if (adjustedFrames.length === 0 || downloading) return;
    setDownloading("zip");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const pad = String(adjustedFrames.length - 1).length;
      adjustedFrames.forEach((c, i) => {
        const dataUrl = c.toDataURL("image/png");
        const base64 = dataUrl.slice("data:image/png;base64,".length);
        zip.file(
          `${parentGenerationId}-${String(i).padStart(pad, "0")}.png`,
          base64,
          { base64: true },
        );
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

        <div
          className="relative mx-auto shrink-0 select-none rounded-lg border border-border bg-bg-card"
          style={{ width: displayW, height: displayH }}
        >
          <canvas ref={baseRef} className="absolute inset-0" width={displayW} height={displayH} />
          <GridOverlay rows={rows} cols={cols} w={displayW} h={displayH} />
        </div>

        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">행</span>
              <input
                type="number" min={1} max={16} value={rows}
                onChange={e => setRows(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">열</span>
              <input
                type="number" min={1} max={16} value={cols}
                onChange={e => setCols(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <span className="text-text-muted/70">셀 {cellW}×{cellH} · {frameCount}프레임</span>
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
            >
              <ArrowDown size={12} /> 세로
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-text-muted">FPS</span>
            <input
              type="range" min={1} max={30} value={fps}
              onChange={e => setFps(Number(e.target.value))}
              className="flex-1 accent-[color:var(--accent)]"
            />
            <span className="w-10 text-right tabular-nums text-text-muted/80">{fps}</span>
          </div>
        </div>

        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">분할 결과 ({thumbs.length}프레임)</span>
            <div className="flex gap-1">
              <button
                onClick={autoAlign}
                disabled={frames.length === 0}
                className="flex h-6 items-center gap-1 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                title="발(bottom) 기준으로 자동 정렬"
              >
                <RefreshCw size={10} /> 자동 정렬
              </button>
              <button
                onClick={resetOffsets}
                disabled={frames.length === 0}
                className="h-6 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                title="위치 초기화"
              >
                초기화
              </button>
            </div>
          </div>
          <p className="text-[11px] text-text-muted/60">
            썸네일을 드래그해서 캐릭터 위치를 조정하세요. 십자선 기준으로 맞추면 프레임 간 정렬이 됩니다.
          </p>
          {/* cols 에 맞춰 동적 열 수 + 셀 비율을 실제 cellW/cellH 로 유지 */}
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {thumbs.map((src, i) => {
              const off = offsets[i] ?? { x: 0, y: 0 };
              return (
                <div
                  key={i}
                  className={`relative overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px] select-none ${
                    dragging?.idx === i ? "cursor-grabbing ring-1 ring-[color:var(--accent)]" : "cursor-grab"
                  }`}
                  style={{ aspectRatio: `${cellW}/${cellH}` }}
                  onMouseDown={e => {
                    e.preventDefault();
                    setDragging({ idx: i, startX: e.clientX, startY: e.clientY, origX: off.x, origY: off.y });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`frame ${i}`}
                    className="absolute inset-0 h-full w-full object-contain"
                    draggable={false}
                  />
                  {/* 십자 점선 — 중앙 기준선 */}
                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    <line
                      x1="50" y1="0" x2="50" y2="100"
                      stroke="rgba(168,85,247,0.6)" strokeWidth="0.8"
                      strokeDasharray="3 2" vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1="0" y1="50" x2="100" y2="50"
                      stroke="rgba(168,85,247,0.6)" strokeWidth="0.8"
                      strokeDasharray="3 2" vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {/* offset 수치 표시 */}
                  {(off.x !== 0 || off.y !== 0) && (
                    <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/70 px-0.5 text-[9px] tabular-nums text-white/90">
                      {off.x > 0 ? "+" : ""}{off.x},{off.y > 0 ? "+" : ""}{off.y}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-text-muted">GIF</span>
            <div className="flex h-64 flex-1 items-center justify-center overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]">
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
          disabled={adjustedFrames.length === 0 || !!downloading}
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
      {/* 레퍼런스 그리드 스타일: 얇은 실선, 스프라이트 위에서도 구분되도록 반투명 흰선 + 보라 이중 */}
      {vLines.map((x, i) => (
        <g key={`v${i}`}>
          <line x1={x} y1={0} x2={x} y2={h} stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
          <line x1={x} y1={0} x2={x} y2={h} stroke="rgba(168, 85, 247, 0.8)" strokeWidth={0.75} />
        </g>
      ))}
      {hLines.map((y, i) => (
        <g key={`h${i}`}>
          <line x1={0} y1={y} x2={w} y2={y} stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
          <line x1={0} y1={y} x2={w} y2={y} stroke="rgba(168, 85, 247, 0.8)" strokeWidth={0.75} />
        </g>
      ))}
    </svg>
  );
}
