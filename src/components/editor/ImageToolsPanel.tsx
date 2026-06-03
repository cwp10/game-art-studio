"use client";

import { Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type FilterArg = { id: string; prompt: string };

export const POST_FILTER_DEFS = [
  { id: "removeBg", label: "배경제거", prompt: "이 이미지의 배경을 투명하게 제거해줘." },
  { id: "sharpen",  label: "샤프닝",   prompt: "이 이미지를 더 선명하게 샤프닝 처리해줘." },
  { id: "blur",     label: "블러",     prompt: "이 이미지를 부드럽게 블러 처리해줘." },
  { id: "pixelate", label: "픽셀",     prompt: "이 이미지를 픽셀아트 스타일로 픽셀화해줘." },
] as const;

type Props = {
  generationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  busy?: boolean;
  onCrop: (args: {
    srcX: number;
    srcY: number;
    srcW: number;
    srcH: number;
    targetW: number;
    targetH: number;
    opacity: number;
    filters: FilterArg[];
  }) => Promise<void>;
  onCancel: () => void;
};

const CW = 560;
const CH = 380;
const PAD = 32;

function computeFrame(tW: number, tH: number) {
  const maxW = CW - PAD * 2;
  const maxH = CH - PAD * 2;
  const aspect = Math.max(tW, 1) / Math.max(tH, 1);
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { x: (CW - w) / 2, y: (CH - h) / 2, w, h };
}

export function ImageToolsPanel({
  generationId,
  imageUrl,
  imageWidth,
  imageHeight,
  busy,
  onCrop,
  onCancel,
}: Props) {
  const [targetW, setTargetW] = useState(imageWidth);
  const [targetH, setTargetH] = useState(imageHeight);
  const [opacity, setOpacity] = useState(100);

  // 패널 열릴 때 원본 이미지의 실제 평균 알파값으로 초기화
  useEffect(() => {
    fetch(`/api/images/${generationId}/opacity`)
      .then(r => r.json())
      .then((d: { opacity: number }) => setOpacity(d.opacity))
      .catch(() => setOpacity(100));
  }, [generationId]);
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set());
  const [isCropping, setIsCropping] = useState(false);

  const toggleFilter = useCallback((id: string) => {
    setSelectedFilters(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef(computeFrame(imageWidth, imageHeight));
  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const draggingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const patternRef = useRef<CanvasPattern | null>(null);

  const frame = useMemo(() => computeFrame(targetW, targetH), [targetW, targetH]);

  // Stable draw — reads only from refs + stable props
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fr = frameRef.current;
    const { x: ox, y: oy } = offsetRef.current;
    const s = scaleRef.current;

    // Checkerboard pattern (lazy-init per canvas context)
    if (!patternRef.current) {
      const pc = document.createElement("canvas");
      pc.width = 14;
      pc.height = 14;
      const pCtx = pc.getContext("2d")!;
      pCtx.fillStyle = "#1a1a1a";
      pCtx.fillRect(0, 0, 14, 14);
      pCtx.fillStyle = "#3a3a3a";
      pCtx.fillRect(0, 0, 7, 7);
      pCtx.fillRect(7, 7, 7, 7);
      patternRef.current = ctx.createPattern(pc, "repeat");
    }

    ctx.clearRect(0, 0, CW, CH);

    // Background
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, CW, CH);

    // Image
    if (img) {
      ctx.drawImage(img, ox, oy, imageWidth * s, imageHeight * s);
    }

    // Dark overlay outside frame (4 rects)
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, CW, fr.y);
    ctx.fillRect(0, fr.y + fr.h, CW, CH - fr.y - fr.h);
    ctx.fillRect(0, fr.y, fr.x, fr.h);
    ctx.fillRect(fr.x + fr.w, fr.y, CW - fr.x - fr.w, fr.h);

    // Rule-of-thirds grid
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(fr.x + (fr.w * i) / 3, fr.y);
      ctx.lineTo(fr.x + (fr.w * i) / 3, fr.y + fr.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(fr.x, fr.y + (fr.h * i) / 3);
      ctx.lineTo(fr.x + fr.w, fr.y + (fr.h * i) / 3);
      ctx.stroke();
    }

    // Frame border
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);

    // Corner handles
    const hs = 8;
    ctx.fillStyle = "#fff";
    for (const [cx, cy] of [
      [fr.x, fr.y],
      [fr.x + fr.w, fr.y],
      [fr.x, fr.y + fr.h],
      [fr.x + fr.w, fr.y + fr.h],
    ] as [number, number][]) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }

    // Size label inside frame
    const label = `${Math.round(targetW)} × ${Math.round(targetH)}`;
    ctx.font = "11px monospace";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(label, fr.x + 6, fr.y + 14);
  }, [imageWidth, imageHeight, targetW, targetH]);

  // Init transform: scale image to cover the frame, center it
  const initTransform = useCallback(() => {
    frameRef.current = frame;
    const s = Math.max(frame.w / imageWidth, frame.h / imageHeight);
    scaleRef.current = s;
    offsetRef.current = {
      x: frame.x + (frame.w - imageWidth * s) / 2,
      y: frame.y + (frame.h - imageHeight * s) / 2,
    };
    draw();
  }, [frame, imageWidth, imageHeight, draw]);

  // Re-init when frame changes (targetW/targetH)
  useEffect(() => {
    initTransform();
  }, [initTransform]);

  // Load image once
  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = imageUrl;
  }, [imageUrl, draw]);

  // Map client coords → canvas internal coords
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: clientX, y: clientY };
    return {
      x: ((clientX - r.left) * CW) / r.width,
      y: ((clientY - r.top) * CH) / r.height,
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    draggingRef.current = true;
    lastPosRef.current = toCanvas(e.clientX, e.clientY);
    e.preventDefault();
  }, [toCanvas]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const pos = toCanvas(e.clientX, e.clientY);
    const dx = pos.x - lastPosRef.current.x;
    const dy = pos.y - lastPosRef.current.y;
    lastPosRef.current = pos;
    offsetRef.current = { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy };
    draw();
  }, [toCanvas, draw]);

  const onMouseUp = useCallback(() => { draggingRef.current = false; }, []);

  // Wheel zoom (native event for passive:false)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const cx = ((e.clientX - r.left) * CW) / r.width;
      const cy = ((e.clientY - r.top) * CH) / r.height;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const oldS = scaleRef.current;
      const newS = Math.max(0.02, Math.min(100, oldS * factor));
      const ratio = newS / oldS;
      offsetRef.current = {
        x: cx - (cx - offsetRef.current.x) * ratio,
        y: cy - (cy - offsetRef.current.y) * ratio,
      };
      scaleRef.current = newS;
      draw();
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [draw]);

  const handleSubmit = useCallback(async () => {
    if (isCropping || busy) return;
    const fr = frameRef.current;
    const s = scaleRef.current;
    const { x: ox, y: oy } = offsetRef.current;
    const srcX = (fr.x - ox) / s;
    const srcY = (fr.y - oy) / s;
    const srcW = fr.w / s;
    const srcH = fr.h / s;
    setIsCropping(true);
    try {
      const filters: FilterArg[] = POST_FILTER_DEFS
        .filter(f => selectedFilters.has(f.id))
        .map(f => ({ id: f.id, prompt: f.prompt }));
      await onCrop({ srcX, srcY, srcW, srcH, targetW, targetH, opacity, filters });
    } finally {
      setIsCropping(false);
    }
  }, [isCropping, busy, targetW, targetH, opacity, selectedFilters, onCrop]);

  const disabled = isCropping || !!busy;

  return (
    <aside className="flex h-full flex-col bg-bg-card text-sm text-text-primary shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-medium">이미지 도구</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-text-muted">{generationId.slice(0, 8)}</span>
          <button
            onClick={onCancel}
            className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {/* Size inputs + toggle buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-text-muted">
            너비
            <input
              type="number"
              min={1}
              value={targetW}
              onChange={e => setTargetW(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-border bg-bg-card px-2 py-1 text-xs text-text-primary"
            />
          </label>
          <span className="text-text-muted">×</span>
          <label className="flex items-center gap-1 text-xs text-text-muted">
            높이
            <input
              type="number"
              min={1}
              value={targetH}
              onChange={e => setTargetH(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-border bg-bg-card px-2 py-1 text-xs text-text-primary"
            />
          </label>
          {POST_FILTER_DEFS.map(f => (
            <button
              key={f.id}
              onClick={() => toggleFilter(f.id)}
              className={`rounded border px-2 py-1 text-xs transition-colors ${selectedFilters.has(f.id) ? "border-accent bg-accent text-white" : "border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"}`}
            >
              {f.label}
            </button>
          ))}
          <button
            onClick={initTransform}
            className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-bg-panel hover:text-text-primary"
            title="이미지를 프레임 중앙으로 초기화"
          >
            <RefreshCw size={12} />
            초기화
          </button>
        </div>

        {/* Opacity slider */}
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-xs text-text-muted">투명도</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={e => setOpacity(Number(e.target.value))}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-accent"
          />
          <span className="w-9 text-right text-xs tabular-nums text-text-muted">{opacity}%</span>
        </div>

        {/* Crop canvas */}
        <div className="overflow-hidden rounded-lg border border-border">
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            className="block w-full cursor-grab select-none active:cursor-grabbing"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
        </div>
        <p className="text-center text-xs text-text-muted/60">드래그로 이동 · 휠로 확대/축소</p>
      </div>

      {/* Footer */}
      <div className="flex gap-2 border-t border-border p-3">
        <button
          disabled={disabled}
          onClick={handleSubmit}
          className="flex flex-1 items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCropping ? <Loader2 size={14} className="animate-spin" /> : null}
          실행
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-border px-4 py-2 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
        >
          닫기
        </button>
      </div>
    </aside>
  );
}
